#!/usr/bin/env node
// Compiled `{{ }}` closures against core's own expression evaluator, run in node: every expression binding of xml-ts,
// apps/automated and apps/toolbox (both platforms; the update expression too when two-way) and every expression of
// core's expression-parser.spec.ts (both directions), on models generated from each expression's names and member
// paths: present, missing, null, undefined, wrong types, read from global, and the changed object taking precedence.
// Values, thrown errors and the calls made (arguments, `this`, order) must be equal. Each get closure is compiled again
// with its root names read typed, as for a proved class, and run on instances of a class holding those names (wrong-typed
// values included) and on plain objects, which the guard sends to the reads by name.
//   node tests/xml-bindings-check.ts
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { loadCoreXml, xmlBindingSites, type PlanPlatform } from '../src/xml/plan.ts';
import { backExpression, compileExpression, expressionParser, HELPERS } from '../src/xml/bindings.ts';

const here = dirname(fileURLToPath(import.meta.url));
const monorepo = resolve(here, '../../..');
const repo = [process.env.NS_CORE_REPO, monorepo, join(monorepo, 'core'), resolve(monorepo, '../../NativeScript/NativeScript')].find((c): c is string => !!c && existsSync(join(c, 'packages/core/package.json'))) ?? monorepo;
const coreDir = join(repo, 'packages/core');
// xml-ts: the small XML app in tests/xml-ts, or the one $XML_TS_APP names.
const xmlTs = process.env.XML_TS_APP ?? join(here, 'xml-ts');
const apps = {
  'xml-ts': join(xmlTs, 'app'),
  automated: join(repo, 'apps/automated/src'),
  toolbox: join(repo, 'apps/toolbox/src'),
};
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
  if (/^(node_modules|App_Resources|platforms|hooks)$/.test(f)) return [];
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

