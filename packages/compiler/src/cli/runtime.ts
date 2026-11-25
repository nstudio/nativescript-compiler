import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { CliCommandContext, CliDevicesService, CliLogger, CliProjectData } from './contracts.ts';

export const COMPILER_PACKAGE_NAMES = ['@nstudio/nativescript-compiler', '@nativescript/compiler'] as const;

export const EXPORT_METHODS = ['debugging', 'release-testing', 'app-store-connect', 'enterprise'] as const;

export interface CompileCommonOptions {
	prepareOnly?: boolean;
	run?: boolean;
	clean?: boolean;
	out?: string;
	copyTo?: string;
	device?: string;
	allErrors?: boolean;
	allowUnimplementedProperties?: boolean;
	allowCoreMismatch?: boolean;
	allowUntestedFrameworks?: boolean;
	skipToolchainCheck?: boolean;
}

export interface CompileIosOptions extends CompileCommonOptions {
	forDevice?: boolean;
	provision?: unknown;
	teamId?: unknown;
	exportMethod?: string;
	wholeKit?: boolean;
}

export interface CompileAndroidOptions extends CompileCommonOptions {
	aab?: boolean;
	keyStorePath?: string;
	keyStorePassword?: string;
	keyStoreAlias?: string;
	keyStoreAliasPassword?: string;
}

export function extensionRoot(): string {
	return resolve(import.meta.dirname, '../..');
}

