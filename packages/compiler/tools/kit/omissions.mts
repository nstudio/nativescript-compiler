/**
 * The published kit is generated with --partial: a construct of core the compiler does not translate is left out of it,
 * the rest written. omissions.json lists what may be left out; anything else stops generation, so core code the
 * compiler cannot translate never drops out of a release silently.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Omission {
	owner: string;
	cause: string;
}

/** An omission as listed: its file and message, without the line and column that move as core changes. */
export function signature(error: string): string {
	return error.replace(/^([^:\n]+):\d+(?::\d+)?: /, '$1: ');
}

/** The problems with `errors` (what generation left out for `platform`) against the list: unlisted, or listed and gone. */
export function omissionProblems(platform: 'ios' | 'android', errors: readonly string[]): string[] {
	const listed: Record<string, Omission> = JSON.parse(readFileSync(join(import.meta.dirname, 'omissions.json'), 'utf8'))[platform];
	const seen = new Set(errors.map(signature));
	return [
		...[...seen].filter((s) => !Object.hasOwn(listed, s)).map((s) => `left out of the ${platform} kit, not in tools/kit/omissions.json: ${s}`),
		...Object.keys(listed)
			.filter((s) => !seen.has(s))
			.map((s) => `listed in tools/kit/omissions.json (${platform}) but no longer left out: ${s}`),
	];
}
