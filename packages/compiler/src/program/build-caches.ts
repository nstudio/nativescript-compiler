// Caches that outlive a translation but not a build: what files on disk say (package.json names, tsconfig strictness, SDK
// symbol tables) and what a build registers beside them (a plugin's symbol tables, the module its typings declare). Each
// is kept by the module that reads it, read through by path or name; `compile()` clears them all as a build starts, so
// a build in a long-lived process reads its own files and registrations, never an earlier build's.
const caches: { clear(): void }[] = [];

/** `cache`, cleared when a build starts. */
export function buildCache<T extends { clear(): void }>(cache: T): T {
	caches.push(cache);
	return cache;
}

export function clearBuildCaches(): void {
	for (const c of caches) c.clear();
}
