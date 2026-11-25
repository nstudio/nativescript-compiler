import ts from 'typescript';
import { basename, dirname, join, relative } from 'node:path';
import { readFileSync } from 'node:fs';
import { evaluationOrder } from '../program/module-order.ts';
import type { Translator } from './translator.ts';
import type { ActiveAdapter } from '../adapters/active.ts';
import { buildCache } from '../program/build-caches.ts';

export interface KotlinModule {
	file: string;
	/** The Kotlin file's name, without the extension. */
	name: string;
	code: string;
	/** The function running the module's top-level statements, if it has any. */
	init: string | null;
}

/**
 * The app's plain modules as Kotlin, in the order JavaScript evaluates them.
 * Top-level statements with effects become an init function per module, which
 * the entry point calls in that order: Kotlin initializes a file's properties
 * when the file is first used instead.
 */
export function translateKotlinModules(translator: Translator, program: ts.Program, files: string[], resolved?: (containing: string, specifier: string) => string | undefined, app?: string): KotlinModule[] {
	const out: KotlinModule[] = [];
	const ordered = evaluationOrder(program, files, resolved);
	const names = moduleFileNames(ordered, app ? (f) => sourceName(app, f, translator.config.adapter) : undefined);
	for (const file of ordered) {
		const sf = program.getSourceFile(file)!;
		const name = names.get(file)!;
		const { code, init } = translator.module(sf);
		// Library mode: the module's object runs its init.
		const object = translator.library?.moduleName?.(file);
		const initName = init.length ? (object ? `${object}.__init` : `__init_${name}`) : null;
		const initCode = initName && !object ? `\n\nfun ${initName}() {\n${init.join('\n')}\n}\n` : '';
		out.push({ file, name, code: code + initCode, init: initName });
	}
	return out;
}

/** Interfaces become classes once everything that might use them is translated. */
export function addKotlinInterfaces(translator: Translator, modules: KotlinModule[]) {
	for (const m of modules) m.code = (translator.interfacesOf(m.file) + m.code).trim() + '\n';
}

/**
 * Each module's Kotlin file name, which is also its JVM facade class's: its own name, or with as many of its
 * directories (a package's file: its package's name) before it as tell it apart from the others, ignoring case.
 */
function moduleFileNames(files: string[], named?: (file: string) => string): Map<string, string> {
	const parts = new Map(
		files.map((f) => [
			f,
			(named ? named(f) : f)
				.replace(/\.tsx?$/, '')
				.split(/[\\/]/)
				.filter((p) => p && p !== '.' && p !== '..' && !p.startsWith('@')),
		]),
	);
	const at = (f: string, k: number) => {
		const name = parts.get(f)!.slice(-k).join('_').replace(/\W/g, '_');
		return /^\d/.test(name) ? '_' + name : name;
	};
	const depth = new Map(files.map((f) => [f, 1]));
	for (let grew = true; grew;) {
		grew = false;
		const byName = new Map<string, string[]>();
		for (const f of files) {
			const n = at(f, depth.get(f)!).toLowerCase();
			byName.set(n, [...(byName.get(n) ?? []), f]);
		}
		for (const same of byName.values()) {
			if (same.length < 2) continue;
			for (const f of same)
				if (depth.get(f)! < parts.get(f)!.length) {
					depth.set(f, depth.get(f)! + 1);
					grew = true;
				}
		}
	}
	const used = new Set<string>(),
		out = new Map<string, string>();
	for (const f of files) {
		let name = at(f, depth.get(f)!),
			n = 2;
		while (used.has((n > 2 ? `${name}_${n - 1}` : name).toLowerCase())) n++;
		if (n > 2) name = `${name}_${n - 1}`;
		used.add(name.toLowerCase());
		out.set(f, name);
	}
	return out;
}

/**
 * How a generated file names its source: an app file by its path in the app, any other (a package's, a plugin's checkout,
 * the compiler's or its framework adapter's runtime) as its package's name and its path there, so no generated file holds
 * a machine's paths. `adapter`: the build's framework adapter, whose runtime's files are its package's.
 */
export function sourceName(app: string, file: string, adapter: ActiveAdapter): string {
	const inApp = relative(app, file);
	if (!inApp.startsWith('..') && !inApp.split(/[\\/]/).includes('node_modules')) return inApp;
	const runtime = adapter.runtimePackageOf(file);
	if (runtime) return `${runtime.name}/${relative(runtime.root, file)}`;
	for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
		if (!packageNames.has(dir)) packageNames.set(dir, packageName(dir));
		const name = packageNames.get(dir);
		if (name) return `${name}/${relative(dir, file)}`;
		// A plugin's checkout in the source cache (`@scope+name@1.0.0/repo/…`) where no package.json names it.
		const cached = /^(@[^+/]+)\+([^@/]+)@[^/]+$|^([^@+/]+)@[^/]+$/.exec(basename(dir));
		if (cached) return `${cached[3] ?? `${cached[1]}/${cached[2]}`}/${relative(dir, file).split(/[\\/]/).slice(1).join('/')}`;
	}
	return basename(file);
}
const packageNames = buildCache(new Map<string, string | null>());
function packageName(dir: string): string | null {
	try {
		return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name ?? null;
	} catch {
		return null;
	}
}
