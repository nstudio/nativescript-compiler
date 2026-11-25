// `{{ }}` binding expressions of a plain XML app compiled to TypeScript closures that core's Builder uses in place of its
// expression evaluator (core's `registerCompiledBinding` of `ui/builder/binding-builder`, through the kit's
// `__nsRegisterCompiledBinding`, so that an app typed against an older core still builds; keyed as the XML plan keys attributes). A closure does what
// core's `convertExpressionToValue` (`ui/core/bindable/bindable-expressions.ts`) does with the expression's AST, node by
// node and in the same order, including its quirks: the scope rule (`changed`, then the model, then global), the
// null-safe member read of an identifier's value, the converter pipe and its `toView`/`toModel` choice, and its errors.
// An expression with a node the evaluator refuses, or that does not parse, gets no closure and stays on the evaluator.
// Where the context's class is proved, a closure reads that class's members directly behind `instanceof`, and any other
// context takes the same reads by name.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BindingPlan } from './plan.ts';
import type { TypedRead } from './contexts.ts';

type Node = { type: string; [k: string]: any };
export type ParseExpression = (text: string) => Node | undefined;

/** acorn as core's `parseExpression` runs it: the first expression statement of the text, or undefined; throws on a syntax error. */
export function expressionParser(coreDir = fileURLToPath(new URL('../../../core/', import.meta.url))): ParseExpression {
	const { parse } = createRequire(join(coreDir, 'package.json'))('acorn');
	return (text) => {
		const program = parse(text, { ecmaVersion: 2020 });
		// Core takes the first expression statement; anything else around it is left to the evaluator.
		if (program.body.length !== 1 || program.body[0].type !== 'ExpressionStatement') return undefined;
		return program.body[0].expression;
	};
}

/** The update expression of a two-way binding: `prepareExpressionForUpdate` of core's `Binding`. */
export function backExpression(expression: string, sourceProperty: string): string {
	return expression.replace(new RegExp(sourceProperty.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, '\\$&'), 'g'), '$newPropertyValue');
}

class Refused extends Error {}

const UNARY = new Set(['+', '-', '!', 'void', 'typeof']);
const BINARY = new Set(['+', '-', '*', '**', '/', '%', '<', '>', '<=', '>=', '==', '!=', '===', '!==', 'in', 'instanceof']);
const LOGICAL = new Set(['&&', '||', '??']);

/**
 * Annotations the evaluator sets on AST nodes as it runs; all of them are fixed by the node's place in the tree. `typed`:
 * the members a value read takes from `m` directly, `m` being an instance of the guarding class.
 */
interface Marks {
	converter: Set<Node>;
	pending: Set<Node>;
	chained: Set<Node>;
	typed?: ReadonlySet<string>;
}

function literal(e: Node): string {
	if (e.regex) return `(new RegExp(${JSON.stringify(e.regex.pattern)}, ${JSON.stringify(e.regex.flags)}) as any)`;
	const v = e.value;
	if (v === null) return 'null';
	if (typeof v === 'string') return `(${JSON.stringify(v)} as any)`;
	if (typeof v === 'boolean') return `(${v} as any)`;
	if (typeof v === 'number') return Number.isFinite(v) ? `(${String(v)} as any)` : '(Infinity as any)';
	throw new Refused(`literal ${typeof v}`);
}

