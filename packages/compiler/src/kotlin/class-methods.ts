// A class declaration's methods as Kotlin: native setters and setProperty, symbol-named and abstract methods, methods and their entries by name.
import ts from 'typescript';
import { OBJECT_TO_STRING, ident, kotlinString, substituteTypes, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import type { ClassParts } from './class-declaration.ts';
import { hasModifier, nonVirtualName } from '../semantics/ast.ts';
import { isStatic } from '../semantics/throws.ts';
import { kitMember } from '../kit/kit-index.ts';
import { runtimeKitIndex } from './core-index.ts';
import { inheritsToString, toStringGivesNonString, uncheckedIteratorResult } from '../semantics/classes.ts';
import { isUntyped, spelledType } from '../semantics/types.ts';
import { isDirectSymbolMethod } from '../semantics/lang.ts';

export const classMethodsMethods = {
	/**
	 * `[fooProperty.setNative](value)`: the class's native setter for that registered property. The generated kit
	 * reaches any property's setter by its symbol, core's (`isUserInteractionEnabledProperty`) included.
	 */
	nativeSetterProperty(this: Translator, x: ts.Expression): string | null {
		return this.library ? null : (this.setNativeOf(x) ?? (this.generatedKit && ts.isPropertyAccessExpression(x) && x.name.text === 'setNative' ? x.expression.getText().replace(/\W+/g, '_') : null));
	},

	computedMethodsCode(this: Translator, k: ClassParts): void {
		const { cls, isView, open, lines } = k;
		const setters: { property: string; method: string; param: string; key: ts.Expression }[] = [];
		for (const m of cls.members) {
			if (!ts.isMethodDeclaration(m) || !m.body || !ts.isComputedPropertyName(m.name)) continue;
			const property = this.nativeSetterProperty(m.name.expression);
			if (!property) {
				if (!this.symbolMember(m.name)) throw this.error(m.name, 'a computed method name');
				continue;
			}
			const method = `__setNative_${property}`;
			setters.push({ property, method, param: m.parameters[0] ? this.typeOf(m.parameters[0].name) : 'Unit', key: m.name.expression });
			lines.push('    ' + this.func(m, method, open ? 'open ' : ''));
		}
		// The generated kit applies a property as core does: through the method its `setNative` symbol names (`jsGet`, below).
		if (setters.length && !this.generatedKit) {
			if (!isView) throw this.error(cls, 'native setters on a class that is not a view');
			lines.push('    override fun setProperty(name: String, value: Any?) {', '        when (name) {');
			for (const st of setters) {
				const call = st.param === 'Unit' ? `${st.method}()` : `${st.method}(${this.fromAnyCode('value', st.param, true)})`;
				// What a native setter throws is reported, as core reports an error applying a property.
				lines.push(`            ${kotlinString(st.property)} -> ${RT.jsReport} { ${call} }`);
			}
			lines.push('            else -> super.setProperty(name, value)', '        }', '    }');
		}
		if (this.generatedKit) {
			for (const st of setters) k.dynMethods.push({ name: st.method, key: `(${this.expr(st.key)} as JSSymbol).key`, params: st.param === 'Unit' ? [] : [st.param], ret: 'Unit' });
		}
	},

	methodMembersCode(this: Translator, k: ClassParts): void {
		for (const m of k.cls.members) if (ts.isMethodDeclaration(m)) this.methodMemberCode(k, m);
	},

	methodMemberCode(this: Translator, k: ClassParts, m: ts.MethodDeclaration): void {
		const { cls, plugin, kitRoot, memberOpen, overridden, lines } = k;
		const { inherited } = k.layout;
		const c = this.checker;
		if (m.body && ts.isComputedPropertyName(m.name) && this.nativeSetterProperty(m.name.expression)) return;
		if (!m.body && hasModifier(m, ts.SyntaxKind.AbstractKeyword)) return this.abstractMethodCode(k, m);
		if (!m.body) return;
		const keyed = this.symbolMember(m.name);
		if (this.symbolMethodCode(k, m, keyed)) return;
		if (keyed && isDirectSymbolMethod(keyed.member)) {
			if (isStatic(m)) {
				this.indent = '        ';
				k.statics.push('        ' + this.func(m, keyed.member));
				this.indent = '    ';
			} else lines.push('    ' + this.func(m, keyed.member, memberOpen));
			return;
		}
		if (keyed) throw this.error(m.name, 'a method named by this symbol');
		const n = m.name.getText();
		if (plugin && !this.library && !inherited.has(n) && !(kitRoot && this.core?.kitMember(kitRoot, n)) && !this.facts.isNamed(n)) return;
		if (isStatic(m)) {
			this.indent = '        ';
			k.statics.push('        ' + this.func(m, ident(n)));
			this.indent = '    ';
			return;
		}
		if (n === 'toString' && !m.parameters.length) {
			const object = toStringGivesNonString(m, c);
			lines.push('    ' + this.func(m, object ? OBJECT_TO_STRING : 'toString', !object || inheritsToString(cls, c) ? 'override ' : memberOpen));
			return;
		}
		const kit = kitRoot && !inherited.has(n) ? (this.core ? this.core.kitMember(kitRoot, n) : kitMember(runtimeKitIndex(this.config.adapter.kit), kitRoot, n)) : null;
		if (kit && kit.kind === 'func' && !kit.static) {
			lines.push(this.kitOverride(m, kit));
			return;
		}
		if (this.nonVirtualEntry(m)) lines.push('    ' + this.func(m, ident(nonVirtualName(n, cls.name?.text ?? k.name))));
		// An override whose parameters TypeScript types more narrowly than the method it overrides: the base's Kotlin signature.
		// The signature Kotlin has is the topmost declaration's: each override in between takes it too.
		let base = inherited.has(n) ? this.inheritedMethod(cls, n) : undefined;
		for (let up = base && this.inheritedMethod(base.parent as ts.ClassLikeDeclaration, n); up; up = this.inheritedMethod(up.parent as ts.ClassLikeDeclaration, n)) base = up;
		// Library mode: an override taking more parameters than the method it overrides (`accessibilityScreenChanged(refocus)`) is an
		// overload of its own, which the overridden signature calls and subclasses taking as many override in turn.
		if (this.library && base && m.parameters.length > base.parameters.length && !m.parameters.some((p) => p.dotDotDotToken) && !this.readsArguments(m)) {
			let wider: ts.MethodDeclaration | undefined;
			for (let up = this.inheritedMethod(cls, n); up && up !== base && !wider; up = this.inheritedMethod(up.parent as ts.ClassLikeDeclaration, n)) if (up.parameters.length === m.parameters.length) wider = up;
			if (wider && !wider.parameters.some((p, k) => this.paramType(p) !== this.paramType(m.parameters[k])) && this.returnTypeOf(wider) === this.returnTypeOf(m)) this.takeBaseNames(m, this.paramNames(wider));
			if (wider) lines.push(wider.parameters.some((p, k) => this.paramType(p) !== this.paramType(m.parameters[k])) || this.returnTypeOf(wider) !== this.returnTypeOf(m) ? this.appOverride(m, wider) : '    ' + this.func(m, this.methodIdent(n), 'override '));
			else lines.push(this.overloadBridge(m, base), '    ' + this.func(m, this.methodIdent(n), 'open '));
			return;
		}
		const args = base ? this.baseTypeArgs(cls, base.parent as ts.ClassLikeDeclaration) : new Map<string, string>();
		if (base && (base.parameters.length !== m.parameters.length || base.parameters.some((p, k) => substituteTypes(this.paramType(p), args) !== this.paramType(m.parameters[k])) || substituteTypes(this.returnTypeOf(base), args) !== this.returnTypeOf(m))) {
			lines.push(this.appOverride(m, base));
			return;
		}
		// `equals(value)`: Kotlin's own `equals`, which it overrides.
		const kotlinEquals = this.library && n === 'equals' && m.parameters.length === 1 && isUntyped(spelledType(this.paramType(m.parameters[0]))) && this.returnTypeOf(m) === 'Boolean';
		if (kotlinEquals) this.takeBaseNames(m, ['other']);
		else if (base) this.takeBaseNames(m, this.paramNames(base));
		// A template's own bindings and handlers (`$b0`, `$e1`) are read only by the module's generated views.
		const own = !overridden.has(n) && /^\$[be]\d+$/.test(n) ? 'internal ' : '';
		lines.push('    ' + this.func(m, this.methodIdent(n), (this.erasedSignatureMethods.has(m) ? `@JvmName("${n}__typed") ` : '') + own + (kotlinEquals ? 'override ' : this.memberMods(k, n))));
		// A plugin's objects are read untyped too (`handler.attachToView(view)` on an `any`): their methods by name.
		if (plugin && !m.parameters.some((p) => p.dotDotDotToken)) k.dynMethods.push({ name: n, params: m.parameters.map((p) => this.paramType(p)), ret: this.returnTypeOf(m) });
	},

	abstractMethodCode(this: Translator, k: ClassParts, m: ts.MethodDeclaration): void {
		const ret = this.returnTypeOf(m);
		k.lines.push(`    ${k.overridden.has(m.name.getText()) ? 'override ' : ''}abstract fun ${ident(m.name.getText())}(${this.params(m, false)})${ret === 'Unit' ? '' : `: ${ret}`}`);
	},

	/** A method named by a symbol (`[Symbol.iterator]()`): false where the method is not one. */
	symbolMethodCode(this: Translator, k: ClassParts, m: ts.MethodDeclaration, keyed: { member: string; key: string | null; fixed: boolean; either: boolean } | null): boolean {
		const { cls, supertypes, lines } = k;
		const { inherited } = k.layout;
		if (keyed?.member === 'jsToPrimitive') {
			const ret = this.returnTypeOf(m);
			lines.push('    ' + this.func(m, '__symbol_toPrimitive'));
			const call = `__symbol_toPrimitive(${m.parameters.length ? 'hint' : ''})`;
			lines.push(`    override fun jsToPrimitive(hint: String): Any? = ${ret === 'Unit' ? `run { ${call}; null }` : call}`);
			supertypes.push('JSToPrimitive');
			return true;
		}
		if (keyed?.member === 'jsSymbolIterator' || keyed?.member === 'jsSymbolAsyncIterator') {
			lines.push('    ' + this.func(m, keyed.member));
			const async = keyed.member === 'jsSymbolAsyncIterator';
			supertypes.push(async ? 'JSAsyncIterableValue' : 'JSIterableValue');
			const made = async ? 'jsSymbolAsyncIterator()' : 'jsSymbolIterator()';
			const ret = this.returnTypeOf(m);
			const rawExpr = ret === 'Unit' ? `run { ${made}; null }` : made;
			const iterator = !async && uncheckedIteratorResult(m, this.checker) ? `${RT.jsIteratorResult}(${rawExpr})` : this.library ? `(${made} ?: ${RT.jsNoIterator}())` : made;
			lines.push(async ? `    override fun jsAnyAsyncIterator(): JSAsyncIteratorProtocol = ${iterator}` : `    override fun jsAnyIterator(): JSIteratorProtocol = ${iterator}`);
			if (!async) lines.push(`    override fun jsRawIterator(): Any? = ${rawExpr}`);
			return true;
		}
		if (keyed?.key) {
			// An override of a symbol-named method takes the topmost declaration's Kotlin signature.
			let root = this.library && inherited.has(m.name.getText()) ? this.inheritedMethod(cls, m.name.getText()) : undefined;
			for (let up = root && this.inheritedMethod(root.parent as ts.ClassLikeDeclaration, m.name.getText()); up; up = this.inheritedMethod(up.parent as ts.ClassLikeDeclaration, m.name.getText())) root = up;
			if (root && (root.parameters.length !== m.parameters.length || root.parameters.some((p, k) => this.paramType(p) !== this.paramType(m.parameters[k])) || this.returnTypeOf(root) !== this.returnTypeOf(m))) lines.push(this.appOverride(m, root, keyed.member));
			else {
				if (root) this.takeBaseNames(m, this.paramNames(root));
				lines.push('    ' + this.func(m, keyed.member, this.library ? this.memberMods(k, m.name.getText()) : ''));
			}
			// Called by its symbol with the Kotlin signature it has: the overridden one's.
			const sig = root && root !== m ? root : m;
			if (!isStatic(m) && !sig.parameters.some((p) => p.dotDotDotToken) && !sig.typeParameters?.length && !this.readsArguments(sig)) {
				const key = keyed.fixed ? keyed.key : this.capturedSymbolKey(k, keyed.key);
				k.dynMethods.push({ name: keyed.member, key, fixed: keyed.fixed, either: keyed.either, maybeUndefined: keyed.key.includes('?: "undefined"'), params: sig.parameters.map((p) => this.paramType(p)), unread: m.parameters.map((p) => this.unreadParameter(m, p)), ret: this.returnTypeOf(sig) });
			}
			return true;
		}
		return false;
	},

	methodsByNameCode(this: Translator, k: ClassParts): void {
		const { cls, plugin, kitRoot, byName, dynMethods } = k;
		const { inherited } = k.layout;
		// Library mode: every method of the class is read by name as well (`font.getAndroidTypeface()` on an untyped font), overrides included.
		if (this.library || byName || this.membersByName(cls) || this.states.downcastClass(cls) || this.states.byNameClass(cls)) {
			for (const m of cls.members) {
				if (!ts.isMethodDeclaration(m) || !m.body || isStatic(m) || ts.isComputedPropertyName(m.name) || ts.isPrivateIdentifier(m.name) || m.parameters.some((p) => p.dotDotDotToken) || this.readsArguments(m)) continue;
				const n = m.name.getText();
				if (dynMethods.some((d) => d.name === n && !d.key) || n === 'toString' || n === 'equals') continue;
				if (!this.memberByName(cls, n) && !this.states.byNameMember(cls, n)) continue;
				// A plugin's method nothing names is not compiled; one overriding the kit's is read through the kit's own table.
				if (plugin && !this.library && !inherited.has(n) && !(kitRoot && this.core?.kitMember(kitRoot, n)) && !this.facts.isNamed(n)) continue;
				if (!this.library && kitRoot && this.core?.kitMember(kitRoot, n)) continue;
				let root: ts.MethodDeclaration = m;
				for (let up = this.inheritedMethod(cls, n); up; up = this.inheritedMethod(up.parent as ts.ClassLikeDeclaration, n)) root = up;
				if (root.parameters.length !== m.parameters.length) continue;
				dynMethods.push({ name: n, params: root.parameters.map((p) => this.paramType(p)), ret: this.returnTypeOf(root) });
			}
		}
	},
};
