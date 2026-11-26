import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { componentOf, declarablesIn } from './angular.ts';
import type { PluginSources } from '@nstudio/nativescript-compiler/adapter-api';
import { core, ts } from './core-api.ts';

/** The TypeScript of each `<package>/angular` entry the app imports, from the plugin's source beside its main module. */
export function angularLibraries(sources: string[], modulesDir: string, plugins: PluginSources, replaced: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of sources) {
    for (const m of readFileSync(f, 'utf8').matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]((?:@[\w.-]+\/)?[\w.-]+)\/angular['"]/g)) {
      const wanted = m[1].split(',').map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      // A plugin the build stubs has its stand-in's elements, and one the app replaces is the app's module: neither has
      // an Angular wrapper of its own compiled.
      if (seen.has(m[2]) || core.stubbedPlugins.has(m[2]) || replaced.has(m[2])) continue;
      seen.add(m[2]);
      const dir = join(modulesDir, m[2]);
      const main = ['index.ios.js', 'index.js'].map((x) => join(dir, x)).find(existsSync);
      if (!main) continue;
      plugins.get(dir);
      const mainSource = plugins.sourceOf(main);
      const angular = mainSource && join(dirname(mainSource), 'angular');
      // A wrapper written against Angular's view internals (ElementRef, ViewContainerRef) has no components of its own the build reads.
      if (!angular || !existsSync(angular)) continue;
      const components = new Map<string, string>();
      /** The names an NgModule's `declarations`, `imports` and `exports` list: an app importing the module imports those. */
      const modules = new Map<string, string[]>();
      const moduleFiles = new Map<string, string>();
      // A wrapper written against Angular's view internals (ElementRef, ViewContainerRef) is not compiled: a compiled template replaces it.
      const viewInternals = (text: string) => /\b(ViewContainerRef|DetachedContainer)\b/.test(text);
      const walk = (d: string) => {
        for (const x of readdirSync(d)) {
          const p = join(d, x);
          if (statSync(p).isDirectory()) walk(p);
          else if (x.endsWith('.ts') && !x.endsWith('.d.ts') && !x.endsWith('.spec.ts')) {
            const text = readFileSync(p, 'utf8');
            const name = viewInternals(text) ? undefined : componentOf(p, text)?.name;
            if (name) components.set(name, p);
            const found = declarablesIn(p, text);
            for (const d of found.classes) components.set(d, p);
            for (const [m, names] of found.modules) {
              modules.set(m, names);
              if (!viewInternals(text)) moduleFiles.set(m, p);
            }
          }
        }
      };
      walk(angular);
      const listed = (names: string[]): string[] => names.flatMap((n) => (modules.has(n) ? listed(modules.get(n)!.filter((x) => x !== n)) : [n]));
      // The components and pipes the app imports, directly or through an NgModule, and those their `imports` name,
      // transitively, with the modules of their own they import.
      const queue = listed(wanted).filter((w) => components.has(w));
      const taken = new Set<string>();
      const files = [...components.values()];
      const take = (file: string) => {
        out.push(file);
        const text = readFileSync(file, 'utf8');
        const imports = /imports:\s*\[([^\]]*)\]/.exec(text)?.[1] ?? '';
        for (const i of imports.split(',').map((x) => x.trim())) if (components.has(i)) queue.push(i);
        for (const m of text.matchAll(/from\s*['"](\.[^'"]+)['"]/g)) {
          const support = [resolve(dirname(file), m[1]) + '.ts', join(resolve(dirname(file), m[1]), 'index.ts')].find(existsSync);
          if (support && !files.includes(support) && !out.includes(support) && !viewInternals(readFileSync(support, 'utf8'))) out.push(support);
          // A component the code itself uses (a dialog it opens).
          for (const [other, f] of components) if (f === support) queue.push(other);
        }
      };
      const drain = () => {
        while (queue.length) {
          const name = queue.pop()!;
          if (taken.has(name)) continue;
          taken.add(name);
          take(components.get(name)!);
        }
      };
      drain();
      // An entry with components compiled here resolves to its typings unless it is compiled too: the NgModules the app
      // imports from it are, in their own files. Without components the whole entry is compiled as the plugin's source.
      if (!taken.size) continue;
      const imported = new Set<string>();
      const moduleNames = (names: string[]) => names.forEach((n) => { if (modules.has(n) && !imported.has(n)) { imported.add(n); moduleNames(modules.get(n)!); } });
      moduleNames(wanted);
      for (const name of imported) {
        const file = moduleFiles.get(name);
        if (file && !out.includes(file)) take(file);
      }
      drain();
    }
  }
  return out;
}