/** The TypeScript of the closure body for `e`, reading the model as `m` and the changed object as `c`. */
function emit(e: Node, back: boolean, marks: Marks): string {
	const sub = (n: Node) => emit(n, back, marks);
	const list = (items: Node[]) => emitList(items, back, marks);
	switch (e.type) {
		case 'Literal':
			return literal(e);
		case 'Identifier': {
			const key = JSON.stringify(e.name);
			const converter = marks.converter.has(e);
			// A get closure's `changed` is the model or `{ $value }`, so a member present on every instance of the class is
			// the scope rule's pick: `key in changed` is false (no `$` or Object.prototype name is typed) and `key in model` true.
			if (marks.typed?.has(e.name) && !back && !converter && !marks.pending.has(e)) return `(m.${e.name} as any)`;
			return marks.pending.has(e) || converter ? `__nsb.idFn(m, c, ${key}, ${converter}, ${back})` : `__nsb.id(m, c, ${key})`;
		}
		case 'ArrayExpression':
			return `(${list(e.elements)} as any)`;
		case 'ObjectExpression': {
			let out = '{}';
			for (const p of e.properties) {
				if (p.type === 'SpreadElement') out = `__nsb.assign(${out}, ${sub(p.argument)})`;
				else if (p.type === 'Property') {
					if (p.kind !== 'init' || p.method) throw new Refused('accessor');
					const key = p.computed ? sub(p.key) : JSON.stringify(p.key?.name);
					out = `__nsb.assign(${out}, __nsb.prop(${key}, ${sub(p.value)}))`;
				} else throw new Refused(p.type);
			}
			return out;
		}
		case 'TemplateLiteral': {
			let out = `''`;
			e.quasis.forEach((q: Node, i: number) => {
				out += ` + ${JSON.stringify(q.value.cooked)}`;
				if (!q.tail) out += ` + (${sub(e.expressions[i])})`;
			});
			return `(${out} as any)`;
		}
		case 'UnaryExpression':
			if (!UNARY.has(e.operator)) throw new Refused(e.operator);
			return `((${e.operator}${/^[a-z]/.test(e.operator) ? ' ' : ''}(${sub(e.argument)})) as any)`;
		case 'LogicalExpression':
			if (!LOGICAL.has(e.operator)) throw new Refused(e.operator);
			return `((${sub(e.left)}) ${e.operator} (${sub(e.right)}) as any)`;
		case 'ConditionalExpression':
			return `((${sub(e.test)}) ? (${sub(e.consequent)}) : (${sub(e.alternate)}))`;
		case 'ChainExpression':
			return sub(e.expression);
		case 'BinaryExpression': {
			if (e.operator !== '|') {
				if (!BINARY.has(e.operator)) throw new Refused(e.operator);
				return `((${sub(e.left)}) ${e.operator} (${sub(e.right)}) as any)`;
			}
			// The converter pipe: `left | conv`, `left | conv(args)` (the call gets `left` first, evaluated again).
			let target = e.right;
			if (target.type === 'ChainExpression') target = target.expression;
			let callable = false;
			if (target.type === 'CallExpression') {
				callable = true;
				target = target.callee;
			}
			if (!['Identifier', 'MemberExpression', 'NewExpression'].includes(target.type)) throw new Refused('converter syntax');
			marks.converter.add(target);
			marks.pending.add(target);
			const left = sub(e.left);
			if (callable) {
				const call = e.right.type === 'ChainExpression' ? e.right.expression : e.right;
				return `__nsb.seq(${left}, ${emitCall(call, [e.left, ...call.arguments], back, marks)})`;
			}
			return `__nsb.pipe(${left}, ${sub(e.right)})`;
		}
		case 'CallExpression':
			return emitCall(e, e.arguments, back, marks);
		case 'MemberExpression': {
			if (e.object.type === 'MemberExpression') marks.chained.add(e.object);
			if (e.object.type === 'Super' || e.property.type === 'PrivateIdentifier') throw new Refused('member');
			const flags = (e.object.type === 'Identifier' ? 1 : 0) | (marks.chained.has(e) ? 2 : 0) | (e.optional ? 4 : 0) | (marks.converter.has(e) ? 8 : 0) | (marks.pending.has(e) ? 16 : 0);
			const property = e.computed ? sub(e.property) : JSON.stringify(e.property.name);
			return `__nsb.member(${sub(e.object)}, ${property}, ${flags}, ${back})`;
		}
		case 'NewExpression':
			return `__nsb.construct(${sub(e.callee)}, ${list(e.arguments)}, ${marks.converter.has(e)}, ${back})`;
		default:
			throw new Refused(e.type);
	}
}

