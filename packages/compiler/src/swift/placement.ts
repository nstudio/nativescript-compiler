// Placement and coercion in Swift: a value put into a slot, nullish reads, conditions.
import { heldLoss } from '../semantics/losses.ts';
import ts from 'typescript';
import { convertedRead } from '../semantics/states/predicates.ts';
import type { NulledRead } from '../semantics/states/value-states.ts';
import { place } from '../semantics/placement.ts';
import type { ResultSlot, ReturnCell } from '../semantics/placement.ts';
import { THROWING_CODE, escapingFunction, escapingParam, functionParts, hasTopLevelArrow, ident, isFunctionType, isNullish, isOptional, nullishType, numberLiteralBranch, numericLiteralOnly, optionalElementsType, optionalType, postfixChain, splitTopLevel, swiftString, unwrapFunction, RT, lenientReader } from './syntax.ts';
import type { Translator } from './translator.ts';
import { structural } from '../semantics/conversion.ts';
import { heldOf, isKit, isNamed, isUntyped, parseNativeType, spelledType } from '../semantics/types.ts';
import type { Value } from '../semantics/conversion.ts';
import { isLibDeclaration, isWriteTarget, notIterable } from '../semantics/ast.ts';
import { holdsNil, notedField, resultShapeNamed } from '../semantics/shapes.ts';
import { implementedInterfaces, literalKey, takesReceiver } from '../semantics/lang.ts';
import { slotOf } from '../semantics/trust.ts';
import { isCoreDeclaration } from '../program/core-facts.ts';
import { isAsync, isStatic } from '../semantics/throws.ts';
import { typedCollection } from './native/bridging.ts';
import { isLibGlobal } from '../semantics/globals.ts';
import { literalClassOf } from '../semantics/classes.ts';