/** A tag registered for a plugin view: its class, the module it is from, and the `ViewClassMeta` keys it was registered with. */
export interface RegisteredElement {
  name: string;
  from: string;
  /** The keys of the third argument (`insertChild`, `skipAddToDom`…), or null when it is not an object literal the file declares. */
  meta?: string[] | null;
  /** Synthesized TypeScript expression registering a plugin FESM's `insertChild` / `removeChild` meta at startup. */
  metaCode?: string;
  /** True when the registration lives in an app source file whose own `registerElement` call runs at startup. */
  fromApp?: boolean;
}

/** Annotates untyped parameters of JS function/arrow/method expressions inside a node so it compiles in strict TS. */
function typedMetaLiteral(sf: ts.SourceFile, node: ts.Node): string {
  const edits: { at: number; text: string }[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isParameter(n) && !n.type) edits.push({ at: n.name.getEnd(), text: ': any' });
    ts.forEachChild(n, visit);
  };
  visit(node);
  const start = node.getStart(sf);
  let text = node.getText(sf);
  for (const e of edits.sort((a, b) => b.at - a.at)) {
    const pos = e.at - start;
    text = text.slice(0, pos) + e.text + text.slice(pos);
  }
  return text;
}

/** Collects top-level constant and helper function declarations referenced by `obj` (e.g. `MAINCONTENT = 'MainContent'`, `rawChildIndex(...)`). */
function metaLiteralCode(sf: ts.SourceFile, obj: ts.ObjectLiteralExpression): string {
  const decls = new Map<string, { node: ts.Node; code: string }>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) {
      decls.set(st.name.text, { node: st, code: typedMetaLiteral(sf, st) });
    } else if (ts.isVariableStatement(st) && (st.declarationList.flags & ts.NodeFlags.Const)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        if (ts.isStringLiteralLike(d.initializer) || ts.isNumericLiteral(d.initializer) || d.initializer.kind === ts.SyntaxKind.TrueKeyword || d.initializer.kind === ts.SyntaxKind.FalseKeyword) {
          decls.set(d.name.text, { node: d.initializer, code: `const ${d.name.text} = ${d.initializer.getText(sf)};` });
        }
      }
    }
  }
  const used = new Set<string>();
  const scanIds = (n: ts.Node) => {
    if (ts.isIdentifier(n) && decls.has(n.text) && !used.has(n.text) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n) && !(ts.isFunctionDeclaration(n.parent) && n.parent.name === n)) {
      used.add(n.text);
      scanIds(decls.get(n.text)!.node);
    }
    ts.forEachChild(n, scanIds);
  };
  scanIds(obj);
  const body = typedMetaLiteral(sf, obj);
  if (!used.size) return body;
  return `(() => { ${[...used].map((k) => decls.get(k)!.code).join(' ')} return ${body}; })()`;
}