function emitCall(e: Node, args: Node[], back: boolean, marks: Marks): string {
	marks.pending.add(e.callee);
	const callee = emit(e.callee, back, marks);
	return `__nsb.call(__nsb.callee(${callee}, ${!!e.optional}), ${!!e.optional}, ${emitList(args, back, marks)})`;
}

/** An array of evaluated items; with a spread, built push by push as the evaluator builds it. */
function emitList(items: Node[], back: boolean, marks: Marks): string {
	if (items.some((a) => a === null)) throw new Refused('hole');
	if (!items.some((a) => a.type === 'SpreadElement')) return `[${items.map((a) => emit(a, back, marks)).join(', ')}]`;
	let out = '[]';
	for (const a of items) out = a.type === 'SpreadElement' ? `__nsb.spread(${out}, ${emit(a.argument, back, marks)})` : `__nsb.add(${out}, ${emit(a, back, marks)})`;
	return out;
}

/** The closure for an expression, or null when it stays on the evaluator. */
export function compileExpression(parse: ParseExpression, text: string, back: boolean, typed?: { guard: string; members: ReadonlySet<string> }): string | null {
	let ast: Node | undefined;
	try {
		ast = parse(text);
	} catch {
		return null;
	}
	if (!ast) return null;
	try {
		// Marks are set while emitting, before the marked node is emitted, as the evaluator sets them before evaluating it.
		const body = (members?: ReadonlySet<string>) => emit(ast!, back, { converter: new Set(), pending: new Set(), chained: new Set(), typed: members });
		const untyped = body();
		const direct = typed && !back ? body(typed.members) : untyped;
		return `(m: any, c: any): any => ${direct === untyped ? untyped : `m instanceof ${typed!.guard} ? ${direct} : ${untyped}`}`;
	} catch (err) {
		if (err instanceof Refused) return null;
		throw err;
	}
}

/** The run-time helpers the closures call, each doing what the evaluator's handler of that node does. */
export const HELPERS = `const __nsbChain = Symbol('forcedChain');
const __nsb = {
  scope(m: any, c: any, k: string): any {
    let x = k in c ? c : m;
    if (!(k in x)) x = global;
    return x;
  },
  id(m: any, c: any, k: string): any {
    return __nsb.scope(m, c, k)[k];
  },
  idFn(m: any, c: any, k: string, converter: boolean, back: boolean): any {
    const x = __nsb.scope(m, c, k);
    let v = x[k];
    if (converter) v = __nsb.conv(v, back);
    return typeof v === 'function' ? v.bind(x) : v;
  },
  conv(v: any, back: boolean): any {
    if (v === undefined || v === null) return v;
    if (typeof v === 'function') return back ? Function.prototype : v;
    if (typeof v === 'object' && (typeof v.toModel === 'function' || typeof v.toView === 'function')) return (back ? v.toModel : v.toView) || Function.prototype;
    return v;
  },
  // flags: 1 the object is an identifier, 2 the object of another member, 4 optional, 8 a converter, 16 called.
  member(o: any, p: any, flags: number, back: boolean): any {
    if (o == null && (flags & 1) !== 0) return (flags & 2) !== 0 ? __nsbChain : undefined;
    // Strict: no other value equals the module's own symbol, and the runtimes' loose equality of a string and a symbol recurses.
    if (o === __nsbChain) return (flags & 2) !== 0 ? o : undefined;
    let v = (flags & 4) !== 0 ? o?.[p] : o[p];
    if ((flags & 8) !== 0) v = __nsb.conv(v, back);
    return (flags & 16) !== 0 && typeof v === 'function' ? v.bind(o) : v;
  },
  callee(callback: any, optional: boolean): any {
    if (!optional && (callback === undefined || callback === null)) throw new Error('Cannot perform a call using a null or undefined property');
    return callback;
  },
  call(callback: any, optional: boolean, args: any[]): any {
    return optional ? callback?.(...args) : callback(...args);
  },
  construct(callback: any, args: any[], converter: boolean, back: boolean): any {
    const v = new callback(...args);
    return converter ? __nsb.conv(v, back) : v;
  },
  pipe(left: any, right: any): any {
    if (typeof right === 'function') return right(left);
    if (right === undefined || right === null) throw new Error('Cannot perform a call using a null or undefined property');
    throw new Error('Invalid converter syntax');
  },
  add(list: any[], value: any): any[] {
    list.push(value);
    return list;
  },
  spread(list: any[], value: any): any[] {
    list.push(...value);
    return list;
  },
  seq(first: any, value: any): any {
    return value;
  },
  assign(o: any, part: any): any {
    Object.assign(o, part);
    return o;
  },
  prop(k: any, v: any): any {
    return { [k]: v };
  },
};
`;

