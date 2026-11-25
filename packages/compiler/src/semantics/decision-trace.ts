// The decision-parity trace (tests/checks/decision-parity.ts): with NS_DECISION_TRACE set, each entry point of the front
// records the question it answered, the node it answered it for and its answer, so a translation of one program by both
// backends can be compared question by question. Each answer also names the backend inputs it read: the ledger's fields
// (`ledger.<field>`) and the backend's own facts and spellings a front question is given (`backend.<hook>`). Unset, the
// entry points are the plain functions: `traceMethods`, `traceClass` and the `traced…` wrappers return what they are
// given, and `traced` callers test `TRACING` first.
import ts from 'typescript';
import type { Ledger } from './ledger.ts';

export const TRACING = !!process.env.NS_DECISION_TRACE;

/**
 * One question: where (a node's file, start, end and kind; '-' for the whole program), to what, the answers it was given
 * and the backend inputs they read, and how often it was asked.
 */
export interface Decision {
	readonly at: string;
	readonly question: string;
	readonly answers: readonly string[];
	readonly inputs: readonly string[];
	readonly asked: number;
}

let sink: Map<string, { at: string; question: string; answers: Set<string>; inputs: Set<string>; asked: number }> | null = null;
/** The questions being answered, innermost last: what an input read inside one is charged to. */
const frames: { at: string | null; inputs: Set<string> }[] = [];
/** Sets and maps an answer gave. */
const answered = new WeakSet<object>();
/**
 * The inputs read in making an object an answer gave (a whole-program analysis, a memoized set) or in an analysis's
 * methods: charged again wherever it is given or asked later, when making it reads nothing. Per trace: an object one
 * translation's answers share with the next (a constant type) carries nothing from it.
 */
let taints = new WeakMap<object, Set<string>>();

function taint(x: object, inputs: Set<string>): void {
	let t = taints.get(x);
	if (!t) taints.set(x, (t = new Set()));
	for (const i of inputs) t.add(i);
	for (const i of t) inputs.add(i);
}

/** Starts collecting the decisions of what runs next. */
export function startDecisionTrace(): void {
	sink = new Map();
	taints = new WeakMap();
}

/** The decisions collected since `startDecisionTrace`, which stops collecting. */
export function takeDecisionTrace(): Decision[] {
	const out = [...(sink?.values() ?? [])].map((d) => ({ ...d, answers: [...d.answers].sort(), inputs: [...d.inputs].sort() }));
	sink = null;
	return out;
}

/** Where a node is: its file, start, end and kind; the same in two programs of the same text. */
export function nodeKey(n: ts.Node): string {
	const sf = n.getSourceFile();
	if (!sf) return `?:${n.kind}`;
	return `${sf.fileName}:${n.pos < 0 ? n.pos : n.getStart(sf)}:${n.end}:${ts.SyntaxKind[n.kind]}`;
}

function isNode(x: unknown): x is ts.Node {
	return !!x && typeof x === 'object' && typeof (x as ts.Node).kind === 'number' && 'pos' in x && 'end' in x && 'flags' in x && 'parent' in x;
}

function isSymbol(x: unknown): x is ts.Symbol {
	return !!x && typeof x === 'object' && 'escapedName' in x && 'flags' in x && !('kind' in x);
}

function isType(x: unknown): x is ts.Type {
	return !!x && typeof x === 'object' && 'checker' in x && 'flags' in x && 'id' in x;
}

/** A value as text that two programs of the same source agree on: nodes by where they are, no object identity. */
function shown(x: unknown, depth = 0): string {
	if (x === undefined) return 'undefined';
	if (x === null || typeof x === 'boolean' || typeof x === 'number' || typeof x === 'string') return JSON.stringify(x);
	if (typeof x === 'function') return 'fn';
	if (isNode(x)) return nodeKey(x);
	if (isSymbol(x)) return `symbol ${x.name}@${x.valueDeclaration ? nodeKey(x.valueDeclaration) : x.declarations?.[0] ? nodeKey(x.declarations[0]) : '-'}`;
	// Two instantiations of one generic (`string[]`, `number[]`) are two types.
	if (isType(x)) return `type ${x.flags} ${(x as ts.Type & { checker: ts.TypeChecker }).checker.typeToString(x)}`;
	if (depth > 3) return '…';
	if (x instanceof Set)
		return `{${[...x]
			.map((v) => shown(v, depth + 1))
			.sort()
			.join(', ')}}`;
	if (x instanceof Map)
		return `{${[...x]
			.map(([k, v]) => `${shown(k, depth + 1)}: ${shown(v, depth + 1)}`)
			.sort()
			.join(', ')}}`;
	if (Array.isArray(x)) return `[${x.map((v) => shown(v, depth + 1)).join(', ')}]`;
	const proto = Object.getPrototypeOf(x);
	if (proto !== Object.prototype && proto !== null) return `instance ${proto.constructor?.name ?? '?'}`;
	// A native type's name, head and text are its spelling, the backend's own.
	const spelled = ['kind', 'optional', 'name'].every((k) => Object.hasOwn(x, k));
	return `{${Object.keys(x)
		.filter((k) => !(spelled && (k === 'name' || k === 'text' || k === 'head')))
		.sort()
		.map((k) => `${k}: ${shown((x as Record<string, unknown>)[k], depth + 1)}`)
		.join(', ')}}`;
}

