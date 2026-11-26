// Member and element reads as Kotlin: properties, receivers, element access and asserted reads.
import { heldLoss } from '../semantics/losses.ts';
import ts from 'typescript';
import { propSignal } from '../semantics/signals.ts';
import { KIT_NAMES_ANDROID, LIB_CONSTANTS, MATH } from './library.ts';
import { prototypeClassSymbol } from '../semantics/classes.ts';
import { isCoreDeclaration } from '../program/core-facts.ts';
import { mathFunctionValue } from '../semantics/apis/math.ts';
import { CONSOLE } from '../semantics/apis/console.ts';
import { libFunctionValueKind } from '../semantics/apis/statics.ts';
import { ERRORS, isLibGlobal } from '../semantics/globals.ts';
import { spell, ident, isCompared, isNullable, isThisParameter, kotlinString, numberLiteral, optionalType, testsMissing, scriptPrimitive, RT, assertedReader } from './syntax.ts';
import type { Translator } from './translator.ts';
import { observerSlot, place, receiverCell, receiverSlot, isEnumObject, nullishField, type ReceiverCell } from '../semantics/placement.ts';
import { accessedDeclaration, augmentedPropertyRead, functionProperty, wellKnownMember, isSelf, literalMethod, uncheckedMatch } from '../semantics/lang.ts';
import { convertedRead, onlyNull } from '../semantics/states/predicates.ts';
import { isLibDeclaration, isWriteTarget, notIterable } from '../semantics/ast.ts';
import { isStatic } from '../semantics/throws.ts';
import { constClassExpr, declaredClassName } from '../semantics/classes.ts';
import { isKit, isNamed, isUntyped, iterableAssertion, spelledType, type NativeType } from '../semantics/types.ts';
import { definedField } from '../semantics/shapes.ts';
import { programSymbolKey } from '../program/stable-names.ts';
import { byKey, symbolField } from '../semantics/spelled.ts';

