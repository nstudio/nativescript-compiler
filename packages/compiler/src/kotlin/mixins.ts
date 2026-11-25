// Mixins as Kotlin: mixin declarations and the methods a composed class takes from them.
import ts from 'typescript';
import { ident, kotlinString, optionalType, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { mixinChain } from '../semantics/ast.ts';
import { isAsync } from '../semantics/throws.ts';

export const mixinsMethods = {
	/**
	 * A method several mixins of a core class define: the mixins installed so far, in the order they were, and the
	 * method running the last installed one's first and returning the first one's result, as each `applyMixins` wraps the
	 * method the one before it installed. Before any is installed the target has no such method.
	 */
	composedMixinMethod(this: Translator, target: string, n: string, classes: ts.ClassDeclaration[]): string {
		const fns = classes.map((c) => c.members.find((m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m) && !!m.body && !ts.isComputedPropertyName(m.name) && m.name.getText() === n)!);
		if (fns.some(isAsync)) throw this.error(fns[0], `the async method ${n} several mixins define`);
		const params = fns.map((fn) => this.params(fn, false));
		const types = (p: string) => p.replace(/(^|, )(\w+|`[^`]+`): /g, '$1');
		const rets = fns.map((fn) => this.returnTypeOf(fn));
		const differing = fns.findIndex((_, k) => types(params[k]) !== types(params[0]) || rets[k] !== rets[0]);
		if (differing > 0) throw this.error(fns[differing], `the method ${n} several mixins define with different parameter or return types`);
		const args = [...params[0].matchAll(/(?:^|, )(\w+|`[^`]+`): /g)].map((x) => x[1]).join(', ');
		const ret = rets[0];
		const chain = mixinChain(target, n);
		const when = (k: string) => `when (${k}) { ${fns.map((_, i) => `${i === fns.length - 1 ? 'else' : i} -> this.__${classes[i].name!.text}_${n}(${args})`).join('; ')} }`;
		return [`val ${chain} = mutableListOf<Int>()`, `fun ${target}.${ident(n)}(${params[0]})${ret === 'Unit' ? '' : `: ${ret}`} {`, `    val __chain = ${chain}.toList()`, `    if (__chain.isEmpty()) throw JSException(JSTypeError(${kotlinString(`${n} is not a function`)}))`, `    for (__k in __chain.drop(1).asReversed()) ${when('__k')}`, `    ${ret === 'Unit' ? '' : 'return '}${when('__chain[0]')}`, '}'].join('\n');
	},

	/**
	 * A mixin class (`applyMixins(View, [ViewGestureExtended])`): its methods
	 * extend the core class; its native-view lifecycle methods run as hooks
	 * when a view of that class sets up and disposes its native view; its
	 * native setters are the class's setters for those properties. Its fields
	 * are not copied by the mixin: the methods keep them on the view by name.
	 */
	mixinDecl(this: Translator, cls: ts.ClassDeclaration, target: string): string {
		const name = cls.name!.text;
		const lines: string[] = [];
		const hooks: { init?: string; dispose?: string } = {};
		const setters: string[] = [];
		const members: string[] = [];
		const chains: string[] = [];
		this.indent = '';
		for (const m of cls.members) {
			if (ts.isPropertyDeclaration(m)) {
				const n = m.name.getText();
				const t = optionalType(this.typeOf(m.name));
				const sym = this.checker.getSymbolAtLocation(m.name);
				if (sym && t !== this.typeOf(m.name)) this.nullableDecls.add(sym);
				lines.push(`var ${target}.${ident(n)}: ${t}`, `    get() = ${this.fromAnyCode(`this.jsGet(${kotlinString(n)})`, t)}`, `    set(value) { this.jsSet(${kotlinString(n)}, value) }`);
				continue;
			}
			if (ts.isGetAccessorDeclaration(m)) {
				const t = this.returnTypeOf(m);
				const n = m.name.getText();
				lines.push(`val ${target}.${ident(n)}: ${t}`, `    get() ${this.functionBody(m, t, '    ')}`);
				// Read by name too (`this.findRootView(view)?.registry` on what core types as a view).
				members.push(`    View.mixinMembers[${kotlinString(n)}] = { view -> (view as? ${target})?.${ident(n)} }`);
				continue;
			}
			if (!ts.isMethodDeclaration(m) || !m.body) continue;
			if (ts.isComputedPropertyName(m.name)) {
				const property = this.setNativeOf(m.name.expression);
				if (!property) throw this.error(m.name, 'a computed method name');
				const param = m.parameters[0] ? this.typeOf(m.parameters[0].name) : 'Unit';
				lines.push(this.func(m, `${target}.__setNative_${property}`));
				setters.push(`    View.nativeSetterHooks[${kotlinString(property)}] = { view, value -> (view as? ${target})?.__setNative_${property}(${param === 'Unit' ? '' : this.fromAnyCode('value', param, true)}) }`);
				continue;
			}
			const n = m.name.getText();
			if (n === 'initNativeView' || n === 'disposeNativeView') {
				if (this.patterns.mixinComposed(cls, n)) throw this.error(m.name, `the lifecycle hook ${n} several mixins of ${target} define (applyMixins runs the last installed first)`);
				lines.push(this.func(m, `${target}.__${name}_${n}`));
				hooks[n === 'initNativeView' ? 'init' : 'dispose'] = `{ view -> ${RT.jsReport} { (view as? ${target})?.__${name}_${n}() } }`;
				continue;
			}
			if (this.patterns.mixinWrapsCore(cls, n)) throw this.error(m.name, `a mixin method ${target} already has (applyMixins wraps core's ${n}, which the kit's ${target} runs as its own)`);
			const composed = this.patterns.mixinComposed(cls, n);
			if (composed) {
				lines.push(this.func(m, `${target}.__${name}_${n}`));
				chains.push(`    ${mixinChain(target, n)}.add(${composed.indexOf(cls)})`);
				if (composed[composed.length - 1] !== cls) continue;
				lines.push(this.composedMixinMethod(target, n, composed));
			} else lines.push(this.func(m, `${target}.${ident(n)}`));
			if (!m.parameters.length) {
				const ret = this.returnTypeOf(m);
				members.push(`    View.mixinMembers[${kotlinString(n)}] = { view -> ${RT.jsFunction} { (view as? ${target})?.${ident(n)}()${ret === 'Unit' ? '; null' : ''} } }`);
			}
		}
		lines.push('', `fun __install_${name}() {`);
		if (hooks.init || hooks.dispose) lines.push(`    View.lifecycleHooks.add(View.LifecycleHook(${hooks.init ?? 'null'}, ${hooks.dispose ?? 'null'}))`);
		lines.push(...chains, ...setters, ...members, '}');
		return lines.join('\n');
	},
};
