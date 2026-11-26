#!/usr/bin/env node
// NativeScript CLI extension contract checks for `@nstudio/nativescript-compiler`:
// - package.json declares `nativescript:extension`, lazy `nativescript.commands`, and `nativescript.docs`;
// - dist/cli/*.cjs builds cleanly and loads via synchronous require() (how ExtensibilityService loads commands);
// - every exported command carries the cross-bundle Symbol.for marker, matches its manifest key, and ships a man page;
// - project-local compiler resolution, argument building, artifact paths, and --copy-to work as specified.
//   node tests/cli/extension.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildDist } from '../../bin/build-dist.mjs';
import { COMMAND_DEFINITION_MARKER, type CliProjectData } from '../../src/cli/contracts.ts';
import { artifactPath, buildCompileArgs, copyArtifact, resolveCompilerPackage } from '../../src/cli/runtime.ts';
import { runDoctor } from '../../src/tools/doctor.ts';
import { check, finish } from '../release-checks/checks.ts';

const root = resolve(import.meta.dirname, '../..');
const work = mkdtempSync(join(tmpdir(), 'ns-cli-ext-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
	name: string;
	keywords?: string[];
	files?: string[];
	nativescript?: { commands?: Record<string, string>; docs?: string };
};

check(pkg.name === '@nstudio/nativescript-compiler', 'package name is @nstudio/nativescript-compiler');
check(Array.isArray(pkg.keywords) && pkg.keywords.includes('nativescript:extension'), 'package.json carries the nativescript:extension keyword');
check(!!pkg.nativescript?.commands && !Array.isArray(pkg.nativescript.commands), 'package.json declares nativescript.commands as a lazy map');
check(pkg.nativescript?.docs === './docs/cli' && pkg.files?.includes('docs/cli/') === true, 'package.json declares and ships docs/cli/');

const expectedCommands = ['compile|ios', 'compile|android', 'compile|verify', 'compile|retrace', 'compile|doctor'];
for (const name of expectedCommands) {
	check(typeof pkg.nativescript?.commands?.[name] === 'string', `manifest declares command '${name}'`);
	const docFile = join(root, 'docs', 'cli', `${name.replace(/\|/g, '-')}.md`);
	check(existsSync(docFile), `man page exists for '${name}' (${docFile})`);
}
check(existsSync(join(root, 'docs', 'cli', 'compile.md')), 'parent man page docs/cli/compile.md exists');

// Build `src/cli` into a scratch dist/ and require() each declared CJS command module synchronously.
const distRoot = join(work, 'dist');
buildDist(join(root, 'src'), distRoot, { skip: (rel) => rel !== 'cli' && !rel.startsWith('cli/'), copy: false });
const req = createRequire(import.meta.url);

for (const [cmdName, relPath] of Object.entries(pkg.nativescript?.commands ?? {})) {
	const builtPath = join(work, relPath.replace(/^\.\//, ''));
	check(existsSync(builtPath), `buildDist emits ${relPath}`);
	const loaded = req(builtPath) as { default?: Record<string | symbol, unknown> };
	const def = loaded.default ?? (loaded as Record<string | symbol, unknown>);
	check(def[COMMAND_DEFINITION_MARKER] === true, `${cmdName} exports a defineCommand definition marked with Symbol.for`);
	check(def.name === cmdName, `${cmdName} definition name matches its manifest key`);
	check(typeof def.run === 'function', `${cmdName} defines an executable run() handler`);
}

// Project-local compiler resolution prefers project node_modules over extension fallback.
const appDir = join(work, 'app');
const localPkg = join(appDir, 'node_modules', '@nstudio', 'nativescript-compiler');
mkdirSync(localPkg, { recursive: true });
writeFileSync(join(localPkg, 'package.json'), JSON.stringify({ name: '@nstudio/nativescript-compiler', version: '9.2.0' }));
check(resolveCompilerPackage(appDir, root) === localPkg, 'resolveCompilerPackage prefers project-local @nstudio/nativescript-compiler');

const emptyApp = join(work, 'no-local');
mkdirSync(emptyApp, { recursive: true });
check(resolveCompilerPackage(emptyApp, root) === root, 'resolveCompilerPackage falls back to extension root when not installed in project');

// Argument mapping and artifact path checks.
const project: CliProjectData = {
	projectDir: appDir,
	projectName: 'DemoApp',
	platformsDir: join(appDir, 'platforms'),
	projectIdentifiers: { ios: 'org.nstudio.demo', android: 'org.nstudio.demo' },
	initializeProjectData() {},
};

const iosArgs = buildCompileArgs('ios', project, { forDevice: true, teamId: 'TEAM123', exportMethod: 'app-store-connect', wholeKit: true }, join(appDir, 'platforms/compiled/ios'));
check(
	iosArgs.includes('--platform') &&
		iosArgs.includes('ios') &&
		iosArgs.includes('--build') &&
		iosArgs.includes('--device') &&
		iosArgs.includes('--team-id') &&
		iosArgs.includes('TEAM123') &&
		iosArgs.includes('--export-method') &&
		iosArgs.includes('app-store-connect') &&
		iosArgs.includes('--whole-kit'),
	'buildCompileArgs maps iOS device signing and compiler flags',
);

const androidPrepArgs = buildCompileArgs(
	'android',
	project,
	{ prepareOnly: true, aab: true, keyStorePath: 'keys/release.jks', keyStorePassword: 'pw', keyStoreAlias: 'alias', keyStoreAliasPassword: 'apw' },
	join(appDir, 'platforms/compiled/android'),
);
check(
	!androidPrepArgs.includes('--build') &&
		androidPrepArgs.includes('--aab') &&
		androidPrepArgs.includes('--key-store-path') &&
		androidPrepArgs.includes(join(appDir, 'keys/release.jks')),
	'buildCompileArgs respects --prepare-only and Android signing flags',
);

const norm = (p: string) => p.replace(/\\/g, '/');
check(norm(artifactPath('ios', '/out', 'DemoApp', {})).endsWith('/out/build/Build/Products/Release-iphonesimulator/DemoApp.app'), 'iOS simulator artifactPath resolves .app');
check(norm(artifactPath('ios', '/out', 'DemoApp', { forDevice: true })).endsWith('/out/build/DemoApp.ipa'), 'iOS device artifactPath resolves .ipa');
check(norm(artifactPath('android', '/out', 'DemoApp', {})).endsWith('/out/build/outputs/apk/release/DemoApp-release.apk'), 'Android artifactPath resolves .apk');
check(norm(artifactPath('android', '/out', 'DemoApp', { aab: true })).endsWith('/out/build/outputs/bundle/release/DemoApp-release.aab'), 'Android --aab artifactPath resolves .aab');

const dummyApk = join(work, 'DemoApp-release.apk');
writeFileSync(dummyApk, 'apk');
const copiedDir = join(work, 'out-dir');
mkdirSync(copiedDir, { recursive: true });
const copied = copyArtifact(dummyApk, copiedDir, work);
check(copied === join(copiedDir, 'DemoApp-release.apk') && existsSync(copied), 'copyArtifact copies into a target directory preserving filename');

const doctorOutside = runDoctor(join(work, 'not-a-project'), ['ios']);
check(doctorOutside.projectDir === null && doctorOutside.checks.some((c) => c.category === 'project' && c.status === 'warn'), 'runDoctor skips project checks with a warning outside a project');

const doctorApp = join(work, 'doctor-app');
mkdirSync(join(doctorApp, 'app'), { recursive: true });
writeFileSync(join(doctorApp, 'package.json'), JSON.stringify({ name: 'doctor-app', main: 'app/app.ts', dependencies: { '@angular/core': '22.0.0' } }));
writeFileSync(join(doctorApp, 'app', 'app.ts'), '');
const doctorMissing = runDoctor(doctorApp, ['ios']);
check(
	doctorMissing.framework === 'angular' &&
		doctorMissing.checks.some((c) => c.category === 'framework' && c.status === 'error' && c.message.includes('@nstudio/nativescript-compiler-angular')),
	'runDoctor detects framework and names missing @nstudio/nativescript-compiler-<framework> install command',
);

finish('CLI extension checks');
