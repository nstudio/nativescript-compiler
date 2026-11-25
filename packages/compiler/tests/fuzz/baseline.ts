// The fuzz baseline. The suite's fuzz/known-fuzz-failures.json is checked in: the seed, the cases the per-merge set draws
// from, the builds whose instrumented baseline differs, and per backend a summary of the full list of known failures (how
// many, a digest of their keys, how many per cluster) with the known failures among the variants the per-merge set
// draws, which is all a per-merge run reads. Each backend's full list, every variant known not to match Node with its
// cause, is kept outside git, in the build cache's fuzz-baseline folder ($NS_FUZZ_BASELINE) under its digest: written by
// `--update-baseline`, and by a whole nightly run that fails on exactly the variants the summary names. A suite whose file
// holds no summary is an older layout: the file is the full list.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cacheRoot } from '../build-cache.ts';
import { compareText } from '../../src/program/order.ts';

export const TARGETS = ['swift', 'kotlin'] as const;
/** Variant key (`<case>|<line:col:site kind>|<wrong value>`) to its cause (`<cluster>: <detail>`). */
export type Entries = Record<string, string>;
/** `run`: the variants the last whole nightly run ran on the backend, of which `variants` are known failures. */
export interface Summary { variants: number; run?: number; keys: string; clusters: Record<string, number> }
export interface Stored {
  $comment?: string;
  seed?: number;
  cases?: string[];
  baselineDiffers?: Record<string, Entries>;
  full?: Record<string, Summary>;
  swift?: Entries;
  kotlin?: Entries;
}

export const caseOf = (key: string) => key.slice(0, key.indexOf('|'));
const clusterOf = (cause: string) => cause.split(':')[0];
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
/** A digest of a set of variant keys, whatever their order. */
export const keysDigest = (keys: Iterable<string>) => sha256([...keys].sort().join('\n'));

export function summarize(entries: Entries): Summary {
  const clusters: Record<string, number> = {};
  for (const cause of Object.values(entries)) clusters[clusterOf(cause)] = (clusters[clusterOf(cause)] ?? 0) + 1;
  return { variants: Object.keys(entries).length, keys: keysDigest(Object.keys(entries)), clusters: Object.fromEntries(Object.entries(clusters).sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))) };
}

/** Where a backend's full list with this summary is kept. */
export function fullListFile(target: string, summary: Summary): string {
  return join(process.env.NS_FUZZ_BASELINE ?? join(cacheRoot, 'fuzz-baseline'), `${target}-${summary.keys.slice(0, 16)}.json`);
}

/** Per backend, the full list `stored` summarizes, or null when it is not where fullListFile says. */
export function loadFull(stored: Stored): Record<string, Entries | null> {
  if (!stored.full) return { swift: stored.swift ?? {}, kotlin: stored.kotlin ?? {} };
  return Object.fromEntries(TARGETS.map((t) => {
    const summary = stored.full![t];
    const file = summary && fullListFile(t, summary);
    if (!file || !existsSync(file)) return [t, null];
    const list: Entries = JSON.parse(readFileSync(file, 'utf8'));
    if (keysDigest(Object.keys(list)) !== summary.keys) throw new Error(`${file}: not the ${t} list known-fuzz-failures.json summarizes`);
    return [t, list];
  }));
}

/** Writes a backend's full list where fullListFile says, and returns that path. */
export function saveFull(target: string, list: Entries): string {
  const file = fullListFile(target, summarize(list));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(list).sort(([a], [b]) => compareText(a, b))), null, '\t') + '\n');
  return file;
}
