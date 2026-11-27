#!/usr/bin/env node
// The package's public types as a framework adapter or binding package compiles against them: the declarations the
// package ships (bin/build-dist.mjs --types) installed with this package.json into a scratch app, and a consumer
// importing them type-checked strictly, the declarations included (no skipLibCheck). Fails, too, where an import of
// the package's internals resolves: `exports` names the API alone.
//   node tests/checks/api-consumer.ts
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import ts from 'typescript';

const root = join(import.meta.dirname, '../..');
const work = mkdtempSync(join(tmpdir(), 'ns-api-consumer-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));
const installed = join(work, 'node_modules', '@nstudio', 'nativescript-compiler');
mkdirSync(installed, { recursive: true });
cpSync(join(root, 'package.json'), join(installed, 'package.json'));
const built = spawnSync(process.execPath, [join(root, 'bin', 'build-dist.mjs'), '--types', join(installed, 'dist', 'types')], { encoding: 'utf8' });
if (built.status !== 0) {
	console.error(`the declarations do not build:\n${built.stderr}`);
	process.exit(1);
}
const emitted = readdirSync(join(installed, 'dist', 'types')).sort();
const tsDir = dirname(createRequire(import.meta.url).resolve('typescript/package.json'));
symlinkSync(tsDir, join(work, 'node_modules', 'typescript'), 'dir');
writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));

const consumer = join(work, 'adapter.ts');
writeFileSync(
	consumer,
	`import type { CoreApi, FrameworkAdapter, RefusalKind, TranslatorHooks, SwiftTranslatorView, KotlinTranslatorView, TemplateBehaviour } from '@nstudio/nativescript-compiler/adapter-api';
import type { CompilerBinding, CompilerStubs } from '@nstudio/nativescript-compiler/binding-api';

declare module '@nstudio/nativescript-compiler/adapter-api' {
	interface AdapterRefusalIds {
		'consumer-refusal': true;
	}
}

const refusals: Record<'consumer-refusal', RefusalKind> = { 'consumer-refusal': { class: 'gap', title: 'a consumer construct', suggestion: 'write it otherwise' } };
const behaviour: TemplateBehaviour = { schedule: 'microtask', eventScope: 'event', propsOrder: 'pre', deferBindings: false, insertion: 'created', listenersAfterBindings: false, effectScope: null, checkEveryBinding: 'off', slots: false, rowSignals: 'off', fragments: false };
const swift: TranslatorHooks<SwiftTranslatorView> = {
	globalCall(t, name, call) {
		if (name !== 'refused') return undefined;
		throw t.error(call, 'a refused call', 'consumer-refusal');
	},
};
const kotlin: TranslatorHooks<KotlinTranslatorView> = { methodCall: (t, owner, method, call) => (owner === 'Store' && method === 'read' ? t.expr(call.expression) : undefined) };

export default function adapter(core: CoreApi): FrameworkAdapter {
	return {
		apiVersion: core.apiVersion,
		name: 'consumer',
		packages: ['consumer-framework'],
		behaviour,
		reach: 'entry',
		frontEnd: (app) => ({ components: [], modules: app.sources.filter((f) => core.packageOf(f) !== 'skipped'), root: '' }),
		swift,
		kotlin,
		refusals,
	};
}

export const binding: CompilerBinding = { apiVersion: 1, package: 'consumer-plugin', versions: '^1.0.0', ios: { sources: 'ios', installer: 'ConsumerInstaller' } };
export type Stubs = CompilerStubs;
`,
);
const internal = join(work, 'internal.ts');
writeFileSync(internal, `export type { BuildContext } from '@nstudio/nativescript-compiler/src/program/build-context.ts';\n`);

const options: ts.CompilerOptions = { strict: true, noEmit: true, skipLibCheck: false, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022, types: [], exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true };
const diagnostics = (file: string) => ts.getPreEmitDiagnostics(ts.createProgram([file], options)).map((d) => `${d.file ? `${d.file.fileName.replace(work + '/', '')}:${d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}: ` : ''}${ts.flattenDiagnosticMessageText(d.messageText, ' ')} (TS${d.code})`);

let failed = false;
const errors = diagnostics(consumer);
if (errors.length) {
	failed = true;
	console.error(`a strict consumer of the public types does not compile:\n  ${errors.join('\n  ')}`);
}
if (!diagnostics(internal).some((d) => d.includes('TS2307'))) {
	failed = true;
	console.error("an import of the package's internals (src/…) resolves: exports must name the public entries only");
}
console.log(`${failed ? 'FAILED' : 'ok'}: ${emitted.length} declaration files (${emitted.join(', ')}), a strict consumer${failed ? '' : ' compiles'}`);
process.exit(failed ? 1 : 0);
