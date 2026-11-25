// A worker translating one instrumented case per message, so that the run translates several at once: a translation
// builds a whole program, seconds each, and the halving searches translate the same case many times.
import { parentPort } from 'node:worker_threads';
import { translateKotlin, translateSwift } from '../native-build.ts';
import { kotlinOptions, swiftOptions } from '../diff/case-options.ts';

export interface TranslateJob { target: 'swift' | 'kotlin'; root: string; file: string; out: string; pkg: string; modules?: string }
export type TranslateResult = { inits: { init: string; initThrows?: boolean }[] } | { error: string };

parentPort!.on('message', ({ id, job }: { id: number; job: TranslateJob }) => {
  let result: TranslateResult;
  try {
    // Every instrumented site converts an untyped value by design: the copies a release refuses are the diff run's to check.
    const modules = job.target === 'swift' ? translateSwift([job.root], job.out, { ...swiftOptions(job.file), modules: job.modules, copiesChecked: false }) : translateKotlin([job.root], job.out, job.pkg, { ...kotlinOptions(job.file), modules: job.modules, copiesChecked: false });
    result = { inits: modules.filter((m) => m.init).map((m) => ({ init: m.init!, initThrows: 'initThrows' in m && Boolean(m.initThrows) })) };
  } catch (e) {
    result = { error: (e as Error).message };
  }
  parentPort!.postMessage({ id, result });
});
