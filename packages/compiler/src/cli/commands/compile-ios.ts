import { existsSync } from 'node:fs';
import { booleanOption, defineCommand, provideProject, stringOption, type CliLogger, type CliProjectData } from '../contracts.ts';
import { artifactPath, buildCompileArgs, cleanCompiledBuild, compiledOutputDir, compilerBin, copyArtifact, deployAndLaunch, EXPORT_METHODS, readCliOptions, resolveCompilerPackage, runNodeBin, type CompileIosOptions } from '../runtime.ts';

// Shared CLI-wide options (--for-device, --provision, --team-id, --clean, --copy-to, --device)
// are already defined by nativescript-cli and read from the CLI options service via readCliOptions().
const options = {
	exportMethod: stringOption({ description: `Export method with --team-id (${EXPORT_METHODS.join('|')}).` }),
	run: booleanOption({ description: 'Install and launch the compiled app on a simulator or device after building.' }),
	prepareOnly: booleanOption({ description: 'Generate the Swift/Xcode project in platforms/compiled/ios without running xcodebuild.' }),
	out: stringOption({ hasSensitiveValue: true, description: 'Output directory (default: platforms/compiled/ios).' }),
	allErrors: booleanOption({ description: 'Report every unsupported construct instead of stopping at the first.' }),
	allowUnimplementedProperties: booleanOption({ description: 'Warn instead of failing on core properties not applied by the kit.' }),
	allowCoreMismatch: booleanOption({ description: 'Warn instead of failing when @nativescript/core differs from the kit version.' }),
	allowUntestedFrameworks: booleanOption({ description: 'Warn instead of failing when framework versions are outside the adapter range.' }),
	skipToolchainCheck: booleanOption({ description: 'Skip Xcode version validation.' }),
	wholeKit: booleanOption({ description: 'Compile every file of NativeScriptKit instead of closed-world tree-shaking.' }),
};

export const compileIosCommand = defineCommand({
	name: 'compile|ios',
	description: 'Compiles the project to native Swift and builds an iOS release without a JavaScript runtime.',
	options,
	params: 'none',
	providers: [provideProject()],
	canExecute(context) {
		if (process.platform !== 'darwin') {
			context.fail('Compiling for iOS requires macOS and Xcode.', { help: false });
		}
		const opts = readCliOptions<CompileIosOptions>(context);
		if (opts.run && opts.prepareOnly) {
			context.fail('--run cannot be combined with --prepare-only.', { help: false });
		}
		const method = opts.exportMethod;
		if (method && !(EXPORT_METHODS as readonly string[]).includes(method)) {
			context.fail(`Invalid --export-method '${method}'. Expected one of: ${EXPORT_METHODS.join(', ')}.`);
		}
		return true;
	},
	async run(context) {
		const projectData = context.injector.get<CliProjectData>('projectData');
		const logger = context.injector.get<CliLogger>('logger', { optional: true });
		const opts = readCliOptions<CompileIosOptions>(context);
		const outDir = compiledOutputDir(projectData, 'ios', opts.out);

		if (opts.clean) {
			cleanCompiledBuild(outDir);
		}

		const compilerPkg = resolveCompilerPackage(projectData.projectDir);
		const bin = compilerBin(compilerPkg, 'ns-compiled');
		const args = buildCompileArgs('ios', projectData, opts, outDir);

		logger?.info(`Compiling ${projectData.projectName} for iOS (native Swift)...`);
		const exitCode = await runNodeBin(bin, args, projectData.projectDir);
		if (exitCode !== 0) {
			context.fail(`Native iOS compilation failed (exit code ${exitCode}).`, { help: false });
		}

		if (opts.prepareOnly) {
			logger?.info(`Prepared native iOS project at ${outDir}`);
			return;
		}

		const built = artifactPath('ios', outDir, projectData.projectName, opts);
		if (opts.copyTo) {
			if (!existsSync(built)) {
				context.fail(`Expected compiled iOS output at ${built}, but it was not found.`, { help: false });
			}
			const copied = copyArtifact(built, opts.copyTo, projectData.projectDir);
			logger?.info(`Copied compiled iOS output to ${copied}`);
		}

		if (opts.run) {
			if (!existsSync(built)) {
				context.fail(`Expected compiled iOS output at ${built}, but it was not found.`, { help: false });
			}
			await deployAndLaunch(context, 'ios', projectData, built, opts.device);
		}
	},
});

export default compileIosCommand;
