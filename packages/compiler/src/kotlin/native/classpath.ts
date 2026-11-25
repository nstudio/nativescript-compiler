// The classpath an Android build's Kotlin is checked against: android.jar, core's widgets, the plugins' archives and
// androidx at the versions Gradle resolves.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClassPath, androidJar, newer } from './classfiles.ts';
import { KIT_ANDROID } from '../../driver/paths.ts';

/** The SDK the generated Gradle project compiles against (targets/android/build.ts). */
const COMPILE_SDK = 36;
/** The Kotlin the generated app builds with (targets/android/build.ts). */
const KOTLIN_VERSION = '2.2.20';
const KIT_GRADLE = join(KIT_ANDROID, 'build.gradle.kts');

/**
 * The classpath translated code is checked against: android.jar, core's widgets AAR, the plugins'
 * archives, and androidx at the versions Gradle resolves: the highest the kit or a plugin asks for.
 */
export function androidClassPath(widgetsAar: string | null, plugins?: { archives: string[]; dependencies: { coords: string }[] }): ClassPath {
	const pinned = new Map<string, string>();
	const pin = (artifact: string, version: string) => {
		if (!pinned.has(artifact) || newer(version, pinned.get(artifact)!)) pinned.set(artifact, version);
	};
	if (existsSync(KIT_GRADLE)) for (const m of readFileSync(KIT_GRADLE, 'utf8').matchAll(/"([a-z][\w.]*):([\w.-]+):([\w.-]+)"/g)) pin(`${m[1]}:${m[2]}`, m[3]);
	for (const d of plugins?.dependencies ?? []) {
		const [group, artifact, version] = d.coords.split(':');
		if (version) pin(`${group}:${artifact}`, version);
	}
	pin('org.jetbrains.kotlin:kotlin-stdlib', KOTLIN_VERSION);
	return new ClassPath([androidJar(COMPILE_SDK), ...(widgetsAar ? [widgetsAar] : []), ...(plugins?.archives ?? [])], pinned);
}
