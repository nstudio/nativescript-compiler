// Swift as the translator writes it, and the syntax-tree questions only the Swift backend asks: names and literals,
// type spellings, the shape of emitted code (`try`, optional chains, casts). Nothing here reads the translator's state.
import { heldLoss } from '../semantics/losses.ts';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import type { AsyncSyntax } from '../semantics/async.ts';
import { SWIFT_RUNTIME } from '../semantics/runtime.ts';
import { keepsIdentity, type Slot } from '../semantics/conversion.ts';
import { ERROR_CLASS, isKit, parseNativeType, spelledType, type NativeKind, type NativeType, type Spelling } from '../semantics/types.ts';
import { thisNodes } from '../semantics/ast.ts';

const KEYWORDS = new Set(['in', 'default', 'repeat', 'where', 'func', 'var', 'let', 'struct', 'enum', 'protocol', 'extension', 'internal', 'operator', 'self', 'Self', 'Type', 'is', 'as', 'guard', 'defer', 'subscript', 'init', 'deinit', 'inout', 'associatedtype', 'fallthrough', 'super', 'true', 'false', 'nil', 'class', 'import', 'static', 'Any', 'Protocol', 'rethrows', 'throws', 'precedencegroup', 'fileprivate', 'open', 'some', 'any', 'return', 'throw', 'try', 'await', 'catch', 'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue', 'do', 'typealias', 'private', 'public']);

/** The runtime functions this backend calls, by operation (semantics/runtime.ts). */
export const RT = SWIFT_RUNTIME;

const LENIENT_READS: Readonly<Record<string, readonly [string, string]>> = { String: [RT.jsLenientString, RT.jsLenientStringOrNil], Double: [RT.jsLenientNumber, RT.jsLenientNumberOrNil], Bool: [RT.jsLenientBool, RT.jsLenientBoolOrNil] };
const CONVERTED_READS: Readonly<Record<string, readonly [string, string]>> = { String: [RT.jsConvertedString, RT.jsConvertedStringOrNil], Double: [RT.jsConvertedNumber, RT.jsConvertedNumberOrNil], Bool: [RT.jsConvertedBool, RT.jsConvertedBoolOrNil] };

/** What the kit's lenient and converted reads give for undefined. */
const EMPTY_READ: Readonly<Record<string, string>> = { String: '""', Double: '.nan', Bool: 'false' };

/** The kit's lenient read of any value as `type` (`String`, `Double` or `Bool`); `orNil`: nil where the value is undefined. */
export function lenientReader(type: string, orNil = false): string {
	if (!orNil) heldLoss('lenientRead', EMPTY_READ[type]);
	return LENIENT_READS[type][orNil ? 1 : 0];
}

/** The kit's conversion of any value to `type` (`String`, `Double` or `Bool`) as script converts it; `orNil`: nil where the value is undefined. */
export function convertedReader(type: string, orNil = false): string {
	if (!orNil) heldLoss('convertedRead', EMPTY_READ[type]);
	return CONVERTED_READS[type][orNil ? 1 : 0];
}

export function ident(name: string): string {
	// A key no identifier spells (`1`, `aria-label`) keeps its string form in jsKeys and subscripts.
	const n = name
		.replace(/^#/, '_p_')
		.replace(/\$/g, '_')
		.replace(/^(?=\d)/, '_')
		.replace(/[^\w]/g, '_');
	return KEYWORDS.has(n) ? `\`${n}\`` : n;
}

/** A name as a call's argument label, where only `inout`, `var` and `let` need escaping. */
export function label(name: string): string {
	const n = ident(name).replace(/^`(.*)`$/, '$1');
	return ['inout', 'var', 'let'].includes(n) ? `\`${n}\`` : n;
}

/** A function type `(…) throws -> R` returning `Any?` instead. */
export function returningAny(type: string): string {
	let depth = 0;
	for (let i = 0; i < type.length; i++) {
		if (type[i] === '(') depth++;
		else if (type[i] === ')' && --depth === 0) return type.slice(0, i + 1) + ' throws -> Any?';
	}
	return type;
}

/** A function expression that declares a `this` parameter or reads `this`: a method value, called with a receiver. */
export function isMethodValue(fn: ts.FunctionExpression): boolean {
	const first = fn.parameters[0];
	return (!!first && ts.isIdentifier(first.name) && first.name.text === 'this' && first.type?.kind !== ts.SyntaxKind.VoidKeyword) || thisNodes(fn).length > 0;
}

export function isCompoundAssignment(op: ts.SyntaxKind): boolean {
	return op >= ts.SyntaxKind.FirstCompoundAssignment && op <= ts.SyntaxKind.LastCompoundAssignment;
}

/** A promise handler's result type (`T | PromiseLike<T>`) as the one value type it gives directly, else `type` itself. */
export function withoutThenables(type: ts.Type | undefined): ts.Type | undefined {
	if (!type?.isUnion()) return type;
	const direct = type.types.filter((t) => t.getSymbol()?.name !== 'PromiseLike');
	return direct.length === 1 && direct.length < type.types.length ? direct[0] : type;
}

/** Classes whose objects script may read as a number, string or null, and the bases holding them. */
export const PRIMITIVE_CLASSES = new Set(['NSObject', 'NSValue', 'NSNumber', 'NSDecimalNumber', 'NSString', 'NSMutableString', 'NSNull', 'AnyObject', 'JSNull']);

export function isNullish(e: ts.Expression): boolean {
	while (ts.isParenthesizedExpression(e)) e = e.expression;
	return e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined') || ts.isVoidExpression(e);
}

/** A function whose declared return type admits undefined or null (`T[] | undefined`). */
export function declaresUndefined(fn: ts.SignatureDeclaration | undefined): boolean {
	const t = fn?.type;
	return !!t && ts.isUnionTypeNode(t) && t.types.some((x) => x.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isLiteralTypeNode(x) && x.literal.kind === ts.SyntaxKind.NullKeyword));
}

