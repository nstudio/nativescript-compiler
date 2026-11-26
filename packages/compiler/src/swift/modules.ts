// Module-level declarations as Swift: modules, variables, namespaces, constants, interfaces and protocols.
import { setLossSite } from '../semantics/losses.ts';
import ts from 'typescript';
import { NONISOLATED_DEINIT, SWIFT_GLOBAL_FUNCTIONS, escapingFunction, functionParts, ident, identPath, indented, isFunctionType, isNullish, isOptional, nativeResult, nativeZero, optionalType, swiftString, RT } from './syntax.ts';
import type { CellStatic } from './syntax.ts';
import type { ShapeField, Translator } from './translator.ts';
import { lookupClass, lookupMember } from './native/sdk.ts';
import type { NativeMethod } from './native/sdk.ts';
import type { RecordedMember } from '../kit/manifest.ts';
import type { StructuralFacts } from '../semantics/conversion.ts';
import { boundNames, hasModifier, isLibDeclaration, moduleBlockVars, redeclaredVar } from '../semantics/ast.ts';
import { enteredGuard, onMainThread } from './native/bridging.ts';
import { givenBy, onlyNullOrPresent, refusedStatements } from '../semantics/nullish.ts';
import { intersectionAliasMembers, protocolMethodName, prototypeAlias } from '../semantics/lang.ts';
import { isStatic } from '../semantics/throws.ts';
import { isCoreDeclaration } from '../program/core-facts.ts';
import { programSymbolKey } from '../program/stable-names.ts';
import { prototypeDecorated } from '../semantics/classes.ts';
import { methodSlot, resultShapeNamed, signatureField } from '../semantics/shapes.ts';
import { isUntyped, spelledType } from '../semantics/types.ts';

