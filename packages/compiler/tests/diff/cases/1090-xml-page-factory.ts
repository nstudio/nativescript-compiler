// @members-by-name
// A page factory as src/xml/pages.ts emits one, over stand-ins for core's views: attributes set by name, handlers read from
// the context at run time (a missing or non-function export adds no listener), a known function taking the export or
// the text, children attached only where the parent has `_addChildFromBuilder`, a property element assigned where it
// has none, `_addArrayFromBuilder` at every property's end, a template set only where its owner has the property (the
// context read when the property opens), keyed templates, a code file's exports becoming the parser's context, and the
// `_parentPage` a root custom component takes from its context.
import { __xml, registerModule } from './helpers/xml-page.ts';

const log: string[] = [];

class Observable {
  listeners: string[] = [];
  on(event: string, handler: any): void {
    this.listeners.push(event + ':' + typeof handler);
  }
}
class ViewBase extends Observable {
  parent: any = undefined;
  exports: any = undefined;
  text: any = '';
  className: any = '';
  name(): string {
    return 'view';
  }
}
class Layout extends ViewBase {
  children: any[] = [];
  _addChildFromBuilder(name: string, child: any): void {
    child.parent = this;
    this.children.push(name);
  }
  addCssFile(file: string): void {
    log.push('css ' + file);
  }
}
class Leaf extends ViewBase {}
class Bar extends ViewBase {
  items: any[] = [];
  _addArrayFromBuilder(name: string, items: any[]): void {
    log.push('array ' + name + ' ' + items.length);
    this.items = items;
  }
}
class List extends ViewBase {
  static knownFunctions = ['itemTemplateSelector'];
  itemTemplate: any = undefined;
  itemTemplates: any = undefined;
  itemTemplateSelector: any = undefined;
}
class NoTemplate extends ViewBase {}

const code = {
  onTap(): void {},
  pick(): string {
    return 'picked';
  },
  notAFunction: 3,
};
registerModule('main-page.css', {});
registerModule('row-code', { onRow(): void {} });

function row(context: any, xmlModule: string): any {
  const v: any = new Leaf();
  __xml.on(v, 'tap', context, 'onRow');
  __xml.src(v, xmlModule, 9, 7);
  return v;
}

function page(exports: any, moduleName: string, xmlModule: string): any {
  let ctx: any = exports;
  const v0: any = new Layout();
  const xv0: any = __xml.code(v0, { codeFile: 'row-code' });
  __xml.css(v0, moduleName, undefined);
  __xml.set(v0, 'className', 'page');
  __xml.on(v0, 'tap', xv0, 'onRow');
  __xml.src(v0, xmlModule, 1, 1);
  if (v0.exports) ctx = v0.exports;
  const v1: any = new Leaf();
  __xml.set(v1, 'text', 'Hello');
  __xml.on(v1, 'tap', code, 'onTap');
  __xml.on(v1, 'tap', code, 'missing');
  __xml.on(v1, 'tap', code, 'notAFunction');
  __xml.on(v1, 'tap', undefined, 'onTap');
  __xml.src(v1, xmlModule, 2, 3);
  __xml.add(v0, 'Leaf', v1);
  const v2: any = new Leaf();
  __xml.src(v2, xmlModule, 3, 3);
  __xml.add(v1, 'Leaf', v2);
  const v3: any = new Bar();
  __xml.add(v0, 'Bar', v3);
  const i3: any[] = [];
  const v4: any = new Leaf();
  __xml.set(v4, 'text', 'item');
  i3.push(v4);
  __xml.array(v3, 'items', i3);
  const v5: any = new Leaf();
  __xml.prop(v0, 'header', v5);
  __xml.prop(v3, 'header', v5);
  __xml.array(v0, 'header', []);
  const v6: any = new List();
  lists.push(v6);
  __xml.fn(v6, 'itemTemplateSelector', code, 'pick');
  __xml.add(v0, 'List', v6);
  const c6: any = __xml.context(v6, ctx);
  if (__xml.has(v6, 'itemTemplate')) v6['itemTemplate'] = () => row(c6, xmlModule);
  __xml.array(v6, 'itemTemplate', []);
  const t: any[] = [{ key: 'a', createView: () => row(c6, xmlModule) }, { key: 'b', createView: () => row(c6, xmlModule) }];
  v6['itemTemplates'] = t;
  const v7: any = new NoTemplate();
  lists.push(v7);
  __xml.fn(v7, 'itemTemplateSelector', code, 'notAFunction');
  __xml.add(v0, 'NoTemplate', v7);
  if (__xml.has(v7, 'itemTemplate')) v7['itemTemplate'] = () => row(c6, xmlModule);
  return v0;
}

const lists: any[] = [];
const root: any = page(code, 'main-page', 'main-page.xml');
console.log(root.className, root.children.join(','), root.listeners.join(','), typeof root.exports, __xml.sanitize('~/pages/main.xml'));
const list: any = lists[0];
console.log(typeof list.itemTemplate, typeof list.itemTemplates, list.itemTemplates.length, String(list.itemTemplates[1].key));
const made: any = list.itemTemplate();
console.log(made.listeners.join(','), String(made === list.itemTemplate()), String(list.itemTemplates[0].createView().listeners.length));
console.log(typeof list.itemTemplateSelector, list.itemTemplateSelector());
console.log(String(lists[1].itemTemplate), String(lists[1].itemTemplateSelector), String(__xml.has(lists[1], 'itemTemplate')));
console.log(log.join(' / '));
const context: any = { _parentPage: 'the page', other: 1 };
console.log(String(__xml.rootPage(context)), String('_parentPage' in context), String(context.other), String(__xml.rootPage(undefined)));
const owner: any = new Layout();
const templated: any = new List();
owner._addChildFromBuilder('List', templated);
owner.exports = { onRow(): void {} };
console.log(typeof __xml.context(templated, 'fallback'), String(__xml.context(new List(), 'fallback')));
console.log(row(__xml.context(templated, 'fallback'), 'list.xml').listeners.join(','));
class Style {
  color: any = undefined;
}
class Holder extends ViewBase {
  style = new Style();
  ios: any = { position: 'left' };
  inner: any = new Leaf();
  bind(): void {}
}
const holder: any = new Holder();
__xml.dotted(holder, ['style'], 'color', 'red', code);
__xml.dotted(holder, ['ios'], 'position', 'right', code);
__xml.dotted(holder, ['ios'], 'itemTemplateSelector', 'pick', code);
__xml.dotted(holder, ['missing', 'deeper'], 'text', 'never', code);
__xml.dotted(holder, ['inner'], 'text', 'inner text', code);
console.log(String(holder.style.color), String(holder.ios.position), String(holder.ios.itemTemplateSelector), String(holder.inner.text), String(holder.missing));
