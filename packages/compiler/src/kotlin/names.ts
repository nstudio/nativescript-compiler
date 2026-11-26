// Names as Kotlin: identifiers, the members in scope and global aliases.
import ts from 'typescript';
import { KIT_NAMES_ANDROID } from './library.ts';
import { ERRORS } from '../semantics/globals.ts';
import { IOS_TYPINGS, ident, isThisParameter, kotlinString, lambda, optionalType, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { accessedDeclaration, canReadArguments, isArguments, objectMethod } from '../semantics/lang.ts';
import { hasModifier, isAppDeclarationFile, isLibDeclaration, isWriteTarget } from '../semantics/ast.ts';
import { isCoreDeclaration } from '../program/core-facts.ts';
import { isStatic } from '../semantics/throws.ts';
import { isUntyped, spelledType } from '../semantics/types.ts';
import { globalOp } from '../semantics/apis/globals.ts';

export const namesMethods = {
	identifier(this: Translator, e: ts.Identifier): string {
		// A built-in constructor as a value: `TypeError` (`e.constructor === TypeError`) its class, as an instance's
		// constructor reads; `Number`, `String`, `Boolean` (`map(Number)`, `filter(Boolean)`) the conversion they call.
		const p0 = e.parent;
		const asValue = !((ts.isCallExpression(p0) || ts.isNewExpression(p0)) && p0.expression === e) && !(ts.isBinaryExpression(p0) && p0.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && p0.right === e) && !(ts.isPropertyAccessExpression(p0) && p0.expression === e) && !ts.isTypeOfExpression(p0);
		const builtinDecl = (ts.isShorthandPropertyAssignment(p0) && p0.name === e ? this.checker.getShorthandAssignmentValueSymbol(p0) : this.resolve(e))?.declarations?.[0];
		if (asValue && (ERRORS[e.text] || ['Number', 'String', 'Boolean'].includes(e.text)) && isLibDeclaration(builtinDecl)) {
			if (ERRORS[e.text]) return `${ERRORS[e.text]}::class.java`;
			// Placed untyped or compared (`const f: any = Number`, `s.constructor === String`): singleton builtin constructor.
			const context = this.checker.getContextualType(e);
			if (!context || !this.checker.getNonNullableType(context).getCallSignatures()[0]) return `js${e.text}Constructor`;
			return `{ value: Any? -> ${e.text === 'Number' ? RT.jsToNumber : e.text === 'String' ? RT.jsToString : RT.jsTruthy}(value) }`;
		}
		// `Promise`, `Date`, `Array`, `Object` as values (`const { isArray } = Array`, a `PromiseConstructorLike` default): the runtime's.
		const builtin = ({ Promise: 'JSPromiseConstructor', Date: 'jsDateBuiltin', Array: 'jsArrayBuiltin', Object: 'jsObjectBuiltin' } as Record<string, string>)[e.text];
		if (asValue && builtin && isLibDeclaration(builtinDecl)) return builtin;
		// A function of the program compared (`cb === fn`), asserted untyped (`fn as any`) or given properties (`fn.tag = …`):
		// a reference to it. Where a value of another type is wanted, coerce adapts it instead.
		const outer = ts.walkUpParenthesizedExpressions(p0);
		const referenced = (ts.isPropertyAccessExpression(p0) && p0.expression === e && this.isExpando(p0)) || ts.isAsExpression(outer) || ts.isTypeAssertionExpression(outer) || (ts.isBinaryExpression(outer) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(outer.operatorToken.kind));
		// Where no function type is wanted (`Object.keys(fn)`, an `object` parameter).
		const objectWanted = (c: ts.Type | undefined) => !!c && !c.getCallSignatures().length && !(c.isUnion() && c.types.some((u) => u.getCallSignatures().length));
		const declared = !this.library && (referenced || (asValue && objectWanted(this.checker.getContextualType(e)))) ? this.resolve(e)?.valueDeclaration : undefined;
		if (declared && ts.isFunctionDeclaration(declared) && declared.body && !declared.typeParameters?.length && !declared.getSourceFile().isDeclarationFile && !this.implicitThis(declared) && !declared.parameters.some(isThisParameter)) return this.functionValue(e);
		// A core variable imported under another name (`Device as __platform_Device`): the kit's top-level one of its own name.
		const alias = this.checker.getSymbolAtLocation(e);
		const imported = alias && alias.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(alias) : undefined;
		if (imported && imported.name !== e.text && imported.flags & ts.SymbolFlags.Variable && isCoreDeclaration(imported.declarations?.[0]) && this.core?.kitMember('', imported.name)?.kind === 'var') return imported.name;
		const moduleVariable = !this.library ? this.core?.coreVariable?.(e) : null;
		if (moduleVariable) return moduleVariable;
		// An enum as a value (`Object.keys(Color)`): the object JavaScript makes of it.
		const enumDecl = this.library ? undefined : this.resolve(e)?.valueDeclaration;
		if (enumDecl && ts.isEnumDeclaration(enumDecl) && !enumDecl.getSourceFile().isDeclarationFile && !hasModifier(enumDecl, ts.SyntaxKind.ConstKeyword) && !((ts.isPropertyAccessExpression(p0) || ts.isElementAccessExpression(p0)) && p0.expression === e && !objectMethod(this, p0)) && !ts.isTypeOfExpression(p0)) return `${this.refName(e)}.jsEnumObject`;
		// A module of the program held as a value (`import * as tests`, handed to a runner): an object of its exports.
		const held = this.resolve(e);
		if (held && held.flags & ts.SymbolFlags.ValueModule && held.valueDeclaration && ts.isSourceFile(held.valueDeclaration) && !held.valueDeclaration.isDeclarationFile && !(ts.isPropertyAccessExpression(e.parent) && e.parent.expression === e)) return this.moduleValue(e, held);
		// A function's literal constant read in a class the function declares: the literal, as a captured local would add a
		// constructor parameter that a class held as a value (`PagerAdapter = FragmentPagerAdapter`, made by `new`) is not given.
		const local = this.resolve(e)?.valueDeclaration;
		if (local && ts.isVariableDeclaration(local) && local.parent.flags & ts.NodeFlags.Const && local.initializer && ts.findAncestor(local, ts.isFunctionLike)) {
			let init: ts.Expression = local.initializer;
			while (ts.isParenthesizedExpression(init)) init = init.expression;
			const literal = ts.isNumericLiteral(init) || ts.isStringLiteral(init) || (ts.isPrefixUnaryExpression(init) && init.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(init.operand));
			const cls = ts.findAncestor(e, ts.isClassLike);
			if (literal && cls && ts.findAncestor(cls, ts.isFunctionLike) === ts.findAncestor(local, ts.isFunctionLike)) return this.expr(init);
		}
		// A parameter held as its base's class (`appOverride`), read for a member only the narrower class declares: cast to it.
		if (this.widenedParams.size && ts.isPropertyAccessExpression(e.parent) && e.parent.expression === e) {
			const d = this.checker.getSymbolAtLocation(e)?.valueDeclaration;
			const w = d && ts.isParameter(d) ? this.widenedParams.get(d) : undefined;
			if (w && !this.checker.getPropertyOfType(w.base, e.parent.name.text)) return `(${ident(e.text)} as ${w.own})`;
		}
		// `parseInt`, `parseFloat` as values: functions taking the parameters their slot gives (`map` passes an index, parseInt's radix).
		if ((e.text === 'parseInt' || e.text === 'parseFloat') && !(ts.isCallExpression(e.parent) && e.parent.expression === e) && this.resolve(e)?.declarations?.every((d) => d.getSourceFile().isDeclarationFile)) {
			const context = this.checker.getContextualType(e);
			const slot = (context && this.checker.getNonNullableType(context).getCallSignatures()[0]) ?? this.checker.getTypeAtLocation(e).getCallSignatures()[0];
			const types = (slot?.getParameters() ?? []).map((p) => {
				const t = this.type(this.checker.getTypeOfSymbolAtLocation(p, e), e);
				return p.valueDeclaration && ts.isParameter(p.valueDeclaration) && p.valueDeclaration.questionToken ? optionalType(t) : t;
			});
			// Placed untyped (`const f: any = parseInt`), it may be given anything, converted to a string as JavaScript converts it.
			const given = !!context && !!this.checker.getNonNullableType(context).getCallSignatures()[0];
			const first = given && types.length ? types[0] : context ? 'Any?' : 'String';
			const params = (types.length ? types : ['String']).map((t, k) => `__p${k}: ${k === 0 ? first : t}`);
			const radix = types.length > 1 ? '__p1' : 'null';
			const text = first === 'String' ? '__p0' : `${RT.jsToString}(__p0)`;
			return `{ ${params.join(', ')} -> ${e.text === 'parseInt' ? `${RT.jsParseInt}(${text}, ${radix})` : `${RT.jsParseFloat}(${text})`} }`;
		}
		// The global timer functions as values (`const schedule: any = setTimeout`).
		const timerValue = ({ setTimeout: 'jsSetTimeoutValue', setInterval: 'jsSetIntervalValue', clearTimeout: 'jsClearTimeoutValue', clearInterval: 'jsClearIntervalValue' } as Record<string, string>)[e.text];
		if (timerValue && !(ts.isCallExpression(e.parent) && e.parent.expression === e) && !ts.isTypeOfExpression(e.parent)) {
			const decls = this.resolve(e)?.declarations ?? [];
			const global = (d: ts.Node) => d.getSourceFile().isDeclarationFile && (!ts.isExternalModule(d.getSourceFile()) || !!ts.findAncestor(d, (n) => ts.isModuleDeclaration(n) && n.name.text === 'global'));
			// Where a typed function is wanted (`pending.forEach(clearTimeout)`), the runtime's function itself.
			// So where it is the fallback of a function called on the spot (`(delegate?.clearTimeout || clearTimeout)(handle)`).
			let held: ts.Node = e;
			while (ts.isParenthesizedExpression(held.parent) || (ts.isBinaryExpression(held.parent) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(held.parent.operatorToken.kind))) held = held.parent;
			const calledHeld = held !== e && ts.isCallExpression(held.parent) && held.parent.expression === held;
			const typed = (e.text === 'clearTimeout' || e.text === 'clearInterval') && (calledHeld || !!this.checker.getContextualType(e)?.getCallSignatures().length);
			if (decls.every(global)) return typed ? `::${RT[globalOp(e.text)]}` : timerValue;
		}
		const name = e.text;
		const shorthandFunction = this.library ? null : this.shorthandFunction(e);
		if (shorthandFunction) return shorthandFunction;
		if (isArguments(e, this.checker)) {
			const ok = canReadArguments(e, (fn) => this.readsArguments(fn), Boolean(this.library));
			if (!ok) throw this.error(e, '`arguments` of a function expression', 'function-arguments');
			return '__arguments';
		}
		if (name === 'undefined') return this.marks.pureCode('null');
		if (name === 'NaN') return 'Double.NaN';
		if (name === 'Infinity') return 'Double.POSITIVE_INFINITY';
		if (name === 'Intl' && isLibDeclaration(this.resolve(e)?.declarations?.[0])) {
			this.refuseIntl(e);
			return 'jsIntl';
		}
		// Before the global object's names: an import from an untyped package resolves to nothing.
		const moot = this.mootImport(e);
		if (moot) return moot;
		if (this.isAmbient(e)) return `${RT.jsGetIfPresent}(jsGlobalThis, ${kotlinString(name)})`;
		if (this.isDomGlobal(e) && !isWriteTarget(e)) {
			const t = this.typeOf(e);
			const code = `${RT.jsGetIfPresent}(jsGlobalThis, ${kotlinString(name)})`;
			return isUntyped(spelledType(t)) ? code : this.fromAnyCode(code, t, true);
		}
		if (!this.library) {
			const declared = this.resolve(e)?.declarations?.[0];
			// The bundled app's module is in the app's folder.
			if (name === '__dirname' && (!declared || declared.getSourceFile().isDeclarationFile)) return '(org.nativescript.kit.knownFolders.currentApp()?.path ?: "")';
			// A global a module declares itself (`declare var System: any`) or the app's declarations file (`declare var __CI__`, which its
			// bundler defines) is the global object's, undefined where nothing sets it; so is a function only core or the app declares
			// (`zonedCallback`, which core's globals set) as a value.
			const appAmbient = isAppDeclarationFile(declared);
			const ambientVar = !!declared && ts.isVariableDeclaration(declared) && ((!declared.getSourceFile().isDeclarationFile && hasModifier(declared.parent.parent, ts.SyntaxKind.DeclareKeyword)) || appAmbient);
			const ambientFn = !!declared && ts.isFunctionDeclaration(declared) && !declared.body && (appAmbient || isCoreDeclaration(declared)) && ts.isSourceFile(declared.parent) && !ts.isExternalModule(declared.parent) && !(ts.isCallExpression(e.parent) && e.parent.expression === e);
			if ((ambientVar || ambientFn) && !isWriteTarget(e)) {
				const t = this.typeOf(e);
				const code = `${RT.jsGetIfPresent}(jsGlobalThis, ${kotlinString(name)})`;
				return isUntyped(spelledType(t)) || ambientFn ? code : this.fromAnyCode(code, t, true);
			}
		}
		// Library mode: `if (!console)`: a compiled program always has its console; `Reflect`, which it lacks, read from the global object.
		if (this.library && name === 'console' && isLibDeclaration(this.resolve(e)?.declarations?.[0]) && !(ts.isPropertyAccessExpression(e.parent) && e.parent.expression === e)) return '(true as Any?)';
		if (this.library && name === 'Reflect' && isLibDeclaration(this.resolve(e)?.declarations?.[0])) return `${RT.jsGetIfPresent}(jsGlobalThis, "Reflect")`;
		// `global` and `globalThis` are the program's global object, whatever declares them.
		if ((name === 'global' || name === 'globalThis') && (this.resolve(e)?.declarations ?? []).every((d) => d.getSourceFile().isDeclarationFile)) return this.marks.pureCode('jsGlobalThis');
		// Library mode: a name nothing declares (an iOS global, `NSSearchPathDirectory`) is the global object's, undefined.
		if (this.library && !this.resolve(e)?.declarations?.length && !isArguments(e, this.checker)) return `${RT.jsGetIfPresent}(jsGlobalThis, ${kotlinString(name)})`;
		// Library mode: core's `global` and `globalThis` are the program's global object.
		if (this.library && (name === 'global' || name === 'globalThis') && (this.resolve(e)?.declarations ?? []).every((d) => d.getSourceFile().isDeclarationFile)) return this.marks.pureCode('jsGlobalThis');
		const native = this.native?.identifier(e);
		if (native) return native;
		const sym = this.resolve(e);
		// Library mode: a Java package read as a value (`(<any>androidx).core`), the runtime's view of it.
		if (this.library && this.isJavaPackage(sym) && (!ts.isPropertyAccessExpression(e.parent) || ts.isAsExpression(e.parent.parent) || ts.isParenthesizedExpression(e.parent) || !!e.parent.questionDotToken)) return `JSJavaPackage(${kotlinString(name)})`;
		// A Java package read on through `?.` (`org.nativescript?.streamdown?.SyntaxHighlighter`, testing a class is there): the runtime's view of it.
		if (!this.library && this.isJavaPackage(sym) && ts.isPropertyAccessExpression(e.parent) && e.parent.expression === e && !!e.parent.questionDotToken) return `JSJavaPackage(${kotlinString(name)})`;
		// An iOS API an Android build reaches: undefined at run time, as in NativeScript on Android.
		if (sym?.declarations?.length && sym.declarations.every((d) => IOS_TYPINGS.test(d.getSourceFile().fileName))) return `${RT.jsUndefinedGlobal}(${kotlinString(name)})`;
		const required = this.patterns.requiredCore(sym?.valueDeclaration);
		if (required) return `${this.core?.kitClass(required) ?? KIT_NAMES_ANDROID[required] ?? required}::class.java`;
		// A core enum or class imported under another name (`AndroidDirectory as __fs_AndroidDirectory`): the kit's of its own name.
		if (!this.library && sym && sym.flags & (ts.SymbolFlags.Enum | ts.SymbolFlags.Class) && sym.name !== name && isCoreDeclaration(sym.declarations?.[0]) && this.core?.has(this.core.kitClass(sym.name))) return this.core.kitClass(sym.name);
		// A function core exports (`booleanConverter`) used as a value: kit-android's function of that name.
		if (!this.library && sym && sym.flags & ts.SymbolFlags.Function && isCoreDeclaration(sym.declarations?.[0]) && !(ts.isCallExpression(e.parent) && e.parent.expression === e)) {
			// The timer functions are the runtime's (`pending.forEach(clearTimeout)`); an import under another name is the function it names.
			const own = sym.name === 'default' ? name : sym.name;
			const runtime = ({ setTimeout: RT.jsSetTimeout, setInterval: RT.jsSetInterval, clearTimeout: RT.jsClearTimeout, clearInterval: RT.jsClearInterval } as Record<string, string>)[own];
			return `::${runtime ?? own}`;
		}
		// A module's function used as a value (`valueConverter: booleanConverter`): a reference to it.
		const value = sym;
		const fnDecl = value && value.flags & ts.SymbolFlags.Function ? value.declarations?.find((d): d is ts.FunctionDeclaration => ts.isFunctionDeclaration(d) && !!d.body) : undefined;
		if (fnDecl && (this.library || this.implicitThis(fnDecl) || fnDecl.parameters.some((q) => isThisParameter(q) && !this.voidThis(q))) && !(ts.isCallExpression(e.parent) && e.parent.expression === e)) {
			const ref = this.refName(e);
			const self = fnDecl.parameters.find((q) => isThisParameter(q) && !this.voidThis(q));
			// A function taking `this` as a value (a property descriptor's `set`): the receiver is the caller's.
			if ((self || this.implicitThis(fnDecl)) && !this.readsArguments(fnDecl)) {
				const thisType = self ? this.type(this.checker.getTypeAtLocation(self.name), self) : 'Any?';
				const args = fnDecl.parameters.filter((q) => !isThisParameter(q)).map((q, k) => (q.dotDotDotToken ? `JSArray(__a.drop(${k}).map { ${this.fromAnyCode('it', this.typeOf(q.name).replace(/^JSArray<(.*)>$/, '$1'), true)} }.toMutableList())` : this.fromAnyCode(this.marks.pureCode(`__a.getOrNull(${k})`), this.paramType(q), true)));
				return `JSMethod ${lambda(['__self', '__a'], `${ref}(${[isUntyped(spelledType(thisType)) ? '__self' : this.fromAnyCode('__self', thisType, true), ...args].join(', ')})`)}`;
			}
			// Library mode: a function of an optional string, number or boolean held as a value (a shorthand's converter) may be given
			// anything (core probes converters with `unsetValue`): another kind of value is none of them, as `typeof` finds it.
			const kinds = fnDecl.parameters.map((p) => this.paramType(p));
			if (this.library && kinds.length && kinds.every((k) => /^(String|Double|Boolean)\?$/.test(k) || isUntyped(spelledType(k))) && kinds.some((k) => !isUntyped(spelledType(k))) && !fnDecl.parameters.some((p) => p.dotDotDotToken)) {
				const names = kinds.map((_, k) => this.marks.pureCode(`__v${k}`));
				return `{ ${names.map((n) => `${n}: Any?`).join(', ')} -> ${ref}(${names.map((n, k) => (isUntyped(spelledType(kinds[k])) ? n : `(${n} as? ${kinds[k].slice(0, -1)})`)).join(', ')}) }`;
			}
			const dot = ref.lastIndexOf('.');
			return dot < 0 ? `::${ref}` : `${ref.slice(0, dot)}::${ref.slice(dot + 1)}`;
		}
		const p = e.parent;
		// `Color.equals(…)` where ColorBase declares the static: Kotlin's companion members are not inherited.
		if (sym && sym.flags & ts.SymbolFlags.Class && ts.isPropertyAccessExpression(p) && p.expression === e) {
			const member = accessedDeclaration(this.resolve(p.name), isWriteTarget(p));
			const owner = member && (ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member) || ts.isAccessor(member)) && isStatic(member) && ts.isClassDeclaration(member.parent) && !member.getSourceFile().isDeclarationFile ? member.parent : undefined;
			if (owner && owner !== sym.valueDeclaration) return this.className(owner);
		}
		if (sym && sym.flags & ts.SymbolFlags.Class && !(ts.isPropertyAccessExpression(p) && p.expression === e) && !(ts.isNewExpression(p) && p.expression === e) && !(ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && p.right === e) && !ts.isHeritageClause(p.parent ?? p)) {
			// A class used as a value (`prop.register(Drawer)`, `registerElement('drawer', Drawer)`): its Java class.
			const decl = sym.valueDeclaration;
			// A component as a value (`dialog.open(Sheet)`): what creating and rendering it gives.
			const component = decl && ts.isClassDeclaration(decl) && this.framework.componentClass(decl, true) ? this.framework.hooks.componentAsValue?.(this, decl, ident(this.declaredName(e))) : undefined;
			if (component !== undefined) return component;
			const kit = decl && isCoreDeclaration(decl) && !this.library ? (this.core?.kitClass(sym.name) ?? KIT_NAMES_ANDROID[sym.name] ?? sym.name) : null;
			return `${kit ?? this.declaredName(e).split('.').map(ident).join('.')}::class.java`;
		}
		const ref = this.globalAlias(e) ?? this.refName(e);
		// Library mode: a class named where a member of that name is in scope (ApplicationCommon's `AndroidApplication` getter) by its package.
		if (this.library && this.appModule && sym && sym.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Enum) && !ref.includes('.') && this.memberInScope(e, name)) return `${this.appModule}.${ref}`;
		return this.narrowed(e, ref);
	},

	/** Whether a class enclosing `at`, or one it extends, has a member of this name. */
	memberInScope(this: Translator, at: ts.Node, name: string): boolean {
		for (let cls = ts.findAncestor(at.parent, ts.isClassLike); cls; cls = ts.findAncestor(cls.parent, ts.isClassLike)) {
			if (this.checker.getTypeAtLocation(cls).getProperty(name)) return true;
		}
		return false;
	},

	globalAlias(this: Translator, e: ts.Identifier): string | null {
		if (this.library) return null;
		const decl = this.resolve(e)?.valueDeclaration;
		if (!decl || !ts.isVariableDeclaration(decl) || decl.getSourceFile().isDeclarationFile) return null;
		const statement = decl.parent.parent;
		if (!ts.isVariableStatement(statement) || !ts.isSourceFile(statement.parent)) return null;
		const cls = ts.findAncestor(e, ts.isClassLike);
		if (!cls || !cls.members.some((m) => m.name && !ts.isComputedPropertyName(m.name) && m.name.getText() === e.text)) return null;
		const alias = `__global_${e.text}`;
		if (!this.globalAliases.has(alias)) {
			const t = this.typeOf(decl.name);
			const constant = (decl.parent.flags & ts.NodeFlags.Const) !== 0;
			this.globalAliases.set(alias, constant ? `val ${alias}: ${t} get() = ${ident(e.text)}` : `var ${alias}: ${t}\n    get() = ${ident(e.text)}\n    set(value) { ${ident(e.text)} = value }`);
		}
		return alias;
	},

	/** A function value Kotlin holds nullable, called: V8's TypeError where it is missing. */
	callable(this: Translator, code: string, callee: ts.Expression): string {
		return `(${this.unasserted(code)} ?: ${RT.jsNotAFunction}(${kotlinString(callee.getText().replace(/\s+/g, ''))}))`;
	},
};