/** Discovers elements registered via a plugin helper module (e.g. `<pkg>/elements.js` + `@CSSType` decorators in `<pkg>/web.js`). */
function scanPluginElementTable(pkg: string, helperSubpath: string, modulesDir: string, metaObj: ts.ObjectLiteralExpression | null, fesmSf: ts.SourceFile, found: Map<string, RegisteredElement>): void {
  const pkgDir = join(modulesDir, pkg);
  const candidates = [join(pkgDir, helperSubpath + '.js'), join(pkgDir, helperSubpath, 'index.js'), join(pkgDir, helperSubpath + '.mjs')];
  const helperFile = candidates.find(existsSync);
  if (!helperFile) return;
  const helperText = readFileSync(helperFile, 'utf8');
  const helperSf = ts.createSourceFile(helperFile, helperText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const helperImports = new Map<string, [string, string]>();
  const namespaceImports: { local: string; spec: string }[] = [];
  for (const st of helperSf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    const from = spec === '.' || spec === './' || spec === './index' ? pkg : spec.startsWith('./') ? `${pkg}/${spec.slice(2).replace(/\.js$/, '')}` : spec;
    const clause = st.importClause;
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        helperImports.set(el.name.text, [(el.propertyName ?? el.name).text, from]);
      }
    } else if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      namespaceImports.push({ local: clause.namedBindings.name.text, spec });
    }
  }
  const seen = new Set<string>();
  const metaCode = metaObj ? metaLiteralCode(fesmSf, metaObj) : undefined;
  const add = (tag: string, name: string, from: string) => {
    const key = tag.toLowerCase();
    if (!key || seen.has(key) || found.has(tag)) return;
    seen.add(key);
    found.set(tag, { name, from, ...(metaObj ? { meta: ['insertChild', 'removeChild'] } : {}), ...(metaCode ? { metaCode } : {}) });
  };
  // Scan namespace-imported modules (e.g. `./web.js`) for `__decorate([CSSType('tag'), ...], Class)` via AST.
  for (const ns of namespaceImports) {
    const nsBase = resolve(dirname(helperFile), ns.spec);
    const nsFile = [nsBase, nsBase + '.js', join(nsBase, 'index.js')].find(existsSync);
    if (!nsFile) continue;
    const nsFrom = ns.spec.startsWith('./') ? `${pkg}/${ns.spec.slice(2).replace(/\.js$/, '')}` : ns.spec;
    const nsSf = ts.createSourceFile(nsFile, readFileSync(nsFile, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const visitNs = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === '__decorate' && n.arguments.length >= 2 && ts.isArrayLiteralExpression(n.arguments[0]) && ts.isIdentifier(n.arguments[1])) {
        const clsName = n.arguments[1].text;
        for (const el of n.arguments[0].elements) {
          if (ts.isCallExpression(el) && ts.isIdentifier(el.expression) && el.expression.text === 'CSSType' && el.arguments.length >= 1 && ts.isStringLiteralLike(el.arguments[0])) {
            add(el.arguments[0].text, clsName, nsFrom);
          }
        }
      }
      ts.forEachChild(n, visitNs);
    };
    visitNs(nsSf);
  }
  // Scan tuple arrays `[['View', View], ['Scroll', Scroll], ...]` inside the helper module.
  const visitTuples = (n: ts.Node) => {
    if (ts.isArrayLiteralExpression(n) && n.elements.length === 2 && ts.isStringLiteralLike(n.elements[0]) && ts.isIdentifier(n.elements[1])) {
      const imp = helperImports.get(n.elements[1].text);
      if (imp) add(n.elements[0].text, imp[0], imp[1]);
    }
    ts.forEachChild(n, visitTuples);
  };
  visitTuples(helperSf);
}

/**
 * Tags registered for plugin views: `registerElement('Tag', () => Class)` or `registerElement('Tag', () => Class, meta)`
 * in the app, and in the Angular entry (`<package>/angular`) of a plugin the app imports, with the module each class is from.
 */
