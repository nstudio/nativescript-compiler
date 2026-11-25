// Every kind of construct a compiled release refuses, with what to write
// instead. Preflight rules, `limit()` and `error()` name a kind by its id; the
// text a developer reads is here, or in the framework adapter's refusals, and
// nowhere else.
//
// `limit`: JavaScript a compiled release cannot run by design. `gap`: code
// that runs as JavaScript and the compiler does not translate yet. A rewrite
// shown here is one a diff case runs on both backends and matches Node with.

import type ts from 'typescript';
import type { CompilerRefusalId, RefusalId, RefusalKind } from '../api/adapter-api.ts';
import type { ActiveAdapter } from '../adapters/active.ts';
import { compiledEnv } from '../program/env.ts';

export type { RefusalClass, RefusalId, RefusalKind } from '../api/adapter-api.ts';

const ISOLATE = 'move the code into a plain function of its own with typed parameters and result, so the rest of the module translates; the refusal then names only that function';

export const REFUSALS = {
	// Preflight: lib globals and syntax with no compiled runtime.
	proxy: { class: 'limit', title: 'Proxy', why: 'a compiled release has no JavaScript engine to run its traps', suggestion: 'use a class with explicit getters and setters, or a Map for dynamic keys', before: 'const p = new Proxy(target, { get: (t, k) => t[k] ?? 0 })', after: 'const counts = new Map<string, number>(); const read = (k: string) => counts.get(k) ?? 0' },
	reflect: { class: 'limit', title: 'Reflect', suggestion: 'use the operation directly (obj[key], key in obj, Object.keys(obj), new Cls(...args))', before: 'Reflect.has(o, "a"); Reflect.ownKeys(o)', after: '"a" in o; Object.keys(o)' },
	eval: { class: 'limit', title: 'eval', suggestion: 'there is no JavaScript engine to evaluate code: replace it with a lookup of known functions, or keep this app on the JavaScript release', before: 'eval(name + "()")', after: "const actions = new Map<string, () => void>([['save', save], ['load', load]]); actions.get(name)?.()" },
	'function-constructor': { class: 'limit', title: 'Function from text', suggestion: 'there is no JavaScript engine to compile a function from text: write the function in the source', before: 'new Function("a", "b", "return a + b")', after: '(a: number, b: number) => a + b' },
	'finalization-registry': { class: 'limit', title: 'FinalizationRegistry', suggestion: 'finalizers do not run in a compiled release: release the resource explicitly (a dispose() method, or an unloaded/disposeNativeView hook)' },
	'shared-array-buffer': { class: 'limit', title: 'SharedArrayBuffer', suggestion: 'use an ArrayBuffer, and post copies between workers' },
	atomics: { class: 'limit', title: 'Atomics', suggestion: 'use an ArrayBuffer and post messages between workers instead of shared memory' },
	with: { class: 'limit', title: '`with`', suggestion: 'name the object explicitly (`obj.x` instead of `x` inside `with (obj)`)' },
	'computed-import': { class: 'limit', title: 'import() of a computed specifier', suggestion: "import each module by a literal path (`() => import('./pages/a')`), and choose among those functions at run time" },
	'computed-require': { class: 'limit', title: 'require() of a computed specifier', suggestion: 'require each module by a literal path, and choose among them at run time' },
	'arguments-callee': { class: 'limit', title: '`arguments.callee`', suggestion: 'name the function and call it by its name', before: 'const f = function (n) { return n ? n * arguments.callee(n - 1) : 1; }', after: 'function f(n: number): number { return n ? n * f(n - 1) : 1; }' },
	proto: { class: 'limit', title: '`__proto__`', suggestion: 'use Object.getPrototypeOf, or a class hierarchy declared in the source', before: 'b.__proto__ === A.prototype', after: 'b instanceof A' },
	'process-env': { class: 'limit', title: 'process.env the bundler did not define', suggestion: 'a compiled release has no process environment: define the variable in the bundler config (Vite `define`, webpack DefinePlugin), which the compiled build reads too' },
	'undefined-constant': { class: 'limit', title: 'a bundler constant declared but never given a value', suggestion: 'if your bundler defines it (Vite `define`, webpack DefinePlugin), the compiled build reads the same config: check the name there; otherwise assign globalThis.NAME before it is read' },
	'shared-typed-copy': { class: 'limit', title: 'an array of one object type converted into an array of another, a copy where JavaScript shares it', suggestion: 'declare the value with the wanted type where it is made, or copy it explicitly (`list.map((x) => ({ ...x }))`)' },
	'shared-copy': { class: 'limit', title: 'an untyped value converted into a copy where JavaScript shares it', suggestion: 'give the value its type where it is made (`const out: number[] = []`, a typed field), so no copy is made; or copy explicitly (`const copy: number[] = Array.from(raw)`) and write the results back yourself' },

	'lone-surrogate': { class: 'limit', title: 'a string literal holding a lone surrogate (half of a UTF-16 pair)', why: 'an iOS build holds strings as Swift strings, which hold only whole Unicode characters: a lone surrogate would read as U+FFFD', suggestion: 'write whole characters, or keep the UTF-16 code units as numbers where the code works on halves of a pair' },

	// Declared limits of generic erasure: a generic class's type argument is part of its native type, so code that erases it
	// (`any` as the argument, a generic interface's field) is refused.
	'generic-any-argument': { class: 'limit', title: "a generic class's instance held with `any` as its type argument", why: "Swift holds a generic class's type argument, which `any` does not erase", suggestion: 'hold it with its own type argument; an overload implementation types its parameters and result as its overloads do', before: 'const box: Box<any> = new Box<number>(1)', after: 'const box: Box<number> = new Box<number>(1)' },
	'generic-field-overload': { class: 'limit', title: "a generic class's field met as a generic interface's field", why: "Swift can't overload a property by its type", suggestion: "declare the interface's field with a concrete type, or read it through a method" },
	'generic-field-erased': { class: 'limit', title: "a generic class's field met as a generic interface's writable field", why: "the interface's field is erased to any value, which the class's field can't override", suggestion: "declare the interface's field with a concrete type, or read it through a method" },

	// Code that runs as JavaScript and is not translated yet.
	'array-hole': { class: 'gap', title: 'an array hole', suggestion: 'write each missing element as `undefined`', before: 'const xs = [1, , 3]', after: 'const xs = [1, undefined, 3]' },
	'function-arguments': { class: 'gap', title: '`arguments` in a function expression', suggestion: 'take a rest parameter', before: 'const sum = function () { return [].slice.call(arguments).length; }', after: 'const sum = (...args: number[]) => args.length' },
	'builtin-prototype': { class: 'gap', title: 'a built-in prototype (Number.prototype, String.prototype), or a method added to it', suggestion: 'write the method as a plain function that takes the number', before: 'Number.prototype.isOne = function () { return this == 1; }; (1).isOne()', after: 'const isOne = (n: number) => n === 1; isOne(1)' },
	'object-call': { class: 'gap', title: 'Object(value)', suggestion: 'write what the call is used for: an object literal for a fresh object, or the value itself when it is already an object', before: 'const o = Object(v)', after: "const o = typeof v === 'object' && v !== null ? v : {}" },
	'library-member': { class: 'gap', title: 'a library function or member the compiler does not provide yet', suggestion: 'use the global or more common form where there is one (`parseInt(s)` for `Number.parseInt(s)`), or write the operation as a plain function', before: 'Number.parseInt(s, 10)', after: 'parseInt(s, 10)' },
	'function-value': { class: 'gap', title: 'a library function used as a value', suggestion: 'pass an arrow function that calls it', before: '[1, 2].forEach(console.log)', after: '[1, 2].forEach((x) => console.log(x))' },
	'other-receiver': { class: 'gap', title: ".call or .apply with a receiver other than the method's object", suggestion: 'call the function directly with its arguments, or make the receiver a parameter', before: 'log.call.call.apply(fn, [1, 2])', after: 'fn(2)' },
	'builtin-receiver': { class: 'gap', title: 'a built-in method called through .call or .apply on a value of another type', suggestion: "convert the value to the method's type first and call the method on it", before: 'String.prototype.trim.call(value)', after: 'String(value).trim()' },
	'function-new': { class: 'gap', title: '`new` of a function that is not a class', suggestion: 'declare a class whose constructor does what the function does, and construct the class' },
	'wrapper-object': { class: 'gap', title: 'a wrapper object (`new String(…)`, `new Number(…)`, `new Boolean(…)`)', suggestion: 'use the primitive value, which `String(x)`, `Number(x)` or `Boolean(x)` gives' },
	'class-prototype': { class: 'gap', title: "a class's prototype object (`C.prototype`) read as a value", suggestion: 'call the method on an instance, or declare it `static` and call it on the class' },
	'function-this': { class: 'gap', title: '`this` outside a method, constructor or class field', suggestion: 'pass the object the function works on as a parameter' },
	'element-accessor': { class: 'gap', title: 'a getter or setter defined on an array element', suggestion: 'keep the value in a class with a getter, or compute it when the array is built' },
	'private-receiver': { class: 'gap', title: 'a private member (`#x`) of a value not typed as its class', suggestion: 'type the value as its class (`o: Box`)' },
	'finally-jump': { class: 'gap', title: 'a jump out of a finally block', suggestion: 'keep the result in a variable and return it after the try statement', before: 'try { return a(); } finally { return b(); }', after: 'let r; try { a(); } finally { r = b(); } return r;' },
	'class-expression': { class: 'gap', title: 'a class expression', suggestion: 'declare the class with a name, then use it', before: 'const o = new (class { x = 1; })()', after: 'class Point { x = 1; } const o = new Point()' },
	'named-function-expression': { class: 'gap', title: 'a named function expression that refers to itself', suggestion: 'declare it as a function declaration and refer to that name', before: 'const g = function f(n) { return n ? f(n - 1) : 0; }', after: 'function f(n: number): number { return n ? f(n - 1) : 0; } const g = f' },
	'unsupported-base': { class: 'gap', title: 'a class extending null, Function or another base the compiler does not extend yet', suggestion: 'declare the class without that base: hold a function in a field and call it, or use Object.create(null) for an object without a prototype', before: 'class Fn extends Function { constructor() { super(); } }', after: 'class Fn { constructor(readonly call: () => number) {} }' },
	worker: { class: 'gap', title: 'a Worker in an iOS build', suggestion: "the iOS kit starts no workers yet (Android's does): run the work on the main thread in slices (a setTimeout per batch), or in native code on a background queue, and post its result back" },
	'delete-member': { class: 'gap', title: 'delete of this member', suggestion: 'keep entries that come and go in a Map (map.delete(key)), or make the field optional and assign undefined', before: 'delete this.cache[key]', after: 'this.cache.delete(key)  // cache: Map<string, T>' },
	'index-type': { class: 'gap', title: 'indexing this type', suggestion: 'give the indexed object a Record or Map type, or read the member by its name', before: '(obj as any)[key]', after: 'const table: Record<string, number> = obj; table[key]' },
	native: { class: 'gap', title: 'a native API the compiler does not call yet', suggestion: ISOLATE },
	internal: { class: 'gap', title: 'code the translator failed on', suggestion: ISOLATE },
	unhandled: { class: 'gap', title: 'a construct the compiler does not translate yet', suggestion: ISOLATE },
} as const satisfies Record<CompilerRefusalId, RefusalKind>;