export const modulesMethods = {
	// ---- Modules -------------------------------------------------------------------------------

	/** A module's declarations, and the statements that run when it is first imported. */
	module(this: Translator, sf: ts.SourceFile): { code: string; init: string[] } {
		const outer = this.currentFile;
		this.currentFile = sf.fileName;
		const counts = this.freshCounts;
		this.freshCounts = new Map();
		const owner = this.declOwner;
		try {
			const { code, init } = this.moduleOf(sf);
			return { code, init };
		} finally {
			this.currentFile = outer;
			this.freshCounts = counts;
			this.declOwner = owner;
		}
	},

	moduleOf(this: Translator, sf: ts.SourceFile): { code: string; init: string[] } {
		this.props = new Set();
		this.hoisted = [];
		const out: string[] = [];
		const init: string[] = [];
		// Library mode: the module's functions and variables are an enum's static members.
		const library = this.library?.moduleName(sf.fileName) ?? null;
		const members: string[] = [];
		const member = (code: string) => (library ? members : out).push(code);
		// Library mode: the module's functions and variables are recorded as its enum's.
		this.declOwner = library;
		// App mode: a `var` in a block of the module's statements (`if (…) { var observer = … }`) is the module's, as JavaScript
		// hoists it: a global of the module's own name, which another module's of the name does not clash with.
		if (!library) {
			for (const ds of moduleBlockVars(sf, this.checker)) {
				if (ds.some((d) => this.forwardDeclared.has(d))) continue;
				const first = ds[0].name as ts.Identifier;
				const name = this.uniqueTopName(first.text, sf.fileName);
				for (const d of ds) {
					this.topNames().set(d, name);
					this.forwardDeclared.add(d);
				}
				out.push(`var ${ident(name)}: ${this.deferred(this.typeOf(first))}`);
			}
		}
		const refusals = refusedStatements(sf, this.states.nullish().refused);
		let current: ts.Statement | null = null;
		// The module's statements, run by its initializer: a function body.
		const later = (code: () => string) => {
			this.indent = '    ';
			this.moduleAvailability = 0;
			this.functionDepth++;
			try {
				const line = (current && this.lines ? this.lines.mark(current) : '') + code();
				init.push(this.moduleAvailability ? this.availableOnly(this.moduleAvailability, line.replace(/^ {4}/gm, ''), '    ', `${RT.jsReportUncaught}(${RT.jsUnavailable}(${this.moduleAvailability}).value)`) : line);
			} finally {
				this.indent = '';
				this.moduleAvailability = 0;
				this.functionDepth--;
			}
		};
		for (const st of sf.statements) {
			current = st;
			setLossSite('swift', this, st);
			try {
				const refused = refusals.get(st);
				if (refused) {
					const e = this.error(refused[0], refused[1]);
					if (!this.errors) throw e;
					this.errors.push(e.message);
					continue;
				}
				if (ts.isImportDeclaration(st) || ts.isExportDeclaration(st) || ts.isExportAssignment(st)) continue;
				if (hasModifier(st, ts.SyntaxKind.DeclareKeyword)) continue;
				// An interface merged into a class of its name only types it: the class is the declaration.
				if (ts.isInterfaceDeclaration(st) && this.checker.getSymbolAtLocation(st.name)?.flags! & ts.SymbolFlags.Class) continue;
				// Types, which a plugin's values reached may name though nothing reaches them as values: emitted where used.
				if (ts.isInterfaceDeclaration(st)) {
					this.registerInterface(this.topName(st, st.name.text), sf.fileName, this.interfaceMembers(st));
					continue;
				}
				if (ts.isTypeAliasDeclaration(st) && ts.isTypeLiteralNode(st.type)) {
					this.registerInterface(this.topName(st, st.name.text), sf.fileName, st.type.members);
					continue;
				}
				if (ts.isTypeAliasDeclaration(st) && intersectionAliasMembers(st, this.checker)) {
					this.registerInterface(this.topName(st, st.name.text), sf.fileName, intersectionAliasMembers(st, this.checker)!);
					continue;
				}
				if (ts.isTypeAliasDeclaration(st)) continue;
				if (this.reach && !this.reach.keeps(st)) continue;
				if (ts.isEnumDeclaration(st)) {
					out.push(this.enumDecl(st));
					continue;
				}
				if (ts.isModuleDeclaration(st)) {
					const ns = this.namespaceDecl(st, this.topName(st, st.name.text), later);
					if (ns) out.push(ns);
					continue;
				}
				// A function the kit implements in its place (core calling an npm package): references call the kit's.
				if (ts.isFunctionDeclaration(st) && st.name && this.library?.counterpart?.(sf.fileName, st.name.text) && !this.functionCounterpart(st)) continue;
				if (ts.isFunctionDeclaration(st)) {
					if (st.name && st.body) member([...this.docLines(st, ''), this.memberFunc(st, ident(library ? st.name.text : this.topName(st, st.name.text)), library ? 'static ' : '')].join('\n'));
					continue;
				}
				if (ts.isClassDeclaration(st)) {
					const target = this.patterns.mixinTarget(st);
					if (target) {
						out.push(this.mixinDecl(st, target));
						continue;
					}
					// Components are translated with their templates; other classes are services and models.
					// A component's class is written with its render function, in its own file.
					const component = this.isComponentClass(st);
					if (!component && st.name) {
						this.staticInits = [];
						let inits: string[];
						try {
							out.push(this.classDecl(st));
						} finally {
							inits = this.staticInits;
							this.staticInits = null;
						}
						if ((library || this.appMembersByName) && st.members.some((m) => ts.isAccessor(m) && !isStatic(m))) later(() => this.prototypeAccessors(st));
						for (const line of inits) later(() => line);
						// Library mode: its statics and decorators run once it is defined.
						if ((library || this.appMembersByName) && (ts.getDecorators(st)?.length || this.heldAsValue(st))) later(() => this.classDefinition(st));
						else if (!library && !this.appMembersByName && this.states.byNameStatics(st)) later(() => this.staticsDeclaration(st) ?? '');
						if (st.members.some((m) => prototypeDecorated(this, m))) later(() => this.fieldDecorators(st) ?? '');
					}
					continue;
				}
				if (ts.isVariableStatement(st)) {
					if (library && st.declarationList.declarations.some((d) => !ts.isIdentifier(d.name))) throw this.error(st, 'a destructuring declaration at the top of a library module');
					this.variables(
						st,
						member,
						(d) => (library ? `${library}.${ident(d.name.getText())}` : ident(this.topName(d, d.name.getText()))),
						(d) => ident(library ? d.name.getText() : this.topName(d, d.name.getText())),
						library ? 'static ' : '',
						later,
					);
					continue;
				}
				later(() => this.stmt(st));
			} catch (e) {
				throw this.located(e, st);
			}
		}
		setLossSite('swift', this, undefined);
		this.declOwner = null;
		if (library && members.length) {
			this.declarations?.type(library, 'enum');
			out.push([`enum ${library} {`, ...members.map((m) => indented(m)), '}'].join('\n'));
		}
		out.push(...this.hoisted.splice(0));
		return { code: out.join('\n\n') + '\n', init };
	},

	/**
	 * A module's (or namespace's) variables: constants and pure initializers
	 * as declared, the rest assigned by the module's initializer in order.
	 */
	variables(this: Translator, st: ts.VariableStatement, emit: (code: string) => void, ref: (d: ts.VariableDeclaration) => string, declName: (d: ts.VariableDeclaration) => string, modifiers: string, later: (code: () => string) => void) {
		const constant = !!(st.declarationList.flags & ts.NodeFlags.Const);
		const field = (code: string, name: string, type: string, throws = false, readonly = false) => {
			emit(code);
			this.declare(name, { kind: 'var', type, mods: modifiers, throws, readonly });
		};
		for (const d of st.declarationList.declarations) {
			if (prototypeAlias(this, d)) continue;
			if (!ts.isIdentifier(d.name)) {
				// An object rest (`const { tag, ...rest } = p`) has the shape of its fields, as bindTo declares it.
				const typeOfBound = (n: ts.Identifier) => (ts.isBindingElement(n.parent) && n.parent.dotDotDotToken && ts.isObjectBindingPattern(n.parent.parent) ? this.shape(this.checker.getTypeAtLocation(n), n.parent) : this.typeOf(n));
				const groups = ts.isArrayBindingPattern(d.name) && /^JSMatch[?!]?$/.test(this.typeOf(d.initializer!));
				for (const n of boundNames(d.name)) {
					const name = this.topName(n.parent, n.text);
					const group = (groups && n.parent.parent === d.name && !(n.parent as ts.BindingElement).initializer && !(n.parent as ts.BindingElement).dotDotDotToken && /^(Double|String|Bool)$/.test(typeOfBound(n))) || this.states.arrayPiece(n.parent as ts.Declaration) || this.states.optionalObjectPiece(n.parent as ts.Declaration);
					const t = this.deferred(group ? this.bindsOptional(n, typeOfBound(n)) : typeOfBound(n));
					field(`${modifiers}var ${ident(name)}: ${t}`, name, t);
				}
				const tmp = this.fresh('__d');
				later(() => `    let ${tmp}${this.destructured(d.name, d.initializer!)}\n${this.bindTo(d.name, tmp, this.patternIterated(d.name, d.initializer!) ? this.iteratedHeld(d.name, d.initializer!) : this.typeOf(d.initializer!), 'assign')}`);
				continue;
			}
			const name = declName(d);
			const target = ref(d);
			const t = this.typeOf(d.name);
			// `var total = 1; var total = total + 2`: the module's one variable, assigned again.
			if (redeclaredVar(d, this.checker)) {
				if (d.initializer) later(() => `    ${target} = ${this.marks.tryBefore(this.tryPrefix(d.initializer!), this.stored(d.initializer!, d, t))}`);
				continue;
			}
			// Lenient code: a string or boolean declared without a value reads undefined until assigned (`let enabled: boolean;`).
			if (!d.initializer && ((this.lenient && (t === 'Bool' || t === 'String')) || (this.lenientApp && !this.library && ['Bool', 'String', 'Double'].includes(t) && this.states.appCode(d)))) {
				const sym = this.resolve(d.name);
				if (sym) this.undefinedVars.set(sym, optionalType(t));
				field(`${modifiers}var ${name}: ${optionalType(t)} = nil`, name, optionalType(t));
				continue;
			}
			if (!d.initializer) {
				field(`${modifiers}var ${name}: ${this.fieldType(t)}`, name, this.fieldType(t));
				continue;
			}
			// A module's memo (`computed(fn)`), read through `x()`: its value.
			const fn = this.framework.memoized(d, this.checker);
			if (fn) {
				const rt = this.computedType(d.initializer as ts.CallExpression);
				const throws = this.throwsInfo.fn(fn);
				const memo = `${name.replace(/`/g, '')}__memo`;
				field(`${modifiers}let ${memo} = ${this.memo(fn, rt, throws)}\n${modifiers}var ${name}: ${rt} ${throws ? `{\n    get throws { try ${memo}.read() }\n}` : `{ ${memo}.value }`}`, name, rt, throws);
				continue;
			}
			const isTdz = !this.library && !modifiers && this.facts.tdzBindings().has(d);
			const emitTdz = (heldType: string, storageDecl: string, assign: (valTarget: string) => string) => {
				const raw = name.replace(/`/g, '');
				const propType = heldType.endsWith('!') ? heldType.slice(0, -1) : heldType;
				const bang = heldType.endsWith('!') ? '!' : '';
				const msg = swiftString(`Cannot access '${d.name.getText()}' before initialization`);
				const backing = `private var __tdz_${raw} = false\nprivate var __val_${raw}: ${storageDecl}`;
				if (constant) {
					field(`${backing}\nvar ${name}: ${propType} {\n    get throws {\n        guard __tdz_${raw} else { throw JSException(JSReferenceError(${msg})) }\n        return __val_${raw}${bang}\n    }\n}`, name, propType, true, true);
				} else {
					field(`${backing}\nfunc __tdz_get_${raw}() throws -> ${propType} {\n    guard __tdz_${raw} else { throw JSException(JSReferenceError(${msg})) }\n    return __val_${raw}${bang}\n}\nfunc __tdz_set_${raw}(_ value: ${propType}) throws {\n    guard __tdz_${raw} else { throw JSException(JSReferenceError(${msg})) }\n    __val_${raw} = value\n}`, name, propType, true);
				}
				later(() => `${assign(`__val_${raw}`)}\n    __tdz_${raw} = true`);
			};
			const maybe = this.heldUndefined(d) ? (this.maybeUndefined(d.initializer) ?? (this.states.optionalVariable(d) ? this.heldStore(d, optionalType(t)) : null)) : null;
			if (maybe) {
				const sym = this.resolve(d.name);
				if (sym) this.undefinedVars.set(sym, optionalType(t));
				if (sym && this.lenientApp && onlyNullOrPresent(d, this.checker, (v) => !ts.isAwaitExpression(v) && this.states.nullResult(v))) this.states.nullVars.add(sym);
				const rhs = () => (this.isAny(d.initializer!) && !isUntyped(spelledType(t)) ? (this.checkedPlacement(d.initializer!, optionalType(t), maybe, this.storeSlot(d.initializer!, optionalType(t), d)) ?? this.fromAny(maybe, optionalType(t))) : this.optionalArrayAs(maybe, this.typeOf(d.initializer!), optionalType(t)));
				if (isTdz) {
					emitTdz(optionalType(t), `${optionalType(t)} = nil`, (v) => `    ${this.tryPrefix(d.initializer!)}${v} = ${rhs()}`);
					continue;
				}
				field(`${modifiers}var ${name}: ${optionalType(t)} = nil`, name, optionalType(t));
				later(() => `    ${this.tryPrefix(d.initializer!)}${target} = ${rhs()}`);
				continue;
			}
			// Given a non-strict app's null-only result later: optional, as that result is.
			if (this.lenientApp && !t.endsWith('?') && !isUntyped(spelledType(t)) && this.zero(t) === null && givenBy(d, this.checker, (v) => !ts.isAwaitExpression(v) && this.states.nullResult(v))) {
				const sym = this.resolve(d.name);
				if (sym) this.undefinedVars.set(sym, optionalType(t));
				if (sym && onlyNullOrPresent(d, this.checker, (v) => !ts.isAwaitExpression(v) && this.states.nullResult(v))) this.states.nullVars.add(sym);
				if (isTdz) {
					emitTdz(optionalType(t), `${optionalType(t)} = nil`, (v) => `    ${v} = ${this.marks.tryBefore(this.tryPrefix(d.initializer!), this.stored(d.initializer!, d, optionalType(t)))}`);
					continue;
				}
				field(`${modifiers}var ${name}: ${optionalType(t)} = nil`, name, optionalType(t));
				later(() => `    ${target} = ${this.marks.tryBefore(this.tryPrefix(d.initializer!), this.stored(d.initializer!, d, optionalType(t)))}`);
				continue;
			}
			// An object variable starting undefined or null holds one later.
			if (!isTdz && isNullish(d.initializer) && !t.endsWith('?') && !isUntyped(spelledType(t)) && this.zero(t) === null) {
				field(`${modifiers}var ${name}: ${this.deferred(t)}`, name, this.deferred(t));
				continue;
			}
			const init = !isTdz && this.pure(d.initializer) && this.constantInit(d.initializer) && !(constant && this.loose(d.initializer)) ? this.storedInit(d.initializer, t, constant, d) : null;
			// A global's initializer cannot throw in Swift.
			if (init !== null && !/^try /.test(init)) {
				field(`${modifiers}${constant ? 'let' : 'var'} ${name}: ${constant ? t : this.lenientRef(t)} = ${init}`, name, constant ? t : this.lenientRef(t), false, constant);
				continue;
			}
			if (isTdz) {
				const ft = this.fieldType(t);
				emitTdz(ft.replace(/ = .*$/, ''), ft, (v) => `    ${v} = ${this.marks.tryBefore(this.tryPrefix(d.initializer!), this.stored(d.initializer!, d, t))}`);
				continue;
			}
			field(`${modifiers}var ${name}: ${this.fieldType(t)}`, name, this.fieldType(t));
			later(() => `    ${target} = ${this.marks.tryBefore(this.tryPrefix(d.initializer!), this.stored(d.initializer!, d, t))}`);
		}
	},

	/**
	 * `namespace N { … }` as `enum N`: its functions and variables are static
	 * members, read as `N.member`; its statements run with the module's.
	 * A namespace that declares only types has no value and no enum.
	 */
	namespaceDecl(this: Translator, md: ts.ModuleDeclaration, name: string, later: (code: () => string) => void): string {
		if (!md.body || !ts.isModuleBlock(md.body)) throw this.error(md, 'a dotted namespace');
		const path = this.namespacePath(md)!;
		const lines: string[] = [];
		let values = false;
		// What throws here leaves the module, whose `module` restores the owner.
		const owner = this.declOwner;
		this.declOwner = path.replace(/^NativeScriptKit\./, '');
		for (const st of md.body.statements) {
			if (hasModifier(st, ts.SyntaxKind.DeclareKeyword)) continue;
			// A namespace's interfaces are the module's: a class of the interface's name.
			if (ts.isInterfaceDeclaration(st)) {
				this.registerInterface(this.topName(st, st.name.text), md.getSourceFile().fileName, this.interfaceMembers(st));
				continue;
			}
			if (ts.isTypeAliasDeclaration(st) && ts.isTypeLiteralNode(st.type)) {
				this.registerInterface(this.topName(st, st.name.text), md.getSourceFile().fileName, st.type.members);
				continue;
			}
			if (ts.isTypeAliasDeclaration(st) && intersectionAliasMembers(st, this.checker)) {
				this.registerInterface(this.topName(st, st.name.text), md.getSourceFile().fileName, intersectionAliasMembers(st, this.checker)!);
				continue;
			}
			if (ts.isTypeAliasDeclaration(st)) continue;
			values = true;
			if (ts.isFunctionDeclaration(st)) {
				if (st.name && st.body) lines.push(this.memberFunc(st, ident(st.name.text), 'static '));
				continue;
			}
			if (ts.isModuleDeclaration(st)) {
				const inner = this.namespaceDecl(st, st.name.text, later);
				// A nested namespace merged into a class (`xml2ui.TemplateParser`): Swift extends a type only at file scope.
				if (inner.startsWith('extension ')) this.hoistedExtensions.push(inner.replace(/^extension \S+/, `extension ${this.namespacePath(st)}`));
				else if (inner) lines.push(inner);
				continue;
			}
			if (ts.isEnumDeclaration(st)) {
				lines.push(this.enumDecl(st));
				continue;
			}
			if (ts.isVariableStatement(st)) {
				this.variables(
					st,
					(code) => lines.push(code),
					(d) => `${path}.${ident(d.name.getText())}`,
					(d) => ident(d.name.getText()),
					'static ',
					later,
				);
				continue;
			}
			if (ts.isClassDeclaration(st)) {
				lines.push(this.classDecl(st));
				if ((this.library || this.appMembersByName) && st.members.some((m) => ts.isAccessor(m) && !isStatic(m))) later(() => this.prototypeAccessors(st));
				// As a module's class: its statics and decorators run once it is defined.
				if ((this.library || this.appMembersByName) && (ts.getDecorators(st)?.length || this.heldAsValue(st))) later(() => this.classDefinition(st));
				else if (!this.library && !this.appMembersByName && this.states.byNameStatics(st)) later(() => this.staticsDeclaration(st) ?? '');
				if (st.members.some((m) => prototypeDecorated(this, m))) later(() => this.fieldDecorators(st) ?? '');
				continue;
			}
			later(() => this.stmt(st));
		}
		this.declOwner = owner;
		if (!values) return '';
		// A namespace merged into a class or enum of its name: the type's static members.
		const merged = (this.checker.getSymbolAtLocation(md.name)?.flags ?? 0) & (ts.SymbolFlags.Class | ts.SymbolFlags.Enum);
		this.declarations?.type(path.replace(/^NativeScriptKit\./, ''), merged ? 'extension' : 'enum');
		const code = [`${merged ? 'extension' : 'enum'} ${ident(name)} {`, ...lines.map((l) => indented(l)), '}'].join('\n');
		if (ts.isModuleBlock(md.parent)) return code;
		const hoisted = this.hoistedExtensions.splice(0);
		return [code, ...hoisted].join('\n');
	},

	/** The type a namespace's members are recorded under (`CoreTypes.AnimationCurve`). */
	namespaceOwner(this: Translator, md: ts.ModuleDeclaration): string | null {
		return this.namespacePath(md)?.replace(/^NativeScriptKit\./, '') ?? null;
	},

	/** The Swift path of a namespace declaration (`CoreTypes.AnimationCurve`). */
	namespacePath(this: Translator, md: ts.ModuleDeclaration): string | null {
		if (!ts.isIdentifier(md.name)) return null;
		const outer = ts.isModuleBlock(md.parent) ? md.parent.parent : null;
		if (outer) return this.marks.pureCode(`${this.namespacePath(outer)}.${ident(md.name.text)}`);
		// Library mode: by the module's name, as a class's member of the same name (View's `layout()`) hides the namespace.
		const own = ident(this.topName(md, md.name.text));
		return this.library && this.appModule ? this.marks.pureCode(`${this.appModule}.${own}`) : own;
	},

	/**
	 * A reference to a namespace's member (`N.member`) or, in library mode, to
	 * a module's function or variable (`<module enum>.name`); null for the rest.
	 */
	qualifiedDecl(this: Translator, decl: ts.Declaration, name: string): string | null {
		if (decl.getSourceFile().isDeclarationFile) return null;
		const statement = ts.isVariableDeclaration(decl) ? decl.parent.parent : decl;
		if (ts.isModuleBlock(statement.parent) && ts.isModuleDeclaration(statement.parent.parent)) {
			const outer = this.namespacePath(statement.parent.parent);
			return outer ? this.marks.pureCode(`${outer}.${ident(name)}`) : null;
		}
		const counterpart = ts.isFunctionDeclaration(statement) && ts.isSourceFile(statement.parent) ? this.library?.counterpart?.(decl.getSourceFile().fileName, name) : null;
		if (counterpart) return this.marks.pureCode(counterpart);
		const library = this.library?.moduleName(decl.getSourceFile().fileName);
		if (library && ts.isSourceFile(statement.parent) && (ts.isFunctionDeclaration(statement) || ts.isVariableStatement(statement))) return this.marks.pureCode(`${library}.${ident(name)}`);
		return null;
	},

	/** `{ name }`'s value: the variable or function it names, qualified as a reference to it is. */
	shorthandValue(this: Translator, p: ts.ShorthandPropertyAssignment): string {
		const sym = this.checker.getShorthandAssignmentValueSymbol(p);
		const target = sym && sym.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(sym) : sym;
		const decl = target?.valueDeclaration;
		if (decl && (ts.isFunctionDeclaration(decl) || (ts.isMethodDeclaration(decl) && isStatic(decl))) && (this.functionDepth === 0 || this.inStoredInit)) this.isolatedInit = true;
		if (isLibDeclaration(decl)) {
			const builtin = target!.name === 'Object' ? 'jsObjectBuiltin' : this.builtinConstructorValue(p.name, decl);
			if (builtin) return builtin;
		}
		return (decl && this.qualifiedDecl(decl, target!.name)) ?? this.marks.pureCode(ident(decl && this.topNames().has(decl) ? this.topNames().get(decl)! : p.name.text));
	},

	/** An app module imported whole (`import * as tests from './x'`), where the name is the module. */
	appModuleOf(this: Translator, e: ts.Identifier): ts.Symbol | null {
		if (this.library || (ts.isPropertyAccessExpression(e.parent) && e.parent.expression === e)) return null;
		const local = this.checker.getSymbolAtLocation(e);
		const target = local && local.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(local) : local;
		const decl = target?.valueDeclaration;
		return target && target.flags & ts.SymbolFlags.ValueModule && decl && ts.isSourceFile(decl) && !decl.isDeclarationFile ? target : null;
	},

	/**
	 * An app module held as a value (`allTests['GLOBALS'] = globalsTests`): an object of its exported values, its functions
	 * callable as script calls them, as script holds a module (a test runner calls each `test…` function it finds by name).
	 */
	moduleValue(this: Translator, e: ts.Identifier): string | null {
		const module = this.appModuleOf(e);
		if (!module) return null;
		const entries: string[] = [];
		for (const exported of this.checker.getExportsOfModule(module)) {
			const sym = exported.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(exported) : exported;
			const decl = sym.valueDeclaration;
			if (!decl || !(sym.flags & ts.SymbolFlags.Value) || sym.flags & ts.SymbolFlags.Class || ts.isSourceFile(decl)) continue;
			// A function another module's of the same name made the program rename (`createTestCase__scroll_view_tests`): by that name.
			const named = this.qualifiedDecl(decl, sym.name) ?? (this.topNames().has(decl) ? identPath(this.topNames().get(decl)!) : ident(sym.name));
			const ref = ts.isModuleDeclaration(decl) ? `${named}.self` : named;
			// A declared function as Swift has it, its optional parameters as emitted.
			const t = this.boxedGeneric(decl, ts.isFunctionDeclaration(decl) && decl.body ? escapingFunction(functionParts(this.functionValueType(decl))!) : this.type(this.checker.getTypeOfSymbolAtLocation(sym, decl), decl));
			// A declared function as a value outside a function body: the initializer holding it runs isolated (`storedInit`).
			const fn = ts.isFunctionDeclaration(decl) && decl.body && !this.takesThis(decl) ? decl : null;
			if (fn && (!this.functionDepth || this.inStoredInit)) this.isolatedInit = true;
			entries.push(`(${swiftString(exported.name)}, ${fn ? this.boxDeclared(ref, fn) : this.convert(ref, t, 'Any?')})`);
		}
		return `JSObject([${entries.join(', ')}])`;
	},

	/** A generic function's type as one value (held untyped): each type parameter its class bound, or any value. */
	boxedGeneric(this: Translator, decl: ts.Declaration | undefined, type: string): string {
		let t = type;
		for (const p of decl && ts.isFunctionDeclaration(decl) ? (decl.typeParameters ?? []).filter((p) => !this.erasesTypeParameter(p)) : []) {
			const c = p.constraint && this.checker.getTypeFromTypeNode(p.constraint);
			const bound = c && (c.getSymbol()?.flags ?? 0) & ts.SymbolFlags.Class ? this.type(c, p) : null;
			t = t.replace(new RegExp(`\\b${p.name.text}\\b([?!]?)`, 'g'), (_, opt: string) => (bound ? bound + opt : 'Any?'));
		}
		return t;
	},

	/** An identifier as a reference to what it names: qualified where its declaration is a namespace's or a library module's. */
	refName(this: Translator, e: ts.Identifier): string {
		// `{ prompt }`: the name's own symbol is the property; the value it reads is the variable or function of that name.
		const local = ts.isShorthandPropertyAssignment(e.parent) && e.parent.name === e ? this.checker.getShorthandAssignmentValueSymbol(e.parent) : this.checker.getSymbolAtLocation(e);
		const target = local && local.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(local) : local;
		const decl = target?.valueDeclaration;
		const owned = !this.library && decl ? this.core.moduleFunction(decl) : null;
		if (owned) return owned;
		return (decl && this.qualifiedDecl(decl, target!.name)) ?? this.unshadowed(e, decl, this.marks.pureCode(identPath(this.declaredName(e))));
	},

	/** A module-level name read inside a namespace, function or block with a binding of the same name: qualified by the app's module. */
	unshadowed(this: Translator, at: ts.Node, decl: ts.Declaration | undefined, name: string): string {
		if (!this.appModule || !decl || ts.isSourceFile(decl)) return name;
		const statement = ts.isVariableDeclaration(decl) ? decl.parent.parent : decl;
		if (!ts.isSourceFile(statement.parent)) return name;
		if (ts.isFunctionDeclaration(decl) && SWIFT_GLOBAL_FUNCTIONS.has(name) && !decl.getSourceFile().isDeclarationFile) return `${this.appModule}.${name}`;
		for (let n: ts.Node | undefined = at.parent; n; n = n.parent) {
			if (ts.isFunctionLike(n) && n.parameters.some((p) => ts.isIdentifier(p.name) && ident(p.name.text) === name && p !== decl)) return `${this.appModule}.${name}`;
			if (ts.isBlock(n) && n.statements.some((st) => ts.isVariableStatement(st) && st.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && ident(d.name.text) === name && d !== decl))) return `${this.appModule}.${name}`;
			// A class's member of the name (`Status = Status`): inside the class, Swift reads the bare name as the member.
			if (ts.isClassLike(n) && n.members.some((m) => m.name && ts.isIdentifier(m.name) && ident(m.name.text) === name)) return `${this.appModule}.${name}`;
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
		// A class's static member or an enum's member, where a namespace merges into the class or enum.
		if (!decl || ts.isClassElement(decl) || ts.isEnumMember(decl)) return null;
		// An enum as a value (`Object.values(Permissions.NSType)`): the object JavaScript makes of it.
		if (ts.isEnumDeclaration(decl) && !hasModifier(decl, ts.SyntaxKind.ConstKeyword) && !(ts.isPropertyAccessExpression(e.parent) && e.parent.expression === e) && !(ts.isElementAccessExpression(e.parent) && e.parent.expression === e)) {
			const path = ts.isModuleBlock(decl.parent) ? `${this.namespacePath(decl.parent.parent)}.${ident(target!.name)}` : identPath(this.topName(decl, target!.name));
			return `${path}.jsEnumObject`;
		}
		if (ts.isClassDeclaration(decl) || ts.isEnumDeclaration(decl)) {
			const own = this.topName(decl, target!.name);
			// A namespace's enum, read from outside it (`PermissionsIOS.Status.Authorized`): by the namespace's path.
			return ts.isModuleBlock(decl.parent) && !own.includes('.') ? `${this.namespacePath(decl.parent.parent)}.${ident(own)}` : identPath(own);
		}
		if (ts.isModuleDeclaration(decl)) return this.namespacePath(decl);
		return this.qualifiedDecl(decl, target!.name) ?? this.unshadowed(e, decl, this.marks.pureCode(ident(this.topName(decl, target!.name))));
	},

	/** Whether evaluating `e` early (Swift initializes globals lazily) cannot be observed. */
	pure(this: Translator, e: ts.Expression): boolean {
		// Lenient code's missing object where Swift needs one throws.
		if (this.lenient && this.loose(e) && !this.looseTolerated(e)) return false;
		if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) return this.pure(e.expression);
		if (ts.isLiteralExpression(e) || ts.isNoSubstitutionTemplateLiteral(e) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(e.kind)) return true;
		if (ts.isIdentifier(e) || ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return true;
		if (ts.isTemplateExpression(e)) return e.templateSpans.every((s) => this.pure(s.expression));
		// A spread reads what the array holds when it runs.
		if (ts.isArrayLiteralExpression(e)) return e.elements.every((x) => (ts.isSpreadElement(x) ? ts.isArrayLiteralExpression(x.expression) && this.pure(x.expression) : this.pure(x)));
		if (ts.isObjectLiteralExpression(e)) return e.properties.every((p) => (ts.isPropertyAssignment(p) ? this.pure(p.initializer) && (!ts.isComputedPropertyName(p.name) || this.pure(p.name.expression)) : ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p)));
		if (ts.isPrefixUnaryExpression(e)) return e.operator !== ts.SyntaxKind.PlusPlusToken && e.operator !== ts.SyntaxKind.MinusMinusToken && this.pure(e.operand);
		if (ts.isBinaryExpression(e)) return e.operatorToken.kind !== ts.SyntaxKind.EqualsToken && this.pure(e.left) && this.pure(e.right);
		// Reading a member of an untyped value can throw.
		if (ts.isPropertyAccessExpression(e)) return this.pure(e.expression) && !this.isAny(e.expression) && this.looseReceiverKey(e.expression) === null;
		if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && this.framework.pure(e.expression.text) && !!this.resolve(e.expression)?.declarations?.every((d) => d.getSourceFile().isDeclarationFile)) return e.arguments.every((a) => this.pure(a));
		if (ts.isNewExpression(e) && ts.isIdentifier(e.expression) && ['Map', 'Set'].includes(e.expression.text)) return !e.arguments?.length || e.arguments.every((a) => this.pure(a));
		return false;
	},

	/** A class the program's interfaces and object types are made into (with `init(jsObject:)`), not a protocol. */
	structuralFacts(this: Translator): StructuralFacts {
		return { shape: (n) => this.isObjectShape(n), extends: (a, b) => !!this.classNamed(a) && this.sourceExtends(a, b) };
	},

	isObjectShape(this: Translator, name: string): boolean {
		return (this.interfaces.has(name) && !this.protocols.has(name)) || !!this.shapes.named(name) || (!this.library && this.core.viewable(name));
	},

	/** An interface's members with those of the interfaces it extends (`StageFold extends Rect`), its own first. */
	interfaceMembers(this: Translator, decl: ts.InterfaceDeclaration): readonly ts.TypeElement[] {
		if (!decl.heritageClauses?.length) return decl.members;
		const sym = decl.name && this.checker.getSymbolAtLocation(decl.name);
		const all = sym
			? this.checker
					.getDeclaredTypeOfSymbol(sym)
					.getProperties()
					.flatMap((p) => p.declarations?.filter((d): d is ts.TypeElement => ts.isPropertySignature(d) || ts.isMethodSignature(d)).slice(0, 1) ?? [])
			: [];
		return [...decl.members, ...all.filter((m) => m.parent !== decl)];
	},

	registerInterface(this: Translator, name: string, file: string, members: readonly ts.TypeElement[]) {
		if (this.protocols.has(name)) {
			this.interfaces.set(name, { file, code: () => this.protocolCode(name, members) });
			return;
		}
		if (members.some((m) => !!m.name && ts.isComputedPropertyName(m.name))) this.unviewable.add(name);
		this.interfaces.set(name, { file, code: () => this.objectClass(name, this.interfaceFields(members), null) });
	},

	/** An object type's fields: its properties, and its methods as fields holding functions. */
	interfaceFields(this: Translator, members: readonly ts.TypeElement[]): ShapeField[] {
		const out: ShapeField[] = [];
		for (const m of members) {
			const keyed = (ts.isPropertySignature(m) || ts.isMethodSignature(m)) && programSymbolKey(m.name, this.checker);
			const known = (ts.isPropertySignature(m) || ts.isMethodSignature(m)) && !keyed && this.symbolMemberName(m.name);
			if (known) {
				if (!out.some((f) => f.name === known)) out.push({ name: known, type: this.typeOf(m), symbol: true });
				continue;
			}
			if (keyed) {
				if (!out.some((f) => f.name === keyed.member)) out.push({ name: keyed.member, type: m.questionToken ? optionalType(this.typeOf(m)) : this.typeOf(m), symbol: true, key: `${this.expr(keyed.key)}.key` });
				continue;
			}
			if (!(ts.isPropertySignature(m) || ts.isMethodSignature(m)) || !(ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))) continue;
			if (out.some((f) => f.name === (m.name as ts.Identifier).text)) continue;
			const t = this.resultFieldType(m) ?? this.typeOf(m);
			out.push({ name: (m.name as ts.Identifier).text, type: m.questionToken ? optionalType(t) : t });
		}
		return out;
	},

	/** A field of a result interface of core's (`resultShapesOf`) as the kit's class holds it: any value where core gives one untyped. */
	resultFieldType(this: Translator, m: ts.TypeElement): string | null {
		const owner = m.parent;
		if (!ts.isInterfaceDeclaration(owner) || !m.name || !(ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))) return null;
		if (this.library) {
			const sym = this.checker.getSymbolAtLocation(owner.name);
			return sym && this.library.resultShapes?.get(sym)?.has(m.name.text) ? 'Any?' : null;
		}
		return isCoreDeclaration(owner) && this.core.viewable(owner.name.text) ? (this.core.kitMember(owner.name.text, m.name.text)?.type ?? null) : null;
	},

	/** An interface classes implement: a protocol, and `<Name>Object` for the object literals of its type. */
	implementedReadOnly(this: Translator, iface: string, field: string): boolean {
		let found = false;
		const visit = (n: ts.Node) => {
			if (found) return;
			if (ts.isClassDeclaration(n) && (n.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ImplementsKeyword && h.types.some((x) => this.heritageName(x) === iface)) || [...(this.structural.get(n) ?? [])].some((d) => this.topName(d, d.name.text) === iface))) {
				const accessors = n.members.filter((x): x is ts.AccessorDeclaration => ts.isAccessor(x) && x.name.getText() === field);
				if (accessors.length && accessors.every(ts.isGetAccessorDeclaration)) found = true;
			}
			ts.forEachChild(n, visit);
		};
		for (const sf of this.sourceFiles) if (!sf.isDeclarationFile) visit(sf);
		return found;
	},

	protocolCode(this: Translator, name: string, members: readonly ts.TypeElement[]): string {
		const fields = members.filter(ts.isPropertySignature).map((m) => {
			const t = this.typeOf(m);
			// A field a class implementing the interface has only a getter for is read-only through it.
			const own = (m.name as ts.Identifier).text;
			return { name: own, type: m.questionToken ? optionalType(t) : t, readonly: hasModifier(m, ts.SyntaxKind.ReadonlyKeyword) || this.implementedReadOnly(name, own) };
		});
		const methods = members.filter(ts.isMethodSignature).map((m) => {
			const params = m.parameters.map((p, k) => ({ name: ts.isIdentifier(p.name) ? ident(p.name.text) : `p${k}`, type: this.requirementParamType(p) }));
			// Lenient code's classes return an object implicitly unwrapped, as the requirement they meet must.
			const saved = this.currentFile;
			this.currentFile = m.getSourceFile().fileName;
			try {
				const ret = this.returnTypeOf(m);
				const methodName = protocolMethodName(m.name, this.checker, ident);
				return { name: methodName, key: m.name.getText(), params, ret: ret === 'Void' ? ret : this.lenientRef(ret) };
			} finally {
				this.currentFile = saved;
			}
		});
		const signature = (m: (typeof methods)[0]) => `func ${m.name}(${m.params.map((p) => `_ ${p.name}: ${isFunctionType(p.type) ? `@escaping ${p.type}` : p.type}`).join(', ')}) throws${m.ret === 'Void' ? '' : ` -> ${m.ret}`}`;
		const fnType = (m: (typeof methods)[0]) => `(${m.params.map((p) => p.type).join(', ')}) throws -> ${m.ret.replace(/!$/, '?')}`;
		const lines = [`protocol ${name}: JSDynamic {`];
		const params = (m: (typeof methods)[0]) => m.params.map((p) => `_ ${p.name}: ${isFunctionType(p.type) ? `@escaping ${p.type}` : p.type}`).join(', ');
		const requirements = (owner: string) => {
			for (const f of fields) this.declare(f.name, { kind: 'var', type: f.type }, owner);
			for (const m of methods) this.declare(m.name, { kind: 'func', params: params(m), throws: true, type: m.ret }, owner);
		};
		this.declaring(name, 'protocol', null, () => requirements(name));
		for (const f of fields) lines.push(`    var ${ident(f.name)}: ${f.type} { get${f.readonly ? '' : ' set'} }`);
		for (const m of methods) lines.push(`    ${signature(m)}`);
		lines.push('}', '');
		const literal = this.objectClass(`${name}Object`, [...fields, ...methods.map((m) => signatureField(m.key, fnType(m)))], null)
			.replace(/^final class (\w+): JSDynamic((?:, \w+)*) \{/, `final class $1: ${name}$2 {`)
			.replace(/\n}$/, '\n' + methods.map((m) => `    ${signature(m)} { try ${this.lenient ? `${RT.jsCallable}(${ident(methodSlot(m.key))}, ${swiftString(m.name)})` : ident(methodSlot(m.key))}(${m.params.map((p) => p.name).join(', ')}) }`).join('\n') + '\n}');
		this.declaring(`${name}Object`, 'class', null, () => {
			for (const m of methods) this.declare(m.name, { kind: 'func', params: params(m), throws: true, type: m.ret });
		});
		return lines.join('\n') + literal;
	},

	/** The classes for a module's interfaces that translated code used; call after translating everything. */
	interfacesOf(this: Translator, file: string): string {
		let out = '';
		const emitted = new Set<string>();
		// An interface's own fields can use another one.
		for (let more = true; more;) {
			more = false;
			for (const [name, decl] of this.interfaces) {
				if (decl.file !== file || emitted.has(name) || !this.used.has(name)) continue;
				out = decl.code() + '\n\n' + out;
				emitted.add(name);
				more = true;
			}
		}
		return out;
	},

	/** The interfaces the code uses that files the build leaves out declare (a plugin's `RenderingContext`, implemented elsewhere). */
	interfacesOutside(this: Translator, files: ReadonlySet<string>): string {
		let out = '';
		const emitted = new Set<string>();
		for (let more = true; more;) {
			more = false;
			for (const [name, decl] of this.interfaces) {
				if (files.has(decl.file) || emitted.has(name) || !this.used.has(name)) continue;
				out = decl.code() + '\n\n' + out;
				emitted.add(name);
				more = true;
			}
		}
		return out;
	},

	/**
	 * `NativeClass.extend({ method() {…} }, { protocols: [P] })`, as NativeScript's runtime makes a native
	 * subclass at run time: a Swift subclass conforming to the protocols, one per call site, whose
	 * implementations of the protocols' (and the base's) methods call the object's methods with the instance as `this`.
	 */
	extendCall(this: Translator, e: ts.CallExpression): string | null {
		const callee = e.expression;
		if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'extend' || !e.arguments[0] || !ts.isObjectLiteralExpression(e.arguments[0])) return null;
		let base: ts.Expression = callee.expression;
		while (ts.isParenthesizedExpression(base) || ts.isAsExpression(base) || ts.isTypeAssertionExpression(base)) base = base.expression;
		if (!ts.isIdentifier(base)) return null;
		const baseClass = this.nativeClassNamed(base.text, 'class');
		if (!baseClass) return null;
		const options = e.arguments[1] && ts.isObjectLiteralExpression(e.arguments[1]) ? e.arguments[1] : null;
		const listed = options?.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === 'protocols')?.initializer;
		const protocols = (listed && ts.isArrayLiteralExpression(listed) ? listed.elements : []).map((x) => (ts.isIdentifier(x) ? this.nativeClassNamed(x.text, 'protocol') : null));
		if (protocols.some((p) => !p)) throw this.error(listed!, 'a protocol of Cls.extend that is no native protocol');
		const methods = e.arguments[0].properties.flatMap((p) => ((ts.isMethodDeclaration(p) || (ts.isPropertyAssignment(p) && (ts.isFunctionExpression(p.initializer) || ts.isArrowFunction(p.initializer)))) && p.name ? [p.name.getText()] : []));
		const name = `__Extended_${this.extendedClasses.length}`;
		const members: string[] = [];
		const declared: [string, RecordedMember][] = [['jsMethods', { kind: 'var', type: 'Any?' }]];
		for (const m of methods) {
			const found = [...protocols.map((p) => ({ module: p!.module, js: p!.js })), { module: baseClass.module, js: baseClass.js }].map((owner) => lookupMember(owner.module, owner.js, m, false)).find((x): x is NativeMethod => !!x && x.kind === 'method');
			if (!found) continue;
			const params = found.params.map((t, k) => `${found.labels[k] ?? '_'} __a${k}: ${t}`).join(', ');
			declared.push([found.swift, { kind: 'func', params, type: found.returns }]);
			const call = this.marks.tryCode(`${RT.jsCallExtended}(self, jsMethods, ${swiftString(m)}, [${found.params.map((_, k) => `${RT.jsFromNative}(__a${k})`).join(', ')}])`);
			const result = found.returns === 'Void' ? `${RT.jsReport} { _ = ${call} }` : `return ${RT.jsReported} { ${nativeResult(call, found.returns)} } ?? ${nativeZero(found.returns)}`;
			members.push(
				`    @objc nonisolated func ${found.swift}(${params})${found.returns === 'Void' ? '' : ` -> ${found.returns}`} { ${enteredGuard(found.swift, found.labels, found.params, found.returns, '', found.escaping)}; ${onMainThread(
					result,
					found.returns,
					'',
					found.params.map((_, k) => `__a${k}`),
					found.params.map((p, k) => (found.escaping?.includes(k) ? `@escaping ${p}` : p)),
				)} }`,
			);
		}
		this.extendedRecords.push({ name, base: baseClass.swift, members: declared });
		this.extendedClasses.push(`@MainActor final class ${name}: ${[baseClass.swift, ...protocols.map((p) => p!.swift)].join(', ')} {
${NONISOLATED_DEINIT}
    var jsMethods: Any?
${members.join('\n')}
}`);
		const literal = this.coerce(e.arguments[0], 'Any?');
		return `{ () ${this.throwsInfo.expr(e.arguments[0]) ? 'throws ' : ''}-> JSExtendedClass in let __methods: Any? = ${this.tryPrefix(e.arguments[0])}${literal}; return JSExtendedClass { let o = ${name}(); o.jsMethods = __methods; return o } }()`;
	},

	/** A native class or protocol of the plugins' modules or the SDK, by its Objective-C name. */
	nativeClassNamed(this: Translator, js: string, kind: 'class' | 'protocol'): { js: string; swift: string; module: string } | null {
		for (const m of [...this.pluginModules, 'Foundation', 'UIKit', 'ObjectiveC']) {
			const c = lookupClass(m, js);
			if (c && c.kind === kind) return { js, swift: c.swift, module: c.module };
		}
		return null;
	},

	/** Classes for object types without a name, and with `cells` the function cells (`cellsCode`). */
	shapesCode(this: Translator, cells = true): string {
		const shapes = [...this.shapes.values()].map((s) => this.objectClass(s.name, s.fields, null));
		for (const x of this.extendedRecords)
			this.declaring(x.name, 'class', x.base, () => {
				for (const [n, m] of x.members) this.declare(n, m);
			});
		for (const [alias, type] of this.globalAliasTypes) this.declarations?.global(alias, { kind: 'var', type });
		for (const site of this.templateSites) this.declarations?.global(site, { kind: 'var', type: 'JSArray<String>' });
		return [...shapes, ...this.globalAliases.values(), ...this.templateObjects, ...this.extendedClasses, ...(cells ? this.cellsCode().map((c) => c.code) : [])].join('\n\n');
	},

	/** The struct of each function type's cell, with the number of parameters the type takes. After `shapesCode`, whose classes can add cells. */
	cellsCode(this: Translator): { params: number; code: string }[] {
		// `implicit`: `jsImplicit` of the cell's function type, not the generic one, which would hand back a new thunk.
		const needs = (type: string) => Math.max(0, ...[...this.gatedTypes].filter(([n]) => new RegExp(`\\b${n.replace(/\./g, '\\.')}\\b`).test(type)).map(([, v]) => v));
		return [...this.functionCells].map(([type, name]) => ({
			params: this.declaring(
				name,
				'struct',
				null,
				() => {
					this.declare('f', { kind: 'var', type });
					this.declare('implicit', { kind: 'func', mods: 'static ', params: `_ value: (${type})?`, type: `(${type})?` });
					this.declare('present', { kind: 'func', mods: 'static ', params: `_ value: (${type})?`, throws: true, type });
					return functionParts(type)?.params.length ?? 0;
				},
				needs(type) || undefined,
			),
			code: `${needs(type) ? `@available(iOS ${needs(type)}, *)\n` : ''}struct ${name}${this.cellGenerics(type)} {\n    let f: ${type}\n    static func implicit(_ value: (${type})?) -> (${type})? { value }\n    static func present(_ value: (${type})?) throws -> ${type} { guard let value else { throw ${RT.jsNoObject}() }; return value }\n${this.cellStaticCode(name, type, needs)
				.map((l) => l + '\n')
				.join('')}}`,
		}));
	},
	/** The type parameters `type` names, in the order it names them. */
	typeParameters(this: Translator, type: string): string[] {
		const at = (g: string) => type.search(new RegExp(`\\b${g}\\b`));
		return [...this.genericNames].filter((g) => at(g) >= 0).sort((a, b) => at(a) - at(b));
	},
	/** A cell's generic parameter clause (`<T, U>`), or ''. */
	cellGenerics(this: Translator, type: string): string {
		const used = this.typeParameters(type);
		return used.length ? `<${used.join(', ')}>` : '';
	},

	/**
	 * The name of a static member of `cell` doing `kind` with `body`: the conversions it writes depend on the
	 * translated code's mode (lenient or not), so each distinct body is a member of its own, the first by the plain name.
	 * An adapter takes a function of type `from`: adapters from different types overload one name.
	 */
	cellStatic(this: Translator, cell: string, kind: CellStatic, body: string, from?: string, orNil = false): string {
		const statics = this.cellStatics.get(cell) ?? [];
		this.cellStatics.set(cell, statics);
		const same = statics.find((x) => x.kind === kind && x.body === body && x.from === from);
		if (same) {
			same.orNil ||= orNil;
			return same.name;
		}
		const rivals = statics.filter((x) => x.from === from);
		const base = rivals.some((x) => x.kind === kind) ? `${this.lenient ? 'lenient' : 'strict'}${kind[0].toUpperCase()}${kind.slice(1)}` : kind;
		let name = base;
		for (let k = 2; rivals.some((x) => x.name === name); k++) name = `${base}${k}`;
		statics.push({ kind, name, body, from, orNil });
		return name;
	},

	/** A function cell's static members, as `shapesCode` writes them into its struct. */
	cellStaticCode(this: Translator, cell: string, type: string, needs: (type: string) => number): string[] {
		const declare = (name: string, params: string, result: string, available = 0) => this.declare(name, { kind: 'func', mods: 'static ', params, type: result, available: available || undefined }, cell);
		for (const { kind, name, from, orNil } of this.cellStatics.get(cell) ?? []) {
			const gate = from && needs(from) > needs(type) ? needs(from) : 0;
			if (kind === 'adapting') {
				declare(name, `_ __h: @escaping ${from}`, type, gate);
				if (orNil) declare(`${name}OrNil`, `_ __h: (${from})?`, `(${type})?`, gate);
			}
			if (kind === 'fromScript') {
				declare(name, '_ __f: Any?', type);
				declare(`${name}OrNil`, '_ __f: Any?', `(${type})?`);
			}
			if (kind === 'script') {
				declare(name, `_ name: String, _ length: Int, _ __f: @escaping ${type}`, 'JSFunctionObject');
				declare(`${name}OrNil`, `_ name: String, _ length: Int, _ __f: (${type})?`, 'JSFunctionObject?');
			}
			if (kind === 'declared') declare(name, `_ id: String, _ __h: @escaping ${type}`, type);
			if (kind === 'local') declare(name, `_ __d: JSFunctionDeclaration, _ __h: @escaping ${type}`, type);
		}
		return (this.cellStatics.get(cell) ?? []).flatMap(({ kind, name, body, from, orNil }) => {
			switch (kind) {
				case 'adapting': {
					const gate = from && needs(from) > needs(type) ? `    @available(iOS ${needs(from)}, *)\n` : '';
					return [`${gate}    static func ${name}(_ __h: @escaping ${from}) -> ${type} { ${body} }`, ...(orNil ? [`${gate}    static func ${name}OrNil(_ __h: (${from})?) -> (${type})? { if let __h { return ${name}(__h) } else { return nil } }`] : [])];
				}
				case 'fromScript':
					return [`    static func ${name}(_ __f: Any?) -> ${type} { ${body} }`, `    static func ${name}OrNil(_ __f: Any?) -> (${type})? { ${RT.jsIsNullish}(__f) ? nil : ${name}(__f) }`];
				case 'script':
					return [`    static func ${name}(_ name: String, _ length: Int, _ __f: @escaping ${type}) -> JSFunctionObject { ${body} }`, `    static func ${name}OrNil(_ name: String, _ length: Int, _ __f: (${type})?) -> JSFunctionObject? { if let __f { return ${name}(name, length, __f) } else { return nil } }`];
				case 'declared':
					return [`    static func ${name}(_ id: String, _ __h: @escaping ${type}) -> ${type} { ${body} }`];
				case 'local':
					return [`    static func ${name}(_ __d: JSFunctionDeclaration, _ __h: @escaping ${type}) -> ${type} { ${body} }`];
			}
		});
	},
	/**
	 * The struct of one field of function type `type`, through which the runtime reads a closure's
	 * identity (`jsFunctionKey`). A type naming type parameters gets a struct generic over them, written
	 * unspecialized at each use (Swift infers them there).
	 */
	functionCell(this: Translator, type: string): string | null {
		// `JSRest<T>` is `JSArray<T>`: one Swift type, one cell (and one `jsImplicit` overload).
		const t = type.trim().replace(/\bJSRest</g, 'JSArray<');
		if (!functionParts(t)) return null;
		let name = this.functionCells.get(t);
		if (!name) {
			// Named after the function type it holds (`FunctionCell_ViewBaseOpt_to_Void` for `(ViewBase?) throws -> Void`).
			const fn = functionParts(t);
			const part = (x: string) =>
				x
					.replace(/@escaping\s+/g, '')
					.replace(/\bthrows\b/g, '')
					.replace(/\?/g, 'Opt')
					.replace(/!/g, '')
					.replace(/->/g, ' to ')
					.replace(/[^A-Za-z0-9]+/g, '_')
					.replace(/^_+|_+$/g, '');
			const base = fn ? `FunctionCell_${fn.params.map(part).join('_') || 'none'}_to_${part(fn.result)}` : `FunctionCell_${part(t)}`;
			const taken = new Set(this.functionCells.values());
			name = base;
			for (let k = 2; taken.has(name); k++) name = `${base}_${k}`;
			this.functionCells.set(t, name);
		}
		return name;
	},

	/**
	 * A shape's field as its class holds it. The classes are written after every module, as no file's code: lenient
	 * only in the kit, where a field of an object or function type holds null too (`{ completion: null, ...options }`).
	 */
	shapeHeld(this: Translator, f: { type: string; symbol?: boolean }): string {
		if (f.symbol) return f.type;
		if (this.lenientAll) return isFunctionType(f.type) ? `(${f.type})?` : this.nullableRef(f.type);
		// An app's object field holds undefined too, as a literal asserted to the type may give it (`{ …, view } as
		// ItemEventData` before the view exists); a read that uses it unwraps it there.
		return !this.library && !isOptional(f.type) && !f.type.endsWith('!') && !isFunctionType(f.type) && this.nullableRef(f.type) !== f.type ? `${f.type}!` : f.type;
	},
	membersWritten(this: Translator): Set<string> {
		return this.facts.assignedMembers();
	},

	/** A plain JavaScript object of a known shape: a final class with a memberwise init, readable as a dynamic object. */
	objectClass(this: Translator, name: string, allFields: ShapeField[], className: string | null): string {
		return this.declaring(name, 'class', null, () => {
			const saved = this.inShape;
			this.inShape = true;
			try {
				return this.unshadowedTypes(this.objectClassCode(name, allFields, className), allFields);
			} finally {
				this.inShape = saved;
			}
		});
	},

	/** Inside a shape's class, a field named as a class (`{ TouchAnimationsModel }`) hides the class's name in an expression (`X.Type.self`): qualified by the module. */
	unshadowedTypes(this: Translator, code: string, fields: ShapeField[]): string {
		if (!this.appModule) return code;
		return fields.reduce((c, f) => (/^[A-Za-z_]\w*$/.test(f.name) ? c.replace(new RegExp(`(?<![\\w."])${f.name}\\.Type\\.self\\b`, 'g'), `${this.appModule}.${f.name}.Type.self`) : c), code);
	},
	/** `code`'s object as the shape class `name`: the one view of it, or in library code and for a class written without a view mode, a new object read from its keys. */
	viewOf(this: Translator, name: string, code: string): string {
		if ((this.library && !resultShapeNamed(this, name)) || this.unviewable.has(name) || (this.shapesWritten.has(name) && !this.viewed.has(name))) return `${name}(jsObject: ${code})`;
		this.viewed.add(name);
		return `${name}.jsView(${code})`;
	},
};
