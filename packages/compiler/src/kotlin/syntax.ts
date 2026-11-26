// Kotlin as the translator writes it, and the syntax-tree questions only the Kotlin backend asks: names and literals,
// type spellings, the shape of emitted code. Nothing here reads the translator's state.
import { heldLoss } from '../semantics/losses.ts';
import ts from 'typescript';
import type { AsyncSyntax } from '../semantics/async.ts';
import { KOTLIN_RUNTIME } from '../semantics/runtime.ts';
import { ERROR_CLASS, isKit, isUntyped, spelledType, type NativeKind, type NativeType, type Spelling } from '../semantics/types.ts';
import { dollarIdent } from '../semantics/lang.ts';

const KEYWORDS = new Set(['as', 'break', 'class', 'continue', 'do', 'else', 'false', 'for', 'fun', 'if', 'in', 'interface', 'is', 'null', 'object', 'package', 'return', 'super', 'this', 'throw', 'true', 'try', 'typealias', 'typeof', 'val', 'var', 'when', 'while']);

/** Whether code's parentheses balance with none closing before its end (`a(b) ?: c` splits, `(a ?: b)` does not). */

/** The runtime functions this backend calls, by operation (semantics/runtime.ts). */
export const RT = KOTLIN_RUNTIME;

const ASSERTED_READS: Readonly<Record<string, readonly [string, string]>> = { String: [RT.jsAssertedString, RT.jsAssertedStringOrNull], Double: [RT.jsAssertedNumber, RT.jsAssertedNumberOrNull], Boolean: [RT.jsAssertedBoolean, RT.jsAssertedBooleanOrNull] };
const ADAPTERS = [RT.jsAdapt0, RT.jsAdapt1, RT.jsAdapt2, RT.jsAdapt3, RT.jsAdapt4];

/** What the kit's asserted and converted reads give for undefined. */
export const EMPTY_READ: Readonly<Record<string, string>> = { String: '""', Double: 'Double.NaN', Boolean: 'false' };

/** The kit's read of any value asserted to be a `type` (`String`, `Double` or `Boolean`); `orNull`: null where it is undefined. */
export function assertedReader(type: string, orNull = false): string {
	if (!orNull) heldLoss('assertedRead', EMPTY_READ[type]);
	return ASSERTED_READS[type][orNull ? 1 : 0];
}

/** The kit's adapter of a function of `arity` parameters (at most 4) to another function type, keeping its identity. */
export function adaptOf(arity: number): string {
	return ADAPTERS[arity];
}

export function wrapsWhole(code: string): boolean {
	let depth = 0;
	for (const ch of code) {
		if (ch === '(') depth++;
		else if (ch === ')' && --depth < 0) return false;
	}
	return depth === 0 && !/ \?: /.test(code.replace(/\([^()]*\)/g, ''));
}

