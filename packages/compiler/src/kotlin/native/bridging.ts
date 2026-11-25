// Java's types and values as Kotlin calls them: JVM descriptors and their Kotlin types, primitive conversions and
// literals, and the syntax-tree questions direct Android calls ask.
import ts from 'typescript';
import type { JavaClass, JavaMember } from './classfiles.ts';
import { ident, numberLiteral, RT } from '../syntax.ts';
import { BUFFER_TYPES } from '../../semantics/globals.ts';

/**
 * A Kotlin file of the app's: where `hides` (`hidesKitAndroid`) and it names a class of package `android`, it imports the
 * kit's top-level `android` under another name, which hides the star import's from the file.
 */
export function withKitAndroidHidden(code: string, hides: boolean): string {
	return hides && /(?<![\w.`$])android\.[a-z]/.test(code) ? code.replace('import org.nativescript.kit.*\n', 'import org.nativescript.kit.*\nimport org.nativescript.kit.android as kitAndroid\n') : code;
}

export const NUMERIC = new Set(['B', 'S', 'I', 'J', 'F', 'D']);
/** The script types a binding passes as a buffer: the library's, and SharedArrayBuffer. */
export const NATIVE_BUFFER_TYPES: ReadonlySet<string> = new Set([...BUFFER_TYPES, 'SharedArrayBuffer']);
export const KOTLIN_PRIMITIVE: Record<string, string> = { Z: 'Boolean', B: 'Byte', C: 'Char', S: 'Short', I: 'Int', J: 'Long', F: 'Float', D: 'Double', V: 'Unit' };
// Through Long: a number past Int's range wraps, as NativeScript converts it (ToInt32), where Double.toInt() clamps (0xff1c1c1e).
export const CONVERT: Record<string, string> = { B: '.toLong().toByte()', S: '.toLong().toShort()', I: '.toLong().toInt()', J: '.toLong()', F: '.toFloat()', D: '' };
export const ARRAY_OF: Record<string, string> = { Z: 'boolean', B: 'byte', C: 'char', S: 'short', I: 'int', J: 'long', F: 'float', D: 'double' };
/** A JavaScript number's preference among numeric parameter types, as NativeScript's runtime ranks them for a whole number. */
export const NUMBER_RANK: Record<string, number> = { I: 0, J: 1, F: 2, D: 3, S: 4, B: 5 };
export const BOXED_NUMBERS = new Set(['java/lang/Integer', 'java/lang/Long', 'java/lang/Float', 'java/lang/Double', 'java/lang/Short', 'java/lang/Byte', 'java/lang/Number']);
/** Java methods Kotlin reads as its own members (`CharSequence.length()` is `length`): interface, name and descriptor → Kotlin. */
export const KOTLIN_MAPPED: Record<string, string> = {
	'java/lang/CharSequence.length()I': '.length',
	'java/lang/CharSequence.charAt(I)C': '.get',
	'java/util/Collection.size()I': '.size',
	'java/util/Map.size()I': '.size',
	'java/util/Collection.toArray()[Ljava/lang/Object;': '.toTypedArray',
	'java/util/Map.keySet()Ljava/util/Set;': '.keys',
	'java/util/Map.values()Ljava/util/Collection;': '.values',
	'java/util/Map.entrySet()Ljava/util/Set;': '.entries',
	'java/util/Map$Entry.getKey()Ljava/lang/Object;': '.key',
	'java/util/Map$Entry.getValue()Ljava/lang/Object;': '.value',
	'java/lang/Number.intValue()I': '.toInt',
	'java/lang/Number.longValue()J': '.toLong',
	'java/lang/Number.floatValue()F': '.toFloat',
	'java/lang/Number.doubleValue()D': '.toDouble',
	'java/lang/Number.shortValue()S': '.toShort',
	'java/lang/Number.byteValue()B': '.toByte',
	'java/lang/Enum.ordinal()I': '.ordinal',
	'java/lang/Enum.name()Ljava/lang/String;': '.name',
	'java/lang/Throwable.getMessage()Ljava/lang/String;': '.message',
	'java/lang/Throwable.getCause()Ljava/lang/Throwable;': '.cause',
	'java/lang/Object.getClass()Ljava/lang/Class;': '.javaClass',
};
/** Java collection interfaces Kotlin reads as its own: a value Java returns is not assignable to the Java name. */
export const KOTLIN_COLLECTIONS: Record<string, string> = {
	'java/util/List': 'MutableList',
	'java/util/Collection': 'MutableCollection',
	'java/util/Set': 'MutableSet',
	'java/util/Map': 'MutableMap',
	'java/util/Map$Entry': 'MutableMap.MutableEntry',
	'java/util/Iterator': 'MutableIterator',
	'java/lang/Iterable': 'MutableIterable',
};
export const ANDROID_TYPINGS = /[\\/]@nativescript[\\/]types-android[\\/]|[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]*android[^\\/]*[\\/].*\.d\.ts$/i;

export type Kind = { kind: 'number'; literal?: number; forced?: string } | { kind: 'string'; literal?: string } | { kind: 'boolean' | 'null' | 'any' | 'other' } | { kind: 'array'; elem: Kind } | { kind: 'object'; classes: string[] };

/** A Java method or constructor; `fixed` when a varargs call passes its last parameter's elements one by one after that many arguments. */
export interface Callable {
	m: JavaMember;
	params: string[];
	ret: string;
	fixed?: number;
}
/** A Java class NativeScript's `Base.extend({ … })` makes, as the Kotlin class `name` declared where `owner` is. */
export interface Extension {
	call: ts.CallExpression;
	literal: ts.ObjectLiteralExpression;
	base: JavaClass;
	interfaces: JavaClass[];
	owner: ts.VariableDeclaration | null;
	name: string;
	javaName?: string;
}
/** Java code and its Java type; `nullable` when it is annotated `@Nullable` and so typed `T?` in Kotlin. */
export interface Raw {
	code: string;
	desc: string;
	optional?: boolean;
	nullable?: boolean;
	recentlyNullable?: boolean;
	script?: boolean;
}

export function extensionClasses(x: Extension): string[] {
	return [x.base.name, ...x.interfaces.map((i) => i.name)];
}

export function skipCasts(e: ts.Expression): ts.Expression {
	while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
	return e;
}

export function propertyName(p: ts.ObjectLiteralElementLike): string | undefined {
	if (!p.name || ts.isComputedPropertyName(p.name) || ts.isPrivateIdentifier(p.name)) return undefined;
	return p.name.text;
}

export function functionOf(p: ts.ObjectLiteralElementLike): ts.FunctionLikeDeclaration | null {
	if (ts.isMethodDeclaration(p)) return p;
	return ts.isPropertyAssignment(p) && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer)) ? p.initializer : null;
}

/** The function or module a declaration's name is visible throughout. */
export function scopeOf(d: ts.Node): ts.Node {
	let n = d.parent;
	while (!ts.isSourceFile(n) && !(ts.isFunctionLike(n) && 'body' in n)) n = n.parent;
	return n;
}

export function contains(outer: ts.Node, n: ts.Node): boolean {
	for (let p: ts.Node | undefined = n; p; p = p.parent) if (p === outer) return true;
	return false;
}

export function hasStatic(m: ts.Node): boolean {
	return ts.canHaveModifiers(m) && !!ts.getModifiers(m)?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword);
}

/** `return global.__native(this)`: NativeScript's runtime hook a TypeScript constructor of a Java subclass ends with. */
export function isNativeReturn(s: ts.Statement): boolean {
	if (!ts.isReturnStatement(s) || !s.expression || !ts.isCallExpression(s.expression)) return false;
	const callee = s.expression.expression;
	return (ts.isIdentifier(callee) && callee.text === '__native') || (ts.isPropertyAccessExpression(callee) && callee.name.text === '__native');
}

export function numericLiteral(e: ts.Expression): number | null {
	while (ts.isParenthesizedExpression(e)) e = e.expression;
	if (ts.isNumericLiteral(e)) return Number(e.text.replace(/_/g, ''));
	if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand)) return -Number(e.operand.text.replace(/_/g, ''));
	return null;
}

/** A number literal as Kotlin writes a literal of the Java primitive `desc`. */
export function primitiveLiteral(v: number, desc: string): string {
	const whole = Number.isInteger(v);
	switch (desc) {
		case 'D':
			return numberLiteral(String(v));
		case 'F':
			return Number.isFinite(v) ? `${String(v).replace(/e\+?/, 'e')}f` : `${numberLiteral(String(v))}.toFloat()`;
		case 'I':
			return whole && Math.abs(v) <= 0x7fffffff ? String(v) : `(${numberLiteral(String(v))}).toLong().toInt()`;
		case 'J':
			return whole && Number.isSafeInteger(v) ? `${v}L` : `(${numberLiteral(String(v))}).toLong()`;
		case 'C':
			return `${Math.trunc(v)}.toChar()`;
		default:
			return `(${whole ? v : numberLiteral(String(v))})${CONVERT[desc].replace('.toInt().', whole ? '.' : '.toInt().')}`;
	}
}

export function charLiteral(c: string): string {
	const escapes: Record<string, string> = { '\\': '\\\\', "'": "\\'", '\n': '\\n', '\r': '\\r', '\t': '\\t', $: '$' };
	return `'${escapes[c] ?? (c.charCodeAt(0) < 0x20 ? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}` : c)}'`;
}

/** Kotlin code that a member access or conversion can follow as is: a name chain, a call chain, or one parenthesized group. */
export function atom(code: string): string {
	let depth = 0;
	for (let i = 0; i < code.length; i++) {
		const c = code[i];
		if (c === '"') {
			for (i++; i < code.length && code[i] !== '"'; i++) if (code[i] === '\\') i++;
			continue;
		}
		if ('([{'.includes(c)) depth++;
		else if (')]}'.includes(c)) depth--;
		else if (depth === 0 && !/[\w.!?:$]/.test(c)) return `(${code})`;
		else if (depth === 0 && c === '?' && code[i + 1] !== '.') return `(${code})`;
		else if (depth === 0 && c === ':' && code[i + 1] !== ':') return `(${code})`;
	}
	return code;
}

/** Kotlin type arguments split at their top-level commas. */
export function splitArgs(text: string): string[] {
	const out: string[] = [];
	let depth = 0,
		start = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === '<' || ch === '(') depth++;
		else if ((ch === '>' && text[i - 1] !== '-') || ch === ')') depth--;
		else if (ch === ',' && depth === 0) {
			out.push(text.slice(start, i).trim());
			start = i + 1;
		}
	}
	out.push(text.slice(start).trim());
	return out;
}

/** The index of the `>` closing the `<` at `start`. */
export function matchingAngle(sig: string, start: number): number {
	let depth = 0;
	for (let i = start; i < sig.length; i++) {
		if (sig[i] === '<') depth++;
		else if (sig[i] === '>' && --depth === 0) return i;
	}
	return sig.length - 1;
}

/** A class signature's supertypes, one type signature each (`Ljava/lang/Object;Lpkg/Binder<TX;>;`). */
export function topLevelTypes(sig: string): string[] {
	const out: string[] = [];
	let depth = 0,
		start = 0;
	for (let i = 0; i < sig.length; i++) {
		const c = sig[i];
		if (c === '<') depth++;
		else if (c === '>') depth--;
		else if (c === ';' && depth === 0) {
			out.push(sig.slice(start, i + 1));
			start = i + 1;
		}
	}
	return out;
}

/**
 * The first statement of an override Java may call from any thread: from a thread other than its
 * realm's, the call is made again there, posted for a method returning nothing, awaited for one
 * returning a value.
 */
export function enteredGuard(name: string, params: string[], target: Callable, indent: string): string {
	const args = params.join(', ');
	return `${indent}    ${RT.jsElsewhere}(__realm)?.let { return it.${target.ret === 'V' ? 'later' : 'await'} { this.${ident(name)}(${args}) } }`;
}

/**
 * A guarded override in a main-thread class: `@AnyThread`, as Java may call it from any thread, and the code past
 * its guard in `jsOnMainThread { }`, so lint checks that code as running on the main thread, where the guard puts it.
 */
export function mainThreadOverride(code: string): string {
	const lines = code.split('\n');
	const head = lines.findIndex((l) => /^\s*override fun /.test(l));
	const guard = lines.findIndex((l) => l.includes(`${RT.jsElsewhere}(__realm)?.let {`));
	const close = lines.length - 1;
	if (head < 0 || guard < head || !/^\s*}$/.test(lines[close])) return code;
	const indent = /^\s*/.exec(lines[close])![0];
	lines[head] = lines[head].replace(/^(\s*)override fun /, '$1@AnyThread override fun ');
	const body = lines.slice(guard + 1, close).map((l) => (l ? '    ' + l : l));
	if (!body.some((l) => l.trim())) return lines.join('\n');
	return [...lines.slice(0, guard + 1), `${indent}    ${RT.jsOnMainThread} {`, ...body, `${indent}    }`, lines[close]].join('\n');
}

/** What Java gets from an override whose code threw, by its return descriptor: the type's zero, null for an object. */
const REPORTED_RESULT: Record<string, string> = { Z: 'false', B: '0.toByte()', S: '0.toShort()', C: "'\\u0000'", I: '0', J: '0L', F: '0f', D: '0.0' };

/**
 * An override Java calls: what its code throws is reported as uncaught, as NativeScript reports an error escaping a
 * callback, and Java gets the result type's zero; an exception escaping to Java would end the app. An override whose
 * result Kotlin declares non-null is left as it is: it has no value to give.
 */
export function reportingOverride(code: string, ret: string): string {
	const lines = code.split('\n');
	const head = lines.findIndex((l) => /^\s*(@AnyThread )?override fun /.test(l));
	const guard = lines.findIndex((l) => l.includes(`${RT.jsElsewhere}(__realm)?.let {`));
	const close = lines.length - 1;
	if (head < 0 || guard < head || !/^\s*}$/.test(lines[close])) return code;
	const nullable = /\)\s*:\s*[^{]*\?\s*\{\s*$/.test(lines[head]);
	const fallback = ret === 'V' ? null : (REPORTED_RESULT[ret] ?? (nullable ? 'null' : undefined));
	if (fallback === undefined) return code;
	const body = lines.slice(guard + 1, close).map((l) => (l ? '    ' + l : l));
	if (!body.some((l) => l.trim())) return code;
	const indent = /^\s*/.exec(lines[close])![0];
	return [...lines.slice(0, guard + 1), fallback === null ? `${indent}    ${RT.jsReport} {` : `${indent}    return ${RT.jsReportedOr}(${fallback}) {`, ...body, `${indent}    }`, lines[close]].join('\n');
}

/** A class's members, with the realm its overrides' guards read when any has one: the realm that made the object. */
export function withRealm(members: string[], indent: string): string[] {
	return members.some((m) => m.includes(`${RT.jsElsewhere}(__realm)`)) ? [`${indent}private val __realm: JSRealm? = JSRealm.current()`, ...members] : members;
}
