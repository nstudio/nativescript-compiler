// What the translators do for nativescript-vue: its refs, `nextTick()`, and the emitters a component's `emits` make.
import { ts } from './core-api.ts';
import type { FrameworkModel, KotlinTranslatorView, SwiftTranslatorView, TranslatorHooks, TranslatorView } from '@nstudio/nativescript-compiler/adapter-api';

const model: FrameworkModel = {
  signalTypes: { Ref: 'value' },
  signalConstructors: { ref: 'deep' },
  pure: ['ref', 'computed'],
  typeMap: { OutputEmitterRef: 'Emitter<$0>' },
};

/** `nextTick()`, and `output()`: the emitter of an event the component's `emits` declares. */
function globalCall(t: TranslatorView, name: string, e: ts.CallExpression, _decl: ts.Declaration | undefined, lib: boolean): string | undefined {
  if (name === 'nextTick' && !e.arguments.length && lib) return 'Reactivity.nextTick()';
  if (name === 'output' && lib) return `${t.typeOf(e)}()`;
  return undefined;
}

/** `emit(value)` of an event's emitter. */
function methodCall(t: TranslatorView, owner: string, method: string, e: ts.CallExpression): string | undefined {
  if (owner !== 'OutputEmitterRef' || (method !== 'emit' && method !== 'next')) return undefined;
  const target = (e.expression as ts.PropertyAccessExpression).expression;
  const value = /^(?:OutputEmitterRef|EventEmitter|Emitter)<(.*)>[?!]?$/.exec(t.typeOf(target))?.[1];
  const a = e.arguments[0];
  return `${t.expr(target)}.emit(${a ? (value && value !== 'Void' && value !== 'Unit' ? t.coerce(a, value) : t.expr(a)) : ''})`;
}

export const swiftHooks: TranslatorHooks<SwiftTranslatorView> = { ...model, globalCall, methodCall };
export const kotlinHooks: TranslatorHooks<KotlinTranslatorView> = { ...model, globalCall, methodCall };
