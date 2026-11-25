// Native values and types as Swift bridges them: numbers and their native types, CF and Foundation bridging, blocks, and
// calls native code may make from another thread.
import ts from 'typescript';
import { nativeTable, type SwiftType } from './sdk.ts';
import type { SwiftMarks } from '../marks.ts';
import { RT } from '../syntax.ts';

/** A buffer, a view of one, or an untyped value that may be either. */
export const BUFFER_SOURCE = /^(JSArrayBuffer|JSDataView|JSArrayBufferView|JS(Int8|Uint8|Uint8Clamped|Int16|Uint16|Int32|Uint32|Float32|Float64|BigInt64|BigUint64)Array|Any)\??$/;

export const NUMBERS = new Set(['CGFloat', 'Double', 'Float', 'Float32', 'Float64', 'Int', 'UInt', 'Int8', 'Int16', 'Int32', 'Int64', 'UInt8', 'UInt16', 'UInt32', 'UInt64', 'TimeInterval', 'NSInteger', 'NSUInteger']);
export const INTEGERS = new Set(['Int', 'UInt', 'Int8', 'Int16', 'Int32', 'Int64', 'UInt8', 'UInt16', 'UInt32', 'UInt64', 'NSInteger', 'NSUInteger']);

/** A number as a native numeric type, as the runtime marshals it: an integer type takes NaN and the infinities as 0 and clamps the rest. */
export function integral(code: string, type: string): string {
	return INTEGERS.has(type) ? `${RT.jsNativeInteger}(${code}, ${type}.self)` : `${type}(${code})`;
}
export const base = (t: SwiftType) => t.replace(/[?!]$/, '').replace(/^\((.*)\)$/, '$1');
export const optional = (t: SwiftType) => /[?!]$/.test(t);
/** Foundation's classes Swift imports as its value types where an API takes or returns one (`NSURL` as `URL`). */
export const BRIDGED: Record<string, string> = {
	NSURL: 'URL',
	NSDate: 'Date',
	NSData: 'Data',
	NSIndexPath: 'IndexPath',
	NSNotification: 'Notification',
	NSUUID: 'UUID',
	NSLocale: 'Locale',
	NSTimeZone: 'TimeZone',
	NSCalendar: 'Calendar',
	NSURLRequest: 'URLRequest',
	NSDateComponents: 'DateComponents',
	NSCharacterSet: 'CharacterSet',
	NSURLComponents: 'URLComponents',
	NSIndexSet: 'IndexSet',
	NSPersonNameComponents: 'PersonNameComponents',
	UTTypeReference: 'UTType',
	NSError: 'any Error',
	CFString: 'String',
};
/** A Foundation collection (an `NSArray`, `[Any]`, an untyped value) as Swift's typed array, dictionary or set `type`; null for any other type. */
export function typedCollection(code: string, type: SwiftType): string | null {
	const meta = (t: string) => `${t.startsWith('any ') ? `(${t})` : t}.self`;
	const member = /^Set<(.+)>$/.exec(type)?.[1];
	if (member) return `${RT.jsMembers}(${code}, ${meta(member)})`;
	const parts = /^\[(.*)\]$/.exec(type)?.[1];
	if (parts === undefined) return null;
	let depth = 0,
		colon = -1;
	for (let k = 0; k < parts.length && colon < 0; k++) {
		if ('[(<'.includes(parts[k])) depth++;
		else if ('])>'.includes(parts[k])) depth--;
		else if (parts[k] === ':' && !depth) colon = k;
	}
	if (colon < 0) return `${RT.jsElements}(${code}, ${meta(parts.trim())})`;
	return `${RT.jsEntries}(${code}, ${meta(parts.slice(0, colon).trim())}, ${meta(parts.slice(colon + 1).trim())})`;
}

/** `code` of Objective-C class or Swift value type `from` as `to`, the other one of a bridged pair; null when they are not one. */
export function bridge(code: string, from: SwiftType, to: SwiftType): string | null {
	const f = base(from),
		b = base(to);
	// A Core Foundation array is an NSArray, which Swift reads as an array of its elements.
	if (f === 'CFArray' && /^\[[^:]*\]$/.test(b)) return optional(to) ? `(${code}).map { ${typedCollection('$0', b)} }` : typedCollection(code, b);
	// `NSSet` and Swift's `Set<T>`: toward the typed set the cast checks the elements.
	const typedSet = /^NS(Mutable)?Set$/.test(f) && /^Set<.+>$/.test(b);
	// A mutable request where a request is taken: Swift bridges it as its immutable base.
	if (f === 'NSMutableURLRequest' && b === 'URLRequest') return `(${code} as URLRequest${optional(to) ? '?' : ''})`;
	if (BRIDGED[f] !== b && BRIDGED[b] !== f && !typedSet && !(/^Set<.+>$/.test(f) && b === 'NSSet')) return null;
	const want = b === 'any Error' ? '(any Error)' : b;
	if (optional(to)) return `(${code} as${typedSet ? '?' : ''} ${want}${typedSet ? '' : '?'})`;
	if (typedSet) return typedCollection(code, b)!;
	return `(${code}${optional(from) ? '!' : ''} as ${want})`;
}
/** Classes NativeScript's typings rename where TypeScript's DOM library declares the name. */
export const RENAMED: Record<string, string> = { _UIEvent: 'UIEvent' };
/** The iOS version the app targets: newer APIs need `if #available` the translation cannot add. */
export const DEPLOYMENT = 17;