/** A dotted path (`Trace.ConsoleWriter`), each part an identifier. */
export function identPath(name: string): string {
	return name.split('.').map(ident).join('.');
}

/** Code one level deeper; a `#sourceLocation` directive stays where it is. */
export function indented(code: string): string {
	return code
		.split('\n')
		.map((l) => (l && !l.startsWith('#sourceLocation') ? '    ' + l : l))
		.join('\n');
}

export function swiftString(text: string): string {
	return (
		'"' +
		text
			.replace(/\\/g, '\\\\')
			.replace(/"/g, '\\"')
			.replace(/\n/g, '\\n')
			.replace(/\r/g, '\\r')
			.replace(/\t/g, '\\t')
			.replace(/[\u0000-\u001f\u007f]/g, (ch) => `\\u{${ch.charCodeAt(0).toString(16)}}`) +
		'"'
	);
}

/** Code that throws: a `try`, or a check written without one because the statement's `try` covers it. */
export const THROWING_CODE = /\btry\b|\bjs(Unwrap|ObjectRequired|Callable|Iterated|CastPresent|ForeignPresent|Destructured|Converted(?:String|Number|Bool)(?:OrNil)?)\(|\bFunctionCell_\w+\.present\(/;

/** An operand `try` can't lead in Swift: an operator's right side, a conditional's branch, a prefix operator's operand. */
export function rightOperand(n: ts.Node): boolean {
	let x = n;
	// `try` before a receiver covers the chain it heads, so the chain's position decides.
	while (ts.isParenthesizedExpression(x.parent) || ((ts.isPropertyAccessExpression(x.parent) || ts.isElementAccessExpression(x.parent) || ts.isCallExpression(x.parent)) && x.parent.expression === x)) x = x.parent;
	const p = x.parent;
	return (ts.isBinaryExpression(p) && p.right === x && p.operatorToken.kind !== ts.SyntaxKind.EqualsToken) || (ts.isConditionalExpression(p) && p.condition !== x) || ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p) || ts.isTypeOfExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p);
}

/** `(x = v)` as a value: what it gives is what was assigned, checked where it is read. */
export function assignmentValue(e: ts.Node): boolean {
	while (ts.isParenthesizedExpression(e)) e = e.expression;
	return ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken;
}

export const FOREIGN_SLOT: Slot = { rep: 'foreign', type: parseNativeType('Any?'), kind: 'untyped' };

/** Whether code's brackets close as they open, outside string literals: a part of an expression that stands alone. */
export function balanced(code: string): boolean {
	let depth = 0,
		quoted = false;
	for (let i = 0; i < code.length; i++) {
		const c = code[i];
		if (quoted) {
			if (c === '\\') i++;
			else if (c === '"') quoted = false;
			continue;
		}
		if (c === '"') quoted = true;
		else if ('([{'.includes(c)) depth++;
		else if (')]}'.includes(c) && --depth < 0) return false;
	}
	return depth === 0 && !quoted;
}

/** `T?`, keeping an already optional type and parenthesizing a function type. */
export function optionalType(t: string): string {
	if (t.endsWith('!')) return t;
	if (hasTopLevelArrow(t)) return `(${t})?`;
	return t.endsWith('?') ? t : `${t}?`;
}

const NAMES: Partial<Record<NativeKind, string>> = { string: 'String', number: 'Double', boolean: 'Bool', void: 'Void', never: 'Never', any: 'Any', symbol: 'JSSymbol', bigint: 'JSBigInt' };

/** A native type as Swift spells it. */
export function spell(t: NativeType): string {
	if (t.text !== undefined) return t.text;
	if (t.implicit) return t.kind === 'function' ? `(${t.name})!` : `${t.name}!`;
	return t.optional ? optionalType(t.name) : t.name;
}

/** Swift's names of the types the front builds; a function type the front builds converts and never throws. */
export const SPELLING: Spelling = {
	name(kind, head, args) {
		if (head === ERROR_CLASS) return 'JSError.Type';
		if (head) return head === 'AnyObject' ? 'AnyObject' : args.length ? `${head}<${args.map(spell).join(', ')}>` : head;
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
	const present = t.replace(/[?!]$/, '');
	return `JSNullish<${/^\(.*\)$/.test(present) && hasTopLevelArrow(present.slice(1, -1)) ? present.slice(1, -1) : present}>`;
}

/** An array, Set, Map or record type with its elements or values held optional (`JSArray<T?>`, `JSMap<K, T?>`, `JSRecord<T?>`). */
export function optionalElementsType(t: string): string {
	const m = /^(JSArray|JSSet|JSMap|JSRecord)<(.*)>([?!]?)$/.exec(t);
	if (!m) return t;
	const args = splitTopLevel(m[2]);
	args[args.length - 1] = optionalType(args[args.length - 1]);
	return `${m[1]}<${args.join(', ')}>${m[3]}`;
}

/** An array, Set or Map type (`JSArray<T?>`, `JSMap<K, T?>`) with its elements or values held as `JSNullish<T>`. */
export function nullishElementsType(t: string): string {
	const m = /^(JSArray|JSSet|JSMap)<(.*)>([?!]?)$/.exec(t);
	if (!m) return t;
	const args = splitTopLevel(m[2]);
	const k = args.length - 1;
	if (!/[?!]$/.test(args[k]) || isKit(spelledType(args[k]), 'JSNullish')) return t;
	args[k] = nullishType(args[k]);
	return `${m[1]}<${args.join(', ')}>${m[3]}`;
}

/** A function type at the top level (`(A) throws -> B?`), not one inside parentheses or generic arguments. */
export function hasTopLevelArrow(t: string): boolean {
	let depth = 0;
	for (let i = 0; i < t.length; i++) {
		const ch = t[i];
		if ('([<'.includes(ch)) depth++;
		else if (ch === '-' && t[i + 1] === '>') {
			if (depth === 0) return true;
			i++;
		} else if (')]>'.includes(ch)) depth--;
	}
	return false;
}

/**
 * A function type as a collection holds it: the function object script holds, one per function. A closure Swift holds
 * as a generic parameter (an element, a key) is a new thunk at each conversion in or out, another function to `===`.
 */
export function heldType(t: string): string {
	return functionParts(unwrapFunction(t, false)) && keepsIdentity('function') ? 'Any?' : t;
}

/** A function type with an enclosing `(...)?` or `(...)!` removed, leaving one returning an optional function intact. */
export function unwrapFunction(t: string, iuo = true): string {
	return (iuo ? /^\(.*\)[?!]$/ : /^\(.*\)\?$/).test(t) && !hasTopLevelArrow(t) ? t.slice(1, -2) : t;
}

/**
 * Every generated class declares this unless it or a base has an isolated deinit. Under main-actor default isolation an
 * implicit deinit is isolated, and each hop to the main actor costs code (about 400 KB in an app); this one runs no
 * script code, so it can run on whichever thread drops the last reference.
 */
export const NONISOLATED_DEINIT = '    nonisolated deinit {}';

export const CF_CLASSES = new Set(['CGPath', 'CGMutablePath', 'CGColor', 'CGImage', 'CGContext', 'CGColorSpace', 'CGGradient', 'CGFont', 'CTFont', 'CTLine', 'CTFrame', 'CFString', 'CFData', 'CFRunLoop', 'CFRunLoopTimer', 'CFRunLoopSource', 'CFRunLoopObserver']);

/** An optional value type: `T?`, `(…)?`, but not a function returning an optional. */
export const isOptional = (t: string) => t.endsWith('?') && !hasTopLevelArrow(t);

/** Whether two Swift types name one type, whatever their optionality or module qualifier. */
export const sameClass = (a: string, b: string) => {
	const bare = (t: string) => t.replace(/[?!]$/, '').replace(/^NativeScriptKit\./, '');
	return bare(a) === bare(b);
};
export const isFunctionLiteral = (e: ts.Expression): boolean => (ts.isParenthesizedExpression(e) ? isFunctionLiteral(e.expression) : ts.isArrowFunction(e) || ts.isFunctionExpression(e));

export const isFunctionType = (t: string) => hasTopLevelArrow(t) && !t.startsWith('[') && !/^\w+</.test(t);
export const isStringType = (t: string) => /^String[?!]?$/.test(t);

/**
 * Whether Swift statements can throw out of where they stand: a `try` or `throw` outside the closures and
 * functions they declare. A brace opens a block where its statement starts with a control keyword (`if`, `do`,
 * `catch`…) outside any parentheses; any other opens a closure.
 */
export function throwsOutside(code: string): boolean {
	const kinds: boolean[] = [];
	let quoted = false,
		start = 0,
		parens = 0;
	const closed = () => kinds.some((k) => !k);
	for (let k = 0; k < code.length; k++) {
		const ch = code[k];
		if (quoted) {
			if (ch === '\\') k++;
			else if (ch === '"') quoted = false;
			continue;
		}
		if (ch === '"') {
			quoted = true;
			continue;
		}
		if (ch === '(') parens++;
		else if (ch === ')') parens--;
		else if (ch === '{') {
			// A statement's source-line marker (`/*@ns:12*/`) leads it.
			const head = code
				.slice(start, k)
				.replace(/\/\*[^*]*\*\//g, '')
				.trim();
			kinds.push(parens === 0 && /^(?:\}\s*)?(?:\w+:\s*)?(?:if|else|for|while|repeat|switch|guard|do|defer|catch)\b/.test(head));
			start = k + 1;
			parens = 0;
		} else if (ch === '}') {
			kinds.pop();
			start = k + 1;
		} else if (ch === '\n' || ch === ';') start = k + 1;
		else if (!closed() && ch === 't' && /^(try(?![?!])|throw)\b/.test(code.slice(k, k + 6)) && !/\w/.test(code[k - 1] ?? '')) return true;
	}
	return false;
}

/**
 * The container type passed to `jsArrayFrom`, `jsArrayOrNil` or `jsRecordOf` where Swift would otherwise infer an optional
 * element: from a write through the result (`jsRecordOf(values) { $0 }[key] = value`), or from a class element's
 * implicitly unwrapped conversion. Only an array or record already of that type is the same one, so a push through
 * it stays. Spelled as a type, where a member named like the class cannot shadow it.
 */
export function typedElement(container: 'JSArray' | 'JSRecord', element: string): string {
	const named = /^(Any|String|Double|Bool)\?$/.test(element) || (/^[A-Z][\w.]*(<.+>)?$/.test(element) && !/^(Any|String|Double|Bool|Void)$/.test(element));
	return named ? `, as: ${container}<${element}>.self` : '';
}

/**
 * An object shape's class name, from its keys (`Object_x_y`; a unique symbol's key `__@name@12` as `symbol_name`). Past
 * 120 characters, its first keys and a hash of the whole name, so that a type and its file stay a readable length.
 */
export function shapeName(keys: string[]): string {
	const parts = keys.map((k) => {
		const symbol = /^__@([\w$]+)@\d+$/.exec(k)?.[1];
		return (symbol ? `symbol_${symbol}` : k).replace(/\W/g, '');
	});
	const full = 'Object_' + (parts.join('_') || 'empty');
	if (full.length <= 120) return full;
	return `Object_${parts.slice(0, 6).join('_')}_and_${parts.length - 6}_more_${createHash('sha1').update(full).digest('hex').slice(0, 6)}`;
}

/**
 * An untyped value's conversion `jsCheckedNumberOrNil(v)` or `jsLenientNumberOrNil(v)`, which reads undefined and null as absent, as the one
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
		} else if (code.startsWith('try ', from)) from += 4;
		else break;
	}
	const m = /^js(Checked|Lenient)NumberOrNil\(/.exec(code.slice(from, to));
	if (!m || close(from + m[0].length - 1) !== to - 1) return code;
	return `${code.slice(0, from)}${m[1] === 'Checked' ? RT.jsCheckedNumberOrUndefined : RT.jsLenientNumberOrUndefined}${code.slice(from + m[0].length - 1)}`;
}

/** A setter's throwing body, which a typed write and a write by name call. */
export const throwingSetter = (n: string) => `__setThrowing_${n.replace(/\W/g, '_')}`;
/** A getter's throwing body beside its setter (Swift's settable properties cannot throw), which a typed read calls. */
export const throwingGetter = (n: string) => `__getThrowing_${n.replace(/\W/g, '_')}`;

/** Swift's spelling of what the async lowering writes. */
export const SWIFT_SYNTAX: Omit<AsyncSyntax, 'unwrap'> = {
	runtime: RT,
	voidType: 'Void',
	untypedType: 'Any?',
	fnType: (params, ret) => `(${params.map((p) => (p === '() -> Void' ? `@escaping ${p}` : p)).join(', ')}) -> ${ret}`,
	constant: (name, type, value) => `let ${name}${type ? `: ${type}` : ''} = ${value}`,
	closure: (params, body, onError, i) => {
		const list = `(${params.map(([n, t]) => `${n}: ${t === '() -> Void' ? '@escaping ' : ''}${t}`).join(', ')})`;
		if (!throwsOutside(body.join('\n'))) return `{ ${list} -> Void in\n${body.join('\n')}\n${i}}`;
		const deeper = body.map((l) => '    ' + l);
		return `{ ${list} -> Void in\n${i}    do {\n${deeper.join('\n')}\n${i}    } catch {\n${i}        ${onError}(${RT.jsCaught}(error))\n${i}    }\n${i}}`;
	},
	inline: (statement, param) => (param ? `{ (${param[0]}: ${param[1]}) -> Void in ${statement} }` : `{ ${statement} }`),
	ifOpen: (cond) => `if ${cond} {`,
	elseOpen: '} else {',
	ifLine: (cond, statements) => `if ${cond} { ${statements} }`,
	scopeOpen: 'do {',
	tryBlock: (body, onError, i) => (throwsOutside(body.join('\n')) ? [`${i}do {`, ...body.map((l) => '    ' + l), `${i}} catch {`, `${i}    ${onError}(${RT.jsCaught}(error))`, `${i}}`] : [`${i}do {`, ...body, `${i}}`]),
	makeIterator: (name, seq, iterates) => `${iterates ? 'let' : 'var'} ${name} = ${seq}.makeIterator()`,
	nextItem: (item, iterator, otherwise, i) => [`${i}guard let ${item} = ${iterator}.next() else { ${otherwise} }`],
	awaitCall: (operand, isPromise, continuation, onError) => `${RT.jsAwait}(${isPromise ? operand : `value: ${operand}`}, ${continuation}, ${onError})`,
	asyncStart: (cap, result) => `let ${cap} = JSAsync<${result}>()`,
	asyncBody: (cap) => [`${cap}.body {`, '}'],
	// Undefined where the result has no undefined (a tuple, after branches that each return): reached only where the types are wrong.
	asyncReturn: (cap, value, isPromise, result) => (value === null ? `${cap}.returnValue(${result === 'Void' ? '()' : /^\(.*\)$/.test(result) && !/->/.test(result) ? `{ fatalError("undefined for ${result}") }()` : 'nil'})` : `${cap}.${isPromise ? 'returnPromise' : 'returnValue'}(${value})`),
	asyncError: (cap) => `${cap}.throwValue`,
	loopRun: (iteration) => `JSAsyncLoop().run ${iteration}`,
	undefinedValue: 'nil',
	generatorBody: (cap, element, isAsync) => [`return ${isAsync ? 'JSAsyncGenerator' : 'JSGenerator'}<${element}> { (${cap}: ${isAsync ? 'JSAsyncGeneratorContext' : 'JSGeneratorContext'}) throws -> Void in`, '}'],
	generatorReturn: (cap, value) => `${cap}.returnValue(${value ?? ''})`,
	yieldCall: (cap, operand, delegate, continuation, onError, onReturn) => `${cap}.${delegate ? 'delegate' : 'yield'}(${operand}, ${continuation}, ${onError}, ${onReturn})`,
	nextStep: (item, iterator, type, otherwise, i, current) => [`${i}guard try ${iterator}.jsAdvance() else { ${otherwise} }`, `${i}let ${item}: ${type} = ${current ?? `${iterator}.jsCurrent`}`],
	closeIterator: (iterator) => `${iterator}.jsClose()`,
	closeIteratorChecked: (iterator) => `try ${iterator}.jsCloseChecked()`,
	awaitNext: (iterator, continuation, onError) => `${RT.jsAwait}(${iterator}.jsNextPromise(nil), ${continuation}, ${onError})`,
	asyncStep: (step, result, otherwise, i) => [`${i}let ${step} = try ${RT.jsStepOf}(${result})`, `${i}if ${step}.done { ${otherwise} }`],
	closeAsyncIterator: (iterator, next, onError) => `${RT.jsAsyncClose}(${iterator}, ${next}, ${onError})`,
	closeAsyncIteratorThrowing: (iterator, error, onError) => `${RT.jsAsyncCloseThrowing}(${iterator}, ${error}, ${onError})`,
	tryStatement: (statement) => statement.replace(/^(let \w+(?:: [^=]+)? = )/, '$1try '),
};

/** Whether Swift code is one postfix chain of reads and calls at its top level (`a.b(c)?.d[e]`). */
export function postfixChain(code: string): boolean {
	let depth = 0,
		quoted = false;
	for (let k = 0; k < code.length; k++) {
		const ch = code[k];
		if (quoted) {
			if (ch === '\\') k++;
			else if (ch === '"') quoted = false;
			continue;
		}
		if (ch === '"') quoted = true;
		else if ('([{'.includes(ch)) depth++;
		else if (')]}'.includes(ch)) depth--;
		else if (!depth && !/[\w.?]/.test(ch)) return false;
	}
	return true;
}

/** Whether Swift code is a postfix chain still open at its top level (`a?.b(c)`): what follows it is part of the chain. */
export function openSwiftChain(code: string): boolean {
	let depth = 0;
	for (let k = 0; k < code.length; k++) {
		const c = code[k];
		if (c === '"') {
			for (k++; k < code.length && code[k] !== '"'; k++) if (code[k] === '\\') k++;
			continue;
		}
		if (c === '(' || c === '[' || c === '{') depth++;
		else if (c === ')' || c === ']' || c === '}') depth--;
		else if (depth === 0 && c === '?' && (code[k + 1] === '.' || code[k + 1] === '[')) return true;
		// A space at the top level ends the postfix chain (an operator follows), unless a trailing closure opens there.
		else if (depth === 0 && c === ' ' && code[k + 1] !== '{') return false;
	}
	return false;
}
/** A shape's memberwise init parameters, which every construction passes in this order: named fields, fields keyed by a program's symbol, well-known symbols' members. */
export function initOrder<F extends { symbol?: boolean; key?: string }>(fields: readonly F[]): F[] {
	return [...fields.filter((f) => !f.symbol), ...fields.filter((f) => f.key), ...fields.filter((f) => f.symbol && !f.key)];
}

/** Whether an expression reads through `?.` (Swift gives an optional, whatever TypeScript types it). */
export function inOptionalChain(e: ts.Expression): boolean {
	for (let x: ts.Expression = e; ;) {
		if (ts.isParenthesizedExpression(x) || ts.isNonNullExpression(x)) x = x.expression;
		else if (ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x) || ts.isCallExpression(x)) {
			if (x.questionDotToken) return true;
			x = x.expression;
		} else return false;
	}
}

/**
 * Statements written before they were found to need iOS `version` as a whole: the checks they made for it
 * or an older version (`availableOnly`'s, one `else` line each) are their blocks alone, as the whole is checked.
 */
export function unnestAvailability(lines: string, version: number): string {
	// A statement's source-line marker (`/*@ns:12*/`) leads its line, before the indentation.
	const marker = /^\/\*@ns:(?:\d+|-)\*\//;
	const out = lines.split('\n');
	for (let k = 0; k < out.length; k++) {
		const m = /^((?:\/\*@ns:(?:\d+|-)\*\/)?)(\s*)if #available\(iOS ([\d.]+), \*\) \{$/.exec(out[k]);
		if (!m || parseFloat(m[3]) > version) continue;
		const pad = m[2];
		const close = out.findIndex((l, j) => j > k && l === `${pad}} else {`);
		if (
			close < 0 ||
			out[close + 2] !== `${pad}}` ||
			out.slice(k + 1, close).some((l) => {
				const t = l.replace(marker, '');
				return t.length > 0 && !t.startsWith(`${pad} `);
			})
		)
			continue;
		out.splice(close, 3, `${pad}}`);
		out[k] = `${m[1]}${pad}do {`;
	}
	return out.join('\n');
}

/** An expression compared with undefined or null (`x?.find(f) === undefined`): its optional is what the comparison reads. */
export function comparedToNullish(e: ts.Expression): boolean {
	let n: ts.Node = e;
	while (ts.isParenthesizedExpression(n.parent)) n = n.parent;
	const p = n.parent;
	if (!ts.isBinaryExpression(p)) return false;
	const k = p.operatorToken.kind;
	if (![ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(k)) return false;
	return isNullish(p.left === n ? p.right : p.left);
}

export function isSymbolAsyncIterator(e: ts.Expression, checker: ts.TypeChecker): boolean {
	return ts.isPropertyAccessExpression(e) && e.name.text === 'asyncIterator' && ts.isIdentifier(e.expression) && e.expression.text === 'Symbol' && !!checker.getSymbolAtLocation(e.expression)?.declarations?.every((d) => d.getSourceFile().isDeclarationFile);
}

/** A function's `length` as script reads it: its parameters before the first with a default or the rest. */
export function scriptLength(fn: ts.SignatureDeclaration): number {
	const params = fn.parameters.filter((p) => !(ts.isIdentifier(p.name) && p.name.text === 'this'));
	const k = params.findIndex((p) => p.initializer || p.dotDotDotToken);
	return k < 0 ? params.length : k;
}

export function numberLiteral(text: string): string {
	const t = text.replace(/_/g, '');
	// Past 2^53 an integer literal is the double JavaScript rounds it to, written so Swift cannot infer Int (which overflows past 2^63).
	if (/^(\d+|0[xob][\da-f]+)$/i.test(t) && Number(t) > Number.MAX_SAFE_INTEGER) {
		const d = String(Number(t));
		return /^\d+$/.test(d) ? d + '.0' : d;
	}
	if (/^0[xob]/i.test(t)) return String(Number(t));
	if (/^0\d+$/.test(t)) return String(parseInt(t, 8));
	if (t.startsWith('.')) return '0' + t;
	if (t.endsWith('.')) return t + '0';
	return t;
}

/** A number literal, or a conditional with one among its branches, however nested. */
export function numberLiteralBranch(e: ts.Expression): boolean {
	const bare = ts.skipParentheses(e);
	return numericLiteralOnly(bare) || (ts.isConditionalExpression(bare) && [bare.whenTrue, bare.whenFalse].some(numberLiteralBranch));
}

export function numericLiteralOnly(e: ts.Expression): boolean {
	if (ts.isParenthesizedExpression(e)) return numericLiteralOnly(e.expression);
	if (ts.isNumericLiteral(e)) return true;
	if (ts.isPrefixUnaryExpression(e)) return numericLiteralOnly(e.operand);
	if (ts.isBinaryExpression(e)) return numericLiteralOnly(e.left) && numericLiteralOnly(e.right);
	return false;
}

/** Whether code assigns to a symbol (`x = …`, `x += …`, `x++`). */
export function assignsTo(node: ts.Node, sym: ts.Symbol | undefined, checker: ts.TypeChecker): boolean {
	if (!sym) return false;
	let found = false;
	const target = (x: ts.Expression) => ts.isIdentifier(x) && checker.getSymbolAtLocation(x) === sym;
	const visit = (n: ts.Node) => {
		if (found) return;
		if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && target(n.left)) {
			found = true;
			return;
		}
		if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(n.operator) && target(n.operand)) {
			found = true;
			return;
		}
		ts.forEachChild(n, visit);
	};
	visit(node);
	return found;
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
	return out;
}

