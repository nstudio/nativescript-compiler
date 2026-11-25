// The build's framework as the back ends and their analyses ask about it: the compiler's own release vocabulary, which
// every build has, merged with the framework adapter's translator hooks (none for an app without a framework).
import ts from 'typescript';
import type { FrameworkModel, SignalEquality, SignalKind, TranslatorHooks, TranslatorView, TypeMapping } from '../api/adapter-api.ts';

/** `@nativescript/release`'s signals: the compiler's own primitives, which the front ends write. */
const RELEASE = {
	signalTypes: { WritableSignal: 'writable', Sig: 'value', DeepRef: 'ref' },
	signalConstructors: { $signal: 'always-changed', $ref: 'deep', $writable: 'identity' },
	pure: ['$ref', '$signal', '$writable'],
	rethrowing: ['WritableSignal.update', 'WritableSignal.$write'],
} as const;

const own = <T>(table: Readonly<Record<string, T>> | undefined, name: string): T | undefined => (table && Object.hasOwn(table, name) ? table[name] : undefined);

/** A module's declarations, in its package or in the compiler's shim of it (`/__shims__/_nativescript_release.d.ts`). */
export function declaredBy(d: ts.Declaration, module: string): boolean {
	const file = d.getSourceFile().fileName;
	if (file === `/__shims__/${module.replace(/[@/]/g, '_')}.d.ts`) return true;
	return new RegExp(
		`[\\\\/]${module
			.split('/')
			.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
			.join('[\\\\/]')}[\\\\/]`,
	).test(file);
}

/** A shim of one of `modules` (`scope/`: any module of the scope) declares `d`. */
function shimOf(d: ts.Declaration, modules: readonly string[]): boolean {
	const file = d.getSourceFile().fileName;
	return modules.some((m) => (m.endsWith('/') ? file.startsWith(`/__shims__/${m.replace(/[@/]/g, '_')}`) : file === `/__shims__/${m.replace(/[@/]/g, '_')}.d.ts`));
}

export class Framework<V extends TranslatorView = TranslatorView> {
	readonly hooks: TranslatorHooks<V>;

	constructor(hooks: TranslatorHooks<V> = {}) {
		this.hooks = hooks;
	}

	/** The kind of signal a type of this name is. */
	signalKind(name: string): SignalKind | undefined {
		return own<SignalKind>(RELEASE.signalTypes, name) ?? own(this.hooks.signalTypes, name);
	}

	/** A function of this name making a signal of its argument, as `signalConstructors` describes it. */
	signalConstructor(name: string): { equality: SignalEquality; options?: number; typed?: boolean; linked?: boolean } | undefined {
		const made = own<SignalEquality>(RELEASE.signalConstructors, name) ?? own(this.hooks.signalConstructors, name);
		return typeof made === 'string' ? { equality: made } : made;
	}

	/** Whether a module's initializer calling a function of this name (declared, not the program's) runs no app code. */
	pure(name: string): boolean {
		return (RELEASE.pure as readonly string[]).includes(name) || !!this.hooks.pure?.includes(name);
	}

	/** Whether a shim's function or method (`Owner.name`) runs its callback at once. */
	rethrowing(name: string, owner?: string): boolean {
		const listed = (n: string) => (RELEASE.rethrowing as readonly string[]).includes(n) || !!this.hooks.throwsModel?.rethrowing?.includes(n);
		return owner === undefined ? listed(name) : listed(`${owner}.*`) || listed(`${owner}.${name}`);
	}

	/** Whether `e` calls one of the framework's memo functions (`computed(fn)`), as its module declares it. */
	memoCall(e: ts.Node | undefined, checker: ts.TypeChecker): e is ts.CallExpression {
		const memos = this.hooks.memos;
		if (!memos || !e || !ts.isCallExpression(e)) return false;
		const at = ts.isPropertyAccessExpression(e.expression) ? e.expression.name : e.expression;
		let sym = checker.getSymbolAtLocation(at);
		if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
		const module = sym && own(memos, sym.name);
		return !!module && !!sym!.declarations?.some((d) => declaredBy(d, module));
	}

	/**
	 * The memo function a declaration keeps as its own, on every backend: a module's (or namespace's) variable, one memo
	 * for the module, or a class's instance field, one per instance. Any other memo call (a function's local) makes a memo
	 * each time it is evaluated.
	 */
	memoized(d: ts.Node | undefined, checker: ts.TypeChecker): ts.ArrowFunction | ts.FunctionExpression | undefined {
		if (!d || !(ts.isVariableDeclaration(d) || ts.isPropertyDeclaration(d)) || !this.memoCall(d.initializer, checker)) return undefined;
		const owned = ts.isVariableDeclaration(d) ? ts.isVariableStatement(d.parent.parent) && (ts.isSourceFile(d.parent.parent.parent) || ts.isModuleBlock(d.parent.parent.parent)) : ts.isClassLike(d.parent) && !(ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Static);
		const fn = d.initializer.arguments[0];
		return owned && fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ? fn : undefined;
	}

	/**
	 * The error a read of a component's prop field throws until its parent first sets it (`FrameworkModel.unsetError`);
	 * undefined for a field with a value from the start (`given`: its default's code, where the prop takes one).
	 */
	unsetError(field: ts.Node | undefined, given?: string): string | undefined {
		return field && ts.isPropertyDeclaration(field) && given === undefined ? this.hooks.unsetError?.(field) : undefined;
	}

	/** Whether a class field initialized by a call of this name keeps the signal it gives, read by its value. */
	heldSignal(callee: string): boolean {
		return !!this.hooks.heldSignals?.includes(callee);
	}

	/** A type of this name as the framework maps it. */
	typeMapping(name: string): Exclude<TypeMapping, string> | undefined {
		const m = own(this.hooks.typeMap, name);
		return typeof m === 'string' ? { type: m } : m;
	}

	/** The prefix of the kit's classes standing for a shimmed module's classes, by the shim's file. */
	classPrefix(file: string): string | undefined {
		for (const [module, prefix] of Object.entries(this.hooks.prefixedModules ?? {})) if (file === `/__shims__/${module.replace(/[@/]/g, '_')}.d.ts`) return prefix;
		return undefined;
	}

	/** Whether an interface the declarations declare is called untyped (no generated interface), in a package's class or the app's. */
	untypedInterface(decls: readonly ts.Declaration[], inPackage: boolean): boolean {
		const { untypedInterfaces = [], untypedPackageInterfaces = [] } = this.hooks;
		return decls.every((d) => shimOf(d, untypedInterfaces)) || (inPackage && decls.every((d) => shimOf(d, untypedPackageInterfaces)));
	}

	/** A class decorator `@Name` or `@Name(…)` the framework reads, which the class's translation neither refuses nor runs. */
	readDecorators(): string[] {
		return this.hooks.classDecorators ?? [];
	}

	/** Whether the framework's component decorator decorates the class: written `@Component…` (`called`: `@Component(`). */
	componentClass(cls: ts.ClassDeclaration, called = false): boolean {
		const name = this.hooks.componentDecorator;
		return !!name && (ts.getDecorators(cls) ?? []).some((d) => (called ? d.expression.getText().startsWith(`${name}(`) : d.expression.getText().startsWith(name)));
	}

	/** How the framework makes a class, as `FrameworkModel.classRole`. */
	classRole(cls: ts.ClassDeclaration, pluginFiles: ReadonlySet<string>): ReturnType<NonNullable<FrameworkModel['classRole']>> {
		return this.hooks.classRole?.(cls, pluginFiles);
	}
}
