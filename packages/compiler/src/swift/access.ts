// Member and element access as Swift: properties, elements, optional chains, arguments.
import ts from 'typescript';
import { propSignal } from '../semantics/signals.ts';
import { LIB_CONSTANTS, MATH, isTypedArrayType } from './library.ts';
import { mathFunctionValue } from '../semantics/apis/math.ts';
import { CONSOLE } from '../semantics/apis/console.ts';
import { libFunctionValueKind } from '../semantics/apis/statics.ts';
import { ERRORS, isLibGlobal } from '../semantics/globals.ts';
import { escapingFunction, functionParts, hasTopLevelArrow, ident, identPath, isFunctionType, isOptional, openSwiftChain, optionalType, splitTopLevel, swiftString, RT, lenientReader } from './syntax.ts';
import type { Translator } from './translator.ts';
import { elementReceiverCell, keyName, receiverCell, receiverSlot, isEnumObject, nullishField, type ReceiverCell } from '../semantics/placement.ts';
import { ambientAddedMemberOf, augmentedPropertyRead, functionProperty, uncheckedMatch, wellKnownMember, isSelf } from '../semantics/lang.ts';
import { convertedRead, onlyNull } from '../semantics/states/predicates.ts';
import { isLibDeclaration, isWriteTarget, notIterable } from '../semantics/ast.ts';
import { isStatic } from '../semantics/throws.ts';
import { isKit, isNamed, isUntyped, iterableAssertion, spelledType } from '../semantics/types.ts';
import { programSymbolKey } from '../program/stable-names.ts';
import { tested } from './native/bridging.ts';
import { rethrowUnlessRefused } from '../semantics/refusals.ts';
import { byKey, symbolField } from '../semantics/spelled.ts';
import { definedField } from '../semantics/shapes.ts';
import { baseMethod, declaredClassName, heldClassName, prototypeClassSymbol } from '../semantics/classes.ts';
import { MODELLED_BUFFER_PROTOTYPES } from '../semantics/refuse-receivers.ts';

