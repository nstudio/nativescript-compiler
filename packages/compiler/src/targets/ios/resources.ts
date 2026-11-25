// App_Resources and project settings applied to the generated Xcode project, as the NativeScript CLI applies them to
// platforms/ios (ios-project-service, ios-entitlements-service, xcconfig-service).
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mergePlist, readPlist, writePlist, type PlistDict } from './plist.ts';
import { productLines, type SwiftPackage } from './dependencies.ts';
import { appResourcesDir, productionPlugins, readConfig, copiedAppFiles } from '../resources.ts';
import { mirror, writeIfChanged } from '../../driver/mirror.ts';

/** What the app target of project.yml takes from App_Resources/iOS. */
export interface IOSProjectResources {
	/** `settings.base` entries for the app target. */
	settings: Record<string, string>;
	/** The target's base configuration file per configuration (relative to the project), if any. */
	configFiles: { Debug: string; Release: string } | null;
	/** Entries for the target's `sources:` list, as YAML lines. */
	sources: string;
	/** The team build.xcconfig signs with. */
	team?: string;
}

/** Entries of App_Resources/iOS the CLI does not copy into the bundle, or copies there though nothing reads them. */
const NOT_RESOURCES = new Set(['Info.plist', 'Podfile', 'src', 'extensions', 'watchapp', 'watchextension', 'build.xcconfig', 'app.entitlements']);
/** Directories that are resources as a whole rather than folders of resources. */
const BUNDLE_LIKE = /\.(xcassets|lproj|bundle|scnassets|xcstrings|storyboardc)$/;
/** NativeScriptKit's iOS version; an app target cannot import it with a lower deployment target. */
const KIT_DEPLOYMENT_TARGET = 17;

/** build.xcconfig, the app's first, so a plugin cannot override a setting the app chose. */
function mergedXcconfig(app: string, stubbed: ReadonlySet<string>): XcconfigEntry[] {
	const plugins = productionPlugins(app, 'ios', stubbed).map((p) => join(p.dir, 'platforms', 'ios'));
	const xcconfigs = [join(appResourcesDir(app), 'iOS', 'build.xcconfig'), ...plugins.map((p) => join(p, 'build.xcconfig'))].filter(existsSync);
	let merged: XcconfigEntry[] = [];
	for (const file of xcconfigs) merged = mergeXcconfig(merged, parseXcconfig(file));
	return merged;
}