/** What script's result is as a native method's result of this type. */
export function nativeResult(code: string, type: string): string {
	const t = type.replace(/[?!]$/, '');
	if (t === 'Bool' || t === 'ObjCBool') return `${RT.jsTruthy}(${code})`;
	if (['Double', 'Float', 'CGFloat'].includes(t)) return `${t}(${RT.jsToNumber}(${code}))`;
	if (/^U?Int(8|16|32|64)?$/.test(t)) return `${RT.jsNativeIntegerArgument}(${code}, ${t}.self)`;
	if (t === 'String') return /[?!]$/.test(type) ? `${RT.jsNativeString}(${code})` : `${RT.jsToString}(${code})`;
	return /[?!]$/.test(type) ? `(${RT.jsToNative}(${code}) as? ${t})` : `${RT.jsNativeArgument}(${code}, ${metatype(t)})`;
}

/** Swift code without the bodies of its `if #available(…) { … }` blocks: what it names outside them. */
export function withoutAvailableBlocks(code: string): string {
	let out = '',
		i = 0;
	for (;;) {
		const at = code.indexOf('if #available(', i);
		if (at < 0) return out + code.slice(i);
		const open = code.indexOf('{', at);
		if (open < 0) return out + code.slice(i);
		let depth = 0,
			k = open;
		for (; k < code.length; k++) {
			if (code[k] === '{') depth++;
			else if (code[k] === '}' && --depth === 0) break;
		}
		out += code.slice(i, open + 1) + '}';
		i = k + 1;
	}
}

