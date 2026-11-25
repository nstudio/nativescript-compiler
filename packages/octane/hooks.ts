// What the translators do for Octane: `renderNativeScriptApp` mounting a root component, and `useSyncExternalStore`.
import type { KotlinTranslatorView, SwiftTranslatorView, TranslatorHooks, TranslatorView } from '@nstudio/nativescript-compiler/adapter-api';
import { core, ts } from './core-api.ts';

const OCTANE = /[\\/]@nativescript-community[\\/]octane[\\/]/;
const STORE = /[\\/](octane|@nativescript-community[\\/]octane)[\\/]/;

/** `renderNativeScriptApp(host, Component, props)`: the component rendered into the host as Octane's root, its props' arguments in order. */
function rootArgs(t: TranslatorView, e: ts.CallExpression, arg: (prop: string, value: ts.Expression) => string): { name: string; args: string[]; render: string } {
  const [, component, props] = e.arguments;
  const name = component && ts.isIdentifier(component) ? component.text : '';
  const info = t.components.get(name);
  if (!info) throw t.error(e, `rendering ${component?.getText() ?? 'nothing'}: not a component`);
  if (props && !ts.isObjectLiteralExpression(props)) throw t.error(props, 'root props other than an object literal');
  const given = new Map<string, ts.Expression>();
  for (const p of (props as ts.ObjectLiteralExpression | undefined)?.properties ?? []) {
    if (ts.isPropertyAssignment(p)) given.set(p.name.getText(), p.initializer);
    else if (ts.isShorthandPropertyAssignment(p)) given.set(p.name.text, p.name);
    else throw t.error(p, 'a root prop');
  }
  const args = info.props.flatMap((p) => {
    const v = given.get(p);
    if (!v) {
      if (info.optional?.includes(p)) return [];
      throw t.error(e, `rendering ${name} without its prop ${p}`);
    }
    return [arg(p, v)];
  });
  return { name, args, render: info.members.render };
}

const declFile = (decl: ts.Declaration | undefined) => decl?.getSourceFile().fileName ?? '';

export const swiftHooks: TranslatorHooks<SwiftTranslatorView> = {
  globalCall(t, name, e, decl) {
    if (name === 'renderNativeScriptApp' && OCTANE.test(declFile(decl))) {
      const root = rootArgs(t, e, (p, v) => `${core.swift.ident(p)}: ${t.coerce(v, t.typeOf(v))}`);
      return `OctaneRoot(host: ${t.expr(e.arguments[0])}) { ${root.name}(${root.args.join(', ')}).${root.render}() }`;
    }
    if (name === 'useSyncExternalStore' && STORE.test(declFile(decl))) {
      // One subscription per call site: its listener bumps a version every reader tracks, then the snapshot is read.
      const [subscribe, snapshot] = e.arguments;
      const site = `${e.getSourceFile().fileName}:${e.getStart()}`;
      const type = t.typeOf(e);
      const subscribeType = t.typeOf(subscribe);
      let bare: ts.Expression = snapshot;
      while (ts.isParenthesizedExpression(bare)) bare = bare.expression;
      // A function declaration or literal that does not throw reads without `try`; a variable holding a function has Swift's throwing function type.
      const declared = t.resolve(bare)?.declarations?.find((d) => ts.isFunctionDeclaration(d) && !!d.body);
      const read = ts.isArrowFunction(bare) || ts.isFunctionExpression(bare) ? bare : declared;
      const snap = read && !t.throwsInfo.fn(read) ? `{ () -> ${type} in ${t.expr(snapshot)}() }`
        : `{ () throws -> ${type} in try ${t.expr(snapshot)}() }`;
      return `jsExternalStore(${core.swift.string(site)}, subscribe: ${t.convert(t.coerce(subscribe, subscribeType), subscribeType, 'Any?')}, snapshot: ${snap})`;
    }
    return undefined;
  },
};

export const kotlinHooks: TranslatorHooks<KotlinTranslatorView> = {
  globalCall(t, name, e, decl) {
    if (name === 'renderNativeScriptApp' && OCTANE.test(declFile(decl))) {
      const root = rootArgs(t, e, (p, v) => `${core.kotlin.ident(p)} = ${t.coerce(v, t.typeOf(v))}`);
      return `OctaneRoot(${t.expr(e.arguments[0])}) { ${root.name}(${root.args.join(', ')}).${root.render}() }`;
    }
    if (name === 'useSyncExternalStore' && STORE.test(declFile(decl))) {
      // One subscription per call site: its listener bumps a version every reader tracks, then the snapshot is read.
      const [subscribe, snapshot] = e.arguments;
      const site = `${e.getSourceFile().fileName}:${e.getStart()}`;
      const bare = (x: ts.Expression) => { while (ts.isParenthesizedExpression(x)) x = x.expression; return x; };
      const read = t.functionValue(bare(snapshot));
      return `jsExternalStore(${core.kotlin.string(site)}, ${t.functionValue(bare(subscribe))}) { ${read.startsWith('::') ? read.slice(2) : `(${read})`}() }`;
    }
    return undefined;
  },
};