/** The iOS version the app targets: build.xcconfig's, unless it is older than the kit's (`stubbed`: plugins the build stubs). */
export function iosDeploymentTarget(app: string, stubbed: ReadonlySet<string> = new Set()): string {
	const set = mergedXcconfig(app, stubbed).find((e) => e.kind === 'setting' && e.key === 'IPHONEOS_DEPLOYMENT_TARGET');
	return set && set.kind === 'setting' && parseFloat(set.value) > KIT_DEPLOYMENT_TARGET ? set.value.replace(/"/g, '') : `${KIT_DEPLOYMENT_TARGET}.0`;
}

/**
 * The scene manifest NativeScript's app template declares: UIKit stops an app built with the current SDK that adopts no
 * scene life cycle, and core's own scene delegate takes the session.
 */
const SCENE_MANIFEST: PlistDict = { UIApplicationPreferredDefaultSceneSessionRole: 'UIWindowSceneSessionRoleApplication', UIApplicationSupportsMultipleScenes: false };

export function iosProjectResources(o: { app: string; appDir: string; out: string; name: string; pods: boolean; say: (m: string) => void; stubbed?: ReadonlySet<string> }): IOSProjectResources {
	const res = join(appResourcesDir(o.app), 'iOS');
	const plugins = productionPlugins(o.app, 'ios', o.stubbed).map((p) => join(p.dir, 'platforms', 'ios'));
	const settings: Record<string, string> = {};
	const sources: string[] = [];

	// Info.plist: each plugin's, then the app's, then the bundle id from the build setting.
	const appPlist = join(res, 'Info.plist');
	if (existsSync(appPlist)) {
		let plist: PlistDict = {};
		for (const file of [...plugins.map((p) => join(p, 'Info.plist')), appPlist]) if (existsSync(file)) plist = mergePlist(plist, readPlist(file));
		plist = mergePlist(plist, { CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)' });
		if (!plist.UIApplicationSceneManifest) {
			o.say(`${relative(o.app, appPlist)} declares no UIApplicationSceneManifest: the template's is added, as an app built with the current SDK must adopt scenes`);
			plist.UIApplicationSceneManifest = SCENE_MANIFEST;
		}
		writeIfChanged(join(o.out, 'Info.plist'), writePlist(plist));
		settings.INFOPLIST_FILE = 'Info.plist';
	} else {
		// No App_Resources Info.plist: Xcode writes one from the build settings, into this one, which adopts scenes.
		writeIfChanged(join(o.out, 'Info.plist'), writePlist({ UIApplicationSceneManifest: SCENE_MANIFEST }));
		Object.assign(settings, {
			INFOPLIST_FILE: 'Info.plist',
			GENERATE_INFOPLIST_FILE: 'YES',
			INFOPLIST_KEY_UILaunchScreen_Generation: 'YES',
			INFOPLIST_KEY_UISupportedInterfaceOrientations: 'UIInterfaceOrientationPortrait',
			INFOPLIST_KEY_CFBundleDisplayName: o.name,
		});
	}

	const merged = mergedXcconfig(o.app, o.stubbed ?? new Set());
	const configured = (key: string) => merged.find((e) => e.kind === 'setting' && e.key.replace(/\[.*$/, '') === key);

	// app.entitlements: the plugins', then the app's.
	const entitlementFiles = [...plugins.map((p) => join(p, 'app.entitlements')), join(res, 'app.entitlements')].filter(existsSync);
	if (entitlementFiles.length) {
		let entitlements: PlistDict = {};
		for (const file of entitlementFiles) entitlements = mergePlist(entitlements, readPlist(file));
		writeIfChanged(join(o.out, `${o.name}.entitlements`), writePlist(entitlements));
		if (!configured('CODE_SIGN_ENTITLEMENTS')) settings.CODE_SIGN_ENTITLEMENTS = `${o.name}.entitlements`;
	} else rmSync(join(o.out, `${o.name}.entitlements`), { force: true });

	if (merged.length) writeIfChanged(join(o.out, 'build.xcconfig'), writeXcconfig(merged));
	else rmSync(join(o.out, 'build.xcconfig'), { force: true });
	// With pods, the app target's configuration is the pods' merged with build.xcconfig (`mergePodsXcconfig`) once `pod install` has written theirs.
	for (const c of ['debug', 'release']) {
		if (o.pods) writeFileSync(join(o.out, `build.${c}.xcconfig`), merged.length ? writeXcconfig(merged) : '');
		else rmSync(join(o.out, `build.${c}.xcconfig`), { force: true });
	}
	// The runtime template's default, which an app's build.xcconfig overrides.
	if (!configured('TARGETED_DEVICE_FAMILY')) settings.TARGETED_DEVICE_FAMILY = '"1,2"';
	const target = configured('IPHONEOS_DEPLOYMENT_TARGET');
	if (target && target.kind === 'setting' && parseFloat(target.value) < KIT_DEPLOYMENT_TARGET) {
		o.say(`App_Resources/iOS/build.xcconfig: IPHONEOS_DEPLOYMENT_TARGET ${target.value} raised to ${KIT_DEPLOYMENT_TARGET}.0, the oldest iOS the native build runs on`);
		settings.IPHONEOS_DEPLOYMENT_TARGET = `"${KIT_DEPLOYMENT_TARGET}.0"`;
	}

	// Everything else in App_Resources/iOS is copied into the bundle, as the CLI copies it to platforms/ios/<name>/Resources.
	// Both folders are assembled in a scratch folder and mirrored, so Xcode copies only what changed.
	const staging = mkdtempSync(join(tmpdir(), 'ns-compiled-resources-'));
	const staged = join(staging, 'Resources');
	const entries = existsSync(res)
		? readdirSync(res)
				.sort()
				.filter((f) => !NOT_RESOURCES.has(f) && !f.startsWith('.'))
		: [];
	if (entries.length) {
		mkdirSync(staged, { recursive: true });
		const folders: string[] = [];
		for (const f of entries) {
			cpSync(join(res, f), join(staged, f), { recursive: true });
			if (statSync(join(res, f)).isDirectory() && !BUNDLE_LIKE.test(f)) folders.push(f);
		}
		sources.push(`      - path: Resources\n        buildPhase: resources\n${folders.length ? `        excludes: [${folders.map((f) => JSON.stringify(f + '/**')).join(', ')}]\n` : ''}`);
		for (const f of folders) sources.push(`      - path: Resources/${f}\n        type: folder\n        buildPhase: resources\n`);
	}
	// What the app's own build copies beside its bundle, at `app/` where `~/assets/logo.png` resolves, and
	// its fonts, at `app/fonts/` where core registers them at launch.
	const appFiles = join(staging, 'AppFiles');
	const files = copiedAppFiles(o.appDir, readConfig(o.app).bundler === 'vite');
	for (const f of files) {
		mkdirSync(dirname(join(appFiles, 'app', f)), { recursive: true });
		copyFileSync(join(o.appDir, f), join(appFiles, 'app', f));
	}
	if (files.length) sources.push(`      - path: AppFiles/app\n        type: folder\n        buildPhase: resources\n`);
	for (const dir of ['Resources', 'AppFiles']) {
		if (existsSync(join(staging, dir))) mirror(join(staging, dir), join(o.out, dir));
		else rmSync(join(o.out, dir), { recursive: true, force: true });
	}
	rmSync(staging, { recursive: true, force: true });

	const team = configured('DEVELOPMENT_TEAM');
	return {
		settings,
		configFiles: o.pods ? { Debug: 'build.debug.xcconfig', Release: 'build.release.xcconfig' } : merged.length ? { Debug: 'build.xcconfig', Release: 'build.xcconfig' } : null,
		sources: sources.join(''),
		team: team?.kind === 'setting' ? team.value : undefined,
	};
}

/**
 * `mergePodXcconfigFile`: each configuration's pods xcconfig, with
 * build.xcconfig merged into it, as the app target's configuration file.
 */
export function mergePodsXcconfig(out: string, name: string) {
	const own = existsSync(join(out, 'build.xcconfig')) ? parseXcconfig(join(out, 'build.xcconfig')) : [];
	for (const c of ['debug', 'release']) {
		const pods = join(out, 'Pods', 'Target Support Files', `Pods-${name}`, `Pods-${name}.${c}.xcconfig`);
		writeIfChanged(join(out, `build.${c}.xcconfig`), writeXcconfig(mergeXcconfig(existsSync(pods) ? parseXcconfig(pods) : [], own)));
	}
}

const writeXcconfig = (entries: XcconfigEntry[]) => entries.map((e) => (e.kind === 'include' ? e.line : `${e.key} = ${e.value}`)).join('\n') + '\n';

/**
 * App_Resources/iOS/extensions/<name>/: an app extension target per folder,
 * as `IOSExtensionsService` adds it: its sources, `<app id>.<name>`, its
 * Info.plist, extension.json's frameworks and build settings (both
 * configurations', then the named one's), the Swift packages that name it,
 * the app's signing, and embedded in the app. An extension is a link of its
 * own, built without the app's dead code settings.
 */
export function iosExtensions(o: { app: string; out: string; bundle: string; packages: SwiftPackage[]; signing: Record<string, string>; team?: string; say: (m: string) => void }): { targets: string; dependencies: string; profiles: Record<string, string> } {
	const dir = join(appResourcesDir(o.app), 'iOS', 'extensions');
	const names = iosExtensionNames(o.app);
	for (const p of o.packages) for (const t of p.targets) if (!names.includes(t)) o.say(`the Swift package ${p.name} names a target ${t} the app does not have`);
	const provisioning = existsSync(join(dir, 'provisioning.json')) ? (JSON.parse(readFileSync(join(dir, 'provisioning.json'), 'utf8')) as Record<string, string>) : {};
	const profiles: Record<string, string> = {};
	const targets = names
		.map((name) => {
			const ext = join(dir, name);
			const json = existsSync(join(ext, 'extension.json')) ? JSON.parse(readFileSync(join(ext, 'extension.json'), 'utf8')) : {};
			const bundle = `${o.bundle}.${name}`;
			const rel = relative(o.out, ext);
			// Paths in extension.json are relative to the CLI's platforms/ios.
			const path = (v: unknown) => {
				if (typeof v !== 'string' || v.startsWith('/') || v.startsWith('$')) return v;
				const from = [resolve(o.app, 'platforms', 'ios', v), resolve(ext, v)].find(existsSync);
				return from ? relative(o.out, from) : v;
			};
			const values = (props: Record<string, unknown> | undefined) => Object.fromEntries(Object.entries(props ?? {}).map(([k, v]) => [k, /^(CODE_SIGN_ENTITLEMENTS|INFOPLIST_FILE)$/.test(k) ? path(pbxValue(v)) : pbxValue(v)]));
			const signing = { ...o.signing };
			if (signing.PROVISIONING_PROFILE_SPECIFIER) {
				delete signing.PROVISIONING_PROFILE_SPECIFIER;
				if (provisioning[bundle]) signing.PROVISIONING_PROFILE_SPECIFIER = profiles[bundle] = provisioning[bundle];
			}
			const base: Record<string, unknown> = {
				PRODUCT_BUNDLE_IDENTIFIER: bundle,
				PRODUCT_NAME: name,
				...(existsSync(join(ext, 'Info.plist')) ? { INFOPLIST_FILE: join(rel, 'Info.plist') } : {}),
				LD_RUNPATH_SEARCH_PATHS: '$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks',
				SKIP_INSTALL: 'YES',
				SWIFT_LTO: 'NO',
				OTHER_SWIFT_FLAGS: '',
				...(o.team ? { DEVELOPMENT_TEAM: o.team } : {}),
				...signing,
				...(json.assetcatalogCompilerAppiconName ? { ASSETCATALOG_COMPILER_APPICON_NAME: json.assetcatalogCompilerAppiconName } : {}),
				...values(json.targetBuildConfigurationProperties),
			};
			const named = json.targetNamedBuildConfigurationProperties ?? {};
			const configs = (['Debug', 'Release'] as const).map((c) => [c, values(named[c.toLowerCase()])] as const).filter(([, v]) => Object.keys(v).length);
			const settings = (entries: Record<string, unknown>, indent: string) =>
				Object.entries(entries)
					.map(([k, v]) => `${indent}${k}: ${yamlValue(v)}\n`)
					.join('');
			const deps = [...((json.frameworks ?? []) as string[]).map((f) => `      - sdk: ${f}\n`), productLines(o.packages.filter((p) => p.targets.includes(name)))].join('');
			return `  ${name}:
    type: app-extension
    platform: iOS
    sources:
      - path: ${JSON.stringify(rel)}
        excludes: ["extension.json", "Info.plist", "*.entitlements", "Podfile"]
${deps ? `    dependencies:\n${deps}` : ''}    settings:
      base:
${settings(base, '        ')}${configs.length ? `      configs:\n${configs.map(([c, v]) => `        ${c}:\n${settings(v, '          ')}`).join('')}` : ''}`;
		})
		.join('');
	return { targets, dependencies: names.map((n) => `      - target: ${n}\n        embed: true\n`).join(''), profiles };
}

export function iosExtensionNames(app: string): string[] {
	const dir = join(appResourcesDir(app), 'iOS', 'extensions');
	return existsSync(dir)
		? readdirSync(dir)
				.sort()
				.filter((f) => !f.startsWith('.') && statSync(join(dir, f)).isDirectory())
				.sort()
		: [];
}

/** A value as the CLI writes it into the pbxproj: `"\"-O\""` is `-O`, `"(\"DEBUG=1\",\"$(inherited)\",)"` a list. */
function pbxValue(v: unknown): unknown {
	if (typeof v !== 'string') return v;
	const t = v.trim();
	const list = /^\(([\s\S]*)\)$/.exec(t);
	if (list) return [...list[1].matchAll(/"((?:[^"\\]|\\.)*)"|([^\s,"]+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]));
	return /^"[\s\S]*"$/.test(t) ? t.slice(1, -1).replace(/\\(.)/g, '$1') : v;
}

