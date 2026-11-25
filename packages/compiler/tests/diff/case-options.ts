// What a diff case's first lines say about how it is checked and translated, for every harness that runs the cases.
import { readFileSync } from 'node:fs';
import type { KotlinOptions, SwiftOptions } from '../native-build.ts';
import { suiteConfig } from '../suite.ts';
import { Refusal, type RefusalLog } from '../../src/semantics/refusals.ts';

const head = (file: string) => readFileSync(file, 'utf8');

/**
 * A case starting `// @lenient` is checked as core is, without strictNullChecks, and translated
 * as the kit generated from core is, lenient and in library mode (Swift only, as the kit is
 * generated for iOS first). One starting `// @lenient-kotlin` is translated so as Kotlin only,
 * as kotlin/kit-gen.ts generates kit-android; one starting `// @lenient-both` so as both.
 */
export const lenient = (file: string) => head(file).startsWith('// @lenient');
export const lenientBoth = (file: string) => head(file).startsWith('// @lenient-both');
export const kotlinOnly = (file: string) => head(file).startsWith('// @lenient-kotlin');
/** A case starting `// @kotlin` (with its reason, `onlyOn`) is not run as Swift. */
export const kotlinApp = (file: string) => head(file).startsWith('// @kotlin');
/** A case starting `// @plugin` is a non-strict app whose imports from `helpers/plugin/` are a plugin's, compiled from its source (Swift only). */
export const pluginCase = (file: string) => head(file).startsWith('// @plugin');
/** One starting `// @plugin-both` is translated so on both targets. */
export const pluginBoth = (file: string) => head(file).startsWith('// @plugin-both');
/** A case starting `// @app-lenient` is a non-strict app's own code (`strict: false` in its tsconfig.json), on both targets. */
export const appLenient = (file: string) => head(file).startsWith('// @app-lenient');
/**
 * A `// @cli-program` line: an `@app-lenient` case is translated from the strictly typed program the CLI translates an
 * app from (its checks the app's own), where a value the app types `T | null` is held as such; without it, from a program
 * checked as the app's build is.
 */
export const cliProgram = (file: string) => /^\/\/ @cli-program$/m.test(head(file));
/**
 * A case starting `// @swift`, or with a `// @swift` line after another tag's (with its reason, `onlyOn`), is not run as
 * Kotlin.
 */
export const swiftOnly = (file: string) => (lenient(file) && !kotlinOnly(file) && !lenientBoth(file)) || (pluginCase(file) && !pluginBoth(file)) || head(file).startsWith('// @swift') || /^\/\/ @swift(?: .*)?$/m.test(head(file));

/**
 * A case's `// @swift <reason>` or `// @kotlin <reason>` line: the backend it runs on, and why not the other: `ledger:<entry>`,
 * a field of src/semantics/ledger.ts the two backends' ledgers give different values, or `refused:<id>`, the refusal the
 * other backend gives the case (tests/checks/both-backends.ts holds every case to one). Null for a case on both.
 */
export function onlyOn(file: string): { backend: 'swift' | 'kotlin'; reason: string } | null {
  const m = /^\/\/ @(swift|kotlin)(?: (.*))?$/m.exec(head(file));
  return m ? { backend: m[1] as 'swift' | 'kotlin', reason: m[2]?.trim() ?? '' } : null;
}

export const runsOn = (file: string, target: 'swift' | 'kotlin') => (target === 'swift' ? !kotlinOnly(file) && !kotlinApp(file) : !swiftOnly(file));

/** `// @weak-fields A.b C.d` and `// @weak-captures A.e` lines: what the kit's configuration holds weakly (tools/kit/modules.mts). */
export function weakOf(file: string) {
  const text = head(file);
  const list = (tag: string) => [...text.matchAll(new RegExp(`^// @${tag} (.+)$`, 'gm'))].flatMap((m) => m[1].trim().split(/\s+/));
  return { fields: list('weak-fields'), captures: list('weak-captures') };
}

/**
 * A `// @exit <n>` line: the status the case ends with when not 0, natively as under Node. Node's run of a case declaring
 * none must end with 0 and print something.
 */
export const expectedExit = (file: string) => Number(/^\/\/ @exit (\d+)$/m.exec(head(file))?.[1] ?? 0);

/** A `// @members-by-name` line: the case is translated as an XML app's code is, its classes' accessors and methods readable by name (core's Builder binds to them). */
export const membersByName = (file: string) => /^\/\/ @members-by-name$/m.test(head(file));

/**
 * A `// @xml-keys k…` line: the case is translated as an XML app with no run-time XML site is, its classes' members read
 * by name only by the keys listed (the XML's) and those its code names (src/xml/keys.ts); its `helpers/xml-*.ts` modules
 * are the code generated from the XML.
 */
export const xmlKeysOf = (file: string) => /^\/\/ @xml-keys (.+)$/m.exec(head(file))?.[1].trim().split(/\s+/);

