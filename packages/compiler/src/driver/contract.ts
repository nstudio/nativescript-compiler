// The versions a compiled release is built against, checked before anything
// is compiled:
// - the app's @nativescript/core against the core the kit was generated from.
//   The kit is core's logic; the native widgets it drives (TNSWidgets,
//   widgets-release.aar) come from the app's installed core, so the two must
//   be the same release.
// - the framework adapter's part of the kit's index against the kit: what
//   the adapter's Swift adds to the kit's own index, generated with the kit
//   and so from the same core.
// - the app's framework packages against the ranges the framework's adapter
//   is tested with (its package.json `nativescript.compilerAdapter.testedVersions`).
//   They are not peer dependencies: an optional peer still constrains a
//   framework's package that another framework pulls in, and fails npm install.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ANDROID, KIT_APPLE_SOURCES } from './paths.ts';
import type { AdapterManifest } from '../adapters/load.ts';
import { KIT_MANIFEST_FILE } from '../kit/manifest.ts';

export interface KitManifest {
	core: string;
	commit: string;
}

/** The manifest of the kit a build links: iOS's generated Core, or Android's generated kit; null where it is not generated. */
export function kitManifest(platform: 'ios' | 'android'): (KitManifest & { file: string }) | null {
	const file = platform === 'ios' ? join(KIT_APPLE_SOURCES, 'Core', 'manifest.json') : join(KIT_ANDROID, 'generated', 'manifest.json');
	if (!existsSync(file)) return null;
	const m = JSON.parse(readFileSync(file, 'utf8'));
	return { core: m.core, commit: m.commit, file };
}

/** The version of `pkg` installed for the app (its own node_modules or a parent's). */
export function installedVersion(app: string, pkg: string): string | null {
	for (let dir = app; ; dir = join(dir, '..')) {
		const file = join(dir, 'node_modules', pkg, 'package.json');
		if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')).version ?? null;
		if (join(dir, '..') === dir) return null;
	}
}

export interface ContractOptions {
	app: string;
	platform: 'ios' | 'android';
	/** The adapter of the framework the app is written with; null for one with none (`core`). */
	adapter: Pick<AdapterManifest, 'name' | 'version' | 'testedVersions'> | null;
	/** `release.allowCoreMismatch`: a different core is a warning. */
	allowCoreMismatch: boolean;
	/** `release.allowUntestedFrameworks`: a framework outside the tested range is a warning. */
	allowUntestedFrameworks: boolean;
	/** The adapter's Swift added to the iOS kit (`FrameworkAdapter.kit.apple`), as an absolute path. */
	adapterApple?: string;
}

/** Problems with the app's versions: `errors` stop the build, `warnings` are printed. */
export function checkContract(o: ContractOptions): { errors: string[]; warnings: string[] } {
	const errors: string[] = [],
		warnings: string[] = [];
	const kit = kitManifest(o.platform);
	const core = installedVersion(o.app, '@nativescript/core');
	if (kit && core && kit.core !== core) {
		const message = `@nativescript/core ${core} is installed, but this @nstudio/nativescript-compiler's ${o.platform === 'ios' ? 'iOS' : 'Android'} kit was generated from core ${kit.core}: ` + `the compiled app would run core ${kit.core}'s code over core ${core}'s native widgets. ` + `Install @nativescript/core@${kit.core}, or the @nstudio/nativescript-compiler released with core ${core}.`;
		if (o.allowCoreMismatch) warnings.push(`${message} (building anyway: release.allowCoreMismatch)`);
		else errors.push(`${message} release.allowCoreMismatch: true builds anyway.`);
	}
	const fragment = o.platform === 'ios' && o.adapterApple ? join(o.adapterApple, KIT_MANIFEST_FILE) : null;
	if (kit && fragment) {
		const generated = existsSync(fragment) ? JSON.parse(readFileSync(fragment, 'utf8')).core : undefined;
		if (generated !== kit.core) errors.push(`${fragment} ${generated === undefined ? 'is missing' : `was generated with a kit from core ${generated}`}, and the iOS kit is core ${kit.core}'s: generate the kits again (nx run compiler:kit).`);
	}
	for (const [pkg, range] of Object.entries(o.adapter?.testedVersions ?? {})) {
		const version = installedVersion(o.app, pkg);
		if (!version || satisfies(version, range)) continue;
		const message = `${pkg} ${version} is outside the versions ${o.adapter!.name} ${o.adapter!.version} is tested with (${range}): its front end reads that package's templates and APIs as those versions write them.`;
		if (o.allowUntestedFrameworks) warnings.push(`${message} (building anyway: release.allowUntestedFrameworks)`);
		else errors.push(`${message} Install a version in that range, or set release.allowUntestedFrameworks: true to build anyway.`);
	}
	return { errors, warnings };
}

type Version = { n: [number, number, number]; pre: (string | number)[] };

function parse(v: string): Version | null {
	const m = /^\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-([\w.-]+))?(?:\+[\w.-]+)?\s*$/.exec(v);
	if (!m) return null;
	const num = (s: string | undefined) => (s === undefined || s === 'x' || s === '*' ? 0 : +s);
	return { n: [+m[1], num(m[2]), num(m[3])], pre: m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? +p : p)) : [] };
}

function compare(a: Version, b: Version): number {
	for (let k = 0; k < 3; k++) if (a.n[k] !== b.n[k]) return a.n[k] - b.n[k];
	if (!a.pre.length || !b.pre.length) return (a.pre.length ? -1 : 0) + (b.pre.length ? 1 : 0);
	for (let k = 0; k < Math.max(a.pre.length, b.pre.length); k++) {
		const x = a.pre[k],
			y = b.pre[k];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		if (x === y) continue;
		if (typeof x === 'number' && typeof y === 'number') return x - y;
		if (typeof x === 'number') return -1;
		if (typeof y === 'number') return 1;
		return x < y ? -1 : 1;
	}
	return 0;
}

/**
 * Whether `version` is in `range`: `||` of space-separated comparators (`>=`, `>`, `<=`, `<`, `=`), `^x.y.z`, `~x.y.z`, an
 * exact version or `*`. A prerelease orders before its release and is otherwise compared like any version.
 */
export function satisfies(version: string, range: string): boolean {
	const v = parse(version);
	if (!v) return false;
	return range.split('||').some((set) =>
		set
			.trim()
			.split(/\s+/)
			.filter(Boolean)
			.every((c) => {
				if (c === '*' || c === 'x') return true;
				const m = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(c)!;
				const at = parse(m[2]);
				if (!at) return false;
				const d = compare(v, at);
				switch (m[1]) {
					case '>=':
						return d >= 0;
					case '>':
						return d > 0;
					case '<=':
						return d <= 0;
					case '<':
						return d < 0;
					case '^': {
						const upper: Version = at.n[0] > 0 ? { n: [at.n[0] + 1, 0, 0], pre: [0] } : at.n[1] > 0 ? { n: [0, at.n[1] + 1, 0], pre: [0] } : { n: [0, 0, at.n[2] + 1], pre: [0] };
						return d >= 0 && compare(v, upper) < 0;
					}
					case '~':
						return d >= 0 && compare(v, { n: [at.n[0], at.n[1] + 1, 0], pre: [0] }) < 0;
					default:
						return d === 0;
				}
			}),
	);
}