const yamlValue = (v: unknown): string => (Array.isArray(v) ? `[${v.map((x) => JSON.stringify(String(x))).join(', ')}]` : JSON.stringify(String(v)));

type XcconfigEntry = { kind: 'include'; line: string } | { kind: 'setting'; key: string; value: string };

function parseXcconfig(file: string): XcconfigEntry[] {
	const out: XcconfigEntry[] = [];
	for (const raw of readFileSync(file, 'utf8').split('\n')) {
		const line = raw.replace(/\/\/.*$/, '').trim();
		if (!line) continue;
		const include = /^#include(\??)\s+"([^"]+)"/.exec(line);
		if (include) {
			out.push({ kind: 'include', line: `#include${include[1]} "${resolve(dirname(file), include[2])}"` });
			continue;
		}
		const m = /^([A-Za-z_][\w]*(?:\[[^\]]*\])*)\s*=\s*(.*?);?$/.exec(line);
		if (m) out.push({ kind: 'setting', key: m[1], value: m[2].trim() });
	}
	return out;
}

const INHERITED = /\$[({]inherited[)}]/;

/** `XcconfigService.mergeFiles`: a key already set wins, unless its value inherits, in which case the incoming value is appended. */
function mergeXcconfig(into: XcconfigEntry[], from: XcconfigEntry[]): XcconfigEntry[] {
	const out = into.map((e) => ({ ...e }));
	for (const e of from) {
		if (e.kind === 'include') {
			if (!out.some((x) => x.kind === 'include' && x.line === e.line)) out.push(e);
			continue;
		}
		const kept = out.find((x): x is Extract<XcconfigEntry, { kind: 'setting' }> => x.kind === 'setting' && x.key === e.key);
		if (!kept) {
			out.push({ ...e });
			continue;
		}
		if (INHERITED.test(kept.value)) {
			const appended = e.value.replace(INHERITED, '').trim();
			if (appended) kept.value = `${kept.value} ${appended}`;
		}
	}
	return out;
}