/** Whether a postfix member can follow code as is: a name or member chain, optionally ending in one call. */
export function postfixable(code: string): boolean {
	const name = /^[\w.]+(?=\(|$)/.exec(code);
	if (!name) return false;
	let depth = 0;
	for (let i = name[0].length; i < code.length; i++) {
		if (code[i] === '(') depth++;
		else if (code[i] === ')' && --depth === 0 && i < code.length - 1) return false;
	}
	return depth === 0;
}

/** Whether code is one parenthesised group: its first parenthesis closes at its end. */
export function grouped(code: string): boolean {
	if (!code.startsWith('(')) return false;
	let depth = 0,
		quoted = false;
	for (let i = 0; i < code.length; i++) {
		const ch = code[i];
		if (quoted) {
			if (ch === '\\') i++;
			else if (ch === '"') quoted = false;
			continue;
		}
		if (ch === '"') quoted = true;
		else if (ch === '(') depth++;
		else if (ch === ')' && --depth === 0) return i === code.length - 1;
	}
	return false;
}

/** `!code`, parenthesised only when code is not a name, call chain or group; the negation of a negation is its operand. */
export function negated(code: string): string {
	if (code.startsWith('!') && !code.startsWith('!=')) {
		const inner = code.slice(1);
		if (postfixable(inner)) return inner;
		if (grouped(inner)) return postfixable(inner.slice(1, -1)) ? inner.slice(1, -1) : inner;
	}
	if (postfixable(code) && code.endsWith('.isNotEmpty()')) return `${code.slice(0, -'isNotEmpty()'.length)}isEmpty()`;
	const tested = / (!=|==) (null|true)$/.exec(code),
		left = tested && code.slice(0, tested.index);
	if (left && infixOperand(left) === left) return `${left} ${tested[1] === '!=' ? '==' : '!='} ${tested[2]}`;
	return postfixable(code) || grouped(code) ? `!${code}` : `!(${code})`;
}

/** Code as the left operand of an infix operator such as `!=`: a name or call chain, safe calls included, as is. */
export function infixOperand(code: string): string {
	return postfixable(code.replace(/\?\./g, '.').replace(/!!(?=\.|$)/g, '')) || grouped(code) ? code : `(${code})`;
}

/** `jsObjectOf("k" to v, …)` of key and value code; a value whose top level has an operator `to` binds tighter than is parenthesised. */
export function jsObjectCode(entries: [string, string][]): string {
	const operand = (code: string) => {
		let depth = 0,
			quoted = false,
			top = '';
		for (let i = 0; i < code.length; i++) {
			const ch = code[i];
			if (quoted) {
				if (ch === '\\') i++;
				else if (ch === '"') quoted = false;
				continue;
			}
			if (ch === '"') quoted = true;
			else if ('({['.includes(ch)) depth++;
			else if (')}]'.includes(ch)) depth--;
			else if (depth === 0) top += ch;
		}
		return / (?:\?:|!?in|!?is|<=?|>=?|[=!]==?|&&|\|\||[A-Za-z_]\w*) /.test(top) ? `(${code})` : code;
	};
	return `${RT.jsObjectOf}(${entries.map(([k, v]) => `${k} to ${operand(v)}`).join(', ')})`;
}

/** Whether code is one expression: its brackets balance with none closing before its end, and no `;` between them. */
export function oneExpression(code: string): boolean {
	let depth = 0;
	for (const ch of code) {
		if ('({['.includes(ch)) depth++;
		else if (')}]'.includes(ch) && --depth < 0) return false;
		else if (ch === ';' && depth === 0) return false;
	}
	return depth === 0;
}

/** A Kotlin type with type parameters replaced (`JSArray<T>` with T as Label). */
export function substituteTypes(type: string, args: Map<string, string>): string {
	let out = type;
	for (const [n, t] of args) out = out.replace(new RegExp(`\\b${n}\\b`, 'g'), t);
	return out.replace(/\?\?/g, '?');
}

/** The key script reads an accessor by: a computed name's string (`get ['class']()` is `class`). */
export function accessorKey(name: string): string {
	return /^\[(['"])(.*)\1\]$/.exec(name)?.[2] ?? name;
}

/** The method holding the body of a setter that takes more than its getter gives (`setterTakes`). */
export function setterMethod(name: string): string {
	return `__set_${accessorKey(name).replace(/\W/g, '_')}`;
}

/** A program class's toString that may give no string (`toStringGivesNonString`): Kotlin's Any.toString gives a String. */
export const OBJECT_TO_STRING = '__toString';

export function ident(name: string): string {
	if (name === '_') return '__underscore';
	// Kotlin reserves names of underscores alone, and `$`-only names (`$`, `$$`) would collapse to them.
	if (/^_+$/.test(name)) return `__underscore${name.length}`;
	const dollar = dollarIdent(name);
	if (dollar) return dollar;
	// A name of punctuation alone (`'+'`, `'!'` keys) spells its characters, or every such name would be `_`.
	if (!/[\w$#]/.test(name)) return '__k' + [...name].map((c) => c.codePointAt(0)!.toString(16)).join('_');
	const n = name
		.replace(/^#/, '_p_')
		.replace(/\$/g, '_')
		.replace(/^(?=\d)/, '_')
		.replace(/[^\w]/g, '_');
	return KEYWORDS.has(n) ? `\`${n}\`` : n;
}

export const OBJECT_REQUIRED = ` ?: ${RT.jsObjectRequired}())`;

export function kotlinString(text: string): string {
	return '"' + escapeText(text) + '"';
}

export function escapeText(text: string): string {
	// A lone surrogate is escaped: written to the UTF-8 source as itself, it would read as U+FFFD.
	return text.replace(/[\\"$\n\r\t\b]|[\u0000-\u001f\u007f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, (c) => {
		switch (c) {
			case '\\':
				return '\\\\';
			case '"':
				return '\\"';
			case '$':
				return '\\$';
			case '\n':
				return '\\n';
			case '\r':
				return '\\r';
			case '\t':
				return '\\t';
			case '\b':
				return '\\b';
			default:
				return `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
		}
	});
}

/** Code for a branch of an `if` expression: Kotlin reads a leading `{` there as a block, not as a lambda. */
export function branch(code: string): string {
	return code.startsWith('{') ? `(${code})` : code;
}

/** `T?`, keeping an already nullable type and parenthesizing a function type. */
export function optionalType(t: string): string {
	if ((t.endsWith('?') && !isFunctionType(t)) || t === 'Nothing') return t;
	return isFunctionType(t) ? `(${t})?` : `${t}?`;
}

const NAMES: Partial<Record<NativeKind, string>> = { string: 'String', number: 'Double', boolean: 'Boolean', void: 'Unit', never: 'Nothing', any: 'Any', symbol: 'JSSymbol', bigint: 'JSBigInt' };

/** A native type as Kotlin spells it. */
export function spell(t: NativeType): string {
	if (t.text !== undefined) return t.text;
	return t.optional ? optionalType(t.name) : t.name;
}

/** Kotlin's names of the types the front builds. Any object is `Any`. */
export const SPELLING: Spelling = {
	name(kind, head, args) {
		if (head === ERROR_CLASS) return 'Class<out JSError>';
		if (head) return head === 'AnyObject' ? 'Any' : args.length ? `${head}<${args.map(spell).join(', ')}>` : head;
		if (kind === 'function') return `(${args.slice(0, -1).map(spell).join(', ')}) -> ${spell(args[args.length - 1])}`;
		return NAMES[kind] ?? 'Any';
	},
	spell,
	optional: optionalType,
	nullish: nullishType,
	optionalElements: optionalElementsType,
	nullishElements: nullishElementsType,
};

/** `JSNullish<T>` of a type its optional form spells `T?` (or `(F)?`). */
export function nullishType(t: string): string {
	const present = /^\((.*)\)\?$/.exec(t)?.[1] ?? t.replace(/\?$/, '');
	return `JSNullish<${present}>`;
}

/** An array, Set, Map or record type with its elements or values held optional (`JSArray<T?>`, `JSMap<K, T?>`, `JSRecord<T?>`). */
export function optionalElementsType(t: string): string {
	const m = /^(JSArray|JSSet|JSMap|JSRecord)<(.*)>(\??)$/.exec(t);
	if (!m) return t;
	const args = splitTopLevel(m[2]);
	args[args.length - 1] = optionalType(args[args.length - 1]);
	return `${m[1]}<${args.join(', ')}>${m[3]}`;
}

/** An array, Set or Map type (`JSArray<T?>`, `JSMap<K, T?>`) with its elements or values held as `JSNullish<T>`. */
export function nullishElementsType(t: string): string {
	const m = /^(JSArray|JSSet|JSMap)<(.*)>(\??)$/.exec(t);
	if (!m) return t;
	const args = splitTopLevel(m[2]);
	const k = args.length - 1;
	if ((!isNullable(args[k]) && !/^\(.*\)\?$/.test(args[k])) || isKit(spelledType(args[k]), 'JSNullish')) return t;
	args[k] = nullishType(args[k]);
	return `${m[1]}<${args.join(', ')}>${m[3]}`;
}

/** Kotlin types some of whose values JavaScript holds falsy, or that a falsy value can be held as. */
export const FALSY_CAPABLE = new Set(['Any', 'Unit', 'Nothing', 'JSNull', 'JSBigInt', 'Boolean', 'Double', 'Float', 'Int', 'Long', 'Short', 'Byte', 'Char', 'Number', 'String', 'CharSequence', 'Comparable', 'java.io.Serializable', 'Serializable', 'java.lang.Number', 'java.lang.Object', 'kotlin.Any']);

/** A nullable Kotlin type (`T?`, `((A) -> B)?`), not a function returning one. */
export const isNullable = (t: string) => t.endsWith('?') && !isFunctionType(t);

/** A Kotlin function type (`(A) -> B`), not a nullable one or a generic of one. */
export const isFunctionType = (t: string) => /^\(.*\) -> /.test(t) && !/^\(.*\)\?$/.test(t) && topLevelArrow(t);

function topLevelArrow(t: string): boolean {
	let depth = 0;
	for (let i = 0; i < t.length; i++) {
		const c = t[i];
		if (c === '(' || c === '<') depth++;
		else if ((c === ')' || c === '>') && t[i - 1] !== '-') depth--;
		else if (c === '-' && t[i + 1] === '>' && depth === 0) return true;
	}
	return false;
}
/** iOS SDK declarations an Android build types app code with: NativeScript leaves them undefined on Android. */
export const IOS_TYPINGS = /[\\/]@nativescript[\\/]types-ios[\\/]/;
/** The nullable property beside a field read before it is set (`Translator.earlyField`). */
export const earlyBacking = (name: string) => `__early_${name.replace(/\W/g, '_')}`;

export const VALUE_TYPES = new Set(['Double', 'String', 'Boolean', 'Any?', 'Any', 'Unit', 'Nothing', 'JSBigInt', 'JSSymbol']);

/**
 * A module-level property: its JVM accessors would clash with a function the
 * module declares by that name (`state` and `getState()`), so it has none.
 */
export function moduleProperty(decl: string): string {
	const name = /(?:var|val) (\S+):/.exec(decl)![1];
	return decl.startsWith('lateinit ') ? `@get:JvmName("__get_${name.replace(/`/g, '')}") @set:JvmName("__set_${name.replace(/`/g, '')}") ${decl}` : `@JvmField ${decl}`;
}

/**
 * An untyped value's conversion `jsCheckedNumberOrNull(v)` or `jsAssertedNumberOrNull(v)`, which reads undefined and null as absent, as the one
 * a built-in's optional number parameter takes (`n.toString(radix)`): absent only where it is undefined, null is 0.
 */
export function undefinedAbsent(code: string): string {
	const close = (at: number) => {
		let depth = 0;
		for (let i = at; i < code.length; i++)
			if (code[i] === '(') depth++;
			else if (code[i] === ')' && --depth === 0) return i;
		return -1;
	};
	let from = 0,
		to = code.length;
	for (;;) {
		if (code[from] === '(' && close(from) === to - 1) {
			from++;
			to--;
		} else break;
	}
	const m = /^js(Checked|Asserted)NumberOrNull\(/.exec(code.slice(from, to));
	if (!m || close(from + m[0].length - 1) !== to - 1) return code;
	return `${code.slice(0, from)}${m[1] === 'Checked' ? RT.jsCheckedNumberOrUndefined : RT.jsAssertedNumberOrUndefined}${code.slice(from + m[0].length - 1)}`;
}

/** Kotlin's spelling of what the async lowering writes. */
export const KOTLIN_SYNTAX: Omit<AsyncSyntax, 'unwrap'> = {
	runtime: RT,
	voidType: 'Unit',
	untypedType: 'Any?',
	fnType: (params, ret) => `(${params.join(', ')}) -> ${ret}`,
	constant: (name, type, value) => `val ${name}${type ? `: ${type}` : ''} = ${value}`,
	closure: (params, body, onError, i) => {
		const list = params.map(([n, t]) => `${n}: ${t}`).join(', ');
		const deeper = body.map((l) => '    ' + l);
		return `fun(${list}) {\n${i}    try {\n${deeper.join('\n')}\n${i}    } catch (__error: Throwable) {\n${i}        ${onError}(${RT.jsCaught}(__error))\n${i}    }\n${i}}`;
	},
	inline: (statement, param) => (param ? `{ ${param[0]}: ${param[1]} -> ${statement} }` : `{ ${statement} }`),
	ifOpen: (cond) => `if (${cond}) {`,
	elseOpen: '} else {',
	ifLine: (cond, statements) => `if (${cond}) { ${statements} }`,
	scopeOpen: 'run {',
	tryBlock: (body, onError, i) => [`${i}try {`, ...body.map((l) => '    ' + l), `${i}} catch (__error: Throwable) {`, `${i}    ${onError}(${RT.jsCaught}(__error))`, `${i}}`],
	makeIterator: (name, seq) => `val ${name} = (${seq}).iterator()`,
	nextItem: (item, iterator, otherwise, i) => [`${i}if (!${iterator}.hasNext()) { ${otherwise} }`, `${i}val ${item} = ${iterator}.next()`],
	awaitCall: (operand, isPromise, continuation, onError) => `${isPromise ? RT.jsAwait : RT.jsAwaitValue}(${operand}, ${continuation}, ${onError})`,
	asyncStart: (cap, result) => `val ${cap} = JSAsync<${result}>()`,
	asyncBody: (cap) => [`${cap}.body(fun() {`, '})'],
	asyncReturn: (cap, value, isPromise, result) => (value === null ? `${cap}.returnValue(${result === 'Unit' ? 'Unit' : isNullable(result) || ['String', 'Double', 'Boolean'].includes(result) ? 'null' : `${RT.jsUncheckedNull}<${result}>()`})` : `${cap}.${isPromise ? 'returnPromise' : 'returnValue'}(${value})`),
	asyncError: (cap) => `${cap}.onError`,
	loopRun: (iteration) => `JSAsyncLoop().run(${iteration})`,
	undefinedValue: 'null',
	generatorBody: (cap, element, isAsync) => [`return ${isAsync ? 'JSAsyncGenerator' : 'JSGenerator'}<${element}>(fun(${cap}: ${isAsync ? 'JSAsyncGeneratorContext' : 'JSGeneratorContext'}) {`, '})'],
	generatorReturn: (cap, value) => `${cap}.returnValue(${value ?? ''})`,
	yieldCall: (cap, operand, delegate, continuation, onError, onReturn) => `${cap}.${delegate ? 'delegate' : 'yield'}(${operand}, ${continuation}, ${onError}, ${onReturn})`,
	nextStep: (item, iterator, type, otherwise, i, current) => [`${i}if (!${iterator}.jsAdvance()) { ${otherwise} }`, `${i}val ${item}: ${type} = ${current ?? `${iterator}.jsCurrent`}`],
	closeIterator: (iterator) => `${iterator}.jsClose()`,
	closeIteratorChecked: (iterator) => `${iterator}.jsCloseChecked()`,
	awaitNext: (iterator, continuation, onError) => `${RT.jsAwait}(${iterator}.jsNextPromise(null), ${continuation}, ${onError})`,
	asyncStep: (step, result, otherwise, i) => [`${i}val ${step} = ${RT.jsStepOf}(${result})`, `${i}if (${step}.done) { ${otherwise} }`],
	closeAsyncIterator: (iterator, next, onError) => `${RT.jsAsyncClose}(${iterator}, ${next}, ${onError})`,
	closeAsyncIteratorThrowing: (iterator, error, onError) => `${RT.jsAsyncCloseThrowing}(${iterator}, ${error}, ${onError})`,
	tryStatement: (statement) => statement,
};

/** A symbol's declaration, the same for every instantiation of a generic class's member. */
export function declOf(sym: ts.Symbol | undefined): ts.Node | undefined {
	return sym?.valueDeclaration ?? sym?.declarations?.[0];
}

/** `null`, `undefined`, or a conditional with either as a branch. */
function givesNull(e: ts.Expression): boolean {
	e = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
	if (e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined')) return true;
	return ts.isConditionalExpression(e) && (givesNull(e.whenTrue) || givesNull(e.whenFalse));
}

/** Whether a function body returns `null` or `undefined` itself, outside the functions it declares. */
export function returnsNull(body: ts.Node): boolean {
	const visit = (n: ts.Node): boolean => {
		if (ts.isFunctionLike(n)) return false;
		if (ts.isReturnStatement(n) && n.expression && givesNull(n.expression)) return true;
		return !!ts.forEachChild(n, visit);
	};
	return !!ts.forEachChild(body, visit);
}

/** A number literal as a Kotlin Double literal. */
export function numberLiteral(text: string): string {
	const n = Number(text.replace(/_/g, ''));
	if (Number.isNaN(n)) return 'Double.NaN';
	if (!Number.isFinite(n)) return n > 0 ? 'Double.POSITIVE_INFINITY' : 'Double.NEGATIVE_INFINITY';
	const s = String(n);
	return /[.e]/.test(s) ? s : `${s}.0`;
}

/** The name a parameter, variable or field declares. */
export function isDeclarationName(n: ts.Node | undefined): boolean {
	const d = n?.parent;
	return !!d && (ts.isParameter(d) || ts.isVariableDeclaration(d) || ts.isPropertyDeclaration(d) || ts.isPropertySignature(d)) && d.name === n;
}

/** A function's `this: T` parameter, which only TypeScript sees. */
export function isThisParameter(p: ts.ParameterDeclaration): boolean {
	return ts.isIdentifier(p.name) && p.name.text === 'this';
}

/**
 * Whether a literal is (or is nested in) the value a destructuring declaration or assignment destructures: typed as its
 * own, since the pattern's implied type would drop what a rest element takes (`({ a, ...rest } = { a: 1, b: 2 })`).
 */
export function destructuringSource(e: ts.Expression): boolean {
	let n: ts.Node = e;
	for (;;) {
		const p = n.parent;
		if (ts.isParenthesizedExpression(p) || ts.isArrayLiteralExpression(p)) n = p;
		else if (ts.isPropertyAssignment(p) && p.initializer === n) n = p.parent;
		else return (ts.isBinaryExpression(p) && p.right === n && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && (ts.isArrayLiteralExpression(ts.skipOuterExpressions(p.left)) || ts.isObjectLiteralExpression(ts.skipOuterExpressions(p.left)))) || (ts.isVariableDeclaration(p) && p.initializer === n && ts.isBindingPattern(p.name));
	}
}

/** Whether Kotlin code names `name` (a whole word, not part of another, nor a member of something else). */
export function mentions(code: string, name: string): boolean {
	return new RegExp(`(?<![\\w$\`.])${name.replace(/[$`]/g, '\\$&')}(?![\\w$\`])`).test(code);
}

/** Whether a `break` inside a loop leaves it: an unlabeled one not in a nested loop or switch, or one naming the loop's label. */
export function breaksOut(loop: ts.IterationStatement): boolean {
	const label = ts.isLabeledStatement(loop.parent) ? loop.parent.label.text : null;
	let found = false;
	const visit = (n: ts.Node, nested: boolean) => {
		if (found || ts.isFunctionLike(n) || ts.isClassLike(n)) return;
		if (ts.isBreakStatement(n) && (n.label ? n.label.text === label : !nested)) {
			found = true;
			return;
		}
		const inner = nested || ts.isIterationStatement(n, false) || ts.isSwitchStatement(n);
		ts.forEachChild(n, (c) => visit(c, inner));
	};
	ts.forEachChild(loop, (c) => visit(c, false));
	return found;
}

/**
 * `{ a, b -> body }`, a parameter the body doesn't use written `_`. A lone unused parameter is left out (`{ body }`)
 * unless the body names an outer `it`, which an implicit one would shadow.
 */
export function lambda(params: string[], body: string): string {
	const uses = (name: string) => new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(body);
	const written = params.map((p) => {
		const [name, type] = p.split(/:\s*(.*)/s);
		return uses(name.trim()) ? p : type ? `_: ${type}` : '_';
	});
	if (params.length === 1 && written[0] === '_' && !uses('it')) return `{ ${body} }`;
	return `{ ${written.join(', ')} -> ${body} }`;
}

/** A type whose arguments Kotlin cannot check a cast against (`JSArray<View>`, `(String) -> Unit`): the JVM erases them. */
function erased(type: string): boolean {
	return /<|->/.test(type.replace(/<\*(, \*)*>/g, ''));
}

/**
 * Whether `target` is `source` with some of its generic types' arguments `Any?` (`Stream<any>` for `Stream<Event>`):
 * TypeScript's `any` takes any instantiation, Kotlin's invariant generics only by an unchecked cast.
 */
export function anyArguments(source: string, target: string): boolean {
	let pattern = '',
		depth = 0;
	for (let i = 0; i < target.length; i++) {
		if (depth > 0 && target.startsWith('Any?', i) && /[<(,]\s*$/.test(target.slice(0, i)) && /^\s*[>),]/.test(target.slice(i + 4))) {
			pattern += '(.+?)';
			i += 3;
			continue;
		}
		if (target[i] === '<') depth++;
		else if (target[i] === '>' && target[i - 1] !== '-') depth--;
		pattern += target[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}
	return pattern !== target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') && new RegExp(`^${pattern}$`).test(source);
}

/** `code as type`, through the runtime's reified jsAs where only the class can be checked. */
export function cast(code: string, type: string): string {
	// A type parameter (`T`) is checked nowhere: the value is taken as one.
	if (/^[A-Z]\??$/.test(type)) return `${RT.jsUnchecked}<${type}>(${code})`;
	return erased(type) ? `${RT.jsAs}<${type}>(${code})` : `(${code} as ${type})`;
}

/** `code as? type`, as cast. */
export function safeCast(code: string, type: string): string {
	return erased(type) ? `${RT.jsAsOrNull}<${type.replace(/\?$/, '')}>(${code})` : `(${code} as? ${type})`;
}

/** What `typeof` gives of a value Kotlin holds as `type` (non-null), or null where the value decides it. */
export function typeofName(type: string): string | null {
	if (type === 'Double') return 'number';
	if (type === 'String') return 'string';
	if (type === 'Boolean') return 'boolean';
	if (type === 'JSSymbol') return 'symbol';
	if (type === 'JSBigInt') return 'bigint';
	if (isFunctionType(type) || /^\(.*\) -> /.test(type)) return 'function';
	return type === 'Any' || /^[A-Z]$/.test(type) ? null : 'object';
}

/** A Kotlin type script's values of which are held as they are (`Any?`, a string, number or boolean). */
export function scriptPrimitive(t: string): boolean {
	return isUntyped(spelledType(t)) || /^(Double|String|Boolean)\??$/.test(t);
}

/** The parts of a function type or of an optional one (`((A) -> B)?`); `(A) -> (() -> B)?` is the former. */
export function slotFunctionParts(t: string): { params: string[]; ret: string } | null {
	return functionTypeParts(t) ?? functionTypeParts(t.replace(/^\((.*)\)\?$/, '$1'));
}

/** A Kotlin function type's parameter types and result type. */
export function functionTypeParts(t: string): { params: string[]; ret: string } | null {
	if (!t.startsWith('(')) return null;
	let depth = 0;
	for (let i = 0; i < t.length; i++) {
		const c = t[i];
		if (c === '(' || c === '<') depth++;
		else if ((c === ')' || c === '>') && t[i - 1] !== '-') {
			depth--;
			if (depth === 0) {
				if (c !== ')' || t.slice(i + 1, i + 5) !== ' -> ') return null;
				return { params: splitTopLevel(t.slice(1, i)).filter(Boolean), ret: t.slice(i + 5) };
			}
		}
	}
	return null;
}

/** `A, (B, C), D<E, F>` split at its top-level commas. */
export function splitTopLevel(text: string): string[] {
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
	return out.filter((x, k) => x || k < out.length - 1);
}

/** An operand of `==`, `===`, `!=` or `!==`: a dynamic read there may be undefined whatever its declared type. */
export function isCompared(e: ts.Expression): boolean {
	let n: ts.Node = e;
	while (ts.isParenthesizedExpression(n.parent)) n = n.parent;
	const p = n.parent;
	return ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(p.operatorToken.kind);
}

/** A read whose undefined what follows tests: the left of `??`, or a receiver that `?.` continues from. */
export function testsMissing(e: ts.Expression): boolean {
	let n: ts.Node = e;
	while (ts.isParenthesizedExpression(n.parent)) n = n.parent;
	const p = n.parent;
	if (ts.isBinaryExpression(p)) return p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && p.left === n;
	return (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p) || ts.isCallExpression(p)) && p.expression === n && !!p.questionDotToken;
}

/**
 * Whether code assigns to a symbol (`x = …`, `x += …`, `x++`). `truth`: what a condition always is, where the
 * translation leaves out the branch that never runs.
 */
export function assignsTo(node: ts.Node, sym: ts.Symbol | undefined, checker: ts.TypeChecker, truth?: (e: ts.Expression) => boolean | undefined): boolean {
	if (!sym) return false;
	let found = false;
	// A name, or a destructuring pattern (`[a, b] = …`, `({ a } = …)`) naming it.
	const target = (x: ts.Node): boolean => {
		if (ts.isIdentifier(x)) return checker.getSymbolAtLocation(x) === sym;
		if (ts.isParenthesizedExpression(x) || ts.isSpreadElement(x) || ts.isSpreadAssignment(x) || ts.isAsExpression(x) || ts.isTypeAssertionExpression(x) || ts.isNonNullExpression(x)) return target(x.expression);
		if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.EqualsToken) return target(x.left);
		if (ts.isArrayLiteralExpression(x)) return x.elements.some(target);
		if (ts.isObjectLiteralExpression(x)) return x.properties.some((p) => (ts.isPropertyAssignment(p) ? target(p.initializer) : ts.isShorthandPropertyAssignment(p) ? checker.getShorthandAssignmentValueSymbol(p) === sym : ts.isSpreadAssignment(p) && target(p)));
		return false;
	};
	const visit = (n: ts.Node) => {
		if (found) return;
		if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && target(n.left)) {
			found = true;
			return;
		}
		if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && !ts.isVariableDeclarationList(n.initializer) && target(n.initializer)) {
			found = true;
			return;
		}
		if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(n.operator) && target(n.operand)) {
			found = true;
			return;
		}
		const fixed = truth && ts.isIfStatement(n) ? truth(n.expression) : undefined;
		if (fixed !== undefined) {
			const live = fixed ? (n as ts.IfStatement).thenStatement : (n as ts.IfStatement).elseStatement;
			visit((n as ts.IfStatement).expression);
			if (live) visit(live);
			return;
		}
		ts.forEachChild(n, visit);
	};
	visit(node);
	return found;
}

/** Whether `node` names `sym`. */
export function refersTo(node: ts.Node, sym: ts.Symbol | undefined, checker: ts.TypeChecker): boolean {
	if (!sym) return false;
	let found = false;
	const visit = (n: ts.Node) => {
		if (found) return;
		// `{ name }` reads the variable `name`, though the checker gives the property's symbol there.
		const read = ts.isIdentifier(n) && (ts.isShorthandPropertyAssignment(n.parent) && n.parent.name === n ? checker.getShorthandAssignmentValueSymbol(n.parent) : checker.getSymbolAtLocation(n));
		if (read === sym) {
			found = true;
			return;
		}
		ts.forEachChild(n, visit);
	};
	visit(node);
	return found;
}

/** Whether a class reads `this.name?.…`: a field it leaves unset until later is tested for being there. */
export function chainedThrough(cls: ts.ClassLikeDeclaration, name: string): boolean {
	let found = false;
	const visit = (n: ts.Node): void => {
		if (found) return;
		if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isCallExpression(n)) && n.questionDotToken && ts.isPropertyAccessExpression(n.expression) && n.expression.expression.kind === ts.SyntaxKind.ThisKeyword && n.expression.name.text === name) {
			found = true;
			return;
		}
		ts.forEachChild(n, visit);
	};
	visit(cls);
	return found;
}

/** A `const` made an object where it is declared (`new`, a literal, a function): never missing, whatever lenient code may hold elsewhere. */
export function presentConst(d: ts.Node): boolean {
	if (!ts.isVariableDeclaration(d) || !ts.isIdentifier(d.name) || !d.initializer || !(ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const)) return false;
	const init = ts.skipOuterExpressions(d.initializer);
	return ts.isNewExpression(init) || ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init) || ts.isArrowFunction(init) || ts.isFunctionExpression(init) || ts.isClassExpression(init);
}

/** Whether a function body has a `return` of its own (not one of a function inside it). */
export function ownReturns(body: ts.Node): boolean {
	let found = false;
	const visit = (n: ts.Node): void => {
		if (found || ts.isFunctionLike(n) || ts.isClassLike(n)) return;
		if (ts.isReturnStatement(n)) found = true;
		else ts.forEachChild(n, visit);
	};
	ts.forEachChild(body, visit);
	return found;
}

/**
 * A module's top-level statements, run once at startup: what they throw is reported as uncaught and the app goes on,
 * as the Swift kit's module initializers do; an exception escaping the app's start would end it.
 */
export function reportedInit(init: string[]): string {
	// try, not jsReport { }: a lambda would capture every module field it sets, and lint's WrongThreadInterprocedural
	// fails on a lambda capturing a few dozen of them (it builds the product of each capture's possible values).
	return ['    try {', ...init.map((l) => (l ? '    ' + l : l)), '    } catch (__e: Throwable) {', `        ${RT.jsReportThrown}(__e)`, '    }'].join('\n');
}

/** Types the generated Kotlin names without qualification, which a program type of the name would hide (as `SWIFT_NATIVE_TYPES` in swift/syntax.ts): its default imports (kotlin.*, kotlin.collections.*, kotlin.text.*, …, java.lang.*). */
export const KOTLIN_NATIVE_TYPES = new Set(
	`AbstractCollection AbstractIterator AbstractList AbstractMap AbstractSet Annotation
  Any Appendable ArithmeticException Array ArrayDeque ArrayList AssertionError AutoCloseable Boolean BooleanArray Byte
  ByteArray Char CharArray CharRange CharSequence Character Charsets Class ClassCastException ClassLoader Cloneable
  ClosedRange Collection Comparable Comparator ConcurrentModificationException Deprecated Double DoubleArray Enum Error
  Exception Float FloatArray Function Grouping HashMap HashSet IllegalArgumentException IllegalStateException
  IndexOutOfBoundsException IndexedValue Int IntArray IntRange Integer InterruptedException Iterable Iterator JvmField
  JvmName JvmOverloads JvmStatic Lazy LinkedHashMap LinkedHashSet List ListIterator Long LongArray LongRange Map MatchGroup
  MatchResult Math Metadata Module MustBeDocumented MutableCollection MutableIterable MutableIterator MutableList
  MutableListIterator MutableMap MutableSet NoSuchElementException NotImplementedError Nothing NullPointerException Number
  NumberFormatException Object OptIn Override Package Pair Process ProcessBuilder Readable Record Regex RegexOption
  ReplaceWith Repeatable Result Retention Runnable Runtime RuntimeException Sequence SequenceScope Set Short ShortArray
  StackTraceElement StrictMath String StringBuffer StringBuilder Suppress Synchronized System Target Thread ThreadLocal
  Throwable Throws Transient Triple Typography UByte UInt ULong UShort UnsupportedOperationException Unit Void
  Volatile`.split(/\s+/),
);
