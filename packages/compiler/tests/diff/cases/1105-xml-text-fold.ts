// @members-by-name
// Constant XML text in app code built at build time, as src/xml/pages.ts (`textsModule`) and src/xml/fold.ts emit it,
// over stand-ins for core's views: `Builder.parse(<text>, context)` as a factory taking the context's exports (none
// without one), with no source positions; `itemTemplate = <text>` as one constant template per site, so setting it again
// is no change; `itemTemplates = <text>` as a new keyed array per call, its templates built with a null context; and a
// `bind({ expression })` options object passing the compiled closure.
import { __xml, __xmlGetExports, registerModule } from './helpers/xml-page.ts';

type Template = () => View;
interface KeyedTemplate {
  key: string;
  createView: Template;
}
interface BindingOptions {
  sourceProperty: string;
  targetProperty: string;
  expression?: string;
  twoWay?: boolean;
  compiled?: any;
}

const log: string[] = [];

class View {
  parent: any = undefined;
  exports: any = undefined;
  text: any = '';
  children: string[] = [];
  listeners: string[] = [];
  bindings: string[] = [];
  on(event: string, handler: any): void {
    this.listeners.push(event + ':' + typeof handler);
  }
  bind(options: BindingOptions, source?: any): void {
    const value = options.compiled ? options.compiled.get(source, source) : 'evaluated';
    this.bindings.push(options.targetProperty + '=' + String(value) + (options.twoWay ? ' twoWay' : '') + (options.compiled && options.compiled.back ? ' back' : ''));
  }
  _addChildFromBuilder(name: string, child: any): void {
    child.parent = this;
    this.children.push(name);
  }
  addCssFile(file: string): void {
    log.push('css ' + file);
  }
}
class Page extends View {
  title = 'page';
}
class Leaf extends View {}
class List extends View {
  changes = 0;
  private _template: string | Template = '';
  private _templates: string | KeyedTemplate[] = '';
  get itemTemplate(): string | Template {
    return this._template;
  }
  set itemTemplate(value: string | Template) {
    if (value !== this._template) this.changes++;
    this._template = value;
  }
  get itemTemplates(): string | KeyedTemplate[] {
    return this._templates;
  }
  set itemTemplates(value: string | KeyedTemplate[]) {
    if (value !== this._templates) this.changes++;
    this._templates = value;
  }
  render(): View {
    const t = this.itemTemplate;
    return typeof t === 'function' ? t() : new Leaf();
  }
}

const __nsbE0: any = {
  get: (m: any, c: any): any => 'Hi ' + (m ? m.name : 'nobody'),
};
const __nsbE1: any = {
  get: (m: any, c: any): any => (m ? m.count : 0) + 1,
  back: (m: any, c: any): any => c,
};

function __xmlT0(context: any): View {
  let ctx: any = context;
  const v0: any = new Leaf();
  __xml.css(v0, undefined, undefined);
  __xml.set(v0, 'text', 'red');
  __xml.on(v0, 'tap', ctx, 'onTap');
  return v0;
}

function __xmlT1(context: any): View {
  let ctx: any = context;
  const v1: any = new Leaf();
  __xml.css(v1, undefined, undefined);
  v1.bind({ sourceProperty: '$value', targetProperty: 'text', expression: "'Hi ' + name", twoWay: true, compiled: __nsbE0 } as any);
  return v1;
}

export function __xmlParse0(context?: any): View {
  let ctx: any = context ? __xmlGetExports(context) : undefined;
  const v2: any = new Page();
  __xml.css(v2, undefined, 'page-style');
  __xml.set(v2, 'title', 'Parsed');
  __xml.on(v2, 'loaded', ctx, 'onLoaded');
  const v3: any = new Leaf();
  __xml.set(v3, 'text', 'child');
  __xml.on(v3, 'tap', ctx, 'onTap');
  __xml.add(v2, 'Leaf', v3);
  const v4: any = new List();
  __xml.add(v2, 'List', v4);
  const cv4_5: any = __xml.context(v4, ctx);
  if (__xml.has(v4, 'itemTemplate')) v4['itemTemplate'] = () => __xmlT0(cv4_5);
  __xml.array(v4, 'itemTemplate', []);
  return v2;
}

export function __xmlParse1(context?: any): View {
  let ctx: any = context ? __xmlGetExports(context) : undefined;
  const v6: any = new Leaf();
  __xml.css(v6, undefined, undefined);
  v6.bind({ sourceProperty: '$value', targetProperty: 'text', expression: "'Hi ' + name", twoWay: true, compiled: __nsbE0 } as any);
  return v6;
}

export const __xmlTemplate1: () => View = () => __xmlParse1();

export function __xmlTemplates2(): KeyedTemplate[] {
  return [{ key: 'red', createView: () => __xmlT0(null) }, { key: undefined as any, createView: () => __xmlT1(null) }];
}

registerModule('page-style.css', {});
const code = {
  onTap(): void {},
  onLoaded(): void {},
};

const owner = new Leaf();
owner.exports = code;
const inner = new Leaf();
owner._addChildFromBuilder('Leaf', inner);
const page = __xmlParse0(inner) as Page;
console.log(page.title, page.children.join(','), page.listeners.join(','), String(page.exports), log.join(' / '));
console.log(String(page.children.length), typeof page.exports, String((page as any)['_parentPage']));
const bare = __xmlParse0() as Page;
console.log(bare.title, bare.listeners.length, String(__xmlParse0(undefined).listeners.length), String(__xmlParse0(null).listeners.length));
const fromObject = __xmlParse0({ exports: code }) as Page;
console.log(fromObject.listeners.join(','));

const list = new List();
list.itemTemplate = (__xmlTemplate1

);
list.itemTemplate = (__xmlTemplate1);
console.log(String(list.changes), typeof list.itemTemplate, String(list.itemTemplate === __xmlTemplate1));
const row = list.render();
console.log(row.bindings.join(','), String(row === list.render()), String(row.parent));

list.itemTemplates = __xmlTemplates2();
const first = list.itemTemplates;
list.itemTemplates = __xmlTemplates2(
);
const second = list.itemTemplates as KeyedTemplate[];
console.log(String(list.changes), String(first === second), String(second.length), second.map((t) => String(t.key)).join(','));
const red = second[0].createView();
console.log(red.text, red.listeners.length, second[1].createView().bindings.join(','));

const label = new Leaf();
label.bind({ sourceProperty: 'count', targetProperty: 'text', expression: 'count + 1', twoWay: true, compiled: __nsbE1 }, { count: 4 });
label.bind({ sourceProperty: 'name', targetProperty: 'title', expression: "'Hi ' + name", compiled: __nsbE0 }, { name: 'Ann' });
label.bind({ sourceProperty: 'name', targetProperty: 'other', expression: 'name' }, { name: 'Bo' });
console.log(label.bindings.join(' | '));