/** A type's metatype expression: a function type or an existential (`any P.self` is `any (P.self)`) needs parentheses before `.self`. */
export function metatype(type: string): string {
	return type.includes('->') || type.startsWith('any ') ? `(${type}).self` : `${type}.self`;
}

/** A native result type's value where script's method threw. */
export function nativeZero(type: string): string {
	const t = type.replace(/[?!]$/, '');
	if (/[?!]$/.test(type)) return 'nil';
	if (t === 'Bool') return 'false';
	if (t === 'String') return '""';
	if (/^(U?Int(8|16|32|64)?|Double|Float|CGFloat)$/.test(t)) return '0';
	return `${RT.jsNativeZero}(${metatype(t)})`;
}

/** A statement after which control never continues: it ends in `return` or `throw`. */
export function exitsStatement(st: ts.Statement): boolean {
	if (ts.isReturnStatement(st) || ts.isThrowStatement(st)) return true;
	if (ts.isBlock(st)) return st.statements.length > 0 && exitsStatement(st.statements[st.statements.length - 1]);
	return false;
}

/**
 * `jsImplicit(x)` where it changes nothing: of a value Swift already holds optional (a conditional cast, an optional
 * chain's member, a name the file declares only as optional), or where an optional is taken anyway (`jsUnwrap`'s value,
 * a declaration of an optional type). Applied to a finished file, after the translator's own rewrites have read the marker.
 */
