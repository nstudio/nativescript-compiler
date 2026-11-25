import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineCommand, provideProject, stringOption, type CliLogger, type CliProjectData } from '../contracts.ts';
import { buildCompileArgs, compiledOutputDir, compilerBin, resolveCompilerPackage, runNodeBin } from '../runtime.ts';

function findAppBundle(dir: string): string | undefined {
	if (!existsSync(dir)) return undefined;
	const app = readdirSync(dir).find((entry) => entry.endsWith('.app'));
	return app ? join(dir, app) : undefined;
}

const options = {
	steps: stringOption({ hasSensitiveValue: true, description: 'Path to verify.json steps file (defaults to <project>/verify.json if present).' }),
	out: stringOption({ hasSensitiveValue: true, description: 'Output directory for screenshots and diff report (default: platforms/compiled/verify).' }),
	jsApp: stringOption({ hasSensitiveValue: true, description: 'Existing JavaScript Release .app to compare against instead of running `ns build ios --release`.' }),
	compiledApp: stringOption({ hasSensitiveValue: true, description: 'Existing compiled Release .app to compare instead of building a fresh one.' }),
};

export const compileVerifyCommand = defineCommand({
	name: 'compile|verify',
	description: 'Builds and visually compares the compiled release against the JavaScript release on a simulator.',
	options,
	params: [{ name: 'platform', required: false, description: 'Target platform (currently ios).' }],
	providers: [provideProject()],
	canExecute(context) {
		const platform = String(context.params.platform ?? 'ios').toLowerCase();
		if (platform !== 'ios') {
			context.fail('ns compile verify currently compares iOS simulator builds.', { help: false });
		}
		if (process.platform !== 'darwin') {
			context.fail('ns compile verify for iOS requires macOS and Xcode.', { help: false });
		}
		return true;
	},
	async run(context) {
		const projectData = context.injector.get<CliProjectData>('projectData');
		const logger = context.injector.get<CliLogger>('logger', { optional: true });
		const compilerPkg = resolveCompilerPackage(projectData.projectDir);

		let jsApp = context.options.jsApp ? resolve(projectData.projectDir, context.options.jsApp) : undefined;
		if (!jsApp) {
			logger?.info('Building the JavaScript release (ns build ios --release)...');
			const cliEntry = process.argv[1];
			const code = await runNodeBin(cliEntry, ['build', 'ios', '--release'], projectData.projectDir);
			if (code !== 0) return context.fail(`JavaScript release build failed (exit code ${code}).`, { help: false });
			const jsDir = join(projectData.platformsDir, 'ios', 'build', 'Release-iphonesimulator');
			jsApp = findAppBundle(jsDir);
			if (!jsApp) return context.fail(`No JavaScript simulator .app found in ${jsDir}.`, { help: false });
		}

		let compiledApp = context.options.compiledApp ? resolve(projectData.projectDir, context.options.compiledApp) : undefined;
		if (!compiledApp) {
			logger?.info('Building the compiled iOS release...');
			const outDir = compiledOutputDir(projectData, 'ios');
			const code = await runNodeBin(compilerBin(compilerPkg, 'ns-compiled'), buildCompileArgs('ios', projectData, {}, outDir), projectData.projectDir);
			if (code !== 0) return context.fail(`Compiled release build failed (exit code ${code}).`, { help: false });
			const compiledDir = join(outDir, 'build', 'Build', 'Products', 'Release-iphonesimulator');
			compiledApp = findAppBundle(compiledDir);
			if (!compiledApp) return context.fail(`No compiled simulator .app found in ${compiledDir}.`, { help: false });
		}

		const stepsFile = context.options.steps ? resolve(projectData.projectDir, context.options.steps) : join(projectData.projectDir, 'verify.json');
		const verifyOut = context.options.out ? resolve(projectData.projectDir, context.options.out) : join(projectData.platformsDir, 'compiled', 'verify');
		const verifyArgs = ['--js', jsApp, '--compiled', compiledApp, '--out', verifyOut, ...(existsSync(stepsFile) ? ['--steps', stepsFile] : [])];

		const exitCode = await runNodeBin(compilerBin(compilerPkg, 'ns-compiled-verify'), verifyArgs, projectData.projectDir);
		if (exitCode !== 0) {
			context.fail(`The compiled release differs from its JavaScript release: see ${verifyOut}`, { help: false });
		}
	},
});

export default compileVerifyCommand;
