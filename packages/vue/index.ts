import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { CoreApi, FrameworkAdapter } from '@nstudio/nativescript-compiler/adapter-api';
import { ts, useCore } from './core-api.ts';
import { kotlinHooks, swiftHooks } from './hooks.ts';
import { modules } from './modules.ts';
import { vueComponent } from './vue.ts';

/** Extracts top-level startup statements from `app.ts` outside `createApp(...).start()`, or `null` when there are none. */
function vueEntryStartup(entry: string, entryText: string, rootImport: string): string | null {
  const sf = ts.createSourceFile(entry, entryText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const appVars = new Set<string>();
  const isCreateApp = (n: ts.Expression): boolean => {
    let cur = n;
    while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    if (ts.isCallExpression(cur)) {
      if (ts.isIdentifier(cur.expression) && cur.expression.text === 'createApp') return true;
      if (ts.isPropertyAccessExpression(cur.expression)) return isCreateApp(cur.expression.expression);
    }
    return false;
  };
  const isAppChain = (n: ts.Expression): boolean => {
    let cur = n;
    while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    if (ts.isIdentifier(cur)) return appVars.has(cur.text);
    if (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) return isAppChain(cur.expression.expression);
    return false;
  };
  const imports: string[] = [];
  const body: string[] = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const spec = ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : '';
      if (spec.endsWith('.vue') && st.importClause?.name?.text === rootImport) continue;
      if (spec === 'nativescript-vue' || spec === 'vue') {
        const nb = st.importClause?.namedBindings;
        if (nb && ts.isNamedImports(nb)) {
          const kept = nb.elements.filter((e) => e.name.text !== 'createApp').map((e) => e.getText(sf));
          if (kept.length) imports.push(`import { ${kept.join(', ')} } from '${spec}';`);
        }
        continue;
      }
      imports.push(st.getText(sf));
      continue;
    }
    if (ts.isVariableStatement(st)) {
      const kept = st.declarationList.declarations.filter((d) => {
        if (ts.isIdentifier(d.name) && d.initializer && isCreateApp(d.initializer)) {
          appVars.add(d.name.text);
          return false;
        }
        return true;
      });
      if (!kept.length) continue;
      if (kept.length === st.declarationList.declarations.length) {
        body.push(st.getText(sf));
        continue;
      }
    }
    if (ts.isExpressionStatement(st) && (isCreateApp(st.expression) || isAppChain(st.expression))) continue;
    body.push(st.getText(sf));
  }
  if (!body.length) return null;
  return [...imports, '', ...body, ''].join('\n');
}

export default function adapter(core: CoreApi): FrameworkAdapter {
  useCore(core);
  return {
    apiVersion: 1,
    name: 'vue',
    packages: ['nativescript-vue', 'vue'],
    behaviour: { schedule: 'microtask', eventScope: 'none', propsOrder: 'post', deferBindings: false, insertion: 'built', listenersAfterBindings: false, effectScope: 'component', checkEveryBinding: 'off', slots: false, rowSignals: 'array', fragments: false, kit: { scope: { template: 'EffectOrder.component' } } },
    reach: 'project',
    swift: swiftHooks,
    kotlin: kotlinHooks,
    modules,
    frontEnd(app) {
      const components = app.files.filter((f) => f.endsWith('.vue')).map((f) => vueComponent(f, readFileSync(f, 'utf8')));
      const rootImport = /createApp\(\s*(\w+)\s*\)/.exec(app.entryText)?.[1];
      const rootFile = rootImport && new RegExp(`import\\s+${rootImport}\\s+from\\s+['"]([^'"]+)['"]`).exec(app.entryText)?.[1];
      if (!rootFile) throw new Error(`${app.entry}: no createApp(Component)`);
      const startup = vueEntryStartup(app.entry, app.entryText, rootImport);
      const overrides = new Map<string, string>();
      const outModules = [...app.sources];
      if (startup) {
        const entryModule = join(app.appDir, '__vue_entry.release.ts');
        overrides.set(entryModule, startup);
        outModules.push(entryModule);
      }
      return { components, modules: outModules, ...(overrides.size ? { overrides } : {}), root: basename(rootFile, '.vue') };
    },
  };
}
