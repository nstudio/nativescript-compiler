// The test suite a harness runs: this folder (the compiler's own, with no framework), or a folder laid out as it is that
// $NS_TEST_SUITE names, such as a framework adapter's tests run through a checkout of the compiler:
//   diff/cases/            the differential cases (tests/diff/run.ts, tests/fuzz/run.ts)
//   diff/known-failures.json
//   fuzz/known-fuzz-failures.json
//   package.json           what the cases are typed against, installed in its node_modules
//   suite.json             SuiteConfig
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FrameworkAdapter } from '../src/api/adapter-api.ts';
import { adapterEntry, adapterOf, availableAdapters, loadAdapter, type AdapterManifest } from '../src/adapters/load.ts';
import { adapterKitOf } from '../src/adapters/active.ts';
import { BuildContext } from '../src/program/build-context.ts';

export interface SuiteConfig {
  /** The framework whose adapter translates the suite's cases, found as an app's is ($NS_COMPILER_ADAPTERS, or the suite's package.json). */
  adapter?: string;
  /** The adapter's kit sources the host runtimes link (the reactive core its cases run on, which builds without core's views), by file name without its extension. */
  hostRuntime?: string[];
  /**
   * Modules Node imports from a port the adapter ships rather than from the package, in a case with a `// @<tag>` line,
   * by tag: what the case's translation compiles in place of the package.
   */
  nodePorts?: Record<string, { specifier: string; file: string }>;
  /** How many of the suite's cases the per-merge fuzz set draws (tests/fuzz/run.ts). */
  mergeCases?: number;
}

const own = dirname(fileURLToPath(import.meta.url));
/** The suite's folder. */
export const suiteDir = resolve(process.env.NS_TEST_SUITE ?? own);
export const suiteConfig: SuiteConfig = existsSync(join(suiteDir, 'suite.json')) ? JSON.parse(readFileSync(join(suiteDir, 'suite.json'), 'utf8')) : {};
export const diffCases = join(suiteDir, 'diff/cases');
export const knownFailuresFile = join(suiteDir, 'diff/known-failures.json');
export const knownFuzzFailuresFile = join(suiteDir, 'fuzz/known-fuzz-failures.json');
/** What the cases are typed against, as an app's node_modules would hold it. */
export const suiteModules = process.env.NS_DIFF_MODULES ?? join(suiteDir, 'node_modules');

/** The suite's adapter as found, or null for a suite with no framework. */
export const suiteAdapterPackage: AdapterManifest | null = suiteConfig.adapter ? adapterOf(suiteConfig.adapter, availableAdapters(suiteDir)) : null;
/** The build the suite's adapter is loaded with: its core API (`CoreApi.stubbedPlugins`, the defines) reads this one's. */
export const suiteAdapterBuild = new BuildContext();
export const suiteAdapter: FrameworkAdapter | null = suiteAdapterPackage && (await loadAdapter(suiteAdapterPackage, suiteAdapterBuild));
suiteAdapterBuild.useAdapter(suiteAdapter);

/** A build of the suite's: one per program a harness translates, its adapter the suite's. */
export function suiteBuild(): BuildContext {
  const build = new BuildContext();
  build.useAdapter(suiteAdapter);
  return build;
}

/** A module of the suite's adapter beside its entry, by its file's name without the extension: the instance its entry loaded and gave the compiler's functions. */
export function adapterModule(name: string): Promise<any> {
  if (!suiteAdapterPackage) throw new Error(`the suite at ${suiteDir} names no adapter (suite.json)`);
  const entry = adapterEntry(suiteAdapterPackage);
  return import(pathToFileURL(join(dirname(entry), name + extname(entry))).href);
}

/** The adapter's kit sources the host runtimes link: Swift and Kotlin. */
export function hostRuntimeSources(): { swift: string[]; kotlin: string[] } {
  const names = suiteConfig.hostRuntime ?? [];
  if (!names.length || !suiteAdapter) return { swift: [], kotlin: [] };
  const kit = adapterKitOf(suiteAdapter);
  return { swift: names.map((f) => join(kit.apple!, `${f}.swift`)), kotlin: names.map((f) => join(kit.android!, `${f}.kt`)) };
}

/** A port's file (nodePorts), absolute. */
export function nodePortFile(file: string): string {
  if (!suiteAdapterPackage) throw new Error(`the suite at ${suiteDir} names no adapter for its Node ports (suite.json)`);
  return resolve(suiteAdapterPackage.root, file);
}