/** A `// @assign-fields` line: the case's class fields are assigned in the constructor, not defined, as in an app whose target is below ES2022. */
export const assignFields = (file: string) => /^\/\/ @assign-fields$/m.test(head(file));

export const swiftOptions = (file: string): SwiftOptions => ({ lenient: lenient(file), weak: weakOf(file), membersByName: membersByName(file), xmlKeys: xmlKeysOf(file), plugin: pluginCase(file), lenientApp: appLenient(file), cliProgram: cliProgram(file), assignFields: assignFields(file), keepGoing: keepGoingWith(file) });
export const kotlinOptions = (file: string): KotlinOptions => ({ lenient: lenient(file), membersByName: membersByName(file), xmlKeys: xmlKeysOf(file), plugin: pluginCase(file), lenientApp: appLenient(file), cliProgram: cliProgram(file), assignFields: assignFields(file), keepGoing: keepGoingWith(file) });

/**
 * A `// @packages [specifier=file…]` line: the case imports the fixture packages under `cases/helpers/plugin/packages/`,
 * installed beside tests/node_modules' and compiled from their source as an app's plugins are. Node's ES module loader
 * imports no directory, so its run imports each listed specifier from the package file given (relative to node_modules).
 */
export const packagesOf = (file: string): Record<string, string> | null => {
  const line = /^\/\/ @packages\b(.*)$/m.exec(head(file));
  return line ? Object.fromEntries(line[1].trim().split(/\s+/).filter(Boolean).map((m) => m.split('=') as [string, string])) : null;
};

/**
 * `text`, the source of `file` (a case or its helper) `depth` directories below a nodeImportRoot directory, with the
 * imports Node can't resolve as the translator does pointed at what it compiles: a port the suite names (a `// @<tag>`
 * line of its `nodePorts`), a package's file.
 */
export function nodeImports(file: string, text: string, depth: number): string {
  const ported = Object.entries(suiteConfig.nodePorts ?? {}).reduce((t, [tag, { specifier }]) => (new RegExp(`^// @${tag}$`, 'm').test(head(file)) ? t.replaceAll(`from '${specifier}'`, `from '${'../'.repeat(depth) || './'}__${tag}.ts'`) : t), text);
  return Object.entries(packagesOf(file) ?? {}).reduce((t, [specifier, path]) => t.replaceAll(`'${specifier}'`, `'${path}'`), ported);
}

/**
 * A `// @keep-going <text>` line: translated as `--keep-going --all-errors` builds an app, every error must contain
 * <text> (one at least), and what was written must compile and print what Node does.
 */
export const keepGoingWith = (file: string) => /^\/\/ @keep-going (.+)$/m.exec(head(file))?.[1].trim();

/**
 * A `// @refused <text>` line: translating the case must fail with a message containing <text>; nothing is run. A
 * `// @refused-swift <text>` or `// @refused-kotlin <text>` line says so of that target only: the other runs the case.
 */
export const refusedWith = (file: string, target?: 'swift' | 'kotlin') =>
  (target && new RegExp(`^// @refused-${target} (.+)$`, 'm').exec(head(file))?.[1].trim()) || /^\/\/ @refused (.+)$/m.exec(head(file))?.[1].trim();

/**
 * A `// @uncaught` line: the case ends on an uncaught error (with its `@exit` status), and the native run's stderr must
 * hold the error's `Name: message` line as Node prints it.
 */
export const uncaught = (file: string) => /^\/\/ @uncaught$/m.test(head(file));

/**
 * The refusal id (src/semantics/refusals.ts) of a translation's error: the innermost refusal where a translator reports
 * it again in its own (an `internal` refusal's cause); for errors collected as text, the first one's, as the build that
 * made them (`refusals`, tests/native-build.ts) names it.
 */
export function refusalId(err: Error & { refusals?: RefusalLog }): string | undefined {
  let message = err.message;
  for (let inner; (inner = /what fails translating with "(.*)" is not supported/s.exec(message)); ) message = inner[1];
  const collected = err.refusals?.sitesOf(message.split('\n')[0])[0]?.id;
  if (collected) return collected;
  let id: string | undefined;
  for (let e: unknown = err; e instanceof Error; e = e.cause) if (e instanceof Refusal) id = e.id;
  return id;
}

/** Whether the case named `name` is one of `args`: its number or its whole name, or any case a `<prefix>*` argument begins. */
export const selects = (args: string[], name: string) =>
  !args.length || args.some((a) => (a.endsWith('*') ? name.startsWith(a.slice(0, -1)) : name === a || name.startsWith(a + '-')));

/** The names among `names` that `args` select. An argument selecting none throws: a misspelt name would test nothing. */
export function selected(args: string[], names: string[]): string[] {
  const none = args.filter((a) => !names.some((n) => selects([a], n)));
  if (none.length) throw new Error(`no case is ${none.join(', ')}: a case argument is a case's number or whole name (without .ts), or <prefix>*`);
  return names.filter((n) => selects(args, n));
}