/** The refusal of an id: the compiler's own, or the build's framework adapter's. */
export function refusalOf(id: RefusalId, adapter?: ActiveAdapter): RefusalKind {
	const r = Object.hasOwn(REFUSALS, id) ? REFUSALS[id as keyof typeof REFUSALS] : adapter?.refusal(id);
	if (!r) throw new Error(`no refusal ${id}: the build's framework adapter does not declare it`);
	return r;
}

/** Every refusal a build can report, its adapter's after the compiler's own. */
export function allRefusals(adapter?: ActiveAdapter): Readonly<Record<string, RefusalKind>> {
	return { ...REFUSALS, ...adapter?.refusals };
}

export const REPORT_HEADER = 'Constructs a compiled release does not run, with a rewrite for each:';
export const ISSUES_URL = 'https://github.com/NativeScript/NativeScript/issues';
const GAP_NOTE = `This is a compiler gap, not your code: please report it at ${ISSUES_URL}`;

export interface Site {
	id: RefusalId;
	at: string;
	code: string;
}

/** A place in a source file, its line and column counted from 1. */
export interface Position {
	file: string;
	line: number;
	column: number;
}

/**
 * A construct the build refuses: a declared limit of compiled releases or a gap of the compiler, of kind `id`, at `at`
 * where the refusal names its place. Any other error a translator throws is a bug of the compiler, and so is a refusal of
 * kind `internal` (`located`): a question asked speculatively answers "no" only for the others (`rethrowUnlessRefused`).
 */
