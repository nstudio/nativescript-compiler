// Placement and coercion in Kotlin: a value put into a slot, nullish reads, conditions.
import { heldLoss } from '../semantics/losses.ts';
import ts from 'typescript';
import type { NulledRead } from '../semantics/states/value-states.ts';
import { anyArguments, branch, cast, functionTypeParts, ident, isDeclarationName, isFunctionType, isNullable, isThisParameter, kotlinString, lambda, negated, nullishType, optionalType, returnsNull, slotFunctionParts, wrapsWhole, RT, adaptOf } from './syntax.ts';
import { substitutedExpr } from '../semantics/lang.ts';
import type { Translator } from './translator.ts';
import { conditionCell } from '../semantics/placement.ts';
import type { ConditionCell } from '../semantics/placement.ts';
import { isFunctionHeld, notedField, spelledOptional } from '../semantics/shapes.ts';
import { keepsIdentity } from '../semantics/conversion.ts';
import { thisNodes, isWriteTarget, notIterable } from '../semantics/ast.ts';
import { takesReceiver } from '../semantics/lang.ts';
import { observers } from '../semantics/observers.ts';
import { isLibGlobal } from '../semantics/globals.ts';
import { heldOf, isNamed, isUntyped, spelledType } from '../semantics/types.ts';

