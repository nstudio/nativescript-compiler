// App_Resources and project settings both generated projects read (nativescript.config.ts, the app's production
// plugins, the files its build copies), as the NativeScript CLI reads them. Each platform's own part is in
// ios/resources.ts and android/resources.ts.
import { dirname, join, resolve } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import ts from 'typescript';

/** The literal values of nativescript.config.ts's exported object; anything computed is left out. */
export function readConfig(app: string): Record<string, unknown> {
	const file = ['nativescript.config.ts', 'nativescript.config.js'].map((f) => join(app, f)).find(existsSync);
	if (!file) return {};
	const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
	const locals = new Map<string, ts.Expression>();
	for (const st of sf.statements) {
		if (ts.isVariableStatement(st)) {
			for (const d of st.declarationList.declarations) {
				if (ts.isIdentifier(d.name) && d.initializer) locals.set(d.name.text, d.initializer);
			}
		}
	}
	const value = (e: ts.Expression): unknown => {
		if (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e)) return value(e.expression);
		if (ts.isIdentifier(e) && locals.has(e.text)) return value(locals.get(e.text)!);
		if (ts.isStringLiteralLike(e)) return e.text;
		if (ts.isNumericLiteral(e)) return Number(e.text);
		if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
		if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
		if (ts.isArrayLiteralExpression(e)) return e.elements.map(value);
		if (ts.isObjectLiteralExpression(e)) {
			const out: Record<string, unknown> = {};
			for (const p of e.properties) {
				if (ts.isPropertyAssignment(p)) out[p.name.getText().replace(/^['"]|['"]$/g, '')] = value(p.initializer);
				else if (ts.isShorthandPropertyAssignment(p)) out[p.name.text] = value(p.name);
			}
			return out;
		}
		return undefined;
	};
	for (const st of sf.statements) if (ts.isExportAssignment(st)) return (value(st.expression) as Record<string, unknown>) ?? {};
	return {};
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The app's entry statements for nativescript.config's handling of uncaught errors: `uncaughtErrorPolicy`
 * (read at the top level only, as NativeScript's runtime reads it) and the deprecated `discardUncaughtJsExceptions`.
 */
export function uncaughtErrorSwitches(app: string, platform: 'ios' | 'android'): string {
	const config = readConfig(app);
	const own = isObject(config[platform]) ? (config[platform] as Record<string, unknown>) : {};
	const lines: string[] = [];
	if (typeof config.uncaughtErrorPolicy === 'string' && config.uncaughtErrorPolicy !== 'report') lines.push(`UncaughtErrors.policy = ${JSON.stringify(config.uncaughtErrorPolicy)}`);
	if (config.discardUncaughtJsExceptions === true || own.discardUncaughtJsExceptions === true) lines.push('UncaughtErrors.discard = true');
	return lines
		.map(
			(l) => `        ${l}
`,
		)
		.join('');
}

/**
 * The config's `release` (`compiled` and the compiler's options) with `<platform>.release` merged over it;
 * object values such as `pluginReplacements` merge by key.
 */
export function releaseOptions(app: string, platform: 'ios' | 'android'): Record<string, unknown> {
	const config = readConfig(app);
	const own = isObject(config[platform]) ? (config[platform] as Record<string, unknown>).release : undefined;
	const out: Record<string, unknown> = { ...(isObject(config.release) ? config.release : {}) };
	for (const [key, v] of Object.entries(isObject(own) ? own : {})) out[key] = isObject(v) && isObject(out[key]) ? { ...out[key], ...v } : v;
	return out;
}

/**
 * `release.pluginReplacements`: packages the native build replaces with a TypeScript module of
 * the app's (a stand-in for a plugin whose job has no meaning without the JavaScript runtime), resolved paths.
 */
export function pluginReplacements(app: string, platform: 'ios' | 'android'): Record<string, string> {
	const replacements = releaseOptions(app, platform).pluginReplacements as Record<string, string> | undefined;
	return Object.fromEntries(Object.entries(replacements ?? {}).map(([name, file]) => [name, resolve(app, file)]));
}

/**
 * The binary-only plugins the app uses that `release.stubPlugins` lets the build stub, of those a stand-in is found for
 * (`available`, bindings.ts's pluginStubs). Any other of those it uses, neither stubbed nor replaced, stops the build.
 */
export function stubbedPlugins(app: string, platform: 'ios' | 'android', available: ReadonlyMap<string, string>): { stubbed: string[]; errors: string[] } {
	const asked = releaseOptions(app, platform).stubPlugins;
	if (asked !== undefined && (!Array.isArray(asked) || asked.some((x) => typeof x !== 'string'))) throw new Error(`nativescript.config: release.stubPlugins is a list of package names`);
	const stubs = new Set<string>((asked as string[] | undefined) ?? []);
	for (const name of stubs) if (!available.has(name)) throw new Error(`nativescript.config: release.stubPlugins: ${name} has no stand-in: none of the packages found declares one (nativescript.compilerStubs)${available.size ? `; there are stand-ins for ${[...available.keys()].join(', ')}` : ''}`);
	const replaced = pluginReplacements(app, platform);
	const direct = Object.keys(JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')).dependencies ?? {});
	const used = new Set([...direct, ...productionPlugins(app, platform).map((p) => p.name)].filter((name) => available.has(name) && !replaced[name]));
	const refused = [...used].filter((name) => !stubs.has(name));
	return {
		stubbed: [...used].filter((name) => stubs.has(name)),
		errors: refused.map((name) => `${name} is a binary-only plugin: it ships no TypeScript source, so a compiled build cannot compile it. Replace it with a TypeScript module of the app (release.pluginReplacements: { '${name}': './src/…' }), or build it as a no-op stand-in that renders an empty view (release.stubPlugins: ['${name}']).`),
	};
}

export function appResourcesDir(app: string): string {
	return resolve(app, (readConfig(app).appResourcesPath as string | undefined) ?? 'App_Resources');
}

export function localFilePackages(dir: string): Map<string, string> {
	const out = new Map<string, string>();
	const pkgPath = join(dir, 'package.json');
	if (!existsSync(pkgPath)) return out;
	let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
	try {
		pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
	} catch {
		return out;
	}
	for (const group of [pkg.devDependencies, pkg.dependencies]) {
		for (const [name, spec] of Object.entries(group ?? {})) {
			if (typeof spec !== 'string' || !spec.startsWith('file:')) continue;
			const target = resolve(dir, spec.slice(5));
			if (existsSync(join(target, 'package.json'))) out.set(name, target);
		}
	}
	return out;
}

/**
 * The CLI's `getAllProductionPlugins`: the packages the app's production
 * dependencies bring in, transitively, that declare `nativescript` in their
 * package.json, in the order the dependency tree reaches them, less those the
 * build stubs (`stubbed`).
 */
export function productionPlugins(app: string, platform: 'ios' | 'android', stubbed: ReadonlySet<string> = new Set()): { name: string; dir: string }[] {
	const out: { name: string; dir: string }[] = [];
	const seen = new Set<string>();
	const replaced = pluginReplacements(app, platform);
	const queue: { from: string; deps: Record<string, string> }[] = [{ from: app, deps: JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')).dependencies ?? {} }];
	while (queue.length) {
		const { from, deps } = queue.shift()!;
		for (const [name, spec] of Object.entries(deps)) {
			// A plugin the app replaces or the build stubs brings none of its native pieces, nor its own dependencies'.
			if (stubbed.has(name) || replaced[name]) continue;
			const dir = locatePackage(from, name, spec);
			if (!dir || seen.has(dir)) continue;
			seen.add(dir);
			const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
			if (pkg.nativescript) out.push({ name, dir });
			queue.push({ from: dir, deps: pkg.dependencies ?? {} });
		}
	}
	return out;
}

function locatePackage(from: string, name: string, spec?: string): string | null {
	if (typeof spec === 'string' && spec.startsWith('file:')) {
		const target = resolve(from, spec.slice(5));
		if (existsSync(join(target, 'package.json'))) return target;
	}
	for (let dir = from; ; dir = dirname(dir)) {
		const candidate = join(dir, 'node_modules', name);
		if (existsSync(join(candidate, 'package.json'))) return candidate;
		if (dirname(dir) === dir) return null;
	}
}

/**
 * The app folder's files its NativeScript build copies as they are: `assets/**` and the fonts by both
 * bundlers, and every other `.jpg` and `.png` too by webpack's default copy rules.
 */
export function copiedAppFiles(appDir: string, vite: boolean): string[] {
	if (!existsSync(appDir)) return [];
	return (readdirSync(appDir, { recursive: true }).sort() as string[])
		.map((f) => f.split('\\').join('/'))
		.filter((f) => !/(^|\/)(node_modules|App_Resources|\.[^/]+)(\/|$)/.test(f) && statSync(join(appDir, f)).isFile())
		.filter((f) => f.startsWith('assets/') || (f.startsWith('fonts/') && /\.(ttf|otf)$/i.test(f)) || (!vite && !f.startsWith('fonts/') && /\.(jpg|png)$/.test(f)))
		.sort();
}