export class Refusal extends Error {
	readonly id: RefusalId;
	readonly at: Position | undefined;
	/** The refused source text, as the refusal report shows it. */
	readonly code: string;
	constructor(message: string, id: RefusalId, at?: Position, code = '') {
		super(message);
		this.id = id;
		this.at = at;
		this.code = code;
	}
}

/** Rethrows `e` unless it refuses a construct: a bug of the compiler is never taken for an answer. */
export function rethrowUnlessRefused(e: unknown): asserts e is Refusal {
	if (!(e instanceof Refusal) || e.id === 'internal') throw e;
}

/**
 * What translating `n` failed with: a refusal that names its place as it is, anything else as an `internal` refusal at
 * `n`, made by the backend's `error`, its cause the error itself.
 */
export function located(e: unknown, n: ts.Node, error: (n: ts.Node, what: string, id: RefusalId) => Refusal): unknown {
	if (!(e instanceof Error) || (e instanceof Refusal && e.at)) return e;
	if (compiledEnv('STACKS'))
		console.error(
			e.stack
				?.split('\n')
				.filter((l) => !l.includes('typescript.js'))
				.slice(0, 80)
				.join('\n'),
		);
	return Object.assign(error(n, `what fails translating with "${e.message.split('\n')[0]}"`, 'internal'), { cause: e });
}