export interface CompiledSite {
	key: string;
	get: string;
	back?: string;
	typed: boolean;
}
export interface CompiledBindings {
	sites: CompiledSite[];
	imports: Map<string, { module: string; exportName: string }>;
}

/** Each binding with an expression that compiles, with its update closure when it is two-way. */
export function compileBindings(parse: ParseExpression, sites: { key: string; binding: BindingPlan; typed?: TypedRead }[]): CompiledBindings {
	const out: CompiledSite[] = [];
	const imports = new Map<string, { module: string; exportName: string }>();
	const guards = new Map<string, string>();
	for (const { key, binding, typed } of sites) {
		if (binding.expression === undefined) continue;
		let guard: { guard: string; members: ReadonlySet<string> } | undefined;
		if (typed?.exportName && typed.members.length) {
			const id = `${typed.module}\u0000${typed.exportName}`;
			let name = guards.get(id);
			if (!name) guards.set(id, (name = `__nsCtx${guards.size}`));
			guard = { guard: name, members: new Set(typed.members) };
		}
		const get = compileExpression(parse, binding.expression, false, guard);
		if (!get) continue;
		const back = binding.twoWay ? compileExpression(parse, backExpression(binding.expression, binding.sourceProperty), true) : null;
		const isTyped = !!guard && get.includes(`m instanceof ${guard.guard} ?`);
		if (isTyped) imports.set(guard!.guard, { module: typed!.module, exportName: typed!.exportName });
		out.push({ key, get, ...(back ? { back } : {}), typed: isTyped });
	}
	return { sites: out, imports };
}

/** Each site's closure constant in the bindings module: equal closures share one. */
export function closureNames({ sites }: CompiledBindings): { names: Map<string, string>; bodies: Map<string, string> } {
	const bodies = new Map<string, string>();
	const names = new Map<string, string>();
	for (const s of sites) {
		const body = `{ get: ${s.get}${s.back ? `, back: ${s.back}` : ''} }`;
		let name = bodies.get(body);
		if (!name) bodies.set(body, (name = `__nsbE${bodies.size}`));
		names.set(s.key, name);
	}
	return { names, bodies };
}

/**
 * The module registering the closures, or null when there are none. Page factories import the constants. `unregistered`:
 * keys of closures that only generated code names (constant text in app code), which the run-time Builder never looks up.
 */
export function bindingsModule(compiled: CompiledBindings, unregistered: ReadonlySet<string> = new Set()): string | null {
	if (!compiled.sites.length) return null;
	const { names, bodies } = closureNames(compiled);
	const lines: string[] = [...compiled.imports].map(([name, i]) => `import { ${i.exportName} as ${name} } from ${JSON.stringify('./' + i.module)};`);
	for (const [body, name] of bodies) lines.push(`export const ${name}: any = ${body};`);
	for (const [key, name] of names) if (!unregistered.has(key)) lines.push(`__nsRegisterCompiledBinding(${JSON.stringify(key)}, ${name});`);
	return `${HELPERS}\n${lines.join('\n')}\n`;
}
