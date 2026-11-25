#!/usr/bin/env node
// Preflight diagnostics for `@nstudio/nativescript-compiler`: checks host toolchains, generated kits,
// `@nativescript/core` version parity, detected framework adapter, and engine-bound/binary plugins.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { detectFramework } from '../adapters/framework.ts';
import { adapterOf, availableAdapters, compilerVersion, type AdapterManifest } from '../adapters/load.ts';
import { checkContract, installedVersion, kitManifest } from '../driver/contract.ts';
import { checkToolchain } from '../driver/toolchain.ts';
import { appBindings, pluginStubs, unboundEnginePlugins } from '../plugins/bindings.ts';
import { releaseOptions, stubbedPlugins } from '../targets/resources.ts';

export type CheckStatus = 'ok' | 'warn' | 'error';

export interface DoctorCheck {
	category: string;
	status: CheckStatus;
	message: string;
}

export interface DoctorReport {
	compilerVersion: string;
	projectDir: string | null;
	framework: string | null;
	checks: DoctorCheck[];
	errors: number;
	warnings: number;
}

function collectAppFiles(appDir: string): string[] {
	if (!existsSync(appDir)) return [];
	const files: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir).sort()) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) walk(full);
			else files.push(full);
		}
	};
	walk(appDir);
	return files;
}

export function runDoctor(appPath: string | null, platforms: readonly ('ios' | 'android')[] = ['ios', 'android']): DoctorReport {
	const checks: DoctorCheck[] = [];
	const version = compilerVersion();
	const add = (category: string, status: CheckStatus, message: string) => checks.push({ category, status, message });

	for (const platform of platforms) {
		const tc = checkToolchain(platform);
		if (!tc.errors.length && !tc.warnings.length) {
			add(`toolchain:${platform}`, 'ok', `${platform === 'ios' ? 'iOS (Xcode)' : 'Android (JDK + SDK)'} toolchain ready`);
		}
		for (const w of tc.warnings) add(`toolchain:${platform}`, 'warn', w);
		for (const e of tc.errors) add(`toolchain:${platform}`, 'error', e);

		const kit = kitManifest(platform);
		if (kit) {
			add(`kit:${platform}`, 'ok', `NativeScriptKit (${platform}) generated from @nativescript/core ${kit.core}`);
		} else {
			add(`kit:${platform}`, 'error', `NativeScriptKit (${platform}) is not generated yet (run nx run compiler:${platform === 'ios' ? 'kit' : 'kit-android'})`);
		}
	}

	const projectDir = appPath && existsSync(join(resolve(appPath), 'package.json')) ? resolve(appPath) : null;
	let framework: string | null = null;
	if (!projectDir) {
		add('project', 'warn', 'No NativeScript project found in the current directory; skipped project, framework, and plugin checks.');
		return {
			compilerVersion: version,
			projectDir: null,
			framework: null,
			checks,
			errors: checks.filter((c) => c.status === 'error').length,
			warnings: checks.filter((c) => c.status === 'warn').length,
		};
	}

	const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')) as { main?: string };
	const coreVersion = installedVersion(projectDir, '@nativescript/core');
	if (coreVersion) {
		add('core', 'ok', `Installed @nativescript/core ${coreVersion}`);
	} else {
		add('core', 'error', '@nativescript/core is not installed in node_modules (run npm install)');
	}

	const entry = join(projectDir, pkg.main ?? 'app/app.ts');
	const appDir = dirname(entry);
	const files = collectAppFiles(appDir);
	const adapters = availableAdapters(projectDir);
	framework = detectFramework(projectDir, adapters, entry, files, appDir);

	let adapterPkg: AdapterManifest | null = null;
	if (!framework) {
		add('framework', 'warn', 'Could not detect a NativeScript framework from package.json or app files.');
	} else if (framework === 'core') {
		add('framework', 'ok', 'Detected core (XML + TypeScript) — no framework adapter required');
	} else {
		try {
			adapterPkg = adapterOf(framework, adapters);
			add('framework', 'ok', `Detected ${framework} with adapter ${adapterPkg.name}@${adapterPkg.version}`);
		} catch (err) {
			add('framework', 'error', (err as Error).message);
		}
	}

	const stubModules = pluginStubs(projectDir);
	for (const platform of platforms) {
		const opts = releaseOptions(projectDir, platform);
		const contract = checkContract({
			app: projectDir,
			platform,
			adapter: adapterPkg,
			allowCoreMismatch: opts.allowCoreMismatch === true,
			allowUntestedFrameworks: opts.allowUntestedFrameworks === true,
		});
		for (const w of contract.warnings) add(`contract:${platform}`, 'warn', w);
		for (const e of contract.errors) add(`contract:${platform}`, 'error', e);

		const stubs = stubbedPlugins(projectDir, platform, stubModules);
		for (const e of stubs.errors) add(`plugins:${platform}`, 'error', e);
		if (stubs.stubbed.length) {
			add(`plugins:${platform}`, 'warn', `Stubbed binary plugins (${platform}): ${stubs.stubbed.join(', ')}`);
		}
		try {
			const stubSet = new Set(stubs.stubbed);
			const bindings = appBindings(projectDir, platform, stubSet);
			const unbound = unboundEnginePlugins(projectDir, platform, bindings, stubSet);
			for (const e of unbound) add(`plugins:${platform}`, 'error', e);
			if (!stubs.errors.length && !unbound.length) {
				add(`plugins:${platform}`, 'ok', `Plugins (${platform}) ready${bindings.length ? ` (${bindings.length} native binding${bindings.length > 1 ? 's' : ''})` : ''}`);
			}
		} catch (err) {
			add(`plugins:${platform}`, 'error', (err as Error).message);
		}
	}

	return {
		compilerVersion: version,
		projectDir,
		framework,
		checks,
		errors: checks.filter((c) => c.status === 'error').length,
		warnings: checks.filter((c) => c.status === 'warn').length,
	};
}

function main(): void {
	const parsed = parseArgs({
		options: {
			platform: { type: 'string' },
			json: { type: 'boolean' },
			help: { type: 'boolean' },
		},
		allowPositionals: true,
	});
	if (parsed.values.help) {
		console.log('ns-compiled-doctor [app folder] [--platform ios|android|both] [--json]');
		process.exit(0);
	}
	const rawPlatform = (parsed.values.platform ?? 'both').toLowerCase();
	if (rawPlatform !== 'ios' && rawPlatform !== 'android' && rawPlatform !== 'both') {
		console.error(`error: --platform ${rawPlatform}: expected ios, android, or both`);
		process.exit(2);
	}
	const platforms: readonly ('ios' | 'android')[] = rawPlatform === 'both' ? ['ios', 'android'] : [rawPlatform];
	const report = runDoctor(parsed.positionals[0] ?? process.cwd(), platforms);
	if (parsed.values.json) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		console.log(`@nstudio/nativescript-compiler ${report.compilerVersion}`);
		if (report.projectDir) console.log(`Project: ${report.projectDir}`);
		for (const item of report.checks) {
			const icon = item.status === 'ok' ? '✓' : item.status === 'warn' ? '!' : '✗';
			console.log(`  ${icon} [${item.category}] ${item.message}`);
		}
		console.log(`\nSummary: ${report.errors} error(s), ${report.warnings} warning(s)`);
	}
	process.exit(report.errors > 0 ? 1 : 0);
}

const isEntry = process.argv[1] && /(?:^|[\\/])(?:doctor\.(?:ts|js)|ns-compiled-doctor\.js)$/.test(process.argv[1]);
if (isEntry) main();