/**
 * The refusals of one build: those it made, by message, so a message reported as text (collected errors) finds its kind,
 * and those it reported, in order, for the refusal report.
 */
export class RefusalLog {
	private readonly made = new Map<string, Site>();
	private readonly hits: Site[] = [];
	/** The build's framework adapter, whose refusals the log names too. */
	private readonly adapter: () => ActiveAdapter | undefined;

	constructor(adapter: () => ActiveAdapter | undefined = () => undefined) {
		this.adapter = adapter;
	}

	/** The error for a refusal of kind `id` at `at`. */
	refusal(message: string, id: RefusalId, at?: Position, code = ''): Refusal {
		this.made.set(message.trim(), { id, at: at ? `${at.file}:${at.line}:${at.column}` : '', code });
		return new Refusal(message, id, at, code);
	}

	/** `error()`'s message and error. */
	refusedAt(file: string, line: number, column: number, what: string, code: string, id: RefusalId): Refusal {
		return this.refusal(`${file}:${line}:${column}: ${what} is not supported in a release build yet: ${code}`, id, { file, line, column }, code);
	}

	/** `limit()`'s message and error. */
	limitAt(file: string, line: number, column: number, what: string, code: string, id: RefusalId): Refusal {
		const r = refusalOf(id, this.adapter());
		return this.refusal(`${file}:${line}:${column}: ${what} is a declared limit of release builds (${r.why}); rewrite: ${r.suggestion}: ${code}`, id, { file, line, column }, code);
	}

	/** A preflight finding the build reported. */
	noteFinding(id: RefusalId, at: string, code: string): void {
		this.hits.push({ id, at, code });
	}

	/** The refusals `text` reports, one per line naming one. */
	sitesOf(text: string): Site[] {
		const out: Site[] = [];
		for (const line of text.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let site = this.made.get(trimmed);
			if (!site)
				for (const [m, s] of this.made)
					if (trimmed.includes(m)) {
						site = s;
						break;
					}
			if (site && !out.includes(site)) out.push(site);
		}
		return out;
	}

	/** Refusals the build reported as text. */
	noteRefused(text: string): void {
		for (const s of this.sitesOf(text)) if (!this.hits.includes(s)) this.hits.push(s);
	}

	/** The refusal report of what the build reported; empty when it reported nothing. */
	report(): string {
		return refusalReport(this.hits, this.adapter());
	}
}

/** The refusal report for `sites`, grouped by kind; empty when there are none. */
export function refusalReport(sites: readonly Site[], adapter?: ActiveAdapter): string {
	if (!sites.length) return '';
	const byKind = new Map<RefusalId, Site[]>();
	for (const h of sites) byKind.set(h.id, [...(byKind.get(h.id) ?? []), h]);
	const seen = new Set<string>();
	const out = ['', REPORT_HEADER];
	for (const [id, kind] of byKind) {
		const r = refusalOf(id, adapter);
		out.push('', `  ${r.title} [${id}]`, `    ${r.suggestion}`);
		if (r.before) out.push(`      before: ${r.before}`, `      after:  ${r.after}`);
		if (r.class === 'gap') out.push(`    ${GAP_NOTE}`);
		for (const s of kind) {
			const line = `    at ${s.at}${s.code ? `: ${s.code}` : ''}`;
			if (!seen.has(line)) {
				seen.add(line);
				out.push(line);
			}
		}
	}
	return out.join('\n');
}

/** Prints a build's report once, when the process exits, including after a refusal thrown to the top. */
export function reportOnExit(log: RefusalLog): void {
	process.on('uncaughtExceptionMonitor', (e) => log.noteRefused(String((e as Error)?.message ?? e)));
	process.on('exit', () => {
		const text = log.report();
		if (text) console.error(text);
	});
}
