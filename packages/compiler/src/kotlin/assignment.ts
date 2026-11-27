// Assignment as Kotlin: prefix and postfix updates, compound assignment and the reads and writes they make.
import ts from 'typescript';
import { TYPED_ARRAYS } from '../semantics/globals.ts';
import { functionTypeParts, ident, isNullable, kotlinString, lambda, negated, setterMethod, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { asOperation, unsafeReceiver, type ReadWrite } from '../semantics/lang.ts';
import { notedField } from '../semantics/shapes.ts';
import { isNamed, isUntyped, spelledType } from '../semantics/types.ts';
import { assignedTo, negatedCell } from '../semantics/placement.ts';
import { isStatic } from '../semantics/throws.ts';
import { symbolField, isPromiseType } from '../semantics/spelled.ts';
import { untypedUnary } from '../semantics/apis/operators.ts';
import { planUnary } from '../semantics/lower.ts';

export const assignmentMethods = {
	/** The 1 that `++` and `--` step a number or a BigInt by. */
	one(this: Translator, e: ts.Expression): string {
		return this.typeOf(e) === 'JSBigInt' ? 'JSBigInt(1L)' : '1.0';
	},

	prefix(this: Translator, e: ts.PrefixUnaryExpression): string {
		const K = ts.SyntaxKind;
		const thrown = untypedUnary(this, e);
		if (thrown) return thrown;
		const unary = planUnary(e.operator, this.typeOf(e.operand) === 'JSBigInt');
		if (unary) {
			switch (unary.kind) {
				case 'not': {
					const cell = negatedCell(this.conditions, e.operand);
					return negated(cell.step === 'bool' ? this.expr(cell.e) : this.cond(e.operand, cell));
				}
				case 'negate':
					if (unary.bigInt) return `(-${this.expr(e.operand)})`;
					return ts.isNumericLiteral(e.operand) ? `-${this.expr(e.operand)}` : `-(${this.toNumber(e.operand)})`;
				case 'plus':
					return this.toNumber(e.operand);
				case 'bitNot':
					return unary.bigInt ? `${this.expr(e.operand)}.inv()` : `${RT.jsBitNot}(${this.toNumber(e.operand)})`;
			}
		}
		switch (e.operator) {
			case K.PlusPlusToken:
			case K.MinusMinusToken: {
				const sign = e.operator === K.PlusPlusToken ? '+' : '-';
				const place = this.untypedPlace(e.operand);
				if (place) return this.keyedStep(place, sign, false);
				const held = this.heldNumberStep(e);
				if (held) return held;
				const t = this.lvalue(e.operand);
				return `run { ${t} ${sign}= ${this.one(e.operand)}; ${t} }`;
			}
		}
		throw this.error(e, 'prefix operator');
	},

	/** A member's compound, logical or update assignment (`readWrite`): its held parts evaluated once, its value the one computed. */
	readWriteCode(this: Translator, e: ts.Expression, rw: ReadWrite): string {
		const names = rw.held.map((h) => this.fresh(h === rw.target.expression ? '__o' : '__k'));
		const binds = rw.held.map((h, k) => `val ${names[k]} = ${this.expr(h)}`);
		rw.held.forEach((h, k) => {
			this.subst.set(h, names[k]);
			this.heldParts.add(h);
		});
		try {
			const body = rw.value ? this.readWriteValue(e) : this.exprStatement(e);
			const lost = names.find((n) => !new RegExp(`\\b${n}\\b`).test(body));
			if (lost) throw this.error(e, `a compound assignment whose target the translation evaluates apart from its parts (${lost})`);
			return binds.length ? `run { ${[...binds, body].join('; ')} }` : body;
		} finally {
			rw.held.forEach((h) => {
				this.subst.delete(h);
				this.heldParts.delete(h);
			});
		}
	},

	/** `f()` reading a record's entry as present, though Kotlin reads it back nullable. */
	entryRead(this: Translator, e: ts.Expression, f: () => string): string {
		const target = this.recordEntry(e);
		if (!target) return f();
		this.subst.set(target, this.asserted(ts.isElementAccessExpression(target) ? this.expr(target) : this.lvalue(target)));
		try {
			return f();
		} finally {
			this.subst.delete(target);
		}
	},

	/** A member's compound, logical or update assignment as a value: one read, the write, and the value computed or kept. */
	readWriteValue(this: Translator, e: ts.Expression): string {
		const K = ts.SyntaxKind;
		if (ts.isBinaryExpression(e) && [K.AmpersandAmpersandEqualsToken, K.BarBarEqualsToken, K.QuestionQuestionEqualsToken].includes(e.operatorToken.kind)) {
			const read = this.fresh('__read'),
				value = this.fresh('__value');
			const op = e.operatorToken.kind;
			const test = op === K.AmpersandAmpersandEqualsToken ? `${RT.jsTruthy}(${read})` : op === K.BarBarEqualsToken ? `!${RT.jsTruthy}(${read})` : `${RT.jsIsNullish}(${read})`;
			const target = this.declaredTypeOf(e.left) ?? this.typeOf(e.left);
			const t = this.isAny(e.left) ? 'Any?' : this.typeOf(e);
			const assigned = `val ${value} = ${this.stored(e.right, e.left, isUntyped(spelledType(t)) ? 'Any?' : target)}`;
			const kept = isNullable(target) && !isUntyped(spelledType(t)) ? this.undefinedAs(read, t) : this.recordEntry(e.left) ? this.asserted(read) : read;
			this.subst.set(e.right, value);
			try {
				return `run { val ${read} = ${this.expr(e.left)}; if (${test}) { ${assigned}; ${this.assignment(e.left, e.right)}; ${value} } else ${kept} }`;
			} finally {
				this.subst.delete(e.right);
			}
		}
		const value = this.fresh('__value');
		let computed: string,
			given = value,
			old = '';
		if (ts.isBinaryExpression(e)) computed = this.entryRead(e.left, () => this.binary(asOperation(e)));
		else {
			const u = e as ts.PrefixUnaryExpression | ts.PostfixUnaryExpression;
			old = this.fresh('__old');
			computed = `${old} ${u.operator === K.PlusPlusToken ? '+' : '-'} ${this.one(u.operand)}`;
			old = `val ${old} = ${this.entryRead(u.operand, () => (this.typeOf(u.operand) === 'JSBigInt' ? this.expr(u.operand) : this.toNumber(u.operand)))}; `;
			if (ts.isPostfixUnaryExpression(e)) given = /val (\w+)/.exec(old)![1];
		}
		const left = ts.isBinaryExpression(e) ? e.left : (e as ts.PrefixUnaryExpression).operand;
		this.subst.set(e, value);
		try {
			return `run { ${old}val ${value} = ${computed}; ${this.assignment(left, e)}; ${given} }`;
		} finally {
			this.subst.delete(e);
		}
	},

	/** `++`/`--` of a member read and written by key, as a value: the old number (postfix) or the new one. */
	keyedStep(this: Translator, place: { obj: string; key: string }, sign: string, postfix: boolean): string {
		const o = this.fresh('__o');
		return `run { val ${o} = ${place.obj}; val __old = ${RT.jsToNumber}(${RT.jsGet}(${o}, ${place.key})); ${RT.jsSet}(${o}, ${place.key}, __old ${sign} 1.0); ${postfix ? '__old' : `__old ${sign} 1.0`} }`;
	},

	/** `left = right` (also the assignment `??=` and `||=` make). */
	assignment(this: Translator, left: ts.Expression, right: ts.Expression): string {
		// `(x as any) = v`: the assertion is erased, so `v` goes into `x` as `x` is typed.
		if (left !== ts.skipOuterExpressions(left) && ts.isIdentifier(ts.skipOuterExpressions(left)) && ts.isAsExpression(ts.skipParentheses(left))) return this.assignment(ts.skipOuterExpressions(left), right);
		// A right side the translation converted already (`subst`) is not given again.
		const checks = assignedTo(left, right) && !this.subst.has(right);
		const nullish = ts.isIdentifier(left) ? this.states.nullishRead(left) : null;
		if (nullish) return `${this.refName(left as ts.Identifier)} = ${this.stored(right, left, this.nullishSlotType(nullish), checks)}`;
		const field = ts.isPropertyAccessExpression(left) && left.expression.kind !== ts.SyntaxKind.SuperKeyword ? this.states.nullishRead(left) : null;
		if (field) return `${this.lvalue(left)} = ${this.stored(right, left, this.nullishSlotType(field), checks)}`;
		const keyedField = this.states.nullishKeyedField(left);
		if (keyedField) return `${this.lvalue(left)} = ${this.stored(right, left, this.nullishSlotType(keyedField), checks)}`;
		if (ts.isPropertyAccessExpression(left) && notedField(this.states, left)) {
			const value = this.stored(right, left, 'Any?', checks);
			if (this.isAny(left.expression) || this.typeOf(left.expression).endsWith('?') || this.states.heldOptional(left.expression)) return `${RT.jsSet}(${this.expr(left.expression)}, ${kotlinString(left.name.text)}, ${value})`;
			return `${this.expr(left.expression)}.jsSet(${kotlinString(left.name.text)}, ${value})`;
		}
		const keyed = ts.isPropertyAccessExpression(left) && !this.lenient && !this.library ? this.states.nullishShapeField(left, true) : null;
		if (keyed) return `${this.expr((left as ts.PropertyAccessExpression).expression)}.jsSet(${kotlinString(keyed)}, ${this.stored(right, left, 'Any?', checks)})`;
		if (ts.isPropertyAccessExpression(left) && this.framework.signalKind(this.symbolName(left.expression)) === 'ref' && left.name.text === 'value') return `${this.lvalue(left)} = ${this.signalWrite(left.expression, right, this.typeOf(left), checks, left)}`;
		if (ts.isArrayLiteralExpression(left)) throw this.error(left, 'a destructuring assignment');
		// `super.style = value` over the kit's `__set_style`: the kit's body, since its property calls this class's override.
		const enclosing = ts.findAncestor(left, ts.isClassLike);
		const overKit = !this.library && !!enclosing && ts.isPropertyAccessExpression(left) && left.expression.kind === ts.SyntaxKind.SuperKeyword && (this.checker.getSymbolAtLocation(left.name)?.declarations ?? []).every((d) => d.getSourceFile().isDeclarationFile) && this.baseSetterMethod(enclosing, left.name.text);
		const takes = ts.isPropertyAccessExpression(left) ? (this.setterTakesAt(left) ?? (overKit ? 'Any?' : null)) : null;
		if (takes && ts.isPropertyAccessExpression(left)) {
			const place = this.lvalue(left);
			const member = `.${ident(left.name.text)}`;
			if (place.endsWith(member)) return `${place.slice(0, -member.length)}.${setterMethod(left.name.text)}(${this.stored(right, left, takes, checks)})`;
		}
		// An object Kotlin holds untyped, or none this platform's code can reach (the iOS half of `__APPLE__ ? x : undefined`, narrowed to never), is set by name.
		// `this.x = …` in a static block or method, of a static field the class declares: the companion's.
		const staticOwn = ts.isPropertyAccessExpression(left) && left.expression.kind === ts.SyntaxKind.ThisKeyword && !!this.resolve(left.name)?.declarations?.some((d) => ts.isPropertyDeclaration(d) && isStatic(d));
		if (staticOwn) return `${this.expr(left.expression)}.${ident(left.name.text)} = ${this.stored(right, left, this.typeOf(left), checks)}`;
		// A static method is called straight on the companion, which keeps no value under its name.
		const ownMethod = ts.isPropertyAccessExpression(left) ? this.replacedMethod(left) : undefined;
		if (ownMethod && isStatic(ownMethod)) throw this.error(left.parent, `giving ${(ownMethod.parent as ts.ClassLikeDeclaration).name?.text ?? 'a class'}.${ownMethod.name.getText()} a value in place of the class's static method`);
		if (ts.isPropertyAccessExpression(left) && !this.library && !staticOwn && ['Any?', 'Nothing'].includes(this.typeOf(left.expression)) && !this.isExpando(left)) return `${RT.jsSet}(${this.expr(left.expression)}, ${kotlinString(left.name.text)}, ${this.untypedCallable(right)})`;
		// A method of a class replaced on an instance (`image.requestLayout = () => …`): set by name, which the class's own calls do not see.
		if (ts.isPropertyAccessExpression(left) && !this.library && (this.checker.getSymbolAtLocation(left.name)?.flags ?? 0) & ts.SymbolFlags.Method && !this.isPrototypeRef(left.expression)) return `${RT.jsSet}(${this.expr(left.expression)}, ${kotlinString(left.name.text)}, ${this.untypedCallable(right)})`;
		if (ts.isPropertyAccessExpression(left)) {
			const special = this.core?.assign(left, right) ?? this.native?.assign(left, right);
			if (special) return special;
		}
		// Library mode: a function taking `this` put on a prototype (`View.prototype[prop.setNative] = function (this: View, v) {…}`): a method, called with its instance.
		if ((ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) && this.isPrototypeRef(left.expression)) {
			const sig = this.checker.getTypeAtLocation(right).getCallSignatures()[0] as (ts.Signature & { thisParameter?: ts.Symbol }) | undefined;
			const parts = sig?.thisParameter ? functionTypeParts(this.typeOf(right)) : null;
			if (parts?.params.length) {
				const key = ts.isPropertyAccessExpression(left) ? kotlinString(left.name.text) : this.propertyKey(left.argumentExpression);
				const args = parts.params.map((p, k) => this.fromAnyCode(k === 0 ? '__t' : this.marks.pureCode(`__a.getOrNull(${k - 1})`), p, true));
				return `${RT.jsSet}(${this.expr(left.expression)}, ${key}, run { val __f = ${this.stored(right, left, this.typeOf(right), checks)}; JSMethod ${lambda(['__t', '__a'], `__f(${args.join(', ')})`)} })`;
			}
		}
		const eventData =
			this.library &&
			ts.isPropertyAccessExpression(left) &&
			((isNamed(spelledType(this.typeOf(left.expression)), 'EventData', false) && !['eventName', 'object'].includes(left.name.text)) ||
				// `promise.cancel = …` on the kit's promise: kept beside it, as script adds it.
				isPromiseType(this.nativeOf(left.expression)));
		if (ts.isPropertyAccessExpression(left) && !this.library && this.isGlobalObject(left.expression)) return `${RT.jsSet}(jsGlobalThis, ${kotlinString(left.name.text)}, ${this.untypedCallable(right)})`;
		if (ts.isPropertyAccessExpression(left) && !this.library && this.typeOf(left.expression).replace(/\?$/, '') === 'JSWorker' && (left.name.text === 'onmessage' || left.name.text === 'onerror')) {
			return `${RT.jsSet}(${this.expr(left.expression)}, ${kotlinString(left.name.text)}, ${this.untypedCallable(right)})`;
		}
		// `record.key = v` of a `Record<string, T>`: its entry.
		const record = ts.isPropertyAccessExpression(left) ? /^JSRecord<(.*)>\??$/.exec(this.typeOf(left.expression)) : null;
		if (record && ts.isPropertyAccessExpression(left)) return `${this.typeOf(left.expression).endsWith('?') ? this.present(this.expr(left.expression), left.name.text, left.expression, true) : this.expr(left.expression)}[${kotlinString(left.name.text)}] = ${this.stored(right, left, record[1], checks)}`;
		// A method replaced on an instance (`image.requestLayout = () => …`): kept beside it by name, as Kotlin's methods are fixed.
		const method = ts.isPropertyAccessExpression(left) && !this.library && this.checker.getSymbolAtLocation(left.name)?.declarations?.every((d) => ts.isMethodDeclaration(d) || ts.isMethodSignature(d));
		if (method && ts.isPropertyAccessExpression(left)) return `${RT.jsSet}(${this.expr(left.expression)}, ${kotlinString(left.name.text)}, ${this.stored(right, left, 'Any?', checks)})`;
		if (ts.isPropertyAccessExpression(left) && !staticOwn && (this.isExpando(left) || this.isAny(left.expression) || eventData)) return `${RT.jsSet}(${this.expr(left.expression)}, ${kotlinString(left.name.text)}, ${this.stored(right, left, 'Any?', checks)})`;
		const undeclared = ts.isElementAccessExpression(left) && ts.isStringLiteral(left.argumentExpression) && !this.checker.getNonNullableType(this.checker.getTypeAtLocation(left.expression)).getProperty(left.argumentExpression.text);
		// A typed array's element by a numeric index is its own operator, not a dynamic store through the index's string.
		const typedElement = ts.isElementAccessExpression(left) && TYPED_ARRAYS.includes(this.typeOf(left.expression).replace(/\?$/, '').replace(/^JS/, '')) && this.typeOf(left.argumentExpression) === 'Double';
		// A class's static field a symbol names is its companion's member, which has no keys by name.
		const staticSymbol = ts.isElementAccessExpression(left) && ((d) => !!d && isStatic(d))(symbolField(this, left)?.valueDeclaration);
		if (ts.isElementAccessExpression(left) && !typedElement && !staticSymbol && (this.isAny(left.expression) || undeclared || (!ts.isStringLiteral(left.argumentExpression) && this.isObjectRef(left.expression) && !/^(JSArray|JSRecord|JSMatch|Pair|Triple)\b/.test(this.typeOf(left.expression).replace(/\?$/, ''))))) {
			return `${RT.jsSet}(${this.expr(left.expression)}, ${this.propertyKey(left.argumentExpression)}, ${this.stored(right, left, 'Any?', checks)})`;
		}
		const element = ts.isElementAccessExpression(left) && this.states.nullishElements(left.expression) ? this.elementTypeOf(left.expression) : null;
		if (ts.isElementAccessExpression(left) && !element && !left.questionDotToken && !(left.flags & ts.NodeFlags.OptionalChain) && this.typeOf(left.expression) === 'JSArray<Double>' && !this.states.heldOptional(left.expression) && !unsafeReceiver(left.expression, this.checker)) {
			return `${this.expr(left.expression)}.setDouble(${this.toNumber(left.argumentExpression)}, ${this.stored(right, left, 'Double', checks)})`;
		}
		return `${this.lvalue(left)} = ${this.stored(right, left, element ?? this.declaredTypeOf(left) ?? this.typeOf(left), checks)}`;
	},
};
