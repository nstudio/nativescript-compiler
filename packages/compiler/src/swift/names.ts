// Names as Swift: identifiers, imports and the program's top-level names, and global aliases.
import ts from 'typescript';
import { LIB_FUNCTION_VALUES } from './library.ts';
import { ident, identPath, scriptLength, swiftString, RT, SWIFT_NATIVE_TYPES } from './syntax.ts';
import type { Translator } from './translator.ts';
import { runtimeTypeName, isArguments, canReadArguments, objectMethod } from '../semantics/lang.ts';
import { boundNames, hasModifier, isAppDeclarationFile, isLibDeclaration, isWriteTarget, declaresThis } from '../semantics/ast.ts';
import { isCoreDeclaration } from '../program/core-facts.ts';
import { declarationsNamedWith, keptDeclaration, moduleSuffixedName, namedObjectType } from '../semantics/top-names.ts';
import { moduleOfDeclaration, nativeTable, swiftTypeNames } from './native/sdk.ts';
import { isLibGlobal } from '../semantics/globals.ts';
import { isUntyped, spelledType } from '../semantics/types.ts';

export const namesMethods = {
	identifier(this: Translator, e: ts.Identifier): string {
		const name = e.text;
		// `parseInt`, `parseFloat` as values (`valueConverter: parseInt`): functions of the string they are given.
		const parse = this.parseFunction(e);
		if (parse) return parse.code;
		// A function declaring `this`, as a value: a method value calling it with the receiver it is given.
		const thisFn = this.thisFunction(e);
		if (thisFn) {
			const declared = declaresThis(thisFn);
			const params = declared ? thisFn.parameters.slice(1) : [...thisFn.parameters];
			const args = this.readsArguments(thisFn) ? ['JSArray<Any?>(__a)'] : params.map((p, k) => this.fromAnyCode(`${RT.jsArg}(__a, ${k})`, this.paramType(p), true));
			const self = declared ? this.paramType(thisFn.parameters[0]) : 'Any?';
			const call = this.marks.tryIf(this.throwsInfo.fn(thisFn), `${this.refName(e)}(${[isUntyped(spelledType(self)) ? '__this' : this.fromAnyCode('__this', self, true), ...args].join(', ')})`);
			const ret = this.returnTypeOf(thisFn);
			const method = `{ (__this: Any?, __a: [Any?]) throws -> Any? in ${ret === 'Void' ? `${call}; return nil` : `return ${this.convert(call, ret, 'Any?')}`} }`;
			return this.library ? `(${method} as JSMethod)` : `${RT.jsMethodFunction}(${swiftString(thisFn.name!.text)}, ${scriptLength(thisFn)}, ${method})`;
		}
		if (isArguments(e, this.checker)) {
			if (!canReadArguments(e, (fn) => this.readsArguments(fn), !!this.library)) throw this.error(e, '`arguments` of a function expression', 'function-arguments');
			return '__arguments';
		}
		const moot = this.mootImport(e);
		if (moot) return moot;
		const appNative = this.appNativeOf(e);
		if (appNative) return appNative;
		if (name === 'undefined') return 'nil';
		if (name === 'NaN') return this.marks.pureCode('Double.nan');
		if (name === 'Infinity') return 'Double.infinity';
		if (name === 'Intl' && isLibDeclaration(this.resolve(e)?.declarations?.[0])) {
			this.refuseIntl(e);
			return 'jsIntl';
		}
		if (name === 'globalThis' && this.isGlobalThis(e)) return 'jsGlobalThis';
		const libDecl = this.resolve(e)?.declarations?.[0];
		// Library mode: core's `global` is the program's global object; the Android SDK's namespaces exist only there.
		// A name nothing declares for iOS (`android`, `java`, Node's `__dirname`) is a value whose use throws.
		if (name === 'global' && (this.library ? !libDecl || libDecl.getSourceFile().isDeclarationFile : !!libDecl && libDecl.getSourceFile().isDeclarationFile)) return 'jsGlobalThis';
		// A timer or microtask function held as a value (`const clear = clearTimeout`, `requestAnimationFrame`, `queueMicrotask`), core's declaration of it too.
		const held = !!libDecl && libDecl.getSourceFile().isDeclarationFile && Object.hasOwn(LIB_FUNCTION_VALUES, name) && !(ts.isCallExpression(e.parent) && e.parent.expression === e) ? LIB_FUNCTION_VALUES[name] : undefined;
		if (held) return this.convert(held.code, held.type, this.typeOf(e));
		if (this.isDomGlobal(e)) return `jsGlobalThis[jsKey: ${swiftString(name)}]`;
		// The runtime gives the bundled app's module its folder in the app bundle.
		if (name === '__dirname' && (!libDecl || libDecl.getSourceFile().isDeclarationFile)) return 'jsAppDirectory';
		// Library mode: an import of what only the app has (`import appConfig from '~/package.json'`): the kit's counterpart, given by the app.
		const appImport = this.library && !libDecl ? ts.findAncestor(this.checker.getSymbolAtLocation(e)?.declarations?.[0], ts.isImportDeclaration) : undefined;
		if (appImport && ts.isStringLiteral(appImport.moduleSpecifier)) {
			const d = this.checker.getSymbolAtLocation(e)!.declarations![0];
			const found = this.library!.counterpart?.(appImport.moduleSpecifier.text, ts.isImportSpecifier(d) ? (d.propertyName ?? d.name).text : ts.isNamespaceImport(d) ? '*' : 'default');
			if (found) return found;
		}
		// Android's API on iOS (`androidx.core.view.ViewCompat` behind a check that the code runs on Android): a value that throws when used.
		if ((this.library && !libDecl) || (libDecl && /[\\/]types-android[\\/]/.test(libDecl.getSourceFile().fileName))) return `${this.library ? RT.jsMoot : RT.jsUndeclared}(${swiftString(name)})`;
		// A global a module declares itself (`declare let __startCPUProfiler: any`, a plugin's `declare var PluginModule`) is the global object's, set by whatever provides it.
		// An app's own declarations file too (`declare var __CI__`, which its bundler defines): undefined where nothing sets it.
		const appAmbient = !this.library && isAppDeclarationFile(libDecl);
		if (libDecl && ts.isVariableDeclaration(libDecl) && ((!libDecl.getSourceFile().isDeclarationFile && hasModifier(libDecl.parent.parent, ts.SyntaxKind.DeclareKeyword)) || appAmbient)) {
			const sdk = this.native.declaredConstant(e);
			if (sdk) return sdk;
			return this.fromAnyCode(`jsGlobalThis[jsKey: ${swiftString(name)}]`, this.typeOf(e));
		}
		// A global function core or the app only declares (`zonedCallback`, which core's globals set), as a value: the global object's.
		if (!this.library && libDecl && ts.isFunctionDeclaration(libDecl) && !libDecl.body && (appAmbient || isCoreDeclaration(libDecl)) && ts.isSourceFile(libDecl.parent) && !hasModifier(libDecl, ts.SyntaxKind.ExportKeyword)) return 'jsGlobalThis[jsKey: ' + swiftString(name) + ']';
		// `Object` as a value, not the receiver of a call the translation knows (`(<any>Object).entries(o)`): its functions as script has them.
		if (name === 'Object' && isLibDeclaration(libDecl) && !(ts.isPropertyAccessExpression(e.parent) && e.parent.expression === e)) return 'jsObjectBuiltin';
		if (name === 'parseFloat' && isLibDeclaration(libDecl) && !(ts.isCallExpression(e.parent) && e.parent.expression === e)) return RT.jsParseFloat;
		const builtinValue = this.builtinConstructorValue(e, libDecl);
		if (builtinValue) return builtinValue;
		// `if (!console)`: a compiled program always has its console.
		if (name === 'console' && isLibGlobal(this, e)) return '(true as Any?)';
		const native = this.native.identifier(e);
		if (native) return native;
		const sym = this.resolve(e);
		const required = this.patterns.requiredCore(sym?.valueDeclaration);
		if (required) return `${required}.self`;
		const p = e.parent;
		if (name === 'Application' && sym?.declarations?.some((d) => isCoreDeclaration(d)) && ts.isAsExpression(p)) return 'NativeScriptKit.Application';
		// An enum as a value (`Object.entries(Role)`): the object JavaScript makes of it.
		const enumDecl = sym?.valueDeclaration;
		if (enumDecl && ts.isEnumDeclaration(enumDecl) && (!enumDecl.getSourceFile().isDeclarationFile || (!this.library && isCoreDeclaration(enumDecl))) && !(ts.isPropertyAccessExpression(p) && p.expression === e && (this.library || !objectMethod(this, p))) && !(!this.library && ts.isElementAccessExpression(p) && p.expression === e)) {
			return `${this.unshadowed(e, enumDecl, identPath(this.declaredName(e)))}.jsEnumObject`;
		}
		if (sym && sym.flags & ts.SymbolFlags.Class && !(ts.isPropertyAccessExpression(p) && p.expression === e) && !(ts.isNewExpression(p) && p.expression === e) && !(ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && p.right === e) && !ts.isHeritageClause(p.parent ?? p)) {
			// A component as a value (`dialog.open(Sheet)`): what creating and rendering it gives.
			const decl = sym.valueDeclaration;
			const component = decl && ts.isClassDeclaration(decl) && this.framework.componentClass(decl, true) ? this.framework.hooks.componentAsValue?.(this, decl, ident(this.declaredName(e))) : undefined;
			if (component !== undefined) return component;
			const name = (!this.library && decl && isCoreDeclaration(decl) && this.core.kitTypeName(sym.name)) || identPath(this.declaredName(e));
			// A class read inside a class with a member of its name (`static UILayoutViewController = UILayoutViewController`): the module's.
			const cls = ts.findAncestor(e, ts.isClassLike);
			const shadowed = this.appModule && cls && cls.members.some((m) => m.name && ts.isIdentifier(m.name) && m.name.text === e.text);
			return `${shadowed ? `${this.appModule}.` : ''}${name}.self`;
		}
		if (this.isNamespace(e)) return `${this.refName(e)}.self`;
		const ref = this.globalAlias(e) ?? this.refName(e);
		// A module's function or constant read inside a class with a member of its name (`readonly initials = initials`): the module's.
		const top = sym?.valueDeclaration;
		const topLevel = !!top && (ts.isFunctionDeclaration(top) ? ts.isSourceFile(top.parent) : ts.isVariableDeclaration(top) && ts.isVariableStatement(top.parent.parent) && ts.isSourceFile(top.parent.parent.parent));
		const cls = ts.findAncestor(e, ts.isClassLike);
		const qualified = this.appModule && topLevel && cls?.members.some((m) => m.name && ts.isIdentifier(m.name) && ident(m.name.text) === ref) ? `${this.appModule}.${ref}` : ref;
		if (top && ts.isVariableDeclaration(top) && this.facts.tdzBindings().has(top) && !(top.parent.flags & ts.NodeFlags.Const) && !isWriteTarget(e)) {
			return this.narrowed(e, `__tdz_get_${ref.replace(/`/g, '')}()`);
		}
		const declared = this.declaredFunctionRead(e);
		return this.narrowed(e, declared ? this.declaredValue(qualified, declared) : qualified);
	},

	/** A name imported from a module a compiled app has no use for (library mode): a value whose use throws. */
	mootImport(this: Translator, e: ts.Identifier): string | null {
		if (!this.library?.isMoot) return null;
		const local = this.checker.getSymbolAtLocation(e);
		const decl = local?.declarations?.[0];
		const imported = decl && ts.findAncestor(decl, ts.isImportDeclaration);
		const module = imported && this.checker.getSymbolAtLocation(imported.moduleSpecifier)?.valueDeclaration;
		if (!module || !this.library.isMoot(module.getSourceFile().fileName)) return null;
		const name = ts.isImportSpecifier(decl) ? (decl.propertyName ?? decl.name).text : ts.isNamespaceImport(decl) ? '*' : 'default';
		return this.library.counterpart?.(module.getSourceFile().fileName, name) ?? `${RT.jsMoot}(${swiftString(e.text)})`;
	},

	/** Whether an expression names a namespace the program declares (its enum, used as a value). */
	isNamespace(this: Translator, e: ts.Expression): boolean {
		const sym = this.resolve(ts.isPropertyAccessExpression(e) ? e.name : e);
		const d = sym?.valueDeclaration;
		return !!d && ts.isModuleDeclaration(d) && !d.getSourceFile().isDeclarationFile;
	},

	/**
	 * The name a translated declaration has: an import renamed (`install as
	 * installGestureHandler`) names its export, and a module-level name that
	 * several modules declare is the module's own (`topName`).
	 */
	declaredName(this: Translator, e: ts.Identifier): string {
		const local = ts.isShorthandPropertyAssignment(e.parent) && e.parent.name === e ? this.checker.getShorthandAssignmentValueSymbol(e.parent) : this.checker.getSymbolAtLocation(e);
		if (!local) return e.text;
		const alias = !!(local.flags & ts.SymbolFlags.Alias);
		const target = alias ? this.checker.getAliasedSymbol(local) : local;
		const decl = target.valueDeclaration;
		if (decl && this.topNames().has(decl)) return this.topNames().get(decl)!;
		// Core's declarations are the kit's names, whatever the import calls them (`requestAnimationFrame as raf`).
		if (!alias || !decl || (decl.getSourceFile().isDeclarationFile && !isCoreDeclaration(decl)) || target.name === 'default' || target.flags & ts.SymbolFlags.ValueModule) return e.text;
		return target.name;
	},

	/** `name` in `file`'s module: the shortest end of its path no other name has taken (`label__index`, else `label__two_index`). */
	uniqueTopName(this: Translator, name: string, file: string): string {
		return moduleSuffixedName(name, file, this.topTaken);
	},

	/**
	 * App mode: a type name Swift code already has unqualified (the standard library's, the runtime's, the app module's own
	 * Swift, or a native module's the app imports), which a program type of that name would hide from the app.
	 */
	swiftTypeClash(this: Translator, name: string): boolean {
		return !this.library && (SWIFT_NATIVE_TYPES.has(name) || runtimeTypeName(name) || this.appSwiftNames.has(name) || this.importedTypeNames().has(name));
	},
	/** The Swift type names of `nativeModules` and of the SDK modules whose declarations the program's code names. */
	importedTypeNames(this: Translator): Set<string> {
		if (this.importedTypes) return this.importedTypes;
		const modules = new Set(this.nativeModules);
		const byFile = new Map<string, string | null>();
		const visit = (n: ts.Node): void => {
			if (ts.isIdentifier(n)) {
				const file = this.checker.getSymbolAtLocation(n)?.declarations?.[0]?.getSourceFile();
				if (file?.isDeclarationFile) {
					if (!byFile.has(file.fileName)) byFile.set(file.fileName, moduleOfDeclaration(file.fileName));
					const m = byFile.get(file.fileName);
					if (m) modules.add(m);
				}
			}
			ts.forEachChild(n, visit);
		};
		for (const sf of this.sourceFiles) if (!sf.isDeclarationFile) visit(sf);
		this.importedTypes = new Set();
		for (const m of modules) {
			try {
				for (const n of swiftTypeNames(nativeTable(m))) this.importedTypes.add(n);
			} catch {}
		}
		return this.importedTypes;
	},

	/**
	 * Module-level functions and variables of the same name in several modules
	 * (a plugin's `install` in its common and iOS files): all but one take the
	 * module's name as a suffix, as Swift has one namespace for the app.
	 */
	topNames(this: Translator): Map<ts.Node, string> {
		if (this.renamedTop) return this.renamedTop;
		const byName = new Map<string, { decl: ts.Node; file: ts.SourceFile }[]>();
		for (const sf of this.sourceFiles) {
			if (sf.isDeclarationFile) continue;
			const add = (name: string, decl: ts.Node) => {
				const list = byName.get(name) ?? [];
				if (!list.some((x) => x.file === sf)) list.push({ decl, file: sf });
				else if (ts.isFunctionDeclaration(decl)) list.find((x) => x.file === sf)!.decl = decl.body ? decl : list.find((x) => x.file === sf)!.decl;
				byName.set(name, list);
			};
			const library = !!this.library?.moduleName(sf.fileName);
			for (const st of sf.statements) {
				if ((ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) add(st.name.text, st);
				if (ts.isModuleDeclaration(st) && ts.isIdentifier(st.name) && !hasModifier(st, ts.SyntaxKind.DeclareKeyword)) add(st.name.text, st);
				// An object type is a Swift type of its name (a class in library mode, else a protocol or object class), so it shares the
				// namespace with the classes (sqlite's `SQLiteDatabase` interface in its common file, the class in its iOS one).
				if (library ? ts.isInterfaceDeclaration(st) || (ts.isTypeAliasDeclaration(st) && ts.isTypeLiteralNode(st.type)) : namedObjectType(st, this.checker)) add((st as ts.InterfaceDeclaration | ts.TypeAliasDeclaration).name.text, st);
				if (library) continue;
				if (ts.isFunctionDeclaration(st) && st.name) add(st.name.text, st);
				if (ts.isVariableStatement(st) && !hasModifier(st, ts.SyntaxKind.DeclareKeyword)) for (const d of st.declarationList.declarations) for (const n of boundNames(d.name)) add(n.text, n.parent);
			}
		}
		this.renamedTop = new Map();
		for (const name of byName.keys()) this.topTaken.add(name);
		for (const [name, list] of byName) {
			// A plugin's or the app's type named as a NativeScriptKit type takes its module's name too: a class (one extending core's
			// `Observable`), and outside the kit a namespace, enum, interface or object type (ui-chart's `Utils`), since a declaration
			// of the app's module hides the kit's of its name from every file of the app.
			// A function or variable named as the kit's top-level one (a plugin's own `booleanConverter`) takes its module's name, which the app's imports of core's leave to the kit's.
			const typeLike = (d: ts.Node) => ts.isClassDeclaration(d) || (!this.library && (ts.isModuleDeclaration(d) || ts.isEnumDeclaration(d) || ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d)));
			const kitClash = (list.some((x) => typeLike(x.decl)) && (this.library ? this.core.declares(name) : this.core.has(name))) || (!this.library && list.some((x) => ts.isFunctionDeclaration(x.decl) || ts.isVariableDeclaration(x.decl) || ts.isBindingElement(x.decl)) && this.core.exportsTopLevel(name));
			// A generated class and a hand-ported one of the same name: the hand port of that module has to go first.
			if (kitClash && list.some((x) => this.library?.moduleName(x.file.fileName))) this.kitClashes.push(name);
			// A type the hand-written kit declares for itself (Signals' `Source`), or an app's type named as one Swift has already
			// (`Result`): the generated one takes its module's name.
			const internalClash = !!this.library?.internalTypes?.has(name) || (list.some((x) => typeLike(x.decl) || ts.isInterfaceDeclaration(x.decl)) && this.swiftTypeClash(name));
			if (list.length < 2 && !kitClash && !internalClash) continue;
			// The app's first declaration keeps its name; the others take their module's.
			// A class keeps its name over an interface of the same name, as it is the public API.
			const keep = kitClash || internalClash ? undefined : keptDeclaration(list, this.pluginFiles, !!this.library);
			for (const x of list) {
				if (x === keep) continue;
				const renamed = this.uniqueTopName(name, x.file.fileName);
				for (const d of declarationsNamedWith(x.decl, x.file, name, this.checker)) this.renamedTop.set(d, renamed);
			}
		}
		// A class a namespace declares is the namespace's nested class.
		const nested = (md: ts.ModuleDeclaration) => {
			if (!md.body || !ts.isModuleBlock(md.body)) return;
			for (const st of md.body.statements) {
				if (ts.isClassDeclaration(st) && st.name) this.renamedTop!.set(st, `${this.namespacePath(md)}.${st.name.text}`);
				if (ts.isModuleDeclaration(st)) nested(st);
			}
		};
		for (const sf of this.sourceFiles) if (!sf.isDeclarationFile) for (const st of sf.statements) if (ts.isModuleDeclaration(st)) nested(st);
		// A namespace's interface is a class of the module's (see `namespaceDecl`): where another declaration of the module, another
		// namespace's interface or the kit has its name, it takes its namespace's.
		if (!this.library) {
			const hoisted = new Map<string, { decl: ts.Node; ns: ts.ModuleDeclaration }[]>();
			const collect = (md: ts.ModuleDeclaration) => {
				if (!md.body || !ts.isModuleBlock(md.body) || hasModifier(md, ts.SyntaxKind.DeclareKeyword)) return;
				for (const st of md.body.statements) {
					if (ts.isInterfaceDeclaration(st) || (ts.isTypeAliasDeclaration(st) && ts.isTypeLiteralNode(st.type))) hoisted.set(st.name.text, [...(hoisted.get(st.name.text) ?? []), { decl: st, ns: md }]);
					if (ts.isModuleDeclaration(st)) collect(st);
				}
			};
			for (const sf of this.sourceFiles) if (!sf.isDeclarationFile) for (const st of sf.statements) if (ts.isModuleDeclaration(st)) collect(st);
			for (const [name, list] of hoisted) {
				if (!byName.has(name) && list.length < 2 && !this.core.has(name) && !this.swiftTypeClash(name)) continue;
				for (const x of list) this.renamedTop.set(x.decl, `${name}__${(this.namespacePath(x.ns) ?? '').replace(/\./g, '_')}`);
			}
		}
		return this.renamedTop;
	},

	/**
	 * A module-level variable read or written inside a class with a member of the same name
	 * (`readonly fruits = fruits`): Swift would resolve the name to the member,
	 * so the access goes through a global alias of the variable.
	 */
	globalAlias(this: Translator, e: ts.Identifier): string | null {
		const decl = this.resolve(e)?.valueDeclaration;
		if (!decl || !ts.isVariableDeclaration(decl) || decl.getSourceFile().isDeclarationFile || this.qualifiedDecl(decl, e.text)) return null;
		const statement = decl.parent.parent;
		if (!ts.isVariableStatement(statement) || !ts.isSourceFile(statement.parent)) return null;
		const cls = ts.findAncestor(e, ts.isClassLike);
		if (!cls || !cls.members.some((m) => m.name && !ts.isComputedPropertyName(m.name) && m.name.getText() === e.text)) return null;
		const alias = `__global_${e.text}`;
		if (!this.globalAliases.has(alias)) {
			const t = this.typeOf(decl.name);
			const constant = (decl.parent.flags & ts.NodeFlags.Const) !== 0;
			this.globalAliasTypes.set(alias, t);
			this.globalAliases.set(alias, `var ${alias}: ${t} {${constant ? ` ${ident(e.text)} ` : ` get { ${ident(e.text)} } set { ${ident(e.text)} = newValue } `}}`);
		}
		return alias;
	},
};