export const accessMethods = {
	/** The Swift type of the declaration a getter overrides, when the override narrows it; null otherwise. */
	narrowedFrom(this: Translator, decl: ts.Declaration): string | null {
		if (!ts.isGetAccessorDeclaration(decl) || !ts.isClassLike(decl.parent) || decl.getSourceFile().isDeclarationFile) return null;
		const name = decl.name.getText();
		let root: ts.GetAccessorDeclaration | ts.PropertyDeclaration | null = null;
		for (let cls: ts.ClassLikeDeclaration | undefined = decl.parent; cls;) {
			const h: ts.ExpressionWithTypeArguments | undefined = cls.heritageClauses?.find((x) => x.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
			const base: ts.Declaration | undefined = h && this.checker.getTypeAtLocation(h.expression).getSymbol()?.valueDeclaration;
			cls = base && ts.isClassLike(base) && !base.getSourceFile().isDeclarationFile ? base : undefined;
			const m = cls?.members.find((x): x is ts.GetAccessorDeclaration | ts.PropertyDeclaration => (ts.isGetAccessorDeclaration(x) || ts.isPropertyDeclaration(x)) && x.name.getText() === name);
			if (m) root = m;
		}
		if (!root) return null;
		const rootType = ts.isGetAccessorDeclaration(root) ? this.returnTypeOf(root) : this.typeOf(root.name);
		return rootType !== this.returnTypeOf(decl) ? rootType : null;
	},

	/**
	 * `(value as T).member` of an untyped value (app code; `(e as Error).message`, `(args as any as Point).x`):
	 * read by name, as script reads it whatever the value turns out to be; what is missing reads as undefined.
	 */
	assertedRead(this: Translator, e: ts.PropertyAccessExpression): boolean {
		if (this.lenient || this.library || e.questionDotToken || isWriteTarget(e) || (ts.isCallExpression(e.parent) && e.parent.expression === e)) return false;
		let r: ts.Expression = e.expression;
		while (ts.isParenthesizedExpression(r)) r = r.expression;
		if (!ts.isAsExpression(r) && !ts.isTypeAssertionExpression(r)) return false;
		try {
			return this.isAny(r.expression) && !this.isAny(r) && !isKit(spelledType(this.typeOf(r)), 'JSArray');
		} catch (e) {
			rethrowUnlessRefused(e);
			return false;
		}
	},

	/** `handler.tag` of a function declaration given properties: its function object, which holds them. */
	functionObjectOf(this: Translator, e: ts.PropertyAccessExpression): string | null {
		const target = ts.skipOuterExpressions(e.expression, ts.OuterExpressionKinds.Parentheses);
		if (this.library || !ts.isIdentifier(target)) return null;
		// Only the program's own: `call`, `name` and the other members of the language's Function are read as before.
		const own = this.checker.getSymbolAtLocation(e.name)?.declarations;
		if (!own?.length || own.some((x) => x.getSourceFile().isDeclarationFile)) return null;
		const d = this.resolve(target)?.valueDeclaration;
		if (!d || !ts.isFunctionDeclaration(d) || !d.body || d.getSourceFile().isDeclarationFile) return null;
		return this.boxDeclared(this.declaredValue(this.refName(target), d), d);
	},

	propertyRead(this: Translator, e: ts.PropertyAccessExpression): string {
		const name = e.name.text;
		const target = e.expression;
		this.refuseProto(e);
		this.refuseIntlMember(e);
		const fnObject = this.functionObjectOf(e);
		if (fnObject) {
			const read = `${fnObject}[jsKey: ${swiftString(name)}]`;
			const t = this.typeOf(e);
			if (isUntyped(spelledType(t))) return read;
			if (isOptional(t) || ['String', 'Double', 'Bool'].includes(t))
				return this.undefinedAs(
					this.readConverts(e, (c) => this.fromAny(c, optionalType(t)), read),
					t,
				);
			return `${RT.jsUnwrap}(${this.readConverts(e, (c) => this.fromAny(c, optionalType(t)), read)}, ${swiftString(name)})`;
		}
		if (this.assertedRead(e)) {
			let r: ts.Expression = target;
			while (ts.isParenthesizedExpression(r)) r = r.expression;
			const read = `${RT.jsGet}(${this.expr((r as ts.AsExpression).expression)}, ${swiftString(name)})`;
			const t = this.typeOf(e);
			if (isUntyped(spelledType(t))) return read;
			if (isOptional(t) || ['String', 'Double', 'Bool'].includes(t))
				return this.undefinedAs(
					this.readConverts(e, (c) => this.fromAny(c, optionalType(t)), read),
					t,
				);
			return `${RT.jsUnwrap}(${this.readConverts(e, (c) => this.fromAny(c, optionalType(t)), read)}, ${swiftString(name)})`;
		}
		if (this.isNativeExpando(e)) {
			const t = this.typeOf(e);
			const read = `${RT.jsNativeExpando}(${this.expr(target)}, ${swiftString(name)})`;
			return isUntyped(spelledType(t)) ? read : this.lenientRef(t) !== t && !(this.library && this.coreClass(t)) ? this.marks.castCode(read, t, 'as?', true) : this.readConverts(e, (c) => (this.lenientRef(t) !== t ? this.fromAny(c, t) : this.fromAnyCode(c, t, true)), read);
		}
		// A dynamic object (an allSettled result, a lookup table): its field read by name, as its type says.
		if (isNamed(spelledType(this.typeOf(target)), 'JSObject') && !e.questionDotToken) return this.readConverts(e, (c) => this.fromAnyCode(c, this.typeOf(e), true), `${RT.jsField}(${this.expr(target)}, ${swiftString(name)})`);
		if (isSelf(target, this.subst) && this.props.has(name)) return propSignal(e, this.checker, this.framework) ? `self.${ident(name)}` : `self.${ident(name)}.value`;
		if (name === 'raw' && this.symbolName(target) === 'TemplateStringsArray') return `${RT.jsTemplateRaw}(${this.expr(target)})`;
		if (name === 'description' && this.typeOf(target) === 'JSSymbol') return `${this.expr(target)}.jsDescription`;
		const declaredName = declaredClassName(e, this.checker);
		if (declaredName !== null) return swiftString(declaredName);
		const fnProp = functionProperty(e, this.checker);
		if (fnProp) return fnProp.kind === 'length' ? `Double(${fnProp.value})` : swiftString(fnProp.value);
		if (!this.library && !e.questionDotToken && heldClassName(e, this.checker)) return this.readConverts(e, (c) => this.fromAnyCode(c, this.typeOf(e), true), `${RT.jsField}(${this.expr(target)}, "name")`);
		// `this.name` in a static member and `this.constructor.name` (library mode): the class's name, of the class the code runs for.
		if (name === 'name' && this.library) {
			const cls = this.classValueOf(target);
			if (cls) return `${cls}.jsName`;
		}
		if (name === 'prototype') {
			this.refuseClassPrototype(e);
			this.refuseBufferPrototype(e);
		}
		// `ArrayBuffer.prototype`: an object of the class's tag, all a program reads of it.
		if (name === 'prototype' && ts.isIdentifier(target) && MODELLED_BUFFER_PROTOTYPES.has(target.text) && isLibGlobal(this, target)) return `JS${target.text}.jsPrototype`;
		// `Function.prototype`: a function that does nothing.
		if (name === 'prototype' && ts.isIdentifier(target) && target.text === 'Function' && isLibDeclaration(this.resolve(target)?.declarations?.[0])) return '({ (_: [Any?]) throws -> Any? in nil } as JSFunction)';
		// `Cls.prototype`: what script defines there, which the class's instances read.
		const protoSym = prototypeClassSymbol(target, name, this);
		if (protoSym) {
			const cls = this.type(this.checker.getDeclaredTypeOfSymbol(protoSym), e).replace(/<.*$/, '');
			return `JSPrototypes.of(${cls}.self)`;
		}
		if (name === 'prototype' && this.library && this.typeOf(target).endsWith('.Type')) return `JSPrototypes.of(${this.expr(target)})`;
		// `value.constructor`: its class, which script tests for static members.
		if (name === 'constructor' && (this.library || this.checker.getSymbolAtLocation(e.name)?.declarations?.every((d) => isLibDeclaration(d))) && !isWriteTarget(e) && !(ts.isPropertyAccessExpression(e.parent) && e.parent.expression === e && e.parent.name.text === 'name')) return `${RT.jsConstructor}(${this.coerce(target, 'Any?')})`;
		// `TypeError.name`, `Number.name`: the built-in's own name.
		if (name === 'name' && ts.isIdentifier(target) && (ERRORS[target.text] || ['Number', 'String', 'Boolean'].includes(target.text)) && isLibDeclaration(this.resolve(target)?.declarations?.[0])) return swiftString(target.text);
		// `value.constructor.name`: its class's name.
		if (name === 'name' && ts.isPropertyAccessExpression(target) && target.name.text === 'constructor' && !isWriteTarget(e)) return `${RT.jsConstructorName}(${this.coerce(target.expression, 'Any?')})`;
		if (ts.isIdentifier(target) && isLibGlobal(this, target)) {
			const constant = LIB_CONSTANTS[`${target.text}.${name}`];
			if (constant) return constant;
			// `const round = Math.round`: the function as a value.
			const mathValue = target.text === 'Math' ? mathFunctionValue(name) : null;
			if (mathValue) return this.convert(`{ (__x: Double) -> Double in ${MATH[mathValue]}(__x) }`, '(Double) throws -> Double', this.typeOf(e));
			const libFn = libFunctionValueKind(target.text, name);
			if (libFn === 'console') {
				if (tested(e)) return '(true as Any?)';
				const fn = RT[CONSOLE[name].op];
				return this.convert(`{ (__args: JSRest<Any?>) -> Void in ${fn}(spread: __args.storage) }`, '(JSRest<Any?>) throws -> Void', this.typeOf(e));
			}
			if (libFn === 'fromCharCode') return this.convert(`{ (__args: JSRest<Double>) -> String in ${RT.jsFromCharCode}(codes: __args.storage) }`, '(JSRest<Double>) throws -> String', this.typeOf(e));
			if (libFn === 'fromCodePoint') return this.convert(`{ (__args: JSRest<Double>) throws -> String in try ${RT.jsFromCodePoint}(codes: __args.storage) }`, '(JSRest<Double>) throws -> String', this.typeOf(e));
			if (libFn === 'mathRandom') return this.convert('{ () -> Double in Double.random(in: 0..<1) }', '() throws -> Double', this.typeOf(e));
			if (libFn === 'mathVariadic') return this.convert(`{ (__args: JSRest<Double>) -> Double in ${name === 'min' ? RT.jsMathMin : RT.jsMathMax}(values: __args.storage) }`, '(JSRest<Double>) throws -> Double', this.typeOf(e));
			if (libFn === 'typedArrayFrom') return this.convert(`{ (__v: Any?) throws -> JS${target.text} in try JS${target.text}.from(__v) }`, `(Any?) throws -> JS${target.text}`, this.typeOf(e));
			if (libFn === 'isArray') return this.convert(`{ (__v: Any?) -> Bool in JSArray<Any?>.isArray(__v) }`, '(Any?) throws -> Bool', this.typeOf(e));
			if (libFn === 'numberCheck') {
				const test = name === 'isInteger' ? `${RT.jsIsInteger}($0)` : name === 'isSafeInteger' ? `${RT.jsIsSafeInteger}($0)` : `$0.${name}`;
				return this.convert(`{ (__v: Any?) -> Bool in ((__v as? Double).map { ${test} } ?? false) }`, '(Any?) throws -> Bool', this.typeOf(e));
			}
			if (this.isAugmentedLibMember(e)) return '(nil as Any?)';
			throw this.error(e, `${target.text}.${name}`, name === 'prototype' ? 'builtin-prototype' : this.checker.getSymbolAtLocation(e.name)?.flags! & ts.SymbolFlags.Method ? 'function-value' : 'library-member');
		}
		// A tuple's `length` (`LEVELS.length` of an `as const` list): its element count.
		if (name === 'length' && this.checker.isTupleType(this.checker.getNonNullableType(this.checker.getTypeAtLocation(target))) && /^\(/.test(this.typeOf(target))) {
			return `Double(${this.checker.getTypeArguments(this.checker.getNonNullableType(this.checker.getTypeAtLocation(target)) as ts.TypeReference).length})`;
		}
		// A member of an enum a library declares (core's GestureStateTypes.began): its value.
		const enumMember = this.checker.getSymbolAtLocation(e.name)?.valueDeclaration;
		const constant = enumMember && ts.isEnumMember(enumMember) ? this.checker.getConstantValue(enumMember) : undefined;
		// A member named as a Swift keyword (`Specificity.Type`) cannot be written after a dot: its value.
		if (constant !== undefined && (enumMember!.getSourceFile().isDeclarationFile || ident(name) !== name) && !this.native.module(enumMember!.parent as ts.EnumDeclaration)) {
			return typeof constant === 'string' ? swiftString(constant) : `Double(${constant})`;
		}
		const maybeChain = e.questionDotToken ? this.maybeUndefined(e) : null;
		if (maybeChain) {
			// The chain goes on (`group?.items[i]`): through the optional.
			const p = e.parent;
			if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p) || ts.isCallExpression(p)) && p.expression === e && ts.isOptionalChain(p)) return maybeChain;
			return this.undefinedAs(`(${maybeChain})`, this.typeOf(e));
		}
		const kit = isWriteTarget(e) ? null : this.core.augmentedRead(e);
		if (kit !== null) {
			const t = this.typeOf(e);
			if (['String', 'Double', 'Bool'].includes(t) && convertedRead(e)) return this.undefinedAs(this.fromAny(kit, optionalType(t)), t, optionalType(t));
			return this.fromAnyCode(kit, t, true);
		}
		const core = this.core.property(e);
		if (core) return core;
		if (this.isAddedMember(e)) {
			const t = this.typeOf(e);
			const code = `${RT.jsField}(${this.expr(target)}, ${swiftString(name)})`;
			return isUntyped(spelledType(t))
				? code
				: this.undefinedAs(
						this.readConverts(e, (c) => this.fromAny(c, optionalType(t)), code),
						t,
					);
		}
		if (this.isExpando(e)) {
			const t = this.typeOf(e);
			const code = `${RT.jsGet}(${this.expr(target)}, ${swiftString(name)})`;
			if (!isWriteTarget(e) && ['String', 'Double', 'Bool'].includes(t) && convertedRead(e) && augmentedPropertyRead(e, this.checker)) return this.undefinedAs(this.fromAny(code, optionalType(t)), t, optionalType(t));
			return isUntyped(spelledType(t)) || isWriteTarget(e) ? code : this.readConverts(e, (c) => this.fromAnyCode(c, t, true), code);
		}
		const native = this.native.property(e);
		if (native) return native;
		// `a?.b?.c` where Swift holds `b` present: the chain `a?.b` already carries the optional, and `?.` on `b` does not compile.
		const dot = e.questionDotToken && !this.presentLink(target) ? '?.' : '.';
		if (name === 'length' && this.isString(target)) {
			const missing = !e.questionDotToken && !ts.isOptionalChain(e) ? this.receiver(target, 'length') : null;
			if (missing) return `Double(${missing}.utf16.count)`;
			if ((!this.typeOf(target).endsWith('?') && !this.optionalResult(target)) || this.unsetGroupReceiver(target)) return `Double(${this.expr(target)}.utf16.count)`;
			// Only a chain (`s?.length`) reads undefined; `s.length` of null or undefined throws, as unwrapping traps.
			if (!e.questionDotToken && !ts.isOptionalChain(e)) return `Double(${this.expr(target)}!.utf16.count)`;
			// A chain's string its member holds present (`d?.name`): `.map` inside the chain would map its characters.
			const code = this.expr(target);
			return `${openSwiftChain(code) && !isOptional(this.declaredTypeOf(target) ?? this.typeOf(target)) ? `(${code})` : code}.map { Double($0.utf16.count) }`;
		}
		if (this.isAny(target)) {
			const t = this.typeOf(e);
			const receiver = this.expr(target);
			const code = ts.isOptionalChain(e) && !isWriteTarget(e) ? `${RT.jsGetIfPresent}(${receiver}, ${swiftString(name)})` : this.marks.marked(`${RT.jsGet}(${receiver}, ${swiftString(name)})`, { op: 'member', of: this.marks.valueOf(receiver), name, dynamic: true });
			// `a?.b?.c`: the chain goes on from what `a?.b` may be, undefined included.
			const p = e.parent;
			const chained = ts.isPropertyAccessExpression(p) && p.expression === e && !!p.questionDotToken && !hasTopLevelArrow(t);
			// A declared string read so (`token.content?.length`) is empty where the object has none: what the chain reads of it is as falsy.
			return isUntyped(spelledType(t)) || isWriteTarget(e) ? code : chained && t === 'String' ? `(${this.readConverts(e, (c) => this.fromAny(c, 'String?'), code)} ?? "")` : chained ? `(${this.readConverts(e, (c) => this.fromAny(c, optionalType(t)), code)})` : this.readConverts(e, (c) => this.fromAny(c, t), code);
		}
		const base = this.typeOf(target);
		if (byKey(this, e)) {
			// A key of a dictionary-typed object: undefined when missing.
			// `limits?.constructor`: the record as optional, whichever Swift holds it as.
			const read = e.questionDotToken && !base.endsWith('?') ? `(${this.expr(target)} as ${base}?)?[${swiftString(name)}]` : `${this.expr(target)}${base.endsWith('?') ? '?' : ''}[${swiftString(name)}]`;
			const t = this.typeOf(e);
			if (isWriteTarget(e)) return read;
			if (isOptional(t)) return this.marks.orNil(read);
			// Lenient code: a missing object is undefined, which the code tests for (`if (!list) …`).
			if (this.lenient && this.lenientRef(t) !== t) return this.marks.implicitOf(read);
			const z = isFunctionType(t) ? null : this.zero(t);
			return z ? `(${read} ?? ${z})` : this.marks.unwrappedCode(read);
		}
		// A handler typing its event's sender (`args: { object: Chart }`).
		if (base === 'EventData' && name === 'object' && !isWriteTarget(e)) {
			const t = this.typeOf(e).replace(/\?$/, '');
			if (!['Observable', 'Any'].includes(t) && this.isObjectRef(e)) return `(${this.expr(target)}.object as! ${t})`;
		}
		if (base === 'EventData' && !(this.library ? ['eventName', 'object'] : ['value', 'item', 'eventName', 'object', 'index', 'view', 'type', 'state', 'deltaX', 'deltaY', 'scale', 'rotation', 'direction', 'action', 'scrollX', 'scrollY', 'newValue']).includes(name)) {
			const t = this.typeOf(e);
			const code = `${this.expr(target)}[jsKey: ${swiftString(name)}]`;
			return isUntyped(spelledType(t)) ? code : this.readConverts(e, (c) => this.fromAnyCode(c, t, true), code);
		}
		// An event's data: the value's type is the one the handler declared.
		// `ref.value` of an `interop.Reference<number>`: the cell's value as the type argument reads it.
		if (base === 'InteropReference' && name === 'value' && !isWriteTarget(e)) {
			const t = this.typeOf(e);
			return isUntyped(spelledType(t)) ? `${this.expr(target)}.value` : this.readConverts(e, (c) => this.fromAnyCode(c, t, true), `${this.expr(target)}.value`);
		}
		if (base === 'EventData' && (name === 'value' || name === 'item' || name === 'newValue')) {
			const t = this.typeOf(e);
			return isUntyped(spelledType(t)) ? `${this.expr(target)}.${name}` : this.readConverts(e, (c) => this.fromAny(c, t), `${this.expr(target)}.${name}`);
		}
		if (/^JS(Iterator|Generator)</.test(base.replace(/[?!]$/, '')) && (name === 'return' || name === 'throw') && !isWriteTarget(e)) {
			const has = name === 'return' ? 'jsHasReturn' : 'jsHasThrow';
			const fn = name === 'return' ? 'jsReturnResult' : 'jsThrowResult';
			return `(${this.expr(target)} as ${optionalType(base.replace(/[?!]$/, ''))}).flatMap { __it in __it.${has} ? { (__v: Any?) throws -> Any? in try __it.${fn}(__v) } : nil }`;
		}
		const methodOfMissing = this.optionalResult(target) ? this.methodValueRead(e) : null;
		if (methodOfMissing) return methodOfMissing;
		const checked = this.receiver(target, name);
		if (checked) return this.narrowed(e, this.marks.memberOf(checked, dot, this.readMember(e)));
		// `x?.name` on a value Swift has as non-optional: cast to optional, valid for an implicitly unwrapped one too.
		const tt = this.typeOf(target);
		if (e.questionDotToken && !isUntyped(spelledType(tt)) && !tt.endsWith('?') && !tt.endsWith('!') && !hasTopLevelArrow(tt) && !ts.isOptionalChain(target) && !isWriteTarget(e) && !(ts.isCallExpression(target) && this.maybeUndefined(target))) {
			const asserted = this.assertedUntyped(target);
			const read = this.marks.memberOf(asserted ? this.assertedOptional(asserted) : `(${this.expr(target)} as ${optionalType(tt)})`, '?.', this.readMember(e, ident(name)));
			// A field redeclared over its base's untyped one (`viewController: UIViewController`): read as the redeclaration types it.
			const own = this.typeOf(e);
			const code = isUntyped(spelledType(this.declaredTypeOf(e))) && !isUntyped(spelledType(own)) && !isWriteTarget(e) ? `(${this.readConverts(e, (c) => this.fromAny(c, optionalType(own)), read)})` : read;
			// The chain goes on (`a?.b?.c`): it reads the optional.
			if (ts.isOptionalChain(e.parent) && (e.parent as ts.PropertyAccessExpression).expression === e && (e.parent as ts.PropertyAccessExpression).questionDotToken) return code;
			// Lenient code holds what it reads as declared, so a target it holds optional keeps the chain open.
			if (ts.isOptionalChain(e.parent) && (e.parent as ts.PropertyAccessExpression).expression === e) return this.lenient && this.states.heldOptional(target) ? code : `${this.expr(target)}.${ident(name)}`;
			const rt = this.typeOf(e);
			if (this.optionalReads.has(e) && !rt.endsWith('?') && !isUntyped(spelledType(rt))) {
				this.optionalReads.set(e, true);
				return code;
			}
			return rt.endsWith('?') || isUntyped(spelledType(rt)) ? code : this.undefinedAs(this.marks.parens(code), rt, code === read ? (this.declaredTypeOf(e) ?? undefined) : own);
		}
		// A read continuing an optional chain after a call (`xs?.filter(f).length`): part of the chain, as a call continuing one is.
		if (ts.isCallExpression(target) && ts.isOptionalChain(target) && !e.questionDotToken && (this.typeOf(target).endsWith('?') || this.implicitChain(target))) {
			const code = this.expr(target);
			const read = this.narrowed(e, this.marks.memberOf(code, openSwiftChain(code) ? '.' : '?.', this.readMember(e)));
			const rt = this.typeOf(e);
			const chained = ts.isOptionalChain(e.parent) && (e.parent as ts.PropertyAccessExpression | ts.CallExpression).expression === e;
			return chained || isWriteTarget(e) || isOptional(rt) || isUntyped(spelledType(rt)) || this.optionalReads.has(e) ? read : this.undefinedAs(`(${read})`, rt);
		}
		const unwrap = (this.continuesOptional(target) || (ts.isCallExpression(target) && this.maybeUndefined(target))) && !e.questionDotToken && this.looseReceiverKey(target) === null;
		if (!unwrap) {
			const value = this.methodValueRead(e);
			if (value) return value;
		}
		return this.narrowed(e, this.marks.memberOf(unwrap ? this.marks.unwrappedCode(this.expr(target)) : this.expr(target), dot, this.readMember(e)));
	},

	/**
	 * A program class's method read as a value (`source.on('tap', this.onTap, this)`): the one
	 * closure of that receiver and method (`jsMethodValue`), holding the receiver weakly, or strongly and uncached
	 * where the receiver is a `new` or call expression (nothing else holds it). Null for
	 * any other read, and for a method called (`obj.m()`) or called by name (`namedCall`).
	 */
	methodValueRead(this: Translator, e: ts.PropertyAccessExpression): string | null {
		if (this.namedCall || e.questionDotToken || isWriteTarget(e)) return null;
		const p = e.parent;
		if ((ts.isCallExpression(p) && p.expression === e) || ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p) || ts.isTypeOfExpression(p) || ts.isDeleteExpression(p)) return null;
		const decl = this.checker.getSymbolAtLocation(e.name)?.valueDeclaration;
		if (decl && ts.isMethodDeclaration(decl) && isStatic(decl)) return this.staticMethodValue(e, decl);
		if (!decl || !ts.isMethodDeclaration(decl) || isStatic(decl) || decl.typeParameters?.length || decl.asteriskToken || !ts.isClassDeclaration(decl.parent) || decl.getSourceFile().isDeclarationFile) return null;
		if (decl.parameters.some((q) => q.dotDotDotToken)) return null;
		if (e.expression.kind === ts.SyntaxKind.SuperKeyword && this.isInstanceMethod(e.name)) return 'nil';
		if (e.expression.kind === ts.SyntaxKind.SuperKeyword || !(isSelf(e.expression, this.subst) || this.programClass(e.expression))) return null;
		let receiverType = this.typeOf(e.expression);
		// A call whose result may be missing: JavaScript's TypeError where it is, the method's value otherwise.
		const missing = this.optionalResult(e.expression) ? this.receiver(e.expression, e.name.text) : null;
		if (missing) receiverType = receiverType.replace(/\?$/, '');
		else if (receiverType.endsWith('?')) return null;
		const fn = functionParts(this.typeOf(e));
		const cell = fn && fn.rest < 0 ? this.functionCell(fn.text) : null;
		if (!fn || !cell) return null;
		const name = e.name.text;
		const params = fn.params.map((t, k) => `__p${k}: ${t}`);
		const bare = `__r.${this.memberName(e)}(${fn.params.map((_, k) => `__p${k}`).join(', ')})`;
		// Lenient code's method may give undefined where the function type promises an object.
		const call = fn.result !== 'Void' && this.lenient && this.nullableRef(fn.result) !== fn.result ? this.marks.tryCode(this.marks.helper('jsObjectRequired', bare)) : this.marks.tryIf(this.throwsInfo.fn(decl), `${bare}`);
		const body = fn.result !== 'Void' ? `return ${call}` : this.returnTypeOf(decl) === 'Void' ? call : `_ = ${call}`;
		const read = ts.skipOuterExpressions(e.expression, ts.OuterExpressionKinds.Parentheses);
		const temporary = ts.isNewExpression(read) || ts.isCallExpression(read);
		const closure = temporary ? `{ (${params.join(', ')}) throws -> ${fn.result} in ${this.keeping('__i', body, fn.result)} }` : `{ [weak __r] (${params.join(', ')}) throws -> ${fn.result} in guard let __r else { throw ${RT.jsReleasedReceiver}(${swiftString(name)}) }; ${this.keeping('__i', body, fn.result)} }`;
		const methodValue = (receiver: string) => `${RT.jsMethodValue}(${temporary ? 'temporary: ' : ''}${receiver}, ${swiftString(name)}) { __r, __i in ${cell}(f: ${closure}) }.f`;
		if (!this.isInstanceMethod(e.name)) return methodValue(missing ? this.marks.tryCode(missing) : this.expr(e.expression));
		// A method an instance can replace (see `instanceKeys`): its own value when it holds one, as a call reads it.
		const held = this.fresh('__held'),
			own = this.fresh('__own');
		const receiver = missing ? this.marks.tryCode(missing) : `${this.marks.tryBefore(this.tryPrefix(e.expression), this.expr(e.expression))}`;
		return `({ () ${missing || this.throwsInfo.expr(e.expression) ? 'throws ' : ''}-> ${fn.text} in let ${held}: ${receiverType} = ${receiver}; if let ${own} = ${RT.jsOwnProperty}(${held}, ${swiftString(name)})${this.library ? '' : `, ${own} != nil`} { return ${this.fromAnyCode(own, fn.text, true)} }; return ${methodValue(held)} }())`;
	},

	/** A program class's static method read as a value (`Validators.required`): one closure for good, as a module's function is. */
	staticMethodValue(this: Translator, e: ts.PropertyAccessExpression, decl: ts.MethodDeclaration): string | null {
		if (decl.typeParameters?.length || decl.asteriskToken || decl.parameters.some((q) => q.dotDotDotToken) || !ts.isClassDeclaration(decl.parent) || decl.getSourceFile().isDeclarationFile || !this.programClass(e.expression)) return null;
		const fn = functionParts(this.typeOf(e));
		const cell = fn && fn.rest < 0 ? this.functionCell(escapingFunction(fn)) : null;
		if (!cell) return null;
		const ref = `${this.expr(e.expression)}.${this.memberName(e)}`;
		if (!this.functionDepth) this.isolatedInit = true;
		return `${cell}.${this.cellStatic(cell, 'declared', `${RT.jsDeclaredFunction}(id, Self(f: __h)).f`)}(${swiftString(ref.replace(/`/g, ''))}, ${ref})`;
	},

	/** A read of strict code's parameter its group's form widens, held implicitly unwrapped: it may be nil where its type says not. */
	widenedParameterRead(this: Translator, x: ts.Expression): boolean {
		if (this.lenient || !ts.isIdentifier(x)) return false;
		const d = this.resolve(x)?.valueDeclaration;
		return !!d && ts.isParameter(d) && !d.questionToken && !d.initializer && this.states.widened(d) && !isOptional(this.typeOf(d.name)) && !this.isAny(d.name);
	},

	/** App code's indexed receiver Swift holds optional, outside an optional chain: JavaScript's TypeError where it is missing. */
	elementReceiver(this: Translator, e: ts.ElementAccessExpression, target: string): string {
		if (this.library || e.questionDotToken || ts.isOptionalChain(e)) return target;
		// A compound assignment or update reads the element first.
		const set = ts.isBinaryExpression(e.parent) && e.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && e.parent.left === e;
		const cell = elementReceiverCell(this.receivers, e);
		if (cell.cell === 'present') return this.marks.ownTried(this.receiverCode(cell, keyName(e.argumentExpression), set)!);
		if (this.marks.isUnwrap(target)) return target;
		if (!this.typeOf(e.expression).endsWith('?') && (isWriteTarget(e) || !this.widenedParameterRead(ts.skipOuterExpressions(e.expression, ts.OuterExpressionKinds.Parentheses)))) return target;
		const k = e.argumentExpression;
		const key = swiftString(ts.isStringLiteralLike(k) || ts.isNumericLiteral(k) ? k.text : k.getText());
		return this.marks.ownTried(this.marks.helper('jsUnwrap', target, set ? `, setting: ${key}` : `, ${key}${onlyNull(this.checker.getTypeAtLocation(e.expression)) ? ', null: true' : ''}`));
	},

	/** A receiver that can be missing though its type says not (`x!`, `items[i]`): JavaScript's TypeError when it is. */
	receiver(this: Translator, target: ts.Expression, key: string): string | null {
		const x = ts.skipOuterExpressions(target, ts.OuterExpressionKinds.Parentheses);
		if (nullishField(this, x) && !this.subst.has(x) && !receiverSlot(target, key).chained) return this.marks.ownTried(`${this.nullishCode(x)}.present(${this.states.nullishMemberKey(x).set ? 'setting: ' : ''}${swiftString(key)})`);
		const p = target.parent;
		const set = ts.isPropertyAccessExpression(p) && ts.isBinaryExpression(p.parent) && p.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.parent.left === p;
		return this.receiverCode(receiverCell(this.receivers, receiverSlot(target, key)), key, set);
	},

	/** A receiver cell as Swift writes it: null where the access reads it as it is. */
	receiverCode(this: Translator, c: ReceiverCell, key: string, set = false): string | null {
		if (c.cell === 'chained') {
			// Swift's `?.` carries the chain on through the receiver's own check.
			const code = this.maybeUndefined(c.receiver) ?? this.expr(c.receiver);
			const m = this.marks.markOf(code);
			const open = m?.op === 'undefinedAs' ? m.of.code : code;
			if (!openSwiftChain(open)) throw this.error(c.receiver, `an optional chain's link read past it as \`${open}\``);
			return `${open}.${RT.jsUnwrap}(${swiftString(key)}${c.isNull ? ', null: true' : ''})`;
		}
		return c.cell === 'asIs' ? null : set && !c.isNull ? `${RT.jsUnwrap}(${c.code}, setting: ${swiftString(key)})` : `${RT.jsUnwrap}(${c.code}, ${swiftString(key)}${c.isNull ? ', null: true' : ''})`;
	},

	elementAccess(this: Translator, e: ts.ElementAccessExpression): string {
		this.refuseProto(e);
		this.refuseIntlMember(e);
		const target = this.expr(e.expression);
		const key = e.argumentExpression;
		const t = this.typeOf(e.expression).replace(/\?$/, '');
		const q = e.questionDotToken ? '?' : '';
		if (t === 'String') return `${RT.jsCharAt}(${(!q && this.receiver(e.expression, ts.isNumericLiteral(key) || ts.isStringLiteral(key) ? key.text : key.getText())) || target}, ${this.expr(key)})`;
		if (isKit(spelledType(t), 'JSArray')) {
			// A key that is no array index (`a[-1] = v`) is a property of the array, as JavaScript keeps it.
			if (isWriteTarget(e)) return `${this.elementReceiver(e, target)}${q}[${ts.isNumericLiteral(key) ? key.text : `(${this.toNumber(key)} as Double)`}]`;
			// An untyped element the checker narrows (`Array.isArray(xs[0])`): read as the narrowed type.
			const rt = this.typeOf(e);
			if (t === 'JSArray<Any?>' && !isUntyped(spelledType(rt))) return this.fromAny(`(${this.maybeUndefined(e)!} ?? nil)`, rt);
			return this.undefinedAs(this.maybeUndefined(e)!, rt, /^JSArray<(.*)>$/.exec(t)![1]);
		}
		if (t === 'JSMatch') {
			if (!q && uncheckedMatch(e.expression, this.checker)) return `${RT.jsUnwrap}(${target}, ${ts.isNumericLiteral(key) || ts.isStringLiteral(key) ? swiftString(key.text) : `${RT.jsToString}(${this.coerce(key, 'Any?')})`}, null: true)[Int(${this.expr(key)})]`;
			if (!isWriteTarget(e)) return this.undefinedAs(this.maybeUndefined(e)!, this.typeOf(e), 'String?');
			return `${target}${q}[Int(${this.expr(key)})]`;
		}
		if (isTypedArrayType(t)) {
			const assigned = ts.isBinaryExpression(e.parent) && e.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
			const code = `${this.elementReceiver(e, target)}${q}[${isWriteTarget(e) && !assigned ? 'jsElement' : 'jsIndex'}: ${this.toNumber(key)}]`;
			return isWriteTarget(e) ? code : this.undefinedAs(code, this.typeOf(e));
		}
		if (t.startsWith('(') && ts.isNumericLiteral(key)) {
			const part = splitTopLevel(t.slice(1, -1))[Number(key.text)];
			const rt = this.typeOf(e);
			return part && isOptional(part) && !isOptional(rt) && !isWriteTarget(e) ? this.undefinedAs(`${target}.${key.text}`, rt, part) : `${target}.${key.text}`;
		}
		// A tuple at a computed index (`pool[next++ % 5]`): its elements as an array, undefined past them.
		if (t.startsWith('(') && this.checker.isTupleType(this.checker.getNonNullableType(this.checker.getTypeAtLocation(e.expression))) && !isWriteTarget(e)) {
			const parts = splitTopLevel(t.slice(1, -1));
			const el = parts.every((x) => x === parts[0]) ? parts[0] : 'Any?';
			const tuple = this.fresh('__tuple');
			// An optional element (a lenient tuple's object) read past the end is still one undefined, not an optional of one.
			const read = `{ (${tuple}: ${t}) -> ${optionalType(el)} in JSArray<${el}>([${parts.map((_, k) => `${tuple}.${k}`).join(', ')}]).element(${this.toNumber(key)})${isOptional(el) ? ' ?? nil' : ''} }(${target})`;
			const rt = this.typeOf(e);
			return isUntyped(spelledType(el)) && !isUntyped(spelledType(rt)) ? this.fromAny(`(${read} ?? nil)`, rt) : this.undefinedAs(read, rt, optionalType(el));
		}
		// A native array (`view.subviews[0]`): undefined past its end.
		if (/^\[[^:]*\]$/.test(t) && !isWriteTarget(e)) {
			const read = `${RT.jsNativeElement}(${target}, ${this.toNumber(key)})`;
			const rt = this.typeOf(e);
			if (['String', 'Double', 'Bool'].includes(rt)) return this.undefinedAs(`(${read} as? ${rt})`, rt);
			return isUntyped(spelledType(rt)) ? read : this.fromAny(read, rt);
		}
		if (isKit(spelledType(t), 'JSRecord')) {
			// A missing key is undefined in JavaScript; its declared type here is the value type.
			// Lenient code's record may be missing in an optional chain (`handlers?.[a]?.[b]`): the chain stops there.
			const chained = this.lenient && ts.isOptionalChain(e) && this.loose(e.expression) && !this.typeOf(e.expression).endsWith('?');
			const keyCode = this.str(key);
			const read = chained ? `${RT.jsImplicit}(${target})?[${keyCode}]` : `${target}${this.typeOf(e.expression).endsWith('?') ? '?' : ''}[${keyCode}]`;
			if (isWriteTarget(e)) return read;
			const vt = this.typeOf(e);
			if (t === 'JSRecord<Any?>' && !isUntyped(spelledType(vt))) return this.fromAny(`(${read} ?? nil)`, vt);
			if (isOptional(vt)) {
				// An optional value's entry reads back doubly optional: one nil for a missing key and a stored undefined alike.
				const stored = t.replace(/[?!]$/, '').slice('JSRecord<'.length, -1);
				return isOptional(stored) ? read.slice(0, -`[${keyCode}]`.length) + `[entry: ${keyCode}]` : read;
			}
			// Lenient code: a missing object is undefined, which the code tests for (`if (!list) …`).
			if (this.lenient && this.lenientRef(vt) !== vt) return this.marks.implicitOf(read);
			// App code: a key never set reads undefined, not the value type's zero.
			if (!this.library && !this.lenient && ['String', 'Double', 'Bool'].includes(vt) && this.states.appCode(e) && convertedRead(e)) return this.undefinedAs(read, vt, optionalType(vt));
			const z = isFunctionType(vt) ? null : this.zero(vt);
			return z ? `(${read} ?? ${z})` : this.marks.unwrappedCode(read);
		}
		// `Enum[name]`, `Enum[value]`: the object JavaScript makes of the enum, by key.
		const enumDecl = ts.isIdentifier(e.expression) ? this.resolve(e.expression)?.valueDeclaration : undefined;
		if (((enumDecl && ts.isEnumDeclaration(enumDecl) && !enumDecl.getSourceFile().isDeclarationFile) || isEnumObject(this.placement, e.expression)) && !ts.isStringLiteral(key) && !isWriteTarget(e)) {
			const rt = this.typeOf(e);
			const object = ts.isIdentifier(e.expression) ? identPath(this.declaredName(e.expression)) : this.expr(e.expression);
			const code = `${object}.jsEnumObject[jsKey: ${this.propertyKey(key)}]`;
			return isUntyped(spelledType(rt)) ? code : this.fromAny(code, rt);
		}
		if (this.isAny(e.expression)) {
			const code = `${RT.jsGet}(${target}, ${this.propertyKey(key)})`;
			const rt = this.typeOf(e);
			return isUntyped(spelledType(rt)) || isWriteTarget(e) ? code : this.fromAny(code, rt);
		}
		// A key the type does not declare (`view?.['setIndicator']` on a View): looked up by name, as JavaScript does.
		const declared = !ts.isStringLiteral(key) || (!!this.checker.getNonNullableType(this.checker.getTypeAtLocation(e.expression)).getProperty(key.text) && !ambientAddedMemberOf(e, this.checker));
		if (ts.isStringLiteral(key) && declared && definedField(this.states, () => this.shapeFacts(), e.expression, key.text)) {
			if (isWriteTarget(e)) throw this.error(e, `a write of a field Object.defineProperty may restrict by an element access (write \`.${key.text}\`)`);
			if (!q) return this.fromAnyCode(`${target}[jsKey: ${swiftString(key.text)}]`, this.typeOf(e), true);
		}
		if (ts.isStringLiteral(key) && declared) return `${target}${q}.${ident(key.text)}`;
		const keyed = symbolField(this, e);
		if (keyed) return `${target}${q}.${programSymbolKey(keyed, this.checker)?.member ?? `__symbol_${(key as ts.Identifier).text}`}`;
		// `x[Symbol.toStringTag]` on a class declaring it (a field or a getter).
		const tag = ts.isPropertyAccessExpression(key) && key.name.text === 'toStringTag' && ts.isIdentifier(key.expression) && key.expression.text === 'Symbol' && isLibGlobal(this, key.expression);
		if (
			tag &&
			!isWriteTarget(e) &&
			this.checker
				.getNonNullableType(this.checker.getTypeAtLocation(e.expression))
				.getProperties()
				.some((p) => wellKnownMember(p.escapedName.toString()) === 'jsToStringTag')
		)
			return `${target}${q}.jsToStringTag`;
		// A computed key on a native object (`view[property]`), or a literal one its type does not declare (`view['elevation']`,
		// `observer['_owner']`): its Objective-C property by name, as the runtime reads and writes it, else what script added to the object.
		const receiverType = this.checker.getNonNullableType(this.checker.getTypeAtLocation(e.expression));
		if ((ts.isStringLiteral(key) ? !declared : ['String', 'Any?'].includes(this.typeOf(key))) && (this.native.isClassType(receiverType) || this.native.extendsNative(receiverType))) {
			const code = `JSNativeKeyed(${target}${/[?!]$/.test(this.typeOf(e.expression)) ? '!' : ''})[jsKey: ${this.propertyKey(key)}]`;
			const rt = this.typeOf(e);
			return isUntyped(spelledType(rt)) || isWriteTarget(e) ? code : this.fromAnyCode(code, rt, true);
		}
		// A homogeneous Swift tuple indexed dynamically (`next[startIndex]`): switch on the integer index.
		if (this.typeOf(e.expression).startsWith('(') && this.checker.isTupleType(receiverType)) {
			const parts = splitTopLevel(this.typeOf(e.expression).slice(1, -1));
			if (parts.length && parts.every((x) => x === parts[0])) {
				const cases = parts.map((_, k) => `case ${k}: return __t.${k}`).join('; ');
				return `{ (__t: ${this.typeOf(e.expression)}, __i: Int) -> ${parts[0]} in switch __i { ${cases}; default: return __t.0 } }(${target}, Int(${this.toNumber(key)}))`;
			}
		}
		// A computed key on an object (`this[side + 'Drawer']`): its members by name.
		if (this.isObjectRef(e.expression)) {
			const code = `${target}${q}[jsKey: ${this.propertyKey(key)}]`;
			const rt = this.typeOf(e);
			return isUntyped(spelledType(rt)) || isWriteTarget(e) ? code : this.fromAnyCode(code, rt, true);
		}
		throw this.error(e, 'indexing this type', 'index-type');
	},

	/** The Swift result type of the function a call resolves to, where the program declares it. */
	calledType(this: Translator, e: ts.CallExpression): string | undefined {
		// A library function that may give undefined (`map.get(k)`, `re.exec(s)`): the runtime's optional of what TypeScript types.
		if (this.libMayBeUndefined(e)) return optionalType(this.typeOf(e));
		const decl = this.checker.getResolvedSignature(e)?.getDeclaration();
		if (!decl || ts.isJSDocSignature(decl) || decl.getSourceFile().isDeclarationFile) return undefined;
		// An override takes its root's signature: an abstract method declared without a type returns nothing.
		if (ts.isMethodDeclaration(decl)) {
			let root = decl;
			for (let b = baseMethod(root, this.checker); b; b = baseMethod(root, this.checker)) root = b;
			if (!root.body && !root.type) return 'Void';
			return this.returnTypeOf(root);
		}
		return this.returnTypeOf(decl);
	},

	/** An `assertedUntyped` assertion read as the optional it may be: missing where the value is undefined or null. */
	/** `x as Iterable<T>` of a value not held as one: whatever x holds iterated, as GetIterator does where it is iterated. */
	assertedIterable(this: Translator, e: ts.AsExpression | ts.TypeAssertion | ts.SatisfiesExpression): string | null {
		const asserted = iterableAssertion(this.typeOf(e.expression), this.typeOf(e));
		return asserted && `(${RT.jsIterable}(${this.expr(e.expression)}${asserted.mayFail ? `, ${swiftString(notIterable(e))}` : ''}) as JSIterable<${asserted.element}>)`;
	},

	assertedOptional(this: Translator, e: ts.AsExpression | ts.TypeAssertion): string {
		const iterable = this.assertedIterable(e);
		if (iterable) return iterable;
		const t = this.typeOf(e),
			code = this.expr(e.expression);
		const entry = this.checkedAssertion(e);
		if (entry) return this.checkedConvert(code, entry, e, true)!;
		if (['String', 'Double', 'Bool'].includes(t)) return `${lenientReader(t, true)}(${code})`;
		if (this.checkedClassAssertion(e)) return this.marks.ownTried(`${RT.jsCast}(${code}, ${t}.self)`);
		return this.fromAny(code, optionalType(t));
	},

	/**
	 * An untyped value asserted to a class of the app's own code, where the slot it enters may be empty: an object of
	 * another class is JavaScript's TypeError there (`jsCast`, as Kotlin's), never an empty value.
	 */
	checkedClassAssertion(this: Translator, e: ts.AsExpression | ts.TypeAssertion | ts.SatisfiesExpression): boolean {
		return !this.lenient && !this.library && this.states.appCode(e) && this.appClass(this.checker.getTypeAtLocation(e));
	},

	/** Strict app code's object type, held present, that a `??` may give missing where both its operands may be. */
	missingObjectType(this: Translator, e: ts.Expression): boolean {
		const t = this.typeOf(e);
		return !this.library && !this.lenient && this.isObjectRef(e) && !/[?!]$/.test(t) && !isFunctionType(t);
	},

	/** A `missingObject` read Swift holds optional, as it is held; null where Swift holds it present. */
	heldMissing(this: Translator, e: ts.Expression): string | null {
		return this.marks.isUnwrap(this.expr(e)) || this.looseObjectRead(e) || this.widenedParameterRead(e) || /[?!]$/.test(this.declaredTypeOf(e) ?? '') ? this.observe(e, 'asIs') : null;
	},

	/** A read `observedAsIs` (`instanceof`'s left): the optional it may be, never unwrapped. */
	observed(this: Translator, e: ts.Expression): string {
		if (this.library || this.lenient) return this.expr(e);
		const raw = this.maybeUndefined(e);
		if (raw) return raw;
		const code = this.expr(e),
			m = this.marks.markOf(code);
		return m?.op === 'unwrap' ? m.of.code : code;
	},

	/**
	 * An expression that may be undefined though TypeScript types it as its element
	 * (`xs[i]` past the end, or a variable holding one), as a Swift optional; null otherwise.
	 */
	maybeUndefined(this: Translator, e: ts.Expression): string | null {
		return this.mayGiveUndefined(e)?.() ?? null;
	},

	/** `static { … }`: its statements run with the module's where the class is defined, in order with the static fields', `this` the class. */
	staticBlock(this: Translator, m: ts.ClassStaticBlockDeclaration, cls: string): void {
		if (!this.staticInits) throw this.error(m, 'a static block in a class not at the top of a module');
		const selves: ts.Node[] = [];
		const visit = (n: ts.Node): void => {
			if (n.kind === ts.SyntaxKind.ThisKeyword) selves.push(n);
			// A function or class of its own has a `this` of its own; an arrow function's is the block's.
			if (!ts.isFunctionDeclaration(n) && !ts.isFunctionExpression(n) && !ts.isClassLike(n) && !ts.isMethodDeclaration(n) && !ts.isAccessor(n)) ts.forEachChild(n, visit);
		};
		visit(m.body);
		for (const n of selves) this.subst.set(n, ident(cls));
		const saved = this.indent;
		this.indent = '        ';
		try {
			this.staticInits.push(`    do {\n${m.body.statements.map((st) => this.stmt(st)).join('\n')}\n    }`);
		} finally {
			this.indent = saved;
			for (const n of selves) this.subst.delete(n);
		}
	},

	/** Whether a class extends one of the library's error classes, directly or through the program's. */
	errorBased(this: Translator, cls: ts.ClassLikeDeclaration): boolean {
		const heritage = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
		if (!heritage) return false;
		const base = this.checker.getTypeAtLocation(heritage.expression).getSymbol()?.valueDeclaration;
		if (base && ts.isClassLike(base) && !base.getSourceFile().isDeclarationFile) return this.errorBased(base);
		return !!ERRORS[heritage.expression.getText()];
	},

	/**
	 * A member the program's own interface adds to a native class (`interface NSUINavigationBar extends
	 * UINavigationBar { gradientLayer?: … }`): kept with the native object, as the runtime keeps what script adds.
	 */
	isNativeExpando(this: Translator, e: ts.PropertyAccessExpression): boolean {
		const d = this.resolve(e.name)?.valueDeclaration;
		if (!d || d.getSourceFile().isDeclarationFile || !(ts.isPropertySignature(d) || ts.isPropertyDeclaration(d)) || !ts.isInterfaceDeclaration(d.parent)) return false;
		return (d.parent.heritageClauses ?? []).some((h) => h.types.some((x) => this.native.isClassType(this.checker.getTypeAtLocation(x))));
	},

	/** A program class as a value whose `name` the class declares (`Cls`, `this` in a static member, `this.constructor`), as Swift's metatype; null for anything else. */
	classValueOf(this: Translator, x: ts.Expression): string | null {
		const generated = (d: ts.Node | undefined) => !!d && ts.isClassDeclaration(d) && !d.getSourceFile().isDeclarationFile && !this.native.classExtendsNative(d as ts.ClassDeclaration) && !this.errorBased(d as ts.ClassDeclaration) && !!this.library?.moduleName(d.getSourceFile().fileName);
		if (x.kind === ts.SyntaxKind.ThisKeyword) {
			const container = ts.getThisContainer(x, false, false);
			return isStatic(container) && generated(container.parent) ? 'self' : null;
		}
		if (ts.isIdentifier(x)) {
			const sym = this.resolve(x);
			return sym && sym.flags & ts.SymbolFlags.Class && generated(sym.valueDeclaration) ? this.expr(x).replace(/\.self$/, '') : null;
		}
		if (ts.isPropertyAccessExpression(x) && x.name.text === 'constructor' && x.expression.kind === ts.SyntaxKind.ThisKeyword) {
			const container = ts.getThisContainer(x.expression, false, false);
			return !isStatic(container) && ts.isClassLike(container.parent) && generated(container.parent) ? 'type(of: self)' : null;
		}
		return null;
	},

	property(this: Translator, e: ts.PropertyAccessExpression): string {
		const arm = this.convertingMember(e);
		// A field of an erased type parameter (`Cached<T>.data`) holds any value: read as this instantiation types it.
		if (arm?.arm === 'param') {
			const want = this.typeOf(e);
			const read = this.propertyRead(e);
			// An untyped object's member is read as `want` already; a signal's value (`Signal<T>`, a ref) is held as its type.
			const signal = /^Signal<(.*)>[?!]?$/.exec(this.typeOf(e.expression))?.[1];
			return isUntyped(spelledType(want)) || this.isAny(e.expression) || signal === want ? read : this.fromAny(read, want);
		}
		// A field of an erased generic class typed by its parameters (`data: T`, `points: T[]`): read as this instantiation types it.
		if (arm?.arm === 'member') {
			const held = arm.held,
				want = this.typeOf(e);
			const read = this.propertyRead(e);
			if (held === want || isUntyped(spelledType(want)) || want === 'Void' || this.heldWeakRef(e)) return read;
			if (isUntyped(spelledType(held))) return this.fromAny(read, want);
			return isOptional(held) && !isOptional(want) ? this.fromAny(this.marks.castCode(read, 'Any', 'as'), want) : this.convert(read, held, want);
		}
		if (arm?.arm === 'root') {
			const root = arm.root,
				want = this.typeOf(e);
			if (isUntyped(spelledType(root))) return this.isAny(e.expression) ? this.propertyRead(e) : this.fromAny(this.propertyRead(e), want);
			if (isUntyped(spelledType(want))) return this.marks.castCode(this.propertyRead(e), 'Any', 'as');
			const to = want.replace(/[?!]$/, '');
			// Narrowed where it is read too (`v.view instanceof UIButton ? v.view.titleLabel : …`): cast as `narrowing` casts.
			return this.isObjectRef(e) && this.declaredTypeOf(e)?.replace(/[?!]$/, '') !== to ? this.narrowCast(e, this.propertyRead(e), to) : this.forcedCast(this.propertyRead(e), to);
		}
		return this.propertyRead(e);
	},
};
