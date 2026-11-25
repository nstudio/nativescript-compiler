#!/usr/bin/env node
// ns-compiled: a NativeScript app compiled to a native app with no JavaScript engine. The command line of `compile()`
// (compile.ts): its flags, `--help` printed from the table below.
import { parseArgs } from 'node:util';
import { BuildContext } from '../program/build-context.ts';
import { reportOnExit } from '../semantics/refusals.ts';
import type { ExportMethod } from '../targets/ios/signing.ts';
import { compile } from './compile.ts';

/** Each flag: whether it takes a value, and what `--help` says of it. */
const FLAGS = {
	platform: { type: 'string', help: '<ios|android>  the target (default ios)' },
	out: { type: 'string', help: '<dir>  the project folder (default <app>/platforms/compiled/<platform>)' },
	name: { type: 'string', help: "<Name>  the app's name (default its folder's, in PascalCase)" },
	bundle: { type: 'string', help: '<id>  the iOS bundle identifier or Android application id' },
	build: { type: 'boolean', help: 'build the project: Xcode for the simulator, or Gradle' },
	device: { type: 'boolean', help: 'iOS: an archive and .ipa; Android: as --aab' },
	provision: { type: 'string', help: '<profile>  iOS device builds: the provisioning profile to sign with' },
	'team-id': { type: 'string', help: '<team>  iOS device builds: sign automatically for this team' },
	'export-method': { type: 'string', help: '<debugging|release-testing|app-store-connect|enterprise>  with --team-id (default debugging)' },
	aab: { type: 'boolean', help: 'Android: an App Bundle beside the APK' },
	'key-store-path': { type: 'string', help: '<file>  Android: the release key store, with the three below' },
	'key-store-password': { type: 'string', help: '<password>' },
	'key-store-alias': { type: 'string', help: '<alias>' },
	'key-store-alias-password': { type: 'string', help: '<password>' },
	widgets: { type: 'string', help: '<aar>  Android: the widgets library' },
	'all-errors': { type: 'boolean', help: 'list every construct the translator cannot handle, not only the first' },
	'keep-going': { type: 'boolean', help: "write the project anyway: the platform compiler's errors show what is incomplete" },
	'allow-unimplemented-properties': { type: 'boolean', help: 'warn, not stop, for properties core declares that the kit does not apply (release.allowUnimplementedProperties)' },
	'allow-core-mismatch': { type: 'boolean', help: 'build with an installed core the kit was not generated from (release.allowCoreMismatch)' },
	'allow-untested-frameworks': { type: 'boolean', help: 'build with framework versions the adapter is not tested with (release.allowUntestedFrameworks)' },
	'skip-toolchain-check': { type: 'boolean', help: 'do not check Xcode, the JDK or the Android SDK first' },
	'no-source-lines': { type: 'boolean', help: 'generated code names no TypeScript source lines' },
	'xml-strict': { type: 'boolean', help: "an XML app stops where a site needs core's XML run time" },
	'whole-kit': { type: 'boolean', help: 'iOS: compile every file of the kit, however little of it the app reaches' },
	help: { type: 'boolean', help: 'print this' },
} as const satisfies Record<string, { type: 'string' | 'boolean'; help: string }>;

const parsed = (() => {
	try {
		return parseArgs({ options: FLAGS, allowPositionals: true });
	} catch (e) {
		console.error(`error: ${(e as Error).message} (--help lists the options)`);
		process.exit(2);
	}
})();
const { values: v, positionals } = parsed;
if (v.help) {
	const width = Math.max(...Object.keys(FLAGS).map((f) => f.length)) + 2;
	console.log(
		`ns-compiled <app folder> [options]\n\nThe app folder is a NativeScript project (package.json, app/).\n\n${Object.entries(FLAGS)
			.map(([f, d]) => `  --${f.padEnd(width)}${d.help}`)
			.join('\n')}`,
	);
	process.exit(0);
}

const PLATFORMS = ['ios', 'android'] as const;
const EXPORT_METHODS: readonly ExportMethod[] = ['debugging', 'release-testing', 'app-store-connect', 'enterprise'];
const oneOf = <T extends string>(flag: string, value: string | undefined, allowed: readonly T[]): T | undefined => {
	if (value === undefined || (allowed as readonly string[]).includes(value)) return value as T | undefined;
	console.error(`error: --${flag} ${value}: expected ${allowed.join(', ')} (--help lists the options)`);
	process.exit(2);
};
const platform = oneOf('platform', v.platform, PLATFORMS) ?? 'ios';
const exportMethod = oneOf('export-method', v['export-method'], EXPORT_METHODS);

const build = new BuildContext();
reportOnExit(build.refusals);
try {
	await compile(
		{
			app: positionals[0] ?? '.',
			platform,
			out: v.out,
			name: v.name,
			bundle: v.bundle,
			build: v.build,
			device: v.device,
			aab: v.aab,
			provision: v.provision,
			teamId: v['team-id'],
			exportMethod,
			keyStore: v['key-store-path'] === undefined ? undefined : { path: v['key-store-path'], password: v['key-store-password'], alias: v['key-store-alias'], aliasPassword: v['key-store-alias-password'] },
			widgets: v.widgets,
			allErrors: v['all-errors'],
			keepGoing: v['keep-going'],
			allowUnimplementedProperties: v['allow-unimplemented-properties'],
			allowCoreMismatch: v['allow-core-mismatch'],
			allowUntestedFrameworks: v['allow-untested-frameworks'],
			skipToolchainCheck: v['skip-toolchain-check'],
			sourceLines: !v['no-source-lines'],
			xmlStrict: v['xml-strict'],
			wholeKit: v['whole-kit'],
		},
		build,
	);
} catch (e) {
	// The refusal that stopped the build joins the refusal report printed on exit.
	build.refusals.noteRefused(String((e as Error)?.message ?? e));
	throw e;
}
