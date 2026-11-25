import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The package's root: the compiler's sources in `src`, beside the kits every compiled app links. */
export const PACKAGE = fileURLToPath(new URL('../..', import.meta.url));
/** NativeScriptKit for Apple platforms: a Swift package. */
export const KIT_APPLE = join(PACKAGE, 'kit-apple');
export const KIT_APPLE_SOURCES = join(KIT_APPLE, 'Sources', 'NativeScriptKit');
/** NativeScriptKit for Android: a Gradle project. */
export const KIT_ANDROID = join(PACKAGE, 'kit-android');
export const BIN = join(PACKAGE, 'bin');

/**
 * Where the compiler keeps what it fetches and derives once per machine (plugins' sources, their Android libraries,
 * tools it downloads), outside the installed package: $NS_COMPILED_CACHE, else `nativescript/compiled` in
 * $XDG_CACHE_HOME (default ~/.cache).
 */
export function cacheDir(...parts: string[]): string {
	return join(process.env.NS_COMPILED_CACHE ?? join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'nativescript', 'compiled'), ...parts);
}