export function withoutRedundantImplicit(code: string, optionalStatics: ReadonlySet<string> = new Set(), optionalNames = namesHeldOptional(code)): string {
	const out: string[] = [];
	let at = 0;
	for (const m of code.matchAll(/\bjsImplicit\(/g)) {
		if (m.index! < at) continue;
		const start = m.index! + m[0].length;
		let depth = 1,
			i = start,
			quoted = false;
		for (; i < code.length && depth; i++) {
			const c = code[i];
			if (quoted) {
				if (c === '\\') i++;
				else if (c === '"') quoted = false;
			} else if (c === '"') quoted = true;
			else if ('([{'.includes(c)) depth++;
			else if (')]}'.includes(c)) depth--;
		}
		if (depth) break;
		let arg = code.slice(start, i - 1);
		while (arg.startsWith('(') && arg.endsWith(')') && balanced(arg.slice(1, -1))) arg = arg.slice(1, -1);
		if (!balanced(arg)) continue;
		// Outside its parentheses the value is one operand: a cast at its end, or a chain with no spaces.
		let top = arg.replace(/"(?:[^"\\]|\\.)*"/g, '_');
		for (let prev = ''; prev !== top;) {
			prev = top;
			top = top.replace(/\([^()]*\)/g, '_');
		}
		const before = code.slice(Math.max(0, m.index! - 200), m.index!);
		// Where the value stands alone (an argument, a declaration's value), it needs no parentheses.
		const after = code.slice(i, i + 1);
		const alone = (/(?:\bjsUnwrap\(|\bjsImplicit\()\s*$/.test(before) && /^[,)]$/.test(after)) || (/\b(?:let|var) `?\w+`? *: *[^=\n]+\? *= *(?:try )?$/.test(before) && /^[\n;}]?$/.test(after));
		const name = /^`?(\w+)`?$/.exec(arg.trim())?.[1] ?? (optionalStatics.has(arg.trim()) ? arg.trim() : undefined);
		const optional = alone || /^[^\s]+ as\? [\w.]+(<[\w.<>, ?]*>)?$/.test(top) || /^(?:try )?jsCast_$/.test(top) || /^[^\s]*\?\.\w+$/.test(top) || (!!name && (optionalNames.has(name) || optionalStatics.has(name)));
		if (!optional) continue;
		const inner = withoutRedundantImplicit(arg, optionalStatics, optionalNames);
		out.push(code.slice(at, m.index!), alone || name ? inner : `(${inner})`);
		at = i;
	}
	out.push(code.slice(at));
	return out.join('');
}

