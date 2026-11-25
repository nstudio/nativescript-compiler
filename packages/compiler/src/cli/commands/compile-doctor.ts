import { defineCommand, stringOption, type CliProjectData } from '../contracts.ts';
import { compilerBin, readCliOptions, resolveCompilerPackage, runNodeBin } from '../runtime.ts';

interface CompileDoctorOptions {
	platform?: string;
	json?: boolean;
}

// `--json` is already defined CLI-wide in nativescript-cli and read via readCliOptions().
const options = {
	platform: stringOption({ description: 'Check a single target platform: ios, android, or both (default: both).' }),
};

export const compileDoctorCommand = defineCommand({
	name: 'compile|doctor',
	description: 'Checks toolchains, generated kits, @nativescript/core parity, framework adapters, and plugin bindings.',
	options,
	params: [{ name: 'platform', required: false, description: 'Optional platform (ios, android, or both).' }],
	canExecute(context) {
		const opts = readCliOptions<CompileDoctorOptions>(context);
		const raw = String(context.params.platform ?? opts.platform ?? 'both').toLowerCase();
		if (raw !== 'ios' && raw !== 'android' && raw !== 'both') {
			context.fail(`Invalid platform '${raw}'. Expected ios, android, or both.`);
		}
		return true;
	},
	async run(context) {
		const projectData = context.injector.get<CliProjectData>('projectData', { optional: true });
		let projectDir = process.cwd();
		if (projectData) {
			try {
				projectData.initializeProjectData();
				if (projectData.projectDir) projectDir = projectData.projectDir;
			} catch {}
		}
		const opts = readCliOptions<CompileDoctorOptions>(context);
		const platform = String(context.params.platform ?? opts.platform ?? 'both').toLowerCase();
		const compilerPkg = resolveCompilerPackage(projectDir);
		const bin = compilerBin(compilerPkg, 'ns-compiled-doctor');
		const args = [projectDir, '--platform', platform, ...(opts.json ? ['--json'] : [])];

		const exitCode = await runNodeBin(bin, args, projectDir);
		if (exitCode !== 0) {
			context.fail('Compiler doctor found one or more issues above.', { help: false });
		}
	},
});

export default compileDoctorCommand;