export const placementMethods = {
	/** An untyped value into `JSNullish<into>`: its present value converted as an untyped value into `into` is (a TypeError where it isn't one). */
	nullishOfAny(this: Translator, code: string, into: string): string {
		return `JSNullish.ofAny<${into}>(${code}) { ${this.fromAny('it', into)} }`;
	},

	/**
	 * A function value taking or giving `JSNullish` placed untyped: script calls it with values as it holds them and reads
	 * its result so, which the function's own Kotlin type can't take or give.
	 */
	nullishFunction(this: Translator, e: ts.Expression): string | null {
		const from = this.typeOf(e);
		const f = from.includes('JSNullish<') ? functionTypeParts(from.replace(/^\((.*)\)\?$/, '$1')) : null;
		const sig = this.checker.getTypeAtLocation(e).getNonNullableType().getCallSignatures()[0]?.getDeclaration();
		// A declared function named is held untyped by `untypedFunction`, whose results `jsCall` reads as script holds them.
		if (!f || !sig || ts.isJSDocSignature(sig) || ts.isFunctionDeclaration(sig) || ts.isMethodDeclaration(sig) || sig.parameters.some((p) => p.dotDotDotToken || isThisParameter(p))) return null;
		const names = f.params.map((_, k) => this.marks.pureCode(`__n${k}`));
		const call = `__f(${f.params.map((p, k) => this.fromAny(names[k], p)).join(', ')})`;
		const adapter = `{ ${names.map((n) => `${n}: Any?`).join(', ')}${names.length ? ' ' : ''}-> ${f.ret === 'Unit' ? `${call}; Unit` : `${RT.jsBox}(${call})`} }`;
		return `${this.expr(e)}.let { __f -> ${adapter} }`;
	},

	/** A `nullishHeld` variable's, parameter's or function result's `JSNullish<T>`. */
	nullishSlotType(this: Translator, d: ts.Declaration): string {
		const signal = /^Signal<(JSNullish<.*>)>$/.exec(ts.isPropertyDeclaration(d) || ts.isPropertySignature(d) || ts.isParameter(d) || ts.isVariableDeclaration(d) ? this.typeOf(d.name) : '');
		if (signal) return signal[1];
		if (ts.isPropertyDeclaration(d) || ts.isPropertySignature(d)) return nullishType(this.typeOf(d.name));
		if (ts.isVariableDeclaration(d)) return this.typeOf(d.name);
		return ts.isParameter(d) ? this.paramType(d) : this.returnTypeOf(d as ts.SignatureDeclaration);
	},

	/* nullishCode is installed from semantics/lowering-methods.ts */

	/** `nullableEntry`'s read: `jsNulledEntry` of the Map value `code` reads, `jsNulledElement` of the element, the field by its key, or a static by its written flag. */
	nulledEntry(this: Translator, read: NulledRead, code: () => string): string | null {
		if (read.kind === 'static') {
			const cls = this.expr(read.read.expression);
			return `(if (${cls}.${read.flag}) ${RT.jsNulled}(${cls}.${ident(read.name)}) else null)`;
		}
		if (read.kind === 'field') {
			const base = read.read.expression;
			if (this.isAny(base) || (!ts.isOptionalChain(read.read) && (this.typeOf(base).endsWith('?') || this.states.heldOptional(base)))) return `${ts.isOptionalChain(read.read) ? RT.jsGetIfPresent : RT.jsGet}(${this.expr(base)}, ${kotlinString(read.name)})`;
			return `${this.expr(base)}${ts.isOptionalChain(read.read) ? '?.' : '.'}${RT.jsGet}(${kotlinString(read.name)})`;
		}
		if (read.kind === 'element') return `${RT.jsNulledElement}(${this.expr(read.read.expression)}, ${this.toNumber(read.read.argumentExpression)})`;
		const entry = this.marks.markOf(code());
		return entry?.op === 'entry' ? `${RT.jsNulledEntry}(${entry.of.code}, ${entry.key.code})` : null;
	},

	/** `nullishShapeField`'s field: one of a shape or interface object class whose Kotlin type is nullable and not a function. */
	optionalShapeField(this: Translator, e: ts.PropertyAccessExpression): string | null {
		const held = this.typeOf(e.expression).replace(/[?!]$/, '');
		const shape = this.shapes.named(held);
		if (!shape) {
			// An interface's object class, whose fields are its property signatures.
			const d = this.checker.getSymbolAtLocation(e.name)?.valueDeclaration;
			if (!d || !ts.isPropertySignature(d) || !ts.isInterfaceDeclaration(d.parent) || this.topName(d.parent, d.parent.name.text) !== held) return null;
			const t = this.typeOf(d);
			const h = heldOf(spelledType(t));
			return (d.questionToken || spelledOptional(h)) && h !== 'any' && !isFunctionHeld(h) ? e.name.text : null;
		}
		const f = shape.fields.find((x) => x.name === e.name.text);
		return f && heldOf(spelledType(f.type)) === 'optional' && !shape.fields.some((x) => x.symbol || x.accessor) ? f.name : null;
	},

	/**
	 * A default's object literal, which the checker types by its pattern (`{ a, b } = { a: 1, b: 2 }` as `{ a: any; b: any }`):
	 * made as the type of `holder` (the parameter or binding element), `t`; null for any other default.
	 */
	patternDefault(this: Translator, init: ts.Expression, holder: ts.ParameterDeclaration | ts.BindingElement, t: string): string | null {
		const literal = ts.skipOuterExpressions(init);
		const want = t.replace(/\?$/, '');
		const contextual = ts.isObjectLiteralExpression(literal) && !ts.isIdentifier(holder.name) ? this.checker.getContextualType(literal) : undefined;
		if (!contextual) return null;
		const declared = this.checker.getNonNullableType(this.checker.getTypeAtLocation(holder));
		const spelled = (t: ts.Type, at: ts.Node) => this.shapes.question(() => this.type(t, at).replace(/\?$/, ''));
		if (spelled(this.checker.getNonNullableType(contextual), literal) === want) return null;
		return spelled(declared, holder) === want ? this.object(literal as ts.ObjectLiteralExpression, declared) : null;
	},

	coerceTyped(this: Translator, e: ts.Expression, target: string): string {
		if (isUntyped(spelledType(target)) && ts.isPropertyAccessExpression(e) && (notedField(this.states, e) || this.absentKeyField(e)) && !isWriteTarget(e)) {
			if (this.isAny(e.expression) || this.typeOf(e.expression).endsWith('?') || this.states.heldOptional(e.expression)) return `${ts.isOptionalChain(e) ? RT.jsGetIfPresent : RT.jsGet}(${this.expr(e.expression)}, ${kotlinString(e.name.text)})`;
			return `${this.expr(e.expression)}.jsGet(${kotlinString(e.name.text)})`;
		}
		// An erased assertion where the place takes undefined: the value as it is, or the nullable it may be.
		const assertion = this.assertedUntyped(e);
		if (assertion && isUntyped(spelledType(target)) && this.isAny(assertion.expression)) return this.expr(assertion.expression);
		if (assertion && isNullable(target) && target === optionalType(this.typeOf(assertion))) return this.assertedOptional(assertion);
		// `view && view.describe()` where the place takes undefined and the object may be missing: undefined then.
		const bare = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
		// `x!` asserts nothing at run time: where the slot takes null or undefined (`this._next(value!)`, `ref = null!`), the value as it is.
		if (!this.library && ts.isNonNullExpression(bare) && isNullable(target) && !this.subst.has(e) && !this.subst.has(bare)) return this.coerce(bare.expression, target);
		if (!this.library && (isUntyped(spelledType(target)) || isNullable(target)) && ts.isBinaryExpression(bare) && bare.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && this.isObjectRef(bare.left) && !isNullable(this.typeOf(bare.left))) {
			const left = this.maybeUndefined(bare.left);
			if (left) return `(if (${RT.jsTruthy}(${left})) ${this.coerce(bare.right, target)} else null)`;
		}
		// A plugin's string, number or boolean where the kit's slot types an array (`valueConverter` returning what it was given):
		// as script passes it, unchecked.
		if (!this.library && this.inPluginFile(e) && /^JSArray<.*>\??$/.test(target) && ['String', 'String?', 'Double', 'Boolean', 'Nothing'].includes(this.typeOf(e))) return this.unchecked(target, this.expr(e));
		// App mode: a string, number or boolean asserted untyped (`<any>1`) where another of them goes: converted as script converts it.
		if (!this.library && ['String', 'Double', 'Boolean'].includes(target) && (ts.isAsExpression(e) || ts.isTypeAssertionExpression(e)) && this.isAny(e)) {
			const inner = this.typeOf(e.expression);
			if (['String', 'Double', 'Boolean'].includes(inner) && inner !== target) return target === 'String' ? this.str(e.expression) : target === 'Double' ? this.toNumber(e.expression) : this.cond(e.expression);
		}
		// App mode: a value of a type parameter Kotlin holds nullable (a field left null, a weak reference's target) where the
		// type parameter goes: as it is, as script passes it.
		if (!this.library && /^[A-Z]\w*$/.test(target) && this.checker.getTypeAtLocation(e).flags & ts.TypeFlags.TypeParameter) {
			const weak = ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && ['get', 'deref'].includes(e.expression.name.text) && /^JSWeakRef</.test(this.typeOf(e.expression.expression));
			// A field of the type parameter declared without a value is Kotlin's nullable (`_testView: T`).
			const field = ts.isPropertyAccessExpression(e) ? this.checker.getSymbolAtLocation(e.name)?.valueDeclaration : undefined;
			const unset = !!field && ts.isPropertyDeclaration(field) && !field.initializer && !field.getSourceFile().isDeclarationFile;
			if (weak || unset || this.declaredTypeOf(e) === `${target}?`) return this.unchecked(target, this.expr(e));
		}
		// Library mode: undefined as a number is NaN, as JavaScript reads it (`return undefined` of a number method).
		if (this.library && target === 'Double' && ts.isIdentifier(e) && e.text === 'undefined') {
			heldLoss('nullishLiteral', 'Double.NaN', { node: e });
			return 'Double.NaN';
		}
		if (this.lenient && ['String', 'Double', 'Boolean'].includes(target) && (e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined'))) {
			heldLoss('nullishLiteral', this.zero(target)!, { node: e });
			return this.zero(target)!;
		}
		// Lenient code: null where an object type goes (`signal<Person>(null)`), which its checks let through.
		if ((this.lenient || this.lenientApp) && !this.library && !isNullable(target) && (this.isObjectType(target) || (this.lenientApp && isFunctionType(target))) && (e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined'))) return `${RT.jsUncheckedNull}<${target}>()`;
		if (ts.isNewExpression(e) && ts.isIdentifier(e.expression) && ['Map', 'Set'].includes(e.expression.text) && !e.arguments?.length && /^JS(Map|Set)</.test(target.replace(/\?$/, ''))) return `${target.replace(/\?$/, '')}()`;
		// A literal where the slot is an app interface: made as it, whatever the checker's contextual type (an untyped slot,
		// `(m ??= new Map()).set(k, { … })`).
		const literal = ts.skipOuterExpressions(e);
		const iface = ts.isObjectLiteralExpression(literal) && !this.subst.has(literal) ? this.appInterfaceList().find((i) => i.name === target.replace(/\?$/, '')) : undefined;
		if (iface && (this.checker.getContextualType(literal)?.flags ?? 0) & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return this.object(literal as ts.ObjectLiteralExpression, iface.type);
		while (ts.isParenthesizedExpression(e) && (ts.isArrowFunction(e.expression) || ts.isFunctionExpression(e.expression) || ts.isParenthesizedExpression(e.expression))) e = e.expression;
		if (isNullable(target) || isUntyped(spelledType(target))) {
			let x = e;
			while (ts.isParenthesizedExpression(x)) x = x.expression;
			this.nullOk.add(x);
		}
		// An app function held untyped (a page module's export, which core's Builder calls by name): its arguments read as it types them.
		const overloaded = (x: ts.Identifier) => {
			const sym = this.resolve(x);
			return sym?.valueDeclaration && ts.isFunctionDeclaration(sym.valueDeclaration) && !sym.valueDeclaration.body ? sym.declarations?.find((d): d is ts.FunctionDeclaration => ts.isFunctionDeclaration(d) && !!d.body) : undefined;
		};
		if (!this.library && isUntyped(spelledType(target)) && ts.isIdentifier(e) && !(ts.isCallExpression(e.parent) && e.parent.expression === e) && (this.boxStep(this.typeOf(e)).composite === 'function' || overloaded(e))) {
			const sym = this.resolve(e);
			// An overloaded function is its implementation, whose rest parameter collects the arguments.
			const impl = overloaded(e);
			const decl = impl ?? sym?.valueDeclaration;
			if (decl && ts.isFunctionDeclaration(decl) && decl.body && !decl.getSourceFile().isDeclarationFile && !decl.parameters.some((p, k) => (p.dotDotDotToken && !(impl && k === decl.parameters.length - 1)) || isThisParameter(p)) && !this.implicitThis(decl)) {
				const fn = this.functionValue(e);
				// Inside a class with a member of its name, `::f` is the member: the top-level function is called by its package.
				const shadowed = this.appModule && /^::[\w`]+$/.test(fn) && ts.isSourceFile(decl.parent) && this.enclosingMemberNamed(e, fn.slice(2));
				return this.untypedFunction(decl, shadowed ? `${this.appModule}.${fn.slice(2)}` : fn.includes('::') ? `(${fn})` : fn, !shadowed);
			}
		}
		if (isUntyped(spelledType(target)) && !isWriteTarget(e)) {
			const adapted = this.untypedFunctionValue(e);
			if (adapted) return adapted;
		}
		if (ts.isConditionalExpression(bare)) {
			const fixed = this.staticTruth(bare.condition);
			if (fixed !== undefined) return this.coerce(fixed ? bare.whenTrue : bare.whenFalse, target);
		}
		// A conditional's branches each placed in a shape slot: a class's object is read into the shape by itself, and
		// neither branch is held untyped on the way. Library mode: a literal of another shape is made as the slot's class,
		// the conditional's type, as Swift makes it.
		if (ts.isConditionalExpression(bare) && this.isShapeType(target.replace(/\?$/, '')) && [bare.whenTrue, bare.whenFalse].some((x) => this.typeOf(x).replace(/\?$/, '') !== target.replace(/\?$/, ''))) {
			const whole = this.checker.getNonNullableType(this.checker.getTypeAtLocation(bare));
			const part = (x: ts.Expression) => {
				const literal = ts.skipOuterExpressions(x);
				const madeAsWhole = (this.library || this.lenient) && ts.isObjectLiteralExpression(literal) && this.typeOf(x).replace(/\?$/, '') !== target.replace(/\?$/, '') && this.type(whole, bare).replace(/\?$/, '') === target.replace(/\?$/, '');
				return madeAsWhole ? this.object(literal, whole) : this.coerce(x, target);
			};
			return `(if (${this.cond(bare.condition)}) ${branch(part(bare.whenTrue))} else ${branch(part(bare.whenFalse))})`;
		}
		const source = this.typeOf(e);
		const structural = this.structuralCopy(e, source, target);
		if (structural) return structural;
		// A tuple (a Kotlin Pair) where an array goes: an array of its elements; a conditional's branches each so.
		// So is one where an untyped value goes in a build compiling packages (a package's `combineLatest([a$, b$])` tests `Array.isArray`), as Swift's.
		const array = /^JSArray<(.*)>\??$/.exec(target) ?? (isUntyped(spelledType(target)) && /^(Pair|Triple)</.test(source) && this.packageArgument(e) ? [target, 'Any?'] : null);
		if (!this.library && array && ts.isConditionalExpression(e) && [e.whenTrue, e.whenFalse].some((x) => /^(Pair|Triple)</.test(this.typeOf(x)))) {
			return `(if (${this.cond(e.condition)}) ${branch(this.coerce(e.whenTrue, target))} else ${branch(this.coerce(e.whenFalse, target))})`;
		}
		if (!this.library && array && /^(Pair|Triple)</.test(source)) {
			const parts = source.startsWith('Triple') ? ['first', 'second', 'third'] : ['first', 'second'];
			return `(${this.expr(e)})${isNullable(source) ? '?' : ''}.let { __t -> ${RT.jsArrayOf}<${array[1]}>(${parts.map((p) => `__t.${p}`).join(', ')}) }`;
		}
		// A branch giving nothing where a value or nothing goes (`c ? doInnerSub(v) : buffer.push(v)` as `number | void`): undefined.
		const gives = (x: ts.Expression) => {
			const b = ts.skipParentheses(x);
			return this.typeOf(x) === 'Unit' && !(ts.isIdentifier(b) && b.text === 'undefined') && !ts.isVoidExpression(b);
		};
		if (ts.isConditionalExpression(bare) && isNullable(target) && !isUntyped(spelledType(target)) && [bare.whenTrue, bare.whenFalse].some(gives)) {
			const part = (x: ts.Expression) => (gives(x) ? `run { ${this.expr(x)}; null }` : this.coerce(x, target));
			return `(if (${this.cond(bare.condition)}) ${branch(part(bare.whenTrue))} else ${branch(part(bare.whenFalse))})`;
		}
		// Library mode and non-strict apps: each branch where the slot goes, as Kotlin types the `if` by its branches; a nullable
		// string, number or boolean slot (`scale(): number` returning `c ? 2 : null`) takes a missing branch as it is.
		if ((this.library || this.lenientApp) && ts.isConditionalExpression(e) && (isFunctionType(target.replace(/^\((.*)\)\?$/, '$1')) || ['String?', 'Double?', 'Boolean?'].includes(target))) {
			return `(if (${this.cond(e.condition)}) ${branch(this.coerce(e.whenTrue, target))} else ${branch(this.coerce(e.whenFalse, target))})`;
		}
		// A choice stored as an optional element, or one with a branch asserting `x!` where the slot takes undefined: each
		// branch as the slot takes it, an assertion's value as it is.
		if (!this.library && ts.isConditionalExpression(bare) && isNullable(target) && ((!isUntyped(spelledType(target)) && [bare.whenTrue, bare.whenFalse].some((x) => ts.isNonNullExpression(ts.skipParentheses(x)))) || this.states.optionalElementValue(bare))) {
			return `(if (${this.cond(bare.condition)}) ${branch(this.coerce(bare.whenTrue, target))} else ${branch(this.coerce(bare.whenFalse, target))})`;
		}
		// App code: a function slot one branch's Kotlin type is not, or a generic function Kotlin holds erased (`c ? identity : op`).
		if (!this.library && ts.isConditionalExpression(bare) && slotFunctionParts(target) && [bare.whenTrue, bare.whenFalse].some((x) => this.typeOf(x) !== target || this.genericFunctionRef(x))) {
			return `(if (${this.cond(bare.condition)}) ${branch(this.coerce(bare.whenTrue, target))} else ${branch(this.coerce(bare.whenFalse, target))})`;
		}
		// Lenient code: `a ?? b` where `b` may be unset itself, read as the type says.
		if (this.lenient && ['String', 'Double', 'Boolean'].includes(target) && ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) return this.library ? this.fromAnyCode(this.expr(e), target, true) : this.undefinedAs(this.expr(e), target);
		// Library mode, or a package's generic function (`identity`): a module's function as a value, its Kotlin signature (a lenient result
		// nullable, optional parameters) apart from the slot's: adapted.
		const fnRef = this.library || this.genericFunctionRef(e) ? this.functionRefAdapter(e, target) : null;
		if (fnRef) return fnRef;
		// Library mode: a string where core's code declares a number (`toString(eventNames)` of GestureTypes), as script's operators read it.
		if (this.library && target === 'Double' && /^String\??$/.test(this.declaredTypeOf(e) ?? source)) return `${RT.jsToNumber}(${this.expr(e)})`;
		if (!this.library && isNamed(spelledType(source), 'JSMatch', false) && /^JSArray<String\?>\??$/.test(target)) return `${this.expr(e)}${source.endsWith('?') ? '?' : ''}.values`;
		// Library mode: a match where its type is a list of strings (`RegExpMatchArray` as `string[]`): its values, null where none matched.
		if (this.library && isNamed(spelledType(source), 'JSMatch', false) && /^JSArray<String\??>\??$/.test(target)) {
			const values = cast(`${this.expr(e)}?.values`, optionalType(target));
			return isNullable(target) ? values : this.asserted(values);
		}
		// Lenient code: `a?.b` ends undefined where `a` is, whatever the type says.
		if ((this.lenient || !this.library) && ['String', 'Double', 'Boolean'].includes(target) && source === target && this.optionalChainEnd(e)) return this.undefinedAs(this.expr(e), target);
		// Library mode: `a && b`, `a || b` of operands Kotlin types apart (a nullable field, a string): the value, read as the type says.
		if (this.library && ['String', 'Double', 'Boolean'].includes(target) && ts.isBinaryExpression(e) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(e.operatorToken.kind) && source === target && [e.left, e.right].some((x) => (this.declaredTypeOf(x) ?? this.typeOf(x)) !== target)) return this.fromAnyCode(this.expr(e), target, true);
		// Library mode: an array literal of tuples, its elements typed apart from the slot's (`JSArray<Pair<CssProperty, Any?>>`).
		if (this.library && ts.isArrayLiteralExpression(e) && e.elements.length && e.elements.every(ts.isArrayLiteralExpression) && /^JSArray<(Pair|Triple)</.test(target)) {
			const code = this.expr(e);
			const m = this.marks.markOf(code);
			const made = m?.op === 'array' ? m.element : undefined;
			return made && `JSArray<${made}>` !== target.replace(/\?$/, '') ? cast(code, target) : code;
		}
		// Library mode: a call of a function declared `number` that returns undefined (as NaN), where a nullable number goes: null for it.
		if (this.library && target === 'Double?' && source === 'Double' && ts.isCallExpression(e)) {
			const fn = this.checker.getResolvedSignature(e)?.declaration;
			if (fn && (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.body && fn.type?.kind === ts.SyntaxKind.NumberKeyword && returnsNull(fn.body)) {
				// One Kotlin declares nullable gives null itself.
				if (isNullable(this.returnTypeOf(fn))) return this.maybeUndefined(e) ?? this.expr(e);
				return `(${this.expr(e)}).takeUnless { it.isNaN() }`;
			}
		}
		// Library mode: a Java enum's constant where core's code declares a number (its typings' enums are numbers): its ordinal.
		if (this.library && target === 'Double' && source !== 'Double' && this.checker.getTypeAtLocation(e).flags & ts.TypeFlags.EnumLike && this.native?.type(this.checker.getTypeAtLocation(e))) return `(${this.expr(e)}).ordinal.toDouble()`;
		// Library mode: a typed record or array where an untyped one goes (`Record<string, unknown>` set from a `Record<string, string>`).
		if (this.library && /^JS(Record|Array)<Any\?>\??$/.test(target) && /^JS(Record|Array)<.+>\??$/.test(source) && source.replace(/\?$/, '') !== target.replace(/\?$/, '') && source.slice(0, 8) === target.slice(0, 8)) return cast(this.expr(e), target);
		const missing = this.library && ['String', 'Double', 'Boolean'].includes(target) && source === target ? this.maybeUndefined(e) : null;
		if (missing) return this.undefinedAs(missing, target);
		// An iterable where the type names only its iteration: the kit's iterable of it.
		const iterableSlot = /^JS(Async)?Iterable<.*>\??$/.exec(target);
		if (iterableSlot && !/^JS(Async)?(Iterable|Iterator|Generator)</.test(source)) return `${iterableSlot[1] ? RT.jsAsyncIterable : RT.jsIterable}(${this.expr(e)}${!iterableSlot[1] && isUntyped(spelledType(source)) ? `, ${kotlinString(notIterable(e))}` : ''})`;
		if (target.endsWith('?') && !isUntyped(spelledType(target)) && (!source.endsWith('?') || (this.library && isNullable(target) && !isNullable(source)))) {
			const maybe = this.maybeUndefined(e);
			if (maybe) return maybe;
		}
		if (isUntyped(spelledType(target))) {
			const box = this.boxStep(source);
			// Null kept as untyped values hold it, apart from undefined.
			let bare = e;
			while (ts.isParenthesizedExpression(bare)) bare = bare.expression;
			if (!this.library) {
				const rest = this.restCallable(bare);
				if (rest) return rest;
			}
			// Library mode: a member of an untyped object, kept as it is (whatever class this use's type says it has).
			if (this.library && ts.isPropertyAccessExpression(bare) && !isWriteTarget(bare) && this.isAny(bare.expression) && !this.staticOwnRead(bare) && bare.name.text !== 'prototype' && !(ts.isIdentifier(bare.expression) && (isLibGlobal(this, bare.expression) || this.namesClass(bare.expression)))) {
				return `${bare.questionDotToken ? RT.jsGetIfPresent : RT.jsGet}(${this.expr(bare.expression)}, ${kotlinString(bare.name.text)})`;
			}
			// Library mode: `a || b` held untyped: either operand as it is.
			if (this.library && ts.isBinaryExpression(bare) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(bare.operatorToken.kind) && !this.isAny(bare)) {
				const v = this.fresh('__v');
				const [l, r] = [this.coerce(bare.left, 'Any?'), branch(this.coerce(bare.right, 'Any?'))];
				return bare.operatorToken.kind === ts.SyntaxKind.BarBarToken ? `run { val ${v}: Any? = ${l}; if (${RT.jsTruthy}(${v})) ${v} else ${r} }` : `run { val ${v}: Any? = ${l}; if (${RT.jsTruthy}(${v})) ${r} else ${v} }`;
			}
			// A function reading `arguments`, held untyped: called as script calls it, with however many arguments.
			if ((ts.isArrowFunction(bare) || ts.isFunctionExpression(bare)) && this.readsArguments(bare)) {
				const ret = this.returnTypeOf(bare);
				const call = `__f(${RT.jsArrayOf}<Any?>(*__a))`;
				return `run { val __f = ${this.expr(bare)}; JSMethod { _, __a -> ${ret === 'Unit' ? `${call}; null` : call} } }`;
			}
			// A function of a rest parameter held untyped (`(...args) => {}`): called with however many arguments, the rest packed.
			if (this.library && (ts.isArrowFunction(bare) || ts.isFunctionExpression(bare)) && bare.parameters.at(-1)?.dotDotDotToken && !bare.parameters.some((q) => isThisParameter(q) || !ts.isIdentifier(q.name))) {
				const types = bare.parameters.map((q) => this.paramType(q));
				const ret = this.returnTypeOf(bare);
				const n = types.length - 1;
				const lead = types.slice(0, n).map((t, k) => (isUntyped(spelledType(t)) ? this.marks.pureCode(`__a.getOrNull(${k})`) : this.fromAnyCode(this.marks.pureCode(`__a.getOrNull(${k})`), t, true)));
				const call = `__f(${[...lead, `(JSArray<Any?>(__a.drop(${n})) as ${types[n].replace(/\?$/, '')})`].join(', ')})`;
				return `run { val __f = ${this.closure(bare, `(${types.join(', ')}) -> ${ret}`)}; JSMethod ${lambda(['_', '__a'], ret === 'Unit' ? `${call}; null` : call)} }`;
			}
			if (bare.kind === ts.SyntaxKind.NullKeyword) return 'jsNull';
			const takesThis = (x: ts.Expression) => ts.isFunctionExpression(x) && x.parameters.some((q) => isThisParameter(q) && !this.voidThis(q));
			// A function held untyped taking the receiver it is called with (a property descriptor's `get`, a callback
			// `Array.prototype.some.call` gives a thisArg): a JSMethod, given its receiver.
			if (ts.isFunctionExpression(bare) && takesReceiver(bare)) return this.thisMethod(bare);
			// App code: a function literal held untyped where a package's function type goes, taking objects the app types as
			// its own shapes: the package passes its own shape classes (ngrx `on`'s reducer gets the action as `Action`), so
			// each argument is read into the literal's.
			const packageSlot = () =>
				!!this.checker
					.getContextualType(bare)
					?.getNonNullableType()
					.getCallSignatures()
					.some((c) => {
						const d = c.getDeclaration();
						return !!d && this.pluginFiles.has(d.getSourceFile().fileName);
					});
			if (!this.library && !this.pluginFiles.has(bare.getSourceFile().fileName) && (ts.isArrowFunction(bare) || ts.isFunctionExpression(bare)) && bare.parameters.length <= 4 && !this.readsArguments(bare) && !bare.parameters.some((q) => q.dotDotDotToken || isThisParameter(q)) && packageSlot()) {
				const types = bare.parameters.map((q) => (ts.isIdentifier(q.name) ? this.paramType(q) : this.typeOf(q.name)));
				if (types.some((t) => this.isShapeType(t.replace(/\?$/, '')))) {
					const ret = this.returnTypeOf(bare);
					const names = types.map((_, k) => this.marks.pureCode(`__u${k}`));
					const call = `__f(${types.map((t, k) => (isUntyped(spelledType(t)) ? names[k] : this.fromAnyCode(names[k], t, true))).join(', ')})`;
					return `run { val __f = ${this.closure(bare, `(${types.join(', ')}) -> ${ret}`)}; { ${names.map((n) => `${n}: Any?`).join(', ')} -> ${ret === 'Unit' ? `${call}; Unit` : call} } }`;
				}
			}
			// Library mode and plugins: a function of numbers, strings or booleans held untyped (an options object's `valueChanged`), which core may call with undefined.
			if ((this.library || this.pluginFiles.has(bare.getSourceFile().fileName)) && (ts.isArrowFunction(bare) || (ts.isFunctionExpression(bare) && (this.library || !thisNodes(bare).length))) && !bare.parameters.some((q) => q.dotDotDotToken || isThisParameter(q) || !ts.isIdentifier(q.name))) {
				const types = bare.parameters.map((q) => this.paramType(q));
				if (types.some((t) => ['Double', 'Boolean', 'String'].includes(t))) {
					const ret = this.returnTypeOf(bare);
					const names = types.map((_, k) => this.marks.pureCode(`__u${k}`));
					const call = `__f(${types.map((t, k) => (isUntyped(spelledType(t)) ? names[k] : this.fromAnyCode(names[k], t, true))).join(', ')})`;
					return `run { val __f = ${this.closure(bare, `(${types.join(', ')}) -> ${ret}`)}; { ${names.map((n) => `${n}: Any?`).join(', ')} -> ${ret === 'Unit' ? `${call}; Unit` : call} } }`;
				}
			}
			if (ts.isConditionalExpression(bare) && ([bare.whenTrue, bare.whenFalse].some((x) => x.kind === ts.SyntaxKind.NullKeyword) || this.states.nullBranches(bare) || (this.library && [bare.whenTrue, bare.whenFalse].some(takesThis)))) {
				return `(if (${this.cond(bare.condition)}) ${branch(this.coerce(bare.whenTrue, 'Any?'))} else ${branch(this.coerce(bare.whenFalse, 'Any?'))})`;
			}
			const maybe = this.maybeUndefined(e);
			if (maybe) return maybe;
			if (box.composite === 'void' && source === 'Unit' && !(ts.isIdentifier(e) && e.text === 'undefined')) return `${RT.jsBox}(${this.expr(e)})`;
			// Library mode: a Java method's object result held untyped (`line = reader.readLine()`): Java's null is script's null.
			if (this.library && ts.isCallExpression(bare) && this.javaObjectResult(bare)) return `(${this.expr(e)} ?: JSNull)`;
			return this.expr(e);
		}
		if (isUntyped(spelledType(source)) && target !== 'Unit') {
			if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return this.closure(e, target);
			if (e.kind === ts.SyntaxKind.NullKeyword) return 'null';
			// Library mode: a function declaring the `this` it takes (`setFunc(…)`), its Kotlin type taking that first: a JSMethod's receiver.
			const parts = this.library ? functionTypeParts(target.replace(/^\((.*)\)\?$/, '$1')) : null;
			const thisTaking =
				parts &&
				parts.params.length >= 1 &&
				parts.params.length <= 5 &&
				this.checker
					.getTypeAtLocation(e)
					.getCallSignatures()
					.some((sig) => !!sig.thisParameter);
			if (thisTaking) {
				const code = cast(`${RT.jsThisFunction}(__f, ${parts!.params.length})`, target.replace(/^\((.*)\)\?$/, '$1'));
				return `run { val __f = ${this.expr(e)}; ${/\)\?$/.test(target) ? `if (${RT.jsIsNullish}(__f)) null else ${code}` : code} }`;
			}
			// Library mode: an untyped value where a string, number or boolean goes is that type's undefined when missing.
			return this.library ? this.fromAnyCode(this.expr(e), target, true) : this.fromAny(this.expr(e), target);
		}
		if ((ts.isArrowFunction(e) || ts.isFunctionExpression(e)) && isFunctionType(target.replace(/^\((.*)\)\?$/, '$1'))) {
			const slot = target.replace(/^\((.*)\)\?$/, '$1');
			// Library mode: a slot of wider parameter types than the literal's (a generic function's, its type parameters erased): the literal, adapted.
			const want = functionTypeParts(slot);
			const declared = functionTypeParts(this.typeOf(e));
			// So is one declaring an array where the slot passes a tuple (`(views: View[])` for `[T, Page]`).
			const tupleAsArray = !!declared && !!want && declared.params.some((p, k) => /^JSArray</.test(p) && /^(Pair|Triple)</.test(want.params[k] ?? ''));
			// So is one passed where the generated kit's signature takes other parameter types (its generics erased) or more of them.
			const kitSlot = this.generatedKit && !!declared && !!want && (declared.params.length < want.params.length || declared.params.some((p, k) => p !== want.params[k]));
			// So is one given to a package's generic function (a package's `map(([a, b]) => …)`), whose Kotlin signature has its type parameters erased.
			const callee = ts.isCallExpression(e.parent) && e.parent.arguments.includes(e) ? this.checker.getResolvedSignature(e.parent)?.getDeclaration() : undefined;
			const packageSlot = !!callee && !ts.isJSDocSignature(callee) && this.pluginFiles.has(callee.getSourceFile().fileName) && !!callee.typeParameters?.length;
			const typed = this.library || tupleAsArray || kitSlot || packageSlot ? declared : null;
			// Its parameters as the closure declares them (`typeTested` ones untyped, a pattern's unset-group strings nullable).
			const held = (p: string, q: ts.ParameterDeclaration | undefined) => (q && this.typeTested(q) ? 'Any?' : p === 'String' && q && ts.isIdentifier(q.name) && this.unset.element(q.name) ? 'String?' : p);
			const own = typed && { ...typed, params: typed.params.map((p, k) => held(p, e.parameters[k])) };
			if (own && want && own.params.length <= want.params.length && ((kitSlot && own.params.length < want.params.length) || own.params.some((p, k) => p !== want.params[k] && this.convert('x', want.params[k], p) !== 'x'))) {
				const names = want.params.map((_, k) => this.marks.pureCode(`__a${k}`));
				const call = `__f(${own.params.map((p, k) => this.convert(names[k], want.params[k], p)).join(', ')})`;
				// A parameter the function ignores takes any value: Kotlin's function types take a supertype there.
				const params = want.params.map((p, k) => (k < own.params.length ? p : 'Any?'));
				// `run` typed explicitly: an inferred one leaves the argument's type open, and overloads of the callee that
				// differ only in their function parameter's arity (a package's `filter`, `map`) are then ambiguous.
				return `run<(${params.join(', ')}) -> ${want.ret}> { val __f = ${this.closure(e, `(${own.params.join(', ')}) -> ${want.ret}`)}; { ${params.map((p, k) => `${names[k]}: ${p}`).join(', ')} -> ${call} } }`;
			}
			return this.closure(e, slot);
		}
		{
			// A function value taking fewer parameters than the slot passes (JavaScript ignores the rest).
			const f = functionTypeParts(source.replace(/^\((.*)\)\?$/, '$1'));
			const g = functionTypeParts(target.replace(/^\((.*)\)\?$/, '$1'));
			// A function asserted to take fewer parameters (`fn as () => R`) is still the function it was, which script calls
			// with every argument: placed as its operand.
			const assertion = ts.skipParentheses(e);
			if (f && g && f.params.length < g.params.length && (ts.isAsExpression(assertion) || ts.isTypeAssertionExpression(assertion))) {
				const own = functionTypeParts(this.typeOf(assertion.expression).replace(/^\((.*)\)\?$/, '$1'));
				if (own && own.params.length > f.params.length && own.params.length <= g.params.length) return this.coerce(assertion.expression, target);
			}
			// A function of a rest parameter (`throttle`'s result) where a fixed list is wanted: what the slot passes, packed.
			const sd = f && g ? this.checker.getTypeAtLocation(e).getCallSignatures()[0]?.getDeclaration() : undefined;
			if (sd && !ts.isJSDocSignature(sd) && sd.parameters.length === 1 && sd.parameters[0].dotDotDotToken && f!.params.length === 1 && /^JSArray</.test(f!.params[0]) && f!.params[0] !== g!.params[0]) {
				const names = g!.params.map((_, k) => this.marks.pureCode(`__a${k}`));
				const call = `__f(${RT.jsArrayOf}<Any?>(${names.map((n, k) => (g!.params[k] === 'Unit' ? `${RT.jsBox}(${n})` : n)).join(', ')}) as ${f!.params[0]})`;
				const value = this.functionValue(e);
				return `${value.includes('::') ? `(${value})` : value}.let { __f -> { ${g!.params.map((p, k) => `${names[k]}: ${p}`).join(', ')} -> ${g!.ret === 'Unit' ? call : this.convert(call, f!.ret, g!.ret)} } }`;
			}
			// A declared function where one of fewer parameters is wanted: called by name, so the rest take their defaults.
			const decl = f && g && f.params.length > g.params.length && ts.isIdentifier(e) ? this.resolve(e)?.valueDeclaration : undefined;
			if (decl && ts.isFunctionDeclaration(decl) && decl.body && !decl.getSourceFile().isDeclarationFile && decl.parameters.slice(g!.params.length).every((p) => (p.questionToken || p.initializer) && !p.dotDotDotToken)) {
				const names = g!.params.map((_, k) => this.marks.pureCode(`__a${k}`));
				const call = `${this.library ? this.refName(e as ts.Identifier) : ident((e as ts.Identifier).text)}(${names.map((n, k) => this.convert(n, g!.params[k], f!.params[k])).join(', ')})`;
				return `{ ${g!.params.map((p, k) => `${names[k]}: ${p}`).join(', ')} -> ${call} }`;
			}
			const voidPromiseRet = !this.library && !!f && !!g && f.ret === 'JSPromise<Unit>' && /^JSPromise<.+>$/.test(g.ret) && g.ret !== f.ret;
			if (f && g && f.params.length <= g.params.length && (f.params.length < g.params.length || voidPromiseRet || f.params.some((p, k) => p !== g.params[k] && this.convert('x', g.params[k], p) !== 'x')) && (g.ret === 'Unit' || g.ret === f.ret || voidPromiseRet || (isUntyped(spelledType(g.ret)) && (this.library || f.ret !== 'Unit')) || (!this.library && isUntyped(spelledType(f.ret))))) {
				const names = g.params.map((_, k) => this.marks.pureCode(`__a${k}`));
				const fn = this.functionValue(e);
				// A function field Kotlin declares nullable (one left unset): unwrapped where it is called.
				const unwrap = /^\(.*\)\?$/.test(this.declaredTypeOf(e) ?? '') && !/\)\?$/.test(source) ? '!!' : '';
				const called = `${fn.includes('::') ? `(${fn})` : fn}${unwrap}(${names
					.slice(0, f.params.length)
					.map((n, k) => this.convert(n, g.params[k], f.params[k]))
					.join(', ')})`;
				// An untyped result (or Promise<void> into Promise<T | void>) is read as the slot's.
				const call = voidPromiseRet || (isUntyped(spelledType(f.ret)) && g.ret !== 'Unit' && !isUntyped(spelledType(g.ret)) && !this.library) ? this.fromAny(called, g.ret) : called;
				const adapter = `{ ${g.params.map((p, k) => `${names[k]}: ${p}`).join(', ')} -> ${call} }`;
				// An optional member (`closeCallback?: …`) given to an optional parameter (`cb?: …`): undefined stays undefined,
				// as the checker without strictNullChecks types neither as optional.
				const member = ts.isPropertyAccessExpression(e) ? this.resolve(e.name)?.valueDeclaration : undefined;
				const outer = ts.isCallExpression(e.parent) ? e.parent : undefined;
				const sig = outer ? this.checker.getResolvedSignature(outer)?.getDeclaration() : undefined;
				const param = sig && !ts.isJSDocSignature(sig) ? sig.parameters[outer!.arguments.indexOf(e)] : undefined;
				const optional = !!member && (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) && !!member.questionToken && (/\)\?$/.test(target) || !!param?.questionToken || !!param?.initializer);
				// The function as it is now, equal to its other adaptations and to itself (a listener added and later removed).
				if (g.params.length <= 4 && keepsIdentity('function', e)) {
					const held = adapter.replace(`${fn.includes('::') ? `(${fn})` : fn}${unwrap}(`, '__f(');
					const adapt = `${adaptOf(g.params.length)}<${[...g.params, g.ret].join(', ')}>(__f) ${held}`;
					if (/\)\?$/.test(source) || unwrap || optional) {
						const value = this.expr(e);
						if (/\)\?$/.test(target)) return `${value}?.let { __f -> ${adapt} }`;
						return this.isAsserted(value) ? `${value}.let { __f -> ${adapt} }` : this.asserted(`${value}?.let { __f -> ${adapt} }`);
					}
					return `${fn.includes('::') ? `(${fn})` : fn}.let { __f -> ${adapt} }`;
				}
				return /\)\?$/.test(source) || optional ? `${this.expr(e)}?.let { __f -> ${adapter.replace(fn.includes('::') ? `(${fn})` : fn, '__f')} }` : adapter;
			}
		}
		if (/^JSArray<.*>$/.test(source) && /^JSArray<.*>\??$/.test(target) && source !== target.replace(/\?$/, '') && source === 'JSArray<Any?>') {
			// `[]` is made at its contextual element type already.
			const literal = ts.skipOuterExpressions(e);
			const code = this.expr(e);
			if (this.constructs(code, target)) return code;
			return ts.isArrayLiteralExpression(literal) && !literal.elements.length ? cast(code, target) : this.fromAny(code, target);
		}
		// A value TypeScript's strict typing calls possibly undefined where the code expects one (checked without strictNullChecks).
		if (source === optionalType(target) && !isUntyped(spelledType(target)) && !isNullable(target) && !isFunctionType(target)) {
			const field = this.states.placedField(e);
			return field ? `${RT.jsRequired}(${this.expr(e)}, ${kotlinString(field.name)})` : this.undefinedAs(this.expr(e), target);
		}
		{
			// A function value giving nothing where its slot's result is a value or nothing (a package's `operate(scanInternals(…))`): undefined.
			const f = ts.isArrowFunction(bare) || ts.isFunctionExpression(bare) ? null : functionTypeParts(source);
			const g = slotFunctionParts(target);
			if (!this.library && f && g && f.ret === 'Unit' && isNullable(g.ret) && f.params.length <= g.params.length && f.params.every((p, k) => this.convert('x', g.params[k], p) === 'x')) {
				const names = g.params.map((_, k) => this.marks.pureCode(`__a${k}`));
				const fn = this.functionValue(e);
				const body = `${g.params.map((p, k) => `${names[k]}: ${p}`).join(', ')} -> __f(${names.slice(0, f.params.length).join(', ')}); null`;
				const held = g.params.length <= 4 && keepsIdentity('function', e) ? `${adaptOf(g.params.length)}<${[...g.params, g.ret].join(', ')}>(__f) { ${body} }` : `{ ${body} }`;
				return `${fn.includes('::') ? `(${fn})` : fn}.let { __f -> ${held} }`;
			}
		}
		if (isFunctionType(source) && isFunctionType(target.replace(/^\((.*)\)\?$/, '$1')) && / -> Unit$/.test(target.replace(/^\((.*)\)\?$/, '$1')) && !/ -> Unit$/.test(source)) {
			// A function value whose result a void slot ignores.
			const params = functionTypeParts(source)!.params;
			const names = params.map((_, k) => this.marks.pureCode(`__a${k}`));
			if (params.length <= 4 && keepsIdentity('function', e)) {
				const fn = this.functionValue(e);
				return `${fn.includes('::') ? `(${fn})` : fn}.let { __f -> ${adaptOf(params.length)}<${[...params, 'Unit'].join(', ')}>(__f) { ${params.map((p, k) => `${names[k]}: ${p}`).join(', ')} -> __f(${names.join(', ')}) } }`;
			}
			return `{ ${params.map((p, k) => `${names[k]}: ${p}`).join(', ')} -> ${this.functionValue(e)}(${names.join(', ')}) }`;
		}
		if (target === 'Boolean' && source !== 'Boolean' && source !== 'Nothing') return `${RT.jsTruthy}(${this.expr(e)})`;
		// Core's common code typing a value by its platform's subclass (`picker: TimePicker` given a `TimePickerBase`): cast, as TypeScript checks it structurally.
		const [sb, tb] = [source.replace(/\?$/, ''), target.replace(/\?$/, '')];
		if (this.lenient && sb !== tb && this.sourceClassNames().has(sb) && this.sourceClassNames().has(tb)) return this.classCast(this.functionValue(e), source, target);
		// Library mode: one of the kit's generic containers of another element type (`JSPromise<ImageSource>` where `JSPromise<Any?>` is declared),
		// invariant in Kotlin, the same value to script.
		// Library mode: one Java class where script declares another (`getActivity()`'s FragmentActivity for an AppCompatActivity): cast, as script trusts it.
		if (this.library && sb !== tb && /^[a-z]\w*(\.\w+)+$/.test(sb) && /^[a-z]\w*(\.\w+)+$/.test(tb)) return cast(this.functionValue(e), target);
		// Library mode: a Java collection where Java's wildcard (`Map<String, ?>`) is Kotlin's star projection: the declared one, unchecked.
		if (this.library && /^Mutable(Map|List|Set|Collection|Iterator|Iterable)</.test(tb)) return cast(this.functionValue(e), target);
		// The generated kit: a base class's instance where script's type names a subclass (an ActionItem as a NavigationButton),
		// which script lets through: cast, failing where it is no such instance.
		if (this.generatedKit && sb !== tb && this.core?.has(sb) && this.core.has(tb) && this.core.kitExtends?.(tb, sb)) return cast(this.functionValue(e), target);
		const head = (t: string) => /^(JS(?:Promise|Array|Map|Set|Generator|Iterator|WeakRef))</.exec(t)?.[1];
		const elements = !this.library && head(sb) && head(sb) === head(tb) ? this.elementwise(source, target) : null;
		if (elements) {
			// An array literal is made of the slot's element type already.
			const code = this.functionValue(e),
				m = this.marks.markOf(code);
			if (!(m?.op === 'array' && `JSArray<${m.element}>` === tb)) {
				observers.keep?.('kotlin', /^JSPromise</.test(tb) ? 'promise' : 'elements', source, target, e.getSourceFile().fileName, !!this.library, e.getSourceFile().getLineAndCharacterOfPosition(e.getStart()).line + 1);
				return elements(code);
			}
		}
		if (!this.library && (sb === 'JSPromise<Any?>' || sb === 'JSPromise<Unit>') && /^JSPromise<(.+)>$/.test(tb) && tb !== sb) return this.fromAny(this.functionValue(e), target);
		if (head(sb) && head(sb) === head(tb) && sb !== tb) return cast(this.functionValue(e), target);
		if (sb !== tb && anyArguments(sb, tb)) return this.unchecked(target, this.functionValue(e));
		// An object given where an object type of the program's is declared, which it meets without naming it (`btn` as a `MeasuredView`): read through it by name.
		const wanted = this.checker.getContextualType(e)?.getSymbol();
		const programInterface = !!wanted && !!(wanted.flags & ts.SymbolFlags.Interface) && !(wanted.flags & ts.SymbolFlags.Class) && !!wanted.declarations?.every((d) => !d.getSourceFile().isDeclarationFile) && wanted.name === tb;
		if (!this.library && sb !== tb && this.isObjectType(sb) && (programInterface || this.facts.hasInterface(this, this.interfaces, (d, s) => this.topName(d, s), tb) || !!this.shapes.named(tb)) && !this.declaresInterface(this.checker.getTypeAtLocation(e), tb)) {
			const reader = this.protocols.has(tb) ? `${tb}Object` : tb;
			return isNullable(target) ? `${this.expr(e)}?.let { ${this.viewOf(reader, 'it')} }` : this.viewOf(reader, this.expr(e));
		}
		return this.functionValue(e);
	},

	functionRefAdapter(this: Translator, e: ts.Expression, target: string): string | null {
		// `xml2ui.PositionErrorFormat`: a namespace's function, as a value.
		const member = this.library && ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name) ? e.name : undefined;
		if ((!ts.isIdentifier(e) && !member) || (ts.isCallExpression(e.parent) && e.parent.expression === e)) return null;
		const g = functionTypeParts(target.replace(/^\((.*)\)\?$/, '$1'));
		const decl = this.resolve(member ?? e)?.declarations?.find((d): d is ts.FunctionDeclaration => ts.isFunctionDeclaration(d) && !!d.body && !d.getSourceFile().isDeclarationFile);
		const rest = decl?.parameters.findIndex((p) => p.dotDotDotToken) ?? -1;
		// Library mode and a package's code: a generic function's Kotlin signature has its type parameters erased.
		if (!g || !decl || (decl.typeParameters?.length && !this.library && !this.pluginFiles.has(decl.getSourceFile().fileName)) || this.readsArguments(decl) || decl.parameters.some((p, k) => (p.dotDotDotToken && k !== decl.parameters.length - 1) || isThisParameter(p)) || (rest < 0 && decl.parameters.length > g.params.length)) return null;
		const params = decl.parameters.map((p) => (p.dotDotDotToken ? this.typeOf(p.name) : this.paramType(p)));
		const ret = this.returnTypeOf(decl);
		if (rest < 0 && params.every((p, k) => p === g.params[k]) && params.length === g.params.length && (ret === g.ret || g.ret === 'Unit')) return null;
		const names = g.params.map((_, k) => this.marks.pureCode(`__r${k}`));
		// A rest parameter takes what the slot passes from its position on.
		const el = rest >= 0 ? params[rest].replace(/^JSArray<(.*)>$/, '$1') : '';
		const args =
			rest < 0
				? params.map((p, k) => this.convert(names[k], g.params[k], p))
				: [
						...params.slice(0, rest).map((p, k) => this.convert(names[k], g.params[k], p)),
						`${RT.jsArrayOf}<${el}>(${names
							.slice(rest)
							.map((n, k) => this.convert(n, g.params[rest + k], el))
							.join(', ')})`,
					];
		const ref = member ? this.expr(e) : '';
		if (member && !/^[\w.]+::\w+$/.test(ref)) return null;
		const call = `${member ? ref.replace('::', '.') : this.refName(e as ts.Identifier)}(${args.join(', ')})`;
		return lambda(
			g.params.map((p, k) => `${names[k]}: ${p}`),
			g.ret === 'Unit' ? call : this.convert(call, ret, g.ret),
		);
	},

	/** `Color` in `Color.equals(…)`: a class by its name, not a value holding one. */
	namesClass(this: Translator, e: ts.Node | undefined): boolean {
		if (!e || !(ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) || isDeclarationName(e)) return false;
		return !!((this.resolve(ts.isPropertyAccessExpression(e) ? e.name : e)?.flags ?? 0) & ts.SymbolFlags.Class);
	},
	/** The Kotlin names of the classes the program declares. */
	sourceClassNames(this: Translator): Set<string> {
		return (this.classNames ??= new Set(this.sourceClasses().keys()));
	},
	sourceClasses(this: Translator): Map<string, ts.ClassDeclaration> {
		if (this.classDeclarations) return this.classDeclarations;
		this.classDeclarations = new Map();
		const visit = (n: ts.Node): void => {
			if (ts.isClassDeclaration(n) && n.name) this.classDeclarations!.set(this.className(n), n);
			ts.forEachChild(n, visit);
		};
		for (const f of this.sourceFiles) if (!f.isDeclarationFile) visit(f);
		return this.classDeclarations;
	},

	/** Whether the program's class `sub` extends `base`, so Kotlin takes one where the other goes without a cast. */
	extendsClass(this: Translator, sub: string, base: string): boolean {
		const seen = new Set<ts.ClassDeclaration>();
		for (let d = this.sourceClasses().get(sub); d && !seen.has(d);) {
			seen.add(d);
			if (this.className(d) === base) return true;
			const ext = d.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
			d = ext && this.resolve(ext.expression)?.declarations?.find(ts.isClassDeclaration);
		}
		return false;
	},

	/** `code` of class `from` where class `to` goes: a cast only where it narrows, to a subclass or out of null. */
	classCast(this: Translator, code: string, from: string, to: string): string {
		if (this.extendsClass(from.replace(/\?$/, ''), to.replace(/\?$/, '')) && (isNullable(to) || !isNullable(from))) return code;
		return cast(code, to);
	},

	/**
	 * App code: a function value whose last parameter is a rest, held untyped, which jsCall calls with however many
	 * arguments: the rest packed from its position on. A conditional's branches are each held so.
	 */
	restCallable(this: Translator, e: ts.Expression): string | null {
		const hasRest = (x: ts.Expression): boolean => {
			const sig = this.checker.getTypeAtLocation(x).getNonNullableType().getCallSignatures();
			const d = sig.length === 1 ? sig[0].getDeclaration() : undefined;
			return !!d && !ts.isJSDocSignature(d) && !!d.parameters.at(-1)?.dotDotDotToken && !d.parameters.some((p) => isThisParameter(p)) && /^JSArray</.test(functionTypeParts(this.typeOf(x).replace(/^\((.*)\)\?$/, '$1'))?.params.at(-1) ?? '');
		};
		// Parentheses only: an assertion (`v as Replacer`) is held as the type it asserts.
		const held = (x: ts.Expression): boolean => {
			const b = ts.skipParentheses(x);
			return ts.isConditionalExpression(b) ? held(b.whenTrue) || held(b.whenFalse) : !ts.isArrowFunction(b) && !ts.isFunctionExpression(b) && hasRest(b);
		};
		const bare = ts.skipParentheses(e);
		if (!held(bare)) return null;
		if (ts.isConditionalExpression(bare)) return `(if (${this.cond(bare.condition)}) ${branch(this.coerce(bare.whenTrue, 'Any?'))} else ${branch(this.coerce(bare.whenFalse, 'Any?'))})`;
		const asserted = ts.isAsExpression(bare) || ts.isTypeAssertionExpression(bare) ? ts.skipOuterExpressions(bare) : null;
		if (asserted && this.isAny(asserted)) return this.expr(asserted);
		const type = this.typeOf(bare);
		const g = functionTypeParts(type.replace(/^\((.*)\)\?$/, '$1'))!;
		const n = g.params.length - 1;
		const lead = g.params.slice(0, n).map((t, k) => (isUntyped(spelledType(t)) ? this.marks.pureCode(`__a.getOrNull(${k})`) : this.fromAnyCode(this.marks.pureCode(`__a.getOrNull(${k})`), t, true)));
		const packed = `JSArray<Any?>(ArrayList(__a.drop(${n})))`;
		const call = `__f(${[...lead, g.params[n] === 'JSArray<Any?>' ? packed : this.fromAnyCode(packed, g.params[n], true)].join(', ')})`;
		const fn = `${RT.jsFunction}(${n}, __f, true) { __a -> ${g.ret === 'Unit' ? `${call}; null` : call} }`;
		// A variable narrowed to its function is still held nullable when declared so.
		const sym = ts.isIdentifier(bare) ? this.resolve(bare) : undefined;
		const declared = sym?.valueDeclaration ? this.checker.getTypeOfSymbol(sym) : undefined;
		const nullable = /\)\?$/.test(type) || (!!declared && declared.isUnion() && declared.types.some((t) => t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)));
		return `run { val __f = ${this.expr(bare)}; ${nullable ? `if (__f == null) null else ${fn}` : fn} }`;
	},

	/** An expression as a value: a declared function named by a reference. */
	functionValue(this: Translator, e: ts.Expression): string {
		if (ts.isIdentifier(e)) {
			const decl = this.resolve(e)?.valueDeclaration;
			if (decl && ts.isFunctionDeclaration(decl) && !decl.getSourceFile().isDeclarationFile) {
				// By the name it is declared under: an import's alias (`runAll as __import0_runAll`) or a renamed top-level name is not it.
				const ref = this.refName(e);
				const dot = ref.lastIndexOf('.');
				return dot < 0 ? `::${ref}` : `${ref.slice(0, dot)}::${ref.slice(dot + 1)}`;
			}
		}
		if (ts.isPropertyAccessExpression(e) && this.namespaceMember(e)) {
			const decl = this.resolve(e.name)?.valueDeclaration;
			if (decl && ts.isFunctionDeclaration(decl)) {
				const ref = this.namespaceMember(e)!;
				const dot = ref.lastIndexOf('.');
				return dot < 0 ? `::${ref}` : `${ref.slice(0, dot)}::${ref.slice(dot + 1)}`;
			}
		}
		return this.expr(e);
	},

	/** A condition: Kotlin needs a Boolean where JavaScript tests truthiness. */
	cond(this: Translator, e: ts.Expression, c?: ConditionCell): string {
		const code = this.condition(e, c);
		this.condCodes.set(e, code);
		return code;
	},

	condition(this: Translator, e: ts.Expression, c?: ConditionCell): string {
		const sub = substitutedExpr(this.subst, e);
		if (sub) return this.typeOf(sub.bare) === 'Boolean' ? sub.code : `${RT.jsTruthy}(${sub.code})`;
		if (c === undefined) c = conditionCell(this.conditions, e);
		switch (c.step) {
			case 'fixed':
				return String(c.value);
			case 'logical': {
				const l = this.cond(c.e.left),
					r = this.cond(c.e.right);
				return l === r ? l : `(${l} ${c.and ? '&&' : '||'} ${r})`;
			}
			case 'not':
				return negated(this.cond(c.e));
			case 'missing':
				return `${RT.jsTruthy}(${c.code})`;
			case 'bool':
				return this.expr(c.e);
		}
		const code = this.expr(c.e);
		// A missing string read as "undefined" (a match's unmatched group) is falsy as the value it stands for.
		const m = this.marks.markOf(code);
		const raw = m?.op === 'undefinedAs' && m.to.kind === 'string' ? m.of.code : undefined;
		if (raw && wrapsWhole(raw)) return `${RT.jsTruthy}(${raw})`;
		return this.typedTruth(c.e, code) ?? `${RT.jsTruthy}(${code})`;
	},
};
