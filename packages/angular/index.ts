import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreApi, FrameworkAdapter, TemplateBehaviour } from '@nstudio/nativescript-compiler/adapter-api';
import { angularComponent, angularDirectives, angularPipes, angularRoutes, angularRouteTree, componentOf, declarableSource, declarablesIn, hostedComponent, routedComponents, selectorElements, type HostedComponent } from './angular.ts';
import { angularLibraries, registeredElements } from './angular-libraries.ts';
import { refuseBaseUses } from './component-bases.ts';
import { useCore } from './core-api.ts';
import { angularEntryModule, kotlinRouteConfig, swiftRouteConfig } from './entry.ts';
import { modules } from './modules.ts';
import { PACKAGE, RUNTIME } from './package.ts';
import { refusals } from './refusals.ts';
import { kotlinHooks } from './kotlin.ts';
import { swiftHooks } from './swift.ts';

/** @angular/common's pipes, NgClass, NgStyle and QueryList as TypeScript the app's components compile with. */
const COMMON = join(RUNTIME, 'angular.ts');
/** The build's own module of `COMMON`, in the app's folder: the components import it by a relative path. */
const COMMON_MODULE = '__angular.release.ts';

/**
 * Angular makes a view in two passes (`passes`), a child component made without its inputs and then given them, appends
 * each view as it is created, runs a template's bindings once its views are built, and re-reads every binding when change detection checks its view
 * (`Check`); an OnPush component is checked only once marked dirty (`check+onPush`). A listener marks its view and the views above it dirty (`markViewDirty`). Views and
 * embedded views order effects, an embedded view refreshed after its declaring view's bindings (`EmbeddedViews`); `ngDoCheck` runs on every
 * check of the view its component or directive is in (`EveryCheck`), `ngAfterContentChecked` and `ngAfterViewChecked`
 * at their points of it (`ContentChecked`, `ViewChecked`); a `@let` is read once per check into its slot (`LetSlot`);
 * `@for` rows read their item and index as signals.
 */
const behaviour: TemplateBehaviour = {
  schedule: 'task', eventScope: 'event+dirtyView', propsOrder: 'pre', deferBindings: true, insertion: 'created', listenersAfterBindings: false,
  effectScope: 'view', checkEveryBinding: 'check+onPush', slots: false, rowSignals: 'array', fragments: true, inputsAfterConstruction: true, passes: true,
  kit: {
    scope: { template: 'EffectOrder.view', region: 'EffectOrder.embedded' },
    currentView: 'EffectOrder.current.view',
    check: 'Check',
    inputChanged: 'Zone.inputChanged',
    directiveHost: 'ElementRef.hosting',
    routerOutlet: { call: 'Router.shared.outlet', primary: 'primary' },
    embedded: { collect: 'EmbeddedViews.collect', later: 'EmbeddedViews.later' },
    everyCheck: { check: 'EveryCheck', content: 'ContentChecked', view: 'ViewChecked' },
    letSlot: 'LetSlot',
    construct: 'AngularView.construct',
    flushEffects: 'Zone.flushEffects',
    rootScope: 'EffectOrder.root',
  },
};

