import { booleanOption, defineCommand, type CliProjectData } from '../contracts.ts';
import { compilerBin, resolveCompilerPackage, runNodeBin } from '../runtime.ts';

const options = {
	composeMapping: booleanOption({ description: 'Compose Android R8 mapping.txt with source-lines.json into TypeScript source lines.' }),
	buildLog: booleanOption({ description: 'Map Kotlin compiler error lines in a build log back to TypeScript source lines.' }),
};

export const compileRetraceCommand = defineCommand({
	name: 'compile|retrace',
	description: 'Symbolicates a compiled iOS or Android stack trace (or composes Android R8 mappings) back to TypeScript lines.',
	options,
	params: 'any',
	async run(context) {
		const projectData = context.injector.get<CliProjectData>('projectData', { optional: true });
		let projectDir = process.cwd();
		if (projectData) {
			try {
				projectData.initializeProjectData();
				if (projectData.projectDir) projectDir = projectData.projectDir;
			} catch {}
		}

		const compilerPkg = resolveCompilerPackage(projectDir);
		const bin = compilerBin(compilerPkg, 'ns-compiled-retrace');
		const args: string[] = [];
		if (context.options.composeMapping) args.push('--compose-mapping');
		if (context.options.buildLog) args.push('--build-log');
		args.push(...context.args);

		const exitCode = await runNodeBin(bin, args, process.cwd());
		if (exitCode !== 0) {
			context.fail(`ns compile retrace failed (exit code ${exitCode}).`, { help: false });
		}
	},
});

export default compileRetraceCommand;