/**
 * A plugin's typings, registered to its module, also declare the plugin's own JavaScript classes and option interfaces:
 * only a name the module's table has is native.
 */
export function tableDeclares(module: string, decl: ts.Node): boolean {
	let top = decl;
	while (top.parent && !ts.isSourceFile(top.parent) && !ts.isModuleBlock(top.parent)) top = top.parent;
	const id = ts.isVariableStatement(top) ? top.declarationList.declarations[0]?.name : (top as ts.NamedDeclaration).name;
	if (!id || !ts.isIdentifier(id)) return true;
	const t = nativeTable(module),
		n = id.text;
	return !!(t.classes[n] || t.enums[n] || t.structs[n] || t.functions[n] || t.constants[n] || t.typealiases?.[n] || t.swiftTypes?.[n]);
}

/** A call given `&__nsError` (`errorOut`): the error it writes thrown, as the iOS runtime throws it. */
export function withErrorOut(call: string, returns: SwiftType): string {
	const ret = returns === 'Void' ? 'Void' : returns;
	const body = returns === 'Void' ? `${call}; if let __nsError { throw __nsError }` : `let __r = ${call}; if let __nsError { throw __nsError }; return __r`;
	return `({ () throws -> ${ret} in var __nsError: NSError? = nil; ${body} }())`;
}

/** An expression whose value is only tested for truthiness: a condition, or what `!` negates. */
export function onlyTested(e: ts.Expression): boolean {
	const p = e.parent;
	if (ts.isParenthesizedExpression(p)) return onlyTested(p);
	if (ts.isPrefixUnaryExpression(p)) return p.operator === ts.SyntaxKind.ExclamationToken;
	if (ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) return p.expression === e;
	if (ts.isConditionalExpression(p) || ts.isForStatement(p)) return p.condition === e;
	return false;
}

/** An expression whose value only decides a branch: a condition, the operand of `!`, or an operand of `&&`/`||` that is one or comes first. */
export function tested(e: ts.Expression): boolean {
	const p = e.parent;
	if (ts.isParenthesizedExpression(p)) return tested(p);
	if (ts.isPrefixUnaryExpression(p)) return p.operator === ts.SyntaxKind.ExclamationToken;
	if (ts.isBinaryExpression(p) && (p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || p.operatorToken.kind === ts.SyntaxKind.BarBarToken)) return p.left === e || tested(p);
	if (ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) return p.expression === e;
	if (ts.isConditionalExpression(p) || ts.isForStatement(p)) return p.condition === e;
	return false;
}

export function inStaticMember(n: ts.Node): boolean {
	for (let p = n.parent; p?.parent; p = p.parent) {
		if (ts.isClassLike(p.parent) && ts.isClassElement(p)) return ts.getModifiers(p as ts.ClassElement & ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false;
	}
	return false;
}

function splitTypes(text: string): string[] {
	const out: string[] = [];
	let depth = 0,
		start = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if ('([<'.includes(ch)) depth++;
		else if (')]>'.includes(ch) && text[i - 1] !== '-') depth--;
		else if (ch === ',' && depth === 0) {
			out.push(text.slice(start, i).trim());
			start = i + 1;
		}
	}
	out.push(text.slice(start).trim());
	return out.filter(Boolean);
}

/** A block parameter's Swift type (`((A, B) -> R)?`, `@escaping (A) -> Void`) as parameter and result types. */
export function blockType(type: SwiftType): { text: string; params: string[]; result: string } | null {
	// Attributes (`@escaping`, `@Sendable`, `@MainActor`) do not change how a closure is written.
	const bare = (x: string) => x.trim().replace(/^(?:@\w+\s*)+/, '');
	let t = bare(type);
	if (t.endsWith('?') || t.endsWith('!')) t = t.slice(0, -1);
	while (t.startsWith('(') && matching(t, 0) === t.length - 1) t = bare(t.slice(1, -1));
	if (!t.startsWith('(')) return null;
	const close = matching(t, 0);
	const rest = /^\s*(?:throws\s*)?->\s*(.+)$/.exec(t.slice(close + 1));
	if (!rest) return null;
	const inner = t.slice(1, close).trim();
	const params = inner ? splitTypes(inner) : [];
	return { text: `(${params.join(', ')}) -> ${rest[1]}`, params, result: rest[1].trim() };
}