/** A file one platform's program has and the other's has another of (`x.ios.ts`, `x.android.ts`): its answers may differ. */
const PLATFORM_FILE = /\.(ios|android|apple|visionos)\.(d\.)?ts$/;

/** The node a question is about: its first node argument, or a symbol's declaration; '' for one in a platform's own file, null for none. */
function anchorOf(args: readonly unknown[]): string | null {
	for (const a of args) {
		const n = isNode(a) ? a : isSymbol(a) ? (a.valueDeclaration ?? a.declarations?.[0]) : undefined;
		if (!n) continue;
		return PLATFORM_FILE.test(n.getSourceFile()?.fileName ?? '') ? '' : nodeKey(n);
	}
	return null;
}

function record(at: string, question: string, answer: string, inputs: Iterable<string>): void {
	const key = `${at}\0${question}`;
	let d = sink!.get(key);
	if (!d) sink!.set(key, (d = { at, question, answers: new Set(), inputs: new Set(), asked: 0 }));
	d.answers.add(answer);
	for (const i of inputs) d.inputs.add(i);
	d.asked++;
}

function charge(input: string): void {
	for (const f of frames) f.inputs.add(input);
}

/**
 * Records `question`'s answer at the innermost question being answered (`plan()`'s, which is asked of types, not of a
 * node). Callers test `TRACING` first.
 */
export function traced<T>(question: string, answer: T): T {
	const frame = frames.at(-1);
	if (sink && frame?.at) record(frame.at, question, shown(answer), frame.inputs);
	return answer;
}

/** A set or map an answer gave: its `has` (and `get`) record each membership asked of it, at the member asked. */
function watch(question: string, answer: object, inputs: Set<string>): void {
	if (answered.has(answer)) return;
	answered.add(answer);
	const has = (answer as Set<unknown>).has;
	Object.defineProperty(answer, 'has', {
		configurable: true,
		value(this: Set<unknown>, x: unknown) {
			const found = has.call(this, x);
			const at = anchorOf([x]);
			for (const i of taints.get(this) ?? []) charge(i);
			if (sink && at) record(at, `${question}.has`, String(found), [...inputs, ...(taints.get(this) ?? [])]);
			return found;
		},
	});
	if (answer instanceof Map) {
		const get = answer.get;
		Object.defineProperty(answer, 'get', {
			configurable: true,
			value(this: Map<unknown, unknown>, x: unknown) {
				const value = get.call(this, x);
				const at = anchorOf([x]);
				for (const i of taints.get(this) ?? []) charge(i);
				if (sink && at) record(at, `${question}.get`, shown(value), [...inputs, ...(taints.get(this) ?? [])]);
				return value;
			},
		});
	}
}

function wrap(group: string, name: string, fn: (...args: unknown[]) => unknown, analysis = false): (...args: unknown[]) => unknown {
	return function (this: object, ...args: unknown[]) {
		const at = anchorOf(args);
		const frame = { at: at ?? frames.at(-1)?.at ?? null, inputs: new Set<string>() };
		frames.push(frame);
		let answer: unknown;
		try {
			answer = fn.apply(this, args);
		} finally {
			frames.pop();
		}
		if (analysis) taint(this, frame.inputs);
		if (answer && typeof answer === 'object') taint(answer, frame.inputs);
		for (const input of frame.inputs) charge(input);
		// A callback argument is the caller's code: what the answer reads of it is the caller's, not the front's.
		if (args.some((a) => typeof a === 'function')) return answer;
		const shownArgs = args.filter((a) => !isNode(a) && !isSymbol(a)).map((a) => shown(a));
		// An object argument shown only by its class (a flow slot) leaves the question unknown: two calls would merge.
		if (shownArgs.some((a) => a.includes('instance '))) return answer;
		const question = `${group}.${name}(${shownArgs.join(', ')})`;
		if (answer instanceof Set || answer instanceof Map) watch(`${group}.${name}`, answer, frame.inputs);
		else if (sink && at !== '') record(at ?? '-', question, shown(answer), frame.inputs);
		return answer;
	};
}

