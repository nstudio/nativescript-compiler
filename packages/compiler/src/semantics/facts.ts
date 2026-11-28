// Whole-program answers both backends read, each computed once for a program's checker, the files translated with it
// and the scope they are translated in (library or app mode, the plugin files), and shared by every translator given the
// same three. A backend asks these and never caches a whole-program answer of its own.
import ts from 'typescript';
import { definitelyAssignedFields, isArguments, classesHeldUntyped } from './lang.ts';
import { baseMethod, declaringMethod, literalClassOf, programBase, rootMethod, shapesClassOf } from './classes.ts';
import { expandoRootsOf, instanceKeysOf, isShapeInterfaceDecl } from './shapes.ts';
import { hasModifier, resolveSymbol } from './ast.ts';
import { isStatic } from './throws.ts';
import { assignedMembers } from './sharing.ts';
import { cyclicModuleBindings } from './tdz.ts';
import { TRACING, traceClass, traceProgram } from './decision-trace.ts';

/** The scope a program's files are translated in: what of a translator's config the whole-program answers depend on. */
export interface FactsScope {
	/** Library mode, with the files it compiles as modules (`moduleName` non-null); null for an app. */
	readonly library: { moduleName?(file: string): string | null } | null;
	/** Files of the plugins compiled from source. */
	readonly pluginFiles: ReadonlySet<string>;
}

/** By checker, files and mode (the library's object, or `APP`), then by the plugin files: two scopes of one key give the same answers. */
const all = new WeakMap<ts.TypeChecker, WeakMap<readonly ts.SourceFile[], WeakMap<object, Map<string, ProgramFacts>>>>();
const APP = {};

/** A method's family: its root's class and its name, which every override shares. */
function methodFamily(m: ts.MethodDeclaration, checker: ts.TypeChecker): string {
	let root = m;
	for (let b = baseMethod(root, checker); b; b = baseMethod(root, checker)) root = b;
	return `${root.getSourceFile().fileName}:${root.parent.pos}:${root.name.getText()}`;
}

export class ProgramFacts {
	private names: { names: Set<string>; fragments: string[] } | null = null;
	private readonly definite = new Map<ts.ClassLikeDeclaration, Set<ts.PropertyDeclaration>>();
	private functionObjects: Set<ts.Node> | null = null;
	private classList: ts.ClassLikeDeclaration[] | null = null;
	private readonly argumentsReaders = new Map<ts.Node, boolean>();
	private written: Set<ts.Declaration> | null = null;
	private assignedNames: Set<string> | null = null;
	private instanceKeySet: Set<ts.MethodDeclaration> | null = null;
	private undeclaredRoots: Set<ts.ClassLikeDeclaration> | null = null;
	private openFieldsClass: ts.ClassLikeDeclaration | null | undefined = undefined;
	private literalTargets: Set<ts.ClassDeclaration> | null = null;
	private nonVirtualMethods: Set<ts.MethodDeclaration> | null = null;
	private argumentsFamilySet: Set<string> | null = null;
	private overrideMap: Map<ts.MethodDeclaration, ts.MethodDeclaration[]> | null = null;
	private familyMap: Map<ts.MethodDeclaration, ts.MethodDeclaration[]> | null = null;
	private protoKeys: { data: Set<string>; accessors: Set<string> } | null = null;
	private protoClasses: Set<ts.ClassDeclaration> | null = null;
	private tdzSet: ReadonlySet<ts.VariableDeclaration> | null = null;
	private ifaceDecls: (ts.InterfaceDeclaration | ts.TypeAliasDeclaration)[] | null = null;
	private readonly ifaceNamesByTop = new WeakMap<object, Set<string>>();

	/** All interface / object-shape type alias declarations across the program's source files. */
	interfaceDecls(): readonly (ts.InterfaceDeclaration | ts.TypeAliasDeclaration)[] {
		if (this.ifaceDecls) return this.ifaceDecls;
		const out: (ts.InterfaceDeclaration | ts.TypeAliasDeclaration)[] = [];
		const visit = (n: ts.Node) => {
			if (isShapeInterfaceDecl(n) && !(this.checker.getSymbolAtLocation(n.name)?.flags! & ts.SymbolFlags.Class)) out.push(n);
			ts.forEachChild(n, visit);
		};
		for (const f of this.files) visit(f);
		return (this.ifaceDecls = out);
	}

