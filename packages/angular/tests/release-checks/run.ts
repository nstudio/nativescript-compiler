#!/usr/bin/env node
// The Angular adapter's release checks, on fixed inputs: its front end (templates, components, routes, the libraries an
// app's plugins ship), what its translator hooks and kit make of Angular's API, and @angular/forms' port. They run on
// the compiler's harness with this suite (suite.json), the compiler a checkout linked into the workspace:
//   npm run test:release-checks
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS_OVERRIDE, adapterOf, availableAdapters, compilerVersion, loadAdapter } from '@nstudio/nativescript-compiler/src/adapters/load.ts';
import { adapterKitOf } from '@nstudio/nativescript-compiler/src/adapters/active.ts';
import { ISSUES_URL, REPORT_HEADER, refusalReport, type RefusalId } from '@nstudio/nativescript-compiler/src/semantics/refusals.ts';
import { pathAliases } from '@nstudio/nativescript-compiler/src/program/app-paths.ts';
import { PluginSources } from '@nstudio/nativescript-compiler/src/plugins/source.ts';
import { translateModules } from '@nstudio/nativescript-compiler/src/swift/app-modules.ts';
import { isFragment } from '@nstudio/nativescript-compiler/src/template/model.ts';
import { componentMembersOf } from '@nstudio/nativescript-compiler/src/template/plan.ts';
import { render } from '@nstudio/nativescript-compiler/src/swift/render.ts';
import { render as renderKotlin } from '@nstudio/nativescript-compiler/src/kotlin/render.ts';
import { translateKotlinModules } from '@nstudio/nativescript-compiler/src/kotlin/app-modules.ts';
import { AndroidNativeAPI } from '@nstudio/nativescript-compiler/src/kotlin/native/api.ts';
import { androidClassPath } from '@nstudio/nativescript-compiler/src/kotlin/native/classpath.ts';
import { detectFramework } from '@nstudio/nativescript-compiler/src/adapters/framework.ts';
import { spawnSync } from 'node:child_process';
import { check, createProgram, failedElsewhere, finish, KotlinTranslator as Translator, nativeBuild, SwiftTranslator } from '@nstudio/nativescript-compiler/tests/release-checks/checks.ts';
import { buildKotlinRuntime, buildSwiftRuntime, kotlinc, kotlinStdlib, modulesDir, root, swiftc, swiftMain, translateKotlin, translateSwift, ts } from '@nstudio/nativescript-compiler/tests/native-build.ts';
import { adapterModule, suiteAdapter, suiteAdapterBuild, suiteAdapterPackage } from '@nstudio/nativescript-compiler/tests/suite.ts';

const angular = suiteAdapter!;
const angularPackage = suiteAdapterPackage!;
// Its front end's functions, as the adapter's entry loaded them.
const { angularComponent, angularComponents, angularDirectives, angularRouteTree, angularRoutes, componentOf, componentsOf, declarableSource, declarablesIn, hostedComponent, routedComponents } = await adapterModule('angular');
const { angularLibraries, registeredElements } = await adapterModule('angular-libraries');
type AngularComponent = any;
type RouteNode = any;
const here = dirname(fileURLToPath(import.meta.url));

// Each section runs in a function of its own, never a bare block: this module's frame lives for the whole run and keeps
// every top-level block's locals (each a program of several hundred MB) reachable until it ends.

// ---- the refusal report: each refusal kind the adapter declares ----
(() => {
  for (const [id, r] of Object.entries(suiteAdapterBuild.adapter.refusals)) {
    const text = refusalReport([{ id: id as RefusalId, at: 'app/a.ts:3:7', code: 'x()' }], suiteAdapterBuild.adapter);
    const ok = text.includes(REPORT_HEADER) && text.includes(`${r.title} [${id}]`) && text.includes(r.suggestion) && text.includes('at app/a.ts:3:7: x()') && text.includes(ISSUES_URL) === (r.class === 'gap');
    check(ok, `the refusal report of ${id} prints the header, its title, its suggestion and its site${r.class === 'gap' ? ', and that it is a compiler gap' : ''}`);
  }
})();