export default function adapter(core: CoreApi): FrameworkAdapter {
  useCore(core);
  return {
    apiVersion: 1,
    name: 'angular',
    packages: ['@nativescript/angular', '@angular/*'],
    behaviour,
    reach: 'entry',
    swift: swiftHooks,
    kotlin: kotlinHooks,
    modules,
    runtimeRoots: [RUNTIME],
    runtimeModules: [COMMON_MODULE],
    package: PACKAGE,
    kit: { apple: 'kit-apple', android: 'kit-android/main', androidGenerated: 'kit-android/fromcore' },
    refusals,
    frontEnd(app) {
      const read = (f: string) => readFileSync(f, 'utf8');
      const { sources, entry, entryText, appDir, platform } = app;
      // The Angular components of plugins the app imports (`<package>/angular`), compiled from their source with the app's.
      const libraries = angularLibraries(sources, app.nodeModules, app.plugins, app.replacedPackages);
      sources.push(...libraries);
      const selectors = new Map<string, string>();
      const hosts: HostedComponent[] = [];
      for (const f of sources) {
        const text = read(f);
        const c = componentOf(f, text);
        for (const tag of c?.selector ? selectorElements(c.selector) : []) selectors.set(tag, c!.name);
        const hosted = c ? hostedComponent(f, text) : null;
        if (hosted) hosts.push(hosted);
      }
      // The configuration the entry provides, lazy routes followed into their files; else one routes file read flat.
      const tree = angularRouteTree(entry, read, app.aliased);
      const routesFile = tree ? undefined : sources.find((f) => /Routes\b/.test(read(f)) && /component:/.test(read(f)));
      const { routes, initial } = routesFile ? angularRoutes(read(routesFile), routesFile) : { routes: [], initial: '/' };
      const routeFiles = new Set([...(tree?.files ?? []), ...(routesFile ? [routesFile] : [])]);
      // Tags the entry registers too (`registerElement('Glass', …)` in main.ts, before the app bootstraps).
      const elements = registeredElements([...(entry && !sources.includes(entry) ? [entry] : []), ...sources], app.nodeModules);
      // Angular 22 checks with zone.js only when the app provides it (`provideZoneChangeDetection`, or @nativescript/angular's
      // `provideNativeScriptNgZone`, which is `_internalProvideZoneChangeDetection` with its own NgZone) and not `provideZonelessChangeDetection`.
      const texts = [entryText, ...sources.map(read)];
      const zone = texts.some((t) => /\bprovide(ZoneChangeDetection|NativeScriptNgZone)\(/.test(t)) && !texts.some((t) => /\bprovideZonelessChangeDetection\(/.test(t));
      // The pipes templates name: the app's and its libraries' `@Pipe` classes, and @angular/common's, in the build's Angular runtime module.
      const pipes = angularPipes(sources, read);
      // The app's own directives: a library's are written against the view internals a compiled template replaces.
      const directives = angularDirectives(sources.filter((f) => !libraries.includes(f)), read);
      // What each NgModule declares, imports and exports: a component's directives are those in its scope.
      const ngModuleNames = new Map(sources.flatMap((f) => [...declarablesIn(f, read(f), !libraries.includes(f)).modules]));
      const runtimeModule = join(appDir, COMMON_MODULE);
      refuseBaseUses(sources);
      const components = sources.map((f) => angularComponent(f, read(f), selectors, { platform, pipes, runtimeModule, directives, ngModules: ngModuleNames, hosts, elements: new Map([...elements].map(([tag, e]) => [tag, e.name])), elementMeta: new Map([...elements].flatMap(([tag, e]) => (e.meta === undefined ? [] : [[tag, e.meta] as const]))) })).filter((c): c is NonNullable<typeof c> => !!c);
      const routed = new Set(tree ? routedComponents(tree.routes) : routes.map((r) => r.component));
      for (const c of components) c.page = routed.has(c.name);
      const overrides = new Map<string, string>();
      // The classes of registered tags, imported where the build can reach them: route files, which only configure, are not compiled.
      if (elements.size) {
        const file = join(appDir, '__elements.release.ts');
        const specs = [...elements.values()];
        overrides.set(file, specs.map((e) => `import { ${e.name} } from '${e.from}';`).join('\n') + `\nexport function $elements(): any[] { return [${specs.map((e) => `new ${e.name}()`).join(', ')}]; }\n`);
      }
      const modules = [...sources.filter((f) => !routeFiles.has(f) && !components.some((c) => c.file === f.replace(/\.ts$/, '.release.ts'))), ...(elements.size ? [join(appDir, '__elements.release.ts')] : [])];
      // Route files only configure and are not compiled; their guards are, each file's in a module of its own.
      (tree?.guards ?? []).forEach((g, i) => {
        const file = join(appDir, `__routes${i}.release.ts`);
        overrides.set(file, g.source(appDir, platform));
        modules.push(file);
      });
      if (components.some((c) => 'usesRuntime' in c && c.usesRuntime)) {
        overrides.set(runtimeModule, read(COMMON));
        modules.push(runtimeModule);
      }
      // `@Pipe` and `@Directive` classes without their decorators, made through the `$create` that injects their constructor's parameters.
      for (const f of modules) {
        if (overrides.has(f)) continue;
        const declarable = declarableSource(f, read(f));
        if (declarable) overrides.set(f, declarable);
      }
      // The entry's own statements (an app delegate, a keyboard setup) run after the modules it imports, the bootstrap call aside.
      const entryModule = angularEntryModule(entry, entryText, routeFiles, components, app.aliased);
      if (entryModule) {
        overrides.set(entry, entryModule);
        modules.push(entry);
      }
      let root = /bootstrapApplication\(\s*(\w+)/.exec(entryText)?.[1] ?? '';
      const appModule = /bootstrapModule\(\s*(\w+)/.exec(entryText)?.[1];
      if (!root && appModule) {
        const declaring = sources.map(read).find((t) => new RegExp(`class\\s+${appModule}\\b`).test(t));
        root = (declaring && /bootstrap:\s*\[\s*(\w+)/.exec(declaring)?.[1]) ?? '';
      }
      if (!root) throw new Error(`${entry}: no bootstrapApplication(Component) or bootstrapModule(AppModule) with a bootstrap component`);
      const zoneEnabled = zone ? '        Zone.enabled = true\n' : '';
      return {
        components,
        modules,
        overrides,
        root,
        behaviour,
        elementClasses: new Set([...elements.values()].map((e) => e.name)),
        entry: {
          swift: (ctx) => ({
            setup: zoneEnabled,
            beforeRoot: tree
              ? `        Router.shared.config = ${swiftRouteConfig(tree.routes, '        ', ctx)}\n`
              : `        Router.shared.routes = [${routes.map((r) => `Route(${JSON.stringify(r.path)}) { ${ctx.rootView(r.component, `try AngularView.construct { ${ctx.components.get(r.component)?.initThrows ? 'try ' : ''}${ctx.className(r.component)}() }.${ctx.components.get(r.component)!.members.render}()`)} }`).join(', ')}]\n        Router.shared.initial = ${JSON.stringify(initial)}\n`,
          }),
          kotlin: (ctx) => ({
            setup: zoneEnabled,
            beforeRoot: tree
              ? `        Router.shared.config = ${kotlinRouteConfig(tree.routes, '        ', ctx)}\n`
              : `        Router.shared.routes = listOf(${routes.map((r) => `Route(${ctx.string(r.path)}) { ${ctx.rootView(r.component, `AngularView.construct { ${r.component}() }.${ctx.components.get(r.component)!.members.render}()`)} }`).join(', ')})\n        Router.shared.initial = ${ctx.string(initial)}\n`,
          }),
        },
      };
    },
  };
}