const isOptionalType = (t: string) => /^[\w([]/.test(t) && balanced(t) && t.split('<').length === t.split('>').length && (/^\(.*\)\?$/.test(t) || (t.endsWith('?') && !t.includes('->')));

/** The static members the files declare optional, as code names them (`Core_ui_styling_style_properties.colorProperty`). */
export function staticsHeldOptional(files: Iterable<string>): Set<string> {
	const optional = new Set<string>();
	for (const code of files) {
		let type: string | undefined;
		for (const line of code.split('\n')) {
			const top = /^(?:(?:public|open|final|internal|@\w+(?:\([^)]*\))?)\s+)*(?:enum|class|struct|extension)\s+(\w+)/.exec(line);
			if (top) {
				type = top[1];
				continue;
			}
			const m = /^ {4}(?:(?:public|open|internal|nonisolated(?:\(unsafe\))?)\s+)*static\s+(?:var|let)\s+`?(\w+)`?\s*:\s*([^={]+?)\s*(?:[={].*)?$/.exec(line);
			if (type && m && isOptionalType(m[2])) optional.add(`${type}.${m[1]}`);
		}
	}
	return optional;
}

/**
 * The names `code` declares only as optional (`let x: T?`, a parameter `_ x: T?`), and never otherwise: not as another
 * type, nor without one (`let x = …`, `if let x`, a closure's `x in`), which could shadow an optional one.
 */
function namesHeldOptional(source: string): Set<string> {
	const optional = new Set<string>(),
		other = new Set<string>();
	// Comments (the source-line markers among them) and strings hold no declarations.
	const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"/g, '""');
	for (const m of code.matchAll(/\b(\w+)`? *: *([^=,{\n]+?) *(?=[=,){\n])/g)) (isOptionalType(m[2]) ? optional : other).add(m[1]);
	for (const m of code.matchAll(/\b(?:let|var|for|case let|case var) +`?(\w+)`? *(?!`?\w|`? *:)/g)) other.add(m[1]);
	for (const m of code.matchAll(/\b(\w+)`?\)? +in\b/g)) other.add(m[1]);
	for (const m of code.matchAll(/\b(?:weak|unowned) +(?:var +)?`?(\w+)/g)) other.add(m[1]);
	return new Set([...optional].filter((n) => !other.has(n)));
}

/** `rest`: the parameter a `JSRest` type marks as a rest parameter (spelled `JSArray` in `params`), else -1. */
export interface FunctionParts {
	text: string;
	params: string[];
	result: string;
	rest: number;
}
/**
 * What a function cell's static member does: box a typed closure as a script function (`script`), call a script function as a
 * typed closure (`fromScript`), adapt one function type to another (`adapting`), or read a function declaration as a value (`declared`, `local`).
 */
export type CellStatic = 'script' | 'fromScript' | 'adapting' | 'declared' | 'local';

/** `(A, B) throws -> R` split into its parameter and result types; null for any other type. */
export function functionParts(type: string): FunctionParts | null {
	const t = type.trim();
	if (!t.startsWith('(')) return null;
	let depth = 0,
		close = -1;
	for (let i = 0; i < t.length; i++) {
		if (t[i] === '(' || t[i] === '[' || t[i] === '<') depth++;
		else if (t[i] === ')' || t[i] === ']' || (t[i] === '>' && t[i - 1] !== '-')) {
			depth--;
			if (depth === 0) {
				close = i;
				break;
			}
		}
	}
	if (close < 0) return null;
	const rest = /^\s*(?:throws\s*)?->\s*(.+)$/.exec(t.slice(close + 1));
	if (!rest) return null;
	const inner = t.slice(1, close).trim();
	const params = inner ? splitTopLevel(inner) : [];
	return { text: `(${params.join(', ')}) throws -> ${rest[1]}`, params: params.map((p) => p.replace(/^JSRest</, 'JSArray<')), result: rest[1], rest: params.findIndex((p) => isKit(spelledType(p), 'JSRest')) };
}

/** A parameter's type, escaping if it is a function: the closure may keep it. */
export function escapingParam(type: string): string {
	const t = type.replace(/^@escaping /, '');
	return isFunctionType(t) ? `@escaping ${t}` : t;
}

/** A function type whose function parameters are escaping, which a function of the same type with non-escaping ones converts to. */
export function escapingFunction(fn: FunctionParts): string {
	return `(${fn.params.map(escapingParam).join(', ')}) throws -> ${fn.result}`;
}

/** Whether a function inside `node` names `sym`. */
export function functionsReferTo(node: ts.Node, sym: ts.Symbol | undefined, checker: ts.TypeChecker): boolean {
	let found = false;
	const visit = (n: ts.Node) => {
		if (found) return;
		if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n) || ts.isAccessor(n)) && refersTo(n, sym, checker)) {
			found = true;
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
		if (ts.isIdentifier(n) && checker.getSymbolAtLocation(n) === sym) {
			found = true;
			return;
		}
		ts.forEachChild(n, visit);
	};
	visit(node);
	return found;
}

/** Whether an initializer holds a function that reads `this`. */
export function capturesThis(e: ts.Expression): boolean {
	let found = false;
	const visit = (n: ts.Node, inFunction: boolean): void => {
		if (found) return;
		// Reading a field is allowed while fields are still being set; a method call or `this` as a value is not.
		const fieldRead = ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n && !(ts.isCallExpression(n.parent.parent) && n.parent.parent.expression === n.parent);
		if (n.kind === ts.SyntaxKind.ThisKeyword && (inFunction || !fieldRead)) {
			found = true;
			return;
		}
		// A `function` has a `this` of its own.
		if (ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isClassLike(n)) return;
		ts.forEachChild(n, (c) => visit(c, inFunction || ts.isArrowFunction(n)));
	};
	visit(e, false);
	return found;
}

/** Swift's own global functions, which a program's top-level function of the name loses overload resolution to (`assert(x)`). */
export const SWIFT_GLOBAL_FUNCTIONS = new Set(['assert', 'assertionFailure', 'precondition', 'preconditionFailure', 'print', 'debugPrint', 'dump', 'min', 'max', 'abs', 'zip', 'stride', 'swap', 'sequence', 'repeatElement', 'readLine', 'type']);

const identifierCounts = new WeakMap<ts.Node, Map<string, number>>();
/** How many times each identifier is spelled in `node`. */
function countIdentifiers(node: ts.Node): Map<string, number> {
	let counts = identifierCounts.get(node);
	if (counts) return counts;
	const found = new Map<string, number>();
	const visit = (n: ts.Node): void => {
		if (ts.isIdentifier(n)) found.set(n.text, (found.get(n.text) ?? 0) + 1);
		ts.forEachChild(n, visit);
	};
	visit(node);
	identifierCounts.set(node, found);
	return found;
}
/** Whether every name a block declares at its top level is spelled only inside it. */
export function blockNamesUnique(b: ts.Block): boolean {
	const names: string[] = [];
	const bound = (n: ts.BindingName): void => {
		if (ts.isIdentifier(n)) names.push(n.text);
		else for (const e of n.elements) if (!ts.isOmittedExpression(e)) bound(e.name);
	};
	for (const st of b.statements) {
		if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) bound(d.name);
		else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) names.push(st.name.text);
		else if (ts.isLabeledStatement(st)) names.push(st.label.text);
	}
	if (!names.length) return true;
	const sf = b.pos >= 0 ? ts.findAncestor(b, ts.isSourceFile) : undefined;
	if (!sf) return false;
	const file = countIdentifiers(sf),
		inside = countIdentifiers(b);
	return names.every((n) => file.get(n) === inside.get(n));
}

/** Whether `code` (no string literals) is wrapped in one pair of parentheses, the first closing at its end. */
function enclosed(code: string): boolean {
	if (!code.startsWith('(') || !code.endsWith(')') || code.includes('"')) return false;
	let depth = 0;
	for (let k = 0; k < code.length; k++) {
		depth += code[k] === '(' ? 1 : code[k] === ')' ? -1 : 0;
		if (depth === 0 && k < code.length - 1) return false;
	}
	return depth === 0;
}
/** Code that only postfix operators bind (`a.b`, `f(x)`, `a.b.c(x)`): parentheses around it change nothing. */
export function postfixOnly(code: string): boolean {
	const head = /^[A-Za-z_][\w.]*/.exec(code)?.[0];
	if (!head || head.endsWith('.')) return false;
	return head === code || enclosed(code.slice(head.length));
}
/** `!` of a Swift Bool expression: a literal flipped, a negation undone, parentheses only where they bind. */
export function negation(code: string): string {
	if (code === 'true' || code === 'false') return code === 'true' ? 'false' : 'true';
	// `try` marks all of the expression to its right, so `!(try x)` is `try !x`.
	const tried = /^try (.*)$/s.exec(code);
	if (tried) return `try ${negation(tried[1])}`;
	const negated = /^!\((.*)\)$/s.exec(code);
	if (negated && enclosed(code.slice(1))) return postfixOnly(negated[1]) ? negated[1] : `(${negated[1]})`;
	if (code.startsWith('!') && postfixOnly(code.slice(1))) return code.slice(1);
	const present = /^(.*) != nil$/s.exec(code);
	if (present && (postfixOnly(present[1]) || postfixChain(present[1]))) return `${present[1]} == nil`;
	return postfixOnly(code) ? `!${code}` : `!(${code})`;
}

/**
 * Types the generated Swift names without qualification (the standard library's, the Foundation types it uses): a program
 * type of one of these names would hide it from the module's code, so it takes its module's name. Other native classes keep
 * the program's name for its type and are written with their module (`Foundation.ProcessInfo`).
 */
export const SWIFT_NATIVE_TYPES = new Set(
	`Any AnyClass AnyHashable AnyObject Array ArraySlice AsyncSequence AsyncStream Bool
  CGFloat CGRect Character ClosedRange Codable Collection Comparable ContiguousArray CustomStringConvertible Data Date Decodable Dictionary
  Double Duration Encodable Equatable Error Float Float32 Float64 Hashable Hasher Int Int16 Int32 Int64 Int8
  IteratorProtocol KeyPath MainActor Mirror NSArray NSData NSDate NSDictionary NSError NSNumber NSObject NSString
  NSURL Never ObjectIdentifier Optional Range RawRepresentable Regex Result Selector Sendable Sequence Set
  StaticString String Substring Task UInt UInt16 UInt32 UInt64 UInt8 Unicode Void`.split(/\s+/),
);