export const placementMethods = {
	loweredReturn(this: Translator, e: ts.Expression, slot: ResultSlot): [string, boolean] {
		const own = this.typeOf(e).replace(/[?!]$/, ''),
			promise = `JSPromise<${slot.target}>`;
		// The `try` marks the value: a return through a finally holds it in a block, which a `try` cannot mark.
		if (!isKit(spelledType(own), 'JSPromise')) {
			const placed = place(this.placement, e, slot);
			return [this.marks.tryBefore(this.tryPrefix(e) || (THROWING_CODE.test(placed) ? 'try ' : ''), placed), false];
		}
		// A promise of another type than the function's (`Promise<[Status, boolean]>` returned where `Promise<any>` is): its value converted.
		const adopt = (code: string) => (own !== promise ? this.convert(code, own, promise) : code);
		const read = this.typeOf(e);
		if (!read.endsWith('?') && !(this.lenient && this.loose(e))) return [this.marks.tryBefore(this.tryPrefix(e), adopt(this.expr(e))), true];
		// Lenient code's promise may be missing (a function that falls off its end): the async function then gives undefined.
		const adopted = adopt('__p');
		const mapped = `(${this.expr(e)} as ${own}?).map { (__p: ${own}) -> ${promise} in ${adopted} } ?? ${promise}.resolve(${this.asyncUndefined(slot.target)})`;
		return [this.marks.tryBefore(this.tryPrefix(e), THROWING_CODE.test(adopted) ? this.marks.tryCode(mapped) : mapped), true];
	},

	/** What an async function of result `t` resolves with where it gives undefined, as `asyncReturn` writes a bare `return`. */
	asyncUndefined(this: Translator, t: string): string {
		if (t === 'Void') return '()';
		if (isOptional(t) || t.endsWith('!') || isUntyped(spelledType(t))) return 'nil';
		return this.zero(t) ?? (/^\(.*\)$/.test(t) && !/->/.test(t) ? `{ () -> ${t} in fatalError("undefined for ${t}") }()` : 'nil');
	},

	/** A returned value's reads before the shared placement front, as Swift reads a value that may be undefined. */
	resultRead(this: Translator, e: ts.Expression, slot: ResultSlot): string | null {
		const ret = slot.target;
		if (slot.lowered) return null;
		// Code checked without strictNullChecks returns undefined from a function of a value type: read as the type's zero, as its fields are.
		if (ret.endsWith('?') && !isUntyped(spelledType(ret))) {
			const maybe = this.maybeUndefined(e);
			if (maybe) return maybe;
		}
		// A library call that may give undefined (`map.get(key)`) returned where a value type is declared: as such a slot reads undefined.
		if (!isOptional(ret) && !isUntyped(spelledType(ret)) && ret !== 'Void' && ts.isCallExpression(e) && !(slot.fn && this.states.nullishHeld(slot.fn))) {
			const maybe = this.maybeUndefined(e);
			if (maybe && /^JSMatch[?!]?$/.test(this.typeOf(e)) && /^JSArray<String>[?!]?$/.test(ret)) return null;
			if (maybe) {
				const value = this.undefinedAs(maybe, ret, this.calledType(e));
				// Lenient code's closure typed to give an object, giving undefined: a TypeError, Swift's closure giving none.
				return this.lenient && !this.looseTolerated(e) ? this.presentCode(value, ret) : value;
			}
		}
		return null;
	},

	/** An expression body's cell, as Swift writes it: its value placed by the slot's type alone, without `resultRead`. */
	bodyReturned(this: Translator, cell: ReturnCell, slot: ResultSlot): string {
		const i = this.indent;
		switch (cell.step) {
			case 'empty':
				return '';
			case 'drop': {
				const logical = this.voidLogical(cell.e);
				return logical ? i + logical : i + this.tryPrefix(cell.e) + this.exprStatement(cell.e);
			}
			case 'voidCall':
				return `${i}${this.tryPrefix(cell.e)}${this.exprStatement(cell.e)}\n${i}return ${cell.empty}`;
			case 'never':
				throw new Error('unreachable: an expression body never ends the function by its call');
		}
		return cell.code !== undefined ? `${i}return ${cell.code}` : `${i}return ${this.marks.tryBefore(this.tryPrefix(cell.e), this.coerce(cell.e, slot.target))}`;
	},

	/** A read of a signal whose value is held as `JSNullish<T>` (`this.note()`). */
	signalNullishRead(this: Translator, e: ts.Expression): boolean {
		const d = this.states.nullishRead(e);
		return !!d && !ts.isFunctionLike(d) && /^Signal<JSNullish</.test(this.typeOf((d as ts.NamedDeclaration).name!));
	},

	/** A `nullishHeld` variable's, parameter's or function result's `JSNullish<T>`. */
	nullishSlotType(this: Translator, d: ts.Declaration): string {
		const signal = /^Signal<(JSNullish<.*>)>$/.exec(ts.isPropertyDeclaration(d) || ts.isPropertySignature(d) || ts.isParameter(d) || ts.isVariableDeclaration(d) ? this.typeOf(d.name) : '');
		if (signal) return signal[1];
		if (ts.isPropertyDeclaration(d) || ts.isPropertySignature(d)) return nullishType(this.typeOf(d.name));
		if (ts.isVariableDeclaration(d)) return this.typeOf(d.name);
		return ts.isParameter(d) ? nullishType(this.typeOf(d.name)) : this.returnTypeOf(d as ts.SignatureDeclaration);
	},

	/** Whether a `nullishField` read is read as its `T` (`present`, which throws): a member read on it, or its value placed in a slot holding neither null nor undefined. */
	nullishPresent(this: Translator, e: ts.PropertyAccessExpression): boolean {
		const use = this.states.nullishFieldUse(e);
		if (use !== 'value') return use === 'member';
		const slot = slotOf(e, this.checker);
		if (!slot || this.states.nullishHeld(slot)) return false;
		// A library's parameter (`indexOf(searchElement: T)`) takes the type its call instantiates.
		const contextual = slot.getSourceFile().isDeclarationFile ? this.checker.getContextualType(e) : undefined;
		const t = contextual ? this.type(contextual, e) : ts.isFunctionLike(slot) ? this.returnTypeOf(slot as ts.SignatureDeclaration) : ts.isIdentifier((slot as ts.NamedDeclaration).name ?? slot) ? this.typeOf((slot as ts.NamedDeclaration).name!) : 'Any?';
		return !/[?!]$/.test(t);
	},

	/* nullishCode is installed from semantics/lowering-methods.ts */

	/** An app generic class's instance where the same class with an `any` type argument is wanted: Swift's generic classes are invariant. */
	checkAnyArgument(this: Translator, e: ts.Expression, target: string): void {
		const want = /^(\w+)<(.+)>[?!]?$/.exec(target);
		if (!this.ledger.genericsReified || this.library || !want || !/\bAny\?/.test(want[2])) return;
		const have = /^(\w+)<(.+)>[?!]?$/.exec(this.typeOf(e));
		if (!have || have[1] !== want[1] || have[2] === want[2]) return;
		const cls = this.checker.getNonNullableType(this.checker.getTypeAtLocation(e)).getSymbol()?.valueDeclaration;
		if (!cls || !ts.isClassLike(cls) || !cls.typeParameters?.length || cls.getSourceFile().isDeclarationFile) return;
		throw this.limit(e, 'generic-any-argument', `an app generic class's instance held with \`any\` as its type argument (${have[0]} as ${target})`);
	},

	/** A generic class's instance given where its generic interface is wanted, which `fieldByOwnParameter` keeps it from conforming to. */
	checkFieldsMet(this: Translator, e: ts.Expression, target: string): void {
		const want = target.replace(/[?!]$/, '');
		if (!this.ledger.genericsReified || this.library || !this.protocols.has(want)) return;
		const cls = this.checker.getTypeAtLocation(e).getSymbol()?.valueDeclaration;
		if (!cls || !ts.isClassLike(cls) || !cls.typeParameters?.length || cls.getSourceFile().isDeclarationFile) return;
		for (const i of implementedInterfaces(this.checker, cls)) {
			const iface = this.checker.getTypeAtLocation(i).getSymbol()?.declarations?.find(ts.isInterfaceDeclaration);
			if (iface && this.topName(iface, iface.name.text) === want && iface.members.some((m) => this.fieldByOwnParameter(cls, m))) {
				throw this.limit(e, 'generic-field-overload', `a generic class whose field typed by its type parameter meets a generic interface's field, held as the interface (${want})`);
			}
		}
	},

	/** `nullableEntry`'s read: `jsNulledEntry` of the element or Map value `code` reads, the field by its key, or a static by its written flag. */
	nulledEntry(this: Translator, read: NulledRead, code: () => string): string | null {
		if (read.kind === 'static') {
			const owner = this.expr(read.read.expression);
			return `(${owner}.${read.flag} ? ${RT.jsNulled}(${owner}.${ident(read.name)}) : nil)`;
		}
		if (read.kind === 'field') {
			const base = read.read.expression,
				key = `[jsKey: ${swiftString(read.name)}]`;
			if (this.isAny(base)) return `${ts.isOptionalChain(read.read) ? RT.jsGetIfPresent : RT.jsGet}(${this.expr(base)}, ${swiftString(read.name)})`;
			return read.read.questionDotToken ? `(${this.expr(base)} as ${optionalType(this.typeOf(base).replace(/[?!]$/, ''))})?${key}` : `${this.receiver(base, read.name) ?? this.expr(base)}${key}`;
		}
		const text = code();
		if (read.kind === 'element') {
			const element = this.marks.boxedElement(text);
			return element ? `${RT.jsNulledEntry}(${element})` : null;
		}
		if (!this.marks.mapEntry(text)) return null;
		const inner = this.marks.afterTry(text);
		return inner !== null ? this.marks.tryCode(`${RT.jsNulledEntry}(${inner})`) : `${RT.jsNulledEntry}(${text})`;
	},

	/** `nullishShapeField`'s field: one of a shape or interface object class whose Swift type is optional. */
	optionalShapeField(this: Translator, e: ts.PropertyAccessExpression): string | null {
		const held = this.typeOf(e.expression).replace(/[?!]$/, '');
		const shape = this.shapes.named(held);
		if (!shape) {
			// An interface's object class, whose fields are its property signatures.
			const d = this.checker.getSymbolAtLocation(e.name)?.valueDeclaration;
			if (!d || !ts.isPropertySignature(d) || !ts.isInterfaceDeclaration(d.parent) || d.parent.name.text !== held || !this.facts.hasInterface(this, this.interfaces, (x, s) => this.topName(x, s), held) || this.protocols.has(held)) return null;
			const t = this.typeOf(d);
			return (d.questionToken || holdsNil(heldOf(spelledType(t)))) && heldOf(spelledType(t)) !== 'any' ? e.name.text : null;
		}
		const f = shape.fields.find((x) => x.name === e.name.text);
		return f && heldOf(spelledType(f.type)) === 'optional' && !shape.fields.some((x) => x.symbol || x.accessor) ? f.name : null;
	},

	coerceTyped(this: Translator, e: ts.Expression, target: string): string {
		const stored = this.storedLiterals.get(e);
		if (stored && (isUntyped(spelledType(target)) || target.replace(/[?!]$/, '') === stored.type)) return stored.code;
		const awaited = this.awaited(e);
		if (awaited && (isUntyped(spelledType(target)) || awaited.target === target)) return isUntyped(spelledType(target)) ? this.marks.castCode(awaited.raw, 'Any', 'as') : awaited.raw;
		// A non-strict app's optional member, held optional, placed where its string, number or boolean must be: undefined read as that type.
		const member = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
		if (ts.isPropertyAccessExpression(member) && target === this.typeOf(member) && this.lenientOptionalMember(member) && !convertedRead(member)) {
			return this.undefinedAs(this.property(member), target, optionalType(target));
		}
		if (isUntyped(spelledType(target))) {
			const chain = this.chainRead(e);
			if (chain) return this.marks.castCode(chain, 'Any', 'as');
			if (ts.isPropertyAccessExpression(member) && !isWriteTarget(member) && !member.questionDotToken) {
				const sym = this.checker.getSymbolAtLocation(member.name);
				if (sym && this.states.shapeFieldOptional(sym) && (['String', 'Double', 'Bool'].includes(this.typeOf(member)) || this.states.unsetMember(sym.valueDeclaration ?? sym.declarations?.[0]))) return `(${this.maybeUndefined(member) ?? this.expr(member)} as Any?)`;
			}
			if (ts.isPropertyAccessExpression(e) && (notedField(this.states, e) || this.absentKeyField(e)) && !isWriteTarget(e)) {
				if (this.isAny(e.expression)) return `${ts.isOptionalChain(e) ? RT.jsGetIfPresent : RT.jsGet}(${this.expr(e.expression)}, ${swiftString(e.name.text)})`;
				const recv = ts.isOptionalChain(e) ? `(${this.expr(e.expression)} as ${optionalType(this.typeOf(e.expression).replace(/[?!]$/, ''))})?` : (this.receiver(e.expression, e.name.text) ?? this.expr(e.expression));
				return `${recv}[jsKey: ${swiftString(e.name.text)}]`;
			}
			const asserted = this.assertedUntyped(e);
			if (asserted && this.isAny(asserted.expression)) return this.expr(asserted.expression);
		} else if (target.endsWith('?') && optionalType(this.typeOf(e)) === target) {
			const chain = this.chainRead(e, true);
			if (chain) return chain;
			const asserted = this.assertedUntyped(e);
			if (asserted) return this.assertedOptional(asserted);
			const nonNull = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
			if (ts.isNonNullExpression(nonNull) && this.typeOf(nonNull.expression) === target) return this.expr(nonNull.expression);
		}
		// A conditional's branches each placed in a shape slot: a class's object is read into the shape by itself, and
		// neither branch is held untyped on the way.
		const branched = ts.skipParentheses(e),
			shape = target.replace(/[?!]$/, '');
		if (ts.isConditionalExpression(branched) && this.isObjectShape(shape) && [branched.whenTrue, branched.whenFalse].some((x) => this.typeOf(x).replace(/[?!]$/, '') !== shape)) {
			return this.ternary(branched, target, (x) => this.coerce(x, target));
		}
		// A choice an optional element takes: each branch as the element takes it, an undefined staying undefined.
		if (ts.isConditionalExpression(branched) && isOptional(target) && !isUntyped(spelledType(target)) && !isOptional(this.typeOf(branched)) && this.states.optionalElementValue(branched)) {
			return this.ternary(branched, target, (x) => this.coerce(x, target));
		}
		// `x as never` (a value the checker is told to take anywhere): the value, as the slot takes it;
		// a number where the slot is a string (`ret.format = parseVertexFormat(ret.format) as never`) converted as script reads it there.
		if (ts.isAsExpression(e) && e.type.kind === ts.SyntaxKind.NeverKeyword) {
			const inner = this.typeOf(e.expression).replace(/[?!]$/, ''),
				want = target.replace(/[?!]$/, '');
			if (['String', 'Double', 'Bool'].includes(want) && ['String', 'Double', 'Bool'].includes(inner) && inner !== want) return `${lenientReader(want)}(${this.expr(e.expression)} as Any?)`;
			return this.coerce(e.expression, target);
		}
		// Lenient code's `let cell;` is untyped, as its own build reads it: the slot's type is read from the value, whatever class the checker narrowed it to.
		if (this.lenient && ts.isIdentifier(e) && !isWriteTarget(e) && !isUntyped(spelledType(target))) {
			const d = this.resolve(e)?.valueDeclaration;
			if (d && ts.isVariableDeclaration(d) && !d.type && !d.initializer && isUntyped(spelledType(this.declaredTypeOf(e))) && this.typeOf(e) !== target) {
				const read = this.throwingConverts(() => this.fromAny(this.refName(e), target), this.libraryThrowsHere(e), e);
				return this.nullableRef(target) !== target && !this.looseTolerated(e) ? this.presentCode(read, target) : read;
			}
		}
		const saved: [boolean, ts.Expression | null] = [this.optionalSlot, this.presentFunction];
		this.optionalSlot = this.lenient && this.looseTolerated(e) && !this.presentSlot;
		this.presentSlot = false;
		this.presentFunction = this.declaredFunction(e) ? e : null;
		let code: string;
		try {
			code = this.keptOptional(this.coerced(e, target), target);
		} finally {
			[this.optionalSlot, this.presentFunction] = saved;
		}
		return this.lenient && this.nullableRef(target) !== target && !this.looseTolerated(e) ? this.presentCode(code, target) : code;
	},

	/**
	 * Lenient code: a value converted to an object type (`jsImplicit(x as? T)`, a function cell's `implicit`) where Swift
	 * needs it present: the checked form, which throws JavaScript's TypeError where it is missing or of another class.
	 */
	presentCode(this: Translator, code: string, type: string): string {
		const inner = this.marks.afterTry(code);
		return this.presentValue(inner !== null ? this.marks.tried(inner) : this.marks.valued(code), type).code;
	},

	presentValue(this: Translator, v: Value, type: string): Value {
		if (v.mark?.op === 'try') {
			const present = this.presentValue(v.mark.of, type);
			return present.code === v.mark.of.code ? v : this.marks.tried(present.code);
		}
		return this.marks.valued(this.presentUnmarked(v.code));
	},

	presentUnmarked(this: Translator, code: string): string {
		const c = this.marks.markOf(code);
		let now = code;
		if (c?.op === 'cast' && c.implicit && c.spelled) {
			if (c.optional && !c.up && /^(?:[\w.]+|\[[^\[\]]*\])$/.test(c.spelled)) now = `(${RT.jsCastPresent}(${c.of.code}) as ${c.spelled})`;
			else if (c.up && /^[\w.]+$/.test(c.spelled)) now = this.marks.helper('jsObjectRequired', `${c.of.code} as ${c.spelled}?`);
			else now = this.marks.helper('jsObjectRequired', this.marks.implicitInner(code)!);
		} else if (c?.op === 'implicit') now = c.cell ? `${c.cell}.present(${code})` : this.marks.helper('jsObjectRequired', c.of.code);
		else if (c?.op === 'helper' && c.name === 'jsForeign') now = `${RT.jsForeignPresent}(${c.of.code}${c.rest})`;
		else if (c?.op === 'helper' && c.name === 'jsArrayOrNil') now = this.marks.helper('jsObjectRequired', code);
		return now;
	},

	/** An optional the read unwraps (a native property TypeScript declares non-null), kept optional where one is held. */
	keptOptional(this: Translator, code: string, held: string): string {
		if (!this.lenient || !(isOptional(held) || held.endsWith('!')) || isUntyped(spelledType(held))) return code;
		const c = this.marks.markOf(code),
			unwrap = c?.op === 'try' ? c.of.mark : c;
		// A chain of reads and calls (`try jsUnwrap(app, "getRootView").getRootView()!`): its last unwrap is the whole value's.
		return unwrap?.op !== 'unwrap' || !postfixChain(unwrap.of.code) ? code : c?.op === 'try' ? this.marks.tryCode(unwrap.of.code) : unwrap.of.code;
	},

	coerced(this: Translator, e: ts.Expression, target: string): string {
		if (this.isSwiftComputedProperty(e) && /^Signal<.*>[?!]?$/.test(target)) {
			const inner = target.replace(/[?!]$/, '').slice(7, -1);
			return `Signal<${inner}>(computing: { ${this.marks.tryBefore(this.tryPrefix(e), this.coerce(e, inner))} })`;
		}
		// An either-class value (NativeAPI.either) where one of its classes is taken: the object as it.
		const either = /^NSObject[?!]?$/.test(this.typeOf(e)) ? this.native.either(this.checker.getTypeAtLocation(e)) : null;
		const one = target.replace(/[?!]$/, '');
		if (either && one !== 'NSObject' && either.some((c) => c.cls.swift === one)) {
			const code = this.expr(e);
			// Lenient code's narrowed value is cast already, optional as it holds it (see `narrowCast`).
			if (this.lenient && this.marks.alreadyAs(code, one)) return code;
			return this.marks.castCode(code, one, isOptional(target) ? 'as?' : 'as!');
		}
		// A match where an array of strings is wanted (`return s.match(/x/g)` declared `string[]`).
		if (/^JSArray<String>[?!]?$/.test(target) && /^JSMatch[?!]?$/.test(this.typeOf(e))) return this.convert(this.expr(e), 'JSMatch?', target);
		// A member of an untyped object where any value goes: the value as it is, undefined staying undefined
		// (`{ iterations: definition.iterations }`), not converted to the number or string TypeScript declares.
		if (isUntyped(spelledType(target)) && this.lenient) {
			let read: ts.Expression = e;
			while (ts.isParenthesizedExpression(read)) read = read.expression;
			if (ts.isPropertyAccessExpression(read) && !read.questionDotToken && ['Double', 'String', 'Bool'].includes(this.typeOf(read))) {
				const code = this.expr(read);
				const raw = this.marks.lenientGet(code);
				if (raw) return raw.mark?.op === 'try' ? `(${raw.code})` : raw.code;
				// A number member declared optional, which a typed object holds as NaN while unset: undefined.
				if (this.typeOf(read) === 'Double' && this.optionalMember(read)) return `{ (__n: Double) -> Any? in __n.isNaN ? nil : __n }(${code})`;
			}
			const raw = this.untypedMemberValue(read);
			if (raw) return raw;
		}
		// A weak reference's target (`weakRef.get()`, typed present) where a value must be: a TypeError's where it is gone.
		{
			let b: ts.Expression = e;
			while (ts.isParenthesizedExpression(b)) b = b.expression;
			if (ts.isCallExpression(b) && ts.isPropertyAccessExpression(b.expression) && ['get', 'deref'].includes(b.expression.name.text) && !b.expression.questionDotToken && isKit(spelledType(this.typeOf(b.expression.expression).replace(/[?!]$/, '')), 'JSWeakRef') && !/[?!]$/.test(target) && !isUntyped(spelledType(target)) && !this.typeOf(b).endsWith('?')) return this.marks.unwrappedCode(this.expr(e));
		}
		// A Promise executor's resolve passed on as a function: a function of the promise's value type.
		const resolvers = ts.isIdentifier(e) ? this.resolvers.get(this.resolve(e)!) : undefined;
		if (resolvers && (isUntyped(spelledType(target)) || functionParts(target.replace(/^\((.*)\)[?!]$/, '$1')))) {
			const own = `(${resolvers.type === 'Void' ? '' : resolvers.type}) throws -> Void`;
			const fn = resolvers.type === 'Void' ? `{ ${resolvers.name}.resolve() }` : this.expr(e);
			return isUntyped(spelledType(target)) ? this.boxFunction(fn, own) : this.convert(fn, own, target);
		}
		// A value declared `T | undefined` where a `T` goes (`scrollEnabled = this._scrollWasEnabled`): undefined reads as it converts.
		if ((target === 'Bool' || target === 'String' || target === 'Double') && this.typeOf(e) === `${target}?` && this.holdsUndefined(e)) {
			const field = this.states.placedField(e);
			return field ? this.marks.tryCode(`${RT.jsRequired}(${this.expr(e)}, ${swiftString(field.name)})`) : this.undefinedAs(this.expr(e), target);
		}
		// A `lenientNullField` read where a string, number or boolean goes: its null as lenient code places null there.
		if ((target === 'Bool' || target === 'String' || target === 'Double') && this.typeOf(e) === `${target}?` && this.states.lenientNullField(ts.skipOuterExpressions(e))) return `(${this.expr(e)} ?? ${this.zero(target)})`;
		const inner = ts.isParenthesizedExpression(e) ? ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses) : null;
		if (inner && (target === 'Bool' || target === 'String' || target === 'Double') && this.typeOf(inner) === `${target}?` && this.holdsUndefined(inner)) {
			const field = this.states.placedField(inner);
			if (field) return this.marks.tryCode(`${RT.jsRequired}(${this.expr(inner)}, ${swiftString(field.name)})`);
		}
		// An iterable where the type names only its iteration: the kit's iterable of it.
		const iterableSlot = /^JS(Async)?Iterable<.*>\??$/.exec(target);
		if (iterableSlot && !/^JS(Async)?(Iterable|Iterator|Generator)</.test(this.typeOf(e))) return `${iterableSlot[1] ? RT.jsAsyncIterable : RT.jsIterable}(${this.expr(e)}${!iterableSlot[1] && isUntyped(spelledType(this.typeOf(e))) ? `, ${swiftString(notIterable(e))}` : ''})`;
		if (ts.isNewExpression(e) && ts.isIdentifier(e.expression) && ['Map', 'Set'].includes(e.expression.text) && !e.arguments?.length && /^JS(Map|Set)</.test(target.replace(/\?$/, ''))) return `${target.replace(/\?$/, '')}()`;
		// `[]` where an array of a type is wanted is an empty array of it.
		let bare: ts.Expression = e;
		while (ts.isParenthesizedExpression(bare) || ts.isAsExpression(bare)) bare = bare.expression;
		if (ts.isArrayLiteralExpression(bare) && !bare.elements.length && /^JSArray<.*>$/.test(target.replace(/\?$/, ''))) return `${target.replace(/\?$/, '')}()`;
		if (ts.isArrayLiteralExpression(bare) && /^JSArray<(String|Double|Bool)\?>$/.test(target) && this.typeOf(bare) === target.replace('?>', '>')) return this.array(bare, target);
		// An empty array held as a map from number to value (`numberKeyedArray`): an empty record.
		if (/^JSRecord<.*>$/.test(target) && ((ts.isArrayLiteralExpression(bare) && !bare.elements.length) || (ts.isNewExpression(bare) && ts.isIdentifier(bare.expression) && bare.expression.text === 'Array' && !bare.arguments?.length))) return `${target}()`;
		// An array literal where any value may go holds any value: script may store a string in `const list: any = [1, 2]`,
		// or in `{ list: [1] }` of an untyped object.
		const untypedMember = ts.isPropertyAssignment(bare.parent) && this.dynamicLiterals.has(bare.parent.parent);
		const ctx = this.checker.getContextualType(bare);
		if (ts.isArrayLiteralExpression(bare) && isUntyped(spelledType(target)) && !ts.isAsExpression(e) && ((untypedMember && (!ctx || !!(ctx.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) || !this.checker.isArrayType(ctx))) || !!(ctx?.flags! & ts.TypeFlags.Any))) return this.array(bare, 'JSArray<Any?>');
		// An array of tuples where the slot's type has them typed (`[[property, color]]` for `[any, any][]` returned as `[CssProperty, Color][]`).
		const tuples = /^(JSArray<)?(\(.*\))>?$/.exec(target.replace(/\?$/, ''));
		const arity = tuples && !hasTopLevelArrow(tuples[2]) ? splitTopLevel(tuples[2].slice(1, -1)).length : 0;
		const fits = (x: ts.Expression) => ts.isArrayLiteralExpression(x) && x.elements.length === arity && !x.elements.some(ts.isSpreadElement);
		if (ts.isArrayLiteralExpression(bare) && arity > 1 && (tuples![1] ? bare.elements.every(fits) : fits(bare))) return this.array(bare, target.replace(/\?$/, ''));
		// A pair the checker types as a tuple (its slot iterable of tuples, as `Headers` is) where an array or untyped value is wanted: made as the array.
		if (ts.isArrayLiteralExpression(bare) && (/^JSArray<.+>$/.test(target.replace(/[?!]$/, '')) || (this.pluginFiles.size > 0 && isUntyped(spelledType(target)))) && /^\(.*\)$/.test(this.typeOf(bare)) && !functionParts(this.typeOf(bare)) && !bare.elements.some(ts.isSpreadElement)) return this.array(bare, isUntyped(spelledType(target)) ? 'JSArray<Any?>' : target.replace(/[?!]$/, ''));
		// Branches typed otherwise than where the value goes: each as it is taken.
		if (ts.isConditionalExpression(bare) && tuples && arity > 1 && this.typeOf(bare) !== target && ![bare.whenTrue, bare.whenFalse].some(isNullish)) {
			return `(${this.cond(bare.condition)} ? ${this.coerce(bare.whenTrue, target)} : ${this.coerce(bare.whenFalse, target)})`;
		}
		// A literal of another shape than where it goes (`{ spans: [] }` held as `{ spans: any[] }`): made as that shape.
		const wanted = target.replace(/[?!]$/, '');
		if (ts.isObjectLiteralExpression(bare) && /^JSRecord<.*>$/.test(wanted)) return this.object(bare, wanted);
		const wantedShape = ts.isObjectLiteralExpression(bare) && /^Object_\w+$/.test(wanted) && wanted !== this.typeOf(bare).replace(/[?!]$/, '') ? this.shapes.named(wanted) : undefined;
		// A literal where Swift types the slot as an app interface, or a result interface of core's: made as it, whatever the
		// checker's contextual type (an untyped slot, `(m ??= new Map()).set(k, { … })`; an async function's result, `T | PromiseLike<T>`).
		if (ts.isObjectLiteralExpression(bare) && !this.subst.has(bare) && (this.appInterfaces?.some((i) => i.name === wanted) || (this.library ? resultShapeNamed(this, wanted) : this.core.viewable(wanted)))) return this.object(bare, wanted);
		if (wantedShape && (bare as ts.ObjectLiteralExpression).properties.every((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && wantedShape.fields.some((f) => f.name === (literalKey(p.name, this.checker) ?? p.name.getText())))) {
			return this.object(bare as ts.ObjectLiteralExpression, wanted);
		}
		// `new WeakRef(button)` where a reference to its base class is taken: a reference of that type.
		const weak = /^JSWeakRef<(.+)>[?!]?$/.exec(target)?.[1];
		if (weak && ts.isNewExpression(bare) && ts.isIdentifier(bare.expression) && bare.expression.text === 'WeakRef' && bare.arguments?.length === 1 && this.typeOf(bare) !== target.replace(/[?!]$/, '')) {
			return `JSWeakRef<${weak}>(${this.coerce(bare.arguments[0], weak)})`;
		}
		// `new Array<Base>()` where an array of a subclass is wanted: an empty array of it.
		if (ts.isNewExpression(bare) && ts.isIdentifier(bare.expression) && bare.expression.text === 'Array' && !bare.arguments?.length && /^JSArray<.*>[?!]?$/.test(target)) return `${target.replace(/[?!]$/, '')}()`;
		// Lenient code passing null or undefined where a string, number or boolean is declared: the type's zero, as such a slot reads it.
		// Library code's undefined number is NaN, as its fields without a value hold it and `x === undefined` tests it.
		if (this.lenient && target === 'Double' && isNullish(bare) && bare.kind !== ts.SyntaxKind.NullKeyword) {
			heldLoss('nullishLiteral', '.nan', { node: bare });
			return '.nan';
		}
		if ((this.lenient || this.lenientApp) && isNullish(bare) && ['String', 'Double', 'Bool'].includes(target)) {
			heldLoss('nullishLiteral', this.zero(target)!, { node: bare });
			return this.zero(target)!;
		}
		// Null where a native struct is declared: its zero value, as the iOS runtime marshals null for one.
		if (this.lenient && isNullish(bare) && this.native.isStructType(target)) return `${target}()`;
		// Null where a native enum is declared: the iOS runtime marshals it as 0.
		if (this.lenient && isNullish(bare) && this.native.isEnumType(target)) return this.native.isOptionSetType(target) ? '[]' : this.native.enumFromNumber('0', target);
		// Library mode: an object literal of an event type is core's EventData over it.
		if (this.library && ts.isObjectLiteralExpression(bare) && isNamed(spelledType(target), 'EventData')) return `EventData(jsObject: ${this.coerce(e, 'Any?')})`;
		// A function literal where its slot takes the arguments as a rest (`callback: (...args: any[]) => void`): each of its parameters from the list.
		const restSlot = functionParts(target.replace(/^\((.*)\)[?!]$/, '$1'));
		if ((ts.isArrowFunction(bare) || ts.isFunctionExpression(bare)) && restSlot && restSlot.rest >= 0 && !bare.parameters.some((p) => p.dotDotDotToken) && !this.carriesMethod(bare) && !this.takesRestArray(bare)) {
			const own = functionParts(this.closureType(bare));
			if (own && own.params.length >= restSlot.rest) {
				const fixed = restSlot.params.slice(0, restSlot.rest).map((p, k) => `__q${k}: ${p.replace(/^@escaping /, '')}`);
				const args = own.params.map((p, k) => (k < restSlot.rest ? this.convert(`__q${k}`, restSlot.params[k].replace(/^@escaping /, ''), p.replace(/^@escaping /, '')) : this.fromAnyCode(`${RT.jsArg}(__r.storage, ${k - restSlot.rest})`, p.replace(/^@escaping /, ''), true)));
				const call = this.marks.tryCode(`(${this.expr(e)})(${args.join(', ')})`);
				return `{ (${[...fixed, `__r: JSArray<Any?>`].join(', ')}) throws -> ${restSlot.result} in ${restSlot.result === 'Void' ? `_ = ${call}` : `return ${this.convert(call, own.result, restSlot.result)}`} }`;
			}
		}
		// Library mode: a function literal for a slot an erased generic types otherwise (`(value: Span) => …` where `(Any?) -> Void` is taken): adapted.
		// Elsewhere where Swift does not convert the function itself: a typed parameter where the slot passes any value,
		// or one declared as an array where the slot passes a tuple (`(views: View[])` for `[T, Page]`).
		const targetFn = unwrapFunction(target);
		if ((ts.isArrowFunction(bare) || ts.isFunctionExpression(bare)) && !this.carriesMethod(bare) && functionParts(targetFn)) {
			const own = this.closureType(bare);
			const want = functionParts(targetFn)!,
				have = functionParts(own);
			const p = (t: string) => t.replace(/^@escaping /, '');
			const differs = (t: string, k: number) => p(t) !== p(want.params[k]) && (this.library || isUntyped(spelledType(p(want.params[k]))) || (/^\(.*\)$/.test(p(want.params[k])) && !functionParts(p(want.params[k])) && /^JSArray</.test(p(t))));
			if (have && have.params.length <= want.params.length && (have.params.some(differs) || (this.pluginFiles.has(e.getSourceFile().fileName) && isUntyped(spelledType(want.result)) && !isUntyped(spelledType(have.result))))) return this.convert(this.expr(e), own, targetFn);
		}
		// An async function where a function returning nothing is wanted (a callback typed `() => void`): its promise is dropped.
		const want = functionParts(unwrapFunction(target)),
			have = functionParts(unwrapFunction(this.typeOf(e)));
		const own = want && have && want.result === 'Void' && /^JSPromise</.test(have.result) && (ts.isArrowFunction(bare) || ts.isFunctionExpression(bare)) ? functionParts(this.closureType(bare)) : null;
		if (want && have && want.result === 'Void' && /^JSPromise</.test(have.result) && want.params.length === (own ?? have).params.length) {
			const names = want.params.map((_, k) => `__p${k}`);
			const takes = own && own.params.length === want.params.length ? own.params : have.params;
			const args = names.map((n, k) => {
				const [from, to] = [want.params[k].replace(/^@escaping /, ''), takes[k].replace(/^@escaping /, '')];
				const code = this.convert(n, from, to);
				// Lenient code's optional callback where the function takes one: implicitly unwrapped, as lenient code holds it.
				return code === n && isOptional(from) && !isOptional(to) && !isUntyped(spelledType(to)) ? this.marks.unwrappedCode(n) : code;
			});
			return `{ (${want.params.map((p, k) => `${names[k]}: ${p}`).join(', ')}) throws -> Void in _ = try (${this.expr(e)})(${args.join(', ')}) }`;
		}
		// An array of a type where an array of any value is wanted: the one array.
		if (target === 'JSArray<Any?>' && /^JSArray<.*>$/.test(this.typeOf(e)) && this.typeOf(e) !== 'JSArray<Any?>') {
			// Lenient code's array may be undefined where an optional one is taken: it stays undefined.
			const loose = this.loose(e) && this.looseTolerated(e);
			const shared = this.untypedArray(loose ? `${this.expr(e)} as ${this.typeOf(e)}?` : this.expr(e), this.typeOf(e), target, loose);
			if (shared) return shared;
			if (loose) return `(${this.expr(e)} as ${this.typeOf(e)}?).map { JSArray<Any?>($0.storage.map { $0 as Any? }) }`;
			return `JSArray<Any?>(${this.expr(e)}.storage.map { $0 as Any? })`;
		}
		// Narrowed to `never` (a branch the checker deems unreachable, which lenient code still takes): as declared where that is the type wanted
		// (`typeof index !== 'number'` of an optional number), otherwise untyped, as it may hold anything.
		const narrowedOut = this.typeOf(e) === 'Never' && !ts.isCallExpression(bare) && !ts.isThrowStatement(e.parent);
		const declaredOut = narrowedOut ? this.declaredTypeOf(bare) : null;
		const source = narrowedOut ? (declaredOut && declaredOut.replace(/[?!]$/, '') === target.replace(/[?!]$/, '') ? declaredOut : 'Any?') : this.typeOf(e);
		// An untyped array where an array of a type is wanted: its elements as that type, in a new array.
		if (source === 'JSArray<Any?>' && /^JSArray<.+>$/.test(target) && target !== source && !ts.isArrayLiteralExpression(bare)) return this.arrayOf(this.expr(e), target.slice(8, -1));
		if (isOptional(target) && !isUntyped(spelledType(target)) && source === 'Void' && !isNullish(bare)) {
			return `(${RT.jsUndefined}(${this.expr(e)}) as? ${target.replace(/^\((.*)\)\?$/, '$1').replace(/\?$/, '')})`;
		}
		if (target.endsWith('?') && !isUntyped(spelledType(target)) && !source.endsWith('?')) {
			const maybe = this.maybeUndefined(e);
			if (maybe) return maybe;
		}
		const box = isUntyped(spelledType(target)) ? this.boxStep(source) : null;
		if (box?.composite === 'enum') return this.untypedEnum(this.expr(e), source);
		const timer = box ? this.timerFunction(bare) : null;
		if (timer) return timer;
		if (box) {
			// Null kept as untyped values hold it, apart from undefined.
			if (bare.kind === ts.SyntaxKind.NullKeyword) return 'jsNull';
			if (box.composite === 'void' && source === 'Void' && !isNullish(bare)) return `${RT.jsUndefined}(${this.expr(e)})`;
			// A function with a rest parameter (`function count(...args)`) held untyped: called by script, it takes the rest of the arguments.
			const fnType = box.composite === 'function' && !source.endsWith('?') && hasTopLevelArrow(source) ? functionParts(source.replace(/^\((.*)\)!?$/, '$1')) : null;
			if (fnType && (ts.isIdentifier(bare) || ts.isPropertyAccessExpression(bare))) {
				const signature = this.checker.getSignaturesOfType(this.checker.getNonNullableType(this.checker.getTypeAtLocation(bare)), ts.SignatureKind.Call)[0];
				const restAt = signature?.getParameters().findIndex((p) => !!p.valueDeclaration && ts.isParameter(p.valueDeclaration) && !!p.valueDeclaration.dotDotDotToken) ?? -1;
				if (restAt >= 0) return this.boxFunction(this.expr(e), fnType.text, restAt);
			}
			// A Promise executor's resolve held untyped: a function resolving the promise.
			const resolvers = ts.isIdentifier(bare) ? this.resolvers.get(this.resolve(bare)!) : undefined;
			if (resolvers) return `({ (__a: [Any?]) throws -> Any? in ${resolvers.name}.resolve(${resolvers.type === 'Void' ? '' : this.fromAnyCode(`${RT.jsArg}(__a, 0)`, resolvers.type, true)}); return nil } as JSFunction)`;
			if (ts.isConditionalExpression(bare) && ([bare.whenTrue, bare.whenFalse].some((x) => x.kind === ts.SyntaxKind.NullKeyword) || this.states.nullBranches(bare))) {
				return `(${this.cond(bare.condition)} ? ${this.coerce(bare.whenTrue, 'Any?')} : ${this.coerce(bare.whenFalse, 'Any?')})`;
			}
			// A number literal branch takes the conditional's type, which an untyped context would make Swift's `Int`.
			if (ts.isConditionalExpression(bare) && [bare.whenTrue, bare.whenFalse].some(numberLiteralBranch)) {
				return `(${this.cond(bare.condition)} ? (${this.coerce(bare.whenTrue, 'Any?')} as Any?) : (${this.coerce(bare.whenFalse, 'Any?')} as Any?))`;
			}
			const maybe = this.maybeUndefined(e);
			if (maybe) {
				// An optional function (`callback?: (args) => void`) held untyped is a script function, which `callback.call(…)` can call.
				const held = optionalType((this.declaredTypeOf(bare) ?? source).replace(/[?!]$/, ''));
				return functionParts(held.replace(/^\((.*)\)\?$/, '$1')) ? this.convert(maybe, held, 'Any?') : this.marks.castCode(maybe, 'Any', 'as');
			}
			if (source === 'Double' && numericLiteralOnly(e)) return `Double(${this.expr(e)})`;
			// A method value or `arguments`-reading function expression placed untyped is a JSMethod.
			if (ts.isFunctionExpression(bare) && this.carriesMethod(bare)) return this.expr(e);
			if (ts.isFunctionExpression(bare) && this.readsArguments(bare)) return this.library ? this.expr(e) : this.methodValue(bare);
			if (ts.isFunctionExpression(bare) && takesReceiver(bare)) return this.methodValue(bare);
			if (ts.isPropertyAccessExpression(bare) && bare.expression.kind === ts.SyntaxKind.SuperKeyword && this.isInstanceMethod(bare.name)) return 'nil';
			const parse = ts.isIdentifier(bare) ? this.parseFunction(bare) : null;
			if (parse) return this.boxFunction(parse.code, parse.type);
			if (ts.isIdentifier(bare) && ['String', 'Number', 'Boolean'].includes(bare.text) && isLibDeclaration(this.resolve(bare)?.declarations?.[0])) return `js${bare.text}Constructor`;
			// A choice between functions: each boxed as it is.
			if (ts.isConditionalExpression(bare) && [bare.whenTrue, bare.whenFalse].some((x) => ts.isFunctionExpression(x) || ts.isArrowFunction(x) || (ts.isPropertyAccessExpression(x) && x.expression.kind === ts.SyntaxKind.SuperKeyword))) {
				return `(${this.cond(bare.condition)} ? ${this.coerce(bare.whenTrue, 'Any?')} : ${this.coerce(bare.whenFalse, 'Any?')})`;
			}
			if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
				const rest = e.parameters.findIndex((p) => p.dotDotDotToken);
				return rest < 0 ? this.convert(this.expr(e), this.closureType(e), 'Any?') : this.boxFunction(this.expr(e), this.closureType(e), rest);
			}
			if (box.composite === 'function' && functionParts(unwrapFunction(source, false))) {
				const sym = ts.isIdentifier(bare) ? this.resolve(bare) : undefined;
				// An overloaded function is its implementation.
				const d = sym?.valueDeclaration && ts.isFunctionDeclaration(sym.valueDeclaration) && !sym.valueDeclaration.body ? (sym.declarations?.find((x) => ts.isFunctionDeclaration(x) && !!x.body) ?? sym.valueDeclaration) : sym?.valueDeclaration;
				if (d && ts.isFunctionDeclaration(d) && d.body && !d.getSourceFile().isDeclarationFile && !this.takesThis(d)) return this.boxDeclared(this.expr(e), d);
				return this.convert(this.expr(e), d ? this.boxedGeneric(d, ts.isFunctionDeclaration(d) && d.body && !d.getSourceFile().isDeclarationFile ? escapingFunction(functionParts(this.functionValueType(d))!) : source) : source, 'Any?');
			}
			if (/^\(.*\)$/.test(source) && !functionParts(source)) return this.convert(this.expr(e), source, 'Any?');
			// An object read with an unwrap (`view.parent!`) is undefined where it is missing, as an untyped value can be.
			const code = this.expr(e);
			return this.marks.isUnwrap(code) && this.isObjectRef(e) ? this.marks.unwrapInner(code)! : code;
		}
		// A number where Swift has a native enum or option set (`UIMenuOptions.A | UIMenuOptions.B`).
		if (source === 'Double' && target !== 'Double' && this.native.isEnumType(target.replace(/\?$/, ''))) return this.native.enumFromNumber(this.expr(e), target);
		// A native enum or option set where a number is wanted: its raw value; a missing one is undefined, NaN as a number.
		const enumBase = source.replace(/[?!]$/, '');
		if ((target === 'Double' || target === 'Double?') && enumBase !== 'Double' && this.native.isEnumType(enumBase)) {
			const code = this.expr(e);
			if (source === enumBase) return `Double(${code}.rawValue)`;
			return target === 'Double?' ? `(${code}).map { Double($0.rawValue) }` : `((${code}).map { Double($0.rawValue) } ?? .nan)`;
		}
		// A value TypeScript's strict typing calls possibly undefined where the code expects one (`map.get(k)` after `has(k)`).
		// Lenient code: undefined passed where a string is declared stays falsy, as the string's zero.
		if (this.lenient && target === 'String' && source === 'String?') return `(${this.expr(e)} ?? "")`;
		if (source === optionalType(target) && !isUntyped(spelledType(target)) && !target.endsWith('?') && !isFunctionType(target)) {
			const field = this.states.placedField(e);
			const code = this.expr(e),
				m = this.marks.markOf(code);
			return field ? this.marks.tryCode(`${RT.jsRequired}(${m?.op === 'unwrap' ? m.of.code : code}, ${swiftString(field.name)})`) : this.undefinedAs(code, target, source);
		}
		// Lenient code: a library call Swift gives as optional (`map.get(k)`), which the checker reads as its value type.
		const raw = this.lenient && ts.isCallExpression(bare) && source === target && !isUntyped(spelledType(target)) && !isOptional(target) && !isFunctionType(target) ? this.maybeUndefined(bare) : null;
		if (raw) return this.undefinedAs(raw, target, this.calledType(bare as ts.CallExpression));
		// A Foundation mutable collection where Swift's bridged collection is declared (`NSDictionary` returned as an `NSMutableDictionary`).
		if (/^NSMutable(Array|Dictionary)[?!]?$/.test(source) && /^\[.*\]$/.test(target)) return typedCollection(this.expr(e), target) ?? this.marks.castCode(this.expr(e), target, 'as!');
		// A new array of a subclass's objects where one of the base class's is wanted (`this._windows.filter(…)` as `WindowBase[]`).
		if (/^JSArray<\w+>$/.test(source) && /^JSArray<\w+>[?!]?$/.test(target) && source !== target.replace(/[?!]$/, '') && (ts.isCallExpression(bare) || ts.isArrayLiteralExpression(bare))) {
			const cast = this.classCast(this.expr(e), source, target);
			if (cast) return cast;
		}
		// A typed array where an untyped one is wanted (an erased generic's `T[]`): a literal built untyped, else a new array of its elements.
		if (!this.library && /^JSArray<Any\?>[?!]?$/.test(target) && /^JSArray<.+>[?!]?$/.test(source) && !isNamed(spelledType(source), 'JSArray<Any?>')) {
			if (ts.isArrayLiteralExpression(bare) && !bare.elements.some(ts.isSpreadElement)) return this.array(bare, 'JSArray<Any?>');
			return this.convert(this.expr(e), source, target);
		}
		// An array of typed promises where an array of untyped promises is wanted (`Promise<void>[]` as `Promise<unknown>[]`).
		if (!this.library && /^JSArray<JSPromise<.+>>[?!]?$/.test(source) && /^JSArray<JSPromise<Any\?>>[?!]?$/.test(target) && !/^JSArray<JSPromise<Any\?>>[?!]?$/.test(source)) {
			const fromPromise = source.replace(/^JSArray<(.*)>[?!]?$/, '$1');
			return `(${this.expr(e)} as ${source.replace(/[?!]$/, '')}).map { ${this.convert('$0', fromPromise, 'JSPromise<Any?>')} }`;
		}
		// A Set or Array whose elements Swift held optional (`optionalElements`), placed where non-optional elements are declared.
		if (!this.library && source !== target && source === optionalElementsType(target) && /^JS(Set|Array)<.+>\??$/.test(target)) {
			const el = target.replace(/^JS(?:Set|Array)<(.*)>\??$/, '$1');
			if (!isUntyped(spelledType(el))) {
				const kind = target.startsWith('JSSet<') ? 'JSSet' : 'JSArray';
				return `${kind}<${el}>(${this.expr(e)}.map { ${this.undefinedAs('$0', el, optionalType(el))} })`;
			}
		}
		if (/^JSPromise<(Any\?|JSArray<Any\?>)>$/.test(source) && /^JSPromise<.*>[?!]?$/.test(target) && source !== target.replace(/[?!]$/, '')) {
			const all = ts.isCallExpression(bare) && ts.isPropertyAccessExpression(bare.expression) && bare.expression.name.text === 'all' && ts.isIdentifier(bare.expression.expression) && bare.expression.expression.text === 'Promise' && isLibGlobal(this, bare.expression.expression) && bare.arguments.length === 1 && !ts.isArrayLiteralExpression(bare.arguments[0]) ? bare : null;
			return all ? this.untypedAll(all.arguments[0], target) : this.convert(this.expr(e), source, target);
		}
		// A map of typed values where a map of any value is wanted: its entries, in a new map of them.
		const typedMap = /^JSMap<(.+)>$/.exec(source)?.[1],
			anyMap = /^JSMap<(.+)>[?!]?$/.exec(target)?.[1];
		if (typedMap && anyMap && typedMap !== anyMap) {
			const [sk, sv] = splitTopLevel(typedMap),
				[tk, tv] = splitTopLevel(anyMap);
			if (sk === tk && isUntyped(spelledType(tv)) && !isUntyped(spelledType(sv))) return `JSMap<${tk}, Any?>(${this.expr(e)}.map { ($0.0, $0.1 as Any?) })`;
		}
		if (/^JSRecord<.+>[?!]?$/.test(source) && /^JSRecord<Any\?>[?!]?$/.test(target) && !isNamed(spelledType(source), 'JSRecord<Any?>')) return this.convert(this.expr(e), source, target);
		// A promise of a type where a promise of any value is wanted (`let p: Promise<any> = Promise.resolve()`): its value held untyped.
		if (/^JSPromise<.+>$/.test(source) && /^JSPromise<Any\?>[?!]?$/.test(target) && source !== 'JSPromise<Any?>') return this.convert(this.expr(e), source, 'JSPromise<Any?>');
		if ((/^Rx(?:Observable|Subject|BehaviorSubject|ReplaySubject)<.+>[?!]?$/.test(source) && /^RxObservable<.+>[?!]?$/.test(target)) || (/^Signal<.+>[?!]?$/.test(source) && /^Signal<.+>[?!]?$/.test(target))) return this.convert(this.expr(e), source, target);
		const spread = source !== target ? (this.restFunction(e, source, target) ?? this.defaultedFunction(e, source, target)) : null;
		if (spread) return spread;
		// A function declaration giving undefined where its type says a value (lenient code): its Swift result is optional.
		const member = ts.isPropertyAccessExpression(bare) ? this.resolve(bare.name)?.valueDeclaration : undefined;
		const fnDecl = ts.isIdentifier(bare) ? this.resolve(bare)?.valueDeclaration : member && !member.getSourceFile().isDeclarationFile ? member : undefined;
		if (fnDecl && ts.isFunctionDeclaration(fnDecl) && functionParts(unwrapFunction(target, false))) {
			const actual = this.functionValueType(fnDecl);
			if (actual !== target) return this.convert(this.expr(e), actual, target);
		}
		if (source !== target && !ts.isArrowFunction(ts.skipParentheses(e)) && !ts.isFunctionExpression(ts.skipParentheses(e)) && functionParts(unwrapFunction(source, false)) && functionParts(unwrapFunction(target, false))) {
			// An optional member (`closeCallback?: …`) holds undefined, which the checker without strictNullChecks leaves out of its type.
			const optionalMember = !!member && (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) && !!member.questionToken && !/[?!]$/.test(source);
			// So does an optional parameter (`cb?: …`) it is given to.
			const call = ts.isCallExpression(e.parent) || ts.isNewExpression(e.parent) ? e.parent : undefined;
			const at = call?.arguments?.indexOf(e) ?? -1;
			const sig = at >= 0 ? this.checker.getResolvedSignature(call!)?.getDeclaration() : undefined;
			const param = sig && !ts.isJSDocSignature(sig) ? sig.parameters[at] : undefined;
			const optionalParam = !!param && !param.dotDotDotToken && !!(param.questionToken || param.initializer) && !/[?!]$/.test(target);
			return this.convert(this.expr(e), optionalMember ? `(${source})?` : source, optionalParam ? `(${target})?` : target);
		}
		if (isUntyped(spelledType(source)) && target !== 'Void') {
			if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return this.expr(e);
			const code = this.expr(e);
			return this.throwingConverts(() => this.fromAnyChecked(code, target, this.castThrows(e)).code, this.libraryThrowsHere(e), e);
		}
		// Library mode: an object of a literal's shape where a class object literals are typed as goes (`{ ...args, delay: undefined }` as AnimationInfo): one made of its fields.
		const make = !(ts.isObjectLiteralExpression(bare) && literalClassOf(this, bare)) ? this.shapeToClass(source.replace(/[?!]$/, ''), target.replace(/[?!]$/, '')) : null;
		if (make) return source.endsWith('?') ? `(${this.expr(e)}).map(${make})` : this.loose(e) && this.looseTolerated(e) ? `${RT.jsImplicit}(${this.expr(e)}).map(${make})` : `${make}(${this.expr(e)})`;
		// An array of such objects where an array of the class is taken: each made so.
		const elements = /^JSArray<(Object_\w+)>\??$/.exec(source)?.[1];
		const each = elements && this.shapeToClass(elements, /^JSArray<(\w+)>\??$/.exec(target)?.[1] ?? '');
		const missing = isOptional(source) || (this.lenient && ts.isConditionalExpression(bare) && [bare.whenTrue, bare.whenFalse].some(isNullish));
		if (each) return missing ? `(${this.expr(e)})?.map(${each})` : `${this.expr(e)}.map(${each})`;
		// Library mode: a class where a subclass is declared (`this` of ViewCommon where core's declarations say View).
		if ((this.library || this.pluginFiles.has(e.getSourceFile().fileName)) && this.isSubclassOf(target.replace(/[?!]$/, ''), source.replace(/[?!]$/, ''))) {
			// Lenient code's object may be missing (`measureChild(this, this.layoutView, …)`): it stays missing.
			if ((this.lenient || source.endsWith('!')) && !target.endsWith('?') && !source.endsWith('?')) return this.marks.castCode(this.expr(e), target.replace(/[?!]$/, ''), 'as?', true);
			return `(${this.expr(e)} as${target.endsWith('?') || source.endsWith('?') ? '?' : '!'} ${target.replace(/[?!]$/, '')})`;
		}
		// A class's object, or a class, that an object type reads by name (`ValueStates.viewedClass`, `viewedStatics`): a view of it.
		const viewedFrom = this.classNamed(source.replace(/[?!]$/, ''));
		if (viewedFrom && this.states.viewedClass(viewedFrom) && source.replace(/[?!]$/, '') !== target.replace(/[?!]$/, '') && this.isObjectShape(target.replace(/[?!]$/, ''))) return this.convert(this.expr(e), source, target);
		// A class whose declared protocol was dropped by `protocolWitnesses`: wrap through `IFaceObject(jsObject:)`.
		const targetProto = target.replace(/[?!]$/, '');
		if (!this.library && viewedFrom && source.replace(/[?!]$/, '') !== targetProto && this.protocols.has(targetProto) && this.facts.hasInterface(this, this.interfaces, (d, s) => this.topName(d, s), targetProto) && !this.conformsToProtocol(viewedFrom, targetProto)) {
			const wrapped = `${targetProto}Object(jsObject: ${this.expr(e)})`;
			return isOptional(source) || source.endsWith('!') ? this.marks.unwrappedIf(`(${this.expr(e)}).map { ${targetProto}Object(jsObject: $0) }`, !(isOptional(target) || target.endsWith('!'))) : wrapped;
		}
		const viewedStatics = /^(\w+)\.Type$/.exec(source)?.[1];
		if (viewedStatics && this.classNamed(viewedStatics) && this.states.viewedStatics(this.classNamed(viewedStatics)!) && /^\w+$/.test(target) && this.isObjectShape(target)) return this.viewOf(target, this.expr(e));
		// Interfaces structurally equal (`DuoFold` for `StageFold`), or a tuple where an array is wanted.
		if (source.replace(/[?!]$/, '') !== target.replace(/[?!]$/, '') && this.isObjectShape(source.replace(/[?!]$/, '')) && this.isObjectShape(target.replace(/[?!]$/, ''))) return this.convert(this.expr(e), source, target);
		if (/^\(.*\)$/.test(source) && !functionParts(source) && /^JSArray<.*>[?!]?$/.test(target)) return this.convert(this.expr(e), source, target);
		// An array literal is made of the slot's element type already.
		if (ts.isArrayLiteralExpression(bare) && /^JSArray<.+>[?!]?$/.test(source) && /^JSArray<.+>[?!]?$/.test(target) && ['elements', 'view'].includes(structural(parseNativeType(source), parseNativeType(target), this.structuralFacts())?.step ?? '')) return this.expr(e);
		if (/^JSArray<\w+>[?!]?$/.test(source) && /^JSArray<\w+>[?!]?$/.test(target) && source.replace(/[?!]$/, '') !== target.replace(/[?!]$/, '')) return this.convert(this.expr(e), source, target);
		if (!this.library && /^JSArray<.+>[?!]?$/.test(source) && /^JSArray<.+>[?!]?$/.test(target) && ['elements', 'view'].includes(structural(parseNativeType(source), parseNativeType(target), this.structuralFacts())?.step ?? '')) return this.convert(this.expr(e), source, target);
		// A non-strict app's value that may be missing (a native read typed `T | null`) where one is declared: unwrapped where used.
		if (this.lenientApp && !isUntyped(spelledType(target)) && !isOptional(target) && !target.endsWith('!') && source === optionalType(target) && !isFunctionType(target)) return this.marks.unwrappedCode(this.expr(e));
		// An object where a number or string is taken (`indexOf(x, { valueOf() { return 1 } })`): converted as script converts it, by its own valueOf or toString.
		const object = source.replace(/[?!]$/, '');
		const primitive = target.replace(/\?$/, '');
		if ((primitive === 'Double' || primitive === 'String') && (this.isObjectShape(object) || this.classNamed(object))) return `${primitive === 'Double' ? RT.jsToNumber : RT.jsToString}(${this.expr(e)})`;
		return this.expr(e);
	},

	/** An object member of an untyped object (`componentModule.component`, declared a View, an ActionItem too) where any value goes: the value itself, not cast to the class declared. */
	untypedMemberValue(this: Translator, e: ts.Expression): string | null {
		while (ts.isParenthesizedExpression(e)) e = e.expression;
		if (!this.lenient || !ts.isPropertyAccessExpression(e) || e.questionDotToken || !this.isObjectRef(e)) return null;
		// Still read from the text: its receiver of at most one level of parentheses decides the core kit's output, where the
		// read's mark would also take `jsGet((xs.element(i) ?? nil), "k")`.
		const m = this.marks.markOf(this.expr(e));
		// A checked cast is read as the conditional cast it stands for.
		const code = m?.op === 'cast' && m.checked && m.implicit ? `${RT.jsImplicit}(${m.of.code} as? ${m.spelled})` : this.expr(e);
		const raw = /^jsImplicit\(((?:try )?jsGet\([^()]*(?:\([^()]*\)[^()]*)*\)) as\? [\w.]+\)$/.exec(code);
		return raw ? (raw[1].startsWith('try ') ? `(${raw[1]})` : raw[1]) : null;
	},

	/** The library's or core's timer functions held as values (`assertNotEqual(timer.setTimeout, undefined)`): script functions calling the runtime's. */
	timerFunction(this: Translator, e: ts.Expression): string | null {
		const name = ts.isIdentifier(e) ? e : ts.isPropertyAccessExpression(e) ? e.name : null;
		const decl = name && this.resolve(name)?.declarations?.[0];
		if (!decl || !ts.isFunctionDeclaration(decl) || !decl.name || !(decl.getSourceFile().isDeclarationFile || isCoreDeclaration(decl))) return null;
		const call = `{ _ = try ${RT.jsCall}(${RT.jsArg}(__a, 0), spread: Array(__a.dropFirst(2))) }`;
		const body: Record<string, string> = {
			setTimeout: `return ${RT.jsSetTimeout}({ ${RT.jsReport} ${call} }, ${RT.jsToNumber}(${RT.jsArg}(__a, 1)))`,
			setInterval: `return ${RT.jsSetInterval}({ ${RT.jsReport} ${call} }, ${RT.jsToNumber}(${RT.jsArg}(__a, 1)))`,
			clearTimeout: `${RT.jsClearTimeout}(${RT.jsArg}(__a, 0) as? Double); return nil`,
			clearInterval: `${RT.jsClearInterval}(${RT.jsArg}(__a, 0) as? Double); return nil`,
			requestAnimationFrame: `let __f = ${RT.jsArg}(__a, 0); return ${RT.jsRequestAnimationFrame}({ __t in ${RT.jsReport} { _ = try ${RT.jsCall}(__f, __t) } })`,
			cancelAnimationFrame: `${RT.jsCancelAnimationFrame}(${RT.jsToNumber}(${RT.jsArg}(__a, 0))); return nil`,
		};
		const code = body[decl.name.text];
		return code ? `({ (__a: [Any?]) throws -> Any? in ${code} } as JSFunction)` : null;
	},

	/** A function taking a rest parameter (`(...args) => void`) where a function of fixed parameters is wanted: those past the rest's start packed into its array. */
	restFunction(this: Translator, e: ts.Expression, source: string, target: string): string | null {
		const sig = this.checker.getTypeAtLocation(e).getCallSignatures()[0];
		const last = sig?.getParameters().at(-1)?.valueDeclaration;
		if (!last || !ts.isParameter(last) || !last.dotDotDotToken) return null;
		const have = functionParts(source),
			want = functionParts(target);
		const fixed = (have?.params.length ?? 0) - 1;
		const element = have && /^JSArray<(.*)>$/.exec(have.params[fixed] ?? '')?.[1];
		if (!have || !want || want.rest >= 0 || !element || want.params.length < fixed) return null;
		const p = (t: string) => t.replace(/^@escaping /, '');
		const params = want.params.map((t, k) => `__q${k}: ${escapingParam(p(t))}`);
		const args = [
			...want.params.slice(0, fixed).map((t, k) => this.convert(`__q${k}`, p(t), p(have.params[k]))),
			`JSArray<${element}>([${want.params
				.slice(fixed)
				.map((t, k) => this.convert(`__q${fixed + k}`, p(t), element))
				.join(', ')}])`,
		];
		const call = this.marks.tryCode(`__h(${args.join(', ')})`);
		const body = want.result === 'Void' ? `_ = ${call}` : `return ${this.convert(call, have.result, want.result)}`;
		// Lenient code's function value may be missing where an optional one is held: it stays missing.
		return this.adapter(this.expr(e), escapingFunction(have), want, params, body, this.loose(e) && this.optionalSlot);
	},

	/** A declared function where a function of fewer parameters is wanted: called by name, so the rest take their defaults. */
	defaultedFunction(this: Translator, e: ts.Expression, source: string, target: string): string | null {
		if (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e)) return null;
		const decl = this.resolve(ts.isPropertyAccessExpression(e) ? e.name : e)?.valueDeclaration;
		if (!decl || !(ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)) || !decl.body || decl.getSourceFile().isDeclarationFile) return null;
		const have = functionParts(source),
			want = functionParts(target);
		if (!have || !want || want.params.length >= have.params.length || want.params.length >= decl.parameters.length) return null;
		if (!decl.parameters.slice(want.params.length).every((p) => (p.questionToken || p.initializer) && !p.dotDotDotToken)) return null;
		const p = (t: string) => t.replace(/^@escaping /, '');
		const params = want.params.map((t, k) => `__q${k}: ${escapingParam(p(t))}`);
		const callee = this.byName(() => this.expr(e));
		const call = this.marks.tryCode(`${callee}(${want.params.map((t, k) => this.convert(`__q${k}`, p(t), p(have.params[k]))).join(', ')})`);
		const body = want.result === 'Void' ? `_ = ${call}` : `return ${this.convert(call, have.result, want.result)}`;
		// A method's value (one per receiver and method), or a declared function's (`declaredValue`), is the identity the adapter takes on.
		const declared = ts.isIdentifier(e) && this.declaredFunctionRead(e) ? this.expr(e) : null;
		const value = ts.isPropertyAccessExpression(e) ? this.methodValueRead(e) : declared?.startsWith('FunctionCell_') ? declared : null;
		const hc = value ? this.functionCell(declared && ts.isFunctionDeclaration(decl) ? escapingFunction(functionParts(this.functionValueType(decl))!) : have.text) : null,
			gc = this.functionCell(want.text);
		if (!value || !hc || !gc) return `{ (${params.join(', ')}) throws -> ${want.result} in ${body} }`;
		return `{ (__i: JSFunctionAlias) -> ${want.text} in ${RT.jsIdentified}(${gc}(f: { (${params.join(', ')}) throws -> ${want.result} in ${this.keeping('__i', body, want.result)} }), __i).f }(JSFunctionAlias(cell: ${hc}(f: ${value})))`;
	},
	byName(this: Translator, f: () => string): string {
		const was = this.namedCall;
		this.namedCall = true;
		try {
			return f();
		} finally {
			this.namedCall = was;
		}
	},

	/**
	 * A value of one program class (or an array of them) read as another of its hierarchy: an
	 * object as itself, cast; an array of a subclass's objects as the one array viewed as the base's
	 * (`arrayView`), one of a base class's (or lenient code's) as a new array of its elements, Swift's
	 * generic classes not being covariant. Null when the types are not so related.
	 */
	classCast(this: Translator, code: string, from: string, to: string): string | null {
		const bare = (t: string) => t.replace(/[?!]$/, '');
		const related = (a: string, b: string) => this.isSubclassOf(a, b) || this.isSubclassOf(b, a);
		const fa = /^JSArray<(\w+)>$/.exec(bare(from))?.[1],
			ta = /^JSArray<(\w+)>$/.exec(bare(to))?.[1];
		if (fa && ta && fa !== ta && related(fa, ta)) {
			const up = this.isSubclassOf(fa, ta);
			const both = isOptional(from) && isOptional(to);
			const view = up && !this.lenient ? this.arrayView(both ? code : `${code}${/[?!]$/.test(from) ? '!' : ''}`, from, to, both) : null;
			if (view) return view;
			// Lenient code's array may be missing, which stays undefined; an element of another class is a TypeError.
			if (this.lenient) return this.marks.tryIf(!up, `${RT.jsImplicit}(${code}).map { JSArray<${ta}>(${up ? '' : 'try '}$0.storage.map { ${up ? `$0 as ${ta}` : `try (${RT.jsCastPresent}($0) as ${ta})`} }) }`);
			const map = `JSArray<${ta}>(${code}${/[?!]$/.test(from) ? '!' : ''}.storage.map { $0 as${up ? '' : '!'} ${ta} })`;
			return isOptional(from) && isOptional(to) ? `(${code}).map { JSArray<${ta}>($0.storage.map { $0 as${up ? '' : '!'} ${ta} }) }` : map;
		}
		const f = bare(from),
			t = bare(to);
		if (f !== t && /^\w+$/.test(f) && /^\w+$/.test(t) && related(f, t)) return this.isSubclassOf(f, t) ? code : `(${code} as${isOptional(to) ? '?' : '!'} ${t})`;
		return null;
	},

	/** Library mode: a function making an instance of a class object literals are typed as from an object of a literal's shape, its fields copied. */
	shapeToClass(this: Translator, source: string, target: string): string | null {
		if (!this.library || !/^Object_\w+$/.test(source)) return null;
		const cls = [...this.literalClasses()].find((c) => this.className(c) === target);
		const shape = cls && this.shapes.named(source);
		if (!cls || !shape) return null;
		const type = this.checker.getDeclaredTypeOfSymbol(this.checker.getSymbolAtLocation(cls.name!)!);
		const copies = shape.fields.flatMap((f) => {
			const d = type.getProperty(f.name)?.valueDeclaration;
			return d && ts.isPropertyDeclaration(d) && !isStatic(d) ? [`__o.${ident(f.name)} = ${this.convert(`__s.${ident(f.name)}`, f.type, this.typeOf(d.name))}`] : [];
		});
		return `{ (__s: ${source}) -> ${target} in let __o = ${target}(jsLiteral: ()); ${[...copies, 'return __o'].join('; ')} }`;
	},

	/**
	 * An object literal typed as a class: an instance made without the constructor, the literal's keys
	 * written in order. A function the literal gives for a method is the instance's own, which calls of it
	 * reach; the instance is still of the class (`instanceof` holds, unlike the literal's).
	 */
	classLiteral(this: Translator, e: ts.ObjectLiteralExpression, cls: ts.ClassDeclaration): string {
		if (cls.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword)) throw this.error(e, `an object literal of the class ${cls.name?.text} that extends another`);
		const name = this.className(cls);
		const o = this.fresh('__literal');
		const type = this.checker.getDeclaredTypeOfSymbol(this.checker.getSymbolAtLocation(cls.name!)!);
		const write = (key: string, value: ts.Expression): string => {
			const decl = type.getProperty(key)?.valueDeclaration;
			if (decl && ts.isPropertyDeclaration(decl) && !isStatic(decl)) return `${o}.${ident(key)} = ${this.marks.tryBefore(this.tryPrefix(value), this.coerce(value, this.typeOf(decl.name)))}`;
			// A function for a method takes the method's parameters, as its callers pass them.
			if (decl && ts.isMethodDeclaration(decl) && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))) {
				const slot = this.slotOf(value)?.getParameters() ?? [];
				const params = [...value.parameters.map((q) => this.typeOf(q.name)), ...slot.slice(value.parameters.length).map((q) => this.type(this.checker.getTypeOfSymbolAtLocation(q, value), value))];
				return `${RT.jsExpandoSet}(${o}, ${swiftString(key)}, ${this.boxFunction(this.expr(value), `(${params.join(', ')}) throws -> ${this.closureResult(value).target}`)})`;
			}
			return `${RT.jsExpandoSet}(${o}, ${swiftString(key)}, ${this.marks.tryBefore(this.tryPrefix(value), this.coerce(value, 'Any?'))})`;
		};
		const steps = e.properties.flatMap((p) => {
			if (ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name)) return [write(literalKey(p.name, this.checker) ?? p.name.getText(), p.initializer)];
			if (ts.isShorthandPropertyAssignment(p)) return [write(p.name.text, p.name)];
			if (ts.isSpreadAssignment(p)) {
				const source = this.checker.getNonNullableType(this.checker.getTypeAtLocation(p.expression));
				if (this.isAny(p.expression) || !source.getSymbol()?.declarations?.some(ts.isClassDeclaration)) throw this.error(p, 'a spread of anything but a class instance into an object literal of a class');
				const s = this.fresh('__spread');
				const copied = source.getProperties().filter((x) => x.valueDeclaration && ts.isPropertyDeclaration(x.valueDeclaration) && !isStatic(x.valueDeclaration) && type.getProperty(x.name)?.valueDeclaration && ts.isPropertyDeclaration(type.getProperty(x.name)!.valueDeclaration!));
				// Lenient code's spread object may be undefined, which spreads nothing.
				if (this.loose(p.expression)) return [`if let ${s} = ${this.tryPrefix(p.expression)}${RT.jsImplicit}(${this.expr(p.expression)}) { ${copied.map((x) => `${o}.${ident(x.name)} = ${s}.${ident(x.name)}`).join('; ')} }`];
				return [`let ${s}: ${this.typeOf(p.expression).replace(/[?!]$/, '')} = ${this.marks.tryBefore(this.tryPrefix(p.expression), this.expr(p.expression))}`, ...copied.map((x) => `${o}.${ident(x.name)} = ${s}.${ident(x.name)}`)];
			}
			throw this.error(p, 'this member in an object literal of a class');
		});
		return `{ () ${this.throwsInfo.expr(e) ? 'throws ' : ''}-> ${name} in ${[`let ${o} = ${name}(jsLiteral: ())`, ...steps, `return ${o}`].join('; ')} }()`;
	},

	/** An object literal typed as an abstract/plugin class (`HlmPickerPanelRef`, `IconInfo`): a local subclass overriding its methods and fields. */
	abstractClassLiteral(this: Translator, e: ts.ObjectLiteralExpression, cls: ts.ClassDeclaration, name: string): string {
		const clsName = this.className(cls);
		const implName = this.fresh('__Lit');
		const clsType = this.checker.getDeclaredTypeOfSymbol(this.checker.getSymbolAtLocation(cls.name!)!);
		const ctorLines: string[] = [];
		const methodLines: string[] = [];
		const args: string[] = [];
		const ctorParams: string[] = [];
		for (const p of e.properties) {
			if (!(ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p))) {
				throw this.error(p, `this member of an object literal of type ${name}`);
			}
			const key = literalKey(p.name, this.checker) ?? p.name.getText();
			const m = cls.members.find((x): x is ts.MethodDeclaration => ts.isMethodDeclaration(x) && x.name.getText() === key);
			if (m) {
				const sig = this.emittedSignature(m);
				const throws = !isAsync(m) && this.throwsInfo.fn(m);
				const fnType = `(${sig.params.map((x) => x.type).join(', ')}) ${throws ? 'throws ' : ''}-> ${sig.ret}`;
				const fField = `__fn_${ident(key)}`;
				const val = ts.isMethodDeclaration(p) ? `{ (${this.params(p, true)}) ${throws ? 'throws ' : ''}-> ${sig.ret} in${this.functionBody(p, sig.ret, this.indent).slice(1)}` : this.coerce(ts.isPropertyAssignment(p) ? p.initializer : p.name, fnType);
				ctorParams.push(`_ ${fField}: @escaping ${fnType}`);
				args.push(val);
				const pDecls = sig.params.map((x, k) => `_ __a${k}: ${x.type}`).join(', ');
				const pArgs = sig.params.map((_, k) => `__a${k}`).join(', ');
				methodLines.push(`private let ${fField}: ${fnType}`);
				methodLines.push(`override func ${ident(key)}(${pDecls})${throws ? ' throws' : ''}${sig.ret === 'Void' ? '' : ` -> ${sig.ret}`} { ${sig.ret === 'Void' ? '' : 'return '}${throws ? 'try ' : ''}${fField}(${pArgs}) }`);
				ctorLines.push(`self.${fField} = ${fField}`);
				continue;
			}
			const prop = clsType.getProperty(key)?.valueDeclaration;
			const pt = prop && ts.isPropertyDeclaration(prop) ? this.typeOf(prop.name) : 'Any?';
			const pVal = ts.isPropertyAssignment(p) ? p.initializer : (p as ts.ShorthandPropertyAssignment).name;
			const param = `__p_${ident(key)}`;
			ctorParams.push(`_ ${param}: ${pt}`);
			args.push(this.coerce(pVal, pt));
			ctorLines.push(`self.${ident(key)} = ${param}`);
		}
		const throws = this.throwsInfo.expr(e);
		return `{ () ${throws ? 'throws ' : ''}-> ${clsName} in final class ${implName}: ${clsName} { nonisolated deinit {}; ${methodLines.join('; ')}; init(${ctorParams.join(', ')}) { ${ctorLines.join('; ')}; super.init() } }; return ${implName}(${args.join(', ')}) }()`;
	},
};
