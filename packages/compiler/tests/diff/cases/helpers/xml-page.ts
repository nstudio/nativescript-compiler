// The run-time helpers of the XML page factories, as src/xml/pages.ts emits them (tests/xml-pages-check.ts checks it),
// over stand-ins for the core functions they call.
const modules: Record<string, any> = {};
export function registerModule(name: string, exports: any): void {
  modules[name] = exports;
}
const __xmlLoadModule = (name: string): any => modules[name];
const __xmlResolve = (name: string, ext: string): string => {
  const file = ext ? name + '.' + ext : name;
  return file in modules ? file : '';
};
const sourceKey = Symbol('source');
const __xmlSourceTracker = (uri: string): any => (component: any, p: any): void => {
  if (!component[sourceKey]) component[sourceKey] = uri + ':' + p.line + ':' + p.column;
};
export function __xmlGetExports(instance: any): any {
  let exports = instance.exports;
  let parent = instance.parent;
  while (exports === undefined && parent) {
    exports = parent.exports;
    parent = parent.parent;
  }
  return exports;
}
function __xmlSetProperty(instance: any, instanceModule: any, exports: any, name: string, value: any): void {
  instance[name] = value;
}
function __xmlLoadCustomComponent(namespace: string, name: string, attributes: any, context: any, page: any, isRoot: boolean, moduleName: any): any {
  const make = modules[namespace + '/' + name];
  return { component: make(context, page, isRoot, moduleName) };
}
export const __xml = {
  sanitize(name: string): string {
    name = name.trim();
    if (name.startsWith('~/')) name = name.substring(2);
    else if (name.startsWith('~')) name = name.substring(1);
    else if (name.startsWith('/')) name = name.substring(1);
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.substring(0, dot) : name;
  },
  src(v: any, uri: string, line: number, column: number): void {
    __xmlSourceTracker(uri)(v, { line, column });
  },
  code(v: any, attributes: any): any {
    const spec = attributes.codeFile || attributes.import;
    const resolved = __xmlResolve(__xml.sanitize(spec), '');
    if (resolved) {
      const exports = __xmlLoadModule(resolved);
      v.exports = exports;
      return exports;
    }
    throw new Error('Code file with path "' + spec + '" cannot be found! Looking for webpack module with name "' + resolved + '"');
  },
  css(v: any, moduleName: any, cssFile: any): void {
    let applied = false;
    if (cssFile) {
      const resolved = __xmlResolve(__xml.sanitize(cssFile), 'css');
      if (resolved) {
        v.addCssFile(resolved);
        applied = true;
      } else throw new Error('Css file with path "' + cssFile + '" cannot be found! Looking for webpack module with name "' + resolved + '"');
    }
    if (moduleName && !applied) {
      const resolved = __xmlResolve(moduleName, 'css');
      if (resolved) v.addCssFile(resolved);
    }
  },
  set(v: any, name: string, value: string): void {
    v[name] = value;
  },
  // `setPropertyValue` on what a dotted attribute names. A holder that is not a view (`style`, a native `ios` object) takes
  // its event, known-function and plain branches here, as JavaScript reads them; core's own declares a view there.
  dotted(v: any, path: string[], name: string, value: string, exports: any): void {
    let o = v;
    for (const k of path) if (o !== undefined && o !== null) o = o[k];
    if (o === undefined || o === null) return;
    if (o.bind) {
      __xmlSetProperty(o, undefined as any, exports, name, value);
      return;
    }
    const event = name.indexOf('on') === 0 ? name.slice(2) : name;
    if ((o.constructor && event + 'Event' in o.constructor) || __xml.gesture(event)) {
      const handler = exports && exports[value];
      if (typeof handler === 'function') o.on(name, handler);
    } else if (o.constructor && 'knownFunctions' in o.constructor && o.constructor.knownFunctions.indexOf(name) !== -1 && exports && typeof exports[value] === 'function') o[name] = exports[value];
    else o[name] = value;
  },
  gesture(name: string): boolean {
    const t = name.trim().toLowerCase();
    return t === 'tap' || t === 'doubletap' || t === 'pinch' || t === 'pan' || t === 'swipe' || t === 'rotation' || t === 'longpress' || t === 'touch';
  },
  on(v: any, event: string, exports: any, name: string): void {
    const handler = exports && exports[name];
    if (typeof handler === 'function') v.on(event, handler);
  },
  fn(v: any, name: string, exports: any, value: string): void {
    if (exports && typeof exports[value] === 'function') v[name] = exports[value];
    else v[name] = value;
  },
  add(parent: any, name: string, child: any): void {
    if (parent._addChildFromBuilder) parent._addChildFromBuilder(name, child);
  },
  prop(parent: any, name: string, child: any): void {
    if (parent._addChildFromBuilder) parent._addChildFromBuilder(name, child);
    else parent[name] = child;
  },
  array(parent: any, name: string, items: any[]): void {
    if (parent._addArrayFromBuilder) parent._addArrayFromBuilder(name, items);
  },
  has(o: any, name: string): boolean {
    return name in o;
  },
  context(parent: any, context: any): any {
    return __xmlGetExports(parent) || context;
  },
  rootPage(context: any): any {
    if (!context) return undefined;
    const page = context['_parentPage'];
    delete context['_parentPage'];
    return page;
  },
  componentCss(page: any, namespace: string, name: string): void {
    namespace = __xml.sanitize(namespace);
    const resolved = __xmlResolve(namespace + '/' + name, 'css') || __xmlResolve(namespace, 'css');
    if (page && resolved) page.addCssFile(resolved);
  },
  custom(namespace: string, name: string, context: any, page: any, isRoot: boolean, moduleName: any): any {
    return __xmlLoadCustomComponent(namespace, name, undefined, context, page, isRoot, moduleName).component;
  },
  attribute(v: any, exports: any, name: string, value: string): void {
    __xmlSetProperty(v, exports, exports, name, value);
  },
};