// Core's evaluator, from its source.
const js = (file: string) => ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const dataUrl = (text: string) => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
const acorn = pathToFileURL(createRequire(join(coreDir, 'package.json')).resolve('acorn').replace(/acorn\.js$/, 'acorn.mjs')).href;
const evaluator = await import(dataUrl(js(join(coreDir, 'ui/core/bindable/bindable-expressions.ts'))
  .replace(/(['"])acorn\1/, JSON.stringify(acorn))
  .replace(/(['"])\.\.\/\.\.\/\.\.\/utils\/types\1/, JSON.stringify(dataUrl(js(join(coreDir, 'utils/types.ts')))))));

// The corpus: [expression, direction].
type Case = { text: string; back: boolean; where: string };
const cases: Case[] = [];
const counts = { sites: 0, named: 0, expressions: 0, compiled: 0, onEvaluator: [] as string[], backCompiled: 0, backOnEvaluator: [] as string[] };
const core = await loadCoreXml();
const parse = expressionParser(coreDir);
for (const [name, dir] of Object.entries(apps)) {
  const xml = walk(dir).filter((f) => f.endsWith('.xml')).map((f) => ({ name: relative(dir, f), text: readFileSync(f, 'utf8') }));
  for (const platform of ['ios', 'android'] as PlanPlatform[]) {
    for (const { key, binding } of xmlBindingSites(core, dir, xml, platform)) {
      counts.sites++;
      if (binding.expression === undefined) { counts.named++; continue; }
      counts.expressions++;
      const where = `${name}-${platform} ${key}`;
      if (compileExpression(parse, binding.expression, false)) { counts.compiled++; cases.push({ text: binding.expression, back: false, where }); }
      else counts.onEvaluator.push(`${where}: ${binding.expression}`);
      if (binding.twoWay) {
        const update = backExpression(binding.expression, binding.sourceProperty);
        if (compileExpression(parse, update, true)) { counts.backCompiled++; cases.push({ text: update, back: true, where: `${where} (update)` }); }
        else counts.backOnEvaluator.push(`${where}: ${update}`);
      }
    }
  }
}
const specFile = join(here, 'expression-parser-check.ts');
const spec = ts.createSourceFile(specFile, readFileSync(specFile, 'utf8'), ts.ScriptTarget.Latest, true);
const specTexts: string[] = [];
const collect = (n: ts.Node): void => {
  if (ts.isArrayLiteralExpression(n)) for (const e of n.elements) if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) specTexts.push(e.text);
  if (ts.isCallExpression(n)) for (const a of n.arguments) if (ts.isStringLiteral(a) && /parseExpressionNode|acornExpression/.test(n.expression.getText(spec))) specTexts.push(a.text);
  ts.forEachChild(n, collect);
};
collect(spec);
const specCounts = { texts: new Set(specTexts).size, compiled: 0 };
for (const text of new Set(specTexts)) {
  let any = false;
  for (const back of [false, true]) if (compileExpression(parse, text, back)) { any = true; cases.push({ text, back, where: 'spec' }); }
  if (any) specCounts.compiled++;
}

// The closures, as one module.
const unique = [...new Map(cases.map((c) => [`${c.back}\u0000${c.text}`, c])).values()];
const closures: ((m: any, c: any) => any)[] = (await import(dataUrl(ts.transpileModule(`${HELPERS}\nexport default [\n${unique.map((c) => compileExpression(parse, c.text, c.back)).join(',\n')}\n];\n`,
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText))).default;

// Names and member paths of an expression: what a model gives it.
type Use = { called: boolean; converter: boolean };
function paths(ast: any): Map<string, Use> {
  const out = new Map<string, Use>();
  const note = (path: string[], use: Partial<Use> = {}) => {
    const k = path.join('\u0001');
    const u = out.get(k) ?? { called: false, converter: false };
    out.set(k, { called: u.called || !!use.called, converter: u.converter || !!use.converter });
  };
  const chain = (n: any): string[] | null => {
    if (n.type === 'Identifier') return [n.name];
    if (n.type === 'ChainExpression') return chain(n.expression);
    if (n.type === 'MemberExpression') {
      const head = chain(n.object);
      const key = !n.computed ? n.property.name : n.property.type === 'Literal' ? String(n.property.value) : null;
      return head && key !== null ? [...head, key] : null;
    }
    return null;
  };
  const visit = (n: any, use: Partial<Use> = {}): void => {
    if (!n || typeof n !== 'object') return;
    const c = chain(n);
    if (c) { for (let i = 1; i < c.length; i++) note(c.slice(0, i)); note(c, use); }
    if (n.type === 'BinaryExpression' && n.operator === '|') {
      visit(n.left);
      let r = n.right.type === 'ChainExpression' ? n.right.expression : n.right;
      if (r.type === 'CallExpression') { visit(r.callee, { converter: true, called: true }); r.arguments.forEach((a: any) => visit(a)); return; }
      visit(r, { converter: true });
      return;
    }
    if (n.type === 'CallExpression') { visit(n.callee, { called: true }); n.arguments.forEach((a: any) => visit(a)); return; }
    if (n.type === 'NewExpression') { visit(n.callee, { called: true }); n.arguments.forEach((a: any) => visit(a)); return; }
    if (n.type === 'MemberExpression') { visit(n.object); if (n.computed) visit(n.property); return; }
    if (n.type === 'Property') { if (n.computed) visit(n.key); visit(n.value); return; }
    for (const [k, v] of Object.entries(n)) if (k !== 'type' && k !== 'start' && k !== 'end') Array.isArray(v) ? v.forEach((x) => visit(x)) : visit(v);
  };
  visit(ast);
  return out;
}

const WRONG: (() => any)[] = [() => null, () => undefined, () => 0, () => 7, () => '', () => 'str', () => true, () => false, () => [], () => [1, 2], () => ({}), () => NaN];
type Variant = { label: string; set?: [string[], () => any]; missing?: string[]; global?: string; changed?: [string, () => any] };

class Holder { get inherited() { return 'proto'; } }

/** A proved class: each name present on every instance, as an accessor pair or as a field. */
function typedClass(names: string[], fields: boolean): new () => any {
  const values = new WeakMap<object, Record<string, any>>();
  const C = class Typed { constructor() { if (fields) for (const n of names) (this as any)[n] = undefined; } };
  if (!fields) for (const n of names) Object.defineProperty(C.prototype, n, {
    get() { return values.get(this)?.[n]; },
    set(v) { values.set(this, { ...values.get(this), [n]: v }); },
  });
  return C;
}

type Flavor = 'object' | 'class' | (new () => any);
function build(text: string, p: Map<string, Use>, v: Variant, log: any[], flavor: Flavor): { model: any; changed: any; globals: string[] } {
  const model: any = flavor === 'object' ? {} : flavor === 'class' ? new Holder() : new flavor();
  const fn = (name: string) => function (this: any, ...args: any[]) {
    log.push([name, this === model ? 'model' : this === globalThis ? 'global' : this === undefined ? 'undefined' : typeof this, args.map((a) => typeof a === 'function' ? 'fn' : a)]);
    return `${name}(${args.map(String).join(',')})`;
  };
  const leaf = (path: string[], u: Use, i: number) => u.converter ? (i % 2 ? fn(path.join('.')) : { toView: fn(`${path.join('.')}.toView`), toModel: fn(`${path.join('.')}.toModel`) })
    : u.called ? Object.assign(fn(path.join('.')), { prototype: {} }) : [3, 'x', true, [1, 2]][i % 4];
  const keys = [...p.keys()].map((k) => k.split('\u0001')).sort((a, b) => a.length - b.length);
  keys.forEach((path, i) => {
    let o = model;
    for (let j = 0; j < path.length - 1; j++) { if (o[path[j]] === null || typeof o[path[j]] !== 'object' && typeof o[path[j]] !== 'function') o[path[j]] = {}; o = o[path[j]]; }
    const last = path[path.length - 1];
    const isPrefix = keys.some((q) => q.length > path.length && path.every((s, k) => q[k] === s));
    const u = p.get(path.join('\u0001'))!;
    if (!(last in o) || o[last] === undefined) o[last] = isPrefix && !u.called && !u.converter ? {} : leaf(path, u, i);
    else if (isPrefix && (typeof o[last] !== 'object' || o[last] === null) && typeof o[last] !== 'function') o[last] = {};
  });
  if (v.set) {
    const [path, value] = v.set;
    let o = model;
    for (const s of path.slice(0, -1)) o = o?.[s];
    if (o != null && typeof o === 'object' || typeof o === 'function') o[path[path.length - 1]] = value();
  }
  for (const m of v.missing ?? []) delete model[m];
  const globals: string[] = [];
  if (v.global) { (globalThis as any)[v.global] = model[v.global]; delete model[v.global]; globals.push(v.global); }
  // `prepareContextForExpression`.
  if (text.includes('$value')) model.$value = model;
  let changed = model;
  if (v.changed) changed = { [v.changed[0]]: v.changed[1](), $value: model, $newPropertyValue: v.changed[1]() };
  return { model, changed, globals };
}

function norm(v: any, seen = new Set<any>()): any {
  if (typeof v === 'function') return { fn: v.name, length: v.length };
  if (typeof v === 'symbol') return { symbol: String(v) };
  if (typeof v === 'number' && Number.isNaN(v)) return { NaN: true };
  if (v === undefined) return { undefined: true };
  if (v instanceof Error) return { error: `${v.constructor.name}: ${v.message}` };
  if (v instanceof RegExp) return { regexp: String(v) };
  if (v === null || typeof v !== 'object') return v;
  if (seen.has(v)) return { cycle: true };
  seen.add(v);
  if (Array.isArray(v)) return v.map((x) => norm(x, seen));
  return { proto: Object.getPrototypeOf(v)?.constructor?.name ?? null, ...Object.fromEntries(Object.keys(v).map((k) => [k, norm(v[k], seen)])) };
}

let compared = 0;
const mismatches: string[] = [];
unique.forEach((c, index) => {
  const p = paths(parse(c.text));
  const names = [...p.keys()].filter((k) => !k.includes('\u0001'));
  const variants: Variant[] = [{ label: 'present' }, { label: 'all missing', missing: names }];
  for (const k of p.keys()) {
    const path = k.split('\u0001');
    WRONG.forEach((w, i) => variants.push({ label: `${path.join('.')}=${String(w())}#${i}`, set: [path, w] }));
    if (path.length === 1) {
      variants.push({ label: `${k} missing`, missing: [k] }, { label: `${k} global`, global: k });
      for (const w of [() => 'changed', () => 0, () => null, () => undefined]) variants.push({ label: `${k} changed=${String(w())}`, changed: [k, w] });
    }
  }
  if (c.back) for (const w of [() => 'typed', () => 5, () => null, () => undefined, () => '', () => true]) variants.push({ label: `$newPropertyValue=${String(w())}`, changed: ['$value', w] });
  for (const asClass of [false, true]) for (const v of variants) {
    const run = (side: 'evaluator' | 'closure') => {
      const log: any[] = [];
      const { model, changed, globals } = build(c.text, p, v, log, asClass ? 'class' : 'object');
      let result: any;
      try {
        result = side === 'evaluator' ? evaluator.convertExpressionToValue(evaluator.parseExpression(c.text), model, c.back, changed) : closures[index](model, changed);
      } catch (e) {
        result = e instanceof Error ? e : new Error(`thrown ${String(e)}`);
      }
      for (const g of globals) delete (globalThis as any)[g];
      return JSON.stringify(norm({ result, log }));
    };
    const a = run('evaluator');
    const b = run('closure');
    compared++;
    if (a !== b) mismatches.push(`${c.where}: ${c.back ? '[back] ' : ''}${c.text}\n  model ${asClass ? 'class' : 'object'}, ${v.label}\n  evaluator ${a.slice(0, 300)}\n  closure   ${b.slice(0, 300)}`);
  }
});

// Typed reads. A get closure's `changed` is the model or `{ $value: model }` (core's `_getExpressionValue` callers), so
// those are the two run; a field-backed class is not deleted from (the proof is that every instance holds the name).
const typedCases = unique.map((c, index) => ({ c, index })).filter(({ c }) => !c.back).map(({ c, index }) => {
  const names = [...paths(parse(c.text)).keys()].filter((k) => !k.includes('\u0001') && /^[A-Za-z_][\w$]*$/.test(k) && !(k in Object.prototype));
  return { c, index, names, text: compileExpression(parse, c.text, false, { guard: '__T', members: new Set(names) }) };
}).filter((t) => t.text?.includes('m instanceof __T ?'));
const typedClosures: ((T: any) => (m: any, c: any) => any)[] = (await import(dataUrl(ts.transpileModule(`${HELPERS}\nexport default [\n${typedCases.map((t) => `(__T: any) => ${t.text}`).join(',\n')}\n];\n`,
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText))).default;
let typedCompared = 0;
typedCases.forEach((t, i) => {
  const p = paths(parse(t.c.text));
  const variants: Variant[] = [{ label: 'present' }, { label: 'all missing', missing: t.names }];
  for (const k of p.keys()) {
    const path = k.split('\u0001');
    WRONG.forEach((w, j) => variants.push({ label: `${path.join('.')}=${String(w())}#${j}`, set: [path, w] }));
    if (path.length === 1) variants.push({ label: `${k} missing`, missing: [k] }, { label: `${k} global`, global: k });
  }
  for (const fields of [false, true]) {
    const T = typedClass(t.names, fields);
    for (const flavor of [T, 'object'] as Flavor[]) for (const v of variants) for (const wrapped of [false, true]) {
      if (fields && flavor === T && (v.missing || v.global) && (v.missing ?? [v.global]).some((n) => t.names.includes(n!))) continue;
      const run = (side: 'evaluator' | 'closure') => {
        const log: any[] = [];
        const { model, globals } = build(t.c.text, p, v, log, flavor);
        const changed = wrapped ? { $value: model } : model;
        let result: any;
        try {
          result = side === 'evaluator' ? evaluator.convertExpressionToValue(evaluator.parseExpression(t.c.text), model, false, changed) : typedClosures[i](T)(model, changed);
        } catch (e) {
          result = e instanceof Error ? e : new Error(`thrown ${String(e)}`);
        }
        for (const g of globals) delete (globalThis as any)[g];
        return JSON.stringify(norm({ result, log }));
      };
      const a = run('evaluator');
      const b = run('closure');
      typedCompared++;
      if (a !== b) mismatches.push(`${t.c.where}: [typed${fields ? ', fields' : ''}] ${t.c.text}\n  model ${flavor === 'object' ? 'object' : 'typed'}${wrapped ? ' {$value}' : ''}, ${v.label}\n  evaluator ${a.slice(0, 300)}\n  closure   ${b.slice(0, 300)}`);
    }
  }
});

console.log(`XML bindings: ${counts.sites} sites, ${counts.named} name/path (no evaluator), ${counts.expressions} expressions: ${counts.compiled} compiled, ${counts.onEvaluator.length} on the evaluator; two-way updates ${counts.backCompiled} compiled, ${counts.backOnEvaluator.length} on the evaluator`);
for (const s of [...counts.onEvaluator, ...counts.backOnEvaluator]) console.log(`  evaluator: ${s}`);
console.log(`spec: ${specCounts.texts} expressions, ${specCounts.compiled} compiled in at least one direction`);
console.log(`${unique.length} distinct closures, ${compared} model comparisons; ${typedCases.length} with typed reads, ${typedCompared} typed comparisons; ${mismatches.length} differ`);
const kinds = new Map<string, number>();
for (const m of mismatches) { const k = m.split('\n').slice(2).map((l) => l.replace(/^ +\w+ +/, '').replace(/"log":.*/, '')).join(' | '); kinds.set(k, (kinds.get(k) ?? 0) + 1); }
for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`${n}x ${k.slice(0, 260)}`);
for (const m of mismatches.slice(0, 3)) console.log(m);
assert.equal(mismatches.length, 0);
