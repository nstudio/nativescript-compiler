// Expressions as Swift: dispatch, identifiers, top-level names, narrowing.
import ts from 'typescript';
import { propertyKeyCode, templateSubstitution } from '../semantics/apis/operators.ts';
import { awaitedCell, conditionCell, nullishField, type ConditionCell } from '../semantics/placement.ts';
import { assignmentValue, functionParts, isCompoundAssignment, isFunctionType, isNullish, isOptional, metatype, negation, numberLiteral, optionalType, postfixOnly, sameClass, swiftString, RT, lenientReader } from './syntax.ts';
import type { Translator } from './translator.ts';
import { globalProxyUse, isStringRaw, readWrite, statementLevel, substitutedExpr, templateParts, isSelf } from '../semantics/lang.ts';
import { readKeyOf } from '../semantics/nullish.ts';
import { notedField } from '../semantics/shapes.ts';
import { isWriteTarget } from '../semantics/ast.ts';
import { convertedRead } from '../semantics/states/predicates.ts';
import { isStatic } from '../semantics/throws.ts';
import { optionalContext } from '../semantics/spelled.ts';
import { isKit, isUntyped, spelledType } from '../semantics/types.ts';
import { atLossSite, HELD_LOSS } from '../semantics/losses.ts';

export const expressionsMethods = {
	/** Whether one class the program declares extends another, by their Swift names. */
	isSubclassOf(this: Translator, sub: string, base: string): boolean {
		if (sub === base || !/^[A-Za-z_][\w.]*$/.test(sub) || !/^[A-Za-z_][\w.]*$/.test(base)) return false;
		for (let c = this.classNamed(sub); c; c = this.sourceBase(c)) if (this.className(c) === base && c !== this.classNamed(sub)) return true;
		return false;
	},
	/** The program's class Swift names `name`. */
	classNamed(this: Translator, name: string): ts.ClassLikeDeclaration | undefined {
		if (!this.classesByName) {
			this.classesByName = new Map();
			for (const sf of this.sourceFiles) {
				if (sf.isDeclarationFile) continue;
				const visit = (n: ts.Node) => {
					if (ts.isClassDeclaration(n) && n.name) this.classesByName!.set(this.className(n), n);
					ts.forEachChild(n, visit);
				};
				visit(sf);
			}
		}
		return this.classesByName.get(name);
	},

	/** A condition: Swift needs a Bool where JavaScript tests truthiness. */
	cond(this: Translator, e: ts.Expression, cell?: ConditionCell): string {
		const sub = substitutedExpr(this.subst, e);
		if (sub) return this.typeOf(sub.bare) === 'Bool' ? sub.code : `${RT.jsTruthy}(${this.marks.isUnwrap(sub.code) ? this.marks.unwrapInner(sub.code)! : sub.code})`;
		if (cell === undefined) cell = conditionCell(this.conditions, e);
		const code = this.truthy(cell);
		// A closure called in place (`{ () -> Bool in … }()`) would be read as an `if`'s or `while`'s body.
		return code.startsWith('{') ? `(${code})` : code;
	},

	truthy(this: Translator, c: ConditionCell): string {
		switch (c.step) {
			case 'fixed':
				return String(c.value);
			case 'logical': {
				const op = c.e.operatorToken.getText(),
					l = this.cond(c.e.left),
					r = this.cond(c.e.right);
				// A side that cannot change the outcome (`true && x`): the other alone, as both are tested without side effects.
				const unit = op === '&&' ? 'true' : op === '||' ? 'false' : null;
				const only = unit === l ? r : unit === r ? l : null;
				if (only !== null) return postfixOnly(only) ? only : `(${only})`;
				return `(${l} ${op} ${r})`;
			}
			case 'not':
				return negation(this.cond(c.e));
			case 'missing':
				return `${RT.jsTruthy}(${c.code} as Any?)`;
			case 'bool':
				return this.expr(c.e);
		}
		const e = c.e;
		// A member of an untyped value is tested as read, before any conversion to its declared type (`!!descriptor.set`).
		if ((ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) && !e.questionDotToken && this.isAny(e.expression) && !this.isAny(e) && !this.plainHelper(e)) {
			return `${RT.jsTruthy}(${RT.jsGet}(${this.expr(e.expression)}, ${ts.isPropertyAccessExpression(e) ? swiftString(e.name.text) : this.propertyKey(e.argumentExpression)}))`;
		}
		const code = this.expr(e);
		// An object read with an unwrap (`this.page!`) tests whether it is there.
		if (this.marks.isUnwrap(code) && this.isObjectRef(e)) return `${RT.jsTruthy}(${this.marks.unwrapInner(code)!} as Any?)`;
		return this.heldTruthy(e, code) ?? `${RT.jsTruthy}(${code})`;
	},

	expr(this: Translator, e: ts.Expression): string {
		return HELD_LOSS ? atLossSite('swift', this, e, () => this.exprBody(e)) : this.exprBody(e);
	},

	exprBody(this: Translator, e: ts.Expression): string {
		this.refuseScopedExpr(e);
		if (this.heldParts.has(e)) return this.subst.get(e)!;
		if (globalProxyUse(e, this.checker)) throw this.limit(e, 'proxy', '`Proxy`');
		const narrowed = this.narrowedHeld(e);
		if (narrowed) {
			this.rawHeld.add(e);
			try {
				const raw = this.expr(e);
				return this.checkedConvert(raw, narrowed, e) ?? this.marks.ownTried(`${RT.jsCastPresent}(${raw}, ${this.type(narrowed.type, e)}.self)`);
			} finally {
				this.rawHeld.delete(e);
			}
		}
		if (ts.isCallExpression(e) && !this.nullishCalls.has(e) && !this.subst.has(e) && this.states.nullishRead(e)) return `${this.nullishCode(e)}${this.lenientApp ? '.jsAny' : '.optional'}`;
		if (nullishField(this, e) && !this.nullishCalls.has(e) && !this.subst.has(e)) {
			const use = this.states.nullishFieldUse(e);
			const m = use === 'member' && this.states.nullishMemberKey(e);
			return m ? this.marks.ownTried(`${this.nullishCode(e)}.present(${m.set ? 'setting: ' : ''}${swiftString(m.key)})`) : `${this.nullishCode(e)}${use === 'converted' ? '.jsAny' : '.optional'}`;
		}
		if (!this.nullishReceivers.has(e) && this.states.nullishElementReceiver(e)) {
			this.nullishReceivers.add(e);
			try {
				return `${this.expr(e)}.optional`;
			} finally {
				this.nullishReceivers.delete(e);
			}
		}
		const code = this.exprOf(e);
		if ((this.functionDepth === 0 || this.inStoredInit) && this.isDeclaredFunctionValue(e) && this.marks.isPath(code)) this.isolatedInit = true;
		// A forced cast's value (`(x as! T)`, a narrowed read) is present: nothing is left to check.
		if (this.marks.presentCast(code)) return code;
		const key = this.looseReceiverKey(e);
		if (key !== null) return this.chainingLoose ? this.marks.marked(`${RT.jsImplicit}(${code})?`, { op: 'implicit', of: this.marks.valueOf(code), chained: true }) : this.marks.helper('jsUnwrap', this.marks.unwrapInner(code) ?? code, this.assigned(e.parent as ts.Expression) ? `, setting: ${swiftString(key)}` : `, ${swiftString(key)}`);
		if (this.chainingLoose || (assignmentValue(e) && this.lenient) || !this.loose(e) || this.looseTolerated(e)) return code;
		return this.required(e, this.marks.unwrapInner(code) ?? code);
	},

	exprOf(this: Translator, e: ts.Expression): string {
		const awaited = this.awaitSlots.get(e),
			key = awaited ? readKeyOf(e) : null;
		if (awaited && key !== null) return this.receiverCode(awaitedCell(awaited), key)!;
		const s = this.subst.get(e);
		if (s) return s;
		const rw = readWrite(e, this.checker);
		if (rw && ((rw.value && !rw.stored) || rw.held.length) && !rw.held.some((h) => this.subst.has(h))) return this.readWriteCode(e, rw);
		if (ts.isParenthesizedExpression(e) && ts.isBinaryExpression(e.expression) && e.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(e.expression.left)) {
			// `(match = re.exec(s)) !== null`: the assignment's value is the variable after it (Swift's assignment has none).
			const a = e.expression;
			// Lenient code holds an object variable implicitly unwrapped, which `(x = null)` leaves nil; `(x = new C())` never.
			const declared = this.declaredTypeOf(a.left) ?? this.typeOf(a.left);
			const t = this.lenientRef(declared) !== declared ? optionalType(declared) : declared;
			const exprType = this.typeOf(a);
			const rt = isUntyped(spelledType(t)) && !isUntyped(spelledType(exprType)) && exprType !== 'Void' ? exprType : t;
			const retType = this.lenientRef(rt) !== rt ? optionalType(rt) : rt;
			const tp = this.tryPrefix(a);
			const retVal = rt !== t ? this.fromAnyCode(this.expr(a.left), rt, true) : this.expr(a.left);
			const retThrows = tp || /\btry\b/.test(retVal);
			return `({ () ${retThrows ? 'throws ' : ''}-> ${retType} in ${tp}${this.binary(a)}; return ${retVal} }())`;
		}
		if (ts.isParenthesizedExpression(e)) {
			const inner = this.expr(e.expression);
			return postfixOnly(inner) ? inner : this.marks.leading(`(${inner})`, inner);
		}
		// `(info.name = v)` as a value: the value assigned, evaluated once (Swift's assignment has none).
		if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken && !statementLevel(e) && !ts.isArrayLiteralExpression(e.left) && !this.subst.has(e.right)) {
			const stored = this.storedLiteralType(e);
			const outerTarget = isNullish(e.right) && ts.isBinaryExpression(e.parent) && e.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && e.parent.right === e ? (this.declaredTypeOf(e.parent.left) ?? this.typeOf(e.parent.left)) : null;
			const t = stored ?? (outerTarget && isOptional(outerTarget) ? outerTarget : this.typeOf(e.right) === 'Void' ? 'Any?' : this.typeOf(e.right));
			const v = this.fresh('__assigned');
			const tp = this.tryPrefix(e);
			const value = `${this.marks.tryBefore(this.tryPrefix(e.right), this.stored(e.right, e.left, t))}`;
			this.subst.set(e.right, v);
			if (stored) this.storedLiterals.set(e.right, { code: v, type: t });
			try {
				return `({ () ${tp ? 'throws ' : ''}-> ${t} in let ${v}: ${t} = ${value}; ${tp}${this.assignment(e)}; return ${v} }())`;
			} finally {
				this.subst.delete(e.right);
				this.storedLiterals.delete(e.right);
			}
		}
		// `return (s += x)`: a compound assignment's value is its target after it (Swift's assignment has none).
		if (ts.isBinaryExpression(e) && isCompoundAssignment(e.operatorToken.kind) && !statementLevel(e)) {
			const declared = this.declaredTypeOf(e.left) ?? this.typeOf(e.left);
			// `x ??= v` is never nullish after it.
			const assigned = e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken && !isUntyped(spelledType(declared)) && /\?$/.test(declared);
			const t = assigned ? declared.slice(0, -1) : declared;
			const tp = this.tryPrefix(e);
			// A member by key (`scope[SLOT] ??= new Map()`) reads back untyped: as the target's type.
			const target = this.expr(e.left);
			// A record's entry reads back optional, though TypeScript types it as the value.
			const entry = ts.isElementAccessExpression(e.left) && isKit(spelledType(this.typeOf(e.left.expression).replace(/\?$/, '')), 'JSRecord') && !isUntyped(spelledType(t)) && !isOptional(t);
			const read = /\[jsKey: [^\]]+\]$/.test(target) && !isUntyped(spelledType(t)) ? this.fromAnyCode(target, t, true) : assigned || entry ? this.marks.unwrappedCode(target) : target;
			const write = this.binary(e);
			return `({ () ${tp ? 'throws ' : ''}-> ${t} in ${this.marks.markOf(write)?.op === 'block' ? write : tp + write}; return ${this.tryPrefix(e.left)}${read} }())`;
		}
		if (ts.isNumericLiteral(e)) return this.marks.pureCode(numberLiteral(e.text));
		if (ts.isBigIntLiteral(e)) return `JSBigInt(literal: ${swiftString(e.text.replace(/n$/, ''))})`;
		if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return swiftString(this.wellFormed(e, e.text));
		if (e.kind === ts.SyntaxKind.TrueKeyword) return 'true';
		if (e.kind === ts.SyntaxKind.FalseKeyword) return 'false';
		if (e.kind === ts.SyntaxKind.NullKeyword) return this.isAny(e) && !optionalContext(this, e) ? 'jsNull' : 'nil';
		if (e.kind === ts.SyntaxKind.ThisKeyword) {
			// App mode: a function expression's own `this`, which no receiver binds where Swift calls it as a closure: undefined, as a module's plain call gives it.
			const owner = ts.findAncestor(e.parent, (n) => ts.isFunctionLike(n) && !ts.isArrowFunction(n));
			if (!this.library && owner && ts.isFunctionExpression(owner) && !ts.isPropertyAssignment(owner.parent) && this.isAny(e)) return 'nil';
			this.refuseStoredThis(e);
			return 'self';
		}
		if (e.kind === ts.SyntaxKind.SuperKeyword) return 'super';
		if (ts.isIdentifier(e)) {
			if (this.states.nullishRead(e)) {
				if (isWriteTarget(e)) throw this.error(e, 'a compound assignment to a slot that may be null or undefined both');
				if (this.lenientApp) return `${this.refName(e)}.jsAny`;
				return this.narrowed(e, `${this.refName(e)}.optional`);
			}
			return this.moduleValue(e) ?? this.identifier(e);
		}
		if (ts.isTemplateExpression(e)) {
			[e.head, ...e.templateSpans.map((span) => span.literal)].forEach((part) => this.wellFormed(e, part.text));
			const pieces = e.templateSpans.map((span) => templateSubstitution(this, span));
			// A string literal's interpolation is one line in Swift: a piece of statements (a closure), which a formatter may lay
			// out on lines of their own, joins the literal's parts instead.
			if (pieces.some((p) => p.includes('\n') || p.includes(';'))) {
				const parts = [`"${this.escapeInterpolated(e.head.text)}"`];
				e.templateSpans.forEach((span, k) => parts.push(`(${pieces[k]})`, `"${this.escapeInterpolated(span.literal.text)}"`));
				return `[${parts.join(', ')}].joined()`;
			}
			let out = this.escapeInterpolated(e.head.text);
			e.templateSpans.forEach((span, k) => {
				out += `\\(${pieces[k]})` + this.escapeInterpolated(span.literal.text);
			});
			return `"${out}"`;
		}
		if (ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e)) {
			const from = this.typeOf(e.expression);
			const to = this.typeOf(e);
			if (from === 'Double' && this.native.isEnumType(to)) return this.native.toSwift(e.expression, to);
			if (to === 'Never') return this.expr(e.expression);
			const entry = this.checkedAssertion(e);
			if (entry) return this.checkedConvert(this.expr(e.expression), entry, e)!;
			const iterable = this.assertedIterable(e);
			if (iterable) return iterable;
			// The assertion is erased in JavaScript: where Swift needs the type, the value is converted as script converts it there.
			if (!this.library && isUntyped(spelledType(from)) && ['String', 'Double', 'Bool'].includes(to)) return `${lenientReader(to)}(${this.expr(e.expression)})`;
			if (isUntyped(spelledType(from)) && !isUntyped(spelledType(to)) && /^\w+\?$/.test(to) && this.checkedClassAssertion(e)) return this.marks.ownTried(`${RT.jsCast}(${this.expr(e.expression)}, ${to.slice(0, -1)}.self)`);
			if (isUntyped(spelledType(from)) && !isUntyped(spelledType(to))) {
				const code = this.expr(e.expression);
				return this.throwingConverts(() => this.fromAnyChecked(code, to, this.castThrows(e.expression)).code, this.libraryThrowsHere(e), e.expression);
			}
			// `x as string` of a string that may be undefined: the value as JavaScript then reads it as one.
			if (['String', 'Double', 'Bool'].includes(to) && from === `${to}?`) return this.undefinedAs(this.expr(e.expression), to);
			// A typed function asserted to `any` (`<any>callback`): a script function, which any caller can call.
			if (isUntyped(spelledType(to)) && isFunctionType(from.replace(/^\((.*)\)[?!]$/, '$1'))) return this.convert(this.expr(e.expression), from, 'Any?');
			if (isUntyped(spelledType(to))) {
				const raw = this.untypedMemberValue(e.expression);
				if (raw) return raw;
				const maybe = this.maybeUndefined(e.expression);
				if (maybe) return this.marks.leading(`(${maybe} as Any?)`, maybe);
			}
			// `<Array<View>>views` of a ViewBase[]: Swift's arrays of the two are distinct types, so the elements are read as the asserted one, in a copy unless the array already is one.
			const fromArray = /^JSArray<(.+)>[?!]?$/.exec(from),
				toArray = /^JSArray<(.+)>[?!]?$/.exec(to);
			if (fromArray && toArray && fromArray[1] !== toArray[1] && !isUntyped(spelledType(toArray[1]))) {
				const copy = this.arrayOf(this.expr(e.expression), toArray[1]);
				return this.marks.leading(`(${copy} as JSArray<${toArray[1]}>)`, copy);
			}
			if (from !== to && from.replace(/[?!]$/, '') !== to.replace(/[?!]$/, '') && this.isObjectRef(e) && this.isObjectRef(e.expression)) {
				// An object of another shape asserted to an interface (`cur as ICalEvent`): the interface's class read from it.
				const target = this.checker.getTypeAtLocation(e).getSymbol();
				const shaped = !!target && !!(target.flags & ts.SymbolFlags.Interface) && !(target.flags & ts.SymbolFlags.Class) && !to.endsWith('?') && /^[A-Z]\w*$/.test(to) && !target.declarations?.some((d) => d.getSourceFile().isDeclarationFile);
				if (shaped) {
					// An object Swift holds as another literal's or interface's final class is never one of `to`'s.
					const held = this.heldSpelling(e.expression).replace(/[?!]$/, '');
					if (held !== to && held === from.replace(/[?!]$/, '') && this.isObjectShape(held)) return this.viewOf(to, this.expr(e.expression));
					return `{ (__o: Any?) -> ${to} in (__o as? ${to}) ?? ${this.viewOf(to, '__o')} }(${this.expr(e.expression)})`;
				}
				// Lenient code: an assertion of undefined (`getWindowById(id) as IOSNativeWindow`) is undefined.
				if (this.lenient && this.lenientRef(to) !== to) {
					const made = this.madeClass(e.expression);
					if (sameClass(this.typeOf(e.expression), to) || (made && sameClass(made, to))) return this.implicit(this.expr(e.expression), to);
					// An object of a subclass: an upcast, which cannot fail.
					if (this.extendsNamed(this.checker.getTypeAtLocation(e.expression), to)) return this.marks.castCode(this.expr(e.expression), to, 'as', true);
					return this.marks.castCode(this.expr(e.expression), to, 'as?', true);
				}
				// `args.object as Button` of another class: a TypeError, catchable as script's failure on a member it lacks would be.
				const made = this.madeClass(e.expression);
				if (made && sameClass(made, to)) return this.expr(e.expression);
				if (isOptional(to)) return this.marks.castCode(this.expr(e.expression), to.slice(0, -1), 'as?');
				return this.castThrows(e) ? this.marks.ownTried(`${RT.jsChecked}(${this.expr(e.expression)}, ${metatype(to)})`) : this.marks.castCode(this.expr(e.expression), to, 'as!');
			}
			// A non-strict app's assertion of a value that may be missing (`<UITableViewCell>table.cellForRow(…)`): unwrapped where used.
			if (this.lenientApp && from === optionalType(to) && !isUntyped(spelledType(to)) && !isFunctionType(to)) return this.marks.unwrappedCode(this.expr(e.expression));
			const fnOf = (t: string) => t.replace(/^\((.*)\)[?!]$/, '$1');
			if (from !== to && isFunctionType(fnOf(from)) && isFunctionType(fnOf(to))) return this.convert(this.expr(e.expression), from, to);
			return this.expr(e.expression);
		}
		// `f<T>`: the function, its type arguments only TypeScript's.
		if (ts.isExpressionWithTypeArguments(e)) return this.expr(e.expression);
		if (ts.isNonNullExpression(e)) {
			const inner = this.expr(e.expression);
			const key = this.assertedReceiverKey(e);
			if (key !== null) return this.assigned(e.parent as ts.Expression) ? `${RT.jsUnwrap}(${inner}, setting: ${swiftString(key)})` : `${RT.jsUnwrap}(${inner}, ${swiftString(key)})`;
			if (this.lenient && this.lenientRef(this.typeOf(e)) !== this.typeOf(e)) return this.marks.implicitOf(inner);
			const t = this.typeOf(e);
			// `!` asserts nothing at run time: a missing string, number or boolean converts as JavaScript converts undefined.
			if (!this.library && ['String', 'Double', 'Bool'].includes(t) && this.typeOf(e.expression) === optionalType(t) && convertedRead(e)) return this.undefinedAs(inner, t, optionalType(t));
			return this.typeOf(e.expression).endsWith('?') && !this.isAny(e.expression) && inner !== 'nil' ? this.marks.unwrappedCode(inner) : inner;
		}
		if (ts.isPropertyAccessExpression(e)) {
			if (this.functionObjectOf(e)) return this.propertyRead(e);
			const member = this.namespaceMember(e);
			const decl = member ? this.resolve(e.name)?.valueDeclaration : undefined;
			if (member && !(ts.isPropertyAccessExpression(e.parent) && e.parent.expression === e) && (this.isNamespace(e) || (decl && ts.isClassDeclaration(decl)))) return `${member}.self`;
			if (!member && this.lenientOptionalMember(e) && convertedRead(e)) return this.undefinedAs(this.property(e), this.typeOf(e), optionalType(this.typeOf(e)));
			return member ? this.narrowed(e, member) : this.property(e);
		}
		if (ts.isElementAccessExpression(e)) return this.elementAccess(e);
		if (ts.isCallExpression(e)) {
			const p = ts.walkUpParenthesizedExpressions(e.parent);
			if (this.lenientApp && !ts.isAwaitExpression(p) && !ts.isExpressionStatement(p) && !this.states.returnedAsIs(e) && this.states.lenientAsyncCall(e)) throw this.error(e, 'the promise of a non-strict async function that may give null or undefined, used other than by `await`,');
			return this.undefinedResult(e, this.erasedResult(e, this.call(e)));
		}
		if (ts.isNewExpression(e)) return this.newExpr(e);
		if (ts.isBinaryExpression(e)) return this.binary(e);
		if (ts.isPrefixUnaryExpression(e)) return this.prefix(e);
		if (ts.isPostfixUnaryExpression(e)) {
			const member = this.untypedMember(e.operand);
			if (member) return `${RT.jsPostUpdate}(${member.object}, ${member.key}, ${e.operator === ts.SyntaxKind.PlusPlusToken ? '1' : '-1'})`;
			if (ts.isIdentifier(e.operand)) {
				const top = this.resolve(e.operand)?.valueDeclaration;
				if (top && ts.isVariableDeclaration(top) && this.facts.tdzBindings().has(top) && !(top.parent.flags & ts.NodeFlags.Const)) {
					const raw = (this.globalAlias(e.operand) ?? this.refName(e.operand)).replace(/`/g, '');
					const step = e.operator === ts.SyntaxKind.PlusPlusToken ? '+' : '-';
					return this.marks.ownTried(`{ () throws -> Double in let __old = try __tdz_get_${raw}(); try __tdz_set_${raw}(__old ${step} 1); return __old }()`);
				}
			}
			const held = this.optionalNumberUpdate(e);
			if (held) return held;
			const fn = e.operator === ts.SyntaxKind.PlusPlusToken ? RT.jsPostIncrement : RT.jsPostDecrement;
			return `${fn}(&${this.lvalue(e.operand)})`;
		}
		if (ts.isConditionalExpression(e)) {
			let t = this.typeOf(e);
			// Lenient code choosing an object or null: an optional, as the variable holding it is.
			if (this.lenient && [e.whenTrue, e.whenFalse].some(isNullish) && !['String', 'Double', 'Bool'].includes(t) && !isFunctionType(t) && !isUntyped(spelledType(t)) && !t.endsWith('!') && !this.native.isStructType(t)) t = optionalType(t);
			// A choice of objects returned or stored where Swift holds it optional: each branch as it is held.
			else if (!this.lenient && this.optionalChoice(e) && !isOptional(t) && !t.endsWith('!') && !isFunctionType(t) && this.isObjectRef(e) && !this.native.isStructType(t)) t = optionalType(t);
			// A function literal choosing against another function takes every parameter the chosen type passes (`c ? tracker(uri) : () => {}`).
			const chosen = functionParts(t.replace(/^\((.*)\)[?!]$/, '$1'));
			for (const x of chosen ? [e.whenTrue, e.whenFalse].map((b) => ts.skipOuterExpressions(b, ts.OuterExpressionKinds.Parentheses)) : []) {
				if ((ts.isArrowFunction(x) || ts.isFunctionExpression(x)) && x.parameters.length < chosen!.params.length && !this.closureSlots.has(x)) this.closureSlots.set(x, chosen!.params);
			}
			// Branches of different types are untyped values alike.
			const plain = (x: ts.Expression) => (isUntyped(spelledType(t)) && !['Any?', 'Void'].includes(this.typeOf(x)) && x.kind !== ts.SyntaxKind.NullKeyword ? this.marks.castCode(this.coerce(x, t), 'Any', 'as') : this.coerce(x, t));
			// A branch using an API newer than the deployment target (`supported ? UIGlassEffect.effectWithStyle(s) : UIVisualEffect.new()`) is
			// checked on its own, so the condition core tests the OS with still chooses; on an older OS it is the TypeError script meets there.
			const branch = (x: ts.Expression) => {
				if (!this.availability.length || this.asyncCtx) return plain(x);
				this.availability.push(0);
				let code: string, needs: number;
				try {
					code = plain(x);
				} finally {
					needs = this.availability.pop()!;
				}
				if (!needs) return code;
				const throws = !!this.tryPrefix(x);
				const otherwise = throws ? `throw JSException(${RT.jsUnavailable}(${needs}))` : `${RT.jsReportUncaught}(${RT.jsUnavailable}(${needs}).value); return ${this.undefinedValue(t) ?? `${RT.jsNativeZero}(${metatype(t)})`}`;
				return `${throws ? '(try ' : ''}{ () ${throws ? 'throws ' : ''}-> ${t} in if #available(iOS ${needs}, *) { return ${this.marks.tryBefore(this.tryPrefix(x), code)} } else { ${otherwise} } }()${throws ? ')' : ''}`;
			};
			return this.ternary(e, t, branch);
		}
		if (ts.isArrayLiteralExpression(e)) return this.array(e);
		if (ts.isObjectLiteralExpression(e)) return this.object(e);
		if (ts.isTaggedTemplateExpression(e)) return this.taggedTemplate(e);
		if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return this.closure(e);
		// A class whose instances are plain objects of any keys (`class { [key: string]: string }`), held as a value.
		if (ts.isClassExpression(e) && this.library && !e.heritageClauses?.length && e.members.every(ts.isIndexSignatureDeclaration)) return 'JSConstructor { _ in JSObject() }';
		if (ts.isTypeOfExpression(e)) return this.typeofExpr(e);
		if (ts.isAwaitExpression(e)) throw this.error(e, 'await outside a statement of an async function');
		if (ts.isDeleteExpression(e)) {
			const target = e.expression;
			if (ts.isElementAccessExpression(target) && isKit(spelledType(this.typeOf(target.expression)), 'JSRecord')) return `${this.expr(target.expression)}.delete(${this.str(target.argumentExpression)})`;
			if (ts.isPropertyAccessExpression(target) && isKit(spelledType(this.typeOf(target.expression)), 'JSRecord')) return `${this.expr(target.expression)}.delete(${swiftString(target.name.text)})`;
			if (ts.isPropertyAccessExpression(target) && this.isAny(target.expression)) return `${RT.jsDelete}(${this.expr(target.expression)}, ${swiftString(target.name.text)})`;
			if (ts.isElementAccessExpression(target) && this.isAny(target.expression)) return `${RT.jsDelete}(${this.expr(target.expression)}, ${this.propertyKey(target.argumentExpression)})`;
			// A field of a program class that Swift holds as optional: nil is no key of the object (jsKeys, `in`), as a deleted property is none.
			if (ts.isPropertyAccessExpression(target) && !(isSelf(target.expression, this.subst) && this.props.has(target.name.text))) {
				const decl = this.checker.getSymbolAtLocation(target.name)?.valueDeclaration;
				const field = decl && ts.isPropertyDeclaration(decl) && ts.isClassLike(decl.parent) && !decl.getSourceFile().isDeclarationFile && !isStatic(decl) ? this.declaredTypeOf(target) : null;
				if (field?.endsWith('?') && ts.isClassLike(decl!.parent) && this.keyPlan(decl!.parent)?.flagged.has(target.name.text)) {
					if (!ts.isIdentifier(target.expression) && target.expression.kind !== ts.SyntaxKind.ThisKeyword && !this.pure(target.expression)) throw this.error(e, 'delete of a field of an object this expression makes', 'delete-member');
					const o = this.expr(target.expression);
					return `{ () -> Bool in if ${o}.__has_${target.name.text} { ${this.lvalue(target)} = nil; ${o}.__has_${target.name.text} = false }; return true }()`;
				}
				if (field?.endsWith('?')) return `{ () -> Bool in ${this.lvalue(target)} = nil; return true }()`;
			}
			// Library mode: what script added to an instance of a compiled class, or to an object used as a map.
			if (this.quietDelete(e) && ts.isElementAccessExpression(target)) return `((try? ${RT.jsDelete}(${this.expr(target.expression)}, ${this.propertyKey(target.argumentExpression)})) ?? false)`;
			if (this.quietDelete(e) && ts.isPropertyAccessExpression(target)) return `((try? ${RT.jsDelete}(${this.expr(target.expression)}, ${swiftString(target.name.text)})) ?? false)`;
			throw this.error(e, 'delete of this member', 'delete-member');
		}
		if (ts.isVoidExpression(e)) return this.throwsInfo.expr(e.expression) ? `{ () throws -> Any? in _ = try ${this.expr(e.expression)}; return nil }()` : `{ _ = ${this.expr(e.expression)}; return nil as Any? }()`;
		// `import.meta` of the bundled app's module, in the app bundle.
		if (ts.isMetaProperty(e) && e.keywordToken === ts.SyntaxKind.ImportKeyword) return 'jsImportMeta';
		if (ts.isRegularExpressionLiteral(e)) {
			const text = e.text;
			const end = text.lastIndexOf('/');
			return `${RT.jsRegExpLiteral}(${swiftString(text.slice(1, end))}, ${swiftString(text.slice(end + 1))})`;
		}
		if (ts.isClassExpression(e)) return `${this.emitClassExpr(e)}.self`;
		throw this.error(e, 'expression', 'unhandled');
	},

	/** ``tag`a${x}b` ``: the tag called with the site's strings (cooked, and raw as `strings.raw`), then the values. */
	taggedTemplate(this: Translator, e: ts.TaggedTemplateExpression): string {
		const { cooked, raw, values } = templateParts(e.template);
		if (isStringRaw(e.tag, this.checker)) return `(${raw.map((r, k) => swiftString(r) + (k < values.length ? ` + ${this.str(values[k])}` : '')).join(' + ')})`;
		const site = `__template${this.templateObjects.length}`;
		this.templateSites.push(site);
		this.templateObjects.push(`let ${site} = ${RT.jsTemplateObject}([${cooked.map(swiftString).join(', ')}], raw: [${raw.map(swiftString).join(', ')}])`);
		if (this.isAny(e.tag)) {
			const call = this.marks.tryCode(`${RT.jsCall}(${[this.expr(e.tag), site, ...values.map((v) => this.coerce(v, 'Any?'))].join(', ')})`);
			const rt = this.typeOf(e);
			return isUntyped(spelledType(rt)) || rt === 'Void' ? call : this.fromAnyCode(call, rt, true);
		}
		const params = this.checker.getResolvedSignature(e)?.getParameters() ?? [];
		const restAt = params.findIndex((p) => p.valueDeclaration && ts.isParameter(p.valueDeclaration) && !!p.valueDeclaration.dotDotDotToken);
		const restType = () => this.typeOf((params[restAt].valueDeclaration as ts.ParameterDeclaration).name);
		const args = [site];
		for (let k = 0; k < values.length; k++) {
			if (restAt >= 0 && k + 1 >= restAt) {
				args.push(this.packed(values.slice(k), restType()));
				break;
			}
			const p = params[k + 1];
			args.push(p ? this.coerce(values[k], this.type(this.checker.getTypeOfSymbolAtLocation(p, e), e)) : this.expr(values[k]));
		}
		if (restAt > values.length) args.push(`${restType()}()`);
		return `${this.expr(e.tag)}(${args.join(', ')})`;
	},

	escapeInterpolated(this: Translator, text: string): string {
		return swiftString(text).slice(1, -1);
	},

	/** A property key: a symbol's own key, anything else as a string. */
	propertyKey(this: Translator, e: ts.Expression): string {
		return propertyKeyCode(this, e, () => {
			const code = this.expr(e);
			// Lenient code's symbol may be missing, which keys as "undefined".
			return this.lenient && (this.loose(e) || this.marks.rootImplicit(code)) ? `(${RT.jsImplicit}(${code})?.key ?? "undefined")` : `${code}.key`;
		});
	},

	/**
	 * An app's `a?.b` that TypeScript types present, where the value is taken as it is (converted to a string, held
	 * untyped, passed where undefined is allowed): Swift's optional, undefined where the chain stops; null for any other
	 * expression. `objects`: of any type, else only of a string, number or boolean.
	 */
	chainRead(this: Translator, e: ts.Expression, objects = false): string | null {
		if (this.library) return null;
		while (ts.isParenthesizedExpression(e)) e = e.expression;
		if (!(ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) || !ts.isOptionalChain(e) || isWriteTarget(e) || this.optionalReads.has(e)) return null;
		const t = this.typeOf(e);
		if (objects ? isUntyped(spelledType(t)) || isOptional(t) : !['String', 'Double', 'Bool'].includes(t)) return null;
		this.optionalReads.set(e, false);
		try {
			const code = this.expr(e);
			// The read gave the chain's optional, or is one whatever it was asked (`(a as A?)?.items.length`).
			return this.optionalReads.get(e) || this.marks.chainEnd(code) ? code : null;
		} finally {
			this.optionalReads.delete(e);
		}
	},

	/** A value as JavaScript converts it to a string (`String(x)`, `${x}`, `'' + x`). */
	str(this: Translator, e: ts.Expression): string {
		// `x as string` only types x: the value converted is x's, which may be undefined.
		let inner = e;
		while (ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner) || ts.isNonNullExpression(inner) || ts.isParenthesizedExpression(inner)) inner = inner.expression;
		if (inner.kind === ts.SyntaxKind.NullKeyword) return '"null"';
		if (inner !== e && /\?$/.test(this.typeOf(inner)) && this.typeOf(e) === 'String') return `${RT.jsToString}(${this.expr(inner)} as Any?)`;
		if (notedField(this.states, e)) return `${RT.jsToString}(${this.coerce(e, 'Any?')})`;
		const maybe = this.maybeUndefined(e);
		if (maybe) return `${RT.jsToString}(${this.states.nilIsNull(e) ? `${RT.jsNulled}(${maybe} as Any?)` : `${maybe} as Any?`})`;
		const chain = this.chainRead(e);
		if (chain) return `${RT.jsToString}(${chain} as Any?)`;
		// Narrowed by an assignment, a held value may still be missing: its type says present, its form doesn't.
		if (this.states.nullishRead(e)) return `${RT.jsToString}(${this.coerce(e, 'Any?')})`;
		const t = this.typeOf(e);
		if (t === 'String') return this.expr(e);
		if (t === 'Double' || t === 'Bool') return `${RT.js}(${this.expr(e)})`;
		if (t === 'Void' && !isNullish(e)) return this.pure(e) ? '"undefined"' : `${RT.jsToString}(${RT.jsUndefined}(${this.expr(e)}))`;
		// Typed `T | null` (`headers.get(name)`), held as an optional: missing is null, not undefined.
		if (this.states.nilIsNull(e) && /\?$/.test(t) && !isUntyped(spelledType(t))) return `(${this.expr(e)}.map { ${RT.jsToString}($0) } ?? "null")`;
		if (this.states.nullDistinct(e)) return `${RT.jsToString}(${this.coerce(e, 'Any?')})`;
		return `${RT.jsToString}(${this.expr(e)})`;
	},
};