	/** Whether `name` is an interface registered in `interfaces` or declared anywhere in `this.files` under `owner`'s top-level naming. */
	hasInterface(owner: object, interfaces: ReadonlyMap<string, unknown>, topName: (decl: ts.Node, name: string) => string, name: string): boolean {
		if (interfaces.has(name)) return true;
		let set = this.ifaceNamesByTop.get(owner);
		if (!set) {
			set = new Set(this.interfaceDecls().map((n) => topName(n, n.name.text)));
			this.ifaceNamesByTop.set(owner, set);
		}
		return set.has(name);
	}

	private readonly checker: ts.TypeChecker;
	private readonly files: readonly ts.SourceFile[];
	private readonly scope: FactsScope;

	private constructor(checker: ts.TypeChecker, files: readonly ts.SourceFile[], scope: FactsScope) {
		this.checker = checker;
		this.files = files;
		this.scope = scope;
		if (TRACING) traceProgram(checker, files);
	}

	/** The facts of the program `checker` checks, as `files` are translated in `scope`. */
	static of(checker: ts.TypeChecker, files: readonly ts.SourceFile[], scope: FactsScope): ProgramFacts {
		let byFiles = all.get(checker);
		if (!byFiles) all.set(checker, (byFiles = new WeakMap()));
		let byMode = byFiles.get(files);
		if (!byMode) byFiles.set(files, (byMode = new WeakMap()));
		const mode = scope.library ?? APP;
		let byPlugins = byMode.get(mode);
		if (!byPlugins) byMode.set(mode, (byPlugins = new Map()));
		const key = [...scope.pluginFiles].sort().join('\0');
		let facts = byPlugins.get(key);
		if (!facts) byPlugins.set(key, (facts = new ProgramFacts(checker, files, scope)));
		return facts;
	}

	/** Whether code could reach a member of this name: read by name, or built from a string (`this[side + 'LayoutChanged']`). */
	isNamed(member: string): boolean {
		if (!this.names) {
			const names = new Set<string>();
			const fragments = new Set<string>();
			for (const sf of this.files) {
				const visit = (n: ts.Node) => {
					if (ts.isPropertyAccessExpression(n)) names.add(n.name.text);
					if (ts.isIdentifier(n) && !ts.isMethodDeclaration(n.parent)) names.add(n.text);
					if (ts.isStringLiteralLike(n)) {
						names.add(n.text);
						if (n.text.length >= 4) fragments.add(n.text);
					}
					ts.forEachChild(n, visit);
				};
				visit(sf);
			}
			this.names = { names, fragments: [...fragments] };
		}
		const { names, fragments } = this.names;
		return names.has(member) || fragments.some((f) => member.startsWith(f) || member.endsWith(f));
	}

	/** The classes the program's source declares, in source order. */
	classes(): ts.ClassLikeDeclaration[] {
		if (this.classList) return this.classList;
		const list: ts.ClassLikeDeclaration[] = [];
		const visit = (n: ts.Node) => {
			if (ts.isClassLike(n)) list.push(n);
			ts.forEachChild(n, visit);
		};
		for (const sf of this.files) if (!sf.isDeclarationFile) visit(sf);
		return (this.classList = list);
	}

	/** Whether a function's own body reads its `arguments` (not an inner function's that has its own). */
	readsOwnArguments(fn: ts.SignatureDeclaration): boolean {
		if (!('body' in fn) || !fn.body || ts.isArrowFunction(fn)) return false;
		let found = this.argumentsReaders.get(fn);
		if (found !== undefined) return found;
		found = false;
		const visit = (n: ts.Node) => {
			if (found || (n !== fn.body && ts.isFunctionLike(n) && !ts.isArrowFunction(n)) || ts.isClassLike(n)) return;
			if (ts.isIdentifier(n) && isArguments(n, this.checker)) found = true;
			ts.forEachChild(n, visit);
		};
		visit(fn.body);
		this.argumentsReaders.set(fn, found);
		return found;
	}

