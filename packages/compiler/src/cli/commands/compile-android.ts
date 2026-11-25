import { existsSync } from 'node:fs';
import { booleanOption, defineCommand, provideProject, stringOption, type CliLogger, type CliProjectData } from '../contracts.ts';
import { artifactPath, buildCompileArgs, cleanCompiledBuild, compiledOutputDir, compilerBin, copyArtifact, deployAndLaunch, readCliOptions, resolveCompilerPackage, runNodeBin, type CompileAndroidOptions } from '../runtime.ts';

// Shared CLI-wide options (--aab, --key-store-*, --clean, --copy-to, --device)
// are already defined by nativescript-cli and read from the CLI options service via readCliOptions().
const options = {
	run: booleanOption({ description: 'Install and launch the compiled APK on an emulator or device after building.' }),
	prepareOnly: booleanOption({ description: 'Generate the Kotlin/Gradle project in platforms/compiled/android without running Gradle.' }),
	out: stringOption({ hasSensitiveValue: true, description: 'Output directory (default: platforms/compiled/android).' }),
	allErrors: booleanOption({ description: 'Report every unsupported construct instead of stopping at the first.' }),
	allowUnimplementedProperties: booleanOption({ description: 'Warn instead of failing on core properties not applied by the kit.' }),
	allowCoreMismatch: booleanOption({ description: 'Warn instead of failing when @nativescript/core differs from the kit version.' }),
	allowUntestedFrameworks: booleanOption({ description: 'Warn instead of failing when framework versions are outside the adapter range.' }),
	skipToolchainCheck: booleanOption({ description: 'Skip JDK and Android SDK validation.' }),
};

export const compileAndroidCommand = defineCommand({
	name: 'compile|android',
	description: 'Compiles the project to native Kotlin and builds an Android release without a JavaScript runtime.',
	options,
	params: 'none',
	providers: [provideProject()],
	canExecute(context) {
		const opts = readCliOptions<CompileAndroidOptions>(context);
		if (opts.run && opts.prepareOnly) {
			context.fail('--run cannot be combined with --prepare-only.', { help: false });
		}
		if (opts.keyStorePath) {
			const missing = [
				['--key-store-password', opts.keyStorePassword],
				['--key-store-alias', opts.keyStoreAlias],
				['--key-store-alias-password', opts.keyStoreAliasPassword],
			].filter(([, value]) => !value);
			if (missing.length) {
				context.fail(`When --key-store-path is set, also pass: ${missing.map(([flag]) => flag).join(', ')}.`);
			}
		}
		return true;
	},
	async run(context) {
		const projectData = context.injector.get<CliProjectData>('projectData');
		const logger = context.injector.get<CliLogger>('logger', { optional: true });
		const opts = readCliOptions<CompileAndroidOptions>(context);
		const outDir = compiledOutputDir(projectData, 'android', opts.out);

		if (opts.clean) {
			cleanCompiledBuild(outDir);
		}

		const compilerPkg = resolveCompilerPackage(projectData.projectDir);
		const bin = compilerBin(compilerPkg, 'ns-compiled');
		const args = buildCompileArgs('android', projectData, opts, outDir);

		logger?.info(`Compiling ${projectData.projectName} for Android (native Kotlin)...`);
		const exitCode = await runNodeBin(bin, args, projectData.projectDir);
		if (exitCode !== 0) {
			context.fail(`Native Android compilation failed (exit code ${exitCode}).`, { help: false });
		}

		if (opts.prepareOnly) {
			logger?.info(`Prepared native Android project at ${outDir}`);
			return;
		}

		const built = artifactPath('android', outDir, projectData.projectName, opts);
		if (opts.copyTo) {
			if (!existsSync(built)) {
				context.fail(`Expected compiled Android output at ${built}, but it was not found.`, { help: false });
			}
			const copied = copyArtifact(built, opts.copyTo, projectData.projectDir);
			logger?.info(`Copied compiled Android output to ${copied}`);
		}

		if (opts.run) {
			const installApk = artifactPath('android', outDir, projectData.projectName, { aab: false });
			if (!existsSync(installApk)) {
				context.fail(`Expected compiled Android APK at ${installApk}, but it was not found.`, { help: false });
			}
			await deployAndLaunch(context, 'android', projectData, installApk, opts.device);
		}
	},
});

export default compileAndroidCommand;
