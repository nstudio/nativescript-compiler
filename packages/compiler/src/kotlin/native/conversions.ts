// Values converted between script and Java: arguments into Java parameters, Java results into script's.
import ts from 'typescript';
import { ACC_ENUM } from './classfiles.ts';
import { ARRAY_OF, CONVERT, KOTLIN_PRIMITIVE, NUMERIC, atom, charLiteral, numericLiteral, primitiveLiteral, type Raw } from './bridging.ts';
import type { AndroidNativeAPI } from './api.ts';
import { nativeBridging, type BridgeClass } from '../../semantics/conversion.ts';
import { cast, RT } from '../syntax.ts';
import { appMember } from '../../semantics/ast.ts';
import { isUntyped, spelledType } from '../../semantics/types.ts';

export const nativeConversionsMethods = {
	/** `float(n)`, `long(n)`: the number, and the Java type it asks for. */
	forced(this: AndroidNativeAPI, e: ts.Expression): { inner: ts.Expression; desc: string } | null {
		if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression) || e.arguments.length !== 1) return null;
		const name = e.expression.text;
		if ((name !== 'float' && name !== 'long') || !this.isNativeSymbol(this.t.resolve(e.expression))) return null;
		return { inner: e.arguments[0], desc: name === 'float' ? 'F' : 'J' };
	},

	/** A native read or call as Java returns it, before the conversion TypeScript's types ask for. */
	raw(this: AndroidNativeAPI, e: ts.Expression): Raw | null {
		while (ts.isParenthesizedExpression(e)) e = e.expression;
		if (this.t.subst.has(e)) return null;
		if (ts.isCallExpression(e)) {
			const made = this.arrayCreate(e);
			if (made) return made;
		}
		if (ts.isPropertyAccessExpression(e) && !appMember(e.name, this.t.checker) && !e.questionDotToken && this.receiver(e.expression)) {
			const r = this.read(e);
			return r?.script ? null : r;
		}
		if (ts.isCallExpression(e) && !e.questionDotToken && ts.isPropertyAccessExpression(e.expression) && !appMember(e.expression.name, this.t.checker) && this.receiver(e.expression.expression)) {
			const r = this.invoke(e);
			return r?.script ? null : r;
		}
		return this.intBits(e);
	},

	/**
	 * `a | b`, `&`, `^`, `<<`, `>>` of two Java ints (or int literals): Kotlin's Int operator, which is JavaScript's on
	 * their ToInt32 values. Kotlin's infix operators share one precedence, so an operand that is one is parenthesized
	 * unless it is the same operator on the left.
	 */
	intBits(this: AndroidNativeAPI, e: ts.Expression): Raw | null {
		if (!ts.isBinaryExpression(e)) return null;
		const K = ts.SyntaxKind;
		const op = ({ [K.BarToken]: 'or', [K.AmpersandToken]: 'and', [K.CaretToken]: 'xor', [K.LessThanLessThanToken]: 'shl', [K.GreaterThanGreaterThanToken]: 'shr' } as Partial<Record<ts.SyntaxKind, string>>)[e.operatorToken.kind];
		if (!op) return null;
		const side = (x: ts.Expression, left: boolean): string | null => {
			const v = numericLiteral(x);
			if (v !== null) return Number.isInteger(v) && v >= -0x80000000 && v <= 0x7fffffff && !Object.is(v, -0) ? (v < 0 ? `(${v})` : String(v)) : null;
			const r = this.raw(x);
			if (!r || r.desc !== 'I' || r.nullable || r.optional) return null;
			const inner = ts.skipParentheses(x);
			return left && ts.isBinaryExpression(inner) && inner.operatorToken.kind === e.operatorToken.kind ? r.code : atom(r.code);
		};
		const l = side(e.left, true),
			r = l === null ? null : side(e.right, false);
		return l !== null && r !== null ? { code: `${l} ${op} ${r}`, desc: 'I' } : null;
	},

	/** A TypeScript value where a Java parameter or field of type `desc` takes it. */
	toJava(this: AndroidNativeAPI, e: ts.Expression, desc: string, nullableParam = false, nonNullParam = false, signature?: string, typeVar?: (name: string) => string): string {
		const t = this.t;
		let inner = e;
		while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
		if (inner.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(inner) && inner.text === 'undefined')) return 'null';
		const forced = this.forced(inner);
		if (forced) return this.toJava(forced.inner, desc, nullableParam, nonNullParam);
		const literal = numericLiteral(inner);
		if (literal !== null && (NUMERIC.has(desc) || desc === 'C')) return primitiveLiteral(literal, desc);
		const found = this.raw(inner);
		// Library mode: a Java parameter of an object nobody declares non-null takes null, as Java code does.
		const takesNull = this.t.library && desc.startsWith('L') && !nonNullParam;
		const raw = found && { ...found, code: found.nullable && !nullableParam && !takesNull ? this.t.asserted(found.code) : found.code };
		if (raw) {
			if (raw.desc === desc) return raw.code;
			if (NUMERIC.has(raw.desc) && NUMERIC.has(desc)) return desc === 'D' ? `${atom(raw.code)}.toDouble()` : `${atom(raw.code)}${raw.desc === 'I' ? CONVERT[desc].replace(/^\.toLong\(\)(?=\.)/, '') : CONVERT[desc]}`;
			if (raw.desc === 'Ljava/lang/String;' && desc === 'Ljava/lang/CharSequence;') return raw.code;
			if (raw.desc.startsWith('L') && desc.startsWith('L') && this.classpath.distance(raw.desc.slice(1, -1), desc.slice(1, -1)) !== null) {
				// A generic collection script fills untyped (`new java.util.HashSet<any>()`) where Java's parameter names its element type.
				if (this.t.library && signature?.includes('<') && !/\bT[A-Z]?;|<[A-Z];|[+\-*]/.test(signature)) return cast(raw.code, `${this.kotlinType(signature, 'Any?')}${nonNullParam ? '' : '?'}`);
				return raw.code;
			}
		}
		// A Java array the code made and holds as one (its declaration names no JavaScript array): itself.
		const created = /^JSArray</.test(t.typeOf(inner)) ? null : this.createdArray(inner);
		if (created && (created.desc === desc || desc === 'Ljava/lang/Object;')) return cast(t.expr(inner), this.kotlinType(created.desc, 'Any?'));
		if (NUMERIC.has(desc)) {
			const from: BridgeClass = isUntyped(spelledType(t.typeOf(inner))) ? 'untyped' : /^Double\??$/.test(t.typeOf(inner)) ? 'number' : 'other';
			const step = nativeBridging(from, desc === 'D' ? 'double' : desc === 'F' ? 'floating' : 'integer');
			// ToNumber of the value (undefined is NaN, which Kotlin converts to 0); an integer through a Long, as NativeScript's
			// runtime converts one. A value of no number class is ToNumber of it too.
			const n = atom(t.toNumber(inner));
			return step === 'double' ? n : step === 'floating' ? `${n}.toFloat()` : `${n}${CONVERT[desc]}`;
		}
		if (desc === 'Z') return t.coerce(inner, 'Boolean');
		if (desc === 'C') {
			if (ts.isStringLiteralLike(inner) && inner.text.length === 1) return charLiteral(inner.text);
			return t.typeOf(inner) === 'String' ? `${atom(t.expr(inner))}[0]` : `${atom(t.toNumber(inner))}.toInt().toChar()`;
		}
		if (desc.startsWith('[')) return this.toJavaArray(inner, desc, nonNullParam);
		if (desc === 'Ljava/nio/ByteBuffer;' && this.isBuffer(inner)) {
			const value = ts.isAsExpression(inner) ? inner.expression : inner;
			return `(${t.expr(value)} as JSBufferSource).jsBytes`;
		}
		const k = this.kind(inner);
		// Library mode: a read the translator holds untyped (checks narrowed it to nothing) where Java takes a class.
		if (t.library && k.kind !== 'any' && isUntyped(spelledType(t.typeOf(inner))) && desc.startsWith('L') && desc !== 'Ljava/lang/Object;') return cast(t.expr(inner), `${this.kotlinType(desc, 'Any?')}${nonNullParam ? '' : '?'}`);
		const typeVarName = signature && typeVar ? /^T(\w+);$/.exec(signature)?.[1] : undefined;
		if (k.kind === 'any' && typeVarName && !isUntyped(spelledType(typeVar!(typeVarName)))) return cast(t.expr(inner), `${typeVar!(typeVarName).replace(/\?$/, '')}${nonNullParam ? '' : '?'}`);
		if (k.kind === 'any') return cast(t.expr(inner), `${this.kotlinType(signature && !/\bT[A-Z]?;|<[A-Z];/.test(signature) ? signature : desc, 'Any?')}${nonNullParam ? '' : '?'}`);
		// Library mode: a number where Java takes one of its enums (core's typings declare them numbers): the constant of that ordinal.
		const enumClass = t.library && k.kind === 'number' && desc.startsWith('L') ? this.classpath.get(desc.slice(1, -1)) : undefined;
		if (enumClass && enumClass.access & ACC_ENUM) return `${this.kotlinName(enumClass.name)}.values()[${atom(t.toNumber(inner))}.toInt()]`;
		if (k.kind === 'string' && takesNull) {
			if (ts.isConditionalExpression(inner)) return `(if (${t.cond(inner.condition)}) ${this.toJava(inner.whenTrue, desc, nullableParam, nonNullParam)} else ${this.toJava(inner.whenFalse, desc, nullableParam, nonNullParam)})`;
			return t.coerce(inner, 'String?');
		}
		if (k.kind === 'number' || k.kind === 'string' || k.kind === 'boolean') return t.coerce(inner, k.kind === 'number' ? 'Double' : k.kind === 'string' ? 'String' : 'Boolean');
		// Library mode: a generic collection script fills untyped (`new java.util.HashSet<any>()`) where Java's parameter names its element type.
		if (t.library && signature?.includes('<') && !/\bT[A-Z]?;|<[A-Z];|[+\-*]/.test(signature) && this.classesOf(t.checker.getTypeAtLocation(inner))?.some((c) => this.classpath.distance(c, desc.slice(1, -1)) !== null)) {
			return cast(t.expr(inner), `${this.kotlinType(signature, 'Any?')}${nonNullParam ? '' : '?'}`);
		}
		if (takesNull && (ts.isIdentifier(inner) || ts.isPropertyAccessExpression(inner))) {
			t.nullOk.add(inner);
			try {
				return t.expr(inner);
			} finally {
				t.nullOk.delete(inner);
			}
		}
		return t.expr(inner);
	},

	toJavaArray(this: AndroidNativeAPI, e: ts.Expression, desc: string, nonNull = false): string {
		const t = this.t;
		const el = desc.slice(1);
		const prim = ARRAY_OF[el];
		if (ts.isArrayLiteralExpression(e) && !e.elements.some(ts.isSpreadElement)) {
			const items = e.elements.map((x) => this.toJava(x, el)).join(', ');
			return prim ? `${prim}ArrayOf(${items})` : `arrayOf<${this.kotlinType(el, 'Any?')}>(${items})`;
		}
		const k = this.kind(e);
		// An untyped array where Java takes an array: converted element by element at run time, as the runtime marshals it.
		if (k.kind === 'any') return `(${RT.toJavaValue}(${t.expr(e)}, ${this.kotlinType(desc, 'Any?')}::class.java) as ${this.kotlinType(desc, 'Any?')}?)`;
		// Library mode: a missing array is null to Java, as the runtime marshals undefined.
		const q = t.library ? '?' : '';
		if (q && (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e))) t.nullOk.add(e);
		let code: string;
		try {
			code = atom(t.expr(e));
		} finally {
			t.nullOk.delete(e);
		}
		const list = q ? `${code}?.elements` : `${t.typeOf(e).endsWith('?') ? t.present(code, 'elements', e) : code}.elements`;
		// A parameter Java declares present gets the array, as Kotlin types the argument.
		const present = (x: string) => (q && nonNull ? this.t.asserted(x) : x);
		if (!prim) return present(`${list}${q}.map { it as ${this.kotlinType(el, 'Any?')} }${q}.toTypedArray()`);
		const kotlin = KOTLIN_PRIMITIVE[el];
		if (el === 'D' || el === 'Z') return present(`${list}${q}.to${kotlin}Array()`);
		if (el === 'C') return present(`${list}${q}.map { it[0] }${q}.toCharArray()`);
		return present(`${list}${q}.map { it${CONVERT[el]} }${q}.to${kotlin}Array()`);
	},

	/** A Java value as TypeScript reads it: numbers are Double, a char is a string, an array is a JSArray. */
	fromJava(this: AndroidNativeAPI, code: string, desc: string, optional = false): string {
		const q = optional ? '?' : '';
		if (NUMERIC.has(desc)) return desc === 'D' ? code : `${atom(code)}${q}.toDouble()`;
		if (desc === 'C') return `${atom(code)}${q}.toString()`;
		if (desc === 'Ljava/lang/CharSequence;') return `${atom(code)}${q}.toString()`;
		if (desc.startsWith('[')) {
			const el = desc.slice(1);
			const items = (x: string) => (NUMERIC.has(el) && el !== 'D' ? `${x}.map { it.toDouble() }` : el === 'C' ? `${x}.map { it.toString() }` : `${x}.toList()`);
			return optional ? `${atom(code)}?.let { __array -> JSArray(${items('__array')}) }` : `JSArray(${items(atom(code))})`;
		}
		return code;
	},

	/** A Java type in Kotlin: a descriptor or a generic signature's type, type variables as `typeVar`. */
	kotlinType(this: AndroidNativeAPI, sig: string, typeVar: string | ((name: string) => string)): string {
		let i = 0;
		const one = (): string => {
			const ch = sig[i];
			if (ch === '[') {
				i++;
				const elStart = i;
				const inner = one();
				const el = sig.slice(elStart, i);
				return ARRAY_OF[el] ? `${KOTLIN_PRIMITIVE[el]}Array` : `Array<${inner}>`;
			}
			if (KOTLIN_PRIMITIVE[ch]) {
				i++;
				return KOTLIN_PRIMITIVE[ch];
			}
			if (ch === 'T') {
				const end = sig.indexOf(';', i);
				const name = sig.slice(i + 1, end);
				i = end + 1;
				return typeof typeVar === 'string' ? typeVar : typeVar(name);
			}
			if (ch === '*') {
				i++;
				return '*';
			}
			if (ch === '+') {
				i++;
				return `out ${one()}`;
			}
			if (ch === '-') {
				i++;
				return `in ${one()}`;
			}
			// `Lpkg/Outer<args>.Inner<args>;`: an inner class's outer type arguments are dropped.
			i++;
			let internal = '';
			let segment = '';
			let args: string[] = [];
			for (;;) {
				const c = sig[i];
				if (c === '<') {
					i++;
					args = [];
					while (sig[i] !== '>') args.push(one());
					i++;
				} else if (c === '.' || c === ';') {
					internal = internal ? `${internal}$${segment}` : segment;
					segment = '';
					i++;
					if (c === ';') break;
					args = [];
				} else {
					segment += c;
					i++;
				}
			}
			// A Kotlin library's function type (`kotlin.jvm.functions.Function1<in CalendarMonth, Unit>`): Kotlin's own `(CalendarMonth) -> Unit`.
			if (/^kotlin\/jvm\/functions\/Function\d+$/.test(internal) && args.length && !args.includes('*')) {
				const plain = args.map((a) => a.replace(/^(in|out) /, ''));
				return `((${plain.slice(0, -1).join(', ')}) -> ${plain[plain.length - 1]})`;
			}
			if (!args.length) args = Array(this.typeParamCount(this.classpath.get(internal))).fill('*');
			return args.length ? `${this.kotlinTypeName(internal)}<${args.join(', ')}>` : this.kotlinTypeName(internal);
		};
		return one();
	},
};