// ---- Angular templates ----
(() => {
  const component = (template: string) => angularComponent('/app/people.component.ts', `import { Component, inject } from '@angular/core';
@Component({ selector: 'People', template: \`${template}\` })
export class People { items = [{ id: 1, name: 'Alan Turing' }]; }
`, new Map())!;
  type Node = { kind: string; tag?: string; attrs?: { name: string }[]; events?: { name: string; method: string }[]; children?: Node[]; body?: Node[] };
  const all = (nodes: Node[]): Node[] => nodes.flatMap((n) => [n, ...all(n.children ?? []), ...all(n.body ?? [])]);
  const linked = (c: AngularComponent, tag: string) => all(c.template as Node[]).find((n) => n.tag === tag)!;
  const method = (c: AngularComponent, name: string) => c.source.split('\n').find((l) => l.trimStart().startsWith(`${name}(`)) ?? '';

  const rows = component(`<ListView [items]="items"><ng-template let-item="item"><StackLayout [nsRouterLink]="['/item', item.id]"><Label [text]="item.name"></Label></StackLayout></ng-template></ListView>`);
  const row = linked(rows, 'StackLayout');
  const tap = row.events?.find((e) => e.name === 'tap');
  check(!!tap && !row.attrs?.some((a) => a.name === 'nsRouterLink'), '[nsRouterLink] on a ListView row template is a tap handler, not a view property');
  check(!!tap && /^\s*\$e\d+\(item = .*\$event.*this\.\$router\.navigate\(\['\/item', item\.id\], \{ relativeTo: this\.\$route \}\)/.test(method(rows, tap.method)), "a row's link navigates with the row's item");
  check(/readonly \$route = inject\(\$ActivatedRoute\)/.test(rows.source), "a link resolves against the component's own route, read when it is made");

  const plain = component(`<Label text="About" nsRouterLink="about" pageTransition="none" clearHistory="true"></Label><Button [nsRouterLink]="target" text="Go"></Button>`);
  const label = linked(plain, 'Label');
  check(!label.attrs?.some((a) => ['nsRouterLink', 'pageTransition', 'clearHistory'].includes(a.name)), "nsRouterLink's inputs are the directive's, not the view's");
  check(method(plain, label.events?.[0]?.method ?? '-').includes(`navigate(["about"], { relativeTo: this.$route, animated: false, clearHistory: true })`), 'a fixed link is one command, with its transition and clearHistory');
  check(/Array\.isArray\(\$commands\) \? \$commands : \[\$commands\]/.test(method(plain, linked(plain, 'Button').events?.[0]?.method ?? '-')), 'a bound link is its commands, or one command');

  const lineOf = (c: AngularComponent, name: string) => c.source.split('\n').findIndex((l) => l.trimStart().startsWith(`${name}(`));
  const pinned = (c: AngularComponent, name: string) => c.templateLines?.lines.find(([v]) => v === lineOf(c, name))?.[1];
  const multi = component(`<StackLayout>
  <Label [text]="items[0]?.name"></Label>
</StackLayout>`);
  const label2 = linked(multi, 'Label');
  check(multi.templateLines?.file === '/app/people.component.ts' && pinned(multi, (label2.attrs as { name: string; method?: string }[]).find((a) => a.name === 'text')!.method!) === 3, "a binding's method is located at its line in the template, not by matching the component's code");
  check(/\$b\d+\(\): any \{ return \(this\.items\[0\]\?\.name\); \}/.test(multi.source), 'a view property bound to an optional chain takes undefined where the chain stops, whatever its type says');

  let refused = '';
  try { component(`<Label nsRouterLink="/a" [queryParams]="{ q: 1 }"></Label>`); } catch (e) { refused = String(e); }
  check(refused.includes("nsRouterLink's queryParams is not supported"), 'a link input the compiled router has no use for stops the build');

  const mixed = component(`<Label text="Hi {{ items.length > 1 ? 'all' : 'one' }}!"></Label>`);
  check(method(mixed, (linked(mixed, 'Label').attrs as { name: string; method?: string }[]).find((a) => a.name === 'text')?.method ?? '-').includes("return (`Hi ${(this.items.length > 1 ? 'all' : 'one')}!`);"), 'a text attribute mixing literal text and {{ }} is a template literal of both');
  const documented = componentOf('/app/pill.component.ts', `@Component({ selector: 'primary-pill', template: '' })\n/** A doc comment between the decorator and the class. */\nexport class PrimaryPill {}\n`);
  check(documented?.selector === 'primary-pill' && documented.name === 'PrimaryPill', "a component's selector is read whatever comes between its decorator and its class");

  // Angular's template features beyond bindings: platform filters, ng-container, NgSwitch, NgTemplateOutlet, pipes.
  const source = (template: string, members = 'items = [{ id: 1, name: "Alan Turing" }]; mode = "a"; when = new Date(0); first = { name: "Ada" };') => `import { Component } from '@angular/core';
@Component({ selector: 'People', template: \`${template}\` })
export class People { ${members} }
`;
  const shaped = (template: string, options: Parameters<typeof angularComponent>[3] = {}) => angularComponent('/app/people.component.ts', source(template), new Map(), options)!;
  const tags = (c: AngularComponent) => all(c.template as Node[]).map((n) => n.tag ?? n.kind);
  const filtered = shaped(`<StackLayout><android><Label text="a"></Label></android><ios><Button text="i"></Button></ios></StackLayout>`, { platform: 'ios' });
  check(tags(filtered).includes('Button') && !tags(filtered).includes('Label'), '<ios> renders its content on iOS and <android> nothing, as the platform filter components do');
  const contained = shaped(`<StackLayout><ng-container row="1"><Label text="x"></Label></ng-container></StackLayout>`);
  check(tags(contained).join() === 'StackLayout,Label', "<ng-container>'s attributes select directives only: its children join its parent");
  const switched = shaped(`<StackLayout [ngSwitch]="mode"><Label *ngSwitchCase="'a'" text="a"></Label><Label *ngSwitchDefault text="d"></Label></StackLayout>`);
  check(/=== \('a'\)/.test(switched.source) && /!\(\(this\.\$b\d+\(\)\) === \('a'\)\)/.test(switched.source), "ngSwitchDefault renders when no ngSwitchCase is === the switch's value");
  const outlet = shaped(`<StackLayout><ng-template #row let-person let-n="index"><Label [text]="n + person.name"></Label></ng-template><ng-container *ngTemplateOutlet="row; context: { $implicit: first, index: 1 }"></ng-container></StackLayout>`);
  check(/return \(\(\(1\)\) \+ \(\(this\.first\)\)\.name\)/.test(outlet.source), "ngTemplateOutlet renders the referenced template, its let- variables read from the context's properties");
  const piped = shaped(`<StackLayout><Label *ngFor="let item of items" [text]="item.name | uppercase"></Label><Label [text]="when | date: 'y'"></Label><Label [text]="items | json"></Label></StackLayout>`, { runtimeModule: '/app/__angular.release.ts' });
  const loop = all(piped.template as Node[]).find((n) => n.kind === 'for') as Node | undefined;
  check(!!loop && (loop.body ?? []).some((n) => n.kind === 'local'), 'a pipe in an *ngFor row is one per row, a local of the row');
  check(/\$c\d+\.pure1\(/.test(piped.source) && /\$c\d+\.pure2\(\(this\.when\), \('y'\)/.test(piped.source) && /\$p\d+\.transform\(this\.items\)/.test(piped.source), 'a pure pipe transforms through its site\'s cache, an impure one on every check');
  check(!!piped.usesRuntime && piped.source.includes("from './__angular.release'"), "@angular/common's pipes come from the build's Angular runtime module");
  let unknown = '';
  try { shaped(`<Label [text]="items | currency"></Label>`); } catch (e) { unknown = String(e); }
  check(unknown.includes("@angular/common's currency pipe is not supported"), 'a pipe the build has no class for stops the build, naming it');
  const classic = angularComponent('/app/badge.component.ts', `import { Component, Input } from '@angular/core';
@Component({ selector: 'Badge', template: '<Label [text]="tone"></Label>' })
export class Badge { @Input('total') count = 0; @Input() set tone(v: string) { this.shown = v; } shown = ''; bump() { this.count += 1; this.tone = 'x'; } }
`, new Map())!;
  check(classic.setters?.join() === 'tone' && classic.propAliases?.count === 'total', "an @Input setter is a setter prop, an aliased input bound by its alias");
  check(/this\.count\.\$assign\(this\.count\(\) \+ \(1\)\)/.test(classic.source) && /this\.\$set_tone\('x'\)/.test(classic.source), 'a component writing its own inputs writes their signal, or calls the setter');
  const queried = angularComponent('/app/q.component.ts', `import { Component, ElementRef, ViewChild } from '@angular/core';
@Component({ selector: 'Q', template: '<StackLayout #box><Label #title></Label></StackLayout>' })
export class Q { @ViewChild('box', { static: true }) box: ElementRef; @ViewChild('title') title: ElementRef; ngOnInit() {} ngAfterViewInit() {} ngOnDestroy() {} }
`, new Map())!;
  const box = all(queried.template as Node[]).find((n) => n.tag === 'StackLayout') as Node & { init?: boolean; queries?: unknown[] };
  check(!!queried.lateInit && !!box?.init && box.queries?.length === 1, 'a static view query is set when its element is made, and ngOnInit runs once it is');
  check(queried.afterViewInit === 'ngAfterViewInit' && queried.destroy === 'ngOnDestroy' && /this\.box = new \$ElementRef\(\$q\)/.test(queried.source), "ngAfterViewInit and ngOnDestroy are the component's hooks, a #ref query an ElementRef");
  const directive = { className: 'Glow', file: '/app/glow.directive.ts', selector: '[glow]', inputs: new Map([['glow', 'level']]), listeners: [{ event: 'tap', code: 'flash($event)' }], bindings: [{ prop: 'opacity', code: 'level' }], attributes: [], create: false, hooks: new Set(['ngOnInit']), signals: new Set<string>(), structural: false, members: ['level', 'flash'] };
  const glowing = angularComponent('/app/g.component.ts', `import { Component } from '@angular/core';
import { Glow } from './glow.directive';
@Component({ selector: 'G', imports: [Glow], template: '<StackLayout><Label [glow]="2"></Label><Label text="no glow"></Label></StackLayout>' })
export class G {}
`, new Map(), { directives: [directive] })!;
  const lit = all(glowing.template as Node[]).filter((n) => n.tag === 'Label') as (Node & { directives?: { inputs: unknown[]; listeners: unknown[]; bindings: unknown[] }[] })[];
  check(lit[0]?.directives?.length === 1 && lit[0].directives[0].inputs.length === 1 && !lit[0].attrs?.some((a) => a.name === 'glow') && !lit[1]?.directives, "a directive in the component's scope applies where its selector matches, and its inputs' bindings are its own");
  const outOfScope = angularComponent('/app/h.component.ts', `import { Component } from '@angular/core';
@Component({ selector: 'H', template: '<Label [glow]="2"></Label>' })
export class H {}
`, new Map(), { directives: [directive] })!;
  check(!(all(outOfScope.template as Node[])[0] as { directives?: unknown[] }).directives, "a directive the component does not import does not apply");
  const keyworded = angularComponent('/app/k.component.ts', `import { Component } from '@angular/core';
@Component({ selector: 'K', template: '<Button (tap)="continue()" text="go"></Button>' })
export class K { continue() {} }
`, new Map())!;
  check(/\$e\d+\(\$event: \$EventData\) \{ this\.continue\(\); \}/.test(keyworded.source), 'a member named like a keyword (continue) is read on the component');
  const decl = declarableSource('/app/glyph.pipe.ts', `import { Pipe, Inject, Optional, ChangeDetectorRef } from '@angular/core';
@Pipe({ name: 'glyph', pure: false })
export class GlyphPipe { constructor(@Inject(TOKEN) private config: any, @Optional() private ref: ChangeDetectorRef) {} transform(v: string) { return v; } }
`) ?? '';
  check(!decl.includes('@Pipe') && !decl.includes('@Inject') && /static \$create\(\): GlyphPipe \{ return new GlyphPipe\(inject\(TOKEN\), inject\(ChangeDetectorRef, \{ optional: true \}\)\); \}/.test(decl) && decl.startsWith("import { inject } from '@angular/core';"), "a pipe's constructor is injected through $create, as Angular's factory injects it");
})();

// ---- Lazy routes through an app's tsconfig paths ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-app-'));
  const w = (f: string, text: string) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), text); return join(dir, f); };
  try {
    w('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '~/*': ['./src/*'], '@fixtures': ['./src/fixtures/index'], '@outside/*': ['../outside/*'] } }, exclude: ['**/*.spec.ts'] }));
    const main = w('src/main.ts', "import { routes } from './app.routes';\nimport { App } from '~/app/app';\nbootstrapApplication(App, { providers: [provideRouter(routes)] });\n");
    const routes = w('src/app.routes.ts', "export const routes = [{ path: 'a', loadComponent: () => import('~/app/lazy').then((m) => m.Lazy) }, { path: 'b', loadChildren: () => import('~/app/child.routes').then((m) => m.childRoutes) }];\n");
    const child = w('src/app/child.routes.ts', "import { Lazy } from '~/app/lazy';\nexport const childRoutes = [{ path: 'c', component: Lazy }];\n");
    const app = w('src/app/app.ts', "import { helper } from './helper';\nexport class App {}\n");
    const helper = w('src/app/helper.ios.ts', 'export const helper = 2;\n');
    const lazy = w('src/app/lazy.ts', 'export class Lazy {}\n');
    const spec = w('src/app/app.spec.ts', "import { App } from './app';\nimport { stub } from '@fixtures';\n");
    const fixtures = w('src/fixtures/index.ts', 'export const stub = 0;\n');
    const test = w('src/test.ts', "import './app/app.spec';\n");
    const aliased = pathAliases(dir);
    const tree = angularRouteTree(main, (f) => readFileSync(f, 'utf8'), aliased);
    check(!!tree && routedComponents(tree.routes).join() === 'Lazy,Lazy' && tree.files.has(child), 'lazy routes are followed through tsconfig paths');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- Angular libraries of plugins: an app's replaced package, a plugin's NgModule ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-esm-'));
  const w = (f: string, text: string) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), text); return join(dir, f); };
  try {
    const modules = join(dir, 'node_modules');
    mkdirSync(modules);
    symlinkSync(join(modulesDir, '@nativescript'), join(modules, '@nativescript'));
    const stub = { get: () => { throw new Error('acquired'); } } as unknown as PluginSources;
    const home = w('src/home.ts', "import { PagerModule } from '@hk/pager/angular';\n");
    w('node_modules/@hk/pager/index.js', '');
    let acquired = '';
    try { angularLibraries([home], modules, stub, new Set(['@hk/pager'])); } catch (e) { acquired = String(e); }
    check(!acquired, "the Angular wrapper of a package the app replaces is not acquired");

    // A plugin's Angular entry with components, whose NgModule the app imports: the module's file is compiled with the
    // app's, a wrapper written against the view internals beside it is not, and the entry resolves to that file.
    w('node_modules/@hk/sheetish/package.json', JSON.stringify({ name: '@hk/sheetish', version: '1.0.0', main: 'index' }));
    w('node_modules/@hk/sheetish/index.ios.js', '');
    w('node_modules/@hk/sheetish/angular/index.js', '');
    w('sheetish/package.json', JSON.stringify({ name: '@hk/sheetish' }));
    w('sheetish/index.ios.ts', 'export class Sheet { open() { return 1; } }\n');
    const sheetService = w('sheetish/angular/sheet.service.ts', "import { Injectable } from '@angular/core';\nimport { Sheet } from '@hk/sheetish';\n@Injectable({ providedIn: 'root' })\nexport class SheetService { sheet = new Sheet(); }\n");
    const sheetHost = w('sheetish/angular/sheet-host.ts', "import { Directive, ViewContainerRef } from '@angular/core';\n@Directive({ selector: '[sheetHost]' })\nexport class SheetHost { constructor(public container: ViewContainerRef) {} }\n");
    const sheetView = w('sheetish/angular/sheet-view.component.ts', "import { Component } from '@angular/core';\n@Component({ selector: 'SheetView', template: '<Label text=\"sheet\"></Label>' })\nexport class SheetView {}\n");
    const sheetEntry = w('sheetish/angular/index.ts', "import { NgModule } from '@angular/core';\nimport { SheetService } from './sheet.service';\nimport { SheetHost } from './sheet-host';\nimport { SheetView } from './sheet-view.component';\nexport { SheetService } from './sheet.service';\n@NgModule({ imports: [SheetView, SheetHost], exports: [SheetView, SheetHost] })\nexport class SheetModule { constructor(public sheets: SheetService) {} }\n");
    const sheetUser = w('src/sheet-user.ts', "import { importProvidersFrom } from '@angular/core';\nimport { SheetModule } from '@hk/sheetish/angular';\nexport const providers = importProvidersFrom(SheetModule);\n");
    const sheetPlugins = new PluginSources({ app: dir, platform: 'ios', overrides: { '@hk/sheetish': join(dir, 'sheetish') } });
    let sheetLibs: string[] = [];
    let sheetResolved = '';
    try {
      sheetLibs = angularLibraries([sheetUser], modules, sheetPlugins, new Set());
      const built = createProgram([sheetUser, ...sheetLibs], new Map(), 'ios', modules, sheetPlugins);
      sheetResolved = `${built.resolved(sheetUser, '@hk/sheetish/angular')}${built.pluginFiles.includes(sheetEntry) ? ' (as a plugin file)' : ''}`;
    } catch (e) { sheetResolved = String(e).split('\n').slice(0, 3).join(' '); }
    check(sheetLibs.includes(sheetView) && sheetLibs.includes(sheetEntry) && sheetLibs.includes(sheetService) && !sheetLibs.includes(sheetHost) && sheetResolved === sheetEntry,
      `a plugin's Angular NgModule the app imports is compiled with the app, without the view-internals wrapper beside it${sheetResolved === sheetEntry ? '' : `: ${sheetLibs.map((f) => f.slice(dir.length)).join(', ')} → ${sheetResolved}`}`);

  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- A stubbed plugin's element in an Angular template ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-stubs-'));
  const w = (f: string, text: string) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), text); return join(dir, f); };
  try {
    suiteAdapterBuild.stubbedPlugins.add('nativescript-ui-listview');
    const c = angularComponent(join(dir, 'src/list.component.ts'), "import { Component } from '@angular/core';\n@Component({ selector: 'List', template: `<GridLayout rows=\"*\"><RadListView row=\"0\" [items]=\"items\" (itemTap)=\"tap()\"><ng-template tkListItemTemplate let-item=\"item\"><Label [text]=\"item\"></Label></ng-template></RadListView></GridLayout>` })\nexport class List { items = ['a']; tap() {} }\n", new Map())!;
    const stand = (c.template[0] as { children: { tag: string; attrs: { name: string }[]; events: unknown[]; children: unknown[] }[] }).children[0];
    check(stand.tag === 'ContentView' && stand.attrs.map((a) => a.name).join() === 'row' && !stand.events.length && !stand.children.length, "a stubbed plugin's element is an empty ContentView keeping its place in the layout");
  } finally {
    suiteAdapterBuild.stubbedPlugins.delete('nativescript-ui-listview');
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- Angular component classes ----
(() => {
  const make = (text: string) => angularComponent('/app/cls.component.ts', text, new Map())!;
  const noArg = make("import { Component, Input, OnChanges } from '@angular/core';\n@Component({ selector: 'C', template: `<Label [text]=\"name\"></Label>` })\nexport class C implements OnChanges { @Input() name = ''; seen = 0; ngOnChanges() { this.seen++; } }\n");
  check(/this\.ngOnChanges\(\);/.test(noArg.source) && !/this\.ngOnChanges\(changes\)/.test(noArg.source), 'ngOnChanges declared without a parameter is called without one');
  const ctor = make("import { Component } from '@angular/core';\nclass Clock { now() { return 1; } }\n@Component({ selector: 'C', template: `<Label [text]=\"t\"></Label>` })\nexport class C { t = 0; constructor(private clock: Clock) { this.t = clock.now(); } }\n");
  check(/const clock = this\.clock;/.test(ctor.source), "a constructor's body naming a parameter property reads the field it became");
  const inherited = make("import { Component } from '@angular/core';\nclass Base { title = 'base'; }\n@Component({ selector: 'C', template: `<Label [text]=\"title\"></Label>` })\nexport class C extends Base {}\n");
  check(/this\.title/.test(inherited.source), "a template names a member the component inherits");
  const multiline = make("import { Component } from '@angular/core';\n@Component({ selector: 'C', template: `<Label [text]=\"on ? 'a' : 'b\nc'\"></Label>` })\nexport class C { on = true; }\n");
  check(multiline.source.includes("'b\\nc'"), 'a string literal written across lines in a template stays one string');
})();

// ---- NgClass and NgStyle ----
await (async () => {
  type Node = { kind: string; tag?: string; attrs?: { name: string; value?: string; method?: string }[]; children?: Node[]; directives?: { make: string; inputs: { set: string; method?: string }[]; attributes: { name: string; value: string }[] }[] };
  const make = (template: string, selectors = new Map<string, string>()) => angularComponent('/app/c.component.ts', `import { Component, signal } from '@angular/core';
@Component({ selector: 'C', template: \`${template}\` })
export class C { on = signal(true); w = signal(10); name = 'Ada'; }
`, selectors, { runtimeModule: '/app/__angular.release.ts' })!;
  const all = (nodes: Node[]): Node[] => nodes.flatMap((n) => [n, ...all(n.children ?? [])]);
  const label = (c: AngularComponent) => all(c.template as Node[]).find((n) => n.tag === 'Label')!;
  const method = (c: AngularComponent, name: string) => c.source.split('\n').find((l) => l.trimStart().startsWith(`${name}(`)) ?? '';

  const classed = make(`<Label class="base x" [class.on]="on()" [ngClass]="{ big: on(), 'a b': true }"></Label>`);
  const ngClassUse = label(classed).directives?.[0];
  check(!!ngClassUse && method(classed, ngClassUse.make).includes('new $Ng_NgClass()') && method(classed, ngClassUse.inputs[0].set).includes('.apply($v)')
    && method(classed, ngClassUse.inputs[0].method!).includes(`["base x", { big: this.on(), 'a b': true }, ["on", (this.on())]]`), "[ngClass] is the runtime's NgClass on the element, given the static class, NgClass's value and the [class.x] bindings");
  check(!label(classed).attrs!.some((a) => a.name === 'class' || a.name === 'ngClass'), 'beside [ngClass], the static class and [class.x] are NgClass\'s, not bound as the view\'s className');
  check(!!classed.usesRuntime && classed.source.includes("NgClass as $Ng_NgClass } from './__angular.release'"), "NgClass comes from the build's Angular runtime module");
  const fixedClass = make(`<Label ngClass="p q"></Label>`);
  const fixedUse = label(fixedClass).directives?.[0];
  check(!!fixedUse && method(fixedClass, fixedUse.inputs[0].method!).includes('["", "p q", []]') && !label(fixedClass).attrs!.some((a) => a.name === 'ngClass'), 'a static ngClass attribute names its classes through NgClass');
  const piped = make(`<Label [ngClass]="name | lowercase"></Label>`);
  check(/\["", \$c\d+\.pure1\(\(this\.name\), \(\$x0\) => \$p\d+\.transform\(\$x0\)\), \[\]\]/.test(piped.source), "a pipe in [ngClass] is one per view, as in any binding");
  const onComponent = make(`<Badge class="b" [ngClass]="{ on: on() }"></Badge>`, new Map([['Badge', 'Badge']]));
  const badge = all(onComponent.template as Node[]).find((n) => n.kind === 'component') as Node & { props?: { name: string; method?: string }[] };
  check(!!badge.props?.some((p) => p.name === 'class' && p.method && method(onComponent, p.method).includes('$Ng_ngClassNames("b", { on: this.on() }, [])')), "[ngClass] on a component is its class, which falls through to its root view as [class.x] does");

  const styled = make(`<Label style="color: red" [ngStyle]="{ 'width.px': w(), 'background-color': on() ? 'red' : null }"></Label>`);
  const use = label(styled).directives?.find((d) => d.make && method(styled, d.make).includes('NgStyle'));
  check(!!use && method(styled, use.make).includes('new $Ng_NgStyle($unsetValue)') && styled.source.includes("import { unsetValue as $unsetValue } from '@nativescript/core';") && method(styled, use.inputs[0].set).includes('.apply($v)')
    && method(styled, use.inputs[0].method!).includes(`[{ 'width.px': this.w(), 'background-color': this.on() ? 'red' : null }] as any[]`), "[ngStyle] is the runtime's NgStyle on the element, given its value");
  check(!!use && use.attributes.some((a) => a.name === 'style' && a.value === 'color: red') && !label(styled).attrs!.some((a) => a.name === 'style' || a.name === 'ngStyle'), 'a static style beside [ngStyle] is set by it, before its first styles');
  const bound = make(`<Label style="color: red" [style.background-color]="on() ? 'red' : null" [style.width.px]="w()" [style.--gap]="w()"></Label>`);
  const boundUse = label(bound).directives?.find((d) => d.make && method(bound, d.make).includes('NgStyle'));
  check(!!boundUse && method(bound, boundUse.inputs[0].method!).includes(`[{ "background-color": (this.on() ? 'red' : null), "width.px": (this.w()), "--gap": (this.w()) }] as any[]`)
    && boundUse.attributes.some((a) => a.name === 'style') && !label(bound).attrs!.some((a) => a.name !== 'style' && /background|width|gap/.test(a.name)), "[style.x] bindings are one NgStyle object on the element (dashed names, units, CSS variables; null removes)");
  const toggled = make(`<Label class="a x b" [class.x]="on()" [class.y]="on()"></Label>`);
  const toggledClass = label(toggled).attrs!.find((a) => a.name === 'class');
  check(!!toggledClass?.method && method(toggled, toggledClass.method).includes('$Ng_ngClassNames("a x b", null, ["x", (this.on()), "y", (this.on())])'), '[class.x] without NgClass decides a static class x it names, through ngClassNames');
  const swift = render(styled, new Map(), () => false, angular.behaviour).join('\n');
  const kotlin = renderKotlin(styled, new Map(), { behaviour: angular.behaviour }).join('\n');
  check(/ElementRef\.hosting\(v\d+\) \{ self\._b\d+\(\) \}[\s\S]*kitSet\("style", "color: red"\)[\s\S]*Check\(\{ self\._b\d+\(\) \}\)/.test(swift) && /ElementRef\.hosting\(v\d+\) \{ this\._b\d+\(\) \}[\s\S]*kitSet\("style", "color: red"\)[\s\S]*Check\(\{ this\._b\d+\(\) \}\)/.test(kotlin), "NgStyle is made with the element as its ElementRef, the static style set before its styles (Swift, Kotlin)");

  // Diff cases 740 and 741 translate the runtime's NgClass and NgStyle code (strict and non-strict): their copies must stay the runtime's.
  const pieces = (file: string) => {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const out = new Map<string, string>();
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name && st.body) out.set(st.name.text, st.body.getText());
      if (ts.isClassDeclaration(st) && st.name && ['NgClass', 'NgStyle'].includes(st.name.text)) for (const m of st.members) if (ts.isMethodDeclaration(m) && m.body) out.set(`${st.name.text}.${(m.name as ts.Identifier).text}`, m.body.getText());
    }
    return out;
  };
  const runtimePieces = pieces(join(angularPackage.root, 'runtime/angular.ts'));
  for (const c of ['740-ngclass-ngstyle.ts', '741-ngclass-ngstyle-lenient.ts']) {
    const casePieces = pieces(join(here, '../diff/cases', c));
    check(['ngClassNames', 'ngStyleEntries', 'viewClasses', 'NgClass.apply', 'NgClass.update', 'NgClass.toggle', 'NgStyle.apply', 'NgStyle.set'].every((k) => !!runtimePieces.get(k) && runtimePieces.get(k) === casePieces.get(k)), `diff case ${c}'s NgClass and NgStyle code is the runtime's`);
  }

  // The runtime's NgClass and NgStyle, run in Node with a stand-in for the ElementRef they inject.
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-ngclass-'));
  try {
    const unset = 'UNSET';
    writeFileSync(join(dir, 'ng.ts'), `let host: any = null;\nexport const $host = (v: any) => { host = v; };\nexport class ElementRef { nativeElement: any = host; }\nexport class ChangeDetectorRef { markForCheck(): void {} }\nexport function inject(_: any): any { return new ElementRef(); }\n`);
    writeFileSync(join(dir, 'angular.ts'), readFileSync(join(angularPackage.root, 'runtime/angular.ts'), 'utf8').replace("from '@angular/core'", "from './ng.ts'"));
    const rt = await import(join(dir, 'angular.ts'));
    const ng = await import(join(dir, 'ng.ts'));
    const record = (sets: string[]) => new Proxy({ className: '' } as Record<string, unknown>, { set: (t, k, v) => { if (k === 'className') sets.push(String(v)); t[k as string] = v; return true; } });
    const classSets: string[] = [];
    const classView = record(classSets);
    ng.$host(classView);
    const ngClass = new rt.NgClass();
    const classes = (base: string, value: unknown, toggles: unknown[]) => { classSets.length = 0; ngClass.apply([base, value, toggles]); return classView.className; };
    check(classes('card x', { a: true, 'b c': 1, d: 0 }, ['on', true]) === 'card x a b c on', 'NgClass adds the classes its value names beside the static ones and [class.x]');
    check(classes('card x', { 'b c': 1, e: true }, ['on', true]) === 'card x b c on e' && JSON.stringify(classSets) === '["card x b c on","card x b c on e"]', 'a class NgClass no longer names is removed and a new one added, one className change each: the static classes and [class.x] stay');
    check(classes('card x', { x: false, 'b c': 1, e: true }, ['on', true]) === 'card b c on e' && classes('card x', { 'b c': 1, e: true }, ['on', true]) === 'card b c on e x', 'NgClass naming a static class false removes it, and no longer naming it brings it back, as NgClass does');
    check(classes('card x', ['e'], ['on', false]) === 'card e x' && classes('card x', 'e  f ', ['on', undefined]) === 'card e x f' && classes('card x', new Set(['f']), ['on', 'yes']) === 'card x f on', 'NgClass takes a string, an array or a Set; [class.x] changes its class when its value does');
    check(classes('card x', null, ['on', true]) === 'card x on' && classSets.length === 1, 'NgClass of null removes what it added and nothing else');
    let thrownClass = '';
    try { classes('card', [1], []); } catch (e) { thrownClass = String(e); }
    check(thrownClass.includes('NgClass can only toggle CSS classes expressed as strings, got 1'), "NgClass of an array holding a non-string throws, as Angular's does");
    const names = rt.ngClassNames as (base: string, value: unknown, toggles: unknown[]) => string;
    check(names('', 'a  b ', []) === 'a b' && names('', ['a', 'b c'], []) === 'a b c' && names('', new Set(['a', 'b']), []) === 'a b' && names('', { a: true, 'b c': 1, d: 0, e: null }, []) === 'a b c', 'on a component, NgClass takes a string, an array, a Set, or an object of conditions whose keys may name several classes');
    check(names('base', null, []) === 'base' && names('base', undefined, []) === 'base' && names('base', 3, []) === 'base', 'on a component, NgClass of null, undefined or a number adds nothing to the static classes');
    const before = names('card x', { a: true, b: true }, ['on', true]), after = names('card x', { b: true }, ['on', true]);
    check(before === 'card x a b on' && after === 'card x b on', 'on a component, a class NgClass no longer names is removed, and only that one');
    check(names('card x', { x: false }, []) === 'card' && names('card x', {}, []) === 'card x', 'on a component, NgClass naming a static class false removes it, and no longer naming it brings it back');
    check(names('a x b', null, ['x', false, 'y', true]) === 'a b y' && names('a x', null, ['x', true]) === 'a x', 'without NgClass, a false [class.x] removes a static class x');
    check(names('card', { on: true }, ['on', false]) === 'card' && names('card', { on: false }, ['on', true]) === 'card on' && names('card on', null, ['on', undefined]) === 'card on', "on a component, [class.x] decides its class after NgClass, and an undefined one decides nothing");

    const sets: [string, unknown][] = [];
    const vars = new Map<string, unknown>();
    let restyled = 0;
    const style = new Proxy({ unscopedCssVariables: vars, setUnscopedCssVariable: (k: string, v: unknown) => vars.set(k, v) } as Record<string, unknown>, { set: (t, k, v) => { sets.push([String(k), v]); t[k as string] = v; return true; } });
    ng.$host({ style, _onCssStateChange: () => restyled++ });
    const ngStyle = new rt.NgStyle(unset);
    const apply = (value: unknown) => { sets.length = 0; ngStyle.apply([value]); return JSON.stringify(sets); };
    check(apply({ 'width.px': 10, 'font-size': 12, color: 'red' }) === '[["width","10px"],["font-size",12],["color","red"]]', "NgStyle sets each style by the name its key gives, a unit after the dot appended");
    check(apply({ 'width.px': 20, 'font-size': 12 }) === `[["color","${unset}"],["width","20px"]]`, 'a style no longer named is removed, a changed one set again, an unchanged one left');
    check(apply({ 'width.px': null, 'font-size': 12 }) === `[["width","${unset}"]]` && apply(null) === '[]' && apply(undefined) === '[]', "a null style value removes the style; a null or undefined NgStyle leaves the styles as they are");
    check(apply({ 'width.%': 50, 'font-size': 12 }) === `[["width","${unset}"],["width","50%"]]` && apply(new Map([['width.%', 50], ['color', 'blue']])) === `[["font-size","${unset}"],["color","blue"]]`, 'a style whose unit changes is set with the new unit, and NgStyle takes a Map');
    apply({ '--accent': 'red' });
    check(vars.get('--accent') === 'red' && restyled === 1 && apply({}) === '[]' && !vars.has('--accent') && restyled === 2, "a CSS variable is set and removed among the style's unscoped variables, as @nativescript/angular's renderer does");
    let wrong = '';
    try { rt.ngStyleEntries('color: red'); } catch (e) { wrong = String(e); }
    check(wrong.includes('NgStyle takes an object or a Map of styles'), 'NgStyle of a string throws');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- Angular fragments through nested components ----
(() => {
  const outer = angularComponent('/app/outer.component.ts', "import { Component } from '@angular/core';\n@Component({ selector: 'Outer', template: `<Inner></Inner>` })\nexport class Outer {}\n", new Map([['Inner', 'Inner']]))!;
  const infos = new Map([['Inner', { name: 'Inner', props: [], fragment: true }], ['Outer', { name: 'Outer', props: [] }]]);
  check(isFragment(outer.template, infos) && !isFragment(outer.template, new Map([['Inner', { name: 'Inner', props: [] }]])), 'a template that is one component is a fragment when that component is');
  const swift = render(outer, infos, () => false, angular.behaviour).join('\n');
  check(swift.includes('func render(into region: Region) throws'), 'a component rendering a fragment component renders into its parent region');
})();

// ---- Zoneless Angular: a listener checks its view and the views above it ----
(() => {
  const page = angularComponent('/app/status.component.ts', "import { Component } from '@angular/core';\n@Component({ selector: 'Status', template: `<StackLayout><Label [text]=\"status\"></Label><Badge [count]=\"taps\" (picked)=\"pick()\"></Badge><Button text=\"Go\" (tap)=\"go()\"></Button></StackLayout>` })\nexport class Status { status = 'idle'; taps = 0; go() { this.status = 'busy'; this.taps++; } pick() {} }\n", new Map([['Badge', 'Badge']]))!;
  const infos = new Map([['Badge', { name: 'Badge', props: ['count'], outputs: ['picked'] }], ['Status', { name: 'Status', props: [] }]]);
  for (const [backend, code] of [['Swift', render(page, infos, () => false, angular.behaviour).join('\n')], ['Kotlin', renderKotlin(page, infos, { behaviour: angular.behaviour }).join('\n')]] as const) {
    const effects = code.match(/^\s*Effect \{.*$/gm) ?? [];
    check(!effects.length && (code.match(/Check\(\{ (self|this)\._b\d+\(\) \}\)/g) ?? []).length === 2, `a zoneless template's bindings, a view's and a component input's, are checks of its view, re-read when it is checked (${backend})`);
    const listeners = code.split('\n').filter((l) => /\.kitOn\("tap"\)|\.on \{/.test(l));
    const marks = backend === 'Swift' ? /\[__dv = EffectOrder\.current\.view\] .* in Reactivity\.event\(dirty: __dv\)/ : /^\s*EffectOrder\.current\.view\.let \{ __dv -> .* -> Reactivity\.event\(__dv\) \{/;
    check(listeners.length === 2 && listeners.every((l) => marks.test(l)), `a zoneless template's listeners, a view's and a component output's, mark the view they were added in dirty (${backend})`);
  }
})();

// ---- Component providers: each instance of a component makes its own injector ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-providers-'));
  try {
    const store = join(dir, 'store.ts'), panel = join(dir, 'panel.component.ts'), page = join(dir, 'page.component.ts');
    writeFileSync(store, `import { Injectable, InjectionToken, inject } from '@angular/core';
export const LABEL = new InjectionToken<string>('LABEL');
@Injectable() export class Counter { count = 0; }
@Injectable() export class Tally { readonly counter = inject(Counter); }
`);
    writeFileSync(panel, `import { Component, inject } from '@angular/core';
import { Counter, LABEL, Tally } from './store';
@Component({ selector: 'Panel', template: '<Label [text]="label"></Label>', providers: [Counter, { provide: Tally, useClass: Tally }, { provide: LABEL, useValue: 'one' }] })
export class Panel {
  readonly tally = inject(Tally);
  readonly label = inject(LABEL);
  constructor(private readonly counter: Counter) {
    if (this.counter.count > 0) return;
    this.counter.count++;
  }
}
`);
    writeFileSync(page, "import { Component } from '@angular/core';\nimport { Panel } from './panel.component';\n@Component({ selector: 'Page', imports: [Panel], template: '<StackLayout><Panel></Panel><Panel></Panel></StackLayout>' })\nexport class Page {}\n");
    const ir = angularComponent(panel, readFileSync(panel, 'utf8'), new Map())!;
    const pageIr = angularComponent(page, readFileSync(page, 'utf8'), new Map([['Panel', 'Panel']]))!;
    const members = ir.source.slice(ir.source.indexOf('export class Panel {'));
    check(ir.injector === '$injector' && /^export class Panel \{\s*readonly \$injector = NodeInjector\.enter\(\[Counter, /.test(members) && members.indexOf('$injector') < members.indexOf('counter: Counter = inject(Counter)'), "a component's providers make its injector in its first field, before its injected constructor parameters");
    check(/\{ this\.\$injector\.provideSelf\(this\); this\.\$injector\.leave\(\); return; \}[\s\S]*this\.counter\.count\+\+;\s*this\.\$injector\.provideSelf\(this\); this\.\$injector\.leave\(\);\s*\}/.test(members), 'the injector stops being current when the constructor returns, early or at its end');
    const infos = new Map([['Panel', { name: 'Panel', props: [] }], ['Page', { name: 'Page', props: [] }]]);
    check(render(ir, infos, () => false, angular.behaviour).join('\n').includes('try EffectOrder.view(for: self, onPush: true, injector: self._injector) {') && renderKotlin(ir, infos, { behaviour: angular.behaviour }).join('\n').includes('EffectOrder.view(this._injector, this, true) {'), "a component's view injects from its injector (Swift, Kotlin)");
    const pageSwift = render(pageIr, infos, () => false, angular.behaviour).join('\n');
    check((pageSwift.match(/let c\d+ = AngularView\.construct \{ Panel\(\) \}/g) ?? []).length === 2 && pageSwift.includes('try EffectOrder.view(for: self, onPush: true) {'), 'a parent without providers renders two instances of the component, each made by its own init');
    for (const platform of ['ios', 'android'] as const) {
      const { checker, program, files } = createProgram([panel, store], new Map([[panel, ir.source]]), platform, modulesDir);
      const cls = program.getSourceFile(panel)!.statements.filter(ts.isClassDeclaration).find((c) => c.name?.text === 'Panel')!;
      if (platform === 'ios') {
        const sw = new SwiftTranslator(checker, new Map([['Panel', { props: ir.props, optional: ir.optional }]]), files);
        translateModules(sw, program, [panel, store]);
        const init = sw.componentMembers(cls, ir.props).join('\n').split('init() {')[1] ?? '';
        check(/^\s*self\._injector = NodeInjector\.enter\(JSArray<Any\?>\(\[Counter\.self, JSObject\(\[\("provide", Tally\.self\), \("useClass", Tally\.self\)\]\)/.test(init), 'each instance makes its injector first, from its providers (Swift)');
      } else {
        const kt = new Translator(checker, new Map([['Panel', { props: ir.props }]]), files, { appModule: 'org.example.app' });
        translateKotlinModules(kt, program, [panel, store]);
        const lines = kt.componentMembers(cls, ir.props).lines;
        check(/^\s*val _injector: NodeInjector = NodeInjector\.enter\(jsArrayOf<Any\?>\(Counter::class\.java, /.test(lines[0] ?? ''), 'each instance makes its injector first, from its providers (Kotlin)');
      }
    }
    const field = join(dir, 'field.component.ts');
    writeFileSync(field, "import { Component } from '@angular/core';\n@Component({ selector: 'Field', template: '<Label [text]=\"name\"></Label>' })\nexport class Field {\n  name = '';\n  take(value: any) { this.name = value; }\n}\n");
    const fieldIr = angularComponent(field, readFileSync(field, 'utf8'), new Map())!;
    const fieldProgram = createProgram([field], new Map([[field, fieldIr.source]]), 'ios', modulesDir);
    const fieldSwift = new SwiftTranslator(fieldProgram.checker, new Map([['Field', { props: fieldIr.props, optional: fieldIr.optional }]]), fieldProgram.files);
    translateModules(fieldSwift, fieldProgram.program, [field]);
    const fieldCls = fieldProgram.program.getSourceFile(field)!.statements.filter(ts.isClassDeclaration).find((c) => c.name?.text === 'Field')!;
    const fieldCode = fieldSwift.componentMembers(fieldCls, fieldIr.props).join('\n');
    check(/self\.name = [^\n]*\(value\)/.test(fieldCode) && !fieldCode.includes('jsSet(self'), "an untyped value written to a component's field is assigned to it, as a component has no members by name (Swift)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- A component extending a class: the base's members copied into it ----
(() => {
  // In a process of its own: the programs this run makes stay in memory until it ends, near Node's default heap limit.
  const r = spawnSync(process.execPath, [join(here, 'component-bases.ts')], { encoding: 'utf8', maxBuffer: 64 << 20 });
  process.stdout.write(r.stdout + r.stderr);
  failedElsewhere(Math.max((r.stdout.match(/^✗/gm) ?? []).length, r.status === 0 ? 0 : 1));
})();

// ---- Template errors are reported, never trapped ----
(() => {
  // nstreamdown's `@if (token.type === 'mermaid') { <MdMermaid [content]="…" [isIncomplete]="getIsIncomplete(token)"> }`, every binding able to throw.
  const parent = {
    name: 'Streamdown', file: '/app/streamdown.ts', source: '', props: [],
    template: [{ kind: 'element' as const, tag: 'StackLayout', attrs: [], events: [{ name: 'tap', method: '$e3', when: '$b4' }], children: [
      { kind: 'if' as const, branches: [{ cond: '$b0', body: [{ kind: 'component' as const, name: 'MdMermaid', props: [{ name: 'content', method: '$b1' }, { name: 'isIncomplete', method: '$b2' }, { name: 'token', method: '$b5' }], events: [] }] }] },
    ] }],
  };
  const children = new Map([['MdMermaid', { props: ['content', 'isIncomplete', 'token'], optional: ['content', 'isIncomplete'] }]]);
  const swift = render(parent, children, () => true, angular.behaviour).join('\n');
  const made = /let (c\d+) = AngularView\.construct \{ MdMermaid\((.*)\) \}$/m.exec(swift);
  check(!!made && made[2] === '', 'a child component is made without its inputs, whatever its bindings throw (Swift)');
  check(!!made && ['content', 'isIncomplete', 'token'].every((p, i) => new RegExp(`Check\\(\\{ try self\\._b${[1, 2, 5][i]}\\(\\) \\}\\) \\{ ${made[1]}\\.${p}\\.value = \\$0 \\}`).test(swift)), "each binding's own check sets its prop, reporting what it throws (Swift)");
  check(/Choose\(r\d+, \{ jsTruthy\(try self\._b0\(\)\) \? 0 : 1 \}[,)]/.test(swift), 'a condition that throws reaches the region, which reports it and keeps the branch it shows (Swift)');
  check(/if jsReportedTruthy\(\{ try self\._b4\(\) \}\) \{/.test(swift), "a listener's guard that throws is reported and counts as false");
  check(!/try!|try\?/.test(swift.replace(/let v\d+ = try! StackLayout\(\)/g, '')), 'no binding, condition or prop is read with try! or try?');
  const kotlin = renderKotlin(parent, children, { behaviour: angular.behaviour }).join('\n');
  check(/val c\d+ = AngularView\.construct \{ MdMermaid\(\) \}$/m.test(kotlin) && /Check\(\{ this\._b5\(\) \}\) \{ c\d+\.token\.value = it \}/.test(kotlin), "a child component is made without its inputs, each binding's check setting its prop (Kotlin)");
  check(/Choose\(r\d+, \{ if \(jsTruthy\(this\._b0\(\)\)\) 0 else 1 \}[,)]/.test(kotlin), 'a condition that throws reaches the region, which reports it and keeps the branch it shows (Kotlin)');
  const rows = { name: 'Rows', file: '/app/rows.ts', source: '', props: [], template: [{ kind: 'element' as const, tag: 'ListView', attrs: [{ name: 'items', method: '$b0' }], events: [], children: [] }] };
  const list = render(rows, new Map(), () => true, angular.behaviour).join('\n');
  check(/\.bind\(items: \{ try self\._b0\(\) \}\)/.test(list), "a list's items that throw reach the list's binding, which reports them and keeps the items it shows (Swift)");
  check(/\.bind\(items = \{ this\._b0\(\) \}\)/.test(renderKotlin(rows, new Map(), { behaviour: angular.behaviour }).join('\n')), "a list's items that throw reach the list's binding, which reports them and keeps the items it shows (Kotlin)");
})();

// ---- Angular's two passes ----
// Angular 22 makes a view in a creation pass (each child component, its static inputs, its template) and then an update
// pass in template order (a child's bound inputs, then its change and init hooks; the other bindings), then each child's
// own update, then the children's after-view hooks.
(() => {
  const parent = {
    name: 'Host', file: '/app/host.ts', source: '', props: [],
    template: [{ kind: 'element' as const, tag: 'StackLayout', attrs: [], events: [], children: [
      { kind: 'component' as const, name: 'K1', props: [{ name: 'a', method: '$b0' }, { name: 'b', value: 'lit1' }], events: [] },
      { kind: 'element' as const, tag: 'Label', attrs: [{ name: 'text', method: '$b1' }], events: [], children: [] },
      { kind: 'component' as const, name: 'K2', props: [{ name: 'a', method: '$b2' }], events: [] },
    ] }],
  };
  const kids = new Map([['K1', { props: ['a', 'b'], changes: true }], ['K2', { props: ['a'], changes: true }]]);
  /** Each text found after the one before it. */
  const inOrder = (code: string, texts: string[]) => {
    let at = 0;
    return texts.every((t) => {
      const i = code.indexOf(t, at);
      if (i >= 0) at = i + t.length;
      return i >= 0;
    });
  };
  for (const [backend, code, decl, tryIt, own, value] of [
    ['Swift', render(parent, kids, () => false, angular.behaviour).join('\n'), 'let', 'try ', 'self', '$0'],
    ['Kotlin', renderKotlin(parent, kids, { behaviour: angular.behaviour }).join('\n'), 'val', '', 'this', 'it'],
  ] as const) {
    const made = (k: string) => new RegExp(`${decl} (c\\d+) = AngularView\\.construct \\{ ${k}\\(\\) \\}\\n[^]*?${decl} \\((v\\d+), (u\\d+)\\) = (?:try )?\\1\\.__create\\(\\)`).exec(code);
    const [m1, m2] = [made('K1'), made('K2')];
    const [c1, , u1] = m1?.slice(1) ?? [];
    const [c2, , u2] = m2?.slice(1) ?? [];
    check(!!m1 && !!m2 && inOrder(code, [
      `${decl} ${c1} = AngularView.construct { K1() }`, `${c1}.b.value = "lit1"`, `${tryIt}${c1}.__create()`, `${decl} ${c2} = AngularView.construct { K2() }`, `${tryIt}${c2}.__create()`,
      `Check({ ${own}._b0() }) { ${c1}.a.value = ${value}`, `${c1}._flushChanges()`, `${c1}.__init()`,
      `Check({ ${own}._b1() }) { v`,
      `Check({ ${own}._b2() }) { ${c2}.a.value = ${value}`, `${c2}._flushChanges()`, `${c2}.__init()`,
      `${tryIt}${u1}()`, `${tryIt}${u2}()`, `${c1}.__afterView()`, `${c2}.__afterView()`,
    ]), `Angular's two passes: each child made with its static inputs and its template; then in template order its bound inputs, change and init hooks; then each child's update; then their after-view hooks (${backend})`);
  }
})();

// ---- A child component is made without its inputs, then its parent sets them ----
// Angular 22 makes a child component, its field initializers and constructor seeing only its own values (a required
// input read there throws NG0950), then sets the static inputs, then the bound ones in template order, before the
// change and init hooks. Node renders no compiled template, so no diff case reaches it.
(() => {
  const parent = {
    name: 'Host', file: '/app/host.ts', source: '', props: [],
    template: [{ kind: 'element' as const, tag: 'StackLayout', attrs: [], events: [], children: [
      { kind: 'component' as const, name: 'Kid', props: [{ name: 'tone', value: 'lit' }, { name: 'badge', method: '$b0' }, { name: 'req', method: '$b1' }, { name: 'size', method: '$b2' }], events: [] },
    ] }],
  };
  const kids = new Map([['Kid', { props: ['size', 'req', 'tone', 'badge'], optional: ['size', 'tone', 'badge'], setters: ['badge'], changes: true }]]);
  const order = (code: string, steps: RegExp[]) => {
    let at = 0;
    return steps.every((r) => {
      const m = r.exec(code.slice(at));
      if (m) at += m.index + m[0].length;
      return !!m;
    });
  };
  const swift = render(parent, kids, () => false, angular.behaviour).join('\n');
  check(order(swift, [/let (c\d+) = AngularView\.construct \{ Kid\(\) \}\n/, /\.tone\.value = "lit"; c\d+\._change\("tone", "lit"\)/, /let \(v\d+, u\d+\) = try c\d+\.__create\(\)/, /Check\(\{ self\._b0\(\) \}\) \{ c\d+\._set_badge\(\$0\)/, /Check\(\{ self\._b1\(\) \}\) \{ c\d+\.req\.value = \$0/, /Check\(\{ self\._b2\(\) \}\) \{ c\d+\.size\.value = \$0/, /_flushChanges\(\)/, /c\d+\.__init\(\)/, /try u\d+\(\)/]),
    "a child component is made without its inputs; its static inputs, then its bound ones in template order, are set before its change and init hooks and its update (Swift)");
  const kotlin = renderKotlin(parent, kids, { behaviour: angular.behaviour }).join('\n');
  check(order(kotlin, [/val (c\d+) = AngularView\.construct \{ Kid\(\) \}\n/, /\.tone\.value = "lit"; c\d+\._change\("tone", "lit"\)/, /val \(v\d+, u\d+\) = c\d+\.__create\(\)/, /Check\(\{ this\._b0\(\) \}\) \{ jsReport \{ c\d+\._set_badge\(it\)/, /Check\(\{ this\._b1\(\) \}\) \{ c\d+\.req\.value = it/, /Check\(\{ this\._b2\(\) \}\) \{ c\d+\.size\.value = it/, /_flushChanges\(\)/, /c\d+\.__init\(\)/, /u\d+\(\)/]),
    "a child component is made without its inputs; its static inputs, then its bound ones in template order, are set before its change and init hooks and its update (Kotlin)");

  const dir = mkdtempSync(join(nativeBuild, 'release-checks-input-order-'));
  const file = join(dir, 'kid.component.ts');
  writeFileSync(file, `import { Component, computed, input, model, type InputSignal, type Signal } from '@angular/core';
export const seen: string[] = [];
export class Item { constructor(public name: string) {} }
export function readItem(sig: InputSignal<Item>): Item { return sig(); }
export function readWide(sig: Signal<Item>): Item { return sig(); }
@Component({ selector: 'Kid', template: '<Label [text]="tone()"></Label>' })
export class Kid {
  tone = input('dflt');
  size = input(7);
  bare = input<string>();
  item = input.required<Item>();
  m = model('m0');
  mr = model.required<number>();
  held = this.item;
  wide: Signal<Item> = this.item;
  first = (seen.push('init tone=' + this.tone() + ' size=' + this.size() + ' bare=' + this.bare() + ' m=' + this.m()), this.tone());
  label = computed(() => this.item().name + '!');
  constructor() {
    try { this.item(); } catch (e) { seen.push('ctor threw ' + (e as Error).message); }
    try { readItem(this.item); } catch (e) { seen.push('ctor passed read threw ' + (e as Error).message); }
    try { const s = this.held; s(); } catch (e) { seen.push('ctor held read threw ' + (e as Error).message); }
    try { this.wide(); } catch (e) { seen.push('ctor wide field threw ' + (e as Error).message); }
    try { const w: Signal<Item> = this.item; w(); } catch (e) { seen.push('ctor wide local threw ' + (e as Error).message); }
    try { readWide(this.item); } catch (e) { seen.push('ctor wide param threw ' + (e as Error).message); }
    try { this.mr(); } catch (e) { seen.push('ctor model read threw ' + (e as Error).message); }
    try { this.mr.update((v) => v + 1); } catch (e) { seen.push('ctor model update threw ' + (e as Error).message); }
  }
  ngOnInit() { seen.push('init-hook tone=' + this.tone() + ' item=' + this.item().name + ' m=' + this.m() + ' label=' + this.label() + ' first=' + this.first + ' held=' + this.held().name + ' passed=' + readItem(this.item).name + ' wide=' + this.wide().name + ' wideParam=' + readWide(this.item).name + ' mr=' + this.mr()); }
}
`);
  const file2 = join(dir, 'early.component.ts');
  writeFileSync(file2, `import { Component, input } from '@angular/core';
@Component({ selector: 'Early', template: '<Label [text]="tone()"></Label>' })
export class Early {
  tone = input.required<string>();
  seen = this.tone();
}
`);
  const NG0950 = 'NG0950: Input is required but no value is available yet. Find more at https://v22.angular.dev/errors/NG0950';
  const NG0952 = 'NG0952: Model is required but no value is available yet.';
  const expected = ['init tone=dflt size=7 bare=undefined m=m0', `ctor threw ${NG0950}`, `ctor passed read threw ${NG0950}`, `ctor held read threw ${NG0950}`, `ctor wide field threw ${NG0950}`, `ctor wide local threw ${NG0950}`, `ctor wide param threw ${NG0950}`, `ctor model read threw ${NG0952}`, `ctor model update threw ${NG0952}`, 'init-hook tone=given item=given m=mp label=given! first=dflt held=given passed=given wide=given wideParam=given mr=5', `made Early: ${NG0950}`].join('\n');
  const irs = [file, file2].map((f) => angularComponent(f, readFileSync(f, 'utf8'), new Map())!);
  const overrides = new Map([[file, irs[0].source], [file2, irs[1].source]]);
  const infos = new Map([['Kid', { props: irs[0].props, optional: irs[0].optional }], ['Early', { props: irs[1].props, optional: irs[1].optional }]]);
  const run = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    return (r.stdout + r.stderr).trim();
  };
  try {
    let got: string;
    try {
      buildSwiftRuntime(nativeBuild, '-Onone');
      const { checker, program, files } = createProgram([file, file2], overrides, 'ios', modulesDir);
      const sw = new SwiftTranslator(checker, infos, files, { plainFields: true });
      const out = join(dir, 'swift');
      mkdirSync(out);
      writeFileSync(join(out, 'app.swift'), `import Foundation\nimport NativeScriptKit\n${translateModules(sw, program, [file, file2]).map((m) => m.code).join('\n')}`);
      for (const [f, name] of [[file, 'Kid'], [file2, 'Early']]) {
        const cls = program.getSourceFile(f)!.statements.filter(ts.isClassDeclaration).find((c) => c.name?.text === name)!;
        writeFileSync(join(out, `${name}.swift`), `import Foundation\nimport NativeScriptKit\nfinal class ${name} {\n${sw.componentMembers(cls, irs[name === 'Kid' ? 0 : 1].props).join('\n')}\n}\n`);
      }
      writeFileSync(join(out, 'main.swift'), `import NativeScriptKit
let kid = Kid()
kid.item.value = Item("given")
kid.tone.value = "given"
kid.m.value = "mp"
kid.mr.value = 5
try kid.ngOnInit()
for line in seen { print(line) }
do { _ = try Early(); print("made Early") } catch { print("made Early: \\(jsErrorOf(jsCaught(error)).message)") }
`);
      const errors = swiftc(readdirSync(out).map((f) => join(out, f)), join(dir, 'main'), nativeBuild, '-Onone');
      got = errors ? errors.join('\n').slice(0, 1500) : run(join(dir, 'main'), []);
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, "a child component's field initializers and constructor see its own input values, a required one throwing NG0950, and its hooks the values set after (Swift)");
    if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);

    try {
      const { checker, program, files } = createProgram([file, file2], overrides, 'android', modulesDir);
      const kt = new Translator(checker, infos, files, { appModule: 'org.example.app', plainFields: true });
      const out = join(dir, 'kotlin');
      mkdirSync(out);
      const head = 'package org.example.app\nimport org.nativescript.kit.*\n';
      writeFileSync(join(out, 'App.kt'), head + translateKotlinModules(kt, program, [file, file2]).map((m) => m.code).join('\n'));
      for (const [f, name] of [[file, 'Kid'], [file2, 'Early']]) {
        const cls = program.getSourceFile(f)!.statements.filter(ts.isClassDeclaration).find((c) => c.name?.text === name)!;
        const { params, lines } = kt.componentMembers(cls, irs[name === 'Kid' ? 0 : 1].props);
        writeFileSync(join(out, `${name}.kt`), `${head}class ${name}(${params.join(', ')}) {\n${lines.join('\n')}\n}\n`);
      }
      writeFileSync(join(out, 'Main.kt'), `import org.example.app.*
import org.nativescript.kit.*
fun main() {
    val kid = Kid()
    kid.item.value = Item("given")
    kid.tone.value = "given"
    kid.m.value = "mp"
    kid.mr.value = 5.0
    kid.ngOnInit()
    for (line in seen) println(line)
    try { Early(); println("made Early") } catch (e: Throwable) { println("made Early: " + jsErrorOf(jsCaught(e)).message) }
}
`);
      const runtime = buildKotlinRuntime(nativeBuild);
      const errors = kotlinc(readdirSync(out).map((f) => join(out, f)), join(dir, 'classes'), [runtime]);
      got = errors ? errors.join('\n').slice(0, 1500) : run('java', ['-cp', [join(dir, 'classes'), runtime, kotlinStdlib()].join(':'), 'MainKt']);
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, "a child component's field initializers and constructor see its own input values, a required one throwing NG0950, and its hooks the values set after (Kotlin)");
    if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- A component's own members named as the members its view adds ----
// Angular never calls a component's own `render`, `__create`, `__init` or `__afterView`; the members its parent and the
// app's entry call are named clear of them (template/plan.ts componentMembersOf), on both backends.
(() => {
  const dir = mkdtempSync(join(nativeBuild, 'release-checks-pass-names-'));
  const kid = join(dir, 'kid.component.ts'), host = join(dir, 'host.component.ts');
  writeFileSync(kid, `import { Component, input } from '@angular/core';
export const seen: string[] = [];
@Component({ selector: 'Kid', template: '<Label [text]="t()"></Label>' })
export class Kid {
  t = input('dflt');
  __init = 'user field __init';
  render(): string { seen.push('user render'); return 'r'; }
  __create(): string { seen.push('user __create'); return 'c'; }
  __afterView(): string { seen.push('user __afterView'); return 'a'; }
  ngOnInit() { seen.push('init t=' + this.t() + ' ' + this.render() + ' ' + this.__create() + ' ' + this.__init + ' ' + this.__afterView()); }
  ngAfterViewInit() { seen.push('afterView'); }
}
`);
  writeFileSync(host, `import { Component } from '@angular/core';
import { Kid, seen } from './kid.component';
@Component({ selector: 'Host', imports: [Kid], template: '<StackLayout><Kid [t]="given"></Kid></StackLayout>' })
export class Host {
  given = 'given';
  render = 'host field render';
  ngOnInit() { seen.push('host init ' + this.render); }
  ngAfterViewInit() { seen.push('host afterView'); }
}
`);
  const expected = ['host init host field render', 'user render', 'user __create', 'user __afterView', 'init t=given r c user field __init a', 'afterView', 'host afterView'].join('\n');
  const irs = [kid, host].map((f) => angularComponent(f, readFileSync(f, 'utf8'), new Map([['Kid', 'Kid']]))!);
  const overrides = new Map([[kid, irs[0].source], [host, irs[1].source]]);
  const run = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    return (r.stdout + r.stderr).trim();
  };
  const translated = (platform: 'ios' | 'android') => {
    const p = createProgram([kid, host], overrides, platform, modulesDir);
    const classes = [kid, host].map((f) => p.program.getSourceFile(f)!.statements.find(ts.isClassDeclaration)!);
    const infos = new Map(irs.map((ir, i) => [ir.name, { name: ir.name, props: ir.props, optional: ir.optional, changes: ir.changes, members: componentMembersOf(classes[i], p.checker) }]));
    return { ...p, classes, infos };
  };
  try {
    let got: string;
    try {
      buildSwiftRuntime(nativeBuild, '-Onone');
      const { program, files, checker, classes, infos } = translated('ios');
      const sw = new SwiftTranslator(checker, infos, files, { plainFields: true });
      const out = join(dir, 'swift');
      mkdirSync(out);
      writeFileSync(join(out, 'app.swift'), `import Foundation\nimport NativeScriptKit\n${translateModules(sw, program, [kid, host]).map((m) => m.code).join('\n')}`);
      irs.forEach((ir, i) => writeFileSync(join(out, `${ir.name}.swift`), `import Foundation\nimport NativeScriptKit\nfinal class ${ir.name} {\n${[...sw.componentMembers(classes[i], ir.props), ...render(ir, infos, () => false, angular.behaviour)].join('\n')}\n}\n`));
      // The two views the templates make, as far as their code uses them.
      writeFileSync(join(out, 'views.swift'), 'class View { init() throws {}\n  func kitSet(_ key: String, _ value: Any?) {}\n  func kitAddChild(_ view: View) {} }\nfinal class Label: View {}\nfinal class StackLayout: View {}\n');
      writeFileSync(join(out, 'main.swift'), `import NativeScriptKit\n_ = try Host().${infos.get('Host')!.members.render}()\nfor line in seen { print(line) }\n`);
      const errors = swiftc(readdirSync(out).map((f) => join(out, f)), join(dir, 'main'), nativeBuild, '-Onone');
      got = errors ? errors.join('\n').slice(0, 1500) : run(join(dir, 'main'), []);
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, "a component's own render, __create, __init and __afterView stay its own: the members its parent and the entry call are named apart (Swift)");
    if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);

    try {
      const { program, files, checker, classes, infos } = translated('android');
      const kt = new Translator(checker, infos, files, { appModule: 'org.example.app', plainFields: true });
      const out = join(dir, 'kotlin');
      mkdirSync(out);
      const head = 'package org.example.app\nimport org.nativescript.kit.*\n';
      writeFileSync(join(out, 'App.kt'), head + translateKotlinModules(kt, program, [kid, host]).map((m) => m.code).join('\n'));
      irs.forEach((ir, i) => {
        const { params, lines } = kt.componentMembers(classes[i], ir.props);
        writeFileSync(join(out, `${ir.name}.kt`), `${head}class ${ir.name}(${params.join(', ')}) {\n${[...lines, ...renderKotlin(ir, infos, { behaviour: angular.behaviour })].join('\n')}\n}\n`);
      });
      writeFileSync(join(out, 'Views.kt'), 'package org.example.app\nopen class View {\n  fun kitSet(key: String, value: Any?) {}\n  fun kitAddChild(view: View) {}\n}\nclass Label : View()\nclass StackLayout : View()\n');
      writeFileSync(join(out, 'Main.kt'), `import org.example.app.*\nfun main() {\n    Host().${infos.get('Host')!.members.render}()\n    for (line in seen) println(line)\n}\n`);
      const runtime = buildKotlinRuntime(nativeBuild);
      const errors = kotlinc(readdirSync(out).map((f) => join(out, f)), join(dir, 'classes'), [runtime]);
      got = errors ? errors.join('\n').slice(0, 1500) : run('java', ['-cp', [join(dir, 'classes'), runtime, kotlinStdlib()].join(':'), 'MainKt']);
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, "a component's own render, __create, __init and __afterView stay its own: the members its parent and the entry call are named apart (Kotlin)");
    if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- Embedded views and ngDoCheck ----
// Angular 22 (review/compiler-quality/repros/AO5-angular-order.mjs, 5): an @if branch or @for row is made at its place
// in its declaring view's update pass, and updated (its inputs, hooks, view and after-view hook) once that view's
// bindings and hooks have run, before its child components; ngDoCheck runs after ngOnInit, then on every check of the
// view its component is in. Node renders no compiled template, so no diff case reaches it.
(() => {
  const dir = mkdtempSync(join(nativeBuild, 'release-checks-embedded-'));
  // Not named Host: the Kotlin kit declares a Host.
  const kid = join(dir, 'kid.component.ts'), host = join(dir, 'outer.component.ts');
  writeFileSync(kid, `import { ChangeDetectionStrategy, Component, input } from '@angular/core';
export const seen: string[] = [];
@Component({ changeDetection: ChangeDetectionStrategy.Eager, selector: 'Kid', template: '<Label [text]="look()"></Label>' })
export class Kid {
  t = input('dflt');
  constructor() { seen.push('ctor'); }
  look(): string { seen.push('binding ' + this.t()); return this.t(); }
  ngOnInit() { seen.push('init ' + this.t()); }
  ngDoCheck() { seen.push('doCheck ' + this.t()); }
  ngAfterViewInit() { seen.push('afterView ' + this.t()); }
}
`);
  writeFileSync(host, `import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Kid, seen } from './kid.component';
@Component({ changeDetection: ChangeDetectionStrategy.Eager, selector: 'Outer', imports: [Kid], template: '<StackLayout><Kid [t]="look(\\'K3\\')"></Kid>@if (on) {<Kid [t]="look(\\'K4\\')"></Kid>}@for (i of items; track i) {<Kid [t]="look(\\'R\\' + i)"></Kid>}<Kid [t]="look(\\'K5\\')"></Kid></StackLayout>' })
export class Outer {
  on = true;
  items = ['x', 'y'];
  look(s: string): string { seen.push('reads ' + s); return s; }
  mark() { seen.push('--'); }
  ngOnInit() { seen.push('host init'); }
  ngDoCheck() { seen.push('host doCheck'); }
  ngAfterViewInit() { seen.push('host afterView'); }
}
`);
  const expected = [
    'ctor', 'ctor', 'host init', 'host doCheck', 'reads K3', 'init K3', 'doCheck K3', 'ctor', 'ctor', 'ctor', 'reads K5', 'init K5', 'doCheck K5',
    'reads K4', 'init K4', 'doCheck K4', 'binding K4', 'afterView K4', 'reads Rx', 'init Rx', 'doCheck Rx', 'binding Rx', 'afterView Rx',
    'reads Ry', 'init Ry', 'doCheck Ry', 'binding Ry', 'afterView Ry', 'binding K3', 'binding K5', 'afterView K3', 'afterView K5', 'host afterView',
    '--', 'host doCheck', 'reads K3', 'doCheck K3', 'reads K5', 'doCheck K5', 'reads K4', 'doCheck K4', 'binding K4', 'reads Rx', 'doCheck Rx',
    'binding Rx', 'reads Ry', 'doCheck Ry', 'binding Ry', 'binding K3', 'binding K5',
  ].join('\n');
  const irs = [kid, host].map((f) => angularComponent(f, readFileSync(f, 'utf8'), new Map([['Kid', 'Kid']]))!);
  const overrides = new Map([[kid, irs[0].source], [host, irs[1].source]]);
  const run = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    return (r.stdout + r.stderr).trim();
  };
  const translated = (platform: 'ios' | 'android') => {
    const p = createProgram([kid, host], overrides, platform, modulesDir);
    const classes = [kid, host].map((f) => p.program.getSourceFile(f)!.statements.find(ts.isClassDeclaration)!);
    const infos = new Map(irs.map((ir, i) => [ir.name, { name: ir.name, props: ir.props, optional: ir.optional, changes: ir.changes, doCheck: !!ir.doCheck, members: componentMembersOf(classes[i], p.checker) }]));
    return { ...p, classes, infos };
  };
  try {
    let got: string;
    try {
      buildSwiftRuntime(nativeBuild, '-Onone');
      const { program, files, checker, classes, infos } = translated('ios');
      const sw = new SwiftTranslator(checker, infos, files, { plainFields: true });
      const out = join(dir, 'swift');
      mkdirSync(out);
      writeFileSync(join(out, 'app.swift'), `import Foundation\nimport NativeScriptKit\n${translateModules(sw, program, [kid, host]).map((m) => m.code).join('\n')}`);
      irs.forEach((ir, i) => writeFileSync(join(out, `${ir.name}.swift`), `import Foundation\nimport NativeScriptKit\nfinal class ${ir.name} {\n${[...sw.componentMembers(classes[i], ir.props), ...render(ir, infos, () => false, angular.behaviour)].join('\n')}\n}\n`));
      // The views and regions the templates make, as far as their code uses them: a branch or row rendered once.
      writeFileSync(join(out, 'views.swift'), `import NativeScriptKit
class View { init() throws {}
  func kitSet(_ key: String, _ value: Any?) {}
  func kitAddChild(_ view: View) {}
  func kitAddRegion() -> Region { Region() } }
final class Label: View {}
final class StackLayout: View {}
final class Region { func attach(_ view: View) {} }
final class ForRow<Item> {
  let item: Signal<Item>
  let index: Signal<Double>
  init(_ item: Item, _ index: Double) { self.item = Signal(item, equals: { _, _ in false }); self.index = Signal(index) }
}
func Choose(_ region: Region, _ which: @escaping () throws -> Int, site: String, render: @escaping (Int) throws -> [View]) {
  var shown: Int?
  Effect { let branch = try! which(); if branch == shown { return }; shown = branch; untrack { _ = try! Owner(parent: nil).run { try render(branch) } } }
}
func ForEach<Item>(_ region: Region, _ items: @escaping () throws -> [Item], key: @escaping (Item, Double) throws -> String, site: String, render: @escaping (ForRow<Item>) throws -> [View]) {
  var made = false
  Effect { let list = try! items(); if made { return }; made = true; untrack { for (i, item) in list.enumerated() { _ = try! Owner(parent: nil).run { try render(ForRow(item, Double(i))) } } } }
}
`);
      writeFileSync(join(out, 'main.swift'), `import NativeScriptKit\nZone.enabled = true\nlet host = Outer()\n_ = try host.${infos.get('Outer')!.members.render}()\nhost.mark()\nZone.tick()\nfor line in seen { print(line) }\n`);
      const errors = swiftc(readdirSync(out).map((f) => join(out, f)), join(dir, 'main'), nativeBuild, '-Onone');
      got = errors ? errors.join('\n').slice(0, 1500) : run(join(dir, 'main'), []);
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, "an @if branch's and @for row's update passes follow their declaring view's bindings and hooks; ngDoCheck runs after ngOnInit and on every check (Swift)");
    if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);

    try {
      const { program, files, checker, classes, infos } = translated('android');
      const kt = new Translator(checker, infos, files, { appModule: 'org.example.app', plainFields: true });
      const out = join(dir, 'kotlin');
      mkdirSync(out);
      const head = 'package org.example.app\nimport org.nativescript.kit.*\n';
      writeFileSync(join(out, 'App.kt'), head + translateKotlinModules(kt, program, [kid, host]).map((m) => m.code).join('\n'));
      irs.forEach((ir, i) => {
        const { params, lines } = kt.componentMembers(classes[i], ir.props);
        writeFileSync(join(out, `${ir.name}.kt`), `${head}class ${ir.name}(${params.join(', ')}) {\n${[...lines, ...renderKotlin(ir, infos, { behaviour: angular.behaviour })].join('\n')}\n}\n`);
      });
      writeFileSync(join(out, 'Views.kt'), `${head}open class View {
  fun kitSet(key: String, value: Any?) {}
  fun kitAddChild(view: View) {}
  fun kitAddRegion(): Region = Region()
}
class Label : View()
class StackLayout : View()
class Region { fun attach(view: View) {} }
class ForRow<Item>(item: Item, index: Double) {
  val item = Signal(item) { _, _ -> false }
  val index = Signal(index)
}
fun jsKey(item: Any?): String = item.toString()
fun Choose(region: Region, which: () -> Int, site: String, render: (Int) -> List<View>) {
  var shown: Int? = null
  Effect { val branch = which(); if (branch != shown) { shown = branch; untrack { Owner(null).run { render(branch) } } } }
}
fun <Item> ForEach(region: Region, items: () -> List<Item>, key: (Item, Double) -> String, site: String, render: (ForRow<Item>) -> List<View>) {
  var made = false
  Effect { val list = items(); if (!made) { made = true; untrack { list.forEachIndexed { i, item -> Owner(null).run { render(ForRow(item, i.toDouble())) } } } } }
}
`);
      writeFileSync(join(out, 'Main.kt'), `import org.example.app.*\nimport org.nativescript.kit.*\nfun main() {\n    Zone.enabled = true\n    val host = Outer()\n    host.${infos.get('Outer')!.members.render}()\n    host.mark()\n    Zone.tick()\n    for (line in seen) println(line)\n}\n`);
      const runtime = buildKotlinRuntime(nativeBuild);
      const errors = kotlinc(readdirSync(out).map((f) => join(out, f)), join(dir, 'classes'), [runtime]);
      got = errors ? errors.join('\n').slice(0, 1500) : run('java', ['-cp', [join(dir, 'classes'), runtime, kotlinStdlib()].join(':'), 'MainKt']);
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, "an @if branch's and @for row's update passes follow their declaring view's bindings and hooks; ngDoCheck runs after ngOnInit and on every check (Kotlin)");
    if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- @let and the content and view hooks ----
// Angular 22 (review/compiler-quality/repros/AO6-angular-let-hooks.mjs, 4b): a @let is read once per check at its
// place, after the hooks before it where an embedded view reads it; ngAfterContentInit and ngAfterContentChecked run
// once the view's embedded views are updated, before its child components, ngAfterViewChecked after ngAfterViewInit; a
// root's content hooks before its template's update. Node renders no compiled template, so no diff case reaches it.
(() => {
  const dir = mkdtempSync(join(nativeBuild, 'release-checks-let-hooks-'));
  // Not named Host: the Kotlin kit declares a Host.
  const kid = join(dir, 'kid.component.ts'), host = join(dir, 'outer.component.ts');
  writeFileSync(kid, `import { ChangeDetectionStrategy, Component, input } from '@angular/core';
export const seen: string[] = [];
@Component({ changeDetection: ChangeDetectionStrategy.Eager, selector: 'Kid', template: '<Label [text]="look()"></Label>' })
export class Kid {
  t = input('dflt');
  constructor() { seen.push('ctor'); }
  look(): string { seen.push('binding ' + this.t()); return this.t(); }
  ngOnInit() { seen.push(this.t() + ' init'); }
  ngDoCheck() { seen.push(this.t() + ' doCheck'); }
  ngAfterContentInit() { seen.push(this.t() + ' contentInit'); }
  ngAfterContentChecked() { seen.push(this.t() + ' contentChecked'); }
  ngAfterViewInit() { seen.push(this.t() + ' viewInit'); }
  ngAfterViewChecked() { seen.push(this.t() + ' viewChecked'); }
}
`);
  writeFileSync(host, `import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Kid, seen } from './kid.component';
@Component({ changeDetection: ChangeDetectionStrategy.Eager, selector: 'Outer', imports: [Kid], template: '<StackLayout><Kid [t]="look(\\'K1\\')"></Kid>@let x = count(); <Kid [t]="x"></Kid>@if (on) {<Kid [t]="\\'B\\' + x"></Kid>}<Label [text]="x"></Label></StackLayout>' })
export class Outer {
  on = true;
  n = 0;
  look(s: string): string { seen.push('reads ' + s); return s; }
  count(): string { this.n += 1; seen.push('count ' + this.n); return 'L' + this.n; }
  mark() { seen.push('--'); }
  ngOnInit() { seen.push('host init'); }
  ngDoCheck() { seen.push('host doCheck'); }
  ngAfterContentInit() { seen.push('host contentInit'); }
  ngAfterContentChecked() { seen.push('host contentChecked'); }
  ngAfterViewInit() { seen.push('host viewInit'); }
  ngAfterViewChecked() { seen.push('host viewChecked'); }
}
`);
  const expected = [
    'ctor', 'ctor', 'host init', 'host doCheck', 'host contentInit', 'host contentChecked', 'reads K1', 'K1 init', 'K1 doCheck', 'count 1', 'L1 init',
    'L1 doCheck', 'ctor', 'BL1 init', 'BL1 doCheck', 'BL1 contentInit', 'BL1 contentChecked', 'binding BL1', 'BL1 viewInit', 'BL1 viewChecked',
    'K1 contentInit', 'K1 contentChecked', 'L1 contentInit', 'L1 contentChecked', 'binding K1', 'binding L1', 'K1 viewInit', 'K1 viewChecked',
    'L1 viewInit', 'L1 viewChecked', 'host viewInit', 'host viewChecked',
    '--', 'host doCheck', 'host contentChecked', 'reads K1', 'K1 doCheck', 'count 2', 'L2 doCheck', 'BL2 doCheck', 'BL2 contentChecked', 'binding BL2',
    'BL2 viewChecked', 'K1 contentChecked', 'L2 contentChecked', 'binding K1', 'binding L2', 'K1 viewChecked', 'L2 viewChecked', 'host viewChecked',
  ].join('\n');
  const irs = [kid, host].map((f) => angularComponent(f, readFileSync(f, 'utf8'), new Map([['Kid', 'Kid']]))!);
  const overrides = new Map([[kid, irs[0].source], [host, irs[1].source]]);
  const run = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    return (r.stdout + r.stderr).trim();
  };
  const translated = (platform: 'ios' | 'android') => {
    const p = createProgram([kid, host], overrides, platform, modulesDir);
    const classes = [kid, host].map((f) => p.program.getSourceFile(f)!.statements.find(ts.isClassDeclaration)!);
    const infos = new Map(irs.map((ir, i) => [ir.name, { name: ir.name, props: ir.props, optional: ir.optional, changes: ir.changes, doCheck: !!ir.doCheck, afterContentInit: !!ir.afterContentInit, afterContentChecked: !!ir.afterContentChecked, afterViewChecked: !!ir.afterViewChecked, members: componentMembersOf(classes[i], p.checker) }]));
    return { ...p, classes, infos };
  };
  try {
    let got: string;
    try {
      buildSwiftRuntime(nativeBuild, '-Onone');
      const { program, files, checker, classes, infos } = translated('ios');
      const sw = new SwiftTranslator(checker, infos, files, { plainFields: true });
      const out = join(dir, 'swift');
      mkdirSync(out);
      writeFileSync(join(out, 'app.swift'), `import Foundation\nimport NativeScriptKit\n${translateModules(sw, program, [kid, host]).map((m) => m.code).join('\n')}`);
      irs.forEach((ir, i) => writeFileSync(join(out, `${ir.name}.swift`), `import Foundation\nimport NativeScriptKit\nfinal class ${ir.name} {\n${[...sw.componentMembers(classes[i], ir.props), ...render(ir, infos, () => false, angular.behaviour)].join('\n')}\n}\n`));
      // The views and regions the templates make, as far as their code uses them: a branch or row rendered once.
      writeFileSync(join(out, 'views.swift'), `import NativeScriptKit
class View { init() throws {}
  func kitSet(_ key: String, _ value: Any?) {}
  func kitAddChild(_ view: View) {}
  func kitAddRegion() -> Region { Region() } }
final class Label: View {}
final class StackLayout: View {}
final class Region { func attach(_ view: View) {} }
final class ForRow<Item> {
  let item: Signal<Item>
  let index: Signal<Double>
  init(_ item: Item, _ index: Double) { self.item = Signal(item, equals: { _, _ in false }); self.index = Signal(index) }
}
func Choose(_ region: Region, _ which: @escaping () throws -> Int, site: String, render: @escaping (Int) throws -> [View]) {
  var shown: Int?
  Effect { let branch = try! which(); if branch == shown { return }; shown = branch; untrack { _ = try! Owner(parent: nil).run { try render(branch) } } }
}
func ForEach<Item>(_ region: Region, _ items: @escaping () throws -> [Item], key: @escaping (Item, Double) throws -> String, site: String, render: @escaping (ForRow<Item>) throws -> [View]) {
  var made = false
  Effect { let list = try! items(); if made { return }; made = true; untrack { for (i, item) in list.enumerated() { _ = try! Owner(parent: nil).run { try render(ForRow(item, Double(i))) } } } }
}
`);
      writeFileSync(join(out, 'main.swift'), `import NativeScriptKit\nZone.enabled = true\nlet host = Outer()\n_ = try host.${infos.get('Outer')!.members.render}()\nhost.mark()\nZone.tick()\nfor line in seen { print(line) }\n`);
      const errors = swiftc(readdirSync(out).map((f) => join(out, f)), join(dir, 'main'), nativeBuild, '-Onone');
      got = errors ? errors.join('\n').slice(0, 1500) : run(join(dir, 'main'), []);
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, "a @let is read once per check at its place; the content and view hooks run where Angular runs them (Swift)");
    if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);

    try {
      const { program, files, checker, classes, infos } = translated('android');
      const kt = new Translator(checker, infos, files, { appModule: 'org.example.app', plainFields: true });
      const out = join(dir, 'kotlin');
      mkdirSync(out);
      const head = 'package org.example.app\nimport org.nativescript.kit.*\n';
      writeFileSync(join(out, 'App.kt'), head + translateKotlinModules(kt, program, [kid, host]).map((m) => m.code).join('\n'));
      irs.forEach((ir, i) => {
        const { params, lines } = kt.componentMembers(classes[i], ir.props);
        writeFileSync(join(out, `${ir.name}.kt`), `${head}class ${ir.name}(${params.join(', ')}) {\n${[...lines, ...renderKotlin(ir, infos, { behaviour: angular.behaviour })].join('\n')}\n}\n`);
      });
      writeFileSync(join(out, 'Views.kt'), `${head}open class View {
  fun kitSet(key: String, value: Any?) {}
  fun kitAddChild(view: View) {}
  fun kitAddRegion(): Region = Region()
}
class Label : View()
class StackLayout : View()
class Region { fun attach(view: View) {} }
class ForRow<Item>(item: Item, index: Double) {
  val item = Signal(item) { _, _ -> false }
  val index = Signal(index)
}
fun jsKey(item: Any?): String = item.toString()
fun Choose(region: Region, which: () -> Int, site: String, render: (Int) -> List<View>) {
  var shown: Int? = null
  Effect { val branch = which(); if (branch != shown) { shown = branch; untrack { Owner(null).run { render(branch) } } } }
}
fun <Item> ForEach(region: Region, items: () -> List<Item>, key: (Item, Double) -> String, site: String, render: (ForRow<Item>) -> List<View>) {
  var made = false
  Effect { val list = items(); if (!made) { made = true; untrack { list.forEachIndexed { i, item -> Owner(null).run { render(ForRow(item, i.toDouble())) } } } } }
}
`);
      writeFileSync(join(out, 'Main.kt'), `import org.example.app.*\nimport org.nativescript.kit.*\nfun main() {\n    Zone.enabled = true\n    val host = Outer()\n    host.${infos.get('Outer')!.members.render}()\n    host.mark()\n    Zone.tick()\n    for (line in seen) println(line)\n}\n`);
      const runtime = buildKotlinRuntime(nativeBuild);
      const errors = kotlinc(readdirSync(out).map((f) => join(out, f)), join(dir, 'classes'), [runtime]);
      got = errors ? errors.join('\n').slice(0, 1500) : run('java', ['-cp', [join(dir, 'classes'), runtime, kotlinStdlib()].join(':'), 'MainKt']);
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, "a @let is read once per check at its place; the content and view hooks run where Angular runs them (Kotlin)");
    if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- A component's computed signal read in a binding ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-computed-'));
  try {
    const file = join(dir, 'people.component.ts');
    writeFileSync(file, `import { Component, computed, signal } from '@angular/core';
const BYLINE = { byline: true } as const;
class Person { name = 'Ada'; }
type Row = Person | typeof BYLINE;
@Component({ selector: 'People', template: '<ListView [items]="rows()"></ListView>' })
export class People {
  readonly people = signal<Person[]>([]);
  readonly rows = computed<Row[]>(() => [BYLINE, ...this.people()]);
}
`);
    const ir = angularComponent(file, readFileSync(file, 'utf8'), new Map())!;
    const { checker, program, files } = createProgram([file], new Map([[file, ir.source]]), 'ios', modulesDir);
    const sw = new SwiftTranslator(checker, new Map([['People', { props: ir.props, optional: ir.optional }]]), files, { plainFields: true });
    translateModules(sw, program, [file]);
    const cls = program.getSourceFile(file)!.statements.filter(ts.isClassDeclaration).find((c) => c.name?.text === 'People')!;
    sw.componentMembers(cls, ir.props);
    const items = (ir.template as { attrs?: { name: string; method?: string }[] }[])[0]?.attrs?.find((a) => a.name === 'items')?.method ?? '-';
    check(!sw.memberThrows(cls, items), "reading a component's computed array (`rows()`) in a binding throws nothing (Swift)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- A linkedSignal over a required input ----
// Angular computes a linkedSignal on its first read, not as the component is made: one over a required input computes
// once the parent has set it, and again on the read after it changes; a read before then throws NG0950.
(() => {
  const dir = mkdtempSync(join(nativeBuild, 'release-checks-linked-required-'));
  const file = join(dir, 'kid.component.ts');
  writeFileSync(file, `import { Component, input, linkedSignal } from '@angular/core';
export const seen: string[] = [];
@Component({ selector: 'Kid', template: '<Label [text]="label()"></Label>' })
export class Kid {
  item = input.required<string>();
  label = linkedSignal(() => {
    seen.push('compute ' + this.item());
    return 'L' + this.item();
  });
  constructor() {
    seen.push('ctor');
    try {
      seen.push('ctor read ' + this.label());
    } catch (e) {
      seen.push('ctor read threw ' + (e as Error).message);
    }
  }
  ngOnInit() { seen.push('init ' + this.label()); }
  again() { seen.push('again ' + this.label() + ' ' + this.label()); }
}
`);
  const expected = ['ctor', 'ctor read threw NG0950: Input is required but no value is available yet. Find more at https://v22.angular.dev/errors/NG0950', 'compute x', 'init Lx', 'compute y', 'again Ly Ly'].join('\n');
  const ir = angularComponent(file, readFileSync(file, 'utf8'), new Map())!;
  const overrides = new Map([[file, ir.source]]);
  const infos = new Map([['Kid', { props: ir.props, optional: ir.optional }]]);
  const run = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    return (r.stdout + r.stderr).trim();
  };
  const kidClass = (program: ts.Program) => program.getSourceFile(file)!.statements.filter(ts.isClassDeclaration).find((c) => c.name?.text === 'Kid')!;
  try {
    let got: string;
    try {
      buildSwiftRuntime(nativeBuild, '-Onone');
      const { checker, program, files } = createProgram([file], overrides, 'ios', modulesDir);
      const sw = new SwiftTranslator(checker, infos, files, { plainFields: true });
      const out = join(dir, 'swift');
      mkdirSync(out);
      writeFileSync(join(out, 'app.swift'), `import Foundation\nimport NativeScriptKit\n${translateModules(sw, program, [file]).map((m) => m.code).join('\n')}`);
      writeFileSync(join(out, 'Kid.swift'), `import Foundation\nimport NativeScriptKit\nfinal class Kid {\n${sw.componentMembers(kidClass(program), ir.props).join('\n')}\n}\n`);
      writeFileSync(join(out, 'main.swift'), `import NativeScriptKit
let kid = Kid()
kid.item.value = "x"
try kid.ngOnInit()
kid.item.value = "y"
try kid.again()
for line in seen { print(line) }
`);
      const errors = swiftc(readdirSync(out).map((f) => join(out, f)), join(dir, 'main'), nativeBuild, '-Onone');
      got = errors ? errors.join('\n').slice(0, 1500) : run(join(dir, 'main'), []);
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, 'a linkedSignal over a required input throws NG0950 on a read before the parent sets the input, computes on the first read after, and again after it changes (Swift)');
    if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);

    try {
      const { checker, program, files } = createProgram([file], overrides, 'android', modulesDir);
      const kt = new Translator(checker, infos, files, { appModule: 'org.example.app', plainFields: true });
      const out = join(dir, 'kotlin');
      mkdirSync(out);
      const head = 'package org.example.app\nimport org.nativescript.kit.*\n';
      writeFileSync(join(out, 'App.kt'), head + translateKotlinModules(kt, program, [file]).map((m) => m.code).join('\n'));
      const { params, lines } = kt.componentMembers(kidClass(program), ir.props);
      writeFileSync(join(out, 'Kid.kt'), `${head}class Kid(${params.join(', ')}) {\n${lines.join('\n')}\n}\n`);
      writeFileSync(join(out, 'Main.kt'), `import org.example.app.*
fun main() {
    val kid = Kid()
    kid.item.value = "x"
    kid.ngOnInit()
    kid.item.value = "y"
    kid.again()
    for (line in seen) println(line)
}
`);
      const runtime = buildKotlinRuntime(nativeBuild);
      const errors = kotlinc(readdirSync(out).map((f) => join(out, f)), join(dir, 'classes'), [runtime]);
      got = errors ? errors.join('\n').slice(0, 1500) : run('java', ['-cp', [join(dir, 'classes'), runtime, kotlinStdlib()].join(':'), 'MainKt']);
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, 'a linkedSignal over a required input throws NG0950 on a read before the parent sets the input, computes on the first read after, and again after it changes (Kotlin)');
    if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- A non-strict app's signal made with null, read by a template's binding ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-null-signal-'));
  try {
    const file = join(dir, 'person.component.ts');
    writeFileSync(file, `import { Component, signal } from '@angular/core';
class Person { name = 'Ada'; }
@Component({ selector: 'PersonView', template: '@if (person(); as person) { <Label [bindingContext]="person"></Label> }' })
export class PersonView {
  readonly person = signal<Person>(null);
  current(): Person { return this.person(); }
}
`);
    const ir = angularComponent(file, readFileSync(file, 'utf8'), new Map())!;
    const { checker, program, files } = createProgram([file], new Map([[file, ir.source]]), 'ios', modulesDir, undefined, [], {}, { strict: false, useUnknownInCatchVariables: false });
    const sw = new SwiftTranslator(checker, new Map([['PersonView', { props: ir.props, optional: ir.optional }]]), files, { lenientApp: true });
    translateModules(sw, program, [file]);
    const cls = program.getSourceFile(file)!.statements.filter(ts.isClassDeclaration).find((c) => c.name?.text === 'PersonView')!;
    const methods = cls.members.filter(ts.isMethodDeclaration);
    const binding = methods.find((m) => /^\$b\d+$/.test(m.name.getText()) && /return \(+this\.person\(\)\)+!?\)+;/.test(m.getText()));
    const current = methods.find((m) => m.name.getText() === 'current')!;
    check(!!binding && sw.returnTypeOf(binding) === 'Person' && sw.returnTypeOf(current) === 'Person?', `a template binding reading a non-strict app's signal made with null gives the type the template's codegen takes, where the app's own method gives an optional (Swift: ${binding ? sw.returnTypeOf(binding) : 'no binding'}, ${sw.returnTypeOf(current)})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- An injected ViewContainerRef (constructor parameter, inject(), Injector.get) ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-view-container-'));
  try {
    const file = join(dir, 'sheet.component.ts');
    const source = (member: string) => `import { Component, Injector, ViewContainerRef, inject } from '@angular/core';
@Component({ selector: 'Sheet', template: '<Label text="x"></Label>' })
export class Sheet {
  ${member}
  open(): number { return 1; }
}
`;
    for (const member of [
      'constructor(private vcRef: ViewContainerRef) {}',
      'vcRef = inject(ViewContainerRef);',
      'vcRef = inject(Injector).get(ViewContainerRef);',
    ]) {
      const ir = angularComponent(file, source(member), new Map())!;
      for (const platform of ['ios', 'android'] as const) {
        const { checker, program, files, lenient } = createProgram([file], new Map([[file, ir.source]]), platform, modulesDir);
        const cls = program.getSourceFile(file)!.statements.filter(ts.isClassDeclaration).find((c) => c.name?.text === 'Sheet')!;
        let out = '';
        if (platform === 'ios') {
          const sw = new SwiftTranslator(checker, new Map([['Sheet', { props: ir.props, optional: ir.optional }]]), files, { lenientApp: lenient });
          translateModules(sw, program, [file]);
          out = sw.componentMembers(cls, ir.props).join('\n');
        } else {
          const kt = new Translator(checker, new Map([['Sheet', { props: ir.props }]]), files, { lenientApp: lenient, appModule: 'org.example.app' });
          translateKotlinModules(kt, program, [file]);
          out = kt.componentMembers(cls, ir.props).lines.join('\n');
        }
        const ok = out.includes('ViewContainerRef.current()') || out.includes('Injector.root.get(') || out.includes('Injector.shared.get(');
        check(ok, `an injected ViewContainerRef translates cleanly (${platform}, ${member}${ok ? '' : `: ${out.slice(0, 300)}`})`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- An injected class only a library's typings declare (constructor parameter, @Inject, inject()) ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-typings-token-'));
  try {
    const typings = join(dir, 'sheet-lib.d.ts');
    writeFileSync(typings, "declare module 'sheet-lib' { export class SheetParams { context: any; } }\n");
    const file = join(dir, 'sheet.component.ts');
    const source = (member: string) => `import { Component, Inject, inject } from '@angular/core';
import { SheetParams } from 'sheet-lib';
@Component({ selector: 'Sheet', template: '<Label text="x"></Label>' })
export class Sheet {
  ${member}
  open(): number { return 1; }
}
`;
    for (const member of ['constructor(private params: SheetParams) {}', 'constructor(@Inject(SheetParams) private params: any) {}', 'params = inject(SheetParams);']) {
      const ir = angularComponent(file, source(member), new Map())!;
      for (const platform of ['ios', 'android'] as const) {
        const { checker, program, files, lenient } = createProgram([file, typings], new Map([[file, ir.source]]), platform, modulesDir);
        let refusal = '';
        try {
          const cls = program.getSourceFile(file)!.statements.filter(ts.isClassDeclaration).find((c) => c.name?.text === 'Sheet')!;
          if (platform === 'ios') {
            const sw = new SwiftTranslator(checker, new Map([['Sheet', { props: ir.props, optional: ir.optional }]]), files, { lenientApp: lenient });
            translateModules(sw, program, [file]);
            sw.componentMembers(cls, ir.props);
          } else {
            const kt = new Translator(checker, new Map([['Sheet', { props: ir.props }]]), files, { lenientApp: lenient, appModule: 'org.example.app' });
            translateKotlinModules(kt, program, [file]);
            kt.componentMembers(cls, ir.props);
          }
        } catch (e) {
          refusal = String((e as Error).message);
        }
        const ok = refusal.includes("an injected class only a library's typings declare (SheetParams) is not supported in a release build yet");
        check(ok, `an injected class only typings declare stops the build at the inject (${platform}, ${member}${ok ? '' : `: ${refusal.slice(0, 300) || 'translated'}`})`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- A component's own methods taking null or undefined both (the `ns create --ng` template's person detail) ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-nullish-method-'));
  try {
    writeFileSync(join(dir, 'tsconfig.json'), '{ "compilerOptions": { "strict": false } }');
    const file = join(dir, 'person-detail.component.ts'), observed = join(dir, 'kinds.component.ts');
    writeFileSync(file, `import { Component, OnInit, signal } from '@angular/core';
interface Person { name: string; nickname: string; notableAchievements: string[]; }
@Component({ selector: 'PersonDetail', template: '<StackLayout><Label [text]="formatAchievements(person()?.notableAchievements)"></Label><Label [text]="label(person()?.nickname)"></Label></StackLayout>' })
export class PersonDetail implements OnInit {
  person = signal<Person>(null);
  ngOnInit(): void { console.log(this.formatAchievements(null), this.label(null), this.label(undefined)); }
  formatAchievements(achievements: string[] | undefined | null): string {
    if (!achievements || !Array.isArray(achievements)) return '';
    return achievements.map((a, index) => index + 1 + '. ' + a.trim()).join('\\n');
  }
  label(name: string | undefined | null): string { return name === null ? '(null)' : name === undefined ? '(undefined)' : name; }
}
`);
    writeFileSync(observed, `import { Component } from '@angular/core';
@Component({ selector: 'Kinds', template: '<Label [text]="kind(null)"></Label>' })
export class Kinds {
  kind(list: string[] | undefined | null): string { return list === null ? 'null' : list === undefined ? 'undefined' : 'list'; }
}
`);
    const ir = angularComponent(file, readFileSync(file, 'utf8'), new Map())!;
    const kinds = angularComponent(observed, readFileSync(observed, 'utf8'), new Map())!;
    for (const platform of ['ios', 'android'] as const) {
      const name = platform === 'ios' ? 'Swift' : 'Kotlin';
      const { checker, program, files, lenient } = createProgram([file], new Map([[file, ir.source]]), platform, modulesDir);
      const cls = program.getSourceFile(file)!.statements.filter(ts.isClassDeclaration).find((c) => c.name?.text === 'PersonDetail')!;
      let code = '';
      try {
        if (platform === 'ios') {
          const sw = new SwiftTranslator(checker, new Map([['PersonDetail', { props: ir.props, optional: ir.optional }]]), files, { lenientApp: lenient });
          translateModules(sw, program, [file]);
          code = sw.componentMembers(cls, ir.props).join('\n');
        } else {
          const kt = new Translator(checker, new Map([['PersonDetail', { props: ir.props }]]), files, { lenientApp: lenient, appModule: 'org.example.app' });
          translateKotlinModules(kt, program, [file]);
          code = kt.componentMembers(cls, ir.props).lines.join('\n');
        }
      } catch (e) {
        code = String((e as Error).message);
      }
      const typed = platform === 'ios' ? /func formatAchievements\(_ achievements: JSArray<String>\?\)/.test(code) && /func label\(_ name: JSNullish<String>\)/.test(code) : /fun formatAchievements\(achievements: JSArray<String>\?\)/.test(code) && /fun label\(name: JSNullish<String>\)/.test(code);
      check(lenient && typed, `a component's method given null or undefined both by its template and its code translates: an array it never tells apart keeps one nil, a string it does is held as JSNullish (${name}${typed ? '' : `: ${code.split('\n').find((l) => /formatAchievements|label|not supported/.test(l))?.trim().slice(0, 160)}`})`);
      const other = createProgram([observed], new Map([[observed, kinds.source]]), platform, modulesDir);
      const kindsCls = other.program.getSourceFile(observed)!.statements.filter(ts.isClassDeclaration).find((c) => c.name?.text === 'Kinds')!;
      let held = '';
      try {
        if (platform === 'ios') {
          const sw = new SwiftTranslator(other.checker, new Map([['Kinds', { props: kinds.props, optional: kinds.optional }]]), other.files, { lenientApp: other.lenient });
          translateModules(sw, other.program, [observed]);
          held = sw.componentMembers(kindsCls, kinds.props).join('\n');
        } else {
          const kt = new Translator(other.checker, new Map([['Kinds', { props: kinds.props }]]), other.files, { lenientApp: other.lenient, appModule: 'org.example.app' });
          translateKotlinModules(kt, other.program, [observed]);
          held = kt.componentMembers(kindsCls, kinds.props).lines.join('\n');
        }
      } catch (e) {
        held = String((e as Error).message);
      }
      const apart = platform === 'ios' ? /func kind\(_ list: JSNullish<JSArray<String>>\)/.test(held) && /self\.kind\(\.null\)/.test(held) : /fun kind\(list: JSNullish<JSArray<String>>\)/.test(held) && /this\.kind\(JSNullish\.Null\)/.test(held);
      check(apart, `a component's method telling null from undefined in an array holds it as JSNullish, its template's null given as null (case 1171 runs it) (${name}${apart ? '' : `: ${held.split('\n').find((l) => /kind|not supported/.test(l))?.trim().slice(0, 200)}`})`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- A plugin's @Injectable class with a base, or extended ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-plugin-service-'));
  try {
    writeFileSync(join(dir, 'store.ts'), "import { Injectable } from '@angular/core';\nexport class Source<T> { constructor(readonly value: T) {} }\n@Injectable()\nexport class Store<T> extends Source<T> { constructor() { super(null as T); } }\n");
    writeFileSync(join(dir, 'component-store.ts'), "import { Injectable } from '@angular/core';\n@Injectable()\nexport class ComponentStore<T> { state?: T; patch(s: T) { this.state = s; } }\n");
    const pluginFiles = [join(dir, 'store.ts'), join(dir, 'component-store.ts')];
    const translate = (text: string, platform: 'ios' | 'android') => {
      const app = join(dir, 'app.ts');
      writeFileSync(app, text);
      const { checker, program } = createProgram([app], new Map(), platform, modulesDir);
      const all = program.getSourceFiles().filter((f) => !f.isDeclarationFile);
      try {
        if (platform === 'ios') return translateModules(new SwiftTranslator(checker, new Map(), all, { pluginFiles }), program, all.map((f) => f.fileName)).map((m) => m.code).join('\n');
        const translator = new Translator(checker, new Map(), all, { pluginFiles, appModule: 'org.example.app' });
        return translateKotlinModules(translator, program, all.map((f) => f.fileName)).map((m) => m.code).join('\n');
      } catch (e) {
        return `error: ${(e as Error).message}`;
      }
    };
    const based = "import { Store } from './store';\nexport const s = new Store<number>();\n";
    const extending = "import { Injectable } from '@angular/core';\nimport { ComponentStore } from './component-store';\n@Injectable() export class Cart extends ComponentStore<string> {}\nexport const c = new Cart();\n";
    const swiftBased = translate(based, 'ios'), kotlinBased = translate(based, 'android');
    check(/^final class Store: Source \{/m.test(swiftBased) && /super\.init\(jsNull\)/.test(swiftBased) && !/shared: Store/.test(swiftBased), "a plugin's @Injectable class extending a class keeps its base and its super call, a plain class (Swift)");
    check(/^class Store : Source \{/m.test(kotlinBased) && /constructor\(\) : super\(jsNull\)/.test(kotlinBased) && /^open class Source : JSDynamic/m.test(kotlinBased) && !/shared: Store/.test(kotlinBased), "a plugin's @Injectable class extending a class keeps its base and its super call, a plain class (Kotlin)");
    const swiftExtending = translate(extending, 'ios'), kotlinExtending = translate(extending, 'android');
    check(/^final class Cart: ComponentStore \{/m.test(swiftExtending) && /static var shared: Cart \{ Injector\.root\(Cart\.self/.test(swiftExtending), "an app's @Injectable class extending a plugin's @Injectable class extends it and is the injector's service (Swift)");
    check(/^class Cart : ComponentStore \{/m.test(kotlinExtending) && /val shared: Cart get\(\) = AppInjector\.service\(Cart::class\.java\)/.test(kotlinExtending), "an app's @Injectable class extending a plugin's @Injectable class extends it and is the injector's service (Kotlin)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- Framework kit auto-detection & layering + Angular C2/E5/F6/F7/F12 ----
await (async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-ng-kit-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { '@angular/core': '~19.0.0' } }));
    mkdirSync(join(dir, 'nested-xml', 'app'), { recursive: true });
    writeFileSync(join(dir, 'nested-xml', 'package.json'), JSON.stringify({ dependencies: { '@nativescript/core': '~9.1.0' } }));
    writeFileSync(join(dir, 'nested-xml', 'app', 'main-page.xml'), '<Page></Page>');
    check(detectFramework(dir, availableAdapters(dir)) === 'angular' && detectFramework(join(dir, 'nested-xml'), availableAdapters(join(dir, 'nested-xml'))) === 'core', 'detectFramework auto-detects angular from package.json dependencies without leaking ancestor packages');
    // An adapter is chosen by its package.json alone; one the compiler cannot run stops the build naming the package to install.
    const v = compilerVersion();
    const thrown = (f: () => unknown) => { try { f(); return ''; } catch (e) { return String((e as Error).message); } };
    const thrownAsync = async (f: () => Promise<unknown>) => { try { await f(); return ''; } catch (e) { return String((e as Error).message); } };
    check(detectFramework(dir, []) === 'angular' && thrown(() => adapterOf('angular', [])).includes(`which is not installed: npm i -D @nstudio/nativescript-compiler-angular@${v}`),
      "an app of a framework whose adapter is not installed is told the npm command installing it at the compiler's version");
    const fake = (name: string, block: object, peer: string) => {
      const d = join(dir, 'node_modules', '@nstudio', name);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'package.json'), JSON.stringify({ name: `@nstudio/${name}`, version: '1.0.0', exports: { '.': './index.js' }, peerDependencies: { '@nstudio/nativescript-compiler': peer }, nativescript: { compilerAdapter: block } }));
    };
    fake('nativescript-compiler-angular', { apiVersion: 99, detect: { dependencies: ['@angular/core'] } }, v);
    fake('nativescript-compiler-vue', { apiVersion: 1, detect: { dependencies: ['vue'] } }, '0.0.1');
    fake('nativescript-compiler-other', { apiVersion: 1 }, v);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { '@angular/core': '~19.0.0' }, devDependencies: { '@nstudio/nativescript-compiler-angular': '1.0.0', '@nstudio/nativescript-compiler-vue': '1.0.0' } }));
    const override = process.env[ADAPTERS_OVERRIDE];
    delete process.env[ADAPTERS_OVERRIDE];
    const installed = availableAdapters(dir);
    if (override !== undefined) process.env[ADAPTERS_OVERRIDE] = override;
    const api = await thrownAsync(() => loadAdapter(adapterOf('angular', installed)));
    const peer = await thrownAsync(() => loadAdapter(adapterOf('vue', installed)));
    check(installed.map((a) => a.framework).join() === 'angular,vue' && api.includes(`is written for compiler adapter API 99, and this @nstudio/nativescript-compiler ${v} reads API 1: install the @nstudio/nativescript-compiler-angular released with this compiler: npm i -D @nstudio/nativescript-compiler-angular@${v}`)
      && peer.includes(`is built for @nstudio/nativescript-compiler 0.0.1, and this is ${v}: install the @nstudio/nativescript-compiler-vue released with this compiler: npm i -D @nstudio/nativescript-compiler-vue@${v}`),
      `only the adapters the app's package.json lists are found, and one for another adapter API or compiler version is refused (${api} | ${peer})`);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { '@angular/core': '~19.0.0' } }));
    check(existsSync(join(adapterKitOf(angular).apple!, 'AngularAPI.swift')) && existsSync(join(adapterKitOf(angular).androidGenerated!, 'AngularAPI.kt')), "an adapter's kit sources are found from its package's root");

    const compFile = join(dir, 'profile-card.component.ts');
    writeFileSync(compFile, `
import { Component, Injectable, Input, Optional, SkipSelf, input, model } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class CardService {
  prefix = 'card:';
}

@Injectable({ providedIn: 'root' })
export class CoreSingletonModule {
  constructor(@Optional() @SkipSelf() parentModule?: CoreSingletonModule) {
    if (parentModule) throw new Error('already loaded');
  }
}

@Component({
  selector: 'ProfileCard',
  template: '<Label [text]="displayTitle"></Label>',
})
export class ProfileCardComponent {
  subtitle = input<string>();
  active = model<boolean>();
  private _title = '';
  private _badge = '';

  constructor(private cardService: CardService) {}

  @Input()
  get title(): string {
    return this._title;
  }
  set title(v: string) {
    this._title = v.trim();
  }

  @Input()
  set badge(v: string) {
    this._badge = '[' + v + ']';
  }

  get displayTitle(): string {
    return this.cardService.prefix + this._title + this._badge + (this.subtitle() ?? '');
  }
}
`);
    const ir = angularComponent(compFile, readFileSync(compFile, 'utf8'), new Map())!;
    check(ir.props.includes('subtitle') && ir.props.includes('active') && ir.props.includes('title') && ir.props.includes('badge'), 'angularComponent extracts 0-arg input<T>()/model<T>() and getter/setter @Input props');

    const overrides = new Map([[compFile, ir.source]]);
    const { checker: swChecker, program: swProg, files: swFiles } = createProgram([compFile], overrides, 'ios', modulesDir);
    const sw = new SwiftTranslator(swChecker, new Map([['ProfileCardComponent', { props: ir.props, optional: ir.optional }]]), swFiles, { plainFields: true });
    const swMod = translateModules(sw, swProg, [compFile]).map((m) => m.code).join('\n');
    const swCls = swProg.getSourceFile(compFile)!.statements.filter(ts.isClassDeclaration).find((c) => c.name?.text === 'ProfileCardComponent')!;
    const swCode = sw.componentMembers(swCls, ir.props).join('\n') + '\n' + swMod;
    check(/let subtitle: Signal<String\?>/.test(swCode) && /let active: Signal<Bool\?>/.test(swCode) && /init\(subtitle: String\? = nil, active: Bool\? = nil\)/.test(swCode), '0-arg input<T>() and model<T>() emit optional Signal initialized to nil (Swift)');
    check(/let cardService: CardService/.test(swCode) && /self\.cardService = CardService\.shared/.test(swCode), '@Component constructor parameter property is DI-resolved to shared instance (Swift)');
    check(/var title: String \{/.test(swCode) && /func _set_title\(/.test(swCode) && /func _set_badge\(/.test(swCode), 'getter+setter and setter-only @Input accessors rewrite cleanly to getter + _set_ methods (Swift)');
    check(/init\(_ parentModule: CoreSingletonModule\? = nil\)/.test(swCode), '@Optional() @SkipSelf() singleton guard parameter defaults to nil (Swift)');

    const { checker: ktChecker, program: ktProg, files: ktFiles } = createProgram([compFile], overrides, 'android', modulesDir);
    const kt = new Translator(ktChecker, new Map([['ProfileCardComponent', { props: ir.props, optional: ir.optional }]]), ktFiles, { appModule: 'org.example.app', plainFields: true });
    const ktMod = translateKotlinModules(kt, ktProg, [compFile]).map((m) => m.code).join('\n');
    const ktCls = ktProg.getSourceFile(compFile)!.statements.filter(ts.isClassDeclaration).find((c) => c.name?.text === 'ProfileCardComponent')!;
    const ktMembers = kt.componentMembers(ktCls, ir.props);
    const ktCode = [...ktMembers.params, ...ktMembers.lines, ktMod].join('\n');
    check(/subtitle: String\? = null/.test(ktCode) && /active: Boolean\? = null/.test(ktCode) && /val subtitle: Signal<String\?> = Signal<String\?>\(subtitle\)/.test(ktCode) && /val active: Signal<Boolean\?> = Signal<Boolean\?>\(active\)/.test(ktCode), '0-arg input<T>() and model<T>() emit nullable Signal initialized to null (Kotlin)');
    check(/val cardService: CardService = CardService\.shared/.test(ktCode), '@Component constructor parameter property is DI-resolved to shared instance (Kotlin)');
    check(/val title: String\s+get\(\)/.test(ktCode) && /fun _set_title\(/.test(ktCode) && /fun _set_badge\(/.test(ktCode), 'getter+setter and setter-only @Input accessors rewrite cleanly to getter + _set_ methods (Kotlin)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- HttpClient: a `responseType: 'text'` response is a string ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-http-'));
  try {
    const file = join(dir, 'docs.service.ts');
    writeFileSync(file, `
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export async function readDoc(http: HttpClient, url: string): Promise<string> {
  const text = await firstValueFrom(http.get(url, { responseType: 'text' }));
  return text.trim();
}
`);
    // An app's iOS build compiles @angular/common/http from the adapter's runtime/angular-rx.ts, as it does with plugins.
    symlinkSync(modulesDir, join(dir, 'node_modules'), 'dir');
    const sw = createProgram([file], new Map(), 'ios', modulesDir, new PluginSources({ app: dir, platform: 'ios' }));
    const swCode = translateModules(new SwiftTranslator(sw.checker, new Map(), sw.files, { pluginFiles: sw.pluginFiles }), sw.program, [file]).map((m) => m.code).join('\n');
    check(/let text: String = /.test(swCode), "HttpClient.get with responseType 'text' reads its body as a String (Swift)");
    const kt = createProgram([file], new Map(), 'android', modulesDir);
    const ktTranslator = new Translator(kt.checker, new Map(), kt.files, { appModule: 'org.example.app' });
    const ktCode = translateKotlinModules(ktTranslator, kt.program, [file]).map((m) => m.code).join('\n');
    check(/\.get\(url, [^\n]*\)\.mapValues \{ __v: Any\? -> jsAssertedString\(__v\) \}/.test(ktCode), "HttpClient.get with responseType 'text' reads its body as a String (Kotlin)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- the compiler and the Angular adapter installed in an app's node_modules ----
(() => {
  // The adapter's runtime modules (runtime/angular-rx.ts) then sit under node_modules and below the app's tsconfig.json; a lenient
  // app's iOS build must translate them as the checkout does.
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-installed-'));
  try {
    const compiler = root;
    const pkg = join(dir, 'node_modules', '@nstudio', 'nativescript-compiler');
    for (const d of ['bin', 'src', 'runtime']) if (existsSync(join(compiler, d))) cpSync(join(compiler, d), join(pkg, d), { recursive: true });
    // Released together, the compiler is the version the adapter is built for.
    const adapterPkg = JSON.parse(readFileSync(join(angularPackage.root, 'package.json'), 'utf8'));
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(compiler, 'package.json'), 'utf8')), version: adapterPkg.peerDependencies['@nstudio/nativescript-compiler'] }));
    let compilerDeps = compiler;
    while (!existsSync(join(compilerDeps, 'node_modules', 'typescript')) && dirname(compilerDeps) !== compilerDeps) compilerDeps = dirname(compilerDeps);
    if (existsSync(join(compilerDeps, 'node_modules'))) symlinkSync(join(compilerDeps, 'node_modules'), join(pkg, 'node_modules'), 'dir');
    for (const d of ['kit-apple', 'kit-android']) if (existsSync(join(compiler, d))) symlinkSync(join(compiler, d), join(pkg, d), 'dir');
    const adapter = join(dir, 'node_modules', '@nstudio', 'nativescript-compiler-angular');
    cpSync(angularPackage.root, adapter, { recursive: true, filter: (f) => !/[\\/](node_modules|dist|tests)$/.test(f) });
    // Its dependencies, as the checkout's adapter resolves them.
    let deps = angularPackage.root;
    while (!existsSync(join(deps, 'node_modules', '@angular', 'compiler')) && dirname(deps) !== deps) deps = dirname(deps);
    symlinkSync(join(deps, 'node_modules'), join(adapter, 'node_modules'), 'dir');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: { '@nstudio/nativescript-compiler-angular': adapterPkg.version } }));
    // Node strips no types under node_modules: the installed packages run dist/, as published.
    const builds = [[join(pkg, 'bin', 'build-dist.mjs')], [join(pkg, 'bin', 'ns-compiled-adapter.js'), 'build', adapter]].map((a) => spawnSync(process.execPath, a, { encoding: 'utf8' }));
    const dist = builds.find((b) => b.status !== 0) ?? builds[0];
    const app = join(dir, 'app');
    mkdirSync(app);
    symlinkSync(modulesDir, join(app, 'node_modules'), 'dir');
    writeFileSync(join(app, 'tsconfig.json'), '{ "compilerOptions": { "strict": false } }\n');
    writeFileSync(join(app, 'person-detail.component.ts'), `
import { inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

export class PersonDetail {
  route = inject(ActivatedRoute);
  router = inject(Router);
  id(): number { return +this.route.snapshot.params.id; }
  open(id: number) { this.router.navigate(['/item', id], { relativeTo: this.route }); }
}
`);
    writeFileSync(join(dir, 'translate.mjs'), `
const [base, ext, app] = process.argv.slice(2);
const load = (m) => import(base + '/' + m + ext);
const { createProgram } = await load('program/program');
const { BuildContext } = await load('program/build-context');
const build = new BuildContext();
const angular = await (await load('adapters/load')).frameworkAdapter('angular', app, build);
build.useAdapter(angular);
const { PluginSources, writtenStrict } = await load('plugins/source');
const { Translator } = await load('swift/translator');
const { translateModules } = await load('swift/app-modules');
const file = app + '/person-detail.component.ts';
const sw = createProgram([file], new Map(), 'ios', app + '/node_modules', new PluginSources({ app, platform: 'ios' }), [], {}, {}, undefined, undefined, build);
const rx = sw.pluginFiles.filter((f) => f.endsWith('/runtime/angular-rx.ts'));
const t = new Translator(sw.checker, new Map(), sw.files, { hooks: angular.swift, pluginFiles: sw.pluginFiles, lenientFiles: sw.pluginFiles.filter((f) => !writtenStrict(f, build.adapter)), lenientApp: sw.lenient, build });
console.log(translateModules(t, sw.program, [file, ...rx]).map((m) => m.code.split(angular.package.root).join('<adapter>').split(base.replace(/\\/(src|dist)$/, '')).join('<compiler>')).join('\\n'));
`);
    const run = (base: string, ext: string, env: NodeJS.ProcessEnv = process.env) => spawnSync(process.execPath, [join(dir, 'translate.mjs'), base, ext, app], { encoding: 'utf8', maxBuffer: 64 << 20, env });
    const checkout = run(join(compiler, 'src'), '.ts');
    // The installed adapter, found from the app's package.json.
    const installed = dist.status === 0 ? run(join(pkg, 'dist'), '.js', { ...process.env, [ADAPTERS_OVERRIDE]: '' }) : dist;
    if (checkout.status !== 0 || installed.status !== 0) console.log((checkout.stderr + installed.stderr).trim().split('\n').slice(-6).join('\n'));
    check(checkout.status === 0 && installed.status === 0 && /class ActivatedRoute/.test(checkout.stdout) && installed.stdout === checkout.stdout, "an installed compiler and adapter, as JavaScript, translate the adapter's runtime modules as the checkout does (a lenient app's ActivatedRoute, rxjs's Observable)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- NativeDialogConfig on Android ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-dialog-'));
  try {
    const file = join(dir, 'sheet.service.ts');
    writeFileSync(file, `
import { NativeDialogConfig, NativeDialogService } from '@nativescript/angular';

export function openSheet(dialogs: NativeDialogService, cmp: any, config?: NativeDialogConfig) {
  return dialogs.open(cmp, { nativeOptions: { fullscreen: true }, ...(config || {}) });
}
`);
    const kt = createProgram([file], new Map(), 'android', modulesDir);
    const ktTranslator = new Translator(kt.checker, new Map(), kt.files, { appModule: 'org.example.app' });
    const ktCode = translateKotlinModules(ktTranslator, kt.program, [file]).map((m) => m.code).join('\n');
    check(/config: Any\? = null/.test(ktCode) && !ktCode.includes('NativeDialogConfig'), "a NativeDialogConfig is the plain object kit-android's NativeDialogService takes (Kotlin)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- Angular components an attribute selects ----
(() => {
  const bar = "import { Component, input, output } from '@angular/core';\n@Component({ selector: '[searchBar]', template: `<Label [text]=\"hint()\"></Label>` })\nexport class SearchBar { ai = input(false); hint = input('', { alias: 'hintText' }); submitted = output<string>(); }\n";
  const hosted = hostedComponent('/app/search-bar.component.ts', bar)!;
  const page = (template: string, imports = 'SearchBar') => angularComponent('/app/home.component.ts', `import { Component, ViewChild } from '@angular/core';\nimport { SearchBar } from './search-bar.component';\n@Component({ selector: 'Home', imports: [${imports}], template: \`${template}\` })\nexport class Home { @ViewChild('bar') bar: SearchBar; go() {} done(v: string) {} }\n`, new Map(), { hosts: [hosted] })!;
  type Node = { kind: string; tag?: string; name?: string; attrs?: { name: string }[]; props?: { name: string }[]; events?: { name: string; payload?: boolean }[]; children?: Node[]; queries?: { on: string }[] };
  const host = page(`<GridLayout searchBar [ai]="true" [columns]="2" hintText="Ask" (tap)="go()" (submitted)="done($event)" #bar></GridLayout>`).template[0] as Node;
  const inner = host.children?.[0];
  check(host.tag === 'GridLayout' && host.children?.length === 1 && inner?.kind === 'component' && inner.name === 'SearchBar', 'an element whose attribute selects a component hosts it: the component renders into the element');
  check(inner?.props?.map((p) => p.name).sort().join() === 'ai,hintText' && inner.events?.map((e) => e.name).join() === 'submitted' && !!inner.events?.[0].payload, "the component's inputs (by alias) and outputs bound on its host are the component's");
  check(host.attrs?.map((a) => a.name).sort().join() === 'columns,hintText,searchBar' && host.events?.map((e) => e.name).join() === 'tap', "the host's other bindings and events are the element's, and its static attributes are written to it");
  check(inner?.queries?.length === 1 && inner.queries[0].on === 'instance' && !host.queries?.length, "a reference on the host names the component");
  const swift = render(page(`<StackLayout><GridLayout searchBar></GridLayout></StackLayout>`), new Map([['SearchBar', { props: ['ai', 'hint'], optional: ['ai', 'hint'], propAliases: { hint: 'hintText' }, outputs: ['submitted'] }], ['Home', { props: [] }]]), () => false, angular.behaviour).join('\n');
  check(/let (v\d+) = try GridLayout\(\)[\s\S]*let \((v\d+), u\d+\) = try c\d+\.__create\(\)[\s\S]*\1\.kitAddChild\(\2\)/.test(swift), "the hosted component's view is the host element's child (Swift)");
  const outOfScope = page(`<GridLayout searchBar [ai]="true"></GridLayout>`, '').template[0] as Node;
  check(!outOfScope.children?.length && outOfScope.attrs?.some((a) => a.name === 'ai'), 'a component the template does not import is not hosted');
  const refused = (template: string, source = bar) => {
    try { angularComponent('/app/home.component.ts', `import { Component } from '@angular/core';\nimport { SearchBar } from './search-bar.component';\n@Component({ selector: 'Home', imports: [SearchBar], template: \`${template}\` })\nexport class Home {}\n`, new Map(), { hosts: [hostedComponent('/app/search-bar.component.ts', source)!] }); return ''; } catch (e) { return String(e); }
  };
  check(refused(`<GridLayout searchBar><Label text="x"></Label></GridLayout>`).includes('content on <GridLayout>, the host of SearchBar'), "content inside a component's host is refused (no <ng-content> yet)");
  check(refused(`<GridLayout searchBar></GridLayout>`, bar.replace('export class SearchBar {', "export class SearchBar { el = inject(ElementRef);").replace('{ Component,', '{ Component, ElementRef, inject,')).includes("SearchBar's own ElementRef or host bindings"), 'a hosted component reading its host element is refused');
})();

// ---- Plugin elements registered with a ViewClassMeta ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-ng-elements-'));
  try {
    const entry = join(dir, 'node_modules/fake-panel/angular/fesm2022/fake-panel-angular.mjs');
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, "import { registerElement } from '@nativescript/angular';\nimport { Panel, Badge, Chip } from 'fake-panel';\nconst panelMeta = {\n  insertChild: (parent, child) => { if (child.id === 'main') parent.mainContent = child; },\n  removeChild: (parent, child) => { if (child.id === 'main') parent.mainContent = null; },\n};\nregisterElement('Panel', () => Panel, panelMeta);\nregisterElement('Badge', () => Badge, {});\nregisterElement('Chip', () => Chip);\n");
    const app = join(dir, 'src/main.ts');
    mkdirSync(dirname(app), { recursive: true });
    writeFileSync(app, "import { registerElement } from '@nativescript/angular';\nimport { PanelModule } from 'fake-panel/angular';\nimport { Glass } from './glass';\nregisterElement('Glass', () => Glass, { skipAddToDom: true });\n");
    const found = registeredElements([app], join(dir, 'node_modules'));
    check(found.get('Panel')?.name === 'Panel' && found.get('Panel')?.meta?.join() === 'insertChild,removeChild' && found.get('Badge')?.meta?.length === 0 && found.get('Chip')?.meta === undefined && found.get('Glass')?.from === join(dir, 'src/glass'),
      "registerElement with a third argument registers its tag, with the meta's keys");
    const elements = new Map([...found].map(([tag, e]) => [tag, e.name]));
    const elementMeta = new Map([...found].flatMap(([tag, e]) => (e.meta === undefined ? [] : [[tag, e.meta] as const])));
    const use = (template: string) => {
      try { return angularComponent('/app/home.component.ts', `import { Component } from '@angular/core';\n@Component({ selector: 'Home', template: \`${template}\` })\nexport class Home {}\n`, new Map(), { elements, elementMeta })!.template[0] as { tag?: string }; } catch (e) { return String(e); }
    };
    const empty = use('<Panel></Panel>');
    check(typeof empty === 'object' && empty.tag === 'Panel' && typeof use('<Badge><Label text="1"></Label></Badge>') === 'object', 'a tag registered with a meta is an element; one whose meta has no renderer hooks takes children');
    const withChild = use('<Panel><Label id="main" text="x"></Label></Panel>');
    check(typeof withChild === 'object' && withChild.tag === 'Panel' && !!found.get('Panel')?.metaCode?.includes('insertChild'), 'children of a tag whose meta has insertChild/removeChild compile and emit runtime ViewMeta registration');
    check(String(use('<StackLayout><Glass></Glass></StackLayout>')).includes('<Glass> is registered with skipAddToDom'), 'a tag registered with skipAddToDom is refused');
    const invisible = new Map([['Ghost', ['insertInvisibleNode']]]);
    const ghostErr = (() => { try { angularComponent('/app/home.component.ts', `import { Component } from '@angular/core';\n@Component({ selector: 'Home', template: '<Ghost><Label text="x"></Label></Ghost>' })\nexport class Home {}\n`, new Map(), { elements: new Map([['Ghost', 'Ghost']]), elementMeta: invisible }); return ''; } catch (e) { return String(e); } })();
    check(ghostErr.includes('registerElement meta (insertInvisibleNode)'), 'children of a tag whose meta has insertInvisibleNode are still refused');
    const masonEntry = join(dir, 'src/mason.ts');
    writeFileSync(masonEntry, "import { registerElement } from '@nativescript/angular';\nimport { Box } from './box';\nregisterElement('Box', () => Box, { skipAddToDom: false, insertChild(p: any, c: any) {}, removeChild(p: any, c: any) {} });\n");
    const masonFound = registeredElements([masonEntry], join(dir, 'node_modules'));
    check(masonFound.get('Box')?.meta?.join() === 'insertChild,removeChild', 'skipAddToDom: false is not treated as skipAddToDom: true');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- Angular features a release build refuses rather than ignores ----
(() => {
  const thrown = (f: () => unknown) => { try { f(); return ''; } catch (e) { return String(e); } };
  const page = (template: string, members = 'form: any; name = ""; items: string[] = [];', options: Parameters<typeof angularComponent>[3] = {}, selectors = new Map<string, string>()) =>
    thrown(() => angularComponent('/app/form.component.ts', `import { Component } from '@angular/core';\n@Component({ selector: 'Form', template: \`${template}\` })\nexport class Form { ${members} }\n`, selectors, options));
  const refuses = (template: string, text: string, what: string, selectors?: Map<string, string>) => {
    const e = page(template, undefined, {}, selectors);
    check(e.includes(text) && e.includes('not supported in a release build yet'), `${what} stops the build: ${e ? e.split(': ').slice(1).join(': ') : 'it compiled'}`);
  };
  refuses(`<StackLayout [formGroup]="form"></StackLayout>`, '[formGroup] (@angular/forms) on <StackLayout>', '[formGroup]');
  refuses(`<TextField formControlName="name"></TextField>`, 'formControlName (@angular/forms) on <TextField>', 'formControlName');
  refuses(`<StackLayout formGroupName="address"></StackLayout>`, 'formGroupName (@angular/forms)', 'formGroupName');
  refuses(`<TextField [formControl]="form"></TextField>`, '[formControl] (@angular/forms)', '[formControl]');
  refuses(`<TextField [(ngModel)]="name"></TextField>`, '[(ngModel)] (@angular/forms) on <TextField>', '[(ngModel)]');
  refuses(`<TextField [ngModel]="name" (ngModelChange)="name = $event"></TextField>`, '[ngModel] (@angular/forms)', '[ngModel] with (ngModelChange)');
  refuses(`<StackLayout ngForm (ngSubmit)="name = ''"></StackLayout>`, 'ngForm (@angular/forms)', 'ngForm');
  refuses(`<StackLayout (ngSubmit)="name = ''"></StackLayout>`, '(ngSubmit) (@angular/forms)', '(ngSubmit)');
  refuses(`<Rating [(ngModel)]="name"></Rating>`, '[(ngModel)] (@angular/forms) on <Rating>', '[(ngModel)] on a component', new Map([['Rating', 'Rating']]));
  refuses(`<Label #m="ngModel"></Label>`, `#m="ngModel" on <Label>, a reference to a directive's exportAs`, "a reference to a directive's exportAs");
  refuses(`<Rating [ngStyle]="{ color: 'red' }"></Rating>`, "[ngStyle] (@angular/common's NgStyle) on <Rating>", '[ngStyle] on a component', new Map([['Rating', 'Rating']]));
  refuses(`<Label ngStyle="color: red"></Label>`, "ngStyle (@angular/common's NgStyle) on <Label>", 'a static ngStyle attribute');
  refuses(`<ng-container [ngClass]="{ on: true }"></ng-container>`, "[ngClass] (@angular/common's NgClass) on <ng-container>", '[ngClass] on <ng-container>');
  refuses(`<ng-container [ngStyle]="{ color: 'red' }"></ng-container>`, "[ngStyle] (@angular/common's NgStyle) on <ng-container>", '[ngStyle] on <ng-container>');
  refuses(`<Label [class]="name" [ngClass]="{ on: true }"></Label>`, '[class] beside [ngClass] on <Label>', '[class] beside [ngClass]');
  refuses(`<Label routerLink="/a"></Label>`, "routerLink (@angular/router's RouterLink; nsRouterLink is supported)", "@angular/router's routerLink");
  refuses(`<StackLayout [ngTemplateOutlet]="null"></StackLayout>`, "[ngTemplateOutlet] (@angular/common's NgTemplateOutlet, which a release build runs on <ng-container>)", '[ngTemplateOutlet] on an element');
  refuses(`<Label [ngIf]="true"></Label>`, "[ngIf] (@angular/common's NgIf without its template (*ngIf))", 'NgIf without its template');
  refuses(`<Label animate.enter="fade"></Label>`, "animate.enter (Angular's enter animation)", 'animate.enter');
  refuses(`<Label (animate.leave)="name = ''"></Label>`, 'the animation event (animate.leave) on <Label>', '(animate.leave)');
  refuses(`<Label (@fade.done)="name = ''"></Label>`, 'the animation event (@fade.done) on <Label>', 'a legacy animation event');
  refuses(`<Label (window:resize)="name = ''"></Label>`, '(window:resize), an event of the window, on <Label>', 'a global event target');
  refuses(`<ng-container #group></ng-container>`, '#group on <ng-container>', 'a reference on <ng-container>');
  refuses(`<ng-container formGroupName="address"></ng-container>`, 'formGroupName (@angular/forms) on <ng-container>', 'a forms directive on <ng-container>');
  const outlet = page(`<page-router-outlet actionBarVisibility="never" class="bg"></page-router-outlet>`);
  check(!outlet, `page-router-outlet's actionBarVisibility and class compile${outlet ? `: ${outlet}` : ''}`);
  refuses(`<page-router-outlet [actionBarVisibility]="name"></page-router-outlet>`, '[actionBarVisibility] on <page-router-outlet>', "page-router-outlet's bound inputs");
  refuses(`<page-router-outlet (activate)="name = ''"></page-router-outlet>`, '(activate) on <page-router-outlet>', "page-router-outlet's events");
  check(!page(`<page-router-outlet name="tab" actionBarVisibility="auto"></page-router-outlet>`), "page-router-outlet's name and actionBarVisibility=\"auto\" (the Frame's default) compile");
  const fc = angularDirectives(['/app/fc.directive.ts'], () => "import { Directive } from '@angular/core';\n@Directive({ selector: '[formControl]', inputs: ['formControl'] })\nexport class FormControlLike { formControl: any; }\n");
  const fcPage = thrown(() => angularComponent('/app/form.component.ts', "import { Component } from '@angular/core';\nimport { FormControlLike } from './fc.directive';\n@Component({ selector: 'Form', imports: [FormControlLike], template: `<TextField [formControl]=\"form\"></TextField>` })\nexport class Form { form: any; }\n", new Map(), { directives: fc }));
  check(!fcPage, `an app directive selected by [formControl] binds it${fcPage ? `: ${fcPage}` : ''}`);
  const dim = angularDirectives(['/app/dim.directive.ts'], () => "import { Directive } from '@angular/core';\n@Directive({ selector: '[dimmed]' })\nexport class Dim {}\n");
  const dimmed = thrown(() => angularComponent('/app/form.component.ts', "import { Component } from '@angular/core';\nimport { Dim } from './dim.directive';\n@Component({ selector: 'Form', imports: [Dim], template: `<ng-container dimmed></ng-container>` })\nexport class Form {}\n", new Map(), { directives: dim }));
  check(dimmed.includes('the directive Dim on <ng-container> is not supported in a release build yet'), `an app directive on <ng-container> stops the build${dimmed ? '' : ': it compiled'}`);

  const empty = angularComponent('/app/list.component.ts', "import { Component } from '@angular/core';\n@Component({ selector: 'List', template: `<StackLayout>@for (x of items; track x) { <Label [text]=\"x\"></Label> } @empty { <Label text=\"None\"></Label> }</StackLayout>` })\nexport class List { items: string[] = []; }\n", new Map())!;
  type Node = { kind: string; tag?: string; items?: string; branches?: { cond: string | null; body: Node[] }[]; children?: Node[]; attrs?: { name: string; value?: string }[] };
  const [loop, none] = (empty.template[0] as Node).children ?? [];
  const cond = none?.branches?.[0]?.cond ?? '-';
  check(loop?.kind === 'for' && none?.kind === 'if' && none.branches?.length === 1 && none.branches[0].body[0]?.attrs?.some((a) => a.value === 'None') === true
    && empty.source.includes(`${cond}() { return (!!(this.${loop.items}().length === 0)); }`), "@for's @empty renders in the loop's place while its collection is empty");

  const meta = (fields: string, members = '') => thrown(() => angularComponent('/app/c.component.ts', `import { Component, input, output, viewChild, booleanAttribute } from '@angular/core';\nconst template = '';\n@Component({ selector: 'C', template: '<Label></Label>', ${fields} })\nexport class C { ${members} }\n`, new Map()));
  for (const [fields, text] of [
    ["inputs: ['x']", "@Component's inputs"], ["outputs: ['y']", "@Component's outputs"], ["preserveWhitespaces: true", "@Component's preserveWhitespaces"],
    ["interpolation: ['[[', ']]']", "@Component's interpolation"],
  ]) {
    const e = meta(fields);
    check(e.includes(`${text} is not supported in a release build yet`), `${text} stops the build${e ? '' : ': it compiled'}`);
  }
  check(!meta("viewProviders: [Object]") && !meta("host: { class: 'card', 'data-slot': 'box' }"), "@Component's viewProviders and host compile");
  {
    const hosted = angularComponent('/app/c.component.ts', "import { Component, input, booleanAttribute } from '@angular/core';\n@Component({ selector: 'C', host: { class: 'card', 'data-slot': 'box', '[attr.data-on]': 'on()' }, template: '<Label class=\"inner\"></Label>' })\nexport class C { on = input(false, { transform: booleanAttribute }); }\n", new Map())!;
    const rootAttrs = (hosted.template[0] as { attrs: { name: string; value?: string; method?: string }[] }).attrs;
    check(rootAttrs.some((a) => a.name === 'class' && a.value === 'card inner') && rootAttrs.some((a) => a.name === 'data-slot' && a.value === 'box') && rootAttrs.some((a) => a.name === 'data-on' && !!a.method)
      && hosted.setters?.includes('on') && hosted.source.includes('$set_on(value: any) { this.on.$assign(booleanAttribute(value)); }'),
      "@Component's host applies static/bound attributes to the root element and input() transform lowers to a $set_ setter");
  }
  check(!page(`<router-outlet></router-outlet>`) && !page(`<page-router-outlet id="MainContent" class="main"></page-router-outlet>`), '<router-outlet> and <page-router-outlet id="..."> compile');
  check(meta('template').includes("@Component's template is read as `name: value`"), "a shorthand @Component field stops the build");
  check(!meta("standalone: true, schemas: [], exportAs: 'c', animations: [], preserveWhitespaces: false, encapsulation: 2"), '@Component fields that only steer the compiler compile');
  for (const [members, text] of [
    ["done = output<void>({ alias: 'finished' });", "output()'s alias (done) is not supported in a release build yet"],
  ]) {
    const e = meta('standalone: true', members);
    check(e.includes(text), `${text.split(' is ')[0]} stops the build${e ? '' : ': it compiled'}`);
  }
  {
    const q = angularComponent('/app/q.component.ts', "import { Component, ElementRef, viewChild, viewChildren } from '@angular/core';\n@Component({ selector: 'Q', template: '<StackLayout #box><Label #item></Label></StackLayout>' })\nexport class Q { box = viewChild<ElementRef>('box'); req = viewChild.required<ElementRef>('box'); items = viewChildren<ElementRef>('item'); }\n", new Map())!;
    check(q.source.includes('signal<ElementRef | undefined>(undefined)') && q.source.includes('signal<ElementRef>(undefined as any)') && q.source.includes('signal<ElementRef[]>([])') && q.source.includes('this.box.set(new $ElementRef($q))') && q.source.includes('this.items.update((xs) => [...xs, new $ElementRef($q)])'),
      'signal viewChild(), viewChild.required() and viewChildren() lower to writable signals updated by query hooks');
    const dir = angularDirectives(['/app/ig.directive.ts'], () => "import { Directive } from '@angular/core';\n@Directive({ selector: 'hlm-input-group, [hlmInputGroup]' })\nexport class HlmInputGroup {}\n");
    const hostDir = angularComponent('/app/ig.component.ts', "import { Component } from '@angular/core';\nimport { HlmInputGroup } from './ig.directive';\n@Component({ selector: 'Host', imports: [HlmInputGroup], template: '<hlm-input-group><Label text=\"ok\"></Label></hlm-input-group>' })\nexport class Host {}\n", new Map(), { directives: dir })!;
    const rootEl = hostDir.template[0] as { tag?: string; directives?: unknown[] };
    check(rootEl.tag === 'ContentView' && rootEl.directives?.length === 1, 'an unregistered custom element matched by an in-scope @Directive compiles as a host container with that directive');
  }
  check(!meta('standalone: true', "on = input(false, { alias: 'enabled', debugName: 'on' });"), "input()'s alias and debugName compile");
  const directive = (body: string, fields = '') => thrown(() => angularDirectives(['/app/d.directive.ts'], () => `import { Directive, input } from '@angular/core';\n@Directive({ selector: '[dim]'${fields} })\nexport class Dim { ${body} }\n`));
  check(!directive("level = input(1); tint = input<string>(); on = input(false, { alias: 'enabled' });"), "a directive's signal inputs compile, with an alias");
  check(!directive("level = input.required<number>();"), "a directive's required signal input compiles");
  {
    const dirs = angularDirectives(['/app/d.directive.ts'], () => "import { Directive, input } from '@angular/core';\n@Directive({ selector: '[dim]' })\nexport class Dim { dim = input(1); on = input(false, { alias: 'enabled' }); }\n");
    const used = JSON.stringify(angularComponent('/app/c.component.ts', "import { Component } from '@angular/core';\nimport { Dim } from './d.directive';\n@Component({ selector: 'C', imports: [Dim], template: `<Label [dim]=\"n\" [enabled]=\"true\"></Label>` })\nexport class C { n = 2; }\n", new Map(), { directives: dirs }));
    check(used.includes('.dim.$assign($v)') && used.includes('.on.$assign($v)'), "a template sets a directive's signal input through the signal, by its alias");
  }
  check(!directive('', ", exportAs: 'dim'"), "a directive's exportAs compiles");
  {
    // Angular runs a directive's ngDoCheck after its ngOnInit, then on every check of the view its element is in.
    const dirs = angularDirectives(['/app/d.directive.ts'], () => "import { Directive } from '@angular/core';\n@Directive({ selector: '[dim]' })\nexport class Dim { ngOnInit() {} ngDoCheck() {} }\n");
    const c = angularComponent('/app/c.component.ts', "import { Component } from '@angular/core';\nimport { Dim } from './d.directive';\n@Component({ selector: 'C', imports: [Dim], template: `<Label dim></Label>` })\nexport class C {}\n", new Map(), { directives: dirs });
    const swift = render(c, new Map(), () => false, angular.behaviour).join('\n');
    const kotlin = renderKotlin(c, new Map(), { behaviour: angular.behaviour }).join('\n');
    check(/ self\.\w+\((d\d+)\)\n\s*EveryCheck \{\n\s*self\.\w+\(\1\)\n\s*\}/.test(swift) && / jsReport \{ this\.\w+\((d\d+)\) \}\n\s*EveryCheck \{\n\s*jsReport \{ this\.\w+\(\1\) \}\n\s*\}/.test(kotlin), "a directive's ngDoCheck runs after its ngOnInit, then on every check of its view (Swift, Kotlin)");
  }
  {
    // A directive's content hooks run once its view's embedded views are updated, its after-view hooks once its child
    // components are, each checked one after its init one and again at that point of every check; a directive on an
    // element holding a component after that component's (Angular runs them in the order their elements end).
    const dirs = angularDirectives(['/app/d.directive.ts'], () => "import { Directive } from '@angular/core';\n@Directive({ selector: '[dim]' })\nexport class Dim { ngAfterContentInit() {} ngAfterContentChecked() {} ngAfterViewInit() {} ngAfterViewChecked() {} }\n");
    const c = angularComponent('/app/c.component.ts', "import { Component } from '@angular/core';\nimport { Dim } from './d.directive';\nimport { K } from './k.component';\n@Component({ selector: 'C', imports: [Dim, K], template: `<StackLayout dim><K></K></StackLayout>` })\nexport class C {}\n", new Map([['K', 'K']]), { directives: dirs });
    const infos = new Map([['K', { props: [], afterContentInit: true, afterViewChecked: true }]]);
    const swift = render(c, infos, () => false, angular.behaviour).join('\n');
    const kotlin = renderKotlin(c, infos, { behaviour: angular.behaviour }).join('\n');
    // The update pass in one line: the component's content hook, the directive's two, the component's update, then the after-view hooks the same way.
    const flat = (code: string) => code.replace(/\s+/g, ' ');
    const shape = (self: string, run: (m: string) => string) => new RegExp(`(c\\d+)\\.__afterContent\\(\\) ${run(`${self}\\.\\w+\\((d\\d+)\\)`)} ContentChecked \\{ ${run(`${self}\\.\\w+\\(\\2\\)`)} \\} (try )?u\\d+\\(\\) \\1\\.__afterView\\(\\) ViewChecked \\{ \\1\\.__viewChecked\\(\\) \\} ${run(`${self}\\.\\w+\\(\\2\\)`)} ViewChecked \\{ ${run(`${self}\\.\\w+\\(\\2\\)`)} \\}`);
    check(shape('self', (m) => m).test(flat(swift)), "a directive's content and view hooks run after its view's embedded views and child components, after those of a component inside its element (Swift)");
    check(shape('this', (m) => `jsReport \\{ ${m} \\}`).test(flat(kotlin)), "a directive's content and view hooks run after its view's embedded views and child components, after those of a component inside its element (Kotlin)");
  }
  {
    // A directive's input a static attribute gives is set as the directive is made (Angular's setInputsFromAttrs, AO6
    // probe 4c: before the element's children are made), not in the update pass.
    const dirs = angularDirectives(['/app/m.directive.ts'], () => "import { Directive, Input } from '@angular/core';\n@Directive({ selector: '[mark]' })\nexport class Mark { @Input() mark = ''; }\n");
    const c = angularComponent('/app/c.component.ts', "import { Component } from '@angular/core';\nimport { Mark } from './m.directive';\n@Component({ selector: 'C', imports: [Mark], template: `<StackLayout mark=\"m\"><Label [text]=\"t\"></Label></StackLayout>` })\nexport class C { t = 'x'; }\n", new Map(), { directives: dirs });
    for (const [backend, code] of [['Swift', render(c, new Map(), () => false, angular.behaviour).join('\n')], ['Kotlin', renderKotlin(c, new Map(), { behaviour: angular.behaviour }).join('\n')]] as const) {
      const [creation, update] = [code.slice(0, code.indexOf('return (')), code.slice(code.indexOf('return ('))];
      const set = creation.search(/\(d\d+, "m"\)/);
      check(set > 0 && set < creation.indexOf('Label()') && !update.includes('"m")'), `a directive's input a static attribute gives is set as the directive is made, before the element's children (${backend})`);
      if (!(set > 0)) console.log(`    got: ${code.slice(0, 1500)}`);
    }
  }
  {
    // A ListView's [items] is a property binding: Angular sets it in the update pass, after the bindings before it.
    const c = angularComponent('/app/l.component.ts', "import { Component } from '@angular/core';\n@Component({ selector: 'L', template: `<StackLayout><Label [text]=\"a\"></Label><ListView [items]=\"rows\"><ng-template let-r=\"item\"><Label [text]=\"r\"></Label></ng-template></ListView></StackLayout>` })\nexport class L { a = 'a'; rows = ['x']; }\n", new Map());
    const swift = render(c, new Map(), () => false, angular.behaviour).join('\n');
    const kotlin = renderKotlin(c, new Map(), { behaviour: angular.behaviour }).join('\n');
    check(/EffectOrder\.resume\(__scope\)[^]*Check\(\{ self\._b0\(\) \}\)[^]*\.bind\(items: /.test(swift) && /EffectOrder\.resume\(__scope\) \{[^]*Check\(\{ this\._b0\(\) \}\)[^]*\.bind\(items = /.test(kotlin), "a ListView's items are bound in the update pass, after the bindings before it (Swift, Kotlin)");
  }
  for (const [fields, members, text] of [
    ['providers: SHARED', '', "@Component's providers are read as an array literal in a release build"],
    ['providers: [{ provide: Store }]', '', 'needs provide and one of useClass, useValue, useFactory or useExisting'],
    ['providers: [{ provide: Store, useFactory: (s: Store) => s, deps: [[new Optional(), Store]] }]', '', 'deps other than a list of tokens for useFactory are not supported'],
    ['providers: [Store]', 'store = inject(Store, { skipSelf: true });', "inject()'s skipSelf in a component with providers is not supported in a release build yet"],
    ['providers: [Store]', 'constructor(@Self() private store: Store) {}', '@Self() in a component with providers is not supported in a release build yet'],
  ]) {
    const e = meta(fields, members);
    check(e.includes(text), `component providers: ${text.split(' is ')[0].split(' are ')[0]} stops the build${e ? '' : ': it compiled'}`);
  }
  check(!meta('providers: [Store, { provide: Store, useClass: Store, multi: true }]'), 'component providers accept multi: true');
  check(!meta('providers: [...SHARED]') && !meta('providers: [provideStore()]'), 'component providers accept spread arrays and provider factory calls (e.g. provideIcons)');
  const extended = thrown(() => angularComponent('/app/c.component.ts', "import { Component } from '@angular/core';\nclass Base {}\n@Component({ selector: 'C', template: '<Label></Label>', providers: [Base] })\nexport class C extends Base {}\n", new Map()));
  check(!extended, `component providers on a derived class compile${extended ? `: ${extended}` : ''}`);
  const ngModule = "import { NgModule } from '@angular/core';\n@NgModule({ declarations: [], providers: [{ provide: 'API', useValue: '/api' }] })\nexport class AppModule {}\n";
  check(!thrown(() => declarablesIn('/app/app.module.ts', ngModule, true)) && !thrown(() => declarablesIn('/lib/lib.module.ts', ngModule)), "an app NgModule's providers are read with its imports, as a library's are");

  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-ng-routes-'));
  try {
    const w = (f: string, text: string) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), text); return join(dir, f); };
    w('src/home.ts', 'export class Home {}\n');
    const tree = (route: string, features = '') => {
      const main = w('src/main.ts', `import { routes } from './app.routes';\nbootstrapApplication(App, { providers: [provideNativeScriptRouter(routes${features})] });\n`);
      w('src/app.routes.ts', `import { Home } from './home';\nconst more = [{ path: 'more', component: Home }];\nexport const routes = [${route}];\n`);
      return thrown(() => angularRouteTree(main, (f) => readFileSync(f, 'utf8')));
    };
    const canLoad = tree("{ path: 'admin', component: Home, canLoad: [() => false] }");
    check(canLoad.includes("route guards (canLoad on 'admin') are not supported in a release build yet"), `the route guard canLoad stops the build${canLoad ? '' : ': it compiled'}`);
    for (const guard of ['canActivate', 'canActivateChild', 'canDeactivate', 'canMatch']) {
      const e = tree(`{ path: 'admin', component: Home, ${guard}: [() => false] }`);
      check(!e, `the route guard ${guard} compiles${e ? `: ${e}` : ''}`);
    }
    check(tree("{ path: 'a', component: Home, canActivate: guards }").includes("a route's canActivate that is not an array (guards) is not supported"), 'guards not given as an array stop the build');
    check(tree("{ path: 'a', redirectTo: '/b', canMatch: [() => true] }").includes("canMatch on a redirect on 'a' is not supported"), 'canMatch on a redirect stops the build');
    check(tree("{ path: 'a', component: Home, canActivate: [Missing] }").includes("the canActivate guard Missing, which the release build can't find in the app's files, is not supported"), "a guard name the build can't resolve stops it");
    {
      w('src/auth.ts', "import { Injectable, inject } from '@angular/core';\nexport class Session { ok = true; }\n@Injectable({ providedIn: 'root' })\nexport class AuthGuard { canActivate(route: any): boolean { return true; } canDeactivate(): boolean { return true; } }\nexport const loggedIn = () => true;\n");
      w('src/guards/index.ts', "export { AuthGuard as Auth } from '../auth';\n");
      const main = w('src/main.ts', "import { routes } from './app/app.routes';\nbootstrapApplication(App, { providers: [provideNativeScriptRouter(routes)] });\n");
      w('src/app/app.routes.ts', "import { inject } from '@angular/core';\nimport { Home } from '../home';\nimport { Auth } from '../guards';\nimport { Session, loggedIn } from '../auth';\nconst role = (r: string) => () => inject(Session).ok && r === 'admin';\nexport const routes = [{ path: 'a', component: Home, canActivate: [Auth, loggedIn, () => inject(Session).ok], canDeactivate: [Auth] }, { path: 'b', children: [{ path: 'c', component: Home }], canActivateChild: [role('admin')] }, { path: 'd', component: Home }];\n");
      const t = angularRouteTree(main, (f) => readFileSync(f, 'utf8'))!;
      const [a, b, d] = t.routes;
      check(a.guards === 0 && a.deactivate === true && b.guards === 1 && !b.children![0].guards && d.guards === undefined && !d.deactivate, 'guarded routes carry the id their guards register under, and canDeactivate marks the route');
      const ios = t.guards[0].source(join(dir, 'src'), 'ios');
      const android = t.guards[0].source(join(dir, 'src'), 'android');
      check(t.guards.length === 1 && ios.includes("import { Auth } from \"./guards\";") && ios.includes("import { Session, loggedIn } from \"./auth\";") && ios.includes("import { inject } from \"@angular/core\";") && !ios.includes('Home'), "a guard module imports what the guards name, its specifiers relative to the app's folder");
      check(ios.includes("KitRouter.shared.addGuard(0, 'canActivate', (a: any, b: any, c: any, d: any): any => ɵguardResult(inject(Auth).canActivate(a)));") && ios.includes("inject(Auth).canDeactivate()"), "a class guard is injected and its method called with the arguments it declares (a re-export followed)");
      check(/const ɵguard1: \(a: any, b: any\) => any = loggedIn;/.test(ios) && /const ɵguard2: \(a: any, b: any\) => any = \(\) => inject\(Session\)\.ok;/.test(ios), 'a function guard, named or inline, is evaluated once and called with Angular\'s arguments');
      check(ios.includes("const role = (r: string) => () => inject(Session).ok && r === 'admin';") && ios.includes("addGuard(1, 'canActivateChild'"), "the route file's declarations a guard names are copied, and a guard factory's call is the guard");
      check(!android.includes('ɵguardResult') && android.includes('addGuard(0, \'canActivate\', (a: any, b: any, c: any, d: any): any => inject(Auth).canActivate(a));'), "on Android the kit reads a guard's Observable itself");
    }
    check(tree("{ path: 'item', component: Home, resolve: { item: () => 1 } }").includes("route resolvers (resolve on 'item') are not supported in a release build yet"), 'a route resolver stops the build');
    for (const [field, text] of [
      ["data: { at: Math.random() }", "a route's data that is not an object of compile-time constants (at: Math.random()) is not supported"],
      ["data: { inner: { a: 1 } }", "a route's data that is not an object of compile-time constants (inner: { a: 1 }) is not supported"],
      ['data: shared', "a route's data that is not an object of compile-time constants (shared) is not supported"],
      ['providers: []', "a route's providers on 'a' is not supported"],
      ["redirectTo: () => '/b'", "a route's redirectTo that is not a compile-time string (() => '/b') is not supported"], ['component', "a route's component is read as `name: value`"],
    ]) {
      const e = tree(`{ path: 'a', ${field} }`);
      check(e.includes(text), `${text.split(' is ')[0]} stops the build${e ? '' : ': it compiled'}`);
    }
    {
      w('src/kinds.ts', "export enum Step { First = 'first', Second = 'second' }\nexport const BASE = 'flow';\n");
      w('src/app.routes.ts', "import { Home } from './home';\nimport { Step, BASE } from './kinds';\nexport const routes = [{ path: '', redirectTo: Step.First, pathMatch: 'full' }, { path: Step.First, component: Home }, { path: `${Step.Second}/${BASE}`, component: Home }, { path: BASE + '-x', component: Home }];\n");
      const t = angularRouteTree(w('src/main.ts', "import { routes } from './app.routes';\nprovideNativeScriptRouter(routes);\n"), (f) => readFileSync(f, 'utf8'))!;
      check(t.routes.map((r) => r.redirectTo ?? r.path).join() === 'first,first,second/flow,flow-x', "a route's path and redirectTo given by an enum member, a constant, a template or a sum of them are read as their strings");
    }
    check(tree("{ path: 'a' + Math.random(), component: Home }").includes("a route's path that is not a compile-time string ('a' + Math.random()) is not supported"), 'a path that is not a constant stops the build');
    check(tree("{ path: Unknown.A, component: Home }").includes("a route's path that is not a compile-time string (Unknown.A) is not supported"), "an enum member the build can't find stops the build");
    {
      w('src/flags.ts', "export enum Mode { View, Edit = 5, Next }\nexport enum Tone { Calm = 'calm' }\nexport const FULL = true;\n");
      w('src/app.routes.ts', `import { Home } from './home';
import { Mode, Tone, FULL } from './flags';
export const routes = [
  { path: 'a', data: { mode: Mode.Next, wide: FULL, 'tone': Tone.Calm, none: null, n: -2.5 }, children: [
    { path: 'b', component: Home, data: { mode: Mode.Edit, own: true } },
    { path: 'c', component: Home, data: { sub: true }, children: [{ path: 'd', component: Home, data: { leaf: 1 } }, { path: '', component: Home }] },
  ] },
  { path: 'e', component: Home },
];
`);
      const t = angularRouteTree(w('src/main.ts', "import { routes } from './app.routes';\nprovideNativeScriptRouter(routes);\n"), (f) => readFileSync(f, 'utf8'))!;
      const [a, e] = t.routes;
      const [b, c] = a.children!;
      const [d, empty] = c.children!;
      const data = (r: RouteNode) => JSON.stringify(r.data ?? []);
      check(data(a) === '[["mode",6],["wide",true],["tone","calm"],["none",null],["n",-2.5]]', `a route's data of enum members, constants and literals is read as their values, in order (${data(a)})`);
      check(data(b) === '[["mode",5],["wide",true],["tone","calm"],["none",null],["n",-2.5],["own",true]]', `a route under a parent without a component inherits its data, its own keys winning (${data(b)})`);
      const cData = '[["mode",6],["wide",true],["tone","calm"],["none",null],["n",-2.5],["sub",true]]';
      check(data(c) === cData && !e.data, `a route inherits through a parent without a component, and has no data when nothing gives it any (${data(c)})`);
      check(data(d) === '[["leaf",1]]' && data(empty) === cData, `under a parent with a component, a route inherits its data only when its path is '' (${data(d)}, ${data(empty)})`);
    }
    check(tree("{ matcher: () => null, component: Home }").includes("a route's matcher is not supported"), "a route's matcher stops the build");
    check(tree("{ path: 'a', component: Home }", ', withComponentInputBinding()').includes('the router feature withComponentInputBinding() is not supported in a release build yet'), 'a router feature that changes routing stops the build');
    check(!tree("{ path: 'a', component: Home, title: 'A', runGuardsAndResolvers: 'always' }", ', withPreloading(PreloadAllModules)'), "a route's title and runGuardsAndResolvers, and withPreloading, compile");
    const followed = (() => { try { return routedComponents(angularRouteTree(w('src/main.ts', "import { routes } from './app.routes';\nprovideNativeScriptRouter(routes);\n"), (f) => readFileSync(f, 'utf8'))!.routes); } catch { return []; } });
    w('src/app.routes.ts', "import { Home } from './home';\nconst more = [{ path: 'more', component: Home }];\nexport const routes = [{ path: '', children: more }];\n");
    check(followed().join() === 'Home', "a route's children named by a constant are followed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const flat = (text: string) => thrown(() => angularRoutes(text, '/app/app-routing.module.ts'));
  check(flat("const routes = [{ path: 'a', component: A, canActivate: [AuthGuard] }];").includes("route guards (canActivate on 'a') are not supported in a release build yet"), 'a route guard in a routes file outside the entry stops the build');
  check(flat("const routes = [{ path: 'a', component: A, children: [] }];").includes("a route's children, with the routes given outside the entry, is not supported"), 'nested routes outside the entry stop the build');
  check(flat("const routes = [{ path: 'a', component: A, data: { x: true } }];").includes("a route's data, with the routes given outside the entry, is not supported"), "a route's data outside the entry stops the build");
  check(flat("const routes = [{ path: 'a', redirectTo: '/b' }];").includes("a redirect from a path other than ''"), "a redirect from a path other than '' outside the entry stops the build");
  check(flat("const routes = [{ path: 'a', component: A }];\n@NgModule({ imports: [NativeScriptRouterModule.forRoot(routes, { bindToComponentInputs: true })] })\nexport class R {}\n").includes('the router option bindToComponentInputs is not supported'), "forRoot's options that change routing stop the build");
  check(!flat("const routes = [{ path: '', redirectTo: '/a', pathMatch: 'full' }, { path: 'a', component: A }];\nNativeScriptRouterModule.forRoot(routes, { enableTracing: true });\nconst row = { id: 1, path: 'x' };\n"), 'a flat route table, and an object with a path that is not a route, compile');
})();

// ---- Angular exports and a non-strict app's diagnostics ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-ng-exports-'));
  try {
    symlinkSync(modulesDir, join(dir, 'node_modules'), 'dir');
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: false } }));
    const file = join(dir, 'boot.ts');
    writeFileSync(file, `
import { enableProdMode } from '@angular/core';
import type { HttpEvent } from '@angular/common/http';
import type { CanActivate, IsActiveMatchOptions, Params } from '@angular/router';
import { isAngularHmrRestoringRoute } from '@nativescript/angular';

export class Guard implements CanActivate {
  canActivate(): boolean { return true; }
}
export const exact: IsActiveMatchOptions = { paths: 'exact', queryParams: 'ignored', fragment: 'ignored', matrixParams: 'ignored' };
export function page(p: Params): string { return String(p['page'] ?? 1); }
export function status(e: HttpEvent<string>): number { return e.status; }
enableProdMode();
export const restoring = isAngularHmrRestoringRoute();
`);
    const lenient = join(dir, 'lenient.ts');
    writeFileSync(lenient, "declare const flag: boolean;\nexport const a = undefined ?? false;\nexport const b = !Boolean(undefined || flag);\nexport const e = undefined ? 'test' : 'production';\nexport function d() { if ({}) return 1; return 2; }\n");
    let ios = '', android = '';
    let swCode = '', ktCode = '';
    try {
      const sw = createProgram([file, lenient], new Map(), 'ios', modulesDir, new PluginSources({ app: dir, platform: 'ios' }));
      swCode = translateModules(new SwiftTranslator(sw.checker, new Map(), sw.files, { pluginFiles: sw.pluginFiles }), sw.program, [file]).map((m) => m.code).join('\n');
    } catch (e) { ios = String(e); }
    try {
      const kt = createProgram([file, lenient], new Map(), 'android', modulesDir);
      const ktTranslator = new Translator(kt.checker, new Map(), kt.files, { appModule: 'org.example.app' });
      ktCode = translateKotlinModules(ktTranslator, kt.program, [file]).map((m) => m.code).join('\n');
    } catch (e) { android = String(e); }
    check(!ios && !android, `Angular's CanActivate, Params, IsActiveMatchOptions, HttpEvent, enableProdMode and isAngularHmrRestoringRoute type-check and translate, and a non-strict app's always-nullish, -truthy and -falsy operands are not errors${ios || android ? `: ${(ios || android).split('\n').slice(0, 3).join(' ')}` : ''}`);
    check(!/enableProdMode/.test(swCode) && !/enableProdMode/.test(ktCode) && /restoring[^\n]*= false/.test(ktCode), 'enableProdMode is nothing in a release build, and no route is restored for hot module replacement');
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));
    let strict = '';
    try { createProgram([lenient], new Map(), 'android', modulesDir); } catch (e) { strict = String(e); }
    check(strict.includes('TS2871') && strict.includes('TS2873'), "a strict app's always-nullish and always-falsy operands stay errors");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- @angular/forms' directives in templates ----
(() => {
  const compile = (template: string, members = 'name = ""; agree = false; form: any; save(f: any) {}', imports = 'NativeScriptFormsModule, ReactiveFormsModule', selectors = new Map<string, string>()) =>
    angularComponent('/app/form.component.ts', `import { Component, signal } from '@angular/core';\nimport { ReactiveFormsModule, FormsModule } from '@angular/forms';\nimport { NativeScriptFormsModule } from '@nativescript/angular';\n@Component({ selector: 'Form', imports: [${imports}], template: \`${template}\` })\nexport class Form { ${members} }\n`, selectors, {})!;
  const fails = (template: string, members?: string, imports?: string, selectors?: Map<string, string>) => { try { compile(template, members, imports, selectors); return ''; } catch (e) { return String(e); } };
  const methodOf = (c: AngularComponent, m: string) => c.source.split('\n').find((l) => l.trimStart().startsWith(`${m}(`)) ?? '';
  const usesOf = (c: AngularComponent): any[] => {
    const all: any[] = [];
    const walk = (nodes: any[]) => { for (const x of nodes) { all.push(...(x.directives ?? [])); walk(x.children ?? []); walk(x.body ?? []); for (const b of x.branches ?? []) walk(b.body); } };
    walk(c.template);
    return all;
  };
  const makes = (c: AngularComponent) => usesOf(c).map((u) => methodOf(c, u.make).replace(/^.*return \(new \$F_(\w+)\((.*)\)\); }$/, '$1($2)'));

  const td = compile(`<StackLayout ngForm #f="ngForm" (ngSubmit)="save(f)"><TextField [(ngModel)]="name" name="n" required minlength="3" #m="ngModel"></TextField><Label [text]="m.valid ? 'ok' : 'bad'"></Label></StackLayout><Button [isEnabled]="f.valid"></Button>`);
  const tdMakes = makes(td);
  check(JSON.stringify(tdMakes) === JSON.stringify([
    "NgForm([], [], 'always', [false])",
    'NgControlStatus($Ng_hostView(), $Ng_viewChecker(), $d0, true)',
    'NsValueAccessor($Ng_hostView(), "text", $unsetValue)',
    'RequiredValidator(true)',
    'MinLengthValidator(true)',
    'NgModel($d0, [$d3, $d4], [], $d2, $Ng_viewChecker(), [true, true, false, false])',
    'NgControlStatus($Ng_hostView(), $Ng_viewChecker(), $d5, false)',
  ]), `an ngForm with an ngModel below it: NgForm, the accessor, validator directives, NgModel under the form, and their NgControlStatus, in Angular's order (${tdMakes.join(' · ')})`);
  check(/\$e\d+\(\$d0: \$F_NgForm, \$event: any\) \{ this\.save\(\$d0\); \}/.test(td.source), "(ngSubmit) is NgForm's output, its template reference naming NgForm in its own handler");
  check(td.source.includes('this.name = $event;') && td.source.includes('[(this.name), "n", undefined, undefined]'), '[(ngModel)] binds NgModel and writes its ngModelChange back to the field');
  check(td.source.includes("return ($d5.valid ? 'ok' : 'bad');") && /\$b\d+\(\$d0: \$F_NgForm, \$d1: \$F_NgControlStatus\) \{ return \(\$d0\.valid\); \}/.test(td.source), 'a template reference to NgModel or NgForm names it in the elements after it and below it');
  check(td.source.includes('$d2.onChange($event.value);') && td.source.includes('$d2.onTouched();') && usesOf(td).some((u) => u.listeners.some((l: any) => l.event === 'textChange')), "a TextField's value accessor takes its textChange and blur, as @nativescript/angular's does");
  const sig = compile(`<Switch [(ngModel)]="on"></Switch><Slider [(ngModel)]="level"></Slider>`, 'on = signal(false); level = 3;');
  check(sig.source.includes('this.on.set($event);') && sig.source.includes('this.level = $event;') && sig.source.includes('"checked"') && sig.source.includes('"value"'), '[(ngModel)] on a signal sets it, on a field assigns it, and Switch and Slider take their accessors');

  const rx = compile(`<StackLayout [formGroup]="form" (ngSubmit)="save(form)"><TextField formControlName="name" class="in" [class.big]="agree"></TextField><StackLayout formGroupName="address"><SegmentedBar formControlName="plan"></SegmentedBar></StackLayout></StackLayout><DatePicker [formControl]="form"></DatePicker>`);
  const rxMakes = makes(rx);
  check(rxMakes.includes('FormGroupDirective([], [], \'always\', "formGroup", [true])') && rxMakes.includes('FormControlName($d0, [], [], $d2, [true, false])')
    && rxMakes.some((m) => /^FormGroupName\(\$d0, \[\], \[\], false, \[true\]\)$/.test(m)) && rxMakes.some((m) => /^FormControlName\(\$d\d+, \[\], \[\], \$d\d+, \[true, false\]\)$/.test(m) && !m.startsWith('FormControlName($d0,'))
    && rxMakes.some((m) => /^FormControlDirective\(\[\], \[\], \$d\d+, 'always', \[true, false\]\)$/.test(m)), `formGroup with formControlName and formGroupName below it, and a standalone formControl, each under its parent (${rxMakes.join(' · ')})`);
  check(usesOf(rx).some((u) => methodOf(rx, u.make).includes('new $Ng_NgClass()')) && !rx.template.some((x: any) => (x.children ?? []).some((c: any) => c.attrs?.some((a: any) => a.name === 'class'))), "[class.x] beside the ng-* classes goes through NgClass, which shares the view's classes with them");

  const swift = render(td, new Map(), () => false, angular.behaviour).join('\n');
  const kotlin = renderKotlin(td, new Map(), { behaviour: angular.behaviour }).join('\n');
  check(/d\d+\.update\.subscribe \{ \[__dv = EffectOrder\.current\.view\] \(event: Any\?\) in Reactivity\.event\(dirty: __dv\)/.test(swift) && /d\d+\.update\.subscribe \{ event: Any\? -> /.test(kotlin), "a directive's output is a listener of the view it is in (Swift, Kotlin)");
  check(/Button\(\)[\s\S]*self\._b\d+\(d1, d2\)/.test(swift) && /Button\(\)[\s\S]*this\._b\d+\(d1, d2\)/.test(kotlin), 'an element after a form directive reads it (Swift, Kotlin)');

  const refused = (what: string, e: string, text: string) => check(e.includes(text), `${what}: ${e ? e.split(': ').slice(1).join(': ').slice(0, 160) : 'it compiled'}`);
  refused('ngDefaultControl stops the build', fails(`<Label ngModel ngDefaultControl></Label>`), "ngDefaultControl (@angular/forms' DefaultValueAccessor");
  refused('a forms control on a component stops the build', fails(`<Rating [(ngModel)]="name"></Rating>`, undefined, undefined, new Map([['Rating', 'Rating']])), "a component, is not supported in a release build yet: it needs the component's own ControlValueAccessor");
  refused('ngModel on a view no accessor takes stops the build (NG01203)', fails(`<Label [(ngModel)]="name"></Label>`), 'NG01203: No value accessor for form control');
  refused('ngModel without NativeScriptFormsModule stops the build (NG01203)', fails(`<TextField [(ngModel)]="name"></TextField>`, undefined, 'FormsModule'), "TextValueAccessor: import NativeScriptFormsModule");
  refused('formControlName without a form above it stops the build', fails(`<TextField formControlName="name"></TextField>`), 'NG01050: formControlName must be used with a parent formGroup');
  refused('formControlName in an ngModelGroup stops the build', fails(`<StackLayout ngForm><StackLayout ngModelGroup="a"><TextField formControlName="name"></TextField></StackLayout></StackLayout>`), 'NG01051');
  refused('formGroupName without a form above it stops the build', fails(`<StackLayout formGroupName="a"></StackLayout>`), 'NG01053');
  refused('ngModelGroup outside a form stops the build', fails(`<StackLayout ngModelGroup="a"></StackLayout>`), 'NG01353');
  refused('ngModel in a formGroup stops the build', fails(`<StackLayout [formGroup]="form"><TextField [(ngModel)]="name"></TextField></StackLayout>`), 'NG01350');
  check(!fails(`<StackLayout [formGroup]="form"><TextField [(ngModel)]="name" [ngModelOptions]="{ standalone: true }"></TextField></StackLayout>`), 'a standalone ngModel in a formGroup compiles');
  refused('ngModel in a form without a name stops the build', fails(`<StackLayout ngForm><TextField [(ngModel)]="name"></TextField></StackLayout>`), 'NG01352');
  refused('[class] beside a forms control stops the build', fails(`<TextField [(ngModel)]="name" [class]="'x'"></TextField>`), '[class] beside');
  refused("a reference to an exportAs the element doesn't have stops the build", fails(`<TextField [(ngModel)]="name" #f="ngForm"></TextField>`), `#f="ngForm" on <TextField>, a reference to a directive's exportAs`);
})();

// ---- @angular/forms: the port against the package ----
(() => {
  // Each forms diff case run in Node twice, against @angular/forms and against runtime/angular-forms.ts in its place: the
  // port's semantics checked apart from the translators. What the package's typing would reject, the cases leave out.
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-forms-'));
  try {
    symlinkSync(modulesDir, join(dir, 'node_modules'), 'dir');
    const js = (source: string) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    writeFileSync(join(dir, 'forms-port.mjs'), js(readFileSync(join(angularPackage.root, 'runtime/angular-forms.ts'), 'utf8')));
    const run = (file: string) => {
      const r = spawnSync(process.execPath, [file], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
      return `${r.status}\n${r.stdout}\n${r.stderr.split('\n')[0]}`;
    };
    const casesDir = join(here, '../diff/cases');
    const formsCases = readdirSync(casesDir).filter((f) => /^78\d-forms-.*\.ts$/.test(f) && !/^\/\/ @forms-port$/m.test(readFileSync(join(casesDir, f), 'utf8')));
    check(formsCases.length >= 7, 'the forms diff cases are found');
    for (const c of formsCases) {
      const source = js(readFileSync(join(casesDir, c), 'utf8'));
      writeFileSync(join(dir, 'package.mjs'), source);
      writeFileSync(join(dir, 'port.mjs'), source.replace(/from ['"]@angular\/forms['"]/g, "from './forms-port.mjs'"));
      const expected = run('package.mjs');
      const got = run('port.mjs');
      check(expected.startsWith('0\n') && got === expected, `${c} prints the same in Node with the port as with @angular/forms`);
      if (got !== expected) console.log(`    package: ${JSON.stringify(expected.slice(0, 400))}\n    port:    ${JSON.stringify(got.slice(0, 400))}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

(() => {
  // kit-android's runtime on the host JVM, for what no diff case reaches: the harness translates no Java class reference.
  const dir = mkdtempSync(join(nativeBuild, 'release-checks-java-'));
  writeFileSync(join(dir, 'Main.kt'), `import org.nativescript.kit.*
class Holder { @JvmField var drawable: Any? = null }
fun main() {
    val map = java.util.HashMap<String, String>()
    val view = Holder()
    if (jsGet(view, "cached") == null) jsSet(view, "cached", jsCallMethod(map, "get", "missing"))
    println(listOf(jsCallMethod(map, "get", "missing") === JSNull, jsCallMethod(map, "put", "k", "a") === JSNull, jsCallMethod(map, "put", "k", "b"),
        jsCallMethod(map, "clear") == null, jsGet(view, "drawable") === JSNull, jsGet(view, "cached") === JSNull).joinToString(" "))
}
`);
  let got: string;
  try {
    const runtime = buildKotlinRuntime(nativeBuild);
    const errors = kotlinc([join(dir, 'Main.kt')], join(dir, 'classes'), [runtime]);
    got = errors ? errors[0] : spawnSync('java', ['-cp', [join(dir, 'classes'), runtime, kotlinStdlib()].join(':'), 'MainKt'], { encoding: 'utf8' }).stdout.trim();
  } catch (e) {
    got = (e as Error).message.split('\n')[0];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const expected = 'true true a true true true';
  check(got === expected, "a Java method's or field's null reads as script's null on Android, a void method's result as undefined");
  if (got !== expected) console.log(`    got: ${got.slice(0, 300)}`);
})();

(() => {
  // A Java method's null where the typings say present (M3), on the host JVM: no diff case reaches a Java class.
  const dir = mkdtempSync(join(nativeBuild, 'release-checks-java-null-'));
  const file = join(dir, 'nil.android.ts');
  writeFileSync(file, `export function find(name: string, other: string): string {
  const url = java.lang.ClassLoader.getSystemResource(name) ?? java.lang.ClassLoader.getSystemResource(other);
  if (!url) return 'none';
  return url.getProtocol();
}
export function read(name: string): string {
  try {
    const url = java.lang.ClassLoader.getSystemResource(name);
    return url.getProtocol();
  } catch (e) {
    return e instanceof TypeError ? 'TypeError' : 'other';
  }
}
`);
  let got: string;
  try {
    const p = createProgram([file], new Map(), 'android', modulesDir);
    const t = new Translator(p.checker, new Map(), p.files, { appModule: 'org.example.app', native: (t) => new AndroidNativeAPI(t, androidClassPath(null, { archives: [], dependencies: [] })) });
    writeFileSync(join(dir, 'Nil.kt'), `package org.example.app\n\nimport org.nativescript.kit.*\n\n${translateKotlinModules(t, p.program, [file]).map((m) => m.code).join('\n')}`);
    writeFileSync(join(dir, 'Main.kt'), 'import org.example.app.*\nfun main() { println(listOf(find("no/a", "no/b"), find("no/a", "java/lang/Object.class"), read("no/a")).joinToString(" ")) }\n');
    const runtime = buildKotlinRuntime(nativeBuild);
    const errors = kotlinc([join(dir, 'Nil.kt'), join(dir, 'Main.kt')], join(dir, 'classes'), [runtime]);
    got = errors ? errors[0] : spawnSync('java', ['-cp', [join(dir, 'classes'), runtime, kotlinStdlib()].join(':'), 'MainKt'], { encoding: 'utf8' }).stdout.trim();
  } catch (e) {
    got = (e as Error).message.split('\n')[0];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const expected = 'none jrt TypeError';
  check(got === expected, "a Java method's null is held by the app's variable, `??` and the app's own test see it, and a member read of it is JavaScript's TypeError");
  if (got !== expected) console.log(`    got: ${got.slice(0, 300)}`);
})();

(() => {
  // core's addDelegateHandler: a handler typed by the delegate method (`Delegate[K]`), run by `handler.apply` and its
  // result read as the method's native return type. Node has no native enums, so no diff case reaches it.
  const dir = mkdtempSync(join(nativeBuild, 'release-checks-native-results-'));
  mkdirSync(join(dir, 'swift'));
  const file = join(dir, 'app.ios.ts');
  writeFileSync(file, `interface Hooks {
  options(text: string, other: string | null): NSStringCompareOptions;
  order(text: string): NSComparisonResult;
}
class Host {
  private handlers = new Map<string, Function[]>();
  add<K extends keyof Hooks>(name: K, handler: Hooks[K]): void {
    if (typeof handler !== 'function') return;
    const list = this.handlers.get(name) ?? [];
    list.push(handler);
    this.handlers.set(name, list);
  }
  run(name: string, ...args: any[]): any {
    let result: any;
    for (const handler of this.handlers.get(name) ?? []) result = handler.apply(this, args);
    return result;
  }
}
const host = new Host();
host.add('options', (_text: string, other: string | null) => (other ? NSStringCompareOptions.CaseInsensitiveSearch : NSStringCompareOptions.BackwardsSearch));
host.add('order', (text: string) => (text ? NSComparisonResult.OrderedDescending : NSComparisonResult.OrderedAscending));
const both = host.run('options', 'a', 'b');
const one = host.run('options', 'a', null);
const order = host.run('order', 'x');
const held: any = NSStringCompareOptions.NumericSearch;
console.log(typeof both, both, both | 8, typeof one, one, typeof order, order, typeof held, held + 1);
`);
  let got: string;
  try {
    buildSwiftRuntime(nativeBuild, '-Onone');
    const out = join(dir, 'swift');
    const modules = translateSwift([file], out);
    writeFileSync(join(out, 'main.swift'), swiftMain(modules));
    const errors = swiftc(readdirSync(out).map((f) => join(out, f)), join(dir, 'main'), nativeBuild, '-Onone');
    got = errors ? errors[0] : spawnSync(join(dir, 'main'), { encoding: 'utf8' }).stdout.trim();
  } catch (e) {
    got = (e as Error).message.split('\n')[0];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const expected = 'number 1 9 number 4 number 1 number 65';
  check(got === expected, 'a native option set or enum a typed handler gives script, through apply or held untyped, is its number');
  if (got !== expected) console.log(`    got: ${got.slice(0, 300)}`);
})();

(() => {
  // Strict app code checks an untyped value entering a string, number or boolean slot. A native API gives
  // those in representations Node has no counterpart for, so no diff case reaches them.
  const dir = mkdtempSync(join(nativeBuild, 'release-checks-native-primitives-'));
  const file = join(dir, 'app.ts');
  writeFileSync(file, `function twice(n: number): number { return n * 2; }
function shout(s: string): string { return s.toUpperCase(); }
function flip(b: boolean): boolean { return !b; }
function attempt(f: () => unknown): string {
  try { return String(f()); } catch (e) { return (e as Error).message; }
}
export function num(v: any): string { return \`\${typeof v} \${(v as number) + 1} \${twice(v)}\`; }
export function str(v: any): string { return \`\${typeof v} \${(v as string).toUpperCase()} \${shout(v)}\`; }
export function bool(v: any): string { return \`\${typeof v} \${(v as boolean) ? 'yes' : 'no'} \${flip(v)}\`; }
export function refused(v: any): string {
  return [attempt(() => (v as number) + 1), attempt(() => twice(v)), attempt(() => (v as string).toUpperCase()), attempt(() => shout(v)), attempt(() => !(v as boolean)), attempt(() => flip(v))].join(', ');
}
`);
  // What `refused` prints for a value of `type`: where `ok` gives a result, that type's slots take the value.
  const wrong = (type: string, ok: { number?: string; string?: string; boolean?: string }) =>
    [ok.number ?? `${type} is not a number`, ok.number ?? `${type} is not a number`, ok.string ?? `${type} is not a string`, ok.string ?? `${type} is not a string`,
      ok.boolean ?? `${type} is not a boolean`, ok.boolean ?? `${type} is not a boolean`].join(', ');
  try {
    let got: string;
    try {
      buildSwiftRuntime(nativeBuild, '-Onone');
      const out = join(dir, 'swift');
      translateSwift([file], out);
      writeFileSync(join(out, 'main.swift'), `import Foundation
import NativeScriptKit
let numbers: [Any] = [1.5, 3, Int8(-2), UInt8(200), Int16(-300), UInt16(400), Int32(-5), UInt32(6), Int64(-7), UInt64(8), UInt(9), Float(0.5), CGFloat(2.5),
    NSNumber(value: 7), NSDecimalNumber(string: "1.25"), Decimal(string: "4.5")!, NSString.CompareOptions.numeric, ComparisonResult.orderedDescending]
for v in numbers { print(try num(v)) }
for v: Any in ["s", NSString(string: "ns"), NSMutableString(string: "mut")] { print(try str(v)) }
for v: Any in [true, NSNumber(value: true), kCFBooleanFalse!] { print(try bool(v)) }
for v: Any in [NSNumber(value: 1), NSDecimalNumber(string: "1"), NSNumber(value: false), Int8(1), NSString(string: "1"), JSObject([])] { print(try refused(v)) }
`);
      const errors = swiftc(readdirSync(out).map((f) => join(out, f)), join(dir, 'main'), nativeBuild, '-Onone');
      got = errors ? errors[0] : spawnSync(join(dir, 'main'), { encoding: 'utf8' }).stdout.trim();
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    const expected = ['number 2.5 3', 'number 4 6', 'number -1 -4', 'number 201 400', 'number -299 -600', 'number 401 800', 'number -4 -10', 'number 7 12',
      'number -6 -14', 'number 9 16', 'number 10 18', 'number 1.5 1', 'number 3.5 5', 'number 8 14', 'number 2.25 2.5', 'number 5.5 9', 'number 65 128',
      'number 2 2', 'string S S', 'string NS NS', 'string MUT MUT', 'boolean yes false', 'boolean yes false', 'boolean no true',
      wrong('number', { number: '2' }), wrong('number', { number: '2' }), wrong('boolean', { boolean: 'true' }), wrong('number', { number: '2' }),
      wrong('string', { string: '1' }), wrong('object', {})].join('\n');
    check(got === expected, "a native number, string or boolean in any of Swift's representations passes an `as` or an untyped argument as that type; another type is a TypeError (Swift)");
    if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);

    try {
      const out = join(dir, 'kotlin');
      translateKotlin([file], out, 'org.example.app');
      writeFileSync(join(out, 'Main.kt'), `import org.example.app.*
fun main() {
    for (v in listOf<Any>(1.5, 3, -2L, 4.toShort(), 5.toByte(), 0.5f, java.lang.Integer.valueOf(6))) println(num(v))
    for (v in listOf<Any>("s", 'c')) println(str(v))
    for (v in listOf<Any>(true, java.lang.Boolean.FALSE)) println(bool(v))
    for (v in listOf<Any>(1, 'c', java.math.BigDecimal("1"), StringBuilder("1"), true)) println(refused(v))
}
`);
      const runtime = buildKotlinRuntime(nativeBuild);
      const errors = kotlinc(readdirSync(out).map((f) => join(out, f)), join(dir, 'classes'), [runtime]);
      got = errors ? errors[0] : spawnSync('java', ['-cp', [join(dir, 'classes'), runtime, kotlinStdlib()].join(':'), 'MainKt'], { encoding: 'utf8' }).stdout.trim();
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    const expectedKotlin = ['number 2.5 3', 'number 4 6', 'number -1 -4', 'number 5 8', 'number 6 10', 'number 1.5 1', 'number 7 12',
      'string S S', 'string C C', 'boolean yes false', 'boolean no true',
      wrong('number', { number: '2' }), wrong('string', { string: 'C' }), wrong('object', {}), wrong('object', {}), wrong('boolean', { boolean: 'false' })].join('\n');
    check(got === expectedKotlin, "a native number, string or boolean in any of the JVM's representations passes an `as` or an untyped argument as that type; another type is a TypeError (Kotlin)");
    if (got !== expectedKotlin) console.log(`    got: ${got.slice(0, 1500)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

(() => {
  // A missing value placed in a field its form holds present (a `map` callback's literal, whose result Form doesn't
  // follow) is a TypeError naming the field. JavaScript stores undefined there, so no diff case can expect it.
  const dir = mkdtempSync(join(nativeBuild, 'release-checks-required-field-'));
  const file = join(dir, 'app.ts');
  writeFileSync(file, `const NAMES = ['C', 'D'];
function noteName(i: number): string { return NAMES[i]; }
interface Voice { note: string; fret: number }
export function voices(ids: number[]): string {
  try {
    const list: Voice[] = ids.map((i) => ({ note: noteName(i), fret: i }));
    return list.map((v) => v.note + v.fret).join(',');
  } catch (e) {
    return \`\${e instanceof TypeError ? 'TypeError' : 'other'}: \${(e as Error).message}\`;
  }
}
`);
  const expected = 'C0,D1\nTypeError: note is undefined';
  try {
    let got: string;
    try {
      buildSwiftRuntime(nativeBuild, '-Onone');
      const out = join(dir, 'swift');
      translateSwift([file], out);
      writeFileSync(join(out, 'main.swift'), `import NativeScriptKit
print(try voices(JSArray<Double>([0, 1])))
print(try voices(JSArray<Double>([0, 7])))
`);
      const errors = swiftc(readdirSync(out).map((f) => join(out, f)), join(dir, 'main'), nativeBuild, '-Onone');
      got = errors ? errors[0] : spawnSync(join(dir, 'main'), { encoding: 'utf8' }).stdout.trim();
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, 'a missing value placed in a field held present is a TypeError naming the field, not "undefined" (Swift)');
    if (got !== expected) console.log(`    got: ${got.slice(0, 500)}`);

    try {
      const out = join(dir, 'kotlin');
      translateKotlin([file], out, 'org.example.app');
      writeFileSync(join(out, 'Main.kt'), `import org.example.app.*
import org.nativescript.kit.*
fun main() {
    println(voices(jsArrayOf<Double>(0.0, 1.0)))
    println(voices(jsArrayOf<Double>(0.0, 7.0)))
}
`);
      const runtime = buildKotlinRuntime(nativeBuild);
      const errors = kotlinc(readdirSync(out).map((f) => join(out, f)), join(dir, 'classes'), [runtime]);
      got = errors ? errors[0] : spawnSync('java', ['-cp', [join(dir, 'classes'), runtime, kotlinStdlib()].join(':'), 'MainKt'], { encoding: 'utf8' }).stdout.trim();
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, 'a missing value placed in a field held present is a TypeError naming the field, not "undefined" (Kotlin)');
    if (got !== expected) console.log(`    got: ${got.slice(0, 500)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- OnPush components ----
(() => {
  const src = (name: string, strategy: string, template: string) => `import { ChangeDetectionStrategy, Component, Input } from '@angular/core';\n@Component({ selector: '${name}', ${strategy}template: \`${template}\` })\nexport class ${name} { @Input() item: any; go() {} }\n`;
  const list = angularComponent('/app/list.component.ts', src('List', '', '<StackLayout><Row [item]="item"></Row><Button text="Go" (tap)="go()"></Button></StackLayout>'), new Map([['Row', 'Row']]))!;
  const eager = angularComponent('/app/row.component.ts', src('Row', 'changeDetection: ChangeDetectionStrategy.Eager, ', '<Label [text]="item"></Label>'), new Map())!;
  check(list.onPush === true && !eager.onPush, 'a component compiles OnPush unless its strategy is Default (Eager)');
  for (const onPush of [true, false]) {
    const infos = new Map([['Row', { name: 'Row', props: ['item'], onPush }], ['List', { name: 'List', props: ['item'] }]]);
    for (const [backend, code] of [['Swift', render(list, infos, () => false, angular.behaviour).join('\n')], ['Kotlin', renderKotlin(list, infos, { behaviour: angular.behaviour }).join('\n')]] as const) {
      const view = backend === 'Swift' ? 'EffectOrder.view(for: self, onPush: true)' : 'EffectOrder.view(null, this, true)';
      const marks = backend === 'Swift' ? /\[__dv = EffectOrder\.current\.view\] .* in Reactivity\.event\(dirty: __dv\)/ : /EffectOrder\.current\.view\.let \{ __dv -> .* -> Reactivity\.event\(__dv\) \{/;
      check(code.includes(view) && code.includes('Zone.inputChanged(') === onPush && marks.test(code), `an OnPush view is made as one, an OnPush child's input marks it dirty and a listener its view (${backend}${onPush ? '' : ', Eager child'})`);
    }
  }
})();

// Angular 22 under zone.js: each tick refreshes Eager views below refreshed ones and OnPush views only when dirty (an
// input set to another reference, a listener of it or below it, markForCheck of its own ChangeDetectorRef, made before
// its view) or when a signal their bindings read changed, the whole view in template order. Node has no zone app, so no diff case reaches it.
(() => {
  const dir = mkdtempSync(join(nativeBuild, 'release-checks-onpush-zone-'));
  const file = join(dir, 'app.ts');
  writeFileSync(file, `export class Item { constructor(public name: string) {} }\n`);
  const expected = 'title t0,name a,note n0,count 0|title t1|name c,note n1|note n2||note n3|note n4,count 1';
  const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: 'utf8' }).stdout.trim().split('\n').join(',').replace(/,?-,?/g, '|');
  try {
    let got: string;
    try {
      buildSwiftRuntime(nativeBuild, '-Onone');
      const out = join(dir, 'swift');
      translateSwift([file], out);
      writeFileSync(join(out, 'main.swift'), `import Foundation
import NativeScriptKit
final class Child { let item: Signal<Item>; var note = "n0"; let count = Signal(0.0); var cd: ChangeDetectorRef?; init(_ item: Item) { self.item = Signal(item) } }
final class Parent { var title = "t0"; var item = Item("a") }
Zone.enabled = true
let parent = Parent()
let child = AngularView.construct { let c = Child(parent.item); c.cd = ChangeDetectorRef.current(); return c }
var childView: AngularView?
EffectOrder.view {
    Check({ parent.title }) { print("title", $0) }
    Check({ parent.item }) { child.item.value = $0; Zone.inputChanged(child) }
    EffectOrder.view(for: child, onPush: true) {
        childView = EffectOrder.current.view
        Check({ child.item.value.name }) { print("name", $0) }
        Check({ child.note }) { print("note", $0) }
        Check({ child.count.value }) { print("count", Int($0)) }
    }
}
func step(_ body: () -> Void) { print("-"); body(); Zone.tick() }
step { parent.title = "t1"; parent.item.name = "b"; child.note = "n1" }
step { parent.item = Item("c") }
step { Reactivity.event(dirty: childView) { child.note = "n2" } }
step { child.note = "n3" }
step { child.cd?.markForCheck() }
step { child.note = "n4"; child.count.value = 1 }
`);
      const errors = swiftc(readdirSync(out).map((f) => join(out, f)), join(dir, 'main'), nativeBuild, '-Onone');
      got = errors ? errors[0] : run(join(dir, 'main'), []);
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, 'under zone.js an OnPush view is refreshed on a tick only when an input is given another reference, a listener or markForCheck marks it, or a signal it read changed; its Eager parent on every tick (Swift)');
    if (got !== expected) console.log(`    got: ${got.slice(0, 600)}`);

    try {
      const out = join(dir, 'kotlin');
      translateKotlin([file], out, 'org.example.app');
      writeFileSync(join(out, 'Main.kt'), `import org.example.app.*
import org.nativescript.kit.*
class Child(item: Item) { val item = Signal(item); var note = "n0"; val count = Signal(0.0); var cd: ChangeDetectorRef? = null }
class Parent { var title = "t0"; var item = Item("a") }
fun step(body: () -> Unit) { println("-"); body(); Zone.tick() }
fun main() {
    Zone.enabled = true
    val parent = Parent()
    val child = AngularView.construct { Child(parent.item).also { it.cd = ChangeDetectorRef.current() } }
    var childView: AngularView? = null
    EffectOrder.view {
        Check({ parent.title }) { println("title $it") }
        Check({ parent.item }) { child.item.value = it; Zone.inputChanged(child) }
        EffectOrder.view(null, child, true) {
            childView = EffectOrder.current.view
            Check({ child.item.value.name }) { println("name $it") }
            Check({ child.note }) { println("note $it") }
            Check({ child.count.value }) { println("count \${it.toInt()}") }
        }
    }
    step { parent.title = "t1"; parent.item.name = "b"; child.note = "n1" }
    step { parent.item = Item("c") }
    step { Reactivity.event(childView) { child.note = "n2" } }
    step { child.note = "n3" }
    step { child.cd?.markForCheck() }
    step { child.note = "n4"; child.count.value = 1.0 }
}
`);
      const runtime = buildKotlinRuntime(nativeBuild);
      const errors = kotlinc(readdirSync(out).map((f) => join(out, f)), join(dir, 'classes'), [runtime]);
      got = errors ? errors[0] : run('java', ['-cp', [join(dir, 'classes'), runtime, kotlinStdlib()].join(':'), 'MainKt']);
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, 'under zone.js an OnPush view is refreshed on a tick only when an input is given another reference, a listener or markForCheck marks it, or a signal it read changed; its Eager parent on every tick (Kotlin)');
    if (got !== expected) console.log(`    got: ${got.slice(0, 600)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- Zoneless Angular: what a tick refreshes ----
// Angular 22 zoneless (review/compiler-quality/repros/AO6-angular-let-hooks.mjs, 3a, 3b and 3c, its dev-mode
// checkNoChanges pass left out): a signal a view's binding read refreshes that view and its Eager child views, not its
// own hooks; a listener or markForCheck refreshes the view, every view above it and the roots' host views (the root's
// hooks); an OnPush child re-reads its bindings only when marked, by its own ChangeDetectorRef included, whose
// detectChanges refreshes its view alone; an effect() re-runs only when a signal it read changed. Node renders no
// compiled template, so no diff case reaches it.
(() => {
  const dir = mkdtempSync(join(nativeBuild, 'release-checks-zoneless-'));
  const hooks = (who: string) => ['OnInit init', 'DoCheck doCheck', 'AfterContentInit contentInit', 'AfterContentChecked contentChecked', 'AfterViewInit viewInit', 'AfterViewChecked viewChecked'].map((h) => `  ng${h.split(' ')[0]}() { seen.push('${who} ${h.split(' ')[1]}'); }`).join('\n');
  const kid = (name: string, strategy: string) => `import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { seen } from './seen';
@Component({ selector: '${name}', ${strategy}template: '<Label [text]="look(\\'K binding\\')"></Label>' })
export class ${name} {
  @Input() a = '';
  look(s: string): string { seen.push(s); return s; }
${hooks('K')}
}
`;
  const outer = (name: string, kidName: string, extra: string) => `import { ChangeDetectionStrategy, ChangeDetectorRef, Component, effect, inject, signal } from '@angular/core';
import { seen } from './seen';
import { ${kidName} } from './${kidName.toLowerCase()}.component';
@Component({ selector: '${name}', changeDetection: ChangeDetectionStrategy.Eager, imports: [${kidName}], template: '<StackLayout><Label [text]="look(\\'P sig \\' + s())" (tap)="tap(1)"></Label><${kidName} [a]="look(\\'K.a\\')"></${kidName}></StackLayout>' })
export class ${name} {
  s = signal(0);
  cd = inject(ChangeDetectorRef);
${extra}  look(s: string): string { seen.push('P reads ' + s); return s; }
  tap(v: number) { seen.push('P tap ' + v); }
${hooks('P')}
}
`;
  const sources: Record<string, string> = {
    'seen.ts': `export const seen: string[] = [];\nexport function show(label: string): void { console.log(label + ': ' + seen.join(',')); seen.length = 0; }
let act: ((text: string, how: string) => void) | null = null;
export function register(f: (text: string, how: string) => void): void { act = f; }
export function poke(text: string, how: string): void { if (act) act(text, how); }\n`,
    'eagerkid.component.ts': kid('EagerKid', 'changeDetection: ChangeDetectionStrategy.Eager, '),
    'pushkid.component.ts': kid('PushKid', ''),
    'eagerhost.component.ts': outer('EagerHost', 'EagerKid', ''),
    'pushhost.component.ts': outer('PushHost', 'PushKid', "  fx = effect(() => { seen.push('P effect ' + this.s()); });\n"),
    'markkid.component.ts': `import { ChangeDetectorRef, Component, inject } from '@angular/core';
import { register, seen } from './seen';
@Component({ selector: 'MarkKid', template: '<Label [text]="look(\\'K text \\' + text)"></Label>' })
export class MarkKid {
  text = 'a';
  cd = inject(ChangeDetectorRef);
  constructor() {
    register((t: string, how: string) => { this.text = t; if (how === 'mark') this.cd.markForCheck(); if (how === 'detect') this.cd.detectChanges(); });
  }
  look(s: string): string { seen.push(s); return s; }
${hooks('K')}
}
`,
    'markhost.component.ts': `import { ChangeDetectionStrategy, Component } from '@angular/core';
import { seen } from './seen';
import { MarkKid } from './markkid.component';
@Component({ selector: 'MarkHost', changeDetection: ChangeDetectionStrategy.Eager, imports: [MarkKid], template: '<StackLayout><Label [text]="look(\\'P binding\\')"></Label><MarkKid></MarkKid></StackLayout>' })
export class MarkHost {
  look(s: string): string { seen.push('P reads ' + s); return s; }
${hooks('P')}
}
`,
  };
  const files = Object.keys(sources).map((f) => join(dir, f));
  for (const [f, text] of Object.entries(sources)) writeFileSync(join(dir, f), text);
  const comps = files.filter((f) => f.endsWith('.component.ts'));
  const irs = comps.map((f) => angularComponent(f, readFileSync(f, 'utf8'), new Map([['EagerKid', 'EagerKid'], ['PushKid', 'PushKid'], ['MarkKid', 'MarkKid']]))!);
  const overrides = new Map(comps.map((f, i) => [f, irs[i].source]));
  const refresh = 'P doCheck,P contentChecked,P reads P sig 1,P reads K.a,K doCheck,K contentChecked';
  const expected = [
    'signal: P reads P sig 1,P reads K.a,K doCheck,K contentChecked,K binding,K viewChecked', 'nothing: ',
    `listener: P tap 1,${refresh},K binding,K viewChecked,P viewChecked`, `markForCheck: ${refresh},K binding,K viewChecked,P viewChecked`,
    'signal: P effect 1,P reads P sig 1,P reads K.a,K doCheck,K contentChecked,K viewChecked', 'nothing: ',
    `listener: P tap 1,${refresh},K viewChecked,P viewChecked`, `markForCheck: ${refresh},K viewChecked,P viewChecked`,
    'field only: ', 'markForCheck: P doCheck,P contentChecked,P reads P binding,K doCheck,K contentChecked,K text c,K viewChecked,P viewChecked',
    'detectChanges: K text d',
  ].join('\n');
  const run = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    return (r.stdout + r.stderr).trim().split('\n').filter((l) => !l.startsWith('first:')).join('\n');
  };
  const translated = (platform: 'ios' | 'android') => {
    const p = createProgram(files, overrides, platform, modulesDir);
    const classes = comps.map((f) => p.program.getSourceFile(f)!.statements.find(ts.isClassDeclaration)!);
    const infos = new Map(irs.map((ir, i) => [ir.name, { name: ir.name, props: ir.props, optional: ir.optional, changes: ir.changes, onPush: ir.onPush, doCheck: !!ir.doCheck, afterContentInit: !!ir.afterContentInit, afterContentChecked: !!ir.afterContentChecked, afterViewChecked: !!ir.afterViewChecked, members: componentMembersOf(classes[i], p.checker) }]));
    return { ...p, classes, infos };
  };
  const script = (render: string, swift: boolean) => {
    const tap = swift ? 'for t in taps { t(EventData()) }' : 'for (t in taps.toList()) t(EventData())';
    const step = (code: string, label: string) => [code, 'Microtasks.checkpoint()', `show("${label}")`];
    const root = (cls: string) => [
      swift ? `let p${cls} = AngularView.construct { ${cls}() }` : `val p${cls} = AngularView.construct { ${cls}() }`,
      ...step(swift ? `let o${cls} = createRoot { o in _ = try! p${cls}.${render}(); return o }` : `val o${cls} = createRoot { o -> p${cls}.${render}(); o }`, 'first'),
      ...step(`p${cls}.s.value = 1.0`, 'signal'), ...step('', 'nothing'), ...step(tap, 'listener'), ...step(`p${cls}.cd.markForCheck()`, 'markForCheck'),
      `o${cls}.dispose()`, swift ? 'taps.removeAll()' : 'taps.clear()',
    ];
    const call = swift ? 'try! ' : '';
    const marked = [
      swift ? 'let pMarkHost = AngularView.construct { MarkHost() }' : 'val pMarkHost = AngularView.construct { MarkHost() }',
      ...step(swift ? 'let oMarkHost = createRoot { o in _ = try! pMarkHost.' + render + '(); return o }' : 'val oMarkHost = createRoot { o -> pMarkHost.' + render + '(); o }', 'first'),
      ...step(`${call}poke("b", "")`, 'field only'), ...step(`${call}poke("c", "mark")`, 'markForCheck'), ...step(`${call}poke("d", "detect")`, 'detectChanges'),
      'oMarkHost.dispose()',
    ];
    return [swift ? 'Reactivity.schedule = .microtask' : 'Reactivity.schedule = Reactivity.Schedule.MICROTASK', ...root('EagerHost'), ...root('PushHost'), ...marked];
  };
  try {
    let got: string;
    try {
      buildSwiftRuntime(nativeBuild, '-Onone');
      const { program, files: sourceFiles, checker, classes, infos } = translated('ios');
      const sw = new SwiftTranslator(checker, infos, sourceFiles, { plainFields: true });
      const out = join(dir, 'swift');
      mkdirSync(out);
      writeFileSync(join(out, 'app.swift'), `import Foundation\nimport NativeScriptKit\n${translateModules(sw, program, files).map((m) => m.code).join('\n')}`);
      irs.forEach((ir, i) => writeFileSync(join(out, `${ir.name}.swift`), `import Foundation\nimport NativeScriptKit\nfinal class ${ir.name} {\n${[...sw.componentMembers(classes[i], ir.props), ...render(ir, infos, () => false, angular.behaviour)].join('\n')}\n}\n`));
      writeFileSync(join(out, 'views.swift'), `import NativeScriptKit
final class EventData {}
var taps: [(EventData) -> Void] = []
class View { init() throws {}
  func kitSet(_ key: String, _ value: Any?) {}
  func kitAddChild(_ view: View) {}
  func kitOn(_ name: String, _ handler: @escaping (EventData) -> Void) { taps.append(handler) } }
final class Label: View {}
final class StackLayout: View {}
`);
      writeFileSync(join(out, 'main.swift'), `import NativeScriptKit\n${script(infos.get('EagerHost')!.members.render, true).join('\n')}\n`);
      const errors = swiftc(readdirSync(out).map((f) => join(out, f)), join(dir, 'main'), nativeBuild, '-Onone');
      got = errors ? errors.join('\n').slice(0, 1500) : run(join(dir, 'main'), []);
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, 'a zoneless tick refreshes what a signal write, a listener or markForCheck marked, an OnPush child only when marked, and re-runs an effect() only when its signal changed (Swift)');
    if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);

    try {
      const { program, files: sourceFiles, checker, classes, infos } = translated('android');
      const kt = new Translator(checker, infos, sourceFiles, { appModule: 'org.example.app', plainFields: true });
      const out = join(dir, 'kotlin');
      mkdirSync(out);
      const head = 'package org.example.app\nimport org.nativescript.kit.*\n';
      writeFileSync(join(out, 'App.kt'), head + translateKotlinModules(kt, program, files).map((m) => m.code).join('\n'));
      irs.forEach((ir, i) => {
        const { params, lines } = kt.componentMembers(classes[i], ir.props);
        writeFileSync(join(out, `${ir.name}.kt`), `${head}class ${ir.name}(${params.join(', ')}) {\n${[...lines, ...renderKotlin(ir, infos, { behaviour: angular.behaviour })].join('\n')}\n}\n`);
      });
      writeFileSync(join(out, 'Views.kt'), `${head}class EventData
val taps = mutableListOf<(EventData) -> Unit>()
open class View {
  fun kitSet(key: String, value: Any?) {}
  fun kitAddChild(view: View) {}
  fun kitOn(name: String, handler: (EventData) -> Unit) { taps.add(handler) }
}
class Label : View()
class StackLayout : View()
`);
      writeFileSync(join(out, 'Main.kt'), `import org.example.app.*\nimport org.nativescript.kit.*\nfun main() {\n${script(infos.get('EagerHost')!.members.render, false).map((l) => `    ${l}`).join('\n')}\n}\n`);
      const runtime = buildKotlinRuntime(nativeBuild);
      const errors = kotlinc(readdirSync(out).map((f) => join(out, f)), join(dir, 'classes'), [runtime]);
      got = errors ? errors.join('\n').slice(0, 1500) : run('java', ['-cp', [join(dir, 'classes'), runtime, kotlinStdlib()].join(':'), 'MainKt']);
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, 'a zoneless tick refreshes what a signal write, a listener or markForCheck marked, an OnPush child only when marked, and re-runs an effect() only when its signal changed (Kotlin)');
    if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- Zoneless Angular: a ListView's items and rows ----
// @nativescript/angular's ListView: its [items] binding sets the list's items only when given another reference, and
// its ngDoCheck refreshes the list only when its IterableDiffer finds the items changed, so a page refreshed by a listener
// or a signal does not reload the rows; on itemLoading a recycled row is given its new item and refreshed. A row is an
// embedded view declared in the page, refreshed when the page is, by a listener or by a signal alone (Angular refreshes
// transplanted views with their declaration), and a row's listener marks the page (an OnPush one here, Angular 22's
// default). The stub ListView loads cells as core's does: a cell's first load renders its row in the list's RowScope, a
// later one writes it.
(() => {
  const dir = mkdtempSync(join(nativeBuild, 'release-checks-list-'));
  const file = join(dir, 'rows.component.ts');
  writeFileSync(file, `import { Component, signal } from '@angular/core';
@Component({ selector: 'Rows', template: '<StackLayout><Label [text]="status() + picked"></Label><Button (tap)="add()"></Button><Button (tap)="copy()"></Button><Button (tap)="mark()"></Button><ListView [items]="rows" (itemTap)="tapped()" (loadMoreItems)="more()"><ng-template let-item let-index="index"><Label [text]="(index + 1) + \\'. \\' + item + suffix" (tap)="pick(item)"></Label></ng-template></ListView></StackLayout>' })
export class Rows {
  rows = ['a', 'b', 'c'];
  suffix = '';
  picked = '';
  status = signal('none');
  tapped() { this.status.set('tapped'); }
  pick(item: string) { this.picked = '/' + item; }
  signalled() { this.suffix = '?'; this.status.set('sig'); }
  more() { this.status.set(this.status() + '.'); }
  add() { this.rows.push('d'); }
  copy() { this.rows = [...this.rows]; }
  mark() { this.suffix = '!'; }
}
`);
  const ir = angularComponent(file, readFileSync(file, 'utf8'), new Map())!;
  const expected = ['first: text none,items a b c', 'load: text 1. a,text 2. b', 'recycle: text 3. c', 'tap: text tapped', 'more: text tapped.', 'push: items a b c d', 'replace: items a b c d', 'mark: text 3. c!,text 2. b!', 'signal: text sig,text 3. c?,text 2. b?', 'row: text sig/c'].join('\n');
  const run = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    return (r.stdout + r.stderr).trim();
  };
  const translated = (platform: 'ios' | 'android') => {
    const p = createProgram([file], new Map([[file, ir.source]]), platform, modulesDir);
    const cls = p.program.getSourceFile(file)!.statements.find(ts.isClassDeclaration)!;
    const infos = new Map([[ir.name, { name: ir.name, props: ir.props, optional: ir.optional, changes: ir.changes, onPush: ir.onPush, members: componentMembersOf(cls, p.checker) }]]);
    return { ...p, cls, infos };
  };
  const script = (render: string, swift: boolean) => {
    const step = (code: string, label: string) => [code, 'Microtasks.checkpoint()', `show("${label}")`];
    return [
      swift ? 'Reactivity.schedule = .microtask' : 'Reactivity.schedule = Reactivity.Schedule.MICROTASK',
      swift ? 'let page = Rows()' : 'val page = Rows()',
      ...step(swift ? `let root = createRoot { o in _ = try! page.${render}(); return o }` : `val root = createRoot { o -> page.${render}(); o }`, 'first'),
      ...step('load(0, 0); load(1, 1)', 'load'), ...step('load(0, 2)', 'recycle'),
      ...step('fire("itemTap", 0)', 'tap'), ...step('fire("loadMoreItems", 0)', 'more'),
      ...step('fire("tap", 0)', 'push'), ...step('fire("tap", 1)', 'replace'), ...step('fire("tap", 2)', 'mark'),
      ...step('page.signalled()', 'signal'), ...step('fire("tap", 3)', 'row'),
      'root.dispose()',
    ];
  };
  try {
    let got: string;
    try {
      buildSwiftRuntime(nativeBuild, '-Onone');
      const { program, files: sourceFiles, checker, cls, infos } = translated('ios');
      const sw = new SwiftTranslator(checker, infos, sourceFiles, { plainFields: true });
      const out = join(dir, 'swift');
      mkdirSync(out);
      writeFileSync(join(out, 'app.swift'), `import Foundation\nimport NativeScriptKit\n${translateModules(sw, program, [file]).map((m) => m.code).join('\n')}`);
      writeFileSync(join(out, 'Rows.swift'), `import Foundation\nimport NativeScriptKit\nfinal class Rows {\n${[...sw.componentMembers(cls, ir.props), ...render(ir, infos, () => false, angular.behaviour)].join('\n')}\n}\n`);
      writeFileSync(join(out, 'views.swift'), `import NativeScriptKit
final class EventData {}
var log: [String] = []
var listeners: [(String, (EventData) -> Void)] = []
func show(_ label: String) { print(label + ": " + log.joined(separator: ",")); log = [] }
func fire(_ name: String, _ nth: Int) { listeners.filter { $0.0 == name }[nth].1(EventData()) }
class View { init() throws {}
  func kitSet(_ key: String, _ value: Any?) { if key == "text" { log.append("text \\(value as? String ?? "?")") } }
  func kitAddChild(_ view: View) {}
  func kitOn(_ name: String, _ handler: @escaping (EventData) -> Void) { listeners.append((name, handler)) } }
final class Label: View {}
final class Button: View {}
final class StackLayout: View {}
final class ListRow<Item> {
  let item: Signal<Item>
  let index: Signal<Double>
  init(_ item: Item, _ index: Double) { self.item = Signal(item); self.index = Signal(index) } }
var load: (Int, Int) -> Void = { _, _ in }
final class ListView: View {
  func bind<Items: Sequence>(items: @escaping () throws -> Items, templates: [String] = ["default"], selector: ((Items.Element, Double) throws -> String)? = nil, render: ((String, ListRow<Items.Element>) throws -> View)? = nil) {
    var current: [Items.Element] = []
    var cells: [Int: ListRow<Items.Element>] = [:]
    let rowScope = RowScope()
    listItems(items) { elements in current = elements; log.append("items " + elements.map { "\\($0)" }.joined(separator: " ")) }
    load = { cell, index in
      if let row = cells[cell] { row.item.value = current[index]; row.index.value = Double(index); return }
      let row = ListRow(current[index], Double(index))
      cells[cell] = row
      _ = try! rowScope.render { try render?("default", row) }
    }
  }
}
`);
      writeFileSync(join(out, 'main.swift'), `import NativeScriptKit\n${script(infos.get('Rows')!.members.render, true).join('\n')}\n`);
      const errors = swiftc(readdirSync(out).map((f) => join(out, f)), join(dir, 'main'), nativeBuild, '-Onone');
      got = errors ? errors.join('\n').slice(0, 1500) : run(join(dir, 'main'), []);
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, "a zoneless page's refresh sets a ListView's items only when given another reference or other elements, a recycled row shows its new item, and rows refresh with the page (Swift)");
    if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);

    try {
      const { program, files: sourceFiles, checker, cls, infos } = translated('android');
      const kt = new Translator(checker, infos, sourceFiles, { appModule: 'org.example.app', plainFields: true });
      const out = join(dir, 'kotlin');
      mkdirSync(out);
      const head = 'package org.example.app\nimport org.nativescript.kit.*\n';
      writeFileSync(join(out, 'App.kt'), head + translateKotlinModules(kt, program, [file]).map((m) => m.code).join('\n'));
      const { params, lines } = kt.componentMembers(cls, ir.props);
      writeFileSync(join(out, 'Rows.kt'), `${head}class Rows(${params.join(', ')}) {\n${[...lines, ...renderKotlin(ir, infos, { behaviour: angular.behaviour })].join('\n')}\n}\n`);
      writeFileSync(join(out, 'Views.kt'), `${head}class EventData
val log = mutableListOf<String>()
val listeners = mutableListOf<Pair<String, (EventData) -> Unit>>()
fun show(label: String) { println(label + ": " + log.joinToString(",")); log.clear() }
fun fire(name: String, nth: Int) { listeners.filter { it.first == name }[nth].second(EventData()) }
open class View {
  fun kitSet(key: String, value: Any?) { if (key == "text") log.add("text $value") }
  fun kitAddChild(view: View) {}
  fun kitOn(name: String, handler: (EventData) -> Unit) { listeners.add(name to handler) }
}
class Label : View()
class Button : View()
class StackLayout : View()
class ListRow<Item>(item: Item, index: Double) { val item = Signal(item); val index = Signal(index) }
var load: (Int, Int) -> Unit = { _, _ -> }
class ListView : View() {
  fun <Item> bind(items: () -> JSArray<Item>, templates: List<String> = listOf("default"), selector: ((Item, Double) -> String)? = null, render: ((String, ListRow<Item>) -> View)? = null) {
    var current: List<Item> = emptyList()
    val cells = HashMap<Int, ListRow<Item>>()
    val rowScope = RowScope()
    listItems(items) { elements -> current = elements; log.add("items " + elements.joinToString(" ")) }
    load = { cell, index ->
      val row = cells[cell]
      if (row != null) { row.item.value = current[index]; row.index.value = index.toDouble() }
      else { val made = ListRow(current[index], index.toDouble()); cells[cell] = made; rowScope.render { render?.invoke("default", made) } }
    }
  }
}
`);
      writeFileSync(join(out, 'Main.kt'), `import org.example.app.*\nimport org.nativescript.kit.*\nfun main() {\n${script(infos.get('Rows')!.members.render, false).map((l) => `    ${l}`).join('\n')}\n}\n`);
      const runtime = buildKotlinRuntime(nativeBuild);
      const errors = kotlinc(readdirSync(out).map((f) => join(out, f)), join(dir, 'classes'), [runtime]);
      got = errors ? errors.join('\n').slice(0, 1500) : run('java', ['-cp', [join(dir, 'classes'), runtime, kotlinStdlib()].join(':'), 'MainKt']);
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, "a zoneless page's refresh sets a ListView's items only when given another reference or other elements, a recycled row shows its new item, and rows refresh with the page (Kotlin)");
    if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- Where an Angular app's uncaught errors go ----
(() => {
  // With zone.js every task's error reaches the ErrorHandler and never the runtime; without it only Angular's own
  // catch sites' do (a template listener here). Node has no zone app, so no diff case reaches it.
  const dir = mkdtempSync(join(nativeBuild, 'release-checks-angular-errors-'));
  const file = join(dir, 'app.ts');
  writeFileSync(file, `export function fail(what: string): void { throw what; }\n`);
  const expected = { out: 'runtime timer', err: 'ERROR listener\nERROR task' };
  const run = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    return { out: r.stdout.trim(), err: r.stderr.trim() };
  };
  try {
    let got: { out: string; err: string };
    try {
      buildSwiftRuntime(nativeBuild, '-Onone');
      const out = join(dir, 'swift');
      translateSwift([file], out);
      writeFileSync(join(out, 'main.swift'), `import Foundation
import NativeScriptKit
jsUncaughtHandler = { error in if !Zone.handOff(error) { print("runtime", error ?? "") } }
jsReport { try fail("timer") }
Reactivity.event(dirty: nil) { jsReport { try fail("listener") } }
Zone.enabled = true
jsReport { try fail("task") }
`);
      const errors = swiftc(readdirSync(out).map((f) => join(out, f)), join(dir, 'main'), nativeBuild, '-Onone');
      got = errors ? { out: errors[0], err: '' } : run(join(dir, 'main'), []);
    } catch (e) {
      got = { out: (e as Error).message.split('\n')[0], err: '' };
    }
    check(got.out === expected.out && got.err === expected.err, "an Angular app's uncaught error goes to the ErrorHandler, Angular's own logging it, from every task with zone.js and from a template listener without it; else to the runtime (Swift)");
    if (got.out !== expected.out || got.err !== expected.err) console.log(`    got: ${JSON.stringify(got).slice(0, 600)}`);

    try {
      const out = join(dir, 'kotlin');
      translateKotlin([file], out, 'org.example.app');
      writeFileSync(join(out, 'Main.kt'), `import org.example.app.*
import org.nativescript.kit.*
fun main() {
    jsUncaughtHandler = { error -> if (!Zone.handOff(error)) println("runtime $error") }
    jsReport { fail("timer") }
    Reactivity.event(null) { jsReport { fail("listener") } }
    Zone.enabled = true
    jsReport { fail("task") }
}
`);
      const runtime = buildKotlinRuntime(nativeBuild);
      const errors = kotlinc(readdirSync(out).map((f) => join(out, f)), join(dir, 'classes'), [runtime]);
      got = errors ? { out: errors[0], err: '' } : run('java', ['-cp', [join(dir, 'classes'), runtime, kotlinStdlib()].join(':'), 'MainKt']);
    } catch (e) {
      got = { out: (e as Error).message.split('\n')[0], err: '' };
    }
    check(got.out === expected.out && got.err === expected.err, "an Angular app's uncaught error goes to the ErrorHandler, Angular's own logging it, from every task with zone.js and from a template listener without it; else to the runtime (Kotlin)");
    if (got.out !== expected.out || got.err !== expected.err) console.log(`    got: ${JSON.stringify(got).slice(0, 600)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

(() => {
  // A standalone component created as a root view gets its own environment injector, per environment injector it is
  // created over, as Angular's `StandaloneService` makes one (`getStandaloneInjector`); its imported modules are
  // constructed again there, and component injectors around a routed one are asked before it. Node can't create a
  // component without a renderer, so the expected lines are what `ɵcmp.getStandaloneInjector` gives in Node.
  const dir = mkdtempSync(join(nativeBuild, 'release-checks-standalone-injector-'));
  const file = join(dir, 'app.ts');
  writeFileSync(file, `import { Injectable, InjectionToken, NgModule, inject } from '@angular/core';
const made: string[] = [];
export const TAG = new InjectionToken<string>('TAG');
let count = 0;
@Injectable()
export class Greeter { id = ++count; }
@NgModule({ providers: [Greeter, { provide: TAG, useValue: 'shell' }] })
export class ShellModule { constructor() { made.push('shell'); } }
@NgModule({ imports: [ShellModule] })
export class SharedModule { constructor() { made.push('shared'); } }
export const nodeProviders = [{ provide: TAG, useValue: 'node' }];
export function taken(label: string): string { return [label, ...made.splice(0)].join(' '); }
export function seen(): string { return inject(Greeter).id + ' ' + inject(TAG); }
`);
  const expected = ['env shell 1 shell', 'root shell shared 2 shell', 'again 2 shell', 'other shell shared 3 shell', 'env2 shell shared 4 shell', 'bare 1 shell', 'node 2 node'].join('\n');
  let got: string;
  try {
    buildSwiftRuntime(nativeBuild, '-Onone');
    const out = join(dir, 'swift');
    const inits = translateSwift([file], out).flatMap((m) => (m.init ? [`${m.init}()`] : [])).join('\n');
    writeFileSync(join(out, 'main.swift'), `import Foundation
import NativeScriptKit
${inits}
final class Root {}
final class Other {}
final class Bare {}
let imports = JSArray<Any?>([SharedModule.self])
let env = Injector.create(importProvidersFrom(ShellModule.self))
func view(_ type: Any.Type, _ imports: Any?, _ injector: Injector) throws -> String {
    try Injector.runInContext(injector) { try Injector.standalone(type, imports) { try seen() } }
}
print(try taken("env"), try Injector.runInContext(env) { try seen() })
let root = try view(Root.self, imports, env)
print(try taken("root"), root)
let again = try view(Root.self, imports, env)
print(try taken("again"), again)
let other = try view(Other.self, imports, env)
print(try taken("other"), other)
let env2 = try view(Root.self, imports, Injector.create(JSArray<Any?>([])))
print(try taken("env2"), env2)
let bare = try view(Bare.self, JSArray<Any?>([]), env)
print(try taken("bare"), bare)
let routed = try Injector.runInContext(env) { () throws -> String in
    let node = Injector.enter(nodeProviders)
    defer { node.leave() }
    return try Injector.standalone(Root.self, imports) { try seen() }
}
print(try taken("node"), routed)
`);
    const errors = swiftc(readdirSync(out).map((f) => join(out, f)), join(dir, 'main'), nativeBuild, '-Onone');
    got = errors ? errors[0] : spawnSync(join(dir, 'main'), { encoding: 'utf8' }).stdout.trim();
  } catch (e) {
    got = (e as Error).message.split('\n')[0];
  }
  check(got === expected, "a standalone root view's injector is made once per environment injector, constructing its imported modules again there (Swift)");
  if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);
  try {
    const out = join(dir, 'kotlin');
    const inits = translateKotlin([file], out, 'org.example.app').flatMap((m) => (m.init ? [`    ${m.init}()`] : [])).join('\n');
    writeFileSync(join(out, 'Main.kt'), `import org.example.app.*
import org.nativescript.kit.*
class Root
class Other
class Bare
fun view(type: Class<*>, imports: Any?, injector: Injector): String = Injector.runInContext(injector) { Injector.standalone(type, imports) { seen() } }
fun main() {
${inits}
    val imports = jsArrayOf<Any?>(SharedModule::class.java)
    val env = Injector.create(importProvidersFrom(ShellModule::class.java))
    println(taken("env") + " " + Injector.runInContext(env) { seen() })
    val root = view(Root::class.java, imports, env)
    println(taken("root") + " " + root)
    val again = view(Root::class.java, imports, env)
    println(taken("again") + " " + again)
    val other = view(Other::class.java, imports, env)
    println(taken("other") + " " + other)
    val env2 = view(Root::class.java, imports, Injector.create(jsArrayOf<Any?>()))
    println(taken("env2") + " " + env2)
    val bare = view(Bare::class.java, jsArrayOf<Any?>(), env)
    println(taken("bare") + " " + bare)
    val routed = Injector.runInContext(env) {
        val node = Injector.enter(nodeProviders)
        try { Injector.standalone(Root::class.java, imports) { seen() } } finally { node.leave() }
    }
    println(taken("node") + " " + routed)
}
`);
    const runtime = buildKotlinRuntime(nativeBuild);
    const errors = kotlinc(readdirSync(out).map((f) => join(out, f)), join(dir, 'classes'), [runtime]);
    got = errors ? errors[0] : spawnSync('java', ['-cp', [join(dir, 'classes'), runtime, kotlinStdlib()].join(':'), 'MainKt'], { encoding: 'utf8' }).stdout.trim();
  } catch (e) {
    got = (e as Error).message.split('\n')[0];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  check(got === expected, "a standalone root view's injector is made once per environment injector, constructing its imported modules again there (Kotlin)");
  if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);
})();


// ---- REV-NG (F5): OnPush child input & ngDoCheck markForCheck run in the same pass before ngAfterViewChecked ----
(() => {
  const dir = mkdtempSync(join(nativeBuild, 'release-checks-revng-f5-'));
  const sources: Record<string, string> = {
    'log.ts': `export const log: string[] = [];
export function flushLog(tag: string): void { console.log(tag + ': ' + log.join(',')); log.length = 0; }
`,
    'k3o.component.ts': `import { Component, Input } from '@angular/core';
import { log } from './log';
@Component({ selector: 'K3o', template: '<Label [text]="read()"></Label>' })
export class K3o {
  @Input() label = '';
  read(): string { log.push('K3o bind ' + this.label); return this.label; }
  ngAfterViewChecked() { log.push('K3o viewChecked'); }
}
`,
    'k3d.component.ts': `import { ChangeDetectorRef, Component, inject } from '@angular/core';
import { log } from './log';
@Component({ selector: 'K3d', template: '<Label [text]="read()"></Label>' })
export class K3d {
  cd = inject(ChangeDetectorRef);
  n = 0;
  markNext = false;
  updateN(v: number) { this.n = v; }
  read(): string { log.push('K3d bind ' + this.n); return String(this.n); }
  ngDoCheck() { log.push('K3d doCheck'); if (this.markNext) { this.markNext = false; this.cd.markForCheck(); } }
  ngAfterViewChecked() { log.push('K3d viewChecked'); }
}
`,
    'parent.component.ts': `import { ChangeDetectionStrategy, ChangeDetectorRef, Component, inject } from '@angular/core';
import { log } from './log';
import { K3o } from './k3o.component';
import { K3d } from './k3d.component';
@Component({ selector: 'Parent', changeDetection: ChangeDetectionStrategy.Eager, imports: [K3o, K3d], template: '<StackLayout><K3o [label]="v"></K3o><K3d></K3d></StackLayout>' })
export class Parent {
  cd = inject(ChangeDetectorRef);
  v = 'a';
  updateV(next: string) { this.v = next; }
  ngAfterViewChecked() { log.push('P viewChecked'); }
}
`,
  };
  const files = Object.keys(sources).map((f) => join(dir, f));
  for (const [f, text] of Object.entries(sources)) writeFileSync(join(dir, f), text);
  const comps = files.filter((f) => f.endsWith('.component.ts'));
  const irs = comps.map((f) => angularComponent(f, readFileSync(f, 'utf8'), new Map([['K3o', 'K3o'], ['K3d', 'K3d']]))!);
  const overrides = new Map(comps.map((f, i) => [f, irs[i].source]));
  const expected = [
    'zone: K3d doCheck,K3o bind b,K3d bind 1,K3o viewChecked,K3d viewChecked,P viewChecked',
    'zoneless: K3d doCheck,K3o bind c,K3d bind 2,K3o viewChecked,K3d viewChecked,P viewChecked',
  ].join('\n');
  const translated = (platform: 'ios' | 'android') => {
    const p = createProgram(files, overrides, platform, modulesDir);
    const classes = comps.map((f) => p.program.getSourceFile(f)!.statements.find(ts.isClassDeclaration)!);
    const infos = new Map(irs.map((ir, i) => [ir.name, { name: ir.name, props: ir.props, optional: ir.optional, changes: ir.changes, onPush: ir.onPush, doCheck: !!ir.doCheck, afterContentInit: !!ir.afterContentInit, afterContentChecked: !!ir.afterContentChecked, afterViewChecked: !!ir.afterViewChecked, members: componentMembersOf(classes[i], p.checker) }]));
    return { ...p, classes, infos };
  };
  try {
    let got: string;
    try {
      buildSwiftRuntime(nativeBuild, '-Onone');
      const { program, files: sourceFiles, checker, classes, infos } = translated('ios');
      const sw = new SwiftTranslator(checker, infos, sourceFiles, { plainFields: true });
      const out = join(dir, 'swift');
      mkdirSync(out);
      writeFileSync(join(out, 'app.swift'), `import Foundation\nimport NativeScriptKit\n${translateModules(sw, program, files).map((m) => m.code).join('\n')}`);
      irs.forEach((ir, i) => writeFileSync(join(out, `${ir.name}.swift`), `import Foundation\nimport NativeScriptKit\nfinal class ${ir.name} {\n${[...sw.componentMembers(classes[i], ir.props), ...render(ir, infos, () => false, angular.behaviour)].join('\n')}\n}\n`));
      writeFileSync(join(out, 'views.swift'), `import NativeScriptKit
class View { init() throws {}; func kitSet(_ k: String, _ v: Any?) {}; func kitAddChild(_ v: View) {} }
final class Label: View {}
final class StackLayout: View {}
`);
      writeFileSync(join(out, 'main.swift'), `import NativeScriptKit
Reactivity.schedule = .microtask
Zone.enabled = true
let p = AngularView.construct { Parent() }
let k3o = AngularView.construct { K3o() }
let k3d = AngularView.construct { K3d() }
let root = createRoot { o in
    EffectOrder.root {
        EffectOrder.view(for: p) {
            Check({ p.v }) { k3o.label.value = $0; Zone.inputChanged(k3o) }
            EveryCheck { k3d.ngDoCheck() }
            EffectOrder.view(for: k3o, onPush: true) { Check({ k3o.read() }) { _ in } }
            EffectOrder.view(for: k3d, onPush: true) { Check({ k3d.read() }) { _ in } }
            ViewChecked { k3o.ngAfterViewChecked() }
            ViewChecked { k3d.ngAfterViewChecked() }
        }
        ViewChecked { p.ngAfterViewChecked() }
    }
    return o
}
log.storage = []
p.v = "b"; k3d.n = 1; k3d.markNext = true
Zone.tick()
flushLog("zone")
Zone.enabled = false
p.v = "c"; k3d.n = 2; k3d.markNext = true
p.cd.markForCheck()
Microtasks.checkpoint()
flushLog("zoneless")
root.dispose()
`);
      const errors = swiftc(readdirSync(out).map((f) => join(out, f)), join(dir, 'main'), nativeBuild, '-Onone');
      got = errors ? errors.join('\n').slice(0, 1500) : spawnSync(join(dir, 'main'), [], { encoding: 'utf8' }).stdout.trim();
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, 'F5: OnPush child input and ngDoCheck markForCheck refresh in the same pass before ngAfterViewChecked (Swift)');
    if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);

    try {
      const { program, files: sourceFiles, checker, classes, infos } = translated('android');
      const kt = new Translator(checker, infos, sourceFiles, { appModule: 'org.example.app', plainFields: true });
      const out = join(dir, 'kotlin');
      mkdirSync(out);
      const head = 'package org.example.app\nimport org.nativescript.kit.*\n';
      writeFileSync(join(out, 'App.kt'), head + translateKotlinModules(kt, program, files).map((m) => m.code).join('\n'));
      irs.forEach((ir, i) => {
        const { params, lines } = kt.componentMembers(classes[i], ir.props);
        writeFileSync(join(out, `${ir.name}.kt`), `${head}class ${ir.name}(${params.join(', ')}) {\n${[...lines, ...renderKotlin(ir, infos, { behaviour: angular.behaviour })].join('\n')}\n}\n`);
      });
      writeFileSync(join(out, 'Views.kt'), `${head}open class View { fun kitSet(k: String, v: Any?) {}; fun kitAddChild(v: View) {} }
class Label : View()
class StackLayout : View()
`);
      writeFileSync(join(out, 'Main.kt'), `import org.example.app.*
import org.nativescript.kit.*
fun main() {
    Reactivity.schedule = Reactivity.Schedule.MICROTASK
    Zone.enabled = true
    val p = AngularView.construct { Parent() }
    val k3o = AngularView.construct { K3o() }
    val k3d = AngularView.construct { K3d() }
    val root = createRoot { o ->
        EffectOrder.root {
            EffectOrder.view(null, p) {
                Check({ p.v }) { k3o.label.value = it; Zone.inputChanged(k3o) }
                EveryCheck { k3d.ngDoCheck() }
                EffectOrder.view(null, k3o, true) { Check({ k3o.read() }) { } }
                EffectOrder.view(null, k3d, true) { Check({ k3d.read() }) { } }
                ViewChecked { k3o.ngAfterViewChecked() }
                ViewChecked { k3d.ngAfterViewChecked() }
            }
            ViewChecked { p.ngAfterViewChecked() }
        }
        o
    }
    log.storage.clear()
    p.v = "b"; k3d.n = 1.0; k3d.markNext = true
    Zone.tick()
    flushLog("zone")
    Zone.enabled = false
    p.v = "c"; k3d.n = 2.0; k3d.markNext = true
    p.cd.markForCheck()
    Microtasks.checkpoint()
    flushLog("zoneless")
    root.dispose()
}
`);
      const runtime = buildKotlinRuntime(nativeBuild);
      const errors = kotlinc(readdirSync(out).map((f) => join(out, f)), join(dir, 'classes'), [runtime]);
      got = errors ? errors.join('\n').slice(0, 1500) : spawnSync('java', ['-cp', [join(dir, 'classes'), runtime, kotlinStdlib()].join(':'), 'MainKt'], { encoding: 'utf8' }).stdout.trim();
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, 'F5: OnPush child input and ngDoCheck markForCheck refresh in the same pass before ngAfterViewChecked (Kotlin)');
    if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- REV-NG (F6): Signal reads in @if, @for, <ListView [items]> defer to view template order ----
(() => {
  const dir = mkdtempSync(join(nativeBuild, 'release-checks-revng-f6-'));
  const file = join(dir, 'app.ts');
  writeFileSync(file, 'export const dummy = 1;\n');
  const expected = 'tick: lead 1,if 1,for a b,items a b,trail 1';
  try {
    let got: string;
    try {
      buildSwiftRuntime(nativeBuild, '-Onone');
      const out = join(dir, 'swift');
      translateSwift([file], out);
      writeFileSync(join(out, 'main.swift'), `import Foundation
import NativeScriptKit
Reactivity.schedule = .microtask
let s = Signal(0.0)
let list = Signal(JSArray<String>(["a"]))
var log: [String] = []
final class Host {}
let h = AngularView.construct { Host() }
let root = createRoot { o in
    EffectOrder.root {
        EffectOrder.view(for: h, onPush: true) {
            Check({ s.value }) { log.append("lead " + String(Int($0))) }
            Effect { let v = s.value > 0 ? 1 : 0; untrack { log.append("if " + String(v)) } }
            Effect { let els = Array(list.value); untrack { log.append("for " + els.joined(separator: " ")) } }
            listItems({ list.value }) { els in log.append("items " + els.joined(separator: " ")) }
            Check({ s.value }) { log.append("trail " + String(Int($0))) }
        }
    }
    return o
}
log = []
s.value = 1
list.value = JSArray<String>(["a", "b"])
Microtasks.checkpoint()
print("tick: " + log.joined(separator: ","))
root.dispose()
`);
      const errors = swiftc(readdirSync(out).map((f) => join(out, f)), join(dir, 'main'), nativeBuild, '-Onone');
      got = errors ? errors.join('\n').slice(0, 1500) : spawnSync(join(dir, 'main'), [], { encoding: 'utf8' }).stdout.trim();
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, 'F6: signal writes in @if, @for, and <ListView [items]> defer to view template order (Swift)');
    if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);

    try {
      const out = join(dir, 'kotlin');
      translateKotlin([file], out, 'org.example.app');
      writeFileSync(join(out, 'Main.kt'), `import org.nativescript.kit.*
class Host
fun main() {
    Reactivity.schedule = Reactivity.Schedule.MICROTASK
    val s = Signal(0.0)
    val list = Signal(jsArrayOf("a"))
    val log = mutableListOf<String>()
    val h = AngularView.construct { Host() }
    val root = createRoot { o ->
        EffectOrder.root {
            EffectOrder.view(null, h, true) {
                Check({ s.value }) { log.add("lead " + it.toInt()) }
                Effect { val v = if (s.value > 0) 1 else 0; untrack { log.add("if " + v) } }
                Effect { val els = list.value.elements.toList(); untrack { log.add("for " + els.joinToString(" ")) } }
                listItems({ list.value }) { els -> log.add("items " + els.joinToString(" ")) }
                Check({ s.value }) { log.add("trail " + it.toInt()) }
            }
        }
        o
    }
    log.clear()
    s.value = 1.0
    list.value = jsArrayOf("a", "b")
    Microtasks.checkpoint()
    println("tick: " + log.joinToString(","))
    root.dispose()
}
`);
      const runtime = buildKotlinRuntime(nativeBuild);
      const errors = kotlinc(readdirSync(out).map((f) => join(out, f)), join(dir, 'classes'), [runtime]);
      got = errors ? errors.join('\n').slice(0, 1500) : spawnSync('java', ['-cp', [join(dir, 'classes'), runtime, kotlinStdlib()].join(':'), 'MainKt'], { encoding: 'utf8' }).stdout.trim();
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, 'F6: signal writes in @if, @for, and <ListView [items]> defer to view template order (Kotlin)');
    if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- REV-NG (F7 + F25): Component effect() initial lifecycle order + Kotlin Reactivity.detectChanges parity ----
(() => {
  const dir = mkdtempSync(join(nativeBuild, 'release-checks-revng-f7-'));
  const logFile = join(dir, 'log.ts');
  const file = join(dir, 'order.component.ts');
  writeFileSync(logFile, 'export const log: string[] = [];\n');
  writeFileSync(file, `import { Component, effect, signal } from '@angular/core';
import { log } from './log';
@Component({ selector: 'Order', template: '<Label [text]="bind()"></Label>' })
export class Order {
  s = signal(0);
  fx = effect(() => { log.push('effect:' + this.s()); });
  ngOnInit() { log.push('init'); }
  ngDoCheck() { log.push('doCheck'); }
  ngAfterContentInit() { log.push('contentInit'); }
  bind(): string { log.push('binding'); return 'ok'; }
  ngAfterViewInit() { log.push('viewInit'); }
}
`);
  const files = [logFile, file];
  const ir = angularComponent(file, readFileSync(file, 'utf8'), new Map())!;
  const expected = 'init,doCheck,effect:0,contentInit,binding,viewInit|effect:1|scoped:after|rest:before';
  const translated = (platform: 'ios' | 'android') => {
    const p = createProgram(files, new Map([[file, ir.source]]), platform, modulesDir);
    const cls = p.program.getSourceFile(file)!.statements.find(ts.isClassDeclaration)!;
    const infos = new Map([[ir.name, { name: ir.name, props: ir.props, optional: ir.optional, changes: ir.changes, onPush: ir.onPush, doCheck: !!ir.doCheck, afterContentInit: !!ir.afterContentInit, afterContentChecked: !!ir.afterContentChecked, afterViewChecked: !!ir.afterViewChecked, members: componentMembersOf(cls, p.checker) }]]);
    return { ...p, cls, infos };
  };
  try {
    let got: string;
    try {
      buildSwiftRuntime(nativeBuild, '-Onone');
      const { program, files: sourceFiles, checker, cls, infos } = translated('ios');
      const sw = new SwiftTranslator(checker, infos, sourceFiles, { plainFields: true });
      const out = join(dir, 'swift');
      mkdirSync(out);
      writeFileSync(join(out, 'app.swift'), `import Foundation\nimport NativeScriptKit\n${translateModules(sw, program, files).map((m) => m.code).join('\n')}`);
      writeFileSync(join(out, 'Order.swift'), `import Foundation\nimport NativeScriptKit\nfinal class Order {\n${[...sw.componentMembers(cls, ir.props), ...render(ir, infos, () => false, angular.behaviour)].join('\n')}\n}\n`);
      writeFileSync(join(out, 'views.swift'), `import NativeScriptKit
class View { init() throws {}; func kitSet(_ k: String, _ v: Any?) {} }
final class Label: View {}
`);
      writeFileSync(join(out, 'main.swift'), `import NativeScriptKit
Reactivity.schedule = .microtask
let comp = AngularView.construct { Order() }
let root = createRoot { o in _ = try! comp.${infos.get('Order')!.members.render}(); return o }
let initial = log.storage.joined(separator: ",")
log.storage = []
comp.s.value = 1
Microtasks.checkpoint()
let updated = log.storage.joined(separator: ",")
var seq: [String] = []
_ = Effect.deferred { seq.append("before") }
let snap = Reactivity.pending()
_ = Effect.deferred { seq.append("after") }
Reactivity.detectChanges(after: snap)
let scoped = "scoped:" + seq.joined(separator: ",")
seq = []
Microtasks.checkpoint()
let rest = "rest:" + seq.joined(separator: ",")
print([initial, updated, scoped, rest].joined(separator: "|"))
root.dispose()
`);
      const errors = swiftc(readdirSync(out).map((f) => join(out, f)), join(dir, 'main'), nativeBuild, '-Onone');
      got = errors ? errors.join('\n').slice(0, 1500) : spawnSync(join(dir, 'main'), [], { encoding: 'utf8' }).stdout.trim();
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, 'F7: component effect() runs between ngDoCheck and ngAfterContentInit on initial render (Swift)');
    if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);

    try {
      const { program, files: sourceFiles, checker, cls, infos } = translated('android');
      const kt = new Translator(checker, infos, sourceFiles, { appModule: 'org.example.app', plainFields: true });
      const out = join(dir, 'kotlin');
      mkdirSync(out);
      const head = 'package org.example.app\nimport org.nativescript.kit.*\n';
      writeFileSync(join(out, 'App.kt'), head + translateKotlinModules(kt, program, files).map((m) => m.code).join('\n'));
      const { params, lines } = kt.componentMembers(cls, ir.props);
      writeFileSync(join(out, 'Order.kt'), `${head}class Order(${params.join(', ')}) {\n${[...lines, ...renderKotlin(ir, infos, { behaviour: angular.behaviour })].join('\n')}\n}\n`);
      writeFileSync(join(out, 'Views.kt'), `${head}open class View { fun kitSet(k: String, v: Any?) {} }
class Label : View()
`);
      writeFileSync(join(out, 'Main.kt'), `import org.example.app.*
import org.nativescript.kit.*
fun main() {
    Reactivity.schedule = Reactivity.Schedule.MICROTASK
    val comp = AngularView.construct { Order() }
    val root = createRoot { o -> comp.${infos.get('Order')!.members.render}(); o }
    val initial = log.elements.joinToString(",")
    log.storage.clear()
    comp.s.value = 1.0
    Microtasks.checkpoint()
    val updated = log.elements.joinToString(",")
    val seq = mutableListOf<String>()
    Effect.deferred { seq.add("before") }
    val snap = Reactivity.pending()
    Effect.deferred { seq.add("after") }
    Reactivity.detectChanges(after = snap)
    val scoped = "scoped:" + seq.joinToString(",")
    seq.clear()
    Microtasks.checkpoint()
    val rest = "rest:" + seq.joinToString(",")
    println(listOf(initial, updated, scoped, rest).joinToString("|"))
    root.dispose()
}
`);
      const runtime = buildKotlinRuntime(nativeBuild);
      const errors = kotlinc(readdirSync(out).map((f) => join(out, f)), join(dir, 'classes'), [runtime]);
      got = errors ? errors.join('\n').slice(0, 1500) : spawnSync('java', ['-cp', [join(dir, 'classes'), runtime, kotlinStdlib()].join(':'), 'MainKt'], { encoding: 'utf8' }).stdout.trim();
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, 'F7 + F25: component effect() initial lifecycle order and Reactivity.pending()/detectChanges(after:) parity (Kotlin)');
    if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- REV-NG (F8): ChangeDetectorRef in base class, constructor helper, throw cleanup, and re-entrant construct ----
(() => {
  const dir = mkdtempSync(join(nativeBuild, 'release-checks-revng-f8-'));
  const baseFile = join(dir, 'base.ts');
  const file = join(dir, 'sub.component.ts');
  writeFileSync(baseFile, `import { ChangeDetectorRef, inject } from '@angular/core';
export function readCd(): ChangeDetectorRef { return inject(ChangeDetectorRef); }
export class Base {
  cd = inject(ChangeDetectorRef);
  helperCd = readCd();
}
`);
  writeFileSync(file, `import { Component } from '@angular/core';
import { Base } from './base';
@Component({ selector: 'Sub', template: '<Label [text]="label"></Label>' })
export class Sub extends Base {
  label = 'init';
  updateLabel(v: string) { this.label = v; }
}
`);
  const files = [baseFile, file];
  const ir = angularComponent(file, readFileSync(file, 'utf8'), new Map())!;
  const expected = 'sub:v2|helper:v3|afterThrow:clean|reentrant:outer,inner';
  const translated = (platform: 'ios' | 'android') => {
    const p = createProgram(files, new Map([[file, ir.source]]), platform, modulesDir);
    const cls = p.program.getSourceFile(file)!.statements.filter(ts.isClassDeclaration).find((c) => c.name?.text === 'Sub')!;
    const infos = new Map([[ir.name, { name: ir.name, props: ir.props, optional: ir.optional, changes: ir.changes, onPush: ir.onPush, members: componentMembersOf(cls, p.checker) }]]);
    return { ...p, cls, infos };
  };
  try {
    let got: string;
    try {
      buildSwiftRuntime(nativeBuild, '-Onone');
      const { program, files: sourceFiles, checker, cls, infos } = translated('ios');
      const sw = new SwiftTranslator(checker, infos, sourceFiles, { plainFields: true });
      const out = join(dir, 'swift');
      mkdirSync(out);
      writeFileSync(join(out, 'app.swift'), `import Foundation\nimport NativeScriptKit\n${translateModules(sw, program, files).map((m) => m.code).join('\n')}`);
      writeFileSync(join(out, 'Sub.swift'), `import Foundation\nimport NativeScriptKit\nfinal class Sub {\n${[...sw.componentMembers(cls, ir.props), ...render(ir, infos, () => false, angular.behaviour)].join('\n')}\n}\n`);
      writeFileSync(join(out, 'views.swift'), `import NativeScriptKit
var lastText = ""
class View { init() throws {}; func kitSet(_ k: String, _ v: Any?) { if k == "text" { lastText = v as? String ?? "" } } }
final class Label: View {}
`);
      writeFileSync(join(out, 'main.swift'), `import NativeScriptKit
Reactivity.schedule = .microtask
final class Broken {
    let cd = ChangeDetectorRef.current()
    init() throws { throw JSException(value: JSError("ctor boom")) }
}
final class Outer {
    let cd = ChangeDetectorRef.current()
    let inner: Inner
    init() { self.inner = AngularView.construct { Inner() } }
}
final class Inner { let cd = ChangeDetectorRef.current() }
// 1. Base class + helper function inject(ChangeDetectorRef)
let sub = AngularView.construct { Sub() }
let r1 = createRoot { o in _ = try! sub.${infos.get('Sub')!.members.render}(); return o }
sub.label = "v2"; sub.cd.detectChanges(); let s1 = "sub:" + lastText
sub.label = "v3"; sub.helperCd.detectChanges(); let s2 = "helper:" + lastText
// 2. Throwing constructor discards its frame cleanly
_ = try? AngularView.construct { try Broken() }
let nextSub = AngularView.construct { Sub() }
let r2 = createRoot { o in _ = try! nextSub.${infos.get('Sub')!.members.render}(); return o }
nextSub.label = "clean"; nextSub.cd.detectChanges(); let s3 = "afterThrow:" + lastText
// 3. Re-entrant construct binds outer and inner independently
let outer = AngularView.construct { Outer() }
var reLog: [String] = []
var tick = 0
let r3 = createRoot { o in
    EffectOrder.root { EffectOrder.view(for: outer, onPush: true) { Check({ tick }) { _ in reLog.append("outer") } } }
    EffectOrder.root { EffectOrder.view(for: outer.inner, onPush: true) { Check({ tick }) { _ in reLog.append("inner") } } }
    return o
}
reLog = []
tick = 1; outer.cd.detectChanges()
tick = 2; outer.inner.cd.detectChanges()
let s4 = "reentrant:" + reLog.joined(separator: ",")
print([s1, s2, s3, s4].joined(separator: "|"))
r1.dispose(); r2.dispose(); r3.dispose()
`);
      const errors = swiftc(readdirSync(out).map((f) => join(out, f)), join(dir, 'main'), nativeBuild, '-Onone');
      got = errors ? errors.join('\n').slice(0, 1500) : spawnSync(join(dir, 'main'), [], { encoding: 'utf8' }).stdout.trim();
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, 'F8: ChangeDetectorRef binds cleanly across base class, helper, constructor throw, and re-entrant construct (Swift)');
    if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);

    try {
      const { program, files: sourceFiles, checker, cls, infos } = translated('android');
      const kt = new Translator(checker, infos, sourceFiles, { appModule: 'org.example.app', plainFields: true });
      const out = join(dir, 'kotlin');
      mkdirSync(out);
      const head = 'package org.example.app\nimport org.nativescript.kit.*\n';
      writeFileSync(join(out, 'App.kt'), head + translateKotlinModules(kt, program, files).map((m) => m.code).join('\n'));
      const { params, lines } = kt.componentMembers(cls, ir.props);
      writeFileSync(join(out, 'Sub.kt'), `${head}class Sub(${params.join(', ')}) {\n${[...lines, ...renderKotlin(ir, infos, { behaviour: angular.behaviour })].join('\n')}\n}\n`);
      writeFileSync(join(out, 'Views.kt'), `${head}var lastText = ""
open class View { fun kitSet(k: String, v: Any?) { if (k == "text") lastText = v?.toString() ?: "" } }
class Label : View()
`);
      writeFileSync(join(out, 'Main.kt'), `import org.example.app.*
import org.nativescript.kit.*
class Broken {
    val cd = ChangeDetectorRef.current()
    init { throw JSException(JSError("ctor boom")) }
}
class Inner { val cd = ChangeDetectorRef.current() }
class Outer {
    val cd = ChangeDetectorRef.current()
    val inner: Inner = AngularView.construct { Inner() }
}
fun main() {
    Reactivity.schedule = Reactivity.Schedule.MICROTASK
    val sub = AngularView.construct { Sub() }
    val r1 = createRoot { o -> sub.${infos.get('Sub')!.members.render}(); o }
    sub.label = "v2"; sub.cd.detectChanges(); val s1 = "sub:" + lastText
    sub.label = "v3"; sub.helperCd.detectChanges(); val s2 = "helper:" + lastText
    try { AngularView.construct { Broken() } } catch (_: Throwable) {}
    val nextSub = AngularView.construct { Sub() }
    val r2 = createRoot { o -> nextSub.${infos.get('Sub')!.members.render}(); o }
    nextSub.label = "clean"; nextSub.cd.detectChanges(); val s3 = "afterThrow:" + lastText
    val outer = AngularView.construct { Outer() }
    val reLog = mutableListOf<String>()
    var tick = 0
    val r3 = createRoot { o ->
        EffectOrder.root { EffectOrder.view(null, outer, true) { Check({ tick }) { reLog.add("outer") } } }
        EffectOrder.root { EffectOrder.view(null, outer.inner, true) { Check({ tick }) { reLog.add("inner") } } }
        o
    }
    reLog.clear()
    tick = 1; outer.cd.detectChanges()
    tick = 2; outer.inner.cd.detectChanges()
    val s4 = "reentrant:" + reLog.joinToString(",")
    println(listOf(s1, s2, s3, s4).joinToString("|"))
    r1.dispose(); r2.dispose(); r3.dispose()
}
`);
      const runtime = buildKotlinRuntime(nativeBuild);
      const errors = kotlinc(readdirSync(out).map((f) => join(out, f)), join(dir, 'classes'), [runtime]);
      got = errors ? errors.join('\n').slice(0, 1500) : spawnSync('java', ['-cp', [join(dir, 'classes'), runtime, kotlinStdlib()].join(':'), 'MainKt'], { encoding: 'utf8' }).stdout.trim();
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, 'F8: ChangeDetectorRef binds cleanly across base class, helper, constructor throw, and re-entrant construct (Kotlin)');
    if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- REV-NG (F9): Multi-root isolation, EffectOrder.detached dialog isolation, and subtree-scoped detectChanges() ----
(() => {
  const dir = mkdtempSync(join(nativeBuild, 'release-checks-revng-f9-'));
  const file = join(dir, 'app.ts');
  writeFileSync(file, 'export const dummy = 1;\n');
  const expected = 'markA:A-doCheck,A-bind|markModal:M-doCheck,M-bind|dcZone:C-bind|dcZoneless:C-bind';
  try {
    let got: string;
    try {
      buildSwiftRuntime(nativeBuild, '-Onone');
      const out = join(dir, 'swift');
      translateSwift([file], out);
      writeFileSync(join(out, 'main.swift'), `import NativeScriptKit
Reactivity.schedule = .microtask
final class Comp { let cd = ChangeDetectorRef.current(); var v = 0 }
let a = AngularView.construct { Comp() }
let b = AngularView.construct { Comp() }
let c = AngularView.construct { Comp() }
var m: Comp!
var log: [String] = []
let root = createRoot { o in
    EffectOrder.root {
        EveryCheck { log.append("A-doCheck") }
        EffectOrder.view(for: a) {
            Check({ a.v }) { _ in log.append("A-bind") }
            EffectOrder.view(for: c, onPush: true) { Check({ c.v }) { _ in log.append("C-bind") } }
            // Open a detached modal while inside Root A's view scope
            EffectOrder.detached {
                m = AngularView.construct { Comp() }
                EffectOrder.root {
                    EveryCheck { log.append("M-doCheck") }
                    EffectOrder.view(for: m, onPush: true) { Check({ m.v }) { _ in log.append("M-bind") } }
                }
            }
        }
    }
    EffectOrder.root {
        EveryCheck { log.append("B-doCheck") }
        EffectOrder.view(for: b) { Check({ b.v }) { _ in log.append("B-bind") } }
    }
    return o
}
log = []
a.v = 1; b.v = 1; a.cd.markForCheck(); Microtasks.checkpoint()
let s1 = "markA:" + log.joined(separator: ",")
log = []
m.v = 1; m.cd.markForCheck(); Microtasks.checkpoint()
let s2 = "markModal:" + log.joined(separator: ",")
log = []
Zone.enabled = true
a.v = 2; b.v = 2; c.v = 1; c.cd.detectChanges()
let s3 = "dcZone:" + log.joined(separator: ",")
log = []
Zone.enabled = false
a.v = 3; b.v = 3; c.v = 2; c.cd.detectChanges()
let s4 = "dcZoneless:" + log.joined(separator: ",")
print([s1, s2, s3, s4].joined(separator: "|"))
root.dispose()
`);
      const errors = swiftc(readdirSync(out).map((f) => join(out, f)), join(dir, 'main'), nativeBuild, '-Onone');
      got = errors ? errors.join('\n').slice(0, 1500) : spawnSync(join(dir, 'main'), [], { encoding: 'utf8' }).stdout.trim();
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, 'F9: multi-root isolation, EffectOrder.detached dialog isolation, and subtree-scoped detectChanges() (Swift)');
    if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);

    try {
      const out = join(dir, 'kotlin');
      translateKotlin([file], out, 'org.example.app');
      writeFileSync(join(out, 'Main.kt'), `import org.nativescript.kit.*
class Comp { val cd = ChangeDetectorRef.current(); var v = 0 }
fun main() {
    Reactivity.schedule = Reactivity.Schedule.MICROTASK
    val a = AngularView.construct { Comp() }
    val b = AngularView.construct { Comp() }
    val c = AngularView.construct { Comp() }
    lateinit var m: Comp
    val log = mutableListOf<String>()
    val root = createRoot { o ->
        EffectOrder.root {
            EveryCheck { log.add("A-doCheck") }
            EffectOrder.view(null, a) {
                Check({ a.v }) { log.add("A-bind") }
                EffectOrder.view(null, c, true) { Check({ c.v }) { log.add("C-bind") } }
                EffectOrder.detached {
                    m = AngularView.construct { Comp() }
                    EffectOrder.root {
                        EveryCheck { log.add("M-doCheck") }
                        EffectOrder.view(null, m, true) { Check({ m.v }) { log.add("M-bind") } }
                    }
                }
            }
        }
        EffectOrder.root {
            EveryCheck { log.add("B-doCheck") }
            EffectOrder.view(null, b) { Check({ b.v }) { log.add("B-bind") } }
        }
        o
    }
    log.clear()
    a.v = 1; b.v = 1; a.cd.markForCheck(); Microtasks.checkpoint()
    val s1 = "markA:" + log.joinToString(",")
    log.clear()
    m.v = 1; m.cd.markForCheck(); Microtasks.checkpoint()
    val s2 = "markModal:" + log.joinToString(",")
    log.clear()
    Zone.enabled = true
    a.v = 2; b.v = 2; c.v = 1; c.cd.detectChanges()
    val s3 = "dcZone:" + log.joinToString(",")
    log.clear()
    Zone.enabled = false
    a.v = 3; b.v = 3; c.v = 2; c.cd.detectChanges()
    val s4 = "dcZoneless:" + log.joinToString(",")
    println(listOf(s1, s2, s3, s4).joinToString("|"))
    root.dispose()
}
`);
      const runtime = buildKotlinRuntime(nativeBuild);
      const errors = kotlinc(readdirSync(out).map((f) => join(out, f)), join(dir, 'classes'), [runtime]);
      got = errors ? errors.join('\n').slice(0, 1500) : spawnSync('java', ['-cp', [join(dir, 'classes'), runtime, kotlinStdlib()].join(':'), 'MainKt'], { encoding: 'utf8' }).stdout.trim();
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, 'F9: multi-root isolation, EffectOrder.detached dialog isolation, and subtree-scoped detectChanges() (Kotlin)');
    if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- REV-NG (F17): Synchronous ListView row recycle flush under .task + sectioned listSections snapshot ----
(() => {
  const dir = mkdtempSync(join(nativeBuild, 'release-checks-revng-f17-'));
  const file = join(dir, 'app.ts');
  writeFileSync(file, 'export const dummy = 1;\n');
  const expected = 'syncRecycle:1:b|reentrantRecycle:2:c|sections:1->2';
  try {
    let got: string;
    try {
      buildSwiftRuntime(nativeBuild, '-Onone');
      const out = join(dir, 'swift');
      translateSwift([file], out);
      writeFileSync(join(out, 'main.swift'), `import NativeScriptKit
Reactivity.schedule = .task
final class Sec { var items: JSArray<String>; init(_ items: JSArray<String>) { self.items = items } }
let rowItem = Signal("a", equals: { _, _ in false })
let rowIndex = Signal(0.0)
var rendered = ""
let sections = JSArray<Sec>([Sec(JSArray<String>(["x"]))])
var appliedCounts: [Int] = []
let trigger = Signal(0.0)
let root = createRoot { o in
    EffectOrder.root {
        EffectOrder.view {
            Check({ String(Int(rowIndex.value)) + ":" + rowItem.value }) { rendered = $0 }
            listSections({ sections }, rows: { Array($0.items) }) { _, grouped in appliedCounts.append(grouped[0].count) }
        }
    }
    // Re-entrant flushScoped inside an outer flush()
    Effect {
        if trigger.value > 0 {
            let before = Reactivity.pending()
            rowItem.value = "c"; rowIndex.value = 2
            Reactivity.flushScoped(after: before)
        }
    }
    return o
}
// 1. Direct recycle under .task (no timer/microtask drained!)
let before = Reactivity.pending()
rowItem.value = "b"; rowIndex.value = 1
Reactivity.flushScoped(after: before)
let s1 = "syncRecycle:" + rendered
// 2. Re-entrant recycle inside an outer flush (e.g. reloadData firing itemLoading)
batch { trigger.value = 1 }
let s2 = "reentrantRecycle:" + rendered
// 3. In-place push on section.items detected by listSections
sections.storage[0].items.storage.append("y")
Zone.enabled = true
Zone.tick()
Zone.enabled = false
let s3 = "sections:" + appliedCounts.map(String.init).joined(separator: "->")
print([s1, s2, s3].joined(separator: "|"))
root.dispose()
`);
      const errors = swiftc(readdirSync(out).map((f) => join(out, f)), join(dir, 'main'), nativeBuild, '-Onone');
      got = errors ? errors.join('\n').slice(0, 1500) : spawnSync(join(dir, 'main'), [], { encoding: 'utf8' }).stdout.trim();
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, 'F17: synchronous recycled row flush (direct & re-entrant under .task) and sectioned listSections snapshot (Swift)');
    if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);

    try {
      const out = join(dir, 'kotlin');
      translateKotlin([file], out, 'org.example.app');
      writeFileSync(join(out, 'Main.kt'), `import org.nativescript.kit.*
data class Box(val name: String)
class Sec(val items: JSArray<String>)
fun main() {
    Reactivity.schedule = Reactivity.Schedule.TASK
    val rowItem = Signal(Box("a")) { _, _ -> false }
    val rowIndex = Signal(0.0)
    var rendered = ""
    val sections = jsArrayOf(Sec(jsArrayOf("x")))
    val appliedCounts = mutableListOf<Int>()
    val trigger = Signal(0.0)
    val root = createRoot { o ->
        EffectOrder.root {
            EffectOrder.view {
                Check({ rowIndex.value.toInt().toString() + ":" + rowItem.value.name }) { rendered = it }
                listSections({ sections }, { it.items.elements }) { _, grouped -> appliedCounts.add(grouped[0].size) }
            }
        }
        Effect {
            if (trigger.value > 0) {
                val before = Reactivity.pending()
                rowItem.value = Box("c"); rowIndex.value = 2.0
                Reactivity.flushScoped(after = before)
            }
        }
        o
    }
    val before = Reactivity.pending()
    rowItem.value = Box("b"); rowIndex.value = 1.0
    Reactivity.flushScoped(after = before)
    val s1 = "syncRecycle:" + rendered
    batch { trigger.value = 1.0 }
    val s2 = "reentrantRecycle:" + rendered
    sections.storage[0].items.storage.add("y")
    Zone.enabled = true
    Zone.tick()
    Zone.enabled = false
    val s3 = "sections:" + appliedCounts.joinToString("->")
    println(listOf(s1, s2, s3).joinToString("|"))
    root.dispose()
}
`);
      const runtime = buildKotlinRuntime(nativeBuild);
      const errors = kotlinc(readdirSync(out).map((f) => join(out, f)), join(dir, 'classes'), [runtime]);
      got = errors ? errors.join('\n').slice(0, 1500) : spawnSync('java', ['-cp', [join(dir, 'classes'), runtime, kotlinStdlib()].join(':'), 'MainKt'], { encoding: 'utf8' }).stdout.trim();
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, 'F17: synchronous recycled row flush (direct & re-entrant under TASK) and sectioned listSections snapshot (Kotlin)');
    if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- REV-NG (F18): @let throw aborts remaining bindings in its view (no NG0314) + @if tick deferral ----
(() => {
  const dir = mkdtempSync(join(nativeBuild, 'release-checks-revng-f18-'));
  const file = join(dir, 'app.ts');
  writeFileSync(file, 'export const dummy = 1;\n');
  const expected = 'errCount:1|recovered:ok,ok|ifOrder:sibling,branch';
  try {
    let got: string;
    try {
      buildSwiftRuntime(nativeBuild, '-Onone');
      const out = join(dir, 'swift');
      translateSwift([file], out);
      writeFileSync(join(out, 'main.swift'), `import NativeScriptKit
Reactivity.schedule = .microtask
Zone.enabled = true
var errors: [String] = []
jsUncaughtHandler = { err in errors.append(jsToString(err)) }
var fail = true
var show = false
var reads: [String] = []
var ifOrder: [String] = []
let root = createRoot { o in
    EffectOrder.root {
        EffectOrder.view {
            let slot = LetSlot<String> { if fail { throw JSException(value: JSError("let boom")) }; return "ok" }
            slot.store()
            Check({ slot.value }) { reads.append($0) }
            Check({ slot.value }) { reads.append($0) }
        }
        EffectOrder.view {
            let __view = EffectOrder.current
            var shown = false
            Effect {
                if show && !shown {
                    shown = true
                    jsReport {
                        try EffectOrder.embedded(in: __view) {
                            try EmbeddedViews.later { Check({ "branch" }) { ifOrder.append($0) } }
                        }
                    }
                }
            }
            Check({ show ? "sibling" : "off" }) { if $0 == "sibling" { ifOrder.append($0) } }
        }
    }
    return o
}
let errCount = errors.count
reads = []
fail = false
show = true
ifOrder = []
Zone.tick()
Zone.enabled = false
print("errCount:" + String(errCount) + "|recovered:" + reads.joined(separator: ",") + "|ifOrder:" + ifOrder.joined(separator: ","))
root.dispose()
`);
      const errors = swiftc(readdirSync(out).map((f) => join(out, f)), join(dir, 'main'), nativeBuild, '-Onone');
      got = errors ? errors.join('\n').slice(0, 1500) : spawnSync(join(dir, 'main'), [], { encoding: 'utf8' }).stdout.trim();
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, 'F18: @let throw aborts view without NG0314 noise and @if tick update defers after sibling bindings (Swift)');
    if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);

    try {
      const out = join(dir, 'kotlin');
      translateKotlin([file], out, 'org.example.app');
      writeFileSync(join(out, 'Main.kt'), `import org.nativescript.kit.*
fun main() {
    Reactivity.schedule = Reactivity.Schedule.MICROTASK
    Zone.enabled = true
    val errors = mutableListOf<String>()
    jsUncaughtHandler = { err -> errors.add(jsToString(err)) }
    var fail = true
    var show = false
    val reads = mutableListOf<String>()
    val ifOrder = mutableListOf<String>()
    val root = createRoot { o ->
        EffectOrder.root {
            EffectOrder.view {
                val slot = LetSlot { if (fail) throw JSException(JSError("let boom")); "ok" }
                slot.store()
                Check({ slot.value }) { reads.add(it) }
                Check({ slot.value }) { reads.add(it) }
            }
            EffectOrder.view {
                val __view = EffectOrder.current
                var shown = false
                Effect {
                    if (show && !shown) {
                        shown = true
                        EffectOrder.embedded(__view) {
                            EmbeddedViews.later { Check({ "branch" }) { ifOrder.add(it) } }
                        }
                    }
                }
                Check({ if (show) "sibling" else "off" }) { if (it == "sibling") ifOrder.add(it) }
            }
        }
        o
    }
    val errCount = errors.size
    reads.clear()
    fail = false
    show = true
    ifOrder.clear()
    Zone.tick()
    Zone.enabled = false
    println("errCount:" + errCount + "|recovered:" + reads.joinToString(",") + "|ifOrder:" + ifOrder.joinToString(","))
    root.dispose()
}
`);
      const runtime = buildKotlinRuntime(nativeBuild);
      const errors = kotlinc(readdirSync(out).map((f) => join(out, f)), join(dir, 'classes'), [runtime]);
      got = errors ? errors.join('\n').slice(0, 1500) : spawnSync('java', ['-cp', [join(dir, 'classes'), runtime, kotlinStdlib()].join(':'), 'MainKt'], { encoding: 'utf8' }).stdout.trim();
    } catch (e) {
      got = (e as Error).message.split('\n')[0];
    }
    check(got === expected, 'F18: @let throw aborts view without NG0314 noise and @if tick update defers after sibling bindings (Kotlin)');
    if (got !== expected) console.log(`    got: ${got.slice(0, 1500)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- Angular booleanAttribute & numberAttribute (Swift & Kotlin runtime) ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-attrs-'));
  try {
    const expected = 'true,true,false,false,false|42,3.5,99,99,99';
    let swGot = '';
    try {
      const out = join(dir, 'swift-attrs');
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'main.swift'), `import Foundation
import NativeScriptKit
let b = [booleanAttribute(""), booleanAttribute("true"), booleanAttribute("false"), booleanAttribute(nil), booleanAttribute(false)].map(String.init).joined(separator: ",")
let n = [numberAttribute("42", 99), numberAttribute("3.5", 99), numberAttribute("", 99), numberAttribute("abc", 99), numberAttribute(nil, 99)].map { $0 == floor($0) ? String(Int($0)) : String($0) }.joined(separator: ",")
print("\\(b)|\\(n)")
`);
      buildSwiftRuntime(nativeBuild, '-Onone');
      const errors = swiftc(readdirSync(out).map((f) => join(out, f)), join(dir, 'main-attrs'), nativeBuild, '-Onone');
      swGot = errors ? errors.join('\n').slice(0, 800) : spawnSync(join(dir, 'main-attrs'), { encoding: 'utf8' }).stdout.trim();
    } catch (e) { swGot = String(e); }
    check(swGot === expected, `booleanAttribute and numberAttribute match Angular (Swift${swGot === expected ? '' : `: ${swGot}`})`);

    let ktGot = '';
    try {
      const out = join(dir, 'kotlin-attrs');
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'Main.kt'), `import org.nativescript.kit.*
fun main() {
    val b = listOf(booleanAttribute(""), booleanAttribute("true"), booleanAttribute("false"), booleanAttribute(null), booleanAttribute(false)).joinToString(",")
    val n = listOf(numberAttribute("42", 99.0), numberAttribute("3.5", 99.0), numberAttribute("", 99.0), numberAttribute("abc", 99.0), numberAttribute(null, 99.0)).map { if (it == kotlin.math.floor(it)) it.toInt().toString() else it.toString() }.joinToString(",")
    println("$b|$n")
}
`);
      const runtime = buildKotlinRuntime(nativeBuild);
      const errors = kotlinc(readdirSync(out).map((f) => join(out, f)), join(dir, 'classes-attrs'), [runtime]);
      ktGot = errors ? errors.join('\n').slice(0, 800) : spawnSync('java', ['-cp', [join(dir, 'classes-attrs'), runtime, kotlinStdlib()].join(':'), 'MainKt'], { encoding: 'utf8' }).stdout.trim();
    } catch (e) { ktGot = String(e); }
    check(ktGot === expected, `booleanAttribute and numberAttribute match Angular (Kotlin${ktGot === expected ? '' : `: ${ktGot}`})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- Wave 2 Angular AOT: <ng-content>, contentChild/contentChildren, hostDirectives, multi-@Component files (IR + Swift & Kotlin native) ----
(() => {
  const dir = mkdtempSync(join(nativeBuild, 'release-checks-wave2-'));
  try {
    const dirFile = join(dir, 'focusable.directive.ts');
    writeFileSync(dirFile, `import { Directive, EventEmitter, input } from '@angular/core';
@Directive({ standalone: true, host: { role: 'widget', '[attr.data-level]': 'level()' } })
export class Focusable {
  level = input(1);
  pinged = new EventEmitter<string>();
  trigger(msg: string) { this.pinged.emit(msg); }
}
`);
    const togglesFile = join(dir, 'toggles.component.ts');
    writeFileSync(togglesFile, `import { Component, input } from '@angular/core';
const PREFIX = 'tg:';
@Component({ selector: 'my-badge', template: '<Label [text]="full()"></Label>' })
export class MyBadge {
  label = input('b');
  full() { return PREFIX + this.label(); }
}
@Component({ selector: 'my-tag', template: '<Label [text]="name()"></Label>' })
export class MyTag {
  name = input('t');
}
`);
    const cardFile = join(dir, 'card.component.ts');
    writeFileSync(cardFile, `import { Component, contentChild, contentChildren, input } from '@angular/core';
import { Focusable } from './focusable.directive';
import { MyBadge, MyTag } from './toggles.component';
@Component({
  selector: 'my-card',
  hostDirectives: [{ directive: Focusable, inputs: ['level: strength'], outputs: ['pinged: fired'] }],
  template: \`<StackLayout>
    <ng-content select="[hdr]"></ng-content>
    @if (showBody()) { <ng-content></ng-content> }
    <ng-content select="[ftr]"><Label text="default-ftr"></Label></ng-content>
  </StackLayout>\`,
})
export class MyCard {
  showBody = input(true);
  badge = contentChild(MyBadge);
  tags = contentChildren(MyTag);
  summary(): string {
    const b = this.badge();
    return (b ? b.full() : 'none') + '#' + this.tags().map((t) => t.name()).join(',');
  }
}
`);
    const hostFile = join(dir, 'host.component.ts');
    writeFileSync(hostFile, `import { Component, signal, viewChild } from '@angular/core';
import { MyCard } from './card.component';
import { MyBadge, MyTag } from './toggles.component';
@Component({
  selector: 'Host',
  imports: [MyCard, MyBadge, MyTag],
  template: \`<StackLayout>
    <my-card [showBody]="open()" [strength]="7" (fired)="onFired($event)">
      <Label hdr text="HEAD"></Label>
      <Label [text]="bodyText()"></Label>
      <my-badge label="VIP"></my-badge>
      <my-tag name="x"></my-tag>
      <my-tag name="y"></my-tag>
    </my-card>
  </StackLayout>\`,
})
export class Host {
  card = viewChild(MyCard);
  open = signal(true);
  bodyText = signal('BODY1');
  lastFired = '';
  onFired(v: string) { this.lastFired = v; }
  cardSummary(): string { return this.card()?.summary() ?? 'missing'; }
}
`);
    const allSources = [dirFile, togglesFile, cardFile, hostFile];
    const read = (f: string) => readFileSync(f, 'utf8');
    const directives = angularDirectives([dirFile], read);
    check(directives.length === 1 && directives[0].selector === '', 'selectorless @Directive() for hostDirectives parses cleanly');

    const selectors = new Map<string, string>();
    const componentSlots = new Map<string, string[]>();
    const componentContentQueries = new Map<string, { file: string; queries: any[] }>();
    for (const f of allSources) {
      for (const c of componentsOf(f, read(f))) {
        if (c.selector) selectors.set(c.selector, c.name);
        if (c.slots?.length) componentSlots.set(c.name, c.slots);
        if (c.contentQueries?.length) componentContentQueries.set(c.name, { file: f, queries: c.contentQueries });
      }
    }
    check(selectors.get('my-badge') === 'MyBadge' && selectors.get('my-tag') === 'MyTag', 'componentsOf discovers multiple @Component classes in one file');
    check(componentSlots.get('MyCard')?.join(',') === '[hdr],default,[ftr]', 'componentsOf discovers multi-slot <ng-content> selectors');
    check(componentContentQueries.get('MyCard')?.queries.length === 2, 'componentsOf discovers contentChild and contentChildren queries');

    const irs = allSources.flatMap((f) => angularComponents(f, read(f), selectors, { directives, componentSlots, componentContentQueries }));
    check(irs.length === 4 && irs.filter((c) => c.file === togglesFile.replace(/\.ts$/, '.release.ts')).length === 2, 'angularComponents compiles multiple @Component classes in one file into a shared virtual file');
    const cardIr = irs.find((c) => c.name === 'MyCard')!;
    check(cardIr.slots?.length === 3 && cardIr.propAliases?.$hdIn0 === 'strength' && cardIr.outputs?.includes('fired') && cardIr.outputFields?.fired === '$hdOut1', 'hostDirectives exposes aliased inputs & outputs and <ng-content> populates ComponentIR.slots');

    const overrides = new Map<string, string>();
    const dirClean = declarableSource(dirFile, read(dirFile));
    if (dirClean) overrides.set(dirFile, dirClean);
    for (const ir of irs) overrides.set(ir.file, ir.source);
    const programFiles = [dirFile, ...new Set(irs.map((c) => c.file))];

    const buildInfo = (platform: 'ios' | 'android') => {
      const p = createProgram(programFiles, overrides, platform, modulesDir);
      const classOf = (ir: AngularComponent) => p.program.getSourceFile(ir.file)!.statements.find((s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === ir.name)!;
      const infos = new Map(irs.map((ir) => [ir.name, {
        name: ir.name, props: ir.props, optional: ir.optional, outputs: ir.outputs, outputFields: ir.outputFields,
        propAliases: ir.propAliases, setters: ir.setters, changes: ir.changes, onPush: ir.onPush,
        slots: ir.slots, members: componentMembersOf(classOf(ir), p.checker),
      }]));
      return { ...p, classOf, infos };
    };

    const expected = 'role=widget|data-level=7|q1=tg:VIP#x,y|q2=none#|texts=HEAD,BODY1,tg:VIP,x,y,default-ftr|after=HEAD,BODY2,tg:VIP,x,y,default-ftr|closed=HEAD,default-ftr';
    // Swift native execution
    {
      let swGot = '';
      try {
        buildSwiftRuntime(nativeBuild, '-Onone');
        const { program, files: sourceFiles, checker, classOf, infos } = buildInfo('ios');
        const sw = new SwiftTranslator(checker, infos, sourceFiles, { plainFields: true, hooks: angular.swift });
        const out = join(dir, 'swift');
        mkdirSync(out, { recursive: true });
        const modFiles = [...new Set([dirFile, ...irs.map((c) => c.file)])];
        writeFileSync(join(out, 'app.swift'), `import Foundation\nimport NativeScriptKit\n${translateModules(sw, program, modFiles).map((m) => m.code).join('\n')}\n`);
        for (const ir of irs) {
          const cls = classOf(ir);
          writeFileSync(join(out, `${ir.name}.swift`), `import Foundation\nimport NativeScriptKit\nfinal class ${ir.name} {\n${[...sw.componentMembers(cls, ir.props), ...render(ir, infos, (m) => sw.memberThrows(cls, m), angular.behaviour)].join('\n')}\n}\n`);
        }
        writeFileSync(join(out, 'views.swift'), `import NativeScriptKit
class View {
  var attrs: [String: String] = [:]
  var slots: [Any] = []
  init() throws {}
  func kitSet(_ key: String, _ value: Any?) { attrs[key] = value.map { jsToString($0) } ?? "" }
  func kitAddChild(_ view: View) { slots.append(view) }
  func kitAddRegion() -> Region { let r = Region(); slots.append(r); return r }
  func allViews() -> [View] {
    var out: [View] = [self]
    for s in slots {
      if let v = s as? View { out.append(contentsOf: v.allViews()) }
      else if let r = s as? Region { for v in r.allViews() { out.append(contentsOf: v.allViews()) } }
    }
    return out
  }
}
final class Label: View {}
final class StackLayout: View {}
enum RegionPart { case view(View); case region(Region) }
final class Region {
  var parts: [RegionPart] = []
  func attach(_ view: View) { parts.append(.view(view)) }
  func set(parts: [RegionPart]) { self.parts = parts }
  func allViews() -> [View] {
    parts.flatMap { switch $0 { case .view(let v): return [v]; case .region(let r): return r.allViews() } }
  }
}
final class RegionFragment {
  let owner: Region
  var parts: [RegionPart] = []
  init(_ owner: Region) { self.owner = owner }
  func kitAddChild(_ v: View) { parts.append(.view(v)) }
  func kitAddRegion() -> Region { let r = Region(); parts.append(.region(r)); return r }
}
func ChooseFragment(_ region: Region, _ which: @escaping () throws -> Int, site: String = "", render: @escaping (Int) throws -> RegionFragment) {
  var cur: Int? = nil
  var branchOwner: Owner? = nil
  Effect {
    let idx = (try? which()) ?? -1
    if idx == cur { return }
    cur = idx
    untrack {
      branchOwner?.dispose()
      let o = Owner(parent: nil)
      branchOwner = o
      let frag = (try? o.run { try render(idx) }) ?? RegionFragment(region)
      region.set(parts: frag.parts)
    }
  }
}
`);
        writeFileSync(join(out, 'main.swift'), `import Foundation
import NativeScriptKit
Reactivity.schedule = .microtask
let h = AngularView.construct { Host() }
let rootView = try h.render()
let all1 = rootView.allViews()
let cardView = all1.first { $0.attrs["role"] != nil }!
let texts1 = all1.compactMap { ($0 as? Label)?.attrs["text"] }.joined(separator: ",")
let q1 = h.cardSummary()
h.bodyText.value = "BODY2"
Microtasks.checkpoint()
let texts2 = rootView.allViews().compactMap { ($0 as? Label)?.attrs["text"] }.joined(separator: ",")
h.open.value = false
Microtasks.checkpoint()
let q2 = h.cardSummary()
let texts3 = rootView.allViews().compactMap { ($0 as? Label)?.attrs["text"] }.joined(separator: ",")
print("role=\\(cardView.attrs["role"] ?? "")|data-level=\\(cardView.attrs["data-level"] ?? "")|q1=\\(q1)|q2=\\(q2)|texts=\\(texts1)|after=\\(texts2)|closed=\\(texts3)")
`);
        const errors = swiftc(readdirSync(out).map((f) => join(out, f)), join(dir, 'main-wave2'), nativeBuild, '-Onone');
        swGot = errors ? errors.join('\n').slice(0, 1200) : spawnSync(join(dir, 'main-wave2'), { encoding: 'utf8' }).stdout.trim();
      } catch (e) { swGot = String(e); }
      check(swGot === expected, `Wave 2 (<ng-content> multi-slot + fallback + @if, contentChild/Children, hostDirectives, multi-@Component) compiles & runs natively (Swift${swGot === expected ? '' : `: ${swGot}`})`);
    }
    // Kotlin native execution
    {
      let ktGot = '';
      try {
        const { program, files: sourceFiles, checker, classOf, infos } = buildInfo('android');
        const kt = new Translator(checker, infos, sourceFiles, { appModule: 'org.example.wave2', plainFields: true, hooks: angular.kotlin, native: (t) => new AndroidNativeAPI(t, androidClassPath(null, { archives: [], dependencies: [] })) });
        const out = join(dir, 'kotlin');
        mkdirSync(out, { recursive: true });
        const modFiles = [...new Set([dirFile, ...irs.map((c) => c.file)])];
        const head = 'package org.example.wave2\nimport org.nativescript.kit.*\n';
        writeFileSync(join(out, 'App.kt'), head + translateKotlinModules(kt, program, modFiles).map((m) => m.code).join('\n') + '\n');
        for (const ir of irs) {
          const cls = classOf(ir);
          const { params, lines } = kt.componentMembers(cls, ir.props);
          writeFileSync(join(out, `${ir.name}.kt`), `${head}class ${ir.name}(${params.join(', ')}) {\n${[...lines, ...renderKotlin(ir, infos, { behaviour: angular.behaviour })].join('\n')}\n}\n`);
        }
        writeFileSync(join(out, 'Views.kt'), `${head}open class View {
  val attrs = mutableMapOf<String, String>()
  val slots = mutableListOf<Any>()
  fun kitSet(key: String, value: Any?) { attrs[key] = if (value == null) "" else jsToString(value) }
  fun kitAddChild(view: View) { slots.add(view) }
  fun kitAddRegion(): Region { val r = Region(); slots.add(r); return r }
  fun allViews(): List<View> {
    val out = mutableListOf<View>(this)
    for (s in slots) {
      if (s is View) out.addAll(s.allViews())
      else if (s is Region) for (v in s.allViews()) out.addAll(v.allViews())
    }
    return out
  }
}
class Label : View()
class StackLayout : View()
sealed class RegionPart { class Child(val v: View) : RegionPart(); class Nested(val r: Region) : RegionPart() }
class Region {
  private var items: List<RegionPart> = emptyList()
  fun attach(view: View) { items = items + RegionPart.Child(view) }
  fun setParts(p: List<RegionPart>) { items = p }
  fun allViews(): List<View> = items.flatMap { when (it) { is RegionPart.Child -> listOf(it.v); is RegionPart.Nested -> it.r.allViews() } }
}
class RegionFragment(private val owner: Region) {
  val parts = mutableListOf<RegionPart>()
  fun kitAddChild(v: View) { parts.add(RegionPart.Child(v)) }
  fun kitAddRegion(): Region { val r = Region(); parts.add(RegionPart.Nested(r)); return r }
  fun fill() { owner.setParts(parts.toList()) }
}
fun ChooseFragment(region: Region, which: () -> Int, site: String = "", render: (Int) -> RegionFragment) {
  var cur: Int? = null
  var branchOwner: Owner? = null
  Effect {
    val idx = try { which() } catch (_: Throwable) { -1 }
    if (idx == cur) return@Effect
    cur = idx
    untrack {
      branchOwner?.dispose()
      val o = Owner(null)
      branchOwner = o
      val frag = try { o.run { render(idx) } } catch (_: Throwable) { RegionFragment(region) }
      region.setParts(frag.parts.toList())
    }
  }
}
`);
        writeFileSync(join(out, 'Main.kt'), `${head}fun main() {
  Reactivity.schedule = Reactivity.Schedule.MICROTASK
  val h = AngularView.construct { Host() }
  val rootView = h.render()
  val all1 = rootView.allViews()
  val cardView = all1.first { it.attrs.containsKey("role") }
  val texts1 = all1.filterIsInstance<Label>().mapNotNull { it.attrs["text"] }.joinToString(",")
  val q1 = h.cardSummary()
  h.bodyText.value = "BODY2"
  Microtasks.checkpoint()
  val texts2 = rootView.allViews().filterIsInstance<Label>().mapNotNull { it.attrs["text"] }.joinToString(",")
  h.open.value = false
  Microtasks.checkpoint()
  val q2 = h.cardSummary()
  val texts3 = rootView.allViews().filterIsInstance<Label>().mapNotNull { it.attrs["text"] }.joinToString(",")
  println("role=\${cardView.attrs["role"]}|data-level=\${cardView.attrs["data-level"]}|q1=$q1|q2=$q2|texts=$texts1|after=$texts2|closed=$texts3")
}
`);
        const runtime = buildKotlinRuntime(nativeBuild);
        const errors = kotlinc(readdirSync(out).map((f) => join(out, f)), join(dir, 'classes-wave2'), [runtime]);
        ktGot = errors ? errors.join('\n').slice(0, 1200) : spawnSync('java', ['-cp', [join(dir, 'classes-wave2'), runtime, kotlinStdlib()].join(':'), 'org.example.wave2.MainKt'], { encoding: 'utf8' }).stdout.trim();
      } catch (e) { ktGot = String(e); }
      check(ktGot === expected, `Wave 2 (<ng-content> multi-slot + fallback + @if, contentChild/Children, hostDirectives, multi-@Component) compiles & runs natively (Kotlin${ktGot === expected ? '' : `: ${ktGot}`})`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ---- Wave 3: generic 0-param @Directive erasure on Swift, Renderer2/RendererFactory2, @angular/cdk, dynamic import('@angular/compiler') ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-angular-wave3-'));
  try {
    const dirFile = join(dir, 'cell.directive.ts');
    const appFile = join(dir, 'app.ts');
    writeFileSync(
      dirFile,
      `import { Directive } from '@angular/core';
export const registered: CellButton<any>[] = [];
@Directive({ selector: 'button[cellBtn]' })
export class CellButton<T> {
  value!: T;
  constructor() {
    registered.push(this);
  }
}
`,
    );
    writeFileSync(
      appFile,
      `import { inject, Renderer2, RendererFactory2 } from '@angular/core';
import { coerceBooleanProperty } from '@angular/cdk/coercion';
import { Platform } from '@angular/cdk/platform';
import { CellButton, registered } from './cell.directive';

export async function runWave3(): Promise<string> {
  const cell = new CellButton<string>();
  cell.value = 'day-1';
  const rf = inject(RendererFactory2);
  const r2 = rf.createRenderer(null, null);
  const directR2 = inject(Renderer2);
  const plat = inject(Platform);
  const jitRejected = await import('@angular/compiler').then(() => 'loaded', () => 'aot-rejected');
  return [
    String(registered.length),
    String(registered[0].value),
    String(coerceBooleanProperty('true')),
    String(coerceBooleanProperty('false')),
    String(Boolean(r2 && directR2)),
    String(typeof plat.isBrowser === 'boolean'),
    jitRejected,
  ].join('|');
}
`,
    );
    const cleaned = declarableSource(dirFile, readFileSync(dirFile, 'utf8'));
    check(!!cleaned && cleaned.includes('/* @ng-declarable */') && !cleaned.includes('@Directive'), 'declarableSource marks generic 0-param @Directive for Swift erasure');

    const overrides = new Map<string, string>([[dirFile, cleaned!]]);
    const expected = '1|day-1|true|false|true|true|aot-rejected';
    {
      let swGot = '';
      try {
        buildSwiftRuntime(nativeBuild, '-Onone');
        const p = createProgram([dirFile, appFile], overrides, 'ios', modulesDir);
        const sw = new SwiftTranslator(p.checker, new Map(), p.files, { hooks: angular.swift, pluginFiles: new Set(p.pluginFiles) });
        const out = join(dir, 'swift');
        mkdirSync(out, { recursive: true });
        const mods = translateModules(sw, p.program, p.files.map((f) => f.fileName));
        const body = mods.map((m) => sw.interfacesOf(m.file) + m.code).join('\n');
        const swiftShapes = sw.shapesCode();
        writeFileSync(join(out, 'app.swift'), `import Foundation\nimport NativeScriptKit\n${swiftShapes}\n${body}\n`);
        writeFileSync(join(out, 'main.swift'), `import Foundation\nimport NativeScriptKit\n${mods.flatMap((m) => (m.init ? [`${m.initThrows ? 'try ' : ''}${m.init}()`] : [])).join('\n')}\n_ = runWave3().then({ (v: String) -> Any? in print(v); return nil }, { (e: Any?) -> Any? in print("ERR:", e ?? ""); return nil })\nMicrotasks.checkpoint()\n`);
        const errors = swiftc(readdirSync(out).map((f) => join(out, f)), join(dir, 'main-ng-wave3'), nativeBuild, '-Onone');
        swGot = errors ? errors.slice(0, 3).join(' ; ') : spawnSync(join(dir, 'main-ng-wave3'), { encoding: 'utf8' }).stdout.trim();
      } catch (e) { swGot = String(e); }
      check(swGot === expected, `Wave 3 Angular (generic @Directive erasure, Renderer2/RendererFactory2, @angular/cdk, dynamic @angular/compiler rejection) runs natively (Swift${swGot === expected ? '' : `: ${swGot.slice(0, 300)}`})`);
    }
    {
      let ktGot = '';
      try {
        const p = createProgram([dirFile, appFile], overrides, 'android', modulesDir);
        const kt = new Translator(p.checker, new Map(), p.files, { appModule: 'org.example.ngwave3', hooks: angular.kotlin, pluginFiles: new Set(p.pluginFiles), native: (t) => new AndroidNativeAPI(t, androidClassPath(null, { archives: [], dependencies: [] })) });
        const out = join(dir, 'kotlin');
        mkdirSync(out, { recursive: true });
        const head = 'package org.example.ngwave3\nimport org.nativescript.kit.*\n';
        const mods = translateKotlinModules(kt, p.program, p.files.map((f) => f.fileName));
        const ktShapes = kt.shapesCode();
        writeFileSync(join(out, 'App.kt'), head + ktShapes + '\n' + mods.map((m) => kt.interfacesOf(m.file) + m.code).join('\n') + '\n');
        writeFileSync(join(out, 'Main.kt'), `${head}fun main() {\n${mods.flatMap((m) => (m.init ? [`  ${m.init}()`] : [])).join('\n')}\n  runWave3().then({ println(it); null }, { println("ERR: $it"); null })\n  Microtasks.checkpoint()\n}\n`);
        const runtime = buildKotlinRuntime(nativeBuild);
        const errors = kotlinc(readdirSync(out).map((f) => join(out, f)), join(dir, 'classes-ng-wave3'), [runtime]);
        ktGot = errors ? errors.slice(0, 3).join(' ; ') : spawnSync('java', ['-cp', [join(dir, 'classes-ng-wave3'), runtime, kotlinStdlib()].join(':'), 'org.example.ngwave3.MainKt'], { encoding: 'utf8' }).stdout.trim();
      } catch (e) { ktGot = String(e); }
      check(ktGot === expected, `Wave 3 Angular (generic @Directive erasure, Renderer2/RendererFactory2, @angular/cdk, dynamic @angular/compiler rejection) runs natively (Kotlin${ktGot === expected ? '' : `: ${ktGot.slice(0, 300)}`})`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

finish();
