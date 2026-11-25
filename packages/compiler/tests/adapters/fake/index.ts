// The adapter of `fake-framework`, a framework that exists only here, written against the adapter API alone. An app's
// entry starts it with `start(Component)`; a component is a `.fake` file: its state (`name = initial value` lines),
// `---`, then a template of core's elements, where `attr="{expression}"` binds an attribute, `on:event="statements"`
// listens, and any other attribute is a value.
import type { CoreApi, FrameworkAdapter, FrameworkModel, TNode, TranslatorHooks, TranslatorView } from '../../../src/api/adapter-api.ts';

let core: CoreApi;

const refusals = {
  'fake-eval': { class: 'limit', title: "fake-framework's fakeEval()", suggestion: 'call the function the text names instead', why: 'there is no engine to run code given as text' },
} as const;

declare module '../../../src/api/adapter-api.ts' {
  interface AdapterRefusalIds extends Record<keyof typeof refusals, true> {}
}

/** `fakeNow()`: a constant each back end spells; `fakeEval(text)`: refused. */
function globalCall(native: string) {
  return (t: TranslatorView, name: string, call: import('typescript').CallExpression, _decl: unknown, lib: boolean): string | undefined => {
    if (!lib) return undefined;
    if (name === 'fakeNow') return native;
    if (name === 'fakeEval') throw t.error(call, 'fakeEval() runs code given as text', 'fake-eval');
    return undefined;
  };
}

const model: FrameworkModel = { pure: ['fakeNow'] };

/** A component's class and template, from its file's text. */
function component(file: string, text: string) {
  const name = /([^/\\]+)\.fake$/.exec(file)![1];
  const [state, template] = text.includes('\n---\n') ? text.split('\n---\n') : ['', text];
  const fields = state.split('\n').map((l) => /^\s*(\w+)\s*=\s*(.+?)\s*$/.exec(l)).filter((m): m is RegExpExecArray => !!m);
  const scope = { names: new Map(fields.map(([, n]) => [n, `this.${n}.value`])) };
  const members: string[] = [];
  let next = 0;
  const method = (code: string, kind: 'expression' | 'statements') => {
    const m = `$${kind === 'expression' ? 'b' : 'e'}${next++}`;
    members.push(kind === 'expression' ? `  ${m}() { return ${core.rewrite(code, scope)}; }` : `  ${m}($event: $EventData) { ${core.rewrite(code, scope, 'statements')} }`);
    return m;
  };
  const roots: TNode[] = [];
  const open: Extract<TNode, { kind: 'element' }>[] = [];
  for (const [, close, tag, attrs, selfClosing] of template.matchAll(/<(\/?)([A-Za-z][\w.]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>/g)) {
    if (close) { open.pop(); continue; }
    const node: Extract<TNode, { kind: 'element' }> = { kind: 'element', tag, attrs: [], events: [], children: [] };
    for (const [, attr, value] of attrs.matchAll(/([\w:.-]+)="([^"]*)"/g)) {
      if (attr.startsWith('on:')) node.events.push({ name: attr.slice(3), method: method(value, 'statements') });
      else if (/^\{.*\}$/s.test(value)) node.attrs.push({ name: attr, method: method(value.slice(1, -1), 'expression') });
      else node.attrs.push({ name: attr, value });
    }
    (open.length ? open[open.length - 1].children : roots).push(node);
    if (!selfClosing) open.push(node);
  }
  const source = [
    `import { $ref, type EventData as $EventData } from '@nativescript/release';`,
    `import { fakeEval, fakeNow } from 'fake-framework';`,
    ``,
    `export default class ${name} {`,
    ...fields.map(([, n, init]) => `  readonly ${n} = $ref(${init});`),
    ...members,
    `}`,
    ``,
  ].join('\n');
  return { name, file: file.replace(/\.fake$/, '.ts'), source, props: [], template: roots };
}

export default function adapter(api: CoreApi): FrameworkAdapter {
  core = api;
  return {
    apiVersion: 1,
    name: 'fake',
    packages: ['fake-framework'],
    behaviour: { schedule: 'microtask', eventScope: 'none', propsOrder: 'post', deferBindings: false, insertion: 'built', listenersAfterBindings: false, effectScope: null, checkEveryBinding: 'off', slots: false, rowSignals: 'off', fragments: false },
    reach: 'project',
    swift: { ...model, globalCall: globalCall('Double(1234.5)') } satisfies TranslatorHooks,
    kotlin: { ...model, globalCall: globalCall('1234.5') } satisfies TranslatorHooks,
    modules: {
      shims: {
        'fake-framework': `
          export declare function start(component: any): void;
          export declare function fakeNow(): number;
          export declare function fakeEval(code: string): unknown;
        `,
      },
      componentExtensions: ['.fake'],
    },
    refusals,
    async frontEnd(app) {
      const { readFileSync } = await import('node:fs');
      const components = app.files.filter((f) => f.endsWith('.fake')).map((f) => component(f, readFileSync(f, 'utf8')));
      const root = /start\(\s*(\w+)\s*\)/.exec(app.entryText)?.[1];
      if (!root) throw new Error(`${app.entry}: no start(Component)`);
      return { components, modules: app.sources, root };
    },
  };
}