/** `methods` with each function recording its answers while tracing; `methods` itself otherwise. */
export function traceMethods<T extends object>(group: string, methods: T): T {
	if (!TRACING) return methods;
	const out = {} as T;
	for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(methods))) {
		Object.defineProperty(out, k, typeof d.value === 'function' ? { ...d, value: wrap(group, k, d.value) } : d);
	}
	return out;
}

/** While tracing, each method of a class's prototype records its answers, but those `spelled` names, which answer in the backend's own code. */
export function traceClass(proto: object, group: string, spelled: readonly string[] = []): void {
	if (!TRACING) return;
	for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
		if (k === 'constructor' || typeof d.value !== 'function' || spelled.includes(k)) continue;
		Object.defineProperty(proto, k, { ...d, value: wrap(group, k, d.value) });
	}
}

/**
 * While tracing, each method of a whole-program analysis's prototype records its answers, charged with every input the
 * analysis read so far: what it built once from them answers later questions.
 */
export function traceAnalysis(proto: object, group: string): void {
	if (!TRACING) return;
	for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
		if (k === 'constructor' || typeof d.value !== 'function') continue;
		Object.defineProperty(proto, k, { ...d, value: wrap(group, k, d.value, true) });
	}
}

/**
 * Records what each import of a program's own files resolves to, a platform's file (`x.ios.ts`) as the module it is:
 * two programs whose imports resolve differently (a package with one platform's source only) are not one program.
 */
export function traceProgram(checker: ts.TypeChecker, files: readonly ts.SourceFile[]): void {
	if (!sink) return;
	const resolved: string[] = [];
	for (const sf of files) {
		if (sf.isDeclarationFile) continue;
		for (const st of sf.statements) {
			if (!ts.isImportDeclaration(st) && !ts.isExportDeclaration(st)) continue;
			const target = st.moduleSpecifier && checker.getSymbolAtLocation(st.moduleSpecifier)?.valueDeclaration?.getSourceFile().fileName;
			if (target) resolved.push(`${sf.fileName.replace(PLATFORM_SUFFIX, '')} -> ${target.replace(PLATFORM_SUFFIX, '')}`);
		}
	}
	record('-', 'program.imports', resolved.sort().join('\n'), []);
}
const PLATFORM_SUFFIX = /\.(ios|android)(?=\.(d\.)?ts$)/;

/** While tracing, a ledger whose every field read is charged to the questions being answered. */
export function tracedLedger(ledger: Ledger): Ledger {
	if (!TRACING) return ledger;
	return new Proxy(ledger, {
		get(target, key, receiver) {
			if (typeof key === 'string') charge(`ledger.${key}`);
			return Reflect.get(target, key, receiver);
		},
	});
}

/**
 * While tracing, `backend` with each call of a member `types` names recorded as a question of its own (`types.<hook>`):
 * the native type a value is held as, which the front decides and both backends must give alike. Each call of a member `hooks` names charged to the questions being answered as that
 * call (`backend.<hook>(<arguments>)@<node>`), whose answer is recorded too, so that an answer that read it is told apart
 * only where the backends answered it differently; a read of a member that is no function is charged by its name.
 */
export function tracedBackend<T extends object>(backend: T, hooks: readonly (keyof T & string)[], types: readonly (keyof T & string)[] = []): T {
	if (!TRACING) return backend;
	return new Proxy(backend, {
		get(target, key, receiver) {
			const value = Reflect.get(target, key, receiver);
			if (typeof key === 'string' && typeof value === 'function' && (types as readonly string[]).includes(key)) return wrap('types', key, value.bind(target) as (...args: unknown[]) => unknown);
			if (typeof key !== 'string' || !(hooks as readonly string[]).includes(key)) return value;
			if (typeof value !== 'function') {
				charge(`backend.${key}`);
				return value;
			}
			return (...args: unknown[]) => {
				const at = anchorOf(args);
				if (at === '' || args.some((a) => typeof a === 'function')) {
					charge(`backend.${key}`);
					return value.apply(target, args);
				}
				const question = `backend.${key}(${args
					.filter((a) => !isNode(a) && !isSymbol(a))
					.map((a) => shown(a))
					.join(', ')})`;
				charge(`${question}@${at ?? '-'}`);
				const answer = value.apply(target, args);
				if (sink) record(at ?? '-', question, shown(answer), []);
				return answer;
			};
		},
	});
}
