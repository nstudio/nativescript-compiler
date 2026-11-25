import ts from 'typescript';
import { isCoreDeclaration } from './core-facts.ts';

/**
 * Plugin idioms that patch @nativescript/core at run time, recognized so a
 * closed-world build can give them as explicit kit hooks:
 *
 * - a mixin function (`applyMixins(Target, [Mixin…])` whose body copies
 *   `Object.getOwnPropertyNames(base.prototype)` onto `derived.prototype`,
 *   wrapping methods the target has: the mixin's runs first): the mixin's
 *   methods join the core class (a Swift extension), its `initNativeView`/
 *   `disposeNativeView` become lifecycle hooks, its `[prop.setNative]`
 *   methods native setters of that class;
 * - `require('@nativescript/core/…').Name`: core's class of that name;
 * - `Core.prototype.method = function () { … }`: a replacement of a core
 *   class's method, which the kit takes as a hook where it has one.
 */
export interface Patterns {
	/** A mixin class → the core class it is mixed into. */
	mixinTarget(cls: ts.ClassDeclaration): string | null;
	/** Whether a call is a recognized mixin application. */
	isMixinCall(call: ts.CallExpression): ts.ClassDeclaration[] | null;
	/**
	 * The mixins of a core class defining a method of this name, when more than one does: each `applyMixins` wraps the
	 * method the target has so far (its own runs first, then the earlier one's result is returned), so the order the
	 * mixins are installed in at run time decides what runs.
	 */
	mixinComposed(cls: ts.ClassDeclaration, method: string): ts.ClassDeclaration[] | null;
	/** A mixin's method the core class it is mixed into already has (core's own, which `applyMixins` wraps). */
	mixinWrapsCore(cls: ts.ClassDeclaration, method: string): boolean;
	/** The core class a `require(…).Name` declaration names. */
	requiredCore(decl: ts.Node | undefined): string | null;
	/** `Core.prototype.method = function () { … }`: the core class, the method and the function. */
	prototypeMethod(e: ts.Expression): { target: string; method: string; fn: ts.FunctionExpression } | null;
}

export function recognizePatterns(checker: ts.TypeChecker, files: readonly ts.SourceFile[]): Patterns {
	const resolve = (n: ts.Node) => {
		const s = checker.getSymbolAtLocation(n);
		return s && s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
	};
	const isMixinFunction = (decl: ts.Declaration | undefined) => !!decl && ts.isFunctionDeclaration(decl) && !!decl.body && /Object\.getOwnPropertyNames\(\s*\w+\.prototype\s*\)/.test(decl.body.getText()) && /\w+\.prototype\[name\]\s*=/.test(decl.body.getText());
	const requiredCore = (decl: ts.Node | undefined): string | null => {
		if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return null;
		const init = decl.initializer;
		if (!ts.isPropertyAccessExpression(init) || !ts.isCallExpression(init.expression)) return null;
		const call = init.expression;
		if (!ts.isIdentifier(call.expression) || call.expression.text !== 'require' || !ts.isStringLiteralLike(call.arguments[0] ?? ts.factory.createIdentifier(''))) return null;
		return (call.arguments[0] as ts.StringLiteral).text.startsWith('@nativescript/core') ? init.name.text : null;
	};
	const targetName = (e: ts.Expression): string | null => {
		const sym = resolve(e);
		const decl = sym?.valueDeclaration;
		if (decl && ts.isClassDeclaration(decl) && isCoreDeclaration(decl)) return decl.name!.text;
		return requiredCore(decl);
	};
	const mixins = new Map<ts.ClassDeclaration, string>();
	const calls = new Map<ts.CallExpression, ts.ClassDeclaration[]>();
	const byTarget = new Map<string, Map<string, ts.ClassDeclaration[]>>();
	const coreMembers = new Map<ts.ClassDeclaration, Set<string>>();
	for (const sf of files) {
		const visit = (n: ts.Node) => {
			if (ts.isCallExpression(n) && isMixinFunction(resolve(n.expression)?.valueDeclaration) && n.arguments.length >= 2) {
				const target = targetName(n.arguments[0]);
				const list = n.arguments[1];
				if (target && ts.isArrayLiteralExpression(list)) {
					const classes = list.elements.map((x) => resolve(x)?.valueDeclaration).filter((d): d is ts.ClassDeclaration => !!d && ts.isClassDeclaration(d));
					if (classes.length === list.elements.length && n.arguments.length === 2) {
						for (const c of classes) mixins.set(c, target);
						calls.set(n, classes);
						const byName = byTarget.get(target) ?? byTarget.set(target, new Map()).get(target)!;
						const targetType = checker.getTypeAtLocation(n.arguments[0]).getProperty('prototype');
						const instance = targetType && checker.getTypeOfSymbolAtLocation(targetType, n.arguments[0]);
						for (const c of classes) {
							for (const name of composableMethods(c)) {
								if (!byName.get(name)?.includes(c)) byName.set(name, [...(byName.get(name) ?? []), c]);
								if (instance?.getProperty(name)?.declarations?.some(isCoreDeclaration)) coreMembers.set(c, (coreMembers.get(c) ?? new Set()).add(name));
							}
						}
					}
				}
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
	}
	const prototypeMethod = (e: ts.Expression) => {
		if (!ts.isBinaryExpression(e) || e.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isFunctionExpression(e.right)) return null;
		const left = e.left;
		if (!ts.isPropertyAccessExpression(left) || !ts.isPropertyAccessExpression(left.expression) || left.expression.name.text !== 'prototype') return null;
		const target = targetName(left.expression.expression);
		return target ? { target, method: left.name.text, fn: e.right } : null;
	};
	return {
		mixinTarget: (cls) => mixins.get(cls) ?? null,
		isMixinCall: (call) => calls.get(call) ?? null,
		mixinComposed: (cls, method) => {
			const defining = byTarget.get(mixins.get(cls) ?? '')?.get(method);
			return defining && defining.length > 1 && defining.includes(cls) ? defining : null;
		},
		mixinWrapsCore: (cls, method) => !!coreMembers.get(cls)?.has(method),
		requiredCore,
		prototypeMethod,
	};
}

/** A mixin's named instance methods (not its native setters). */
function composableMethods(cls: ts.ClassDeclaration): string[] {
	return cls.members.flatMap((m) => (ts.isMethodDeclaration(m) && m.body && !ts.isComputedPropertyName(m.name) && !(ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Static) ? [m.name.getText()] : []));
}

/**
 * Whether a property decorator is a native-property one (gesturehandler's `@nativeProperty`): its body names a
 * function of its file defining, with `Object.defineProperty`, a getter reading `this.native[nativeGetterName]()` and a
 * setter writing `this.options[key]`. The translators give such a field as an accessor through the native object.
 */
export function isNativePropertyDecorator(fn: ts.FunctionDeclaration): boolean {
	const file = fn.getSourceFile();
	const generator = file.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && !!s.body && /Object\.defineProperty\(\s*target\s*,\s*key\s*,\s*\{\s*get:\s*\w+\(key, options\),\s*set:\s*\w+\(key, options\)/.test(s.body.getText()));
	if (!generator || !fn.body) return false;
	const getter = /get:\s*(\w+)\(/.exec(generator.body!.getText())?.[1];
	const setter = /set:\s*(\w+)\(/.exec(generator.body!.getText())?.[1];
	const bodyOf = (name?: string) => file.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name)?.body?.getText() ?? '';
	return /this\.native\[nativeGetterName\]\(\)/.test(bodyOf(getter)) && /this\.options\[key\] = newVal/.test(bodyOf(setter)) && fn.body.getText().includes(generator.name!.text);
}
