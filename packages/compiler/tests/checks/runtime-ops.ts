#!/usr/bin/env node
// The runtime functions translated code calls are the operations of src/semantics/runtime.ts:
// - each operation's name in each column is a public top-level function of that kit, as the translator's index reads
//   it (`Type.member`: a static member of the kit's type), so a misspelled or removed helper fails here;
// - no string or template text spells a call of one (`jsAdd(`, `jsReport {`, `jsCast<`): src/swift/ and
//   src/targets/ios/ write `${RT.op}(`, src/kotlin/ and src/targets/android/ likewise, and src/semantics/ takes the
//   backend's column. A name counts when it is a kit function's that starts `js`, or one the table names; text that
//   only names an operation (`helper('jsUnwrap', …)`, a mark's) is no call.
//   node tests/checks/runtime-ops.ts
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { KIT_GLOBALS, kitIndex, type KitType } from '../../src/kit/kit-index.ts';
import { KIT_APPLE_SOURCES } from '../../src/driver/paths.ts';
import { kitSources } from '../../src/kotlin/core-api.ts';
import { kotlinKitIndex } from '../../src/kotlin/core-index.ts';
import { KOTLIN_RUNTIME, SWIFT_RUNTIME } from '../../src/semantics/runtime.ts';

const src = resolve(import.meta.dirname, '../../src');
const failures: string[] = [];

function files(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true })
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
		.flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
}

/** Whether `index` declares `name`: a top-level function, or `Type.member` a static member of its type. */
function declares(index: Map<string, KitType>, name: string): boolean {
	const dot = name.lastIndexOf('.');
	if (dot < 0)
		return !!index
			.get(KIT_GLOBALS)
			?.members.get(name)
			?.some((m) => m.kind === 'func');
	return !!index
		.get(name.slice(0, dot))
		?.members.get(name.slice(dot + 1))
		?.some((m) => m.static);
}

const kits = [
	{ label: 'Swift', column: SWIFT_RUNTIME as Readonly<Record<string, string>>, index: kitIndex(KIT_APPLE_SOURCES, undefined), dirs: ['swift', 'targets/ios'] },
	{ label: 'Kotlin', column: KOTLIN_RUNTIME as Readonly<Record<string, string>>, index: kotlinKitIndex(kitSources({})), dirs: ['kotlin', 'targets/android'] },
];

for (const k of kits) for (const [op, name] of Object.entries(k.column)) if (!declares(k.index, name)) failures.push(`${op}: the ${k.label} kit declares no ${name}`);

/** Every call in string or template text under `dir` of a name `spelled` takes. */
function spellings(dir: string, spelled: (name: string) => boolean): string[] {
	const out: string[] = [];
	// A member declared with a kit function's name (`override fun jsGet(`) is no call of it.
	const word = /(?<![\w.$])(?<!\b(?:fun|func)\s+)([A-Za-z_$][\w$]*)(?=\s*[({<])/g;
	for (const file of files(join(src, dir))) {
		const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
		const visit = (n: ts.Node): void => {
			if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
				const p = n.parent;
				// An operation's own name typed where one is taken, an import's path, a key: no spelling.
				const named = ts.isLiteralTypeNode(p) || ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p)) && p.name === n);
				if (!named) for (const m of n.getText(sf).matchAll(word)) if (spelled(m[1])) out.push(`${relative(src, file).split(sep).join('/')}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${m[1]}`);
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
	}
	return out;
}

const functionsOf = (index: Map<string, KitType>) => new Set([...(index.get(KIT_GLOBALS)?.members ?? [])].filter(([, ms]) => ms.some((m) => m.kind === 'func')).map(([n]) => n));
const tableNames = new Set(kits.flatMap((k) => Object.values(k.column)));
const counts: string[] = [];
for (const k of kits) {
	const fns = functionsOf(k.index);
	const spelled = (n: string) => fns.has(n) && (n.startsWith('js') || tableNames.has(n));
	const found = k.dirs.flatMap((d) => spellings(d, spelled));
	for (const f of found) failures.push(`${f}: a ${k.label} runtime function spelled by name (write \`\${RT.<op>}\`)`);
	counts.push(`${k.label} ${Object.keys(k.column).length}`);
}
const front = new Set(kits.flatMap((k) => [...functionsOf(k.index)].filter((n) => n.startsWith('js') || tableNames.has(n))));
for (const f of spellings('semantics', (n) => front.has(n))) failures.push(`${f}: the front spells a runtime call (take the backend's column)`);

for (const f of failures) console.log(`✗ ${f}`);
console.log(`runtime ops: ${counts.join(', ')}; ${failures.length} failures`);
process.exit(failures.length ? 1 : 0);
