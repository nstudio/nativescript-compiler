// What a build's framework adapter adds to how the compiler resolves modules and which sources it ships, held by the
// build (`BuildContext.adapter`, program/build-context.ts) and set before its program is made. An app with no framework
// (XML and TypeScript) has none.
import { basename, relative, resolve, sep } from 'node:path';
import type { AdapterKit, AdapterPackage, FrameworkAdapter, ModuleRules, RefusalKind } from '../api/adapter-api.ts';

export class ActiveAdapter {
	/** The adapter's module rules (substitutions, aliases, decorators the program reads). */
	readonly rules: ModuleRules;
	/** The adapter's kit sources (`FrameworkAdapter.kit`), as absolute paths. */
	readonly kit: Readonly<AdapterKit>;
	/** The refusals the adapter's hooks make, by id. */
	readonly refusals: Readonly<Record<string, RefusalKind>>;
	private readonly packages: readonly string[];
	private readonly runtime: { roots: string[]; modules: string[]; pkg: AdapterPackage | undefined };

	/** The build's adapter, or null for an app with no framework. */
	constructor(adapter: FrameworkAdapter | null) {
		this.rules = adapter?.modules ?? {};
		this.packages = adapter?.packages ?? [];
		this.runtime = { roots: (adapter?.runtimeRoots ?? []).map((d) => resolve(d) + sep), modules: adapter?.runtimeModules ?? [], pkg: adapter?.package };
		this.refusals = adapter?.refusals ?? {};
		this.kit = adapter ? adapterKitOf(adapter) : {};
	}

	/** A package of the build's framework (`@scope/x` where it names `@scope/*`). */
	isFrameworkPackage(pkg: string): boolean {
		return this.packages.some((p) => (p.endsWith('/*') ? pkg.startsWith(p.slice(0, -1)) : p === pkg));
	}

	/** TypeScript the adapter ships to compile with an app: as written, wherever it is installed. */
	isRuntimeSource(file: string): boolean {
		return this.runtime.roots.some((r) => file.startsWith(r));
	}

	/** A module the front end placed in the app's folder with a runtime file's text. */
	isRuntimeModule(file: string): boolean {
		return this.runtime.modules.includes(basename(file));
	}

	/** The adapter's package, for a file of its runtime. */
	runtimePackageOf(file: string): AdapterPackage | undefined {
		const pkg = this.runtime.pkg;
		return pkg && this.runtime.roots.some((r) => file.startsWith(r)) ? pkg : undefined;
	}

	/** A file of the adapter's runtime by its path in the adapter's package (`runtime/forms.ts`); undefined for any other file. */
	runtimeFile(file: string | undefined): string | undefined {
		const pkg = file === undefined ? undefined : this.runtimePackageOf(file);
		return pkg && relative(pkg.root, file!).split(sep).join('/');
	}

	/** A substitution's file whose classes' members are read by name too. */
	readsMembersByName(file: string): boolean {
		return Object.values(this.rules.substitutions ?? {}).some((s) => s.membersByName && s.file === file);
	}

	/** The adapter's refusal of an id the compiler's own refusals do not have. */
	refusal(id: string): RefusalKind | undefined {
		return Object.hasOwn(this.refusals, id) ? this.refusals[id] : undefined;
	}
}

/** An adapter's kit sources, as absolute paths. */
export function adapterKitOf(adapter: FrameworkAdapter): AdapterKit {
	const folders = Object.entries(adapter.kit ?? {}).filter(([, d]) => d !== undefined);
	if (folders.length && !adapter.package) throw new Error(`the ${adapter.name} adapter has kit sources but no package: they are found from its root (\`package.root\`)`);
	return Object.fromEntries(folders.map(([k, d]) => [k, resolve(adapter.package!.root, d)]));
}
