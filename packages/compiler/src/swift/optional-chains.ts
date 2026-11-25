// Reads that may give undefined as Swift: mayGiveUndefined, optional chain links and undefined converted to a type.
import { heldLoss } from '../semantics/losses.ts';
import ts from 'typescript';
import { isTypedArrayType } from './library.ts';
import { ident, identPath, isFunctionType, isNullish, isOptional, openSwiftChain, optionalType, sameClass, swiftString, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { keyName, isEnumObject, receiverCell, receiverSlot } from '../semantics/placement.ts';
import { uncheckedMatch } from '../semantics/lang.ts';
import { isWriteTarget } from '../semantics/ast.ts';
import { isKit, isNamed, isUntyped, parseNativeType, spelledType } from '../semantics/types.ts';
import { symbolField } from '../semantics/spelled.ts';

export const optionalChainsMethods = {
	/**
	 * Whether `e` may give undefined where TypeScript types it present, and if so how to write that optional; decided
	 * without writing code, so the throws analysis (run before any translation) and `declaration` ask it alike.
	 */
	mayGiveUndefined(this: Translator, e: ts.Expression): (() => string) | null {
		while (ts.isParenthesizedExpression(e)) e = e.expression;
		const awaited = this.awaited(e);
		if (awaited) return () => awaited.raw;
		const asserted = this.assertedUntyped(e);
		// An object variable (`const v = x as View`) is held as Swift's type says, the value checked there; one declared optional takes it unchecked.
		if (asserted && (['String', 'Double', 'Bool'].includes(this.typeOf(asserted)) || !ts.isVariableDeclaration(ts.walkUpParenthesizedExpressions(asserted.parent)))) return () => this.assertedOptional(asserted);
		if (ts.isCallExpression(e) && !this.typeOf(e).endsWith('?')) {
			const decl = this.checker.getResolvedSignature(e)?.getDeclaration();
			if (decl && !ts.isJSDocSignature(decl) && this.mayReturnUndefined(decl) && this.returnTypeOf(decl).endsWith('?')) return () => this.rawRead(e);
		}
		// `x ??= v` of a slot held optional, where `v` may be undefined: what it assigns, which may be.
		if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken && ['String', 'Double', 'Bool'].includes(this.typeOf(e))) {
			const declared = this.declaredTypeOf(e.left) ?? this.typeOf(e.left);
			if (isOptional(declared) && this.mayGiveUndefined(e.right)) {
				return () => {
					const tp = this.tryPrefix(e);
					return `({ () ${tp ? 'throws ' : ''}-> ${declared} in ${tp}${this.binary(e)}; return ${this.marks.tryBefore(this.tryPrefix(e.left), this.expr(e.left))} }())`;
				};
			}
		}
		// A string, number or boolean read by key from an untyped object (`map[symbol] ?? fallback`): undefined where it has no such key.
		if (ts.isElementAccessExpression(e) && !isWriteTarget(e) && ['String', 'Double', 'Bool'].includes(this.typeOf(e))) {
			const holder = this.typeOf(e.expression).replace(/[?!]$/, '');
			if (holder === 'Any' || holder === 'JSObject') return () => this.fromAny({ code: this.marks.ownTried(`${RT.jsGet}(${this.expr(e.expression)}, ${this.propertyKey(e.argumentExpression)})`), throws: true, pure: false }, optionalType(this.typeOf(e)));
		}
		// A string's character past its end is undefined, though TypeScript types the read `string`.
		if (ts.isElementAccessExpression(e) && !isWriteTarget(e) && !e.questionDotToken && this.typeOf(e.expression) === 'String' && this.typeOf(e) === 'String') {
			return () => `${RT.jsCharAtOrUndefined}(${this.expr(e.expression)}, ${this.coerce(e.argumentExpression, 'Double')})`;
		}
		// `a ?? b` where `b` may give undefined: the optional `b` gives when `a` gives nothing.
		if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && (['String', 'Double', 'Bool'].includes(this.typeOf(e)) || (this.missingObjectType(e) && this.states.missingObject(e)))) {
			const right = this.mayGiveUndefined(e.right);
			if (right) return () => `(${this.maybeUndefined(e.left) ?? this.coerce(e.left, optionalType(this.typeOf(e)))} ?? ${right()})`;
		}
		// `c ? a : b` where a branch may give undefined: each branch as the optional it may be.
		if (ts.isConditionalExpression(e) && ['String', 'Double', 'Bool'].includes(this.typeOf(e)) && [e.whenTrue, e.whenFalse].some((b) => this.mayGiveUndefined(b))) {
			const t = optionalType(this.typeOf(e));
			return () => this.ternary(e, t, (x) => this.maybeUndefined(x) ?? this.coerce(x, t));
		}
		// Lenient code: a variable of a string, number or boolean an optional chain reads (`scene?.session?.persistentIdentifier`) is undefined where the chain stops.
		if (this.lenient && ts.isPropertyAccessExpression(e) && ts.isOptionalChain(e) && ts.isVariableDeclaration(ts.walkUpParenthesizedExpressions(e.parent)) && !this.optionalReads.has(e) && ['String', 'Double', 'Bool'].includes(this.typeOf(e))) {
			return () => {
				this.optionalReads.set(e, false);
				try {
					return this.native.readOptional(e, () => this.expr(e));
				} finally {
					this.optionalReads.delete(e);
				}
			};
		}
		if (ts.isPropertyAccessExpression(e) && !isWriteTarget(e) && this.isAddedMember(e)) {
			const t = this.typeOf(e);
			if (!isUntyped(spelledType(t)) && !isOptional(t)) return () => this.fromAny(`${RT.jsField}(${this.expr(e.expression)}, ${swiftString(e.name.text)})`, optionalType(t));
		}
		if (ts.isPropertyAccessExpression(e) && !isWriteTarget(e) && this.augmentedMember(e)) {
			const t = this.typeOf(e);
			if (!isUntyped(spelledType(t)) && !isOptional(t)) return () => this.fromAny(this.augmentedRead(e)!, optionalType(t));
		}
		// `c ? value : null`, checked without strictNullChecks: the value or nothing.
		if (ts.isConditionalExpression(e) && [e.whenTrue, e.whenFalse].some(isNullish) && ![e.whenTrue, e.whenFalse].every(isNullish)) {
			const t = this.typeOf(e);
			if (!isUntyped(spelledType(t)) && t !== 'Void' && !isOptional(t) && !t.endsWith('!')) {
				return () => this.ternary(e, optionalType(t), (x) => (isNullish(x) ? 'nil' : this.coerce(x, optionalType(t))));
			}
		}
		if (this.states.emptyDefault(e)) {
			const left = (e as ts.BinaryExpression).left;
			return () => this.coerce(left, optionalType(this.typeOf(e)));
		}
		if (ts.isConditionalExpression(e) && this.states.mayGiveEmptyDefault(e) && !isOptional(this.typeOf(e))) {
			const t = optionalType(this.typeOf(e));
			return () => this.ternary(e, t, (x) => this.maybeUndefined(x) ?? this.coerce(x, t));
		}
		// `x?.m()` on an untyped value: undefined where x is, whatever its declared result.
		if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.questionDotToken && this.isAny(e.expression.expression)) {
			const t = this.typeOf(e);
			if (!isUntyped(spelledType(t)) && t !== 'Void' && !isOptional(t)) return () => this.fromAny(this.rawRead(e), optionalType(t));
		}
		if (ts.isCallExpression(e) && this.libMayBeUndefined(e)) return () => this.rawRead(e);
		// `a?.b()` whose result TypeScript types present: Swift's chain gives an optional.
		if (ts.isCallExpression(e) && ts.isOptionalChain(e) && !['Any?', 'Void'].includes(this.typeOf(e)) && !isOptional(this.typeOf(e))) return () => this.rawRead(e);
		// `a?.b() as T`: undefined where the chain stops, whatever the assertion says.
		if (ts.isAsExpression(e) && ts.isOptionalChain(e.expression) && !this.typeOf(e).endsWith('?') && this.isObjectRef(e)) {
			const inner = e.expression;
			if (this.isAny(inner)) return () => this.fromAny(this.expr(inner), optionalType(this.typeOf(e)));
			return () => (sameClass(this.typeOf(inner), this.typeOf(e)) ? this.expr(inner) : this.marks.castCode(this.expr(inner), this.typeOf(e), 'as?'));
		}
		// A key of a dictionary-typed object, read before its type's zero stands in for a missing one.
		if ((ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) && !e.questionDotToken && !isWriteTarget(e) && /^JSRecord<.*>$/.test(this.typeOf(e.expression)) && !isOptional(this.typeOf(e))) {
			const r = e;
			return () => {
				const key = ts.isPropertyAccessExpression(r) ? swiftString(r.name.text) : this.str(r.argumentExpression);
				return this.typeOf(r.expression) === 'JSRecord<Any?>' ? this.marks.orNil(`${this.expr(r.expression)}[${key}]`) : `${this.expr(r.expression)}[${key}]`;
			};
		}
		// `a || undefined`, `a && null`: the left operand or undefined, which a value type cannot hold.
		if (ts.isBinaryExpression(e) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(e.operatorToken.kind) && isNullish(e.right)) {
			const t = this.typeOf(e);
			const lt = this.mayGiveUndefined(e.left) ? optionalType(this.typeOf(e.left)) : this.typeOf(e.left);
			if (!isOptional(t) && !isUntyped(spelledType(t)) && t !== 'Void' && (lt === t || lt === optionalType(t))) {
				return () => {
					const left = this.maybeUndefined(e.left);
					const v = this.fresh('__v');
					const tr = this.tryPrefix(e.left);
					const [truthy, falsy] = e.operatorToken.kind === ts.SyntaxKind.BarBarToken ? [v, 'nil'] : ['nil', v];
					return `({ () ${tr ? 'throws ' : ''}-> ${optionalType(t)} in let ${v}: ${optionalType(t)} = ${this.marks.tryBefore(tr, left ?? this.expr(e.left))}; return ${RT.jsTruthy}(${v} as Any?) ? ${truthy} : ${falsy} }())`;
				};
			}
		}
		// A match's group that took no part in it: undefined, though TypeScript types every element a string.
		if (ts.isElementAccessExpression(e) && !isWriteTarget(e) && isNamed(spelledType(this.typeOf(e.expression)), 'JSMatch') && !uncheckedMatch(e.expression, this.checker)) {
			const r = e;
			return () => {
				const q = r.questionDotToken || this.continuesOptional(r.expression) ? '?' : '';
				const present = q ? null : this.receiver(r.expression, keyName(r.argumentExpression));
				return this.marks.orNil(this.marks.elementOf(present ?? this.expr(r.expression), this.toNumber(r.argumentExpression), `${q}.values`));
			};
		}
		// `Enum[value]` of a value no member has: undefined, though TypeScript types it a string.
		if (ts.isElementAccessExpression(e) && !isWriteTarget(e) && !ts.isStringLiteral(e.argumentExpression) && isEnumObject(this.placement, e.expression) && !isOptional(this.typeOf(e))) {
			const r = e;
			return () => {
				const object = ts.isIdentifier(r.expression) ? identPath(this.declaredName(r.expression)) : this.expr(r.expression);
				const code = `${object}.jsEnumObject[jsKey: ${this.propertyKey(r.argumentExpression)}]`;
				return this.isAny(r) ? code : this.fromAny(code, optionalType(this.typeOf(r)));
			};
		}
		if (ts.isElementAccessExpression(e) && !isWriteTarget(e) && isTypedArrayType(this.typeOf(e.expression).replace(/[?!]$/, ''))) {
			const r = e;
			return () => {
				const target = this.expr(r.expression);
				const recv = this.elementReceiver(r, target);
				return `${recv}${recv === target && (r.questionDotToken || this.continuesOptional(r.expression)) ? '?' : ''}[jsIndex: ${this.toNumber(r.argumentExpression)}]`;
			};
		}
		if (ts.isElementAccessExpression(e) && !isWriteTarget(e) && isKit(spelledType(this.typeOf(e.expression).replace(/\?$/, '')), 'JSArray')) {
			const r = e;
			return () => {
				// A chain's element that may be missing, indexed (`g?.[1][0]`): checked inside the chain.
				const link = !r.questionDotToken && ts.isOptionalChain(r) ? receiverCell(this.receivers, receiverSlot(r.expression, keyName(r.argumentExpression))) : null;
				const linked = link?.cell === 'chained' ? this.receiverCode(link, keyName(r.argumentExpression)) : null;
				const held = linked ?? this.expr(r.expression);
				const target = linked ?? this.elementReceiver(r, held);
				// An element of a call continuing an optional chain (`xs?.map(f)[0]`) is part of the chain.
				const inChain = !!linked || (!r.questionDotToken && ts.isCallExpression(r.expression) && ts.isOptionalChain(r.expression) && openSwiftChain(target));
				const q = !inChain && target === held && ((r.questionDotToken && !this.presentLink(r.expression) && !this.presentHead(r.expression)) || this.continuesOptional(r.expression)) ? '?' : '';
				const code = this.marks.elementOf(target, this.toNumber(r.argumentExpression), q);
				// An untyped element narrowed (`args[0] instanceof Path2D`, `typeof arguments[0] === 'number'`): the element as that type.
				const narrowed = this.typeOf(r).replace(/[?!]$/, '');
				if (/^JSArray<Any\?>[?!]?$/.test(this.typeOf(r.expression)) && narrowed !== 'Any' && (this.isObjectRef(r) || ['Double', 'String', 'Bool'].includes(narrowed))) return `((${code} ?? nil) as? ${narrowed})`;
				const elem = /^JSArray<(.*)>([?!]?)$/.exec(this.typeOf(r.expression))?.[1];
				return this.typeOf(r).endsWith('?') || (!!elem && isOptional(elem)) || q ? this.marks.orNil(code) : code;
			};
		}
		if (ts.isIdentifier(e)) {
			const sym = this.resolve(e),
				d = sym?.valueDeclaration;
			const id = e;
			if (sym && (this.undefinedVars.has(sym) || (d && ts.isVariableDeclaration(d) && this.heldUndefined(d)))) return () => this.refName(id);
			if (this.states.narrowedMissing(e) && !this.optionalReads.has(e)) {
				return () => {
					this.optionalReads.set(id, false);
					try {
						return this.expr(id);
					} finally {
						this.optionalReads.delete(id);
					}
				};
			}
		}
		if (ts.isPropertyAccessExpression(e) && this.lenientOptionalMember(e)) {
			const r = e;
			return () => this.property(r);
		}
		if (ts.isPropertyAccessExpression(e) && !isWriteTarget(e) && !e.questionDotToken && !this.optionalReads.has(e)) {
			const sym = this.checker.getSymbolAtLocation(e.name);
			if (sym && this.states.shapeFieldOptional(sym) && (['String', 'Double', 'Bool'].includes(this.typeOf(e)) || this.states.unsetMember(sym.valueDeclaration ?? sym.declarations?.[0]))) {
				const r = e;
				return () => {
					this.optionalReads.set(r, false);
					try {
						return this.expr(r);
					} finally {
						this.optionalReads.delete(r);
					}
				};
			}
		}
		// `a?.b` of an untyped `a` where the chain goes on (`a?.b?.c`): the optional the chain continues from.
		if (ts.isPropertyAccessExpression(e) && e.questionDotToken && this.isAny(e.expression) && !isOptional(this.typeOf(e)) && !this.isAny(e) && !this.untypedLinks.has(e)) {
			const p = e.parent,
				r = e;
			if (ts.isPropertyAccessExpression(p) && p.expression === e && p.questionDotToken) {
				return () => {
					this.untypedLinks.add(r);
					try {
						return this.expr(r);
					} finally {
						this.untypedLinks.delete(r);
					}
				};
			}
		}
		if (ts.isPropertyAccessExpression(e) && e.questionDotToken && !this.typeOf(e.expression).endsWith('?')) {
			const target = this.mayGiveUndefined(e.expression),
				r = e;
			if (target && this.isExpando(e)) return () => `${RT.jsGetIfPresent}(${target()} as Any?, ${swiftString(r.name.text)})`;
			if (target) {
				return () => {
					// A native method's result inside the chain (`c?.ios?.colorWithAlphaComponent(1)?.CGColor`): Swift continues past a non-optional one with `.`.
					const link = ts.isCallExpression(r.expression) && ts.isOptionalChain(r.expression) ? this.native.methodReturns(r.expression) : null;
					const dot = link && !/[?!]$/.test(link) ? '.' : '?.';
					const code = target();
					return this.native.chainedProperty(r, code, dot) ?? this.marks.memberOf(code, dot, ident(r.name.text));
				};
			}
		}
		// `this[side + 'Drawer']`: a member by computed key, missing when the object has none.
		let access: ts.Expression = e;
		while (ts.isParenthesizedExpression(access) || ts.isAsExpression(access)) access = access.expression;
		if (ts.isElementAccessExpression(access) && !isWriteTarget(access) && !ts.isStringLiteral(access.argumentExpression) && this.isObjectRef(access.expression) && !symbolField(this, access)) {
			const t = this.typeOf(e),
				a = access;
			const base = this.typeOf(access.expression).replace(/\?$/, '');
			if (!t.endsWith('?') && !isUntyped(spelledType(t)) && this.isObjectRef(e) && !/^JS(Array|Record|Match)/.test(base) && !base.startsWith('(') && base !== 'String') {
				return () => `(${this.expr(a.expression)}${a.questionDotToken ? '?' : ''}[jsKey: ${this.propertyKey(a.argumentExpression)}] as? ${t})`;
			}
		}
		// `ref.get()`: undefined once the object is gone, though core's typings say `T`.
		if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && ['get', 'deref'].includes(e.expression.name.text) && isKit(spelledType(this.typeOf(e.expression.expression).replace(/\?$/, '')), 'JSWeakRef') && !this.typeOf(e).endsWith('?')) {
			const r = e;
			return () => this.expr(r);
		}
		// `a && a.get()` where `a` may be missing: undefined then, whatever the right side's type.
		if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
			const t = this.typeOf(e),
				lt = this.typeOf(e.left),
				b = e;
			// An object operand is falsy only when missing.
			if (!t.endsWith('?') && t !== 'Bool' && lt !== t && lt !== optionalType(t) && !isUntyped(spelledType(lt)) && (lt.endsWith('?') || this.isObjectRef(e.left))) {
				return () => {
					const v = this.fresh('__v');
					const lt0 = this.tryPrefix(b.left),
						rt0 = this.tryPrefix(b.right);
					// Both operands may be missing (`this.page && this.page.frame` of a view in no page): each is read as the optional it is.
					const left = ts.skipOuterExpressions(b.left, ts.OuterExpressionKinds.Parentheses);
					const member = ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left);
					if (member) this.optionalReads.set(left, false);
					let leftCode: string;
					const loose = ts.isIdentifier(left) || this.assertedUntyped(left) ? this.maybeUndefined(left) : null;
					try {
						leftCode = loose ?? this.expr(b.left);
					} finally {
						if (member) this.optionalReads.delete(left);
					}
					return `({ () ${lt0 || rt0 ? 'throws ' : ''}-> ${optionalType(t)} in let ${v} = ${this.marks.tryBefore(lt0, leftCode)}; return ${RT.jsTruthy}(${v}) ? ${rt0}${this.maybeUndefined(b.right) ?? this.coerce(b.right, optionalType(t))} : nil }())`;
				};
			}
		}
		return null;
	},

	/** `e`'s code with the optional a call may give kept as it is. */
	rawRead(this: Translator, e: ts.Expression): string {
		this.rawOptional.add(e);
		try {
			return this.expr(e);
		} finally {
			this.rawOptional.delete(e);
		}
	},

	/**
	 * `a?.b` continuing a chain where Swift holds `b` present, as its declaration types it: `?.` after it does not compile.
	 * A read the translation wraps (`jsArrayOrNil(a?.b, …)`) ends Swift's chain, and its result is optional.
	 */
	presentLink(this: Translator, x: ts.Expression): boolean {
		if (this.library || !ts.isPropertyAccessExpression(x) || !ts.isOptionalChain(x)) return false;
		return !this.states.heldOptional(x) && openSwiftChain(this.expr(x));
	},

	/** Whether `x?.m()` calls through an optional: as a chain's link or head reads `x`, which Swift may hold present. */
	optionalCallHead(this: Translator, x: ts.Expression): boolean {
		const t = this.typeOf(x);
		if (this.library || ts.isCallExpression(x)) return /[?!]$/.test(t) || (ts.isOptionalChain(x) && !this.presentChainCall(x));
		if (ts.isOptionalChain(x)) return ts.isPropertyAccessExpression(x) ? !this.presentLink(x) : /[?!]$/.test(t);
		return !this.presentHead(x);
	},

	/** A call in a chain (`s.split(',')?.sort()`) Swift holds present: where TypeScript types it so. */
	presentChainCall(this: Translator, x: ts.Expression): boolean {
		if (this.library || !ts.isCallExpression(x) || /[?!]$/.test(this.typeOf(x)) || this.isAny(x)) return false;
		return openSwiftChain(this.expr(x)) || !this.states.heldOptional(x);
	},

	/** A chain's head (`this.items?.[0]`) Swift holds present. */
	presentHead(this: Translator, x: ts.Expression): boolean {
		if (this.library || ts.isOptionalChain(x) || ts.isCallExpression(x)) return false;
		return !/[?!]$/.test(this.typeOf(x)) && !this.states.heldOptional(x) && !this.implicitChain(x);
	},

	/** An optional chain's end Swift holds optional though TypeScript types it present (`items?.getItems()` of lenient code). */
	implicitChain(this: Translator, target: ts.Expression): boolean {
		if (!this.lenient) return false;
		const code = this.expr(target);
		return this.marks.rootImplicit(code);
	},

	/** `jsImplicit(code)` of an optional value of `type`: a function's through its cell's own, which keeps its identity. */
	implicit(this: Translator, code: string, type: string): string {
		const fn = type.replace(/^\((.*)\)[?!]$/, '$1');
		const cell = isFunctionType(fn) ? this.functionCell(fn) : null;
		return cell ? this.marks.implicitOf(code, cell) : this.marks.implicitOf(code);
	},

	/**
	 * An undefined-or-value as the TypeScript type reads it: NaN, "undefined" and false are what undefined converts to.
	 * `from`, where known, is the Swift type `code` has: no cast is written to the class it already is.
	 */
	undefinedAs(this: Translator, code: string, type: string, from?: string): string {
		const m = this.marks.markOf(code);
		if (isOptional(type)) return m?.op === 'undefinedAs' && m.to.optional ? code : this.undefinedRead(code, 'nil', type);
		// A value read with an unwrap (`x.index(of: y)!`) is undefined where it is missing, as the default reads it.
		if (['Double', 'String', 'Bool'].includes(type) && m?.op === 'unwrap') code = m.of.code;
		if (type === 'Double') return this.undefinedRead(code, '.nan', type);
		if (type === 'String') return this.undefinedRead(code, '"undefined"', type);
		if (type === 'Bool') return this.undefinedRead(code, 'false', type);
		// Lenient code: undefined read as the object type wanted, which may be a subclass of the value's.
		if (this.lenient && this.marks.castTo(code, type, true)) return code;
		const same = (from !== undefined && sameClass(from, type)) || this.marks.alreadyAs(code, type);
		if (this.lenient) heldLoss('undefinedAs', 'implicit');
		return this.lenient ? (/^[A-Z][\w.]*$/.test(type) && !this.native.isStructType(type) && !same ? this.marks.castCode(code, type, 'as?', true) : this.implicit(code, type)) : this.marks.unwrappedCode(code);
	},

	/** `(code ?? zero)`: undefined read as `type` reads it. */
	undefinedRead(this: Translator, code: string, zero: string, type: string): string {
		if (zero !== 'nil') heldLoss('undefinedAs', zero);
		return this.marks.leading(this.marks.marked(`(${code} ?? ${zero})`, { op: 'undefinedAs', to: parseNativeType(type), of: this.marks.valueOf(code) }), code);
	},

	/**
	 * A string, number or boolean read `e` of type `t` as the optional it holds, where it converts undefined (a read, or
	 * a choice one of whose branches does); null where it converts nothing.
	 */
	convertedOptional(this: Translator, e: ts.Expression, t: string): string | null {
		if (this.library) return null;
		const inner = ts.skipOuterExpressions(e);
		if (ts.isConditionalExpression(inner) && this.typeOf(inner) === t && [inner.whenTrue, inner.whenFalse].some((x) => this.undefinedConverted(this.coerce(ts.skipOuterExpressions(x, ts.OuterExpressionKinds.Parentheses), t)))) return this.coerce(inner, optionalType(t));
		return this.undefinedConverted(this.expr(ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses)));
	},

	/**
	 * App and plugin code's string, number or boolean read that converts undefined (`(x ?? "undefined")`): the optional it
	 * converts, for a use that takes undefined as it is (a comparison). Null for any other code.
	 */
	undefinedConverted(this: Translator, code: string): string | null {
		const m = this.marks.markOf(code);
		return !this.library && m?.op === 'undefinedAs' && !m.to.optional && ['String', 'Double', 'Bool'].includes(m.to.name) ? m.of.code : null;
	},

	/** A callee Swift holds as a closure: a field, variable or parameter of a function type (`on: Events['on']`), not a function or method. */
	isClosureValue(this: Translator, callee: ts.Expression): boolean {
		const name = ts.isPropertyAccessExpression(callee) ? callee.name : ts.isIdentifier(callee) ? callee : null;
		const d = name && this.resolve(name)?.valueDeclaration;
		// A program interface's or shape's method is a function field or a protocol requirement: neither has defaults.
		return !!d && !d.getSourceFile().isDeclarationFile && (ts.isPropertyDeclaration(d) || ts.isPropertySignature(d) || ts.isVariableDeclaration(d) || ts.isParameter(d) || ts.isMethodSignature(d));
	},
};
