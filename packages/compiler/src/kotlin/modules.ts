// Module-level declarations as Kotlin: modules, namespaces, prototype defaults, constants, interfaces.
import { setLossSite } from '../semantics/losses.ts';
import ts from 'typescript';
import { LIB_CONSTANTS } from './library.ts';
import { ident, isFunctionType, isNullable, isThisParameter, kotlinString, moduleProperty, optionalType, reportedInit, RT } from './syntax.ts';
import type { ShapeField, Translator } from './translator.ts';
import { boundNames, hasModifier, isLibDeclaration, implementationOf, moduleBlockVars, redeclaredVar } from '../semantics/ast.ts';
import { intersectionAliasMembers, isRegExpProtocol, protocolMethodName, prototypeAlias } from '../semantics/lang.ts';
import { refusedStatements } from '../semantics/nullish.ts';
import { isStatic } from '../semantics/throws.ts';
import { programSymbolKey } from '../program/stable-names.ts';
import { isCoreDeclaration } from '../program/core-facts.ts';
import { isLibGlobal } from '../semantics/globals.ts';
import { methodSlot, resultShapeNamed, signatureField } from '../semantics/shapes.ts';
import { isUntyped, spelledType } from '../semantics/types.ts';

export const modulesMethods = {
	// ---- Modules -------------------------------------------------------------------------------

	/** A module's declarations, and the statements that run when it is first imported. */
	module(this: Translator, sf: ts.SourceFile): { code: string; init: string[] } {
		const refusals = refusedStatements(sf, this.states.nullish().refused);
		this.currentFile = sf.fileName;
		this.props = new Set();
		this.moduleTemporaries.clear();
		const out: string[] = [];
		const init: string[] = [];
		// Library mode: the module's functions and variables are its object's members; its init runs in that object.
		const moduleObject = this.library?.moduleName?.(sf.fileName) ?? null;
		const members: string[] = moduleObject ? [] : out;
		const lexical: string[] = [];
		let current: ts.Statement | null = null;
		const later = (code: () => string) => {
			this.indent = '    ';
			try {
				init.push((current && this.lines ? this.lines.mark(current) : '') + code());
			} finally {
				this.indent = '';
			}
		};
		// App mode: a `var` in a block of the module's statements (`if (…) { var observer = … }`) is the module's, as JavaScript hoists it.
		for (const ds of this.library ? [] : moduleBlockVars(sf, this.checker)) {
			ds.forEach((d) => this.forwardDeclared.add(d));
			members.push(moduleProperty(this.deferredDeclaration(ident(this.topName(ds[0], ds[0].name.getText())), this.typeOf(ds[0].name))));
		}
		for (const st of sf.statements) {
			current = st;
			this.translating = st;
			setLossSite('kotlin', this, st);
			try {
				const refused = refusals.get(st);
				if (refused) throw this.error(refused[0], refused[1]);
				if (ts.isImportDeclaration(st) || ts.isExportDeclaration(st) || ts.isExportAssignment(st)) continue;
				if (this.givesPrototypeDefault(st)) continue;
				if (hasModifier(st, ts.SyntaxKind.DeclareKeyword)) continue;
				if (ts.isInterfaceDeclaration(st) && this.checker.getSymbolAtLocation(st.name)?.declarations?.some(ts.isClassDeclaration)) continue;
				// Types, which a plugin's reached values may name though nothing reaches them as values: emitted where used.
				if (ts.isInterfaceDeclaration(st)) {
					this.registerInterface(this.topName(st, st.name.text), sf.fileName, st.members, st);
					continue;
				}
				if (ts.isTypeAliasDeclaration(st) && ts.isTypeLiteralNode(st.type) && !isRegExpProtocol(this.checker.getTypeAtLocation(st.type))) {
					this.registerInterface(this.topName(st, st.name.text), sf.fileName, st.type.members, st);
					continue;
				}
				if (ts.isTypeAliasDeclaration(st) && intersectionAliasMembers(st, this.checker)) {
					this.registerInterface(this.topName(st, st.name.text), sf.fileName, ts.factory.createNodeArray(intersectionAliasMembers(st, this.checker)!), st);
					continue;
				}
				if (ts.isTypeAliasDeclaration(st)) continue;
				if (this.reach && !this.reach.keeps(st)) continue;
				if (ts.isEnumDeclaration(st)) {
					// A namespace merged into the enum: members of its object.
					const merged = (this.checker.getSymbolAtLocation(st.name)?.declarations ?? []).filter((d): d is ts.ModuleDeclaration => ts.isModuleDeclaration(d) && d.getSourceFile() === sf).flatMap((md) => this.namespaceMembers(md, later) ?? []);
					out.push(this.enumDecl(st, merged));
					continue;
				}
				if (ts.isModuleDeclaration(st) && this.mergedClass(st)) continue;
				if (ts.isModuleDeclaration(st)) {
					const ns = this.namespaceDecl(st, this.topName(st, st.name.text), later);
					if (ns) out.push(ns);
					continue;
				}
				if (ts.isFunctionDeclaration(st) && st.name && this.library?.counterpart(sf.fileName, st.name.text)) continue;
				if (ts.isFunctionDeclaration(st)) {
					if (st.name && st.body) members.push(this.func(st, ident(this.topName(st, st.name.text))));
					continue;
				}
				if (ts.isClassDeclaration(st)) {
					const target = this.patterns.mixinTarget(st);
					if (target) {
						out.push(this.mixinDecl(st, target));
						continue;
					}
					const component = (ts.getDecorators(st) ?? []).some((d) => d.expression.getText().startsWith('Component')) || (!!st.name && this.components.has(st.name.text));
					if (!component && st.name) {
						// A namespace merged into the class: its companion's members.
						this.mergedStatics = (this.checker.getSymbolAtLocation(st.name)?.declarations ?? []).filter((d): d is ts.ModuleDeclaration => ts.isModuleDeclaration(d) && d.getSourceFile() === sf).flatMap((md) => this.namespaceMembers(md, later) ?? []);
						this.staticInits = [];
						try {
							out.push(this.classDecl(st));
						} finally {
							this.mergedStatics = [];
							for (const line of this.staticInits) later(() => line);
							this.staticInits = null;
						}
					}
					continue;
				}
				if (ts.isVariableStatement(st)) {
					const constant = !!(st.declarationList.flags & ts.NodeFlags.Const);
					for (const d of st.declarationList.declarations) {
						if (!ts.isIdentifier(d.name)) {
							for (const n of boundNames(d.name)) {
								const piece = this.states.arrayPiece(n.parent as ts.Declaration) || this.states.optionalObjectPiece(n.parent as ts.Declaration);
								if (ts.isBindingElement(n.parent) && this.matchGroupBinding(n.parent)) {
									const sym = this.resolve(n);
									if (sym) this.undefinedVars.set(sym, 'String?');
									members.push(moduleProperty(`var ${ident(this.topName(n.parent, n.text))}: String? = null`));
								} else if (piece) {
									const sym = this.resolve(n);
									if (sym) this.undefinedVars.set(sym, optionalType(this.typeOf(n)));
									members.push(moduleProperty(`var ${ident(this.topName(n.parent, n.text))}: ${optionalType(this.typeOf(n))} = null`));
								} else members.push(moduleProperty(this.deferredDeclaration(ident(this.topName(n.parent, n.text)), this.typeOf(n))));
							}
							const tmp = this.fresh('__d');
							later(() => this.staticBindings(d, 'assign') ?? `    val ${tmp}${this.destructured(d.name, d.initializer!)}\n${this.bindTo(d.name, tmp, this.untypedPattern(d.name, d.initializer!) ? 'Any?' : '', 'assign')}`);
							continue;
						}
						const extension = this.native?.extensionClass(d);
						if (extension) {
							out.push(extension);
							continue;
						}
						if (this.patterns.requiredCore(d) || this.native?.isClassAlias(d) || prototypeAlias(this, d)) continue;
						const name = ident(this.topName(d, d.name.text));
						// A variable only ever undefined (this platform's half of `isIOS ? x : undefined`) holds nothing: any value.
						const t = this.typeOf(d.name) === 'Unit' ? 'Any?' : this.typeOf(d.name);
						if (redeclaredVar(d, this.checker)) {
							if (d.initializer) later(() => `    ${name} = ${this.stored(d.initializer!, d, t)}`);
							continue;
						}
						if (this.states.nullishHeld(d)) {
							members.push(moduleProperty(`var ${name}: ${t} = JSNullish.Undefined`));
							if (d.initializer) later(() => `    ${name} = ${this.stored(d.initializer!, d, t)}`);
							continue;
						}
						// A plugin's unset object variable (`let vibrator: Vibrator`, tested before it is assigned): nullable, unwrapped where it is read.
						// So is an app's one its code tests (`let instance: Sdk;` … `if (!instance)`).
						if (!d.initializer && (this.pluginFiles.has(sf.fileName) || this.truthTested(d.name)) && !t.endsWith('?') && this.isObjectType(t) && !isFunctionType(t)) {
							const sym = this.checker.getSymbolAtLocation(d.name);
							if (sym) this.nullableDecls.add(sym);
							members.push(moduleProperty(`var ${name}: ${optionalType(t)} = null`));
							continue;
						}
						// Lenient code: `let callback: () => void = null`, or unset, nullable, unwrapped where it is read.
						if (this.lenient && !isNullable(t) && !isUntyped(spelledType(t)) && (this.zero(t) ?? 'null') === 'null' && (d.initializer ? d.initializer.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(d.initializer) && d.initializer.text === 'undefined') : isFunctionType(t))) {
							const sym = this.checker.getSymbolAtLocation(d.name);
							if (sym) this.nullableDecls.add(sym);
							members.push(moduleProperty(`var ${name}: ${optionalType(t)} = null`));
							continue;
						}
						// Library mode: `let density: number;` (or `= undefined`) that code tests for undefined before setting it: nullable.
						const unset = !d.initializer || d.initializer.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(d.initializer) && d.initializer.text === 'undefined');
						if (this.library && unset && ['Double', 'Boolean', 'String'].includes(t) && this.testedForUndefined(d)) {
							const sym = this.checker.getSymbolAtLocation(d.name);
							if (sym) this.nullableDecls.add(sym);
							members.push(moduleProperty(`var ${name}: ${optionalType(t)} = null`));
							continue;
						}
						if (!d.initializer && this.lenientApp && !this.library && ['Double', 'Boolean', 'String'].includes(t) && this.states.appCode(d)) {
							const sym = this.resolve(d.name);
							if (sym) this.undefinedVars.set(sym, optionalType(t));
							members.push(moduleProperty(`var ${name}: ${optionalType(t)} = null`));
							continue;
						}
						if (!d.initializer) {
							members.push(moduleProperty(this.deferredDeclaration(name, t)));
							continue;
						}
						const isTdz = !moduleObject && this.facts.tdzBindings().has(d);
						const emitTdz = (heldType: string, defaultVal: string, rhs: () => string) => {
							const raw = name.replace(/`/g, '');
							const msg = kotlinString(`Cannot access '${ts.isIdentifier(d.name) ? d.name.text : d.name.getText()}' before initialization`);
							members.push(`private var __tdz_${raw}: Boolean = false`, `private var __val_${raw}: ${heldType} = ${defaultVal}`, `var ${name}: ${heldType}\n    @JvmName("__tdz_get_${raw}")\n    get() {\n        if (!__tdz_${raw}) throw JSException(JSReferenceError(${msg}))\n        return __val_${raw}\n    }\n    @JvmName("__tdz_set_${raw}")\n    set(value) {\n        if (!__tdz_${raw}) throw JSException(JSReferenceError(${msg}))\n        __val_${raw} = value\n    }`);
							later(() => `    __val_${raw} = ${rhs()}\n    __tdz_${raw} = true`);
						};
						const maybe = !t.endsWith('?') ? (this.maybeUndefined(d.initializer) ?? (this.states.optionalVariable(d) ? this.heldStore(d, optionalType(t)) : null)) : null;
						if (maybe) {
							const sym = this.resolve(d.name);
							if (sym) this.undefinedVars.set(sym, optionalType(t));
							const rhs = () => ((this.isAny(d.initializer!) || this.untypedElement(d.initializer!)) && !isUntyped(spelledType(t)) ? (this.checkedPlacement(d.initializer!, optionalType(t), maybe, this.storeSlot(d.initializer!, optionalType(t), d)) ?? this.fromAny(maybe, optionalType(t))) : this.nullableArrayAs(maybe, this.typeOf(d.initializer!), t));
							if (isTdz) {
								emitTdz(optionalType(t), 'null', rhs);
								continue;
							}
							members.push(moduleProperty(`var ${name}: ${optionalType(t)} = null`));
							later(() => `    ${name} = ${rhs()}`);
							continue;
						}
						// A module's memo (`computed(fn)`), read through `x()`: its value.
						const computedFn = this.framework.memoized(d, this.checker);
						if (computedFn) {
							const rt = this.computedType(d.initializer as ts.CallExpression);
							const memo = `${name.replace(/`/g, '')}__memo`;
							members.push(moduleProperty(`val ${memo}: Memo<${rt}> = ${this.memo(computedFn, rt, '')}`), `val ${name}: ${rt}\n    get() = ${memo}.value`);
							continue;
						}
						if (!isTdz && this.atLoad(d.initializer)) {
							members.push(moduleProperty(`${constant && !this.mutatedLater(d) ? 'val' : 'var'} ${name}: ${t} = ${this.stored(d.initializer, d, t)}`));
							continue;
						}
						// App mode: the result of a function that gives undefined for its type parameter (`ios(f)`, this platform's half
						// of `__APPLE__ ? f : undefined`): nullable.
						if (!this.library && !isNullable(t) && this.givesNothing(d.initializer)) {
							const sym = this.checker.getSymbolAtLocation(d.name);
							if (sym) this.nullableDecls.add(sym);
							if (isTdz) {
								emitTdz(optionalType(t), 'null', () => this.expr(d.initializer!));
								continue;
							}
							members.push(moduleProperty(`var ${name}: ${optionalType(t)} = null`));
							later(() => `    ${name} = ${this.expr(d.initializer!)}`);
							continue;
						}
						// A lateinit property's setter throws on the null a non-strict app's function gives where its type says an object.
						if (this.givenNullResult(d)) {
							this.noteNullVar(d);
							if (isTdz) {
								emitTdz(t, `${RT.jsUncheckedNull}()`, () => this.stored(d.initializer!, d, t));
								continue;
							}
							members.push(moduleProperty(`var ${name}: ${t} = ${RT.jsUncheckedNull}()`));
							later(() => `    ${name} = ${this.stored(d.initializer!, d, t)}`);
							continue;
						}
						const deferred = this.deferredDeclaration(name, t);
						if (isTdz && !deferred.startsWith('lateinit ')) {
							const eq = deferred.indexOf(' = ');
							const defaultVal = eq >= 0 ? deferred.slice(eq + 3) : 'null';
							emitTdz(t, defaultVal, () => this.stored(d.initializer!, d, t));
							continue;
						}
						// A `let` or `const` read before its declaration runs is JavaScript's ReferenceError: the runtime knows its name.
						if (deferred.startsWith('lateinit ') && st.declarationList.flags & ts.NodeFlags.BlockScoped) {
							const kotlinName = name.replace(/`/g, '');
							lexical.push(kotlinName === d.name.text ? kotlinName : `${kotlinName}:${d.name.text}`);
						}
						members.push(moduleProperty(deferred));
						later(() => `    ${name} = ${this.stored(d.initializer!, d, t)}`);
					}
					continue;
				}
				later(() => this.stmt(st));
			} catch (e) {
				const located = this.located(e, st);
				if (!this.errors) throw located;
				this.errors.push((located as Error).message ?? String(located));
			} finally {
				out.push(...this.hoisted.splice(0));
			}
		}
		this.translating = undefined;
		setLossSite('kotlin', this, undefined);
		const names = lexical.map(kotlinString).join(', ');
		if (lexical.length && !moduleObject) out.push(`private val __lexical_${ident(sf.fileName.replace(/^.*[\\/]/, '').replace(/\W+/g, '_'))} = ${RT.jsLexical}(${names})`);
		if (moduleObject) {
			const body = [...(lexical.length ? [`init {\n    ${RT.jsLexical}(${names})\n}`] : []), ...members, ...(init.length ? [`fun __init() {\n${reportedInit(init)}\n}`] : [])];
			out.push(
				[
					`${this.threadAnnotation(sf)}object ${moduleObject} {`,
					...body.map((m) =>
						m
							.split('\n')
							.map((x) => (x ? '    ' + x : x))
							.join('\n'),
					),
					'}',
				].join('\n'),
			);
		}
		return { code: out.join('\n\n') + '\n', init };
	},

	/**
	 * `namespace N { … }` as `object N`: its functions and variables are
	 * members, read as `N.member`; its statements run with the module's.
	 * A namespace that declares only types has no value and no object.
	 */
	namespaceDecl(this: Translator, md: ts.ModuleDeclaration, name: string, later: (code: () => string) => void): string {
		const lines = this.namespaceMembers(md, later);
		if (!lines) return '';
		return [
			`object ${ident(name)} {`,
			...lines.map((l) =>
				l
					.split('\n')
					.map((x) => (x ? '    ' + x : x))
					.join('\n'),
			),
			'}',
		].join('\n');
	},

	/** A namespace's members as an object's (or, merged into a class, its companion's); null when it has no values. */
	namespaceMembers(this: Translator, md: ts.ModuleDeclaration, later: (code: () => string) => void): string[] | null {
		if (!md.body || !ts.isModuleBlock(md.body)) throw this.error(md, 'a dotted namespace');
		const path = this.namespacePath(md)!;
		const lines: string[] = [];
		let values = false;
		for (const st of md.body.statements) {
			if (hasModifier(st, ts.SyntaxKind.DeclareKeyword)) continue;
			// A namespace's interfaces are the module's: a class of the interface's name.
			if (ts.isInterfaceDeclaration(st)) {
				this.registerInterface(this.topName(st, st.name.text), md.getSourceFile().fileName, st.members, st);
				continue;
			}
			if (ts.isTypeAliasDeclaration(st) && ts.isTypeLiteralNode(st.type) && !isRegExpProtocol(this.checker.getTypeAtLocation(st.type))) {
				this.registerInterface(this.topName(st, st.name.text), md.getSourceFile().fileName, st.type.members, st);
				continue;
			}
			if (ts.isTypeAliasDeclaration(st) && intersectionAliasMembers(st, this.checker)) {
				this.registerInterface(this.topName(st, st.name.text), md.getSourceFile().fileName, ts.factory.createNodeArray(intersectionAliasMembers(st, this.checker)!), st);
				continue;
			}
			if (ts.isTypeAliasDeclaration(st)) continue;
			values = true;
			if (ts.isFunctionDeclaration(st)) {
				if (st.name && st.body) lines.push(this.func(st, ident(st.name.text)));
				continue;
			}
			// A namespace merged into a class of this namespace's (`xml2ui.TemplateParser`): its companion's members, below.
			if (ts.isModuleDeclaration(st) && md.body.statements.some((x) => ts.isClassDeclaration(x) && x.name?.text === st.name.getText())) continue;
			if (ts.isModuleDeclaration(st)) {
				const inner = this.namespaceDecl(st, st.name.text, later);
				if (inner) lines.push(inner);
				continue;
			}
			if (ts.isEnumDeclaration(st)) {
				lines.push(this.enumDecl(st));
				continue;
			}
			if (ts.isVariableStatement(st)) {
				const constant = !!(st.declarationList.flags & ts.NodeFlags.Const);
				for (const d of st.declarationList.declarations) {
					if (!ts.isIdentifier(d.name)) throw this.error(d, 'a destructuring declaration in a namespace');
					if (prototypeAlias(this, d)) continue;
					const name = ident(d.name.text);
					const t = this.typeOf(d.name);
					if (d.initializer && this.atLoad(d.initializer)) {
						lines.push(`@JvmField ${constant ? 'val' : 'var'} ${name}: ${t} = ${this.stored(d.initializer, d, t)}`);
						continue;
					}
					lines.push(this.deferredDeclaration(name, t));
					if (d.initializer) later(() => `    ${path}.${name} = ${this.stored(d.initializer!, d, t)}`);
				}
				continue;
			}
			if (ts.isClassDeclaration(st)) {
				const merged = (md.body as ts.ModuleBlock).statements.filter((x): x is ts.ModuleDeclaration => ts.isModuleDeclaration(x) && x.name.getText() === st.name?.text);
				const saved = this.mergedStatics;
				this.mergedStatics = merged.flatMap((x) => this.namespaceMembers(x, later) ?? []);
				try {
					lines.push(this.classDecl(st));
				} finally {
					this.mergedStatics = saved;
				}
				continue;
			}
			later(() => this.stmt(st));
		}
		return values ? lines : null;
	},
	/** Whether a class declared in a function reads nothing the function declares. */
	capturesNothing(this: Translator, cls: ts.ClassDeclaration, seen = new Set<ts.Node>()): boolean {
		const fn = ts.findAncestor(cls.parent, ts.isFunctionLike);
		if (!fn) return true;
		seen.add(cls);
		let captures = false;
		const visit = (n: ts.Node): void => {
			if (captures) return;
			if (ts.isIdentifier(n)) {
				const d = this.resolve(n)?.declarations?.[0];
				// Another class of the function's declared at the top level too, and its types, are no capture.
				// A member's name is no capture; a local alias of a Java class (`const AccessibilityDelegate = android.view.View.AccessibilityDelegate`) names that class.
				const local = !!d && (ts.isParameter(d) || ts.isFunctionDeclaration(d) || ts.isBindingElement(d) || (ts.isVariableDeclaration(d) && !this.native?.isClassAlias(d)) || ts.isClassDeclaration(d));
				const hoisted = !local || (ts.isClassDeclaration(d!) && (seen.has(d!) || this.capturesNothing(d as ts.ClassDeclaration, seen)));
				if (d && !hoisted && d.getSourceFile() === cls.getSourceFile() && d.pos >= fn.pos && d.end <= fn.end && !(d.pos >= cls.pos && d.end <= cls.end)) {
					captures = true;
					this.captured.set(cls, n.text);
				}
			}
			ts.forEachChild(n, visit);
		};
		ts.forEachChild(cls, visit);
		return !captures;
	},
	/** A statement `prototypeDefaults` gives to the class it assigns. */
	givesPrototypeDefault(this: Translator, st: ts.Statement): boolean {
		this.prototypeDefaults();
		return this.prototypeStatements.has(st);
	},
	/**
	 * Library code's `View.prototype.row = 0` at a module's top level: a field no class initializes, given a value
	 * every instance reads until it sets its own. Each instance of the class starts with it.
	 */
	prototypeDefaults(this: Translator): Map<ts.Node, { field: ts.PropertyDeclaration; value: ts.Expression }[]> {
		if (this.prototypeFields) return this.prototypeFields;
		this.prototypeFields = new Map();
		if (!this.library) return this.prototypeFields;
		for (const sf of this.sourceFiles) {
			if (sf.isDeclarationFile) continue;
			for (const st of sf.statements) {
				const x = ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression) && st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken ? st.expression : null;
				const target = x && ts.isPropertyAccessExpression(x.left) && ts.isPropertyAccessExpression(x.left.expression) && x.left.expression.name.text === 'prototype' ? x.left : null;
				if (!x || !target || !this.constantInit(x.right)) continue;
				const cls = this.resolve((target.expression as ts.PropertyAccessExpression).expression)?.valueDeclaration;
				if (!cls || !ts.isClassDeclaration(cls) || cls.getSourceFile().isDeclarationFile) continue;
				const field = this.checker.getTypeAtLocation(cls).getProperty(target.name.text) ?? this.checker.getDeclaredTypeOfSymbol(this.resolve(cls.name!)!).getProperty(target.name.text);
				const decls = field?.declarations ?? [];
				if (!decls.length || !decls.every((d) => ts.isPropertyDeclaration(d) && !d.initializer && !isStatic(d) && !d.getSourceFile().isDeclarationFile)) continue;
				(this.prototypeFields.get(cls) ?? this.prototypeFields.set(cls, []).get(cls)!).push({ field: decls[0] as ts.PropertyDeclaration, value: x.right });
				this.prototypeStatements.add(st);
			}
		}
		return this.prototypeFields;
	},
	/** The fields `prototypeDefaults` gives each instance a value for. */
	prototypeDefaulted(this: Translator): Set<ts.Node> {
		return new Set([...this.prototypeDefaults().values()].flatMap((list) => list.map((d) => d.field)));
	},
	/** Whether a namespace merges into a class of its name in its file. */
	mergedClass(this: Translator, md: ts.ModuleDeclaration): boolean {
		return (this.checker.getSymbolAtLocation(md.name)?.declarations ?? []).some((d) => (ts.isClassDeclaration(d) || ts.isEnumDeclaration(d)) && d.getSourceFile() === md.getSourceFile());
	},

	/** The Kotlin path of a namespace declaration (`CoreTypes.AnimationCurve`). */
	namespacePath(this: Translator, md: ts.ModuleDeclaration): string | null {
		if (!ts.isIdentifier(md.name)) return null;
		const outer = ts.isModuleBlock(md.parent) ? md.parent.parent : null;
		if (outer) return `${this.namespacePath(outer)}.${ident(md.name.text)}`;
		// Library mode: by the package, as a parameter or member of the same name (`encoding`) hides the namespace.
		const own = ident(this.topName(md, md.name.text));
		return this.library && this.appModule ? `${this.appModule}.${own}` : own;
	},

	/** A reference to a namespace's member (`N.member`) or, in library mode, a module's function or variable (`<module object>.name`); null for the rest. */
	qualifiedDecl(this: Translator, decl: ts.Declaration, name: string): string | null {
		if (decl.getSourceFile().isDeclarationFile) return null;
		const statement = ts.isVariableDeclaration(decl) ? decl.parent.parent : decl;
		const owner = ts.isSourceFile(statement.parent) && (ts.isFunctionDeclaration(statement) || ts.isVariableStatement(statement)) ? this.library?.moduleName?.(decl.getSourceFile().fileName) : null;
		// `export default function lazy`: the function's own name.
		const own = (ts.isFunctionDeclaration(decl) || ts.isVariableDeclaration(decl)) && decl.name && ts.isIdentifier(decl.name) ? decl.name.text : name;
		if (owner) return `${owner}.${ident(own)}`;
		if (!ts.isModuleBlock(statement.parent) || !ts.isModuleDeclaration(statement.parent.parent)) return null;
		const outer = this.namespacePath(statement.parent.parent);
		return outer ? `${outer}.${ident(name)}` : null;
	},

	/** An identifier as a reference to what it names: qualified where its declaration is a namespace's. */
	refName(this: Translator, e: ts.Identifier): string {
		// Library mode: `{ prompt }` names the variable or function it reads, not the property.
		const local = this.library && ts.isShorthandPropertyAssignment(e.parent) && e.parent.name === e ? this.checker.getShorthandAssignmentValueSymbol(e.parent) : this.checker.getSymbolAtLocation(e);
		// An imported type merged with a module's own variable of its name (`let WebViewClient: WebViewClient`): the variable.
		const target = local && local.flags & ts.SymbolFlags.Alias && !local.valueDeclaration ? this.checker.getAliasedSymbol(local) : local;
		const decl = target?.valueDeclaration;
		const counterpart = decl && ts.isFunctionDeclaration(decl) && ts.isSourceFile(decl.parent) ? this.library?.counterpart(decl.getSourceFile().fileName, target!.name) : null;
		if (counterpart) return counterpart;
		return (decl && this.qualifiedDecl(decl, target!.name)) ?? this.unshadowed(e, decl, this.marks.pureCode(ident(this.declaredName(e))));
	},

	/** `{ name }`'s value: in library mode what the name reads (a module's variable, a class, a function) as any read of it is. */
	shorthandValue(this: Translator, e: ts.Identifier): string {
		if (this.library || (ts.isShorthandPropertyAssignment(e.parent) && isLibDeclaration(this.checker.getShorthandAssignmentValueSymbol(e.parent)?.declarations?.[0]))) return this.expr(e);
		return this.shorthandFunction(e) ?? this.marks.pureCode(ident(e.text));
	},

	/** App mode: `{ removeAll }` of a function declaration held untyped, the function value, as one held untyped is. */
	untypedShorthandFunction(this: Translator, e: ts.Identifier): string | null {
		const first = ts.isShorthandPropertyAssignment(e.parent) ? this.checker.getShorthandAssignmentValueSymbol(e.parent)?.valueDeclaration : undefined;
		// An overloaded function is its implementation.
		const decl = first && ts.isFunctionDeclaration(first) && !first.body ? (implementationOf(first) ?? first) : first;
		if (this.library || !decl || !ts.isFunctionDeclaration(decl) || decl.parameters.some((q) => q.dotDotDotToken || isThisParameter(q))) return null;
		const ref = this.shorthandFunction(e);
		return ref ? this.untypedFunction(decl, `(${ref})`) : null;
	},

	/** App mode: `{ flag }` of a function declaration, a reference to it; the name's own symbol is the property's. */
	shorthandFunction(this: Translator, e: ts.Identifier): string | null {
		const local = ts.isShorthandPropertyAssignment(e.parent) && e.parent.name === e ? this.checker.getShorthandAssignmentValueSymbol(e.parent) : undefined;
		const target = local && local.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(local) : local;
		const first = target?.valueDeclaration;
		const decl = first && ts.isFunctionDeclaration(first) && !first.body ? (implementationOf(first) ?? first) : first;
		if (!decl || !ts.isFunctionDeclaration(decl) || !decl.body || decl.getSourceFile().isDeclarationFile || this.implicitThis(decl)) return null;
		const ref = this.unshadowed(e, decl, ident(this.topNames().get(decl) ?? target!.name));
		const dot = ref.lastIndexOf('.');
		return dot < 0 ? `::${ref}` : `${ref.slice(0, dot)}::${ref.slice(dot + 1)}`;
	},

	/** A module-level name read inside a namespace with a member of the same name: qualified by the app's module. */
	enclosingMemberNamed(this: Translator, at: ts.Node, name: string): boolean {
		for (let n: ts.Node | undefined = at.parent; n; n = n.parent) if (ts.isClassLike(n) && n.members.some((m) => m.name && ts.isIdentifier(m.name) && ident(m.name.text) === name)) return true;
		return false;
	},

	unshadowed(this: Translator, at: ts.Node, decl: ts.Declaration | undefined, name: string): string {
		if (!this.appModule || !decl || ts.isSourceFile(decl)) return name;
		const statement = ts.isVariableDeclaration(decl) ? decl.parent.parent : decl;
		if (!ts.isSourceFile(statement.parent)) return name;
		// Read by another name (an import's alias) where a local of its Kotlin name is in scope: by the package.
		if (ts.isIdentifier(at) && at.text !== name) {
			const local = (this.checker as ts.TypeChecker & { resolveName(name: string, at: ts.Node, meaning: ts.SymbolFlags, excludeGlobals: boolean): ts.Symbol | undefined }).resolveName(name, at, ts.SymbolFlags.Value, false)?.valueDeclaration;
			const top = local && (ts.isVariableDeclaration(local) ? local.parent.parent : local);
			if (local && local !== decl && top && !ts.isSourceFile(top.parent) && !local.getSourceFile().isDeclarationFile) return `${this.appModule}.${name}`;
		}
		for (let n: ts.Node | undefined = at.parent; n; n = n.parent) {
			// A class's member of the name (`Status = Status`): inside the class, Kotlin reads the bare name as the member.
			// Not a function: a callable reference takes no package (`::initials` already names the top-level function).
			if (!ts.isFunctionDeclaration(decl) && ts.isClassLike(n) && n.members.some((m) => m.name && ts.isIdentifier(m.name) && ident(m.name.text) === name)) return `${this.appModule}.${name}`;
			if (!ts.isModuleBlock(n)) continue;
			const shadows = n.statements.some((st) => (ts.isFunctionDeclaration(st) || ts.isModuleDeclaration(st) || ts.isEnumDeclaration(st) ? st.name?.getText() === name : ts.isVariableStatement(st) && st.declarationList.declarations.some((d) => d.name.getText() === name)));
			if (shadows) return `${this.appModule}.${name}`;
		}
		return name;
	},

	/** `ns.member` where `ns` is a namespace or a module imported as one (`import * as types`): the member's own reference. */
	namespaceMember(this: Translator, e: ts.PropertyAccessExpression): string | null {
		const recv = this.resolve(e.expression);
		const d = recv?.valueDeclaration;
		if (!recv || !(recv.flags & ts.SymbolFlags.ValueModule) || !d || (d.getSourceFile().isDeclarationFile && !d.getSourceFile().fileName.startsWith('/__shims__/'))) return null;
		const member = this.checker.getSymbolAtLocation(e.name);
		const target = member && member.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(member) : member;
		const decl = target?.valueDeclaration;
		// A class's static member or an enum's member, where a namespace merges into the class or enum; a property script
		// assigns a function (`fn.tag = …`), which is the function value's.
		if (!decl || ts.isClassElement(decl) || ts.isEnumMember(decl) || ts.isPropertyAccessExpression(decl) || ts.isBinaryExpression(decl)) return null;
		if (ts.isModuleDeclaration(decl)) return this.namespacePath(decl);
		// A stand-in's class (a shim's, through a namespace import) is the kit's of its name.
		if (ts.isClassDeclaration(decl)) return decl.getSourceFile().isDeclarationFile ? ident(target!.name) : this.className(decl);
		return this.qualifiedDecl(decl, target!.name) ?? this.unshadowed(e, decl, this.marks.pureCode(ident(this.topName(decl, target!.name))));
	},

	/** Whether a module-level `const` is assigned again by name (never, in valid TypeScript), kept for symmetry with `let`. */
	mutatedLater(this: Translator, _d: ts.VariableDeclaration): boolean {
		return false;
	},

	/**
	 * Whether a module or namespace variable can take its initializer when the file's class loads: the class can load
	 * before or after any statement of the module runs, so the value must be the one it gives whenever it runs.
	 */
	atLoad(this: Translator, e: ts.Expression): boolean {
		return this.pure(e) && this.constantInit(e);
	},

	/** Whether evaluating `e` early (before the module's init runs) cannot be observed. */
	pure(this: Translator, e: ts.Expression): boolean {
		if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) return this.pure(e.expression);
		if (ts.isLiteralExpression(e) || ts.isNoSubstitutionTemplateLiteral(e) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(e.kind)) return !ts.isRegularExpressionLiteral(e);
		if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return true;
		if (ts.isIdentifier(e)) {
			// Another module's variable may not be initialized yet when this file's are.
			const decl = (ts.isShorthandPropertyAssignment(e.parent) && e.parent.name === e ? this.checker.getShorthandAssignmentValueSymbol(e.parent) : this.resolve(e))?.valueDeclaration;
			if (!decl || !ts.isVariableDeclaration(decl) || decl.getSourceFile().isDeclarationFile) return true;
			// A variable of this file is set at load only when its own initializer is.
			return decl.getSourceFile() === e.getSourceFile() && !!decl.initializer && ts.isSourceFile(decl.parent.parent.parent) && this.pure(decl.initializer);
		}
		if (ts.isTemplateExpression(e)) return e.templateSpans.every((s) => this.pure(s.expression));
		// A spread reads what the array holds when it runs.
		if (ts.isArrayLiteralExpression(e)) return e.elements.every((x) => (ts.isSpreadElement(x) ? ts.isArrayLiteralExpression(x.expression) && this.pure(x.expression) : this.pure(x)));
		if (ts.isObjectLiteralExpression(e)) return e.properties.every((p) => (ts.isPropertyAssignment(p) ? this.pure(p.initializer) && (!ts.isComputedPropertyName(p.name) || this.pure(p.name.expression)) : ts.isShorthandPropertyAssignment(p) ? this.pure(p.name) : ts.isMethodDeclaration(p)));
		if (ts.isPrefixUnaryExpression(e)) return e.operator !== ts.SyntaxKind.PlusPlusToken && e.operator !== ts.SyntaxKind.MinusMinusToken && this.pure(e.operand);
		if (ts.isBinaryExpression(e)) return e.operatorToken.kind !== ts.SyntaxKind.EqualsToken && this.pure(e.left) && this.pure(e.right);
		if (ts.isPropertyAccessExpression(e)) {
			// A namespace's variable is set at load only when its own initializer is.
			const member = this.resolve(e.name)?.valueDeclaration;
			if (member && ts.isVariableDeclaration(member) && ts.isModuleBlock(member.parent.parent.parent) && !member.getSourceFile().isDeclarationFile) return member.getSourceFile() === e.getSourceFile() && !!member.initializer && this.pure(member.initializer);
			return this.pure(e.expression) && !(ts.isIdentifier(e.expression) && isLibGlobal(this, e.expression) && !LIB_CONSTANTS[`${e.expression.text}.${e.name.text}`]);
		}
		if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && this.framework.pure(e.expression.text) && !!this.resolve(e.expression)?.declarations?.every((d) => d.getSourceFile().isDeclarationFile)) return e.arguments.every((a) => this.pure(a));
		if (ts.isNewExpression(e) && ts.isIdentifier(e.expression) && ['Map', 'Set'].includes(e.expression.text)) return !e.arguments?.length || e.arguments.every((a) => this.pure(a));
		return false;
	},

	registerInterface(this: Translator, name: string, file: string, members: ts.NodeArray<ts.TypeElement>, decl: ts.Node) {
		if (this.protocols.has(name)) {
			// Its literal's class calls the functions the literal gave: an object of another class has none to call as fields.
			if (this.withInherited(decl, members).some(ts.isMethodSignature)) this.unviewable.add(`${name}Object`);
			this.interfaces.set(name, { file, code: () => this.protocolCode(name, this.withInherited(decl, members)) });
			return;
		}
		if (this.withInherited(decl, members).some((m) => !!m.name && ts.isComputedPropertyName(m.name))) this.unviewable.add(name);
		// Its type parameters erased (`Cached<T>`, `PropertyOptions<T, U>`): one class of fields for every instantiation, its
		// fields of a parameter read as each use types them. Parameters constrained to a primitive (`Option extends string`) erase to it.
		const all = this.withInherited(decl, members);
		this.interfaces.set(name, { file, code: () => this.objectClass(name, this.interfaceFields(all), null) });
	},

	/** An object type's fields: its properties, and its methods as fields holding functions, the first of each name. */
	interfaceFields(this: Translator, all: readonly ts.TypeElement[]): ShapeField[] {
		return all.filter((m, k) => (ts.isPropertySignature(m) || ts.isMethodSignature(m)) && all.findIndex((x) => x.name?.getText() === m.name?.getText()) === k).map((m) => this.interfaceField(m));
	},

	interfaceField(this: Translator, m: ts.TypeElement): ShapeField {
		const t = this.resultFieldType(m) ?? this.typeOf(m);
		const keyed = programSymbolKey(m.name!, this.checker);
		const known = !keyed && this.symbolMemberName(m.name!);
		if (known) return { name: known, type: t, symbol: true };
		if (keyed) return { name: keyed.member, type: m.questionToken ? optionalType(t) : t, symbol: true, key: this.symbolKey(this.expr(keyed.key)) };
		return { name: (m.name as ts.Identifier).text, type: m.questionToken ? optionalType(t) : t };
	},

	/** A field of a result interface of core's (`resultShapesOf`) as the kit's class holds it: any value where core gives one untyped. */
	resultFieldType(this: Translator, m: ts.TypeElement): string | null {
		const owner = m.parent;
		if (!ts.isInterfaceDeclaration(owner) || !m.name || !(ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))) return null;
		if (this.library) {
			const sym = this.checker.getSymbolAtLocation(owner.name);
			return sym && this.library.resultShapes?.get(sym)?.has(m.name.text) ? 'Any?' : null;
		}
		return isCoreDeclaration(owner) && this.core?.viewable?.(owner.name.text) ? (this.core.kitMember(owner.name.text, m.name.text)?.type ?? null) : null;
	},

	/** An interface's members with those of the program's interfaces it extends (`PinchGestureEventData extends GestureEventData`), its own first. */
	withInherited(this: Translator, decl: ts.Node, members: ts.NodeArray<ts.TypeElement>): ts.NodeArray<ts.TypeElement> {
		if (!ts.isInterfaceDeclaration(decl) || !decl.heritageClauses) return members;
		const all = [...members];
		const seen = new Set(members.map((m) => m.name?.getText()));
		for (const h of decl.heritageClauses)
			for (const x of h.types) {
				const base = this.checker
					.getTypeAtLocation(x)
					.getSymbol()
					?.declarations?.find((d): d is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(d) && !d.getSourceFile().isDeclarationFile);
				if (!base) continue;
				for (const m of this.withInherited(base, base.members))
					if (!seen.has(m.name?.getText())) {
						seen.add(m.name?.getText());
						all.push(m);
					}
			}
		return ts.factory.createNodeArray(all);
	},

	/** An interface classes implement: a Kotlin interface, and `<Name>Object` for the object literals of its type. */
	protocolCode(this: Translator, name: string, members: ts.NodeArray<ts.TypeElement>): string {
		const fields = members.filter(ts.isPropertySignature).map((m) => {
			const t = this.typeOf(m);
			return { name: (m.name as ts.Identifier).text, type: m.questionToken ? optionalType(t) : t, readonly: hasModifier(m, ts.SyntaxKind.ReadonlyKeyword) };
		});
		const methods = members.filter(ts.isMethodSignature).map((m) => {
			const params = m.parameters.map((p, k) => ({ name: ts.isIdentifier(p.name) ? ident(p.name.text) : `p${k}`, type: this.requirementParamType(p), undefinedDefault: !!p.questionToken && this.states.nullishHeld(p) }));
			const methodName = protocolMethodName(m.name, this.checker, ident);
			return { name: methodName, key: m.name.getText(), params, ret: this.returnTypeOf(m) };
		});
		// The interface's own declaration gives an omitted `JSNullish` argument its undefined; overrides inherit it.
		const signature = (m: (typeof methods)[0], declared = false) => `fun ${m.name}(${m.params.map((p) => `${p.name}: ${p.type}${declared && p.undefinedDefault ? ' = JSNullish.Undefined' : ''}`).join(', ')})${m.ret === 'Unit' ? '' : `: ${m.ret}`}`;
		const fnType = (m: (typeof methods)[0]) => `(${m.params.map((p) => p.type).join(', ')}) -> ${m.ret}`;
		const lines = [`interface ${name} : JSDynamic {`];
		// Library mode: read-only in the interface, so a class implementing it may hold a narrower type (`android: MotionEvent` for `any`).
		for (const f of fields) lines.push(`    ${f.readonly || this.library ? 'val' : 'var'} ${ident(f.name)}: ${f.type}`);
		// A declared toString() is Any's, which the literal's class overrides as its string conversion (`shapeProtocols`).
		const anyToString = (m: (typeof methods)[0]) => m.key === 'toString' && !m.params.length && m.ret === 'String';
		for (const m of methods) lines.push(`    ${anyToString(m) ? 'override ' : ''}${signature(m, true)}`);
		lines.push('}', '');
		const literal = this.objectClass(`${name}Object`, [...fields, ...methods.map((m) => signatureField(m.key, fnType(m)))], null, name, new Set(fields.map((f) => f.name)));
		const withMethods = literal.replace(
			/\n}$/,
			'\n' +
				methods
					.filter((m) => !anyToString(m))
					.map((m) => `    override ${signature(m)} = ${ident(methodSlot(m.key))}(${m.params.map((p) => p.name).join(', ')})`)
					.join('\n') +
				'\n}',
		);
		return lines.join('\n') + withMethods;
	},

	interfacesOf(this: Translator, file: string): string {
		let out = '';
		const emitted = new Set<string>();
		const norm = file.replace(/\\/g, '/');
		for (let more = true; more;) {
			more = false;
			for (const [name, decl] of this.interfaces) {
				if (decl.file.replace(/\\/g, '/') !== norm || emitted.has(name) || !this.used.has(name)) continue;
				out = decl.code() + '\n\n' + out;
				emitted.add(name);
				more = true;
			}
		}
		return out;
	},

	shapesCode(this: Translator): string {
		return [...[...this.shapes.values()].map((s) => this.objectClass(s.name, s.fields, null)), ...this.globalAliases.values(), ...this.templateObjects].join('\n\n');
	},
	/** Names of members the program assigns on objects that are not class instances (`options.width = 2`). */
	membersSetLater(this: Translator): Set<string> {
		return this.facts.assignedMembers();
	},
	/** `code`'s object as the shape class `name`: the one view of it, or in library code and for a class written without a view mode, a new object read from its keys. */
	viewOf(this: Translator, name: string, code: string): string {
		if ((this.library && !resultShapeNamed(this, name)) || this.unviewable.has(name) || (this.shapesWritten.has(name) && !this.viewed.has(name))) return `${name}.fromJS(${code})`;
		this.viewed.add(name);
		return `${name}.jsView(${code})`;
	},
};