export const accessMethods = {
	/** A symbol's property key; a symbol Kotlin holds nullable keys as undefined does when it is missing. */
	symbolKey(this: Translator, code: string): string {
		return this.isAsserted(code) ? `(${this.unasserted(code)}?.key ?: "undefined")` : `${code}.key`;
	},

	/** `this.x` in a static method, of a static field the class declares: the companion's. */
	staticOwnRead(this: Translator, e: ts.PropertyAccessExpression): boolean {
		return e.expression.kind === ts.SyntaxKind.ThisKeyword && !!this.resolve(e.name)?.declarations?.some((d) => ts.isPropertyDeclaration(d) && isStatic(d));
	},

	property(this: Translator, e: ts.PropertyAccessExpression): string {
		const name = e.name.text;
		const target = e.expression;
		this.refuseProto(e);
		this.refuseIntlMember(e);
		if (!e.questionDotToken && !isWriteTarget(e)) {
			const continued = this.continuedChain(e, target, () => this.property(e));
			if (continued) return continued;
		}
		const arm = this.convertingMember(e, this.erasedReads.has(e));
		// A field of an erased type parameter (`Cached<T>.data`) or erased generic class holds any value: read as this instantiation types it.
		if (arm === 'erased') {
			const want = this.typeOf(e);
			this.erasedReads.add(e);
			try {
				const read = this.expr(e);
				return isUntyped(spelledType(want)) ? read : e.questionDotToken || isNullable(want) ? this.fromAny(read, optionalType(want)) : /^JSArray</.test(want) ? this.fromAny(read, want) : this.fromAnyCode(read, want, true);
			} finally {
				this.erasedReads.delete(e);
			}
		}
		// A name of the global object (`global.X`, which a binding installs): read by name, as script reads it.
		if (arm === 'global') {
			// A Java package's root (`global.android`): the runtime's package object, as NativeScript's global has it.
			if (this.isJavaPackage(this.resolve(e.name))) return `JSJavaPackage(${kotlinString(name)})`;
			const t = this.typeOf(e);
			return isUntyped(spelledType(t)) ? `${RT.jsGet}(jsGlobalThis, ${kotlinString(name)})` : this.fromAnyCode(`${RT.jsGet}(jsGlobalThis, ${kotlinString(name)})`, t, true);
		}
		// A dynamic object (an allSettled result, an enum's object): its field read by name, as its type says.
		if (arm === 'dynamic') {
			const t = this.typeOf(e);
			const read = `${RT.jsField}(${this.expr(target)}, ${kotlinString(name)})`;
			return isUntyped(spelledType(t)) ? read : this.fromAnyCode(read, t, true);
		}
		if (isSelf(target, this.subst) && this.props.has(name)) return propSignal(e, this.checker, this.framework) ? `this.${ident(name)}` : `this.${ident(name)}.value`;
		// A value this platform's code never has (the iOS half of `__APPLE__ ? x : null`, narrowed to never): read by name.
		if (!this.library && this.typeOf(target) === 'Nothing' && !isWriteTarget(e)) return `${RT.jsGet}(${ts.isIdentifier(target) ? ident(target.text) : this.coerce(target, 'Any?')}, ${kotlinString(name)})`;
		if (name === 'raw' && this.symbolName(target) === 'TemplateStringsArray') return `${RT.jsTemplateRaw}(${this.expr(target)})`;
		if (name === 'description' && this.typeOf(target) === 'JSSymbol') return `${this.expr(target)}.jsDescription`;
		if (this.isAmbient(e)) return `${RT.jsGetIfPresent}(${this.expr(target)}, ${kotlinString(name)})`;
		// Library mode: a Java package used as a value (`const graphics = androidx.core.graphics`), or read on through `?.`.
		if (this.isJavaPackage(this.resolve(e.name)) && (this.library ? !ts.isPropertyAccessExpression(e.parent) || !!e.parent.questionDotToken : ts.isPropertyAccessExpression(e.parent) && !!e.parent.questionDotToken)) return `JSJavaPackage(${kotlinString(e.getText().replace(/\s+|\?/g, ''))})`;
		if (name === 'prototype') this.refuseClassPrototype(e);
		// `Function.prototype`: a function doing nothing.
		if (name === 'prototype' && ts.isIdentifier(target) && target.text === 'Function' && this.resolve(target)?.declarations?.every((d) => d.getSourceFile().isDeclarationFile)) return 'JSFunction { null }';
		// A class's prototype, the registry's object for it.
		const protoSym = prototypeClassSymbol(target, name, this);
		if (protoSym) {
			const declOnly = protoSym.declarations?.every((d) => d.getSourceFile().isDeclarationFile);
			const clsName = declOnly ? (isCoreDeclaration(protoSym.declarations?.[0]) ? (KIT_NAMES_ANDROID[protoSym.name] ?? protoSym.name) : null) : this.expr(target);
			if (clsName) return `JSPrototypes.of(${clsName}::class.java)`;
		}
		if (ts.isIdentifier(target) && isLibGlobal(this, target)) {
			const constant = LIB_CONSTANTS[`${target.text}.${name}`];
			if (constant) return constant;
			if (`${target.text}.${name}` === 'Date.now') return '{ JSDate.now() }';
			// `const round = Math.round`: the function as a value.
			const mathValue = target.text === 'Math' ? mathFunctionValue(name) : null;
			if (mathValue) return `{ __x: Double -> ${MATH[mathValue]}(__x) }`;
			const libFn = libFunctionValueKind(target.text, name);
			if (libFn === 'console') {
				const fn = RT[CONSOLE[name].op];
				return this.convert(`{ __args: JSArray<Any?> -> ${fn}(*__args.storage.toTypedArray()) }`, '(JSArray<Any?>) -> Unit', this.typeOf(e));
			}
			if (libFn === 'fromCharCode') return this.convert(`{ __args: JSArray<Double> -> ${RT.jsFromCharCode}(*__args.storage.toDoubleArray()) }`, '(JSArray<Double>) -> String', this.typeOf(e));
			if (libFn === 'fromCodePoint') return this.convert(`{ __args: JSArray<Double> -> ${RT.jsFromCodePoint}(*__args.storage.toDoubleArray()) }`, '(JSArray<Double>) -> String', this.typeOf(e));
			if (libFn === 'mathRandom') return this.convert('{ Math.random() }', '() -> Double', this.typeOf(e));
			if (libFn === 'mathVariadic') return this.convert(`{ __args: JSArray<Double> -> ${name === 'min' ? RT.jsMathMin : RT.jsMathMax}(*__args.storage.toDoubleArray()) }`, '(JSArray<Double>) -> Double', this.typeOf(e));
			if (libFn === 'typedArrayFrom') return this.convert(`{ __v: Any? -> JS${target.text}.from(__v) }`, `(Any?) -> JS${target.text}`, this.typeOf(e));
			if (libFn === 'isArray') return this.convert(`{ __v: Any? -> JSArray.isArray(__v) }`, '(Any?) -> Boolean', this.typeOf(e));
			if (libFn === 'numberCheck') {
				const test = name === 'isInteger' ? `${RT.jsIsInteger}(it)` : name === 'isSafeInteger' ? `${RT.jsIsSafeInteger}(it)` : name === 'isFinite' ? `${RT.jsIsFinite}(it)` : 'it.isNaN()';
				return this.convert(`{ __v: Any? -> ((__v as? Double)?.let { ${test} } ?: false) }`, '(Any?) -> Boolean', this.typeOf(e));
			}
			if (this.isAugmentedLibMember(e)) return '(null as Any?)';
			throw this.error(e, `${target.text}.${name}`, name === 'prototype' ? 'builtin-prototype' : this.checker.getSymbolAtLocation(e.name)?.flags! & ts.SymbolFlags.Method ? 'function-value' : 'library-member');
		}
		const enumMember = this.checker.getSymbolAtLocation(e.name)?.valueDeclaration;
		const constant = enumMember && ts.isEnumMember(enumMember) ? this.checker.getConstantValue(enumMember) : undefined;
		if (constant !== undefined && enumMember!.getSourceFile().isDeclarationFile && !this.native?.isNativeDeclaration(enumMember!)) {
			return typeof constant === 'string' ? kotlinString(constant) : numberLiteral(String(constant));
		}
		const fnMeta = functionProperty(e, this.checker);
		if (fnMeta) return fnMeta.kind === 'length' ? `${fnMeta.value}.0` : kotlinString(fnMeta.value);
		// `object.constructor`, the class of the instance.
		if (name === 'constructor' && !this.isAny(target) && this.checker.getSymbolAtLocation(e.name)?.declarations?.every((d) => d.getSourceFile().isDeclarationFile)) {
			const primCtor = ({ String: 'jsStringConstructor', Double: 'jsNumberConstructor', Boolean: 'jsBooleanConstructor' } as Record<string, string>)[this.typeOf(target)];
			if (primCtor) return primCtor;
			const code = this.expr(target);
			return `${this.typeOf(target).endsWith('?') || this.isAsserted(code) ? this.present(code, name, target) : code}.javaClass`;
		}
		// A constructor's name: the library's error classes by their JavaScript names, a class held as a value by its own.
		if (name === 'name' && !isWriteTarget(e)) {
			const declared = declaredClassName(e, this.checker);
			if (declared !== null) return kotlinString(declared);
			if (ts.isIdentifier(target) && ERRORS[target.text] && isLibDeclaration(this.resolve(target)?.declarations?.[0])) return kotlinString(target.text);
			const ctor = ts.isPropertyAccessExpression(target) && target.name.text === 'constructor' && !this.isAny(target.expression) && !!this.checker.getSymbolAtLocation(target.name)?.declarations?.every((d) => d.getSourceFile().isDeclarationFile);
			if (ctor || this.typeOf(target).replace(/\?$/, '').startsWith('Class<')) return `${RT.jsConstructorName}(${this.expr(target)})`;
		}
		// A match's `groups` is the runtime's plain object: read as the dictionary its type says.
		if (name === 'groups' && !isWriteTarget(e) && isNamed(spelledType(this.typeOf(target)), 'JSMatch', false) && /^JSRecord<.*>\??$/.test(this.typeOf(e))) {
			const value = this.typeOf(e)
				.replace(/\?$/, '')
				.replace(/^JSRecord<(.*)>$/, '$1');
			return `${RT.jsRecordOrNull}<${value}>(${this.expr(target)}${e.questionDotToken || this.typeOf(target).endsWith('?') ? '?' : ''}.groups)`;
		}
		const method = e.questionDotToken && !isWriteTarget(e) ? this.native?.methodValue?.(e) : null;
		if (method) return method;
		const maybeChain = e.questionDotToken ? this.maybeUndefined(e) : null;
		// An array the chain reads an element of (`group?.items[i]`): the element read goes on with the chain.
		const intoElement = ts.isElementAccessExpression(e.parent) && e.parent.expression === e && !!(e.parent.flags & ts.NodeFlags.OptionalChain) && !isWriteTarget(e.parent) && isKit(spelledType(this.typeOf(e)), 'JSArray');
		if (maybeChain) return intoElement ? maybeChain : this.undefinedAs(maybeChain, this.typeOf(e));
		const kit = isWriteTarget(e) ? null : (this.core?.augmentedRead(e) ?? null);
		if (kit !== null) {
			const t = this.typeOf(e);
			if (['String', 'Double', 'Boolean'].includes(t) && convertedRead(e)) return this.undefinedAs(this.fromAny(kit, optionalType(t)), t);
			return this.fromAnyCode(kit, t, true);
		}
		const core = this.core?.property(e);
		if (core) return core;
		const ce = constClassExpr(target, this.checker);
		if (ce) return `${this.emitClassExprCode(ce)}.${ident(name)}`;
		if (this.isExpando(e)) {
			const t = this.typeOf(e);
			const code = `${RT.jsGet}(${this.expr(target)}, ${kotlinString(name)})`;
			if (!isWriteTarget(e) && ['String', 'Double', 'Boolean'].includes(t) && convertedRead(e) && augmentedPropertyRead(e, this.checker)) return this.undefinedAs(this.fromAny(code, optionalType(t)), t);
			return isUntyped(spelledType(t)) || isWriteTarget(e) ? code : this.fromAnyCode(code, t, true);
		}
		const native = this.native?.property(e);
		if (native) return native;
		// Library mode: a Java class used as a value (`const compat = androidx.core.view.ViewCompat`).
		const p = e.parent;
		const cls = this.library ? this.resolve(e.name) : undefined;
		if (cls && cls.flags & ts.SymbolFlags.Class && cls.declarations?.some((d) => this.native?.isNativeDeclaration(d)) && !((ts.isPropertyAccessExpression(p) || ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === e) && !(ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) && !ts.isExpressionWithTypeArguments(p)) return `${e.getText().replace(/\s+/g, '')}::class.java`;
		// A field the app's class only types again: the kit class's property, read as the app declares it.
		const retyped = this.checker.getSymbolAtLocation(e.name)?.valueDeclaration;
		if (!isWriteTarget(e) && this.kitRedeclared(retyped)) {
			const kitType = this.core!.kitMember(this.kitRootOf(retyped!.parent as ts.ClassLikeDeclaration)!, name)!.type;
			const own = this.typeOf(e);
			const read = `${this.typeOf(target).endsWith('?') ? (e.questionDotToken ? `${this.expr(target)}?` : this.present(this.expr(target), name, target)) : this.expr(target)}.${ident(name)}`;
			return kitType === own ? read : kitType.replace(/\?$/, '') === own.replace(/\?$/, '') ? this.convert(read, kitType, own) : this.unchecked(own, read);
		}
		if (this.structuralTypeParam(target)) {
			const t = this.typeOf(e);
			const code = `${RT.jsGet}(${this.expr(target)}, ${kotlinString(name)})`;
			return isUntyped(spelledType(t)) || isWriteTarget(e) ? code : this.fromAnyCode(code, t, true);
		}
		const base = this.typeOf(target);
		// An event's data beyond its name, object and value (a drawer's `side`): read by key.
		if (isNamed(spelledType(base), 'EventData', false) && !(this.library ? ['eventName', 'object'] : ['value', 'item', 'eventName', 'object', 'index', 'view', 'type', 'state', 'deltaX', 'deltaY', 'scale', 'rotation', 'direction', 'action', 'newValue']).includes(name)) {
			if (this.library) {
				const t = this.typeOf(e);
				const code = `${RT.jsGet}(${this.expr(target)}, ${kotlinString(name)})`;
				return isUntyped(spelledType(t)) || isWriteTarget(e) ? code : this.fromAnyCode(code, t, true);
			}
			const t = this.typeOf(e);
			const code = `${this.expr(target)}.jsGet(${kotlinString(name)})`;
			return isUntyped(spelledType(t)) ? code : this.fromAnyCode(code, t, true);
		}
		// An event's object typed as the view that raises it (`args: { object: Chart }`): the generated kit's EventData holds an Observable.
		if (this.generatedKit && name === 'object' && isNamed(spelledType(base), 'EventData', false) && !e.questionDotToken && !isWriteTarget(e)) {
			const t = this.typeOf(e);
			if (!isUntyped(spelledType(t)) && !/^Observable\??$/.test(t)) return `(${base.endsWith('?') ? this.present(this.expr(target), 'object', target) : this.expr(target)}.\`object\` as ${t})`;
		}
		// The generated kit's EventData holds its object nullable: a member read through it (`args.object.get(…)`) reads it present.
		if (this.generatedKit && name === 'object' && isNamed(spelledType(base), 'EventData', false) && !e.questionDotToken && !isWriteTarget(e) && ts.isPropertyAccessExpression(e.parent) && e.parent.expression === e && !e.parent.questionDotToken) {
			return this.asserted(`${base.endsWith('?') ? this.present(this.expr(target), 'object', target) : this.expr(target)}.\`object\``);
		}
		// Inside an optional chain (`a?.b.c`) an undefined link ends the chain.
		const inChain = !!(e.flags & ts.NodeFlags.OptionalChain) && base.endsWith('?');
		const dot = e.questionDotToken || inChain ? '?.' : '.';
		const recv = () => {
			const checked = this.receiver(target, name);
			if (checked) return checked;
			const code = this.expr(target);
			// A non-strict app's name Kotlin declares nullable though its type says present (an object-typed parameter).
			const held = this.lenientApp && !this.library && ts.isIdentifier(target) && code === ident(target.text) && this.states.heldOptional(target);
			const proven = (base.endsWith('?') || held) && ts.isIdentifier(target) && code === ident(target.text) && this.smartCast(target);
			return ((base.endsWith('?') || held) && !proven && !e.questionDotToken && !inChain && !isSelf(target, this.subst)) || this.isAsserted(code) ? this.present(code, name, target, isWriteTarget(e)) : code;
		};
		if (name === 'length' && this.isString(target)) {
			return e.questionDotToken || inChain ? `${this.expr(target)}?.length?.toDouble()` : `${recv()}.length.toDouble()`;
		}
		if (name === 'length' && (base.startsWith('Pair<') || base.startsWith('Triple<'))) return base.startsWith('Pair<') ? '2.0' : '3.0';
		const staticOwn = this.staticOwnRead(e);
		if (this.isAny(target) && !staticOwn) {
			const t = this.typeOf(e);
			const code = `${e.questionDotToken || inChain ? RT.jsGetIfPresent : RT.jsGet}(${this.expr(target)}, ${kotlinString(name)})`;
			// Library mode: a member an untyped object may lack, as script reads it (its type's undefined).
			return isUntyped(spelledType(t)) || isWriteTarget(e) ? code : isCompared(e) || (!this.library && (e.questionDotToken || inChain) && testsMissing(e)) || (this.library && (e.questionDotToken || inChain) && this.isObjectType(t) && !((ts.isPropertyAccessExpression(e.parent) || ts.isElementAccessExpression(e.parent)) && e.parent.expression === e && !e.parent.questionDotToken)) ? this.fromAny(code, optionalType(t)) : this.library || t === 'Double' ? this.fromAnyCode(code, t, true) : this.fromAny(code, t);
		}
		if (byKey(this, e)) {
			const read = base.endsWith('?') ? `${this.expr(target)}?.get(${kotlinString(name)})` : `${this.expr(target)}[${kotlinString(name)}]`;
			const t = this.typeOf(e);
			if (isWriteTarget(e) || t.endsWith('?')) return read;
			const z = this.zero(t);
			if (z && z !== 'null') heldLoss('keyedRead', z);
			return z && z !== 'null' ? `(${read} ?: ${z})` : this.asserted(read);
		}
		// An iterator's optional `return`/`throw` read as a value: the function, or undefined where it has none.
		if (/^JS(Iterator|Generator)</.test(base) && (name === 'return' || name === 'throw') && !isWriteTarget(e)) {
			const [has, fn] = name === 'return' ? ['jsHasReturn', 'jsReturnResult'] : ['jsHasThrow', 'jsThrowResult'];
			return `${this.expr(target)}?.let { __it -> if (__it.${has}) { __v: Any? -> __it.${fn}(__v) } else null }`;
		}
		if (base === 'EventData' && (name === 'value' || name === 'item')) {
			const t = this.typeOf(e);
			return isUntyped(spelledType(t)) ? `${this.expr(target)}.${name}` : this.fromAny(`${this.expr(target)}.${name}`, t);
		}
		// A method used as a value is a bound reference.
		const symbol = this.checker.getSymbolAtLocation(e.name);
		const called = ts.isCallExpression(e.parent) && e.parent.expression === e;
		// Library mode: a promise's method, its Kotlin overloads generic: the method as script reads it.
		if (this.library && symbol && symbol.flags & ts.SymbolFlags.Method && !called && isLibDeclaration(symbol.declarations?.[0]) && /^JSPromise</.test(base)) return this.fromAnyCode(`${RT.jsGet}(${this.coerce(target, 'Any?')}, ${kotlinString(name)})`, this.typeOf(e), true);
		if (symbol && symbol.flags & ts.SymbolFlags.Method && !called && !this.isFunctionField(symbol)) {
			// A static method of a class the program declares: its companion's, not the instance method of that name (`ColorBase.equals`).
			const decl = symbol.valueDeclaration;
			const method = this.isCompiledMethod(symbol) ? this.compiledMethodIdent(symbol, name) : ident(name);
			if (this.library && decl && ts.isMethodDeclaration(decl) && isStatic(decl) && ts.isClassDeclaration(decl.parent) && !decl.getSourceFile().isDeclarationFile && !decl.parameters.some((q) => q.dotDotDotToken || isThisParameter(q))) {
				const params = decl.parameters.map((q, k) => `__s${k}: ${this.paramType(q)}`);
				return `{ ${params.join(', ')} -> ${this.className(decl.parent)}.${method}(${decl.parameters.map((_, k) => `__s${k}`).join(', ')}) }`;
			}
			// The base's method as a value: Kotlin has no `super::m`, but a lambda in the class may call `super.m`.
			if (target.kind === ts.SyntaxKind.SuperKeyword && decl && ts.isMethodDeclaration(decl) && !decl.parameters.some((q) => q.dotDotDotToken || isThisParameter(q))) {
				const params = decl.parameters.map((q, k) => `__s${k}: ${this.paramType(q)}`);
				return `{ ${params.join(', ')}${params.length ? ' ' : ''}-> super.${method}(${decl.parameters.map((_, k) => `__s${k}`).join(', ')}) }`;
			}
			const r = recv();
			if (target.kind !== ts.SyntaxKind.SuperKeyword && !isWriteTarget(e) && this.isInstanceKey(e.name)) {
				const o = this.fresh('__o'),
					own = this.fresh('__own');
				const read = `val ${own} = ${RT.jsOwnProperty}(${o}, ${kotlinString(name)}); if (${own} != null) ${this.fromAnyCode(`${own}.value`, this.typeOf(e).replace(/\?$/, ''), true)} else ${o}::${method}`;
				return r.endsWith('?') ? `${r.slice(0, -1)}?.let { ${o} -> ${read} }` : `${r}.let { ${o} -> ${read} }`;
			}
			// Read through `?.` (`child?.getChildAt`): undefined where the receiver is.
			return r.endsWith('?') ? `${r.slice(0, -1)}?.let { __r -> __r::${method} }` : `${r}::${method}`;
		}
		// Library mode: a member core's declarations type otherwise than its compiled class (`parent: View` of `index.d.ts`, `ViewBase` compiled): cast.
		const described = this.library && symbol?.valueDeclaration?.getSourceFile().isDeclarationFile && !isLibDeclaration(symbol.valueDeclaration) && !this.native?.isNativeDeclaration(symbol.valueDeclaration) && !isWriteTarget(e) ? (this.fieldIn(this.checker.getNonNullableType(this.checker.getTypeAtLocation(target)), name) ?? this.compiledField(this.checker.getNonNullableType(this.checker.getTypeAtLocation(target)), name)) : undefined;
		// Library mode: a field of a generic class (`Property<T, U>.defaultValue`), its type parameters erased: read as this use's type.
		// So is any field compiled untyped that this read types (`Style.fontStyle`, a union of strings and an enum's).
		// So is a field or getter of a package's source (`FormGroup.controls`) read outside it, its class's type parameters erased.
		const vd = accessedDeclaration(symbol);
		const packageMember = !this.library && !!vd && (ts.isPropertyDeclaration(vd) || ts.isGetAccessorDeclaration(vd)) && this.pluginFiles.has(vd.getSourceFile().fileName) && !this.pluginFiles.has(e.getSourceFile().fileName);
		const erased = (this.library || packageMember) && vd && (ts.isPropertyDeclaration(vd) || (packageMember && ts.isGetAccessorDeclaration(vd))) && !vd.getSourceFile().isDeclarationFile && ts.isClassLike(vd.parent) && !isWriteTarget(e) && !this.erasedReads.has(e) && this.isAny(vd.name) && !this.isAny(e);
		// A package's record or array is read as script reads it, a plain object shared rather than refused.
		if (erased) return packageMember && /^JS(Record|Array)</.test(this.typeOf(e)) ? this.fromAny(`${recv()}${dot}${ident(name)}`, this.typeOf(e)) : this.fromAnyCode(`${recv()}${dot}${ident(name)}`, this.typeOf(e), true);
		// Library mode: a member core's declarations give a class whose compiled code has none (`Transition.androidFragmentTransactionCallback`,
		// its subclasses'): read by name.
		const describedClass = this.library && symbol?.valueDeclaration?.getSourceFile().isDeclarationFile && !isLibDeclaration(symbol.valueDeclaration) && !this.native?.isNativeDeclaration(symbol.valueDeclaration) ? this.compiledClasses().get(this.checker.getNonNullableType(this.checker.getTypeAtLocation(target)).getSymbol()?.name ?? '') : undefined;
		// Library mode: a member TypeScript does not find on the type (lenient code reading what the type omits): read by name.
		const unknown = this.library && !symbol && !e.name.text.startsWith('#') && this.isObjectRef(target);
		if (((describedClass && !this.compiledMember(describedClass, name)) || unknown) && !(ts.isCallExpression(e.parent) && e.parent.expression === e && !e.parent.questionDotToken)) {
			const t = this.typeOf(e);
			const code = `${e.questionDotToken || inChain ? RT.jsGetIfPresent : RT.jsGet}(${this.expr(target)}, ${kotlinString(name)})`;
			// Called (`x.callback?.(…)`): the function as script holds it, which the call reads.
			return isUntyped(spelledType(t)) || isWriteTarget(e) || (ts.isCallExpression(e.parent) && e.parent.expression === e) ? code : this.fromAnyCode(code, t, true);
		}
		if (described) {
			const t = this.typeOf(e);
			const own = this.typeOf(described.name);
			// Compiled untyped (a union of strings and an enum's): as this read's type, the type's zero where it is missing.
			if (isUntyped(spelledType(own)) && !isUntyped(spelledType(t)) && !isWriteTarget(e)) return this.fromAnyCode(`${recv()}${dot}${ident(name)}`, t, true);
			if (!isUntyped(spelledType(t)) && own.replace(/\?$/, '') !== t.replace(/\?$/, '') && this.isObjectType(t)) return this.narrowed(e, `(${recv()}${dot}${ident(name)} as ${optionalType(t)})`);
		}
		// Library mode: a field a subclass redeclares more narrowly is its base's, cast to the subclass's type.
		const held = symbol?.valueDeclaration;
		const redeclared = held && (this.library || this.pluginFiles.has(held.getSourceFile().fileName)) && (ts.isPropertyDeclaration(held) || ts.isParameter(held)) && this.redeclaredField(held);
		if (redeclared && !isWriteTarget(e)) {
			const t = this.typeOf(e);
			const base = this.typeOf(redeclared.name);
			// Over an untyped base field, which may hold JavaScript's null.
			if (!isUntyped(spelledType(t)) && t !== base) return this.narrowed(e, isUntyped(spelledType(base)) ? this.fromAny(`${recv()}${dot}${ident(name)}`, optionalType(t)) : `(${recv()}${dot}${ident(name)} as ${optionalType(t)})`);
		}
		const receiver = recv();
		const plain = `${receiver}${dot}${ident(name)}`;
		const read = dot === '.' ? this.marks.marked(plain, { op: 'member', of: this.marks.valueOf(receiver), name }) : plain;
		// A non-strict app's optional member is held optional though its type says present: a value read reads its undefined.
		if ((this.optionalMember(e) || (!e.questionDotToken && !(e.flags & ts.NodeFlags.OptionalChain) && !!symbol && this.states.shapeFieldOptional(symbol))) && !isWriteTarget(e) && !this.nullOk.has(e) && ['String', 'Double', 'Boolean'].includes(this.typeOf(e))) return this.undefinedAs(read, this.typeOf(e));
		return this.narrowed(e, read);
	},

	/** A method an object type declares, which its class for object literals holds as a function-typed field. */
	isFunctionField(this: Translator, symbol: ts.Symbol): boolean {
		return (
			!!symbol.declarations?.length &&
			symbol.declarations.every((d) => {
				if (literalMethod(d)) return true;
				if (!ts.isMethodSignature(d)) return false;
				const owner = ts.isInterfaceDeclaration(d.parent) ? this.topName(d.parent, d.parent.name.text) : ts.isTypeLiteralNode(d.parent) && ts.isTypeAliasDeclaration(d.parent.parent) ? this.topName(d.parent.parent, d.parent.parent.name.text) : null;
				return !!owner && this.interfaces.has(owner) && !this.protocols.has(owner);
			})
		);
	},

	/** A key as its message names it. */
	keyText(this: Translator, key: ts.Expression): string {
		return ts.isNumericLiteral(key) || ts.isStringLiteral(key) ? kotlinString(key.text) : this.str(key);
	},

	/** A receiver that can be missing though its type says not (`x!`, `items[i]`): JavaScript's TypeError when it is. */
	receiver(this: Translator, target: ts.Expression, key: string): string | null {
		const x = ts.skipOuterExpressions(target, ts.OuterExpressionKinds.Parentheses);
		// A call's receiver it already substituted checked reads as that substitute; `x!` reads its operand, never substituted.
		if (!ts.isNonNullExpression(x) && (this.checkedSubst.has(target) || this.checkedSubst.has(x))) return null;
		if (nullishField(this, x) && !this.subst.has(x) && !receiverSlot(target, key).chained) return `${this.nullishCode(x)}.${this.states.nullishMemberKey(x).set ? 'presentToSet' : 'present'}(${kotlinString(key)})`;
		const slot = receiverSlot(target, key);
		const cell = receiverCell(this.receivers, slot);
		// A local Kotlin itself proves present here never takes the TypeError branch.
		if (cell.cell === 'present' && ts.isIdentifier(x) && this.smartCast(x)) return null;
		// A chain's link `continuedChain` holds by a local, which it has checked.
		if (cell.cell === 'chained' && this.subst.has(x)) return null;
		// A read converting undefined to its text, NaN or false: a member of undefined is JavaScript's TypeError.
		const converted = cell.cell === 'asIs' && !slot.chained && !this.subst.has(x) && !this.lenient && this.states.appCode(target) ? this.undefinedConverted(this.expr(target)) : null;
		return this.receiverCode(converted ? { cell: 'present', code: converted, isNull: false } : cell, key);
	},

	/** A receiver cell as Kotlin writes it: null where the access reads it as it is. */
	receiverCode(this: Translator, c: ReceiverCell, key: string): string | null {
		if (c.cell === 'chained') {
			// Undefined where the chain stops: the link is read with its guard held by a local, present there.
			const v = this.fresh('__g');
			const guard = this.unasserted(this.expr(c.guard));
			this.subst.set(c.guard, v);
			try {
				const receiver = this.maybeUndefined(c.receiver) ?? this.unasserted(this.expr(c.receiver));
				return `${guard}?.let { ${v} -> ${receiver} ?: ${c.isNull ? RT.jsCannotReadNull : RT.jsCannotRead}(${kotlinString(key)}) }`;
			} finally {
				this.subst.delete(c.guard);
			}
		}
		return c.cell === 'asIs' ? null : `(${c.code} ?: ${c.isNull ? RT.jsCannotReadNull : RT.jsCannotRead}(${kotlinString(key)}))`;
	},

	/** A call whose result Kotlin holds nullable though its type says present, read as it is held. */
	heldResult(this: Translator, x: ts.Expression): string | null {
		if (!ts.isCallExpression(x) || !this.unwrapsResult(x)) return null;
		this.rawResults.add(x);
		try {
			return this.expr(x);
		} finally {
			this.rawResults.delete(x);
		}
	},

	/** A parameter or member Kotlin declares optional, read as it is held. */
	optionalRead(this: Translator, x: ts.Expression): string | null {
		// Library code reads its own interfaces' members by key (`jsGet`): they have no Kotlin field to read as held.
		if (ts.isPropertyAccessExpression(x) && this.library && this.resolve(x.name)?.declarations?.some((d) => ts.isPropertySignature(d) && !isLibDeclaration(d))) return null;
		if (ts.isPropertyAccessExpression(x)) {
			if (!(this.optionalMember(x) || (!this.typeOf(x).endsWith('?') && !!this.declaredTypeOf(x)?.endsWith('?')))) return null;
			return this.isExpando(x) ? this.fromAny(`${RT.jsGet}(${this.expr(x.expression)}, ${kotlinString(x.name.text)})`, optionalType(this.typeOf(x))) : `${this.expr(x.expression)}.${ident(x.name.text)}`;
		}
		const d = ts.isIdentifier(x) ? this.resolve(x)?.valueDeclaration : undefined;
		if (!d || !(ts.isParameter(d) || ts.isVariableDeclaration(d)) || !this.declaredTypeOf(x)?.endsWith('?')) return null;
		this.rawNames.add(x);
		try {
			const t = this.typeOf(x);
			// A variable held untyped that its type narrows to an object here (`var m; m = re.exec(s)`): its members are read
			// as that type's, null kept. A string, number or boolean's members are the runtime's, read untyped.
			return isUntyped(spelledType(this.declaredTypeOf(x))) && !scriptPrimitive(t) ? this.fromAny(this.expr(x), optionalType(t)) : this.expr(x);
		} finally {
			this.rawNames.delete(x);
		}
	},

	/**
	 * Non-strict code's read of a string, number or boolean member declared optional (`width?: number`) that Kotlin holds
	 * nullable though its type says present.
	 */
	lenientMissingMember(this: Translator, x: ts.Expression): x is ts.PropertyAccessExpression {
		if (!(this.lenient || this.lenientApp) || this.library || !ts.isPropertyAccessExpression(x) || ts.isOptionalChain(x) || isWriteTarget(x)) return false;
		const t = this.typeOf(x);
		if (!['String', 'Double', 'Boolean'].includes(t) || this.isAny(x.expression)) return false;
		const d = this.resolve(x.name)?.valueDeclaration;
		return !!d && (ts.isPropertySignature(d) || ts.isPropertyDeclaration(d)) && !!d.questionToken && !d.getSourceFile().isDeclarationFile && this.declaredTypeOf(x) === optionalType(t);
	},

	/** Non-strict code's string, number or boolean member of an object Kotlin holds untyped: the nullable it is, undefined where missing. */
	untypedMemberRead(this: Translator, x: ts.Expression): string | null {
		if (!(this.lenient || this.lenientApp) || this.library || !ts.isPropertyAccessExpression(x) || ts.isOptionalChain(x) || isWriteTarget(x) || !this.isAny(x.expression)) return null;
		const t = this.typeOf(x);
		return ['String', 'Double', 'Boolean'].includes(t) ? this.fromAny(`${RT.jsGet}(${this.expr(x.expression)}, ${kotlinString(x.name.text)})`, optionalType(t)) : null;
	},

	/** A non-strict app's read of an object type's optional member (`o.a`, `a?: string`), which Kotlin holds optional. */
	optionalMember(this: Translator, x: ts.PropertyAccessExpression): boolean {
		if (!this.lenientApp || this.library || x.questionDotToken || x.flags & ts.NodeFlags.OptionalChain || this.typeOf(x).endsWith('?')) return false;
		const d = this.resolve(x.name)?.valueDeclaration;
		return !!d && ts.isPropertySignature(d) && !!d.questionToken && !d.getSourceFile().isDeclarationFile;
	},

	/**
	 * A receiver Kotlin holds nullable, where JavaScript reads `key` of it: the value, or V8's TypeError when it is
	 * missing. An assertion the code carries (`x!!`) is taken over.
	 */
	present(this: Translator, code: string, key: string | ts.Expression, target?: ts.Expression, write = false): string {
		const value = this.unasserted(code);
		const missing = write ? RT.jsCannotSet : target && onlyNull(this.checker.getTypeAtLocation(target)) ? RT.jsCannotReadNull : RT.jsCannotRead;
		// A key read through the receiver itself (`a[a.length - 1]`) is named as written: past the `?:`, Kotlin knows the receiver null.
		const keyCode = typeof key === 'string' ? kotlinString(key) : this.keyText(key);
		const named = typeof key !== 'string' && keyCode.includes(value) ? kotlinString(key.getText()) : keyCode;
		const field = target && ts.skipOuterExpressions(target, ts.OuterExpressionKinds.Parentheses);
		if (!write && field && nullishField(this, field) && value.endsWith('.optional')) return `${value.slice(0, -'.optional'.length)}.present(${named})`;
		return `(${value} ?: ${missing}(${named}))`;
	},

	elementAccess(this: Translator, e: ts.ElementAccessExpression): string {
		this.refuseProto(e);
		this.refuseIntlMember(e);
		const key = e.argumentExpression;
		// `Enum[name]`, `Enum[value]`: the object JavaScript makes of the enum, by key.
		const enumDecl = ts.isIdentifier(e.expression) ? this.resolve(e.expression)?.valueDeclaration : undefined;
		if (((enumDecl && ts.isEnumDeclaration(enumDecl) && !enumDecl.getSourceFile().isDeclarationFile) || isEnumObject(this.placement, e.expression)) && !ts.isStringLiteral(key) && !isWriteTarget(e)) {
			const rt = this.typeOf(e);
			const code = `${this.expr(e.expression)}.jsEnumObject.jsGet(${this.propertyKey(key)})`;
			return isUntyped(spelledType(rt)) ? code : this.fromAny(code, rt);
		}
		// Library mode: an untyped variable narrowed by `key in owner` to a shape, read by key as it is.
		const raw = this.library && ts.isIdentifier(e.expression) && isUntyped(spelledType(this.declaredTypeOf(e.expression))) && this.isObjectRef(e.expression) && !this.typeOf(e.expression).startsWith('JS');
		const read = raw ? ident((e.expression as ts.Identifier).text) : this.expr(e.expression);
		const target = this.isAsserted(read) ? this.present(read, key, e.expression, isWriteTarget(e)) : read;
		const t = raw ? 'Any?' : this.typeOf(e.expression).replace(/\?$/, '');
		const q = e.questionDotToken ? '?' : '';
		if (raw) {
			const code = `${RT.jsGet}(${target}, ${this.propertyKey(key)})`;
			const rt = this.typeOf(e);
			if (!isWriteTarget(e)) return isUntyped(spelledType(rt)) ? code : this.fromAnyCode(code, rt, true);
		}
		if (t === 'String' && !isWriteTarget(e) && !ts.isStringLiteral(key)) {
			// A string Kotlin holds nullable (a pattern's unset group) though its type says not: JavaScript's TypeError where it is missing.
			const present = this.typeOf(e.expression) === 'String?' && !q && !(e.flags & ts.NodeFlags.OptionalChain) && ts.isIdentifier(e.expression) && this.unset.element(e.expression);
			const checked = !present && !q ? this.receiver(e.expression, ts.isNumericLiteral(key) || ts.isStringLiteral(key) ? key.text : key.getText()) : null;
			return this.undefinedAs(`${RT.jsCharAtOrUndefined}(${present ? this.present(target, key, e.expression) : (checked ?? target)}, ${this.toNumber(key)})`, this.typeOf(e));
		}
		if (t === 'String') return `${RT.jsCharAt}(${target}, ${this.toNumber(key)})`;
		// A typed array's element by index: a number, read and written in place.
		if (/^JS(Int8|Uint8|Uint8Clamped|Int16|Uint16|Int32|Uint32|Float32|Float64)Array$/.test(t) && !ts.isStringLiteral(key)) return `${this.elementReceiver(e, read, target)}${q}[${this.toNumber(key)}]`;
		if (isKit(spelledType(t), 'JSArray')) {
			if (isWriteTarget(e)) return `${this.elementReceiver(e, read, target)}${q}[${this.toNumber(key)}]`;
			// An untyped element the checker narrows (`Array.isArray(xs[0])`): read as the narrowed type.
			const rt = this.typeOf(e);
			if (t === 'JSArray<Any?>' && !isUntyped(spelledType(rt))) return this.fromAny(this.maybeUndefined(e)!, rt);
			return this.undefinedAs(this.maybeUndefined(e)!, rt);
		}
		if (t === 'JSMatch') {
			const read = `${uncheckedMatch(e.expression, this.checker) ? `(${target} ?: ${RT.jsCannotReadNull}(${this.keyText(key)}))` : target}${q}.get(${this.toNumber(key)})`;
			return this.typeOf(e).endsWith('?') ? read : this.undefinedAs(read, this.typeOf(e));
		}
		if ((t.startsWith('Pair<') || t.startsWith('Triple<')) && ts.isNumericLiteral(key)) return `${target}.${['first', 'second', 'third'][Number(key.text)]}`;
		if (isKit(spelledType(t), 'JSRecord')) {
			if (isWriteTarget(e)) return `${target}[${this.str(key)}]`;
			const vt = this.typeOf(e);
			const z = this.zero(vt);
			const optional = q || (e.flags & ts.NodeFlags.OptionalChain && this.typeOf(e.expression).endsWith('?'));
			const read = optional ? `${target}?.get(${this.str(key)})` : `${target}[${this.str(key)}]`;
			// Library mode: an untyped value narrowed where it is read (`Array.isArray(headers[key])`).
			if (this.library && /^JSRecord<Any\?>\??$/.test(t) && !isUntyped(spelledType(vt))) return this.fromAnyCode(read, vt, true);
			if (!this.library && !this.lenient && ['String', 'Double', 'Boolean'].includes(vt) && !optional && convertedRead(e)) return this.undefinedAs(read, vt);
			return vt.endsWith('?') || optional ? read : z && z !== 'null' ? `(${read} ?: ${z})` : this.asserted(read);
		}
		if (this.isAny(e.expression)) {
			const code = `${RT.jsGet}(${target}, ${this.propertyKey(key)})`;
			const rt = this.typeOf(e);
			return isUntyped(spelledType(rt)) || isWriteTarget(e) ? code : this.fromAny(code, isCompared(e) ? optionalType(rt) : rt);
		}
		// A key the type does not declare (`activity['_callbacks']` on a Java object, `button['testAttr']`), the object's by name.
		if (ts.isStringLiteral(key) && !this.checker.getNonNullableType(this.checker.getTypeAtLocation(e.expression)).getProperty(key.text)) {
			const code = `${RT.jsGet}(${target}, ${kotlinString(key.text)})`;
			const rt = this.typeOf(e);
			return isUntyped(spelledType(rt)) || isWriteTarget(e) ? code : this.fromAnyCode(code, rt, true);
		}
		if (ts.isStringLiteral(key) && definedField(this.states, () => this.shapeFacts(), e.expression, key.text)) {
			if (isWriteTarget(e)) throw this.error(e, `a write of a field Object.defineProperty may restrict by an element access (write \`.${key.text}\`)`);
			if (!q) return this.fromAnyCode(`${RT.jsGet}(${target}, ${kotlinString(key.text)})`, this.typeOf(e), true);
		}
		if (ts.isStringLiteral(key)) return `${target}${q}.${ident(key.text)}`;
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
		// A computed key on an object (`this[side + 'Drawer']`): its members by name.
		if (this.isObjectRef(e.expression)) {
			// Library mode: the object as it is, whatever shape its type gives it (a generic `owner: T`).
			const code = `${RT.jsGet}(${this.library && !isWriteTarget(e) ? this.coerce(e.expression, 'Any?') : target}, ${this.propertyKey(key)})`;
			const rt = this.typeOf(e);
			return isUntyped(spelledType(rt)) || isWriteTarget(e) ? code : this.fromAnyCode(code, rt, true);
		}
		if (this.typeOf(e.expression) === 'Nothing') {
			const code = `${RT.jsGet}(${this.coerce(e.expression, 'Any?')}, ${this.propertyKey(key)})`;
			const rt = this.typeOf(e);
			return isUntyped(spelledType(rt)) || isWriteTarget(e) ? code : this.fromAnyCode(code, rt, true);
		}
		throw this.error(e, 'indexing this type', 'index-type');
	},

	/** `assertedUntyped`'s cast: to an object type other than the kit's own containers, promises, dates and errors. */
	untypedCastChecks(this: Translator, _e: ts.Expression, t: NativeType): boolean {
		const type = spell(t);
		return this.isObjectType(type) && !/^JS(Array|Record|Promise|Date|Error)\b/.test(type);
	},

	/** An `assertedUntyped` assertion read as the nullable it may be: null where the value is undefined or null. */
	/** `x as Iterable<T>` of a value not held as one: whatever x holds iterated, as GetIterator does where it is iterated. */
	iterableCast(this: Translator, e: ts.AsExpression | ts.TypeAssertion | ts.SatisfiesExpression): string | null {
		const to = iterableAssertion(this.typeOf(e.expression), this.typeOf(e));
		if (!to) return null;
		return to.mayFail ? `${RT.jsIterable}<${to.element}>(${this.coerce(e.expression, 'Any?')}, ${kotlinString(notIterable(e))})` : `${RT.jsIterable}(${this.expr(e.expression)})`;
	},

	assertedOptional(this: Translator, e: ts.AsExpression | ts.TypeAssertion): string {
		const cast = this.iterableCast(e);
		if (cast) return cast;
		const t = this.typeOf(e),
			code = this.expr(e.expression);
		const entry = !this.library && !this.lenient ? this.states.foreignEntry(e) : null;
		const checked = entry && this.type(entry.type, e) === t ? this.checkedConvert(code, entry, e, true) : null;
		if (checked) return checked;
		if (['String', 'Double', 'Boolean'].includes(t)) return `${assertedReader(t, true)}(${code})`;
		return this.fromAny(code, optionalType(this.widenedAssertion(e) ?? t));
	},

	/**
	 * The class above the asserted one that the variable `e` initializes is held as (`view.android as
	 * android.widget.ScrollView` kept as a View, a NestedScrollView at run time): what the value is checked as, since
	 * script never checks the assertion.
	 */
	widenedAssertion(this: Translator, e: ts.AsExpression | ts.TypeAssertion | ts.SatisfiesExpression): string | null {
		if (this.library) return null;
		const holder = ts.findAncestor(e.parent, (p) => !ts.isParenthesizedExpression(p));
		return holder && ts.isVariableDeclaration(holder) ? this.widerAsserted(holder) : null;
	},

	/** `x` read by an equality or `typeof` (`ObserverSlot`). */
	observe(this: Translator, x: ts.Expression, read: 'untyped' | 'asIs' = 'untyped'): string {
		return place(this.placement, x, observerSlot(this.placement, read));
	},

	/**
	 * A read `observedAsIs` (an identity operand, `instanceof`'s left): the nullable it may be, never asserted present.
	 * Library mode reads an untyped value as it is held: `maybeUndefined` would cast it to the declared type.
	 */
	observed(this: Translator, e: ts.Expression): string {
		return (this.library ? null : this.maybeUndefined(e)) ?? this.unasserted(this.expr(e));
	},

	/** An indexed receiver Kotlin holds nullable, where JavaScript reads or writes its element: JavaScript's TypeError when it is missing. */
	elementReceiver(this: Translator, e: ts.ElementAccessExpression, read: string, target: string): string {
		if (e.questionDotToken || e.flags & ts.NodeFlags.OptionalChain || this.isAsserted(read) || isSelf(e.expression, this.subst)) return target;
		const held = this.lenientApp && !this.library && ts.isIdentifier(e.expression) && read === ident(e.expression.text) && this.states.heldOptional(e.expression);
		// A compound assignment or update reads the element first.
		const set = ts.isBinaryExpression(e.parent) && e.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && e.parent.left === e;
		return this.typeOf(e.expression).endsWith('?') || held ? this.present(read, e.argumentExpression, e.expression, set) : target;
	},
};