function matching(t: string, open: number): number {
	let depth = 0;
	for (let i = open; i < t.length; i++) {
		if (t[i] === '(' || t[i] === '[' || t[i] === '<') depth++;
		else if (t[i] === ')' || t[i] === ']' || (t[i] === '>' && t[i - 1] !== '-')) {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * An optional native value where script's type is `tsType`: optional stays optional; one lenient code holds implicitly
 * unwrapped (`implicit`, or a `T!` type) is read through `jsImplicit`, which unwraps only where a value is needed, as
 * JavaScript reads a missing one as undefined; anything else is unwrapped.
 */
export function unwrapAs(marks: SwiftMarks, optionalCode: string, tsType: string, implicit: boolean): string {
	if (tsType.endsWith('?')) return optionalCode;
	return implicit || tsType.endsWith('!') ? marks.implicitOf(optionalCode) : marks.unwrappedCode(optionalCode);
}

/**
 * Whether a native callback of this result and these parameters, entered from another thread, is
 * posted to the main thread rather than awaited: one returning nothing, unless a pointer or a
 * non-escaping block among its arguments lives only as long as the call.
 */
export function posted(ret: string, params: string[], escaping?: number[]): boolean {
	return ret === 'Void' && !params.some((p, k) => /\bUnsafe/.test(p) || (/->/.test(p) && !/[?!]\s*$/.test(p) && !/@escaping/.test(p) && !escaping?.includes(k)));
}

/** A parameter's label and name, the name alone where it is the label. */
export const labeled = (label: string | null, name: string) => (label === name ? name : `${label ?? '_'} ${name}`);

/**
 * The code of a method native code may call from any thread, past its guard (`enteredGuard`): script code, isolated to
 * the main actor. The method itself is `nonisolated`, as Swift would otherwise check the thread before the guard runs.
 * Its parameters (`names`, of `types`) are handed to the code rather than captured, which Swift would see as values of
 * the calling thread shared with the main actor; a non-escaping block cannot be handed on, and stays captured.
 */
export function onMainThread(code: string, ret: string, indent = '', names: string[] = [], types: string[] = []): string {
	const passed = names.filter((_, k) => !(/->/.test(types[k] ?? '') && !/[?!]\s*$/.test(types[k]) && !/@escaping/.test(types[k])));
	if (passed.length > 8) throw new Error(`a native method of ${passed.length} parameters (jsOnMainThread takes at most 8)`);
	const call = `${RT.jsOnMainThread}${passed.length ? `(${passed.join(', ')})` : ''}`;
	const head = ret === 'Void' ? (passed.length ? ` ${passed.join(', ')} in` : '') : ` (${passed.join(', ')}) -> ${ret} in`;
	const lead = ret === 'Void' ? call : `return ${call}`;
	if (!indent) return `${lead} {${head} ${code} }`;
	// Re-indented as the closure's body, unless that would change a multi-line string literal.
	const body = code.includes('"""')
		? code
		: code
				.split('\n')
				.map((l) => (l ? `    ${l}` : l))
				.join('\n');
	return `${indent}${lead} {${head}\n${body}\n${indent}}`;
}

/** The first statement of a method native code may call from any thread: from another, the call is made again on the main thread. */
export function enteredGuard(name: string, labels: (string | null)[], params: string[], ret: string, indent: string, escaping?: number[], names = params.map((_, k) => `__a${k}`)): string {
	const call = `self.${name}(${params.map((_, k) => (labels[k] && labels[k] !== '_' ? `${labels[k]}: ${names[k]}` : names[k])).join(', ')})`;
	return `${indent}if ${RT.jsOffScriptThread}() { ${posted(ret, params, escaping) ? `${RT.jsLater} { ${call} }; return` : `return ${RT.jsAwait} { ${call} }`} }`;
}

/** A value boxed for any slot (`(x as Any?)`) as its own value, parenthesized (`(x)`); any other code as it is. */
export function unboxed(marks: SwiftMarks, code: string): string {
	const c = marks.markOf(code);
	return c?.op === 'cast' && c.up && c.spelled === 'Any' ? `(${c.of.code})` : code;
}