export function registeredElements(sources: string[], modulesDir: string): Map<string, RegisteredElement> {
  const found = new Map<string, RegisteredElement>();
  const scan = (text: string, file: string | null, pluginPkg?: string) => {
    if (!text.includes('registerElement')) return;
    const imports = new Map<string, string>();
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      for (const part of m[1].split(',')) {
        const [orig, alias] = part.trim().split(/\s+as\s+/);
        if (orig) imports.set((alias ?? orig).trim(), JSON.stringify([orig.trim(), m[2]]));
      }
    }
    const sf = ts.createSourceFile(file ?? 'entry.mjs', text, ts.ScriptTarget.Latest, true, file?.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const objectOf = (e: ts.Expression): ts.ObjectLiteralExpression | null => {
      if (ts.isObjectLiteralExpression(e)) return e;
      if (!ts.isIdentifier(e)) return null;
      for (const st of sf.statements) {
        if (!ts.isVariableStatement(st) || !(st.declarationList.flags & ts.NodeFlags.Const)) continue;
        for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === e.text && d.initializer) return objectOf(d.initializer);
      }
      return null;
    };
    const stringArrays = new Map<string, string[]>();
    const stringsOf = (e: ts.Expression): string[] | null => {
      if (ts.isAsExpression(e)) return stringsOf(e.expression);
      if (ts.isIdentifier(e)) return stringArrays.get(e.text) ?? null;
      if (!ts.isArrayLiteralExpression(e)) return null;
      const items: string[] = [];
      for (const el of e.elements) {
        if (ts.isStringLiteralLike(el)) items.push(el.text);
        else if (ts.isSpreadElement(el)) {
          const inner = stringsOf(el.expression);
          if (!inner) return null;
          items.push(...inner);
        } else return null;
      }
      return items;
    };
    for (const st of sf.statements) {
      if (!ts.isVariableStatement(st) || !(st.declarationList.flags & ts.NodeFlags.Const)) continue;
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) {
          const arr = stringsOf(d.initializer);
          if (arr) stringArrays.set(d.name.text, arr);
        }
      }
    }
    const localBaseClass = (name: string, scope: ts.Node): string | undefined => {
      for (let cur: ts.Node | undefined = scope; cur; cur = cur.parent) {
        if (ts.isBlock(cur) || ts.isSourceFile(cur)) {
          for (const st of cur.statements) {
            if (ts.isClassDeclaration(st) && st.name?.text === name) {
              const ext = st.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
              if (ext && ts.isIdentifier(ext)) return ext.text;
            }
          }
        }
      }
      return undefined;
    };
    const record = (tagText: string, clsId: string, meta: ts.Expression | undefined, scope: ts.Node) => {
      const imported = imports.get(clsId) ?? (localBaseClass(clsId, scope) ? imports.get(localBaseClass(clsId, scope)!) : undefined);
      if (!imported) return;
      const [name, from] = JSON.parse(imported) as [string, string];
      // Core's own views are elements already.
      if (from === '@nativescript/core' || core.stubbedPlugins.has(core.packageOf(from))) return;
      const object = meta ? objectOf(meta) : null;
      const keys = object && object.properties.every((p) => p.name && !ts.isComputedPropertyName(p.name))
        ? object.properties.flatMap((p) => {
            const key = p.name!.getText().replace(/^['"]|['"]$/g, '');
            // `skipAddToDom: false` explicitly opts in to the visual tree (e.g. MasonKit's `masonMeta`).
            if (key === 'skipAddToDom' && ts.isPropertyAssignment(p) && p.initializer.kind === ts.SyntaxKind.FalseKeyword) return [];
            return [key];
          })
        : null;
      const hasChildHooks = !!keys && keys.some((k) => k === 'insertChild' || k === 'removeChild');
      const metaCode = !file && object && hasChildHooks ? metaLiteralCode(sf, object) : undefined;
      found.set(tagText, {
        name,
        from: from.startsWith('.') && file ? resolve(dirname(file), from) : from,
        ...(meta ? { meta: keys } : {}),
        ...(metaCode ? { metaCode } : {}),
        ...(file ? { fromApp: true } : {}),
      });
    };
    const loopTags = new Map<string, string[]>();
    const visit = (n: ts.Node) => {
      if (ts.isForOfStatement(n)) {
        const decl = ts.isVariableDeclarationList(n.initializer) ? n.initializer.declarations[0] : undefined;
        if (decl && ts.isIdentifier(decl.name)) {
          const tags = stringsOf(n.expression);
          if (tags) {
            loopTags.set(decl.name.text, tags);
            ts.forEachChild(n.statement, visit);
            loopTags.delete(decl.name.text);
            return;
          }
        }
        // Plugin FESM loop over an imported element-table helper (`for (const { tag, ctor } of getMasonKitElements(...))`).
        if (!file && pluginPkg && ts.isCallExpression(n.expression) && ts.isIdentifier(n.expression.expression)) {
          const imp = imports.get(n.expression.expression.text);
          if (imp) {
            const [, helperFrom] = JSON.parse(imp) as [string, string];
            if (helperFrom.startsWith(pluginPkg + '/')) {
              const metaIdent = /\bregisterElement\([^,]+,\s*[^,]+,\s*[^?]*\?\s*(\w+)/.exec(n.statement.getText(sf))?.[1];
              const metaObj = metaIdent ? objectOf(ts.factory.createIdentifier(metaIdent)) : null;
              scanPluginElementTable(pluginPkg, helperFrom.slice(pluginPkg.length + 1), modulesDir, metaObj, sf, found);
            }
          }
        }
      }
      ts.forEachChild(n, visit);
      if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression) || n.expression.text !== 'registerElement') return;
      const [tag, resolver, meta] = n.arguments;
      if (!tag || !resolver || !ts.isArrowFunction(resolver) || resolver.parameters.length || !ts.isIdentifier(resolver.body)) return;
      if (ts.isStringLiteralLike(tag)) {
        record(tag.text, resolver.body.text, meta, n);
      } else if (ts.isIdentifier(tag) && loopTags.has(tag.text)) {
        for (const t of loopTags.get(tag.text)!) record(t, resolver.body.text, meta, n);
      }
    };
    visit(sf);
  };
  for (const f of sources) {
    const text = readFileSync(f, 'utf8');
    scan(text, f);
    for (const m of text.matchAll(/from\s*['"]((?:@[\w.-]+\/)?[\w.-]+)\/angular['"]/g)) {
      if (core.stubbedPlugins.has(m[1])) continue;
      const dir = join(modulesDir, m[1], 'angular');
      const entry = existsSync(dir) ? readdirSync(dir).flatMap((d) => (/^fesm/.test(d) ? readdirSync(join(dir, d)).filter((x) => x.endsWith('.mjs')).map((x) => join(dir, d, x)) : [])).sort().reverse()[0] : undefined;
      if (entry) scan(readFileSync(entry, 'utf8'), null, m[1]);
    }
  }
  return found;
}
