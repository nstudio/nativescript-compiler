import { dirname, join, resolve } from 'node:path';
import { ts } from './core-api.ts';
import type { ComponentIR, EntryContext } from '@nstudio/nativescript-compiler/adapter-api';
import type { RouteNode } from './angular.ts';

/** A route tree as the Swift kit's `RouteConfig`s. */
export function swiftRouteConfig(routes: RouteNode[], indent: string, ctx: EntryContext): string {
  const one = (r: RouteNode): string => {
    const named = [
      r.outlet ? `outlet: ${JSON.stringify(r.outlet)}` : '',
      r.redirectTo !== undefined ? `redirectTo: ${JSON.stringify(r.redirectTo)}` : '',
      r.full ? 'full: true' : '',
      r.emptyOutlet ? 'emptyOutlet: true' : '',
      r.guards !== undefined ? `guards: ${r.guards}` : '',
      r.data ? `data: [${r.data.map(([k, v]) => `(${ctx.string(k)}, ${v === null ? 'jsNull' : typeof v === 'string' ? ctx.string(v) : typeof v === 'number' ? `Double(${Object.is(v, -0) ? '-0.0' : v})` : v})`).join(', ')}]` : '',
      r.children?.length ? `children: ${swiftRouteConfig(r.children, indent + '    ', ctx)}` : '',
    ].filter(Boolean);
    // canDeactivate guards take the component: the router keeps the instance it renders.
    const made = r.component ? `AngularView.construct { ${ctx.components.get(r.component)?.initThrows ? 'try ' : ''}${ctx.className(r.component)}() }` : '';
    const make = r.deactivate ? `Router.shared.activating(${made})` : made;
    return `RouteConfig(${[JSON.stringify(r.path), ...named].join(', ')})${r.component ? ` { ${ctx.rootView(r.component, `try ${make}.${ctx.components.get(r.component)!.members.render}()`)} }` : ''}`;
  };
  return `[\n${routes.map((r) => `${indent}    ${one(r)}`).join(',\n')}\n${indent}]`;
}

const kotlinDouble = (n: number) => (Object.is(n, -0) ? '-0.0' : /[.e]/.test(String(n)) ? String(n) : `${n}.0`);

/** A route tree as the generated Android kit's `RouteConfig`s. */
export function kotlinRouteConfig(routes: RouteNode[], indent: string, ctx: EntryContext): string {
  const one = (r: RouteNode): string => {
    const named = [
      r.outlet ? `outlet = ${ctx.string(r.outlet)}` : '',
      r.redirectTo !== undefined ? `redirectTo = ${ctx.string(r.redirectTo)}` : '',
      r.full ? 'full = true' : '',
      r.guards !== undefined ? `guards = ${r.guards}` : '',
      r.data ? `data = listOf(${r.data.map(([k, v]) => `${ctx.string(k)} to ${v === null ? 'jsNull' : typeof v === 'string' ? ctx.string(v) : typeof v === 'number' ? kotlinDouble(v) : v}`).join(', ')})` : '',
      r.children?.length ? `children = ${kotlinRouteConfig(r.children, indent + '    ', ctx)}` : '',
    ].filter(Boolean);
    // canDeactivate guards take the component: the router keeps the instance it renders.
    const made = r.component ? `AngularView.construct { ${r.component}() }` : '';
    const make = r.deactivate ? `Router.shared.activating(${made})` : made;
    return `RouteConfig(${[ctx.string(r.path), ...named].join(', ')})${r.component ? ` { ${ctx.rootView(r.component, `${make}.${ctx.components.get(r.component)!.members.render}()`)} }` : ''}`;
  };
  return `listOf(\n${routes.map((r) => `${indent}    ${one(r)}`).join(',\n')}\n${indent})`;
}

/** The Angular entry without the call that bootstraps the app, or null when that is all it does. */
export function angularEntryModule(
  file: string,
  text: string,
  routeFiles: ReadonlySet<string>,
  components: ComponentIR[],
  aliased: (spec: string) => string | undefined,
): string | null {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const isBootstrap = (st: ts.Statement) => ts.isExpressionStatement(st) && ts.isCallExpression(st.expression)
    && /^(runNativeScriptAngularApp|platformNativeScript|platformNativeScriptDynamic|bootstrapApplication)\b/.test(st.expression.expression.getText());
  const isBuiltinProviderCall = (e: ts.Expression): boolean => {
    if (!ts.isCallExpression(e)) return false;
    const fn = e.expression.getText();
    if (/^(provideNativeScriptRouter|provideRouter|provideZoneChangeDetection|provideZonelessChangeDetection|provideExperimentalZonelessChangeDetection|provideNativeScriptNgZone)$/.test(fn)) return true;
    if (/^(provideNativeScriptHttpClient|provideHttpClient)$/.test(fn) && e.arguments.every((a) => ts.isCallExpression(a) && /^(withInterceptorsFromDi|withFetch|withJsonpSupport|withNoXsrfProtection)$/.test(a.expression.getText()))) return true;
    return false;
  };
  let hasCustomProviders = false;
  const blankRanges: [number, number][] = [];
  const nullFirstArgRanges: [number, number][] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const fn = n.expression.getText();
      if (fn === 'bootstrapApplication') {
        if (n.arguments[0]) {
          nullFirstArgRanges.push([n.arguments[0].getStart(), n.arguments[0].getEnd()]);
        }
        const cfg = n.arguments[1];
        if (cfg) {
          if (ts.isObjectLiteralExpression(cfg)) {
            for (const prop of cfg.properties) {
              if (ts.isPropertyAssignment(prop) && prop.name.getText() === 'providers' && ts.isArrayLiteralExpression(prop.initializer)) {
                if (prop.initializer.elements.some((el) => !isBuiltinProviderCall(el))) {
                  hasCustomProviders = true;
                }
              }
            }
          } else {
            hasCustomProviders = true;
          }
        }
      } else if (fn === 'provideNativeScriptRouter' || fn === 'provideRouter') {
        if (n.arguments.length) {
          blankRanges.push([n.arguments[0].getStart(), n.arguments[n.arguments.length - 1].getEnd()]);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const rest = sf.statements.filter((st) => !ts.isImportDeclaration(st) && !isBootstrap(st));
  if (!rest.length && !hasCustomProviders) return null;
  const componentFiles = new Set(components.map((c) => c.file.replace(/\.release\.ts$/, '.ts')));
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      const base = aliased(spec) ?? (spec.startsWith('.') ? resolve(dirname(file), spec) : undefined);
      if (base) {
        const candidates = [base, base + '.ts', join(base, 'index.ts')];
        if (candidates.some((c) => routeFiles.has(c) || componentFiles.has(c))) {
          blankRanges.push([st.getStart(), st.getEnd()]);
        }
      }
    } else if (isBootstrap(st) && !hasCustomProviders) {
      blankRanges.push([st.getStart(), st.getEnd()]);
    }
  }
  let out = text;
  for (const [s, e] of nullFirstArgRanges) {
    const len = e - s;
    const rep = (len >= 4 ? 'null' : '0').padEnd(len, ' ');
    out = out.slice(0, s) + rep + out.slice(e);
  }
  for (const [s, e] of blankRanges) {
    out = out.slice(0, s) + out.slice(s, e).replace(/[^\n]/g, ' ') + out.slice(e);
  }
  return out;
}