/** Resolves a project-pinned compiler package first, falling back to this CLI extension's own copy. */
export function resolveCompilerPackage(projectDir: string, fallbackRoot: string = extensionRoot()): string {
	let dir = resolve(projectDir);
	for (let depth = 0; depth < 8; depth++) {
		for (const pkgName of COMPILER_PACKAGE_NAMES) {
			const candidate = join(dir, 'node_modules', pkgName);
			if (existsSync(join(candidate, 'package.json'))) return candidate;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return resolve(fallbackRoot);
}

export function compilerBin(packageDir: string, binName: string): string {
	const pkgPath = join(packageDir, 'package.json');
	const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string; bin?: Record<string, string> };
	const rel = pkg.bin?.[binName];
	if (!rel) throw new Error(`${pkg.name ?? packageDir} does not declare bin '${binName}'`);
	return join(packageDir, rel);
}

export function readCliOptions<T extends object>(context: CliCommandContext<any>): T {
	const globalOpts = context.injector.get<Record<string, unknown>>('options', { optional: true });
	return Object.assign({}, globalOpts ?? {}, context.options) as T;
}

export function optionString(value: unknown): string | undefined {
	if (typeof value === 'string') {
		const trimmed = value.trim();
		return trimmed.length ? trimmed : undefined;
	}
	return undefined;
}

export function compiledOutputDir(projectData: CliProjectData, platform: 'ios' | 'android', customOut?: string): string {
	return customOut ? resolve(projectData.projectDir, customOut) : join(projectData.platformsDir, 'compiled', platform);
}

export function cleanCompiledBuild(outDir: string): void {
	rmSync(join(outDir, 'DerivedData'), { recursive: true, force: true });
	rmSync(join(outDir, 'build'), { recursive: true, force: true });
}

export function buildCompileArgs(platform: 'ios' | 'android', projectData: CliProjectData, options: CompileIosOptions & CompileAndroidOptions, outDir: string): string[] {
	const args: string[] = [projectData.projectDir, '--platform', platform, '--out', outDir, '--name', projectData.projectName];
	const bundleId = projectData.projectIdentifiers?.[platform];
	if (bundleId) args.push('--bundle', bundleId);
	if (!options.prepareOnly) args.push('--build');

	if (platform === 'ios') {
		if (options.forDevice) args.push('--device');
		const provision = optionString(options.provision);
		if (provision) args.push('--provision', provision);
		const teamId = optionString(options.teamId);
		if (teamId) args.push('--team-id', teamId);
		if (options.exportMethod) args.push('--export-method', options.exportMethod);
		if (options.wholeKit) args.push('--whole-kit');
	} else {
		if (options.aab) args.push('--aab');
		if (options.keyStorePath) {
			args.push('--key-store-path', resolve(projectData.projectDir, options.keyStorePath));
			if (options.keyStorePassword !== undefined) args.push('--key-store-password', options.keyStorePassword);
			if (options.keyStoreAlias !== undefined) args.push('--key-store-alias', options.keyStoreAlias);
			if (options.keyStoreAliasPassword !== undefined) args.push('--key-store-alias-password', options.keyStoreAliasPassword);
		}
	}

	if (options.allErrors) args.push('--all-errors');
	if (options.allowUnimplementedProperties) args.push('--allow-unimplemented-properties');
	if (options.allowCoreMismatch) args.push('--allow-core-mismatch');
	if (options.allowUntestedFrameworks) args.push('--allow-untested-frameworks');
	if (options.skipToolchainCheck) args.push('--skip-toolchain-check');
	return args;
}

export function artifactPath(platform: 'ios' | 'android', outDir: string, projectName: string, options: Pick<CompileIosOptions, 'forDevice'> & Pick<CompileAndroidOptions, 'aab'>): string {
	if (platform === 'ios') {
		if (options.forDevice) return join(outDir, 'build', `${projectName}.ipa`);
		return join(outDir, 'build', 'Build', 'Products', 'Release-iphonesimulator', `${projectName}.app`);
	}
	if (options.aab) return join(outDir, 'build', 'outputs', 'bundle', 'release', `${projectName}-release.aab`);
	return join(outDir, 'build', 'outputs', 'apk', 'release', `${projectName}-release.apk`);
}

export function copyArtifact(artifact: string, copyTo: string, projectDir: string): string {
	const raw = resolve(projectDir, copyTo);
	const isDirTarget = existsSync(raw) ? statSync(raw).isDirectory() : copyTo.endsWith('/') || copyTo.endsWith('\\');
	const destination = isDirTarget ? join(raw, basename(artifact)) : raw;
	mkdirSync(dirname(destination), { recursive: true });
	cpSync(artifact, destination, { recursive: true, force: true });
	return destination;
}

export async function runNodeBin(scriptPath: string, args: string[], cwd: string): Promise<number> {
	return new Promise<number>((resolveCode, reject) => {
		const child = spawn(process.execPath, [scriptPath, ...args], { cwd, stdio: 'inherit' });
		child.on('error', reject);
		child.on('close', (code) => resolveCode(code ?? 1));
	});
}

export async function deployAndLaunch(context: CliCommandContext<any>, platform: 'ios' | 'android', projectData: CliProjectData, packageFile: string, deviceId?: string): Promise<void> {
	const logger = context.injector.get<CliLogger>('logger', { optional: true });
	const devicesService = context.injector.get<CliDevicesService>('devicesService', { optional: true });
	if (!devicesService) {
		context.fail('Cannot run on a device because the CLI devicesService is unavailable.', { help: false });
	}
	const appId = projectData.projectIdentifiers?.[platform];
	if (!appId) {
		context.fail(`Cannot launch the compiled ${platform} app: no bundle/application identifier is configured in nativescript.config.`, { help: false });
	}
	await devicesService.initialize({
		platform,
		deviceId,
		skipInferPlatform: false,
		skipDeviceDetectionInterval: true,
	});
	if (!devicesService.hasDevices) {
		context.fail(`No connected ${platform} device or emulator/simulator found. Start one or pass --device <id>.`, { help: false });
	}
	await devicesService.execute(async (device) => {
		logger?.info(`Installing ${basename(packageFile)} on ${device.deviceInfo.displayName ?? device.deviceInfo.identifier}...`);
		await device.applicationManager.reinstallApplication(appId, packageFile);
		await device.applicationManager.startApplication({
			appId,
			projectName: projectData.projectName,
			projectDir: projectData.projectDir,
		});
		logger?.info(`Launched ${appId} on ${device.deviceInfo.displayName ?? device.deviceInfo.identifier}.`);
	});
}