	/** The declarations of the members the program's code assigns, increments or decrements anywhere (`this.navigator.tabView = view`). */
	writtenMembers(): Set<ts.Declaration> {
		if (this.written) return this.written;
		const out = new Set<ts.Declaration>();
		const note = (target: ts.Expression) => {
			if (ts.isPropertyAccessExpression(target)) for (const d of this.checker.getSymbolAtLocation(target.name)?.declarations ?? []) out.add(d);
		};
		const visit = (n: ts.Node): void => {
			if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) note(n.left);
			else if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) note(n.operand);
			ts.forEachChild(n, visit);
		};
		for (const f of this.files) if (!f.isDeclarationFile) visit(f);
		return (this.written = out);
	}

	definiteFields(cls: ts.ClassLikeDeclaration): Set<ts.PropertyDeclaration> {
		let set = this.definite.get(cls);
		if (!set) this.definite.set(cls, (set = definitelyAssignedFields(cls)));
		return set;
	}

	/**
	 * Function-typed fields script reads as function objects (`entry.testFunc.length`, `.apply(…)`, `.call(…)`), with the
	 * fields of that name the interfaces and classes they implement or extend, and those implementing or extending them,
	 * declare.
	 */
	functionObjectFields(): Set<ts.Node> {
		if (this.functionObjects) return this.functionObjects;
		const held = new Set<ts.PropertyDeclaration | ts.PropertySignature>();
		this.functionObjects = held;
		const field = (d: ts.Node | undefined): d is ts.PropertyDeclaration | ts.PropertySignature => !!d && (ts.isPropertyDeclaration(d) || ts.isPropertySignature(d)) && !d.getSourceFile().isDeclarationFile && ts.isIdentifier(d.name);
		const files = this.files.filter((sf) => !sf.isDeclarationFile);
		const visit = (x: ts.Node): void => {
			if (ts.isPropertyAccessExpression(x) && ['length', 'apply', 'call'].includes(x.name.text) && ts.isPropertyAccessExpression(x.expression)) {
				const d = this.checker.getSymbolAtLocation(x.expression.name)?.valueDeclaration;
				if (field(d) && this.checker.getTypeAtLocation(x.expression).getCallSignatures().length) held.add(d);
			}
			ts.forEachChild(x, visit);
		};
		files.forEach(visit);
		if (!held.size) return held;
		// The same field of the interfaces and classes a type implements or extends, and of those implementing or extending it.
		const types = files.flatMap((sf) =>
			sf.statements.flatMap(function all(st: ts.Node): (ts.ClassDeclaration | ts.InterfaceDeclaration)[] {
				if (ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st)) return [st];
				return ts.isModuleDeclaration(st) && st.body && ts.isModuleBlock(st.body) ? st.body.statements.flatMap(all) : [];
			}),
		);
		const bases = (t: ts.ClassDeclaration | ts.InterfaceDeclaration) =>
			(t.heritageClauses ?? [])
				.flatMap((h) =>
					h.types.map((x) => {
						const sym = this.checker.getSymbolAtLocation(x.expression);
						return (sym && sym.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(sym) : sym)?.declarations?.find((d) => ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d));
					}),
				)
				.filter((d): d is ts.ClassDeclaration | ts.InterfaceDeclaration => !!d);
		const member = (t: ts.ClassDeclaration | ts.InterfaceDeclaration, name: string) => (t.members as ts.NodeArray<ts.Node>).find((m): m is ts.PropertyDeclaration | ts.PropertySignature => field(m) && (m.name as ts.Identifier).text === name);
		for (let grew = true; grew;) {
			grew = false;
			for (const t of types) {
				for (const b of bases(t)) {
					for (const d of [...held]) {
						const name = (d.name as ts.Identifier).text;
						const own = member(t, name),
							base = member(b, name);
						if (!own || !base || held.has(own) === held.has(base)) continue;
						held.add(own);
						held.add(base);
						grew = true;
					}
				}
			}
		}
		return held;
	}

	/** Names of members the program assigns on any object (`options.width = 2`), by name (sharing.ts `assignedMembers`). */
	assignedMembers(): Set<string> {
		return (this.assignedNames ??= assignedMembers(this.checker, this.files));
	}

	/** Methods an instance may hold a value in place of (`instanceKeysOf`). */
	instanceKeys(): Set<ts.MethodDeclaration> {
		return (this.instanceKeySet ??= instanceKeysOf(this.files, this.checker, (e) => literalClassOf({ checker: this.checker, library: this.scope.library }, e)));
	}

	/** The classes whose objects script gives members they don't declare (`expandoRootsOf`); none in library mode. */
	givenUndeclared(): Set<ts.ClassLikeDeclaration> {
		return (this.undeclaredRoots ??= this.scope.library ? new Set() : expandoRootsOf(this.files, this.checker, this.instanceKeys()));
	}

	/**
	 * App mode: a program class declaring instance fields whose objects the program holds untyped somewhere (any, unknown,
	 * object, a type parameter), so that `Object.defineProperty` with a key known only at run time may name one of its fields.
	 */
	heldOpenWithFields(): ts.ClassLikeDeclaration | null {
		if (this.openFieldsClass !== undefined) return this.openFieldsClass;
		const roots = classesHeldUntyped(this.files, this.checker, true);
		const rootOf = (c: ts.ClassLikeDeclaration) => {
			let r = c;
			for (let base = programBase(r, this.checker); base; base = programBase(base, this.checker)) r = base;
			return r;
		};
		const hasFields = (c: ts.ClassLikeDeclaration) => c.members.some((m) => (ts.isPropertyDeclaration(m) && !hasModifier(m, ts.SyntaxKind.StaticKeyword) && !hasModifier(m, ts.SyntaxKind.DeclareKeyword)) || (ts.isConstructorDeclaration(m) && m.parameters.some((p) => ts.isParameterPropertyDeclaration(p, m))));
		const classes: ts.ClassLikeDeclaration[] = [];
		const visit = (n: ts.Node): void => {
			if (ts.isClassLike(n)) classes.push(n);
			ts.forEachChild(n, visit);
		};
		for (const f of this.files) if (!f.isDeclarationFile && !this.scope.pluginFiles.has(f.fileName)) visit(f);
		return (this.openFieldsClass = this.scope.library ? null : (classes.find((c) => roots.has(rootOf(c)) && hasFields(c)) ?? null));
	}

	/** Library mode: the program's classes object literals are made instances of (`literalClassOf`). */
	literalClasses(): Set<ts.ClassDeclaration> {
		if (this.literalTargets) return this.literalTargets;
		const out = (this.literalTargets = new Set());
		const b = { checker: this.checker, library: this.scope.library };
		const add = (c: ts.ClassDeclaration | null | undefined) => {
			if (c) out.add(c);
		};
		const visit = (n: ts.Node) => {
			if (ts.isObjectLiteralExpression(n)) add(literalClassOf(b, n));
			if (ts.isReturnStatement(n) && n.expression) add(shapesClassOf(b, n.expression));
			if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'map') add(shapesClassOf(b, n));
			ts.forEachChild(n, visit);
		};
		for (const sf of this.files) if (!sf.isDeclarationFile) visit(sf);
		return out;
	}

	/**
	 * Methods some subclass overrides, which `X.prototype.m.call(obj, …)` calls as X has it whatever obj's class is.
	 * Library mode: each such method, which an app may name; otherwise those the program names.
	 */
	nonVirtualEntries(): Set<ts.MethodDeclaration> {
		if (this.nonVirtualMethods) return this.nonVirtualMethods;
		const found = new Set<ts.MethodDeclaration>();
		const classes = this.classes();
		// The instance member names the classes below each class declare.
		const namesBelow = new Map<ts.ClassLikeDeclaration, Set<string>>();
		for (const c of classes) {
			const names = c.members.flatMap((x) => (!isStatic(x) && x.name ? [x.name.getText()] : []));
			if (!names.length) continue;
			const seen = new Set([c]);
			for (let b = programBase(c, this.checker); b && !seen.has(b); b = programBase(b, this.checker)) {
				seen.add(b);
				let set = namesBelow.get(b);
				if (!set) namesBelow.set(b, (set = new Set()));
				for (const n of names) set.add(n);
			}
		}
		const overriddenBelow = (m: ts.MethodDeclaration) => !!namesBelow.get(m.parent as ts.ClassLikeDeclaration)?.has(m.name.getText());
		const consider = (m: ts.MethodDeclaration | undefined) => {
			if (m && !m.typeParameters?.length && ts.isClassDeclaration(m.parent) && m.parent.name && overriddenBelow(m)) found.add(m);
		};
		if (this.scope.library) {
			for (const c of classes) for (const x of c.members) if (ts.isMethodDeclaration(x) && !isStatic(x) && x.body && !ts.isComputedPropertyName(x.name)) consider(x);
		} else {
			const visit = (n: ts.Node) => {
				if (ts.isPropertyAccessExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'prototype') {
					const owner = resolveSymbol(n.expression.expression, this.checker)?.valueDeclaration;
					if (owner && ts.isClassDeclaration(owner) && !owner.getSourceFile().isDeclarationFile) consider(declaringMethod(owner, n.name.text, this.checker));
				}
				ts.forEachChild(n, visit);
			};
			for (const sf of this.files) if (!sf.isDeclarationFile) visit(sf);
		}
		return (this.nonVirtualMethods = found);
	}

	/** The override families (`methodFamily`) some method of which reads its own `arguments`. */
	argumentsFamilies(): Set<string> {
		return (this.argumentsFamilySet ??= new Set(
			this.files.flatMap((f) => {
				const keys: string[] = [];
				const visit = (n: ts.Node): void => {
					if (ts.isMethodDeclaration(n) && !isStatic(n) && ts.isClassLike(n.parent) && this.readsOwnArguments(n)) keys.push(methodFamily(n, this.checker));
					ts.forEachChild(n, visit);
				};
				visit(f);
				return keys;
			}),
		));
	}

	/** Whether a method's override family is one of `argumentsFamilies`. */
	familyReadsArguments(m: ts.MethodDeclaration): boolean {
		return this.argumentsFamilies().has(methodFamily(m, this.checker));
	}

	/** The methods overriding a root method (`baseMethod`'s), directly or through others. */
	overridesOf(root: ts.MethodDeclaration): ts.MethodDeclaration[] {
		if (!this.overrideMap) {
			const map = new Map<ts.MethodDeclaration, ts.MethodDeclaration[]>();
			const visit = (n: ts.Node) => {
				if (ts.isClassLike(n)) {
					for (const m of n.members) {
						if (!ts.isMethodDeclaration(m) || isStatic(m) || (!m.body && !hasModifier(m, ts.SyntaxKind.AbstractKeyword))) continue;
						let top: ts.MethodDeclaration = m;
						for (let b = baseMethod(top, this.checker); b; b = baseMethod(top, this.checker)) top = b;
						if (top !== m) map.set(top, [...(map.get(top) ?? []), m]);
					}
				}
				ts.forEachChild(n, visit);
			};
			for (const f of this.files) visit(f);
			this.overrideMap = map;
		}
		return this.overrideMap.get(root) ?? [];
	}

	/** A root method (`rootMethod`'s) with every method overriding it, directly or through others. */
	methodFamily(root: ts.MethodDeclaration): ts.MethodDeclaration[] {
		if (!this.familyMap) {
			const map = new Map<ts.MethodDeclaration, ts.MethodDeclaration[]>();
			const visit = (n: ts.Node) => {
				if (ts.isClassLike(n)) {
					for (const m of n.members) {
						if (!ts.isMethodDeclaration(m) || isStatic(m) || (!m.body && !hasModifier(m, ts.SyntaxKind.AbstractKeyword))) continue;
						const top = rootMethod(m, this.checker);
						map.set(top, [...(map.get(top) ?? [top]), ...(top === m ? [] : [m])]);
					}
				}
				ts.forEachChild(n, visit);
			};
			for (const f of this.files) if (!f.isDeclarationFile) visit(f);
			this.familyMap = map;
		}
		return this.familyMap.get(root) ?? [root];
	}

	/**
	 * The names the program writes on prototypes: `X.prototype.name = v` (data), `Object.defineProperty(X.prototype,
	 * 'name', …)` (accessors), and, in a file writing `X.prototype[key] = v` with a key known only at run time, every name
	 * the file spells as a string value (`setter: '_setMinWidthNative'`), any of which the key may be.
	 */
	prototypeKeys(): { data: Set<string>; accessors: Set<string> } {
		if (this.protoKeys) return this.protoKeys;
		const data = new Set<string>(),
			accessors = new Set<string>();
		const isPrototype = (x: ts.Node) => ts.isPropertyAccessExpression(x) && x.name.text === 'prototype';
		const visit = (n: ts.Node) => {
			if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left) && isPrototype(n.left.expression)) data.add(n.left.name.text);
			if (ts.isCallExpression(n) && n.expression.getText() === 'Object.defineProperty' && n.arguments.length >= 2 && isPrototype(n.arguments[0]) && ts.isStringLiteralLike(n.arguments[1])) accessors.add(n.arguments[1].text);
			ts.forEachChild(n, visit);
		};
		for (const sf of this.files) if (!sf.isDeclarationFile) visit(sf);
		for (const sf of this.files) {
			if (sf.isDeclarationFile) continue;
			let dynamic = false;
			const find = (n: ts.Node): void => {
				if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isElementAccessExpression(n.left) && isPrototype(n.left.expression) && !ts.isStringLiteralLike(n.left.argumentExpression)) dynamic = true;
				if (!dynamic) ts.forEachChild(n, find);
			};
			find(sf);
			if (!dynamic) continue;
			const strings = (n: ts.Node): void => {
				if (ts.isPropertyAssignment(n) && ts.isStringLiteralLike(n.initializer) && /^[A-Za-z_$][\w$]*$/.test(n.initializer.text)) data.add(n.initializer.text);
				ts.forEachChild(n, strings);
			};
			strings(sf);
		}
		return (this.protoKeys = { data, accessors });
	}

	/** Program classes whose `.prototype` object is read or observed via `Object.getPrototypeOf` in app mode. */
	prototypeClasses(): ReadonlySet<ts.ClassDeclaration> {
		if (this.protoClasses) return this.protoClasses;
		const out = new Set<ts.ClassDeclaration>();
		if (this.scope.library) return (this.protoClasses = out);
		let anyGetProto = false;
		const addChain = (cls: ts.ClassLikeDeclaration | undefined) => {
			for (let c = cls; c; c = programBase(c, this.checker)) {
				if (ts.isClassDeclaration(c) && !c.getSourceFile().isDeclarationFile) out.add(c);
			}
		};
		const visit = (n: ts.Node): void => {
			if (ts.isPropertyAccessExpression(n) && n.name.text === 'prototype') {
				const sym = resolveSymbol(n.expression, this.checker);
				if (sym && sym.flags & ts.SymbolFlags.Class && sym.valueDeclaration && ts.isClassLike(sym.valueDeclaration)) addChain(sym.valueDeclaration);
			} else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === 'Object' && n.expression.name.text === 'getPrototypeOf') {
				anyGetProto = true;
			}
			ts.forEachChild(n, visit);
		};
		for (const sf of this.files) if (!sf.isDeclarationFile) visit(sf);
		if (anyGetProto) {
			for (const c of this.classes()) if (ts.isClassDeclaration(c)) out.add(c);
		}
		return (this.protoClasses = out);
	}

	/** App-mode module `let`/`const` bindings that may be read before their initializer runs. */
	tdzBindings(): ReadonlySet<ts.VariableDeclaration> {
		return (this.tdzSet ??= this.scope.library ? new Set() : cyclicModuleBindings(this.checker, this.files));
	}
}
traceClass(ProgramFacts.prototype, 'facts');
