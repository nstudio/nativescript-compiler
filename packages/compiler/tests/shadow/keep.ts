// Shadow mode (NS_KEEP_SHADOW=<file>): each site where a backend builds a second container for a value it already
// holds (an elementwise copy, an upcast or widening rebuild, a checked read of an untyped array) is recorded, one JSON
// line per emission, so the sites a `keep` carrier would remove can be counted before any emission changes.
import { appendFileSync } from 'node:fs';
import type { KeepKind } from '../../src/semantics/observers.ts';

export function shadowKeep(backend: 'swift' | 'kotlin', kind: KeepKind, from: string, to: string, file: string | null | undefined, library: boolean, line?: number): void {
	const out = process.env.NS_KEEP_SHADOW;
	if (out) appendFileSync(out, JSON.stringify({ backend, kind, from, to, file: file ?? null, line: line ?? null, library }) + '\n');
}
