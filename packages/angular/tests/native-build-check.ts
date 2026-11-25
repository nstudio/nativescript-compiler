#!/usr/bin/env node
// Angular's HttpClient, Router and Forms value classes built as the diff harness builds a program (the compiler's
// tests/native-build.ts, with this suite's adapter), on both backends: they compile and print what Angular's own classes give.
//   npm run test:native-build
// Build products go to $NS_DIFF_BUILD/native-build-check (default: <tmp>/ns-compiled-diff), the runtimes to $NS_DIFF_BUILD.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildKotlinRuntime, buildSwiftRuntime, kotlinc, kotlinMain, kotlinStdlib, swiftc, swiftMain, translateKotlin, translateSwift } from '@nstudio/nativescript-compiler/tests/native-build.ts';

// The runtimes are the diff run's, built there once.
const runtimes = process.env.NS_DIFF_BUILD ?? join(tmpdir(), 'ns-compiled-diff');
const build = join(runtimes, 'native-build-check');
const src = join(build, 'src');
rmSync(build, { recursive: true, force: true });
mkdirSync(src, { recursive: true });
let failed = 0;
const check = (what: string, run: () => string, expected: string) => {
  let got: string;
  try { got = run(); } catch (e) { got = `threw ${(e as Error).message.split('\n')[0]}`; }
  if (got === expected) console.log(`✓ ${what}`);
  else { failed++; console.log(`✗ ${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`); }
};

const ngFile = join(src, 'ng-api.ts');
writeFileSync(ngFile, `
import { HttpHeaders, HttpParams, HttpContext, HttpContextToken, HttpRequest, HttpResponse, HttpErrorResponse, HttpStatusCode } from '@angular/common/http';
import { convertToParamMap, UrlSegment, DefaultUrlSerializer } from '@angular/router';
import { FormControl, FormGroup, FormArray, FormBuilder, Validators } from '@angular/forms';

const headers = new HttpHeaders({ 'X-App': 'Acme' }).set('Accept', 'application/json').append('X-Tag', 'a').append('X-Tag', 'b');
const params = new HttpParams({ fromString: 'page=1&sort=asc' }).set('limit', 20).append('filter', 'x').append('filter', 'y');
const TOKEN = new HttpContextToken<string>(() => 'default-ctx');
const ctx = new HttpContext().set(TOKEN, 'custom-ctx');
const req = new HttpRequest('POST', '/api/items', { name: 'toy' }, { headers, params, context: ctx });
const cloned = req.clone({ setHeaders: { Authorization: 'Bearer 123' }, setParams: { page: '2' } });
const res = new HttpResponse({ body: { ok: true }, status: HttpStatusCode.Created, statusText: 'Created', url: '/api/items' });
const err = new HttpErrorResponse({ error: 'bad', status: HttpStatusCode.BadRequest, statusText: 'Bad Request', url: '/api/items' });

const pm = convertToParamMap({ id: '42', tags: [' kid ', 'parent'] });
const seg = new UrlSegment('profile', { tab: 'settings' });
const serializer = new DefaultUrlSerializer();
const tree = serializer.parse('/dashboard/kids?active=true#top');

const fb = new FormBuilder();
const ctrl = new FormControl('abc', [Validators.required, Validators.minLength(2), Validators.maxLength(5)]);
const grp = fb.group({
  name: ['Alice', Validators.required],
  age: [10, [Validators.min(5), Validators.max(18)]],
});
const arr = new FormArray([new FormControl('x'), new FormControl('y')]);
arr.push(new FormControl('z'));
const value logs: string[] = [];
ctrl.valueChanges.subscribe((v: any) => logs.push('c:' + v));
ctrl.setValue('hello');
grp.patchValue({ name: 'Bob' });

console.log([
  headers.get('x-app') ?? '',
  headers.getAll('x-tag')?.join(',') ?? '',
  params.toString(),
  cloned.headers.get('authorization') ?? '',
  cloned.params.get('page') ?? '',
  String(cloned.context.get(TOKEN)),
  res.status + ':' + res.ok,
  err.status + ':' + err.ok,
  (pm.get('id') ?? '') + ':' + pm.getAll('tags').length,
  seg.path + ':' + (seg.parameterMap.get('tab') ?? ''),
  serializer.serialize(tree),
  ctrl.valid + ':' + logs.join(','),
  String(grp.get('name')?.value) + ':' + grp.valid,
  arr.length + ':' + String(arr.at(2).value),
].join('|'));
`.replace('const value logs:', 'const logs:'));

const expectedNg = 'Acme|a,b|page=1&sort=asc&limit=20&filter=x&filter=y|Bearer 123|2|custom-ctx|201:true|400:false|42:2|profile:settings|/dashboard/kids?active=true#top|true:c:hello|Bob:true|3:z';

check('Angular HttpClient, Router, and Forms classes compile and run identically (swift)', () => {
  const out = join(build, 'swift-ng');
  const modules = translateSwift([ngFile], out);
  writeFileSync(join(out, 'main.swift'), swiftMain(modules));
  const errors = swiftc(readdirSync(out).map((f) => join(out, f)), join(build, 'swift-ng-main'), runtimes, '-Onone');
  if (errors) throw new Error(errors[0]);
  return spawnSync(join(build, 'swift-ng-main'), { encoding: 'utf8' }).stdout.trim();
}, expectedNg);

check('Angular HttpClient, Router, and Forms classes compile and run identically (kotlin)', () => {
  const runtime = buildKotlinRuntime(runtimes);
  const out = join(build, 'kotlin-ng');
  const modules = translateKotlin([ngFile], out, 'checkng');
  writeFileSync(join(out, '__Main.kt'), kotlinMain(modules, 'checkng'));
  const classes = join(build, 'kotlin-ng-classes');
  const errors = kotlinc(readdirSync(out).map((f) => join(out, f)), classes, [runtime]);
  if (errors) throw new Error(errors[0]);
  return spawnSync('java', ['-cp', [classes, runtime, kotlinStdlib()].join(':'), 'checkng.entry.__MainKt'], { encoding: 'utf8' }).stdout.trim();
}, expectedNg);

if (!process.argv.includes('--keep')) rmSync(build, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
