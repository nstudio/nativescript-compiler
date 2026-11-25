// What the translators do for Svelte: its stores, `get(store)`, `tick()`, and svelte-native's `navigate({ page })`.
import { ts } from './core-api.ts';
import type { FrameworkModel, KotlinTranslatorView, SwiftTranslatorView, TranslatorHooks, TranslatorView } from '@nstudio/nativescript-compiler/adapter-api';

const model: FrameworkModel = {
  signalTypes: { Writable: 'store' },
  signalConstructors: { writable: 'always-changed' },
  pure: ['writable'],
  throwsModel: { rethrowing: ['Writable.update'] },
};

function globalCall(t: TranslatorView, name: string, e: ts.CallExpression, _decl: ts.Declaration | undefined, lib: boolean): string | undefined {
  const first = e.arguments[0];
  if (name === 'get' && e.arguments.length === 1 && t.symbolName(first) === 'Writable') return `${t.expr(first)}.value`;
  if (name === 'navigate' && first && ts.isObjectLiteralExpression(first)) {
    const page = first.properties.find((p) => p.name && (p.name as ts.Identifier).text === 'page');
    return t.navigate(e, ((page as ts.PropertyAssignment).initializer as ts.Identifier).text, first);
  }
  if (name === 'tick' && !e.arguments.length && lib) return 'Reactivity.tick()';
  return undefined;
}

export const swiftHooks: TranslatorHooks<SwiftTranslatorView> = { ...model, globalCall };
export const kotlinHooks: TranslatorHooks<KotlinTranslatorView> = { ...model, globalCall };
