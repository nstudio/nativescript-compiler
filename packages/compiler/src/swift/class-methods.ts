// A class declaration's methods as Swift: computed and symbol-named methods, native setters, methods and their entries by name.
import ts from 'typescript';
import { ident, isFunctionType, metatype, optionalType, scriptLength, splitTopLevel, swiftString, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import type { ClassParts } from './class-declaration.ts';
import { hasModifier, nonVirtualName } from '../semantics/ast.ts';
import { isStatic } from '../semantics/throws.ts';
import { COLLECTION_OVERRIDE_METHODS, collectionBaseInfo, programBase, uncheckedIteratorResult } from '../semantics/classes.ts';
import { namesMembersBySymbol } from '../semantics/read-sites.ts';
import { fixedKey } from '../semantics/translator-methods.ts';
import { isDisposerMember } from '../semantics/lang.ts';
import type { SymbolMethod } from './translator-types.ts';
type NativeSetter = { property: string; method: string; param: string; throws: boolean };

export const classMethodsMethods = {
	computedMethods(this: Translator, k: ClassParts): void {
		const { cls, name, expando, lines } = k;
		const symbolMethods: SymbolMethod[] = [];
		// `[fooProperty.setNative](value)`: the class's native setter for that registered property.
		const setters: NativeSetter[] = [];
		for (const m of cls.members) this.computedMethod(k, m, symbolMethods, setters);
		if (symbolMethods.length || expando) {
			lines.push(`    ${expando ? '' : 'override '}func jsSymbolMethod(_ key: String) -> JSMethod? {`);
			this.declare('jsSymbolMethod', { kind: 'func', mods: expando ? '' : 'override ', params: '_ key: String', type: 'JSMethod?' });
			for (const sm of symbolMethods) {
				const args = sm.params.map((p, k) => (sm.unread[k] && this.zero(p)) || this.throwingConverts(() => this.presentFromAny(`${RT.jsArg}(__a, ${k})`, p, true, true)));
				const call = this.marks.tryCode(`(${RT.jsCastPresent}(__this) as ${ident(name)}).${sm.method}(${args.join(', ')})`);
				lines.push(`        if key == ${sm.key} { return { __this, __a in ${sm.ret === 'Void' ? `${call}; return nil` : `return ${this.convert(call, sm.ret, 'Any?')}`} } }`);
			}
			lines.push(`        return ${expando ? 'nil' : 'super.jsSymbolMethod(key)'}`, '    }');
		}
		// Each expando class says whether a symbol key may name one of its members; a subclass that may name one says so over it.
		if (expando) {
			lines.push(`    class var jsSymbolPlain: Bool { ${!namesMembersBySymbol(cls)} }`);
			this.declare('jsSymbolPlain', { kind: 'var', mods: 'class ', type: 'Bool' });
			lines.push(`    class var jsSymbolFieldsPlain: Bool { ${!k.symbolFields.length} }`);
			this.declare('jsSymbolFieldsPlain', { kind: 'var', mods: 'class ', type: 'Bool' });
		} else {
			if (namesMembersBySymbol(cls) && this.inheritsSymbolPlain(k)) {
				lines.push('    override class var jsSymbolPlain: Bool { false }');
				this.declare('jsSymbolPlain', { kind: 'var', mods: 'override class ', type: 'Bool' });
			}
			if (k.symbolFields.length && this.inheritsSymbolFieldsPlain(k)) {
				lines.push('    override class var jsSymbolFieldsPlain: Bool { false }');
				this.declare('jsSymbolFieldsPlain', { kind: 'var', mods: 'override class ', type: 'Bool' });
			}
		}
		if (expando) {
			k.conformances.push('JSExpando');
			lines.push('    var jsExpando: JSObject?', ...(k.symbolFields.length ? [] : ['    var jsSymbolKeys: [String] { jsExpando?.jsSymbolKeys ?? [] }']), '    func jsDeleteOwn(_ key: String) -> Bool { jsExpando?.delete(key) ?? true }');
			this.declare('jsExpando', { kind: 'var', type: 'JSObject?' });
			if (!k.symbolFields.length) this.declare('jsSymbolKeys', { kind: 'var', type: '[String]' });
			this.declare('jsDeleteOwn', { kind: 'func', params: '_ key: String', type: 'Bool' });
		}
		if (setters.length) {
			if (!k.isView) throw this.error(cls, 'native setters on a class that is not a view');
			lines.push('    override func setProperty(_ name: String, _ value: Any?) {', '        switch name {');
			this.declare('setProperty', { kind: 'func', mods: 'override ', params: '_ name: String, _ value: Any?', type: 'Void' });
			if (this.declOwner)
				this.declarations?.names(
					this.declOwner,
					setters.map((st) => st.property),
				);
			for (const st of setters) {
				const call = st.param === 'Void' ? `${st.method}()` : `${st.method}(${this.convert('value', 'Any?', st.param)})`;
				// What a native setter throws is reported, as core reports an error applying a property.
				lines.push(`        case ${swiftString(st.property)}: ${st.throws ? `${RT.jsReport} { try ${call} }` : call}`);
			}
			lines.push('        default: super.setProperty(name, value)', '        }', '    }');
		}
	},

	/** Whether a class without its own `JSExpando` conformance extends one that declares `jsSymbolPlain`. */
	inheritsSymbolPlain(this: Translator, k: ClassParts): boolean {
		if (k.kitRoot && !this.library) return !!this.core.kitMember(k.kitRoot, 'jsSymbolPlain');
		let root: ts.ClassLikeDeclaration = k.cls;
		for (let b = programBase(root, this.checker); b; b = programBase(b, this.checker)) root = b;
		if (root === k.cls || root.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword)) return false;
		return !!this.library || this.pluginFiles.has(root.getSourceFile().fileName) || this.givenUndeclared().has(root);
	},

	/** Whether a class without its own `JSExpando` conformance extends one that declares `jsSymbolFieldsPlain`. */
	inheritsSymbolFieldsPlain(this: Translator, k: ClassParts): boolean {
		if (k.kitRoot && !this.library) return !!this.core.kitMember(k.kitRoot, 'jsSymbolFieldsPlain');
		let root: ts.ClassLikeDeclaration = k.cls;
		for (let b = programBase(root, this.checker); b; b = programBase(b, this.checker)) root = b;
		if (root === k.cls || root.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword)) return false;
		return !!this.library || this.pluginFiles.has(root.getSourceFile().fileName) || this.givenUndeclared().has(root);
	},

	computedMethod(this: Translator, k: ClassParts, m: ts.ClassElement, symbolMethods: SymbolMethod[], setters: NativeSetter[]): void {
		if (!ts.isMethodDeclaration(m) || !m.body || !ts.isComputedPropertyName(m.name)) return;
		const { lines } = k;
		const keyed = this.symbolMember(m.name);
		if (keyed?.member === 'jsToPrimitive') {
			const ret = this.returnTypeOf(m);
			const throws = this.throwsInfo.fn(m);
			lines.push('    ' + this.memberFunc(m, '__symbol_toPrimitive'));
			const call = this.marks.tryIf(throws, `__symbol_toPrimitive(${m.parameters.length ? 'hint' : ''})`);
			lines.push(`    func jsToPrimitive(_ hint: String) throws -> Any? { ${ret === 'Void' ? `${call}; return nil` : `return ${this.convert(call, ret, 'Any?')}`} }`);
			this.declare('jsToPrimitive', { kind: 'func', params: '_ hint: String', throws: true, type: 'Any?' });
			k.conformances.push('JSToPrimitive');
			return;
		}
		if (keyed?.member === 'jsSymbolIterator' || keyed?.member === 'jsSymbolAsyncIterator') {
			lines.push('    ' + this.memberFunc(m, keyed.member));
			const async = keyed.member === 'jsSymbolAsyncIterator';
			const ret = this.returnTypeOf(m);
			const rawCall = this.marks.tryIf(this.throwsInfo.fn(m), 'jsSymbolIterator()');
			this.declare(async ? 'jsAnyAsyncIterator' : 'jsAnyIterator', { kind: 'func', params: '', throws: true, type: async ? 'JSAsyncIteratorProtocol' : 'JSIteratorProtocol' });
			k.conformances.push(async ? 'JSAsyncIterableValue' : 'JSIterableValue');
			lines.push(async ? `    func jsAnyAsyncIterator() throws -> JSAsyncIteratorProtocol { ${this.throwsInfo.fn(m) ? 'try ' : ''}jsSymbolAsyncIterator() }` : `    func jsAnyIterator() throws -> JSIteratorProtocol { ${uncheckedIteratorResult(m, this.checker) ? (ret === 'Void' ? `${rawCall}; return try ${RT.jsIteratorResult}(nil)` : `try ${RT.jsIteratorResult}(${rawCall})`) : this.lenient ? `try ${RT.jsIterated}(${this.throwsInfo.fn(m) ? 'try ' : ''}jsSymbolIterator(), "Result of the Symbol.iterator method is not an object")` : rawCall} }`);
			if (!async) {
				this.declare('jsRawIterator', { kind: 'func', params: '', throws: true, type: 'Any?' });
				lines.push(`    func jsRawIterator() throws -> Any? { ${ret === 'Void' ? `${rawCall}; return nil` : `return ${this.convert(rawCall, ret, 'Any?')}`} }`);
			}
			return;
		}
		if (keyed?.key) {
			lines.push('    ' + this.memberFunc(m, keyed.member));
			if (!isStatic(m)) {
				const key = keyed.fixed || !keyed.of ? keyed.key : this.storedSymbolKey(k, keyed.of, keyed.key);
				const entry: SymbolMethod = { key, method: keyed.member, owner: ident(k.name), params: m.parameters.map((p) => this.paramType(p)), unread: m.parameters.map((p) => this.unreadParameter(m, p)), ret: this.returnTypeOf(m), throws: this.throwsInfo.fn(m) };
				if (this.library || k.kitRoot || k.expando || this.inheritsSymbolPlain(k)) symbolMethods.push(entry);
				else if (!m.typeParameters?.length && !m.parameters.some((p) => p.dotDotDotToken) && !this.readsArguments(m)) k.symbolMethods.push(entry);
			}
			return;
		}
		if (keyed && isDisposerMember(keyed.member)) {
			lines.push('    ' + this.memberFunc(m, keyed.member));
			return;
		}
		if (keyed) throw this.error(m.name, 'a method named by this symbol');
		// On a class of a core view (`[isUserInteractionEnabledProperty.setNative]`): core's property system finds it by its symbol.
		if (this.library || k.kitRoot || k.expando || this.inheritsSymbolPlain(k)) {
			// `[prop.setNative](value)`: a method under a symbol known when the program runs, found by its key.
			const named = this.symbolMethodName(k.cls, m);
			let method = named;
			for (let i = 2; symbolMethods.some((x) => x.method === method); i++) method = `${named}_${i}`;
			const saved = this.chainingLoose;
			this.chainingLoose = true;
			const rawKey = this.propertyKey(m.name.expression);
			this.chainingLoose = saved;
			const key = fixedKey(m.name.expression, this.checker) ? rawKey : this.storedSymbolKey(k, m.name.expression, rawKey);
			symbolMethods.push({ key, method, owner: ident(k.name), params: m.parameters.map((p) => this.paramType(p)), unread: m.parameters.map((p) => this.unreadParameter(m, p)), ret: this.returnTypeOf(m), throws: this.throwsInfo.fn(m) });
			lines.push('    ' + this.memberFunc(m, method));
			return;
		}
		const property = this.setNativeOf(m.name.expression);
		if (!property) throw this.error(m.name, 'a computed method name');
		const method = `__setNative_${property}`;
		setters.push({ property, method, param: m.parameters[0] ? this.typeOf(m.parameters[0].name) : 'Void', throws: this.throwsInfo.fn(m) });
		lines.push('    ' + this.memberFunc(m, method));
	},

	methodMembers(this: Translator, k: ClassParts): void {
		for (const m of k.cls.members) this.methodMember(k, m);
	},

	methodMember(this: Translator, k: ClassParts, m: ts.ClassElement): void {
		const { cls, kitRoot, lines } = k;
		const { inherited, inheritedStatics } = k.layout;
		if (ts.isMethodDeclaration(m) && m.body && ts.isComputedPropertyName(m.name)) return;
		// A generic method of the program's is no one function value; core's (`notify<T extends EventData>`) is read by name
		// (`globalEvents.notify.bind(globalEvents)`), its type parameters as the slot's context gives them.
		const generic = !this.library && ts.isMethodDeclaration(m) && !this.erasesGenerics(m) && !!m.typeParameters?.some((p) => !this.erasesTypeParameter(p));
		if (ts.isMethodDeclaration(m) && !m.body && hasModifier(m, ts.SyntaxKind.AbstractKeyword)) return this.abstractMethod(k, m);
		if (!ts.isMethodDeclaration(m) || !m.body) return;
		const n = m.name.getText();
		if (!this.library && this.pluginFiles.has(cls.getSourceFile().fileName) && !inherited.has(n) && !(kitRoot && this.core.kitMember(kitRoot, n)) && !this.facts.isNamed(n) && !k.implicitlyCalled.has(n)) return;
		// Over a kit method, directly or through a program base that overrides it: the kit's signature.
		const kit = kitRoot && !isStatic(m) ? this.core.kitMember(kitRoot, n) : null;
		if (kit && kit.kind === 'func') {
			lines.push(this.kitOverride(m, kit, inherited.has(n)));
			return;
		}
		// Over a runtime collection (`JSMap`/`JSSet`) open method: emit `override`, bridging through `kitOverride` if throwing or signature differs.
		const colInfo = k.collection && !isStatic(m) ? collectionBaseInfo(cls, this.checker) : null;
		const overridesCollection = !!colInfo && COLLECTION_OVERRIDE_METHODS[colInfo.kind].includes(n);
		if (overridesCollection && (this.throwsInfo.fn(m) || (n === 'get' && !this.returnTypeOf(m).endsWith('?') && this.returnTypeOf(m) !== 'Any?'))) {
			const inner = k.collection!.replace(/^JS(?:Map|Set)<(.*)>$/, '$1');
			const [kType, vType] = colInfo.kind === 'Map' ? splitTopLevel(inner) : [inner, ''];
			const colMember =
				n === 'get'
					? { kind: 'func' as const, static: false, params: `_ key: ${kType}`, type: optionalType(vType), throws: false }
					: n === 'set'
						? { kind: 'func' as const, static: false, params: `_ key: ${kType}, _ value: ${vType}`, type: k.collection!, throws: false }
						: n === 'add'
							? { kind: 'func' as const, static: false, params: `_ value: ${kType}`, type: k.collection!, throws: false }
							: n === 'clear'
								? { kind: 'func' as const, static: false, params: '', type: 'Void', throws: false }
								: { kind: 'func' as const, static: false, params: `_ key: ${kType}`, type: 'Bool', throws: false };
			lines.push(this.kitOverride(m, colMember, inherited.has(n)));
			return;
		}
		// An override declaring fewer parameters than the method it overrides takes the rest unused, as Swift matches signatures.
		const overridden = inherited.has(n) && !isStatic(m) ? this.inheritedMethod(cls, n) : undefined;
		if (overridden)
			m.parameters.forEach((p, k) => {
				const b = overridden.parameters[k];
				if (b && (b.questionToken || (b.initializer && !this.constantDefault(b))) && this.constantDefault(p)) this.optionalDefaults.add(p);
			});
		const extra = overridden ? overridden.parameters.slice(m.parameters.length).map((p, k) => `_ __unused${k}: ${p.questionToken || p.initializer ? optionalType(this.typeOf(p.name)) : this.typeOf(p.name)}`) : [];
		// Static methods are class methods, which a subclass's static method of the same name overrides as JavaScript's does.
		// One taking other parameter types is an overload of it instead, as Swift resolves them.
		const overriddenStatic = isStatic(m) ? inheritedStatics.get(n) : undefined;
		const sameParams = (a: ts.MethodDeclaration, b: ts.MethodDeclaration) => {
			const x = this.signatureOf(a).params,
				y = this.signatureOf(b).params;
			return x.length === y.length && x.every((p, k) => p.type === y[k].type);
		};
		const modifiers = isStatic(m) ? (overriddenStatic && sameParams(m, overriddenStatic) ? 'override class ' : 'class ') : inherited.has(n) || overridesCollection ? 'override ' : '';
		lines.push('    ' + this.memberFunc(m, ident(n), modifiers, extra));
		if (!isStatic(m) && !generic && this.nonVirtualEntry(m)) lines.push('    ' + this.memberFunc(m, ident(nonVirtualName(n, cls.name?.text ?? k.name)), 'final '));
		// A plugin's objects are read untyped too (`handler.attachToView(view)` on an `any`): their methods by name.
		const restAt = m.parameters.findIndex((p) => p.dotDotDotToken);
		if ((((this.pluginFiles.has(cls.getSourceFile().fileName) || this.appMembersByName || this.states.downcastClass(cls) || this.states.byNameClass(cls)) && this.states.byNameMember(cls, n)) || this.states.viewedMember(cls, n)) && !isStatic(m) && !ts.isPrivateIdentifier(m.name) && (restAt < 0 || restAt === m.parameters.length - 1) && !extra.length && !generic) {
			// The signature Swift has for the method: an override's is its root's.
			const sig = this.emittedSignature(m);
			const plain = (t: string) => t.replace(/^\((any .*)\)!$/, '$1?').replace(/!$/, '?');
			// A method reading `arguments` takes the call's arguments as one list; a rest parameter (`fill(...args)`) the arguments from its place.
			const params = this.readsArguments(m) ? ['JSRest<Any?>'] : sig.params.map((p, k) => (k === restAt ? `JSRest<${/^JSArray<(.*)>$/.exec(plain(p.type))?.[1] ?? 'Any?'}>` : isFunctionType(p.type) ? `@escaping ${p.type}` : plain(p.type)));
			k.dynMethods.push({ name: n, type: `(${params.join(', ')}) throws -> ${plain(sig.ret)}`, available: this.gatedFunctions.get(m), length: scriptLength(m) });
		}
	},

	abstractMethod(this: Translator, k: ClassParts, m: ts.MethodDeclaration): void {
		// An overloaded abstract method is its first signature, which overrides take (`baseMethod`).
		if (k.cls.members.find((x) => ts.isMethodDeclaration(x) && !x.body && x.name.getText() === m.name.getText()) !== m) return;
		// An abstract method: subclasses override it.
		// Without a declared type (implicitly any) it returns nothing, as overrides declared for effect do: Swift overrides match exactly.
		const ret = this.signatureOf(m).ret;
		// Called without an override, it is a method JavaScript does not have: a TypeError, thrown or (where Swift's signature cannot throw) reported.
		const missing = `JSTypeError("${m.name.getText()} is not a function")`;
		const body = this.throwsInfo.fn(m) ? `throw JSException(${missing})` : `${RT.jsReportUncaught}(${missing})${ret === 'Void' ? '' : `; return ${this.undefinedValue(ret) ?? `${RT.jsNativeZero}(${metatype(ret)})`}`}`;
		k.lines.push(`    func ${ident(m.name.getText())}(${this.params(m, false)})${this.throwsInfo.fn(m) ? ' throws' : ''}${ret === 'Void' ? '' : ` -> ${ret}`} { ${body} }`);
		this.declare(m.name.getText(), { kind: 'func', params: this.params(m, false), throws: this.throwsInfo.fn(m), type: ret });
	},
};
