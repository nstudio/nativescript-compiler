import { basename } from 'node:path';
import ts from 'typescript';
import type { Translator } from './translator.ts';
import { evaluationOrder } from '../program/module-order.ts';

export interface TranslatedModule {
	file: string;
	/** The Swift file's name, without the extension. */
	name: string;
	code: string;
	/** The function running the module's top-level statements, if it has any. */
	init: string | null;
	/** Whether `init` throws, so callers abort dependent importers and report once at entry. */
	initThrows: boolean;
}

/**
 * The app's plain modules as Swift, in the order JavaScript evaluates them
 * (each module after the modules it imports). Top-level statements with
 * effects become an init function per module: Swift initializes globals
 * lazily, so they run from the entry point in that order instead.
 */
export function translateModules(translator: Translator, program: ts.Program, files: string[], resolved?: (containing: string, specifier: string) => string | undefined): TranslatedModule[] {
	const ordered = evaluationOrder(program, files, resolved);
	const used = new Set<string>();
	const out: TranslatedModule[] = [];
	for (const file of ordered) {
		const sf = program.getSourceFile(file)!;
		let name = basename(file)
			.replace(/\.tsx?$/, '')
			.replace(/\W/g, '_');
		while (used.has(name.toLowerCase())) name += '_';
		used.add(name.toLowerCase());
		let code = '',
			init: string[] = [];
		try {
			({ code, init } = translator.module(sf));
		} catch (e) {
			if (!translator.errors) throw e;
			translator.errors.push((e as Error).message);
		}
		const initName = init.length ? `__init_${name}` : null;
		const initThrows = init.some((l) => /\b(try|throw)\b/.test(l));
		const initCode = initName ? `\n\nfunc ${initName}()${initThrows ? ' throws' : ''} {\n${init.join('\n')}\n}\n` : '';
		out.push({ file, name, code: code + initCode, init: initName, initThrows });
	}
	return out;
}

/** Interfaces become classes once everything that might use them is translated (modules and components). */
export function addInterfaces(translator: Translator, modules: TranslatedModule[]) {
	for (const m of modules) m.code = (translator.interfacesOf(m.file) + m.code).trim() + '\n';
}
