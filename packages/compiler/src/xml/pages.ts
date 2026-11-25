// The XML files of a plain XML app as factories: TypeScript that builds each file's view tree the way core's Builder
// builds it from the text (`ui/builder/index.ts` ComponentParser/TemplateParser/MultiTemplateParser,
// `component-builder/index.ts`), in the same order: create, code file, root stylesheet, attributes in source order,
// attach to the parent at the start tag, then the children. Core's `loadInternal` calls a file's factory in place of
// parsing it (`registerPageFactory`, reached through the kit's `__nsRegisterPage`, so that an app typed against an older
// core still builds); the module name resolver still picks the file, so qualified variants keep their own factories.
// What JavaScript decides at run time stays a run-time decision: code-behind exports and handlers are read from the
// context the Builder passes, code files and stylesheets go through the resolver, and a custom XML component goes
// through core's `loadCustomComponent`, which finds that component's factory.
import type { AttributePlan, ElementPlan, PagePlan, PropertyPlan, XmlPlan } from './plan.ts';

export interface PagesModule {
	source: string;
	/** The files that have a factory, and those left to the Builder with the reason. */
	pages: string[];
	/** Each factory's function name, by file. */
	factories: Map<string, string>;
	/** Each factory's code-behind, as the resolver names it, where the factory owns it. */
	owned: Map<string, string>;
	runtime: { file: string; reason: string }[];
}

/** `createComponentInstance`'s wrapping of a constructor's throw (`make`: namespace, tag, barrel), then the parser's. */
const FAIL = `function __xmlFail(e: any, uri: string | undefined, line: number, column: number, make: string): any {
  if (make) {
    const [namespace, tag, barrel] = make.split('\\n');
    const resolved = barrel || (namespace ? __xmlResolve(namespace, '') : undefined);
    e = new __xmlScopeError(e, "Module '" + (resolved || tag) + "' not found for element '" + (namespace ? namespace + ':' : '') + tag + "'.");
  }
  const p = { line, column };
  return uri ? __xmlBuilder.SourceErrorFormat(uri)(e, p) : __xmlBuilder.PositionErrorFormat(e, p);
}`;

/** The run-time helpers the factories call, each doing what the Builder's code at that step does. */
export const PAGE_HELPERS = `const __xml = {
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
  // \`setPropertyValue\` on what a dotted attribute names. A holder that is not a view (\`style\`, a native \`ios\` object) takes
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
`;

const KNOWN_FUNCTIONS: Record<string, string[]> = { ListView: ['itemTemplateSelector', 'itemIdGenerator'], Repeater: ['itemTemplateSelector'] };

/** Why a file keeps the Builder, or null. */
function runtimeReason(page: PagePlan): string | null {
	if (page.errors.length) return page.errors[0];
	if (!page.root) return 'no root element';
	let reason: string | null = null;
	const visit = (e: ElementPlan | null | undefined): void => {
		if (!e || reason) return;
		if (e.kind === 'unknown') reason = `${page.file}:${e.line}:${e.column}: <${e.prefix ? e.prefix + ':' : ''}${e.tag}> has no class (the Builder throws where it builds it)`;
		else if (e.kind === 'custom-xml' && e.prefixed) reason = `${page.file}:${e.line}:${e.column}: a prefixed attribute on a custom XML component, which the Builder sets as written`;
		else if (e.kind === 'custom-class' && !e.component.file) reason = `${page.file}:${e.line}:${e.column}: <${e.tag}>'s module was not found`;
		e.children.forEach(visit);
		for (const p of e.properties) {
			visit(p.root);
			p.templates?.forEach((t) => visit(t.root));
			p.children?.forEach(visit);
		}
	};
	visit(page.root);
	return reason;
}

const CORE_UI_BARREL = '@nativescript/core/ui';

/**
 * A tree's statements under the Builder's error wrapping: what throws while building reads as the parser's does, at the
 * position of the event being handled (`SourceErrorFormat` for a file, `PositionErrorFormat` for text).
 */
function guarded(out: string[], v: string, uri: string): string {
	const body = [...out, `return ${v};`].map((l) => '    ' + l).join('\n');
	return `  let line = 0, column = 0, make = '';\n  try {\n${body}\n  } catch (e) {\n    throw __xmlFail(e, ${uri}, line, column, make);\n  }`;
}

const camel = (name: string) =>
	name
		.split('-')
		.map((s) => s[0].toUpperCase() + s.substring(1))
		.join('');

/**
 * Emits element trees as the statements that build them; one per generated module. `track`: the tree comes from an XML
 * file, so each element's position goes to core's source tracker and templates take the file as `xmlModule`; text
 * handed to the Builder has neither.
 */
function treeEmitter(closures: Map<string, string>, track: boolean) {
	const coreClasses = new Set<string>();
	const appClasses = new Map<string, string>();
	const usedClosures = new Set<string>();
	const functions: string[] = [];
	let ids = 0;
	let templates = 0;
	const xmlModule = track ? ', xmlModule' : '';

	const classOf = (e: ElementPlan): string => {
		if (e.kind === 'core') {
			coreClasses.add(e.component.name);
			return `__xmlUi_${e.component.name}`;
		}
		const id = `${e.component.file}\u0000${camel(e.component.name)}`;
		let local = appClasses.get(id);
		if (!local) appClasses.set(id, (local = `__xmlApp${appClasses.size}_${camel(e.component.name)}`));
		return local;
	};

	/**
	 * The statements building `e` into `v`, then attaching it. `ctx`: the variable holding the parser's context;
	 * `root`: the variable of the tree's root so far (null for the root itself); `moduleName`: the expression of the
	 * module name the parser has (undefined in templates).
	 */
	const element = (e: ElementPlan, out: string[], ctx: string, root: string | null, moduleName: string, attach: (v: string) => string | null): string => {
		const v = `v${ids++}`;
		const isRoot = root === null;
		const raw = Object.fromEntries(e.attributes.map((a) => [a.name, a.value]));
		let exports = ctx;
		out.push(`line = ${e.line}; column = ${e.column};`);
		if (e.kind === 'custom-xml') {
			out.push(`const ${v}: any = __xml.custom(${JSON.stringify(e.namespace)}, ${JSON.stringify(e.tag)}, ${ctx}, ${root ?? 'undefined'}, ${isRoot}, ${moduleName});`);
			// `loadCustomComponent` applies the use site's attributes as written, against the use site's context.
			for (const a of e.attributes) out.push(attribute(v, a, ctx, true));
		} else {
			const page = e.kind === 'custom-class' && isRoot ? `p${v}` : null;
			if (page) out.push(`const ${page}: any = __xml.rootPage(${ctx});`);
			const cls = classOf(e);
			// An app class's element is held as that class, so only its attributes reach it by name; one whose property
			// elements or code file take keys the class may not declare stays untyped.
			const typed = e.kind === 'custom-class' && !e.properties.length && !(isRoot && e.codeFile);
			// What \`createComponentInstance\` names when the constructor throws: the namespace, the tag and, for a core class
			// under a legacy barrel namespace, the barrel.
			const namespace = e.namespace && !/tns\.xsd$/i.test(e.namespace) ? e.namespace : '';
			const barrel = e.kind === 'core' && namespace ? '\n' + CORE_UI_BARREL : '';
			out.push(`make = ${JSON.stringify(namespace + '\n' + e.tag + barrel)};`);
			out.push(`const ${v}: ${typed ? cls : 'any'} = new ${cls}();`);
			out.push(`make = '';`);
			if (e.codeFile) {
				exports = `x${v}`;
				out.push(`const ${exports}: any = __xml.code(${v}, ${JSON.stringify({ ...(raw.codeFile !== undefined ? { codeFile: raw.codeFile } : {}), ...(raw.import !== undefined ? { import: raw.import } : {}) })});`);
			}
			if (isRoot) out.push(`__xml.css(${v}, ${moduleName}, ${raw.cssFile !== undefined ? JSON.stringify(raw.cssFile) : 'undefined'});`);
			for (const a of e.attributes) out.push(attribute(v, a, exports, false, e));
			if (e.kind === 'custom-class') {
				out.push(`__xml.componentCss(${page ?? root}, ${JSON.stringify(e.namespace)}, ${JSON.stringify(e.tag)});`);
			}
		}
		if (track) out.push(`__xml.src(${v}, xmlModule, ${e.line}, ${e.column});`);
		const attached = attach(v);
		if (attached) out.push(attached);
		// The parser's context becomes the root's own exports (its code file) once the root is made.
		if (isRoot && (e.codeFile || e.kind === 'custom-xml')) out.push(`if (${v}.exports) ${ctx} = ${v}.exports;`);
		const treeRoot = root ?? v;
		const items: { offset: number; emit: () => void }[] = [
			...e.children.map((c) => ({
				offset: c.offset,
				emit: () => {
					element(c, out, ctx, treeRoot, moduleName, (cv) => `__xml.add(${v}, ${JSON.stringify(c.tag)}, ${cv});`);
				},
			})),
			...e.properties.map((p) => ({ offset: p.offset, emit: () => property(v, p, out, ctx, treeRoot, moduleName) })),
		].sort((a, b) => a.offset - b.offset);
		for (const item of items) item.emit();
		return v;
	};

	const property = (v: string, p: PropertyPlan, out: string[], ctx: string, root: string, moduleName: string): void => {
		// At the property's end tag the parser hands its items to `_addArrayFromBuilder`, whatever the property; only
		// known collections hold any.
		if (p.kind === 'template') {
			const context = `c${v}_${ids++}`;
			out.push(`const ${context}: any = __xml.context(${v}, ${ctx});`);
			const t = template(p.root!);
			end(p, out);
			out.push(`if (__xml.has(${v}, ${JSON.stringify(p.name)})) ${v}[${JSON.stringify(p.name)}] = () => ${t}(${context}${xmlModule});`);
			out.push(`__xml.array(${v}, ${JSON.stringify(p.name)}, []);`);
		} else if (p.kind === 'templates') {
			const context = `c${v}_${ids++}`;
			out.push(`const ${context}: any = __xml.context(${v}, ${ctx});`);
			end(p, out);
			out.push(`{ const t: __xmlKeyedTemplate[] = ${keyed(p, context)}; ${v}[${JSON.stringify(p.name)}] = t; }`);
		} else {
			const items = `i${v}_${ids++}`;
			out.push(`const ${items}: any[] = [];`);
			const collection = p.kind === 'collection';
			for (const c of p.children ?? []) element(c, out, ctx, root, moduleName, (cv) => (collection ? `${items}.push(${cv});` : `__xml.prop(${v}, ${JSON.stringify(p.name)}, ${cv});`));
			end(p, out);
			out.push(`__xml.array(${v}, ${JSON.stringify(p.name)}, ${items});`);
		}
	};

	const end = (p: PropertyPlan, out: string[]): void => {
		if (p.end) out.push(`line = ${p.end.line}; column = ${p.end.column};`);
	};

	/** A `templates` property's `KeyedTemplate[]`, each template called with `context`. */
	const keyed = (p: PropertyPlan, context: string): string => `[${p.templates!.map((k) => `{ key: ${k.key === undefined ? 'undefined as any' : JSON.stringify(k.key)}, createView: () => ${template(k.root!)}(${context}${xmlModule}) }`).join(', ')}]`;

	/** A template's root as a function of the template's context, built anew per call (errors surface on first render). */
	const template = (rootElement: ElementPlan): string => {
		const name = `__xmlT${templates++}`;
		const out: string[] = [];
		const v = element(rootElement, out, 'ctx', null, 'undefined', () => null);
		functions.push(`function ${name}(context: any${track ? ', xmlModule: string' : ''}): __xmlView {\n  let ctx: any = context;\n${guarded(out, v, track ? 'xmlModule' : 'undefined')}\n}`);
		return name;
	};

	const attribute = (v: string, a: AttributePlan, exports: string, asWritten: boolean, e?: ElementPlan): string => {
		const name = asWritten ? a.name : a.target;
		if (a.kind === 'binding' && a.binding) {
			const b = a.binding;
			const closure = closures.get(a.key);
			if (closure) usedClosures.add(closure);
			const options = `{ sourceProperty: ${JSON.stringify(b.sourceProperty)}, targetProperty: ${JSON.stringify(asWritten ? a.name : a.target.split('.').pop()!)}, expression: ${b.expression === undefined ? 'undefined' : JSON.stringify(b.expression)}, twoWay: ${b.twoWay}, compiled: ${closure ?? 'undefined'} }`;
			return `${v}.bind(${options} as any${b.bindingSource !== undefined ? `, ${JSON.stringify(b.bindingSource)}` : ''});`;
		}
		if (asWritten) return `__xml.attribute(${v}, ${exports}, ${JSON.stringify(name)}, ${JSON.stringify(a.value)});`;
		if (a.target.includes('.')) {
			const path = a.target.split('.');
			const leaf = path.pop()!;
			return `__xml.dotted(${v}, ${JSON.stringify(path)}, ${JSON.stringify(leaf)}, ${JSON.stringify(a.value)}, ${exports});`;
		}
		if (a.kind === 'event') return `__xml.on(${v}, ${JSON.stringify(name)}, ${exports}, ${JSON.stringify(a.value)});`;
		// `isKnownFunction` and the export are both run-time checks of the Builder.
		if (a.kind === 'function' || (e && e.kind === 'core' && KNOWN_FUNCTIONS[e.component.name]?.includes(name))) return `__xml.fn(${v}, ${JSON.stringify(name)}, ${exports}, ${JSON.stringify(a.value)});`;
		return `__xml.set(${v}, ${JSON.stringify(name)}, ${JSON.stringify(a.value)});`;
	};

	/** The module's head: its imports, the loader and tracker, and the helpers. */
	const head = (bindingsSpec: string | null): string => {
		const imports = [
			`import { ${[...coreClasses]
				.sort()
				.map((c) => `${c} as __xmlUi_${c}`)
				.join(', ')} } from '@nativescript/core';`,
			`import type { KeyedTemplate as __xmlKeyedTemplate, View as __xmlView } from '@nativescript/core';`,
			`import { resolveModuleName as __xmlResolve } from '@nativescript/core/module-name-resolver';`,
			`import { getExports as __xmlGetExports, loadCustomComponent as __xmlLoadCustomComponent, xml2ui as __xmlBuilder } from '@nativescript/core/ui/builder';`,
			`import { setPropertyValue as __xmlSetProperty } from '@nativescript/core/ui/builder/component-builder';`,
			`import { ScopeError as __xmlScopeError } from '@nativescript/core/utils/debug';`,
			...[...appClasses].map(([id, local]) => {
				const [file, cls] = id.split('\u0000');
				return `import { ${cls} as ${local} } from ${JSON.stringify('./' + file!.replace(/\.(ts|js)$/, ''))};`;
			}),
			...(usedClosures.size && bindingsSpec ? [`import { ${[...usedClosures].sort().join(', ')} } from ${JSON.stringify(bindingsSpec)};`] : []),
		].filter((l) => !l.startsWith('import {  }'));
		const loadModule = `const __xmlLoadModule = (name: string): any => (global as any).loadModule(name);\nconst __xmlSourceTracker = (uri: string): any => __xmlBuilder.ComponentSourceTracker(uri);\n${FAIL}`;
		return `${imports.join('\n')}\n${loadModule}\n\n${PAGE_HELPERS}`;
	};

	return { element, keyed, functions, head };
}

/**
 * The factories of the plan's files. `closures`: each `{{ }}` attribute key's compiled closure, as the bindings module
 * exports it.
 *
 * A factory owns its code-behind (core takes the module's object from the registration, not from the registry) when the
 * resolver can name only that file for the module. The registration takes the registry's own object, so the
 * `_parentPage` that `loadCustomComponent` puts on it is seen through either.
 */
export function pagesModule(plan: XmlPlan, closures: Map<string, string>, bindingsSpec: string | null): PagesModule {
	const runtime: { file: string; reason: string }[] = [];
	const built: PagePlan[] = [];
	for (const page of plan.pages) {
		const reason = runtimeReason(page);
		if (reason) runtime.push({ file: page.file, reason });
		else built.push(page);
	}
	const emit = treeEmitter(closures, true);
	const registrations: string[] = [];
	const owned = new Map<string, string>();
	for (const page of built) {
		const name = `__xmlPage${registrations.length}`;
		const out: string[] = [];
		const v = emit.element(page.root!, out, 'ctx', null, 'moduleName', () => null);
		emit.functions.push(`export function ${name}(exports: any, moduleName: string, xmlModule: string): any {\n  let ctx: any = exports;\n${guarded(out, v, 'xmlModule')}\n}`);
		const code = page.codeBehind;
		const variants = plan.modules.find((m) => m.module === page.module)?.code ?? [];
		const module = code && variants.length === 1 && variants[0].file === code && !variants[0].qualifiers.length ? code.replace(/\.(ts|js)$/, '') : null;
		if (module) owned.set(page.file, module);
		const codeArgs = module ? `, ${JSON.stringify(module)}, __xmlLoadModule(${JSON.stringify(module)})` : '';
		registrations.push(`__nsRegisterPage(${JSON.stringify(page.file)}, ${name}${codeArgs});`);
	}
	if (!registrations.length) return { source: '', pages: [], factories: new Map(), owned, runtime };
	const source = `${emit.head(bindingsSpec)}\n${emit.functions.join('\n\n')}\n\n${registrations.join('\n')}\nexport {};\n`;
	return { source, pages: built.map((p) => p.file), factories: new Map(built.map((p, i) => [p.file, `__xmlPage${i}`])), owned, runtime };
}

export interface TextsModule {
	source: string;
	/** Per folded site (its index in `XmlPlan.dynamic`), the export that replaces the text. */
	folded: Map<number, { kind: 'Builder.parse' | 'itemTemplate' | 'itemTemplates'; name: string }>;
	/** The constant texts left to the Builder, with the reason. */
	runtime: { site: number; reason: string }[];
}

/**
 * The constant XML texts of app code built without parsing: `Builder.parse(<text>, context)` becomes
 * `__xmlParse<n>(context)`, which takes the context's exports as `Builder.parse` does; `itemTemplate = <text>` becomes
 * the constant template `__xmlTemplate<n>`, one function per site as the text is one string, so setting it again changes
 * nothing; `itemTemplates = <text>` becomes `__xmlTemplates<n>()`, a new array per call as `parseMultipleTemplates`
 * returns, its templates taking a null context as there. An `itemTemplate` text whose tree reads its context stays
 * text: core passes the owner's exports to `Builder.parse` when it renders a row, which a constant cannot know.
 */
export function textsModule(plan: XmlPlan, closures: Map<string, string>, bindingsSpec: string | null): TextsModule {
	const emit = treeEmitter(closures, false);
	const folded: TextsModule['folded'] = new Map();
	const runtime: TextsModule['runtime'] = [];
	const exported: string[] = [];
	for (const { site, page } of plan.texts) {
		const kind = plan.dynamic[site].kind as 'Builder.parse' | 'itemTemplate' | 'itemTemplates';
		const reason = runtimeReason(page);
		if (reason) {
			runtime.push({ site, reason });
			continue;
		}
		const n = folded.size;
		if (kind === 'itemTemplates') {
			const p = page.root!.properties.find((q) => q.kind === 'templates')!;
			const name = `__xmlTemplates${n}`;
			exported.push(`export function ${name}(): __xmlKeyedTemplate[] {\n  return ${emit.keyed(p, 'null')};\n}`);
			folded.set(site, { kind, name });
			continue;
		}
		const out: string[] = [];
		const v = emit.element(page.root!, out, 'ctx', null, 'undefined', () => null);
		const reads = out.some((l) => /\bctx\b/.test(l.replace(/^if \(\w+\.exports\) ctx = \w+\.exports;$/, '')));
		if (kind === 'itemTemplate' && reads) {
			runtime.push({ site, reason: "the template reads its owner's exports, which core passes when it renders a row" });
			continue;
		}
		const parse = `__xmlParse${n}`;
		exported.push(`export function ${parse}(context?: any): __xmlView {\n  let ctx: any = context ? __xmlGetExports(context) : undefined;\n${guarded(out, v, 'undefined')}\n}`);
		if (kind === 'itemTemplate') {
			const name = `__xmlTemplate${n}`;
			exported.push(`export const ${name}: () => __xmlView = () => ${parse}();`);
			folded.set(site, { kind, name });
		} else folded.set(site, { kind, name: parse });
	}
	if (!folded.size) return { source: '', folded, runtime };
	const source = `${emit.head(bindingsSpec)}\n${[...emit.functions, ...exported].join('\n\n')}\n`;
	return { source, folded, runtime };
}

/**
 * A check module (`NS_XML_TREE_DUMP`): once the app runs, every file with a factory is built through `Builder.load` with
 * its factory and again with the factory removed (the Builder parsing the text), and the two trees are printed as text and
 * compared: class, source position, attributes as properties, listeners, bindings, templates (built), children.
 */
export function treeDumpModule(plan: XmlPlan, pages: PagesModule): string {
	const names = new Set<string>();
	const events = new Set(['bindingContextChange', 'propertyChange', 'loaded', 'unloaded']);
	const visit = (e: ElementPlan | null | undefined): void => {
		if (!e) return;
		for (const a of e.attributes) {
			const n = a.target.split('.').pop()!;
			if (a.kind === 'event' || a.binding?.event) events.add(n);
			else {
				names.add(n);
				events.add(`${n}Change`);
			}
		}
		e.children.forEach(visit);
		for (const p of e.properties) {
			names.add(p.name);
			visit(p.root);
			p.templates?.forEach((t) => visit(t.root));
			p.children?.forEach(visit);
		}
	};
	plan.pages.forEach((p) => visit(p.root));
	const style = ['color', 'backgroundColor', 'fontSize', 'fontWeight', 'fontFamily', 'textAlignment', 'paddingTop', 'paddingLeft', 'marginTop', 'marginLeft', 'height', 'width', 'visibility', 'opacity', 'horizontalAlignment', 'verticalAlignment', 'borderRadius'];
	const list = pages.pages.map((f) => `[${JSON.stringify(f)}, ${JSON.stringify(plan.pages.find((p) => p.file === f)!.module)}, ${pages.factories.get(f)}${pages.owned.has(f) ? `, ${JSON.stringify(pages.owned.get(f))}` : ''}]`);
	return `import { Builder } from '@nativescript/core';
import { resolveModuleName } from '@nativescript/core/module-name-resolver';
import { Source } from '@nativescript/core/utils/debug';
import { ${[...pages.factories.values()].join(', ')} } from './__xml_pages';

const NAMES: string[] = ${JSON.stringify([...names].sort())};
const STYLE: string[] = ${JSON.stringify(style)};
const EVENTS: string[] = ${JSON.stringify([...events].sort())};
const PAGES: any[] = [${list.join(', ')}];

function fmt(x: any): string {
  if (x === undefined) return 'undefined';
  if (x === null) return 'null';
  const t = typeof x;
  if (t === 'string') return JSON.stringify(x);
  if (t === 'number' || t === 'boolean') return String(x);
  if (t === 'function') return 'function';
  if (Array.isArray(x)) return '[' + x.length + ']';
  // A view's text holds its id, which differs between two builds of one tree.
  return (x.typeName ? String(x.typeName) : 'object') + ':' + String(x).replace(/\\(\\d+\\)/g, '(#)');
}

function dump(v: any, depth: number, out: string[]): void {
  const pad = '  '.repeat(depth);
  if (v === undefined || v === null || typeof v !== 'object') {
    out.push(pad + fmt(v));
    return;
  }
  const source: any = Source.get(v);
  out.push(pad + String(v.typeName) + ' @' + (source ? String(source) : 'none') + ' module=' + fmt(v._moduleName) + ' exports=' + typeof v.exports + ' id=' + fmt(v.id) + ' class=' + fmt(v.className));
  for (const k of NAMES) {
    let x: any;
    try { x = v[k]; } catch (err) { x = 'threw ' + err; }
    if (x !== undefined) out.push(pad + '  .' + k + '=' + fmt(x));
  }
  const st = v.style;
  if (st && typeof st === 'object') for (const k of STYLE) { const x = st[k]; if (x !== undefined) out.push(pad + '  style.' + k + '=' + fmt(x)); }
  if (typeof v.hasListeners === 'function') {
    const observers = v._observers;
    for (const e of EVENTS) if (v.hasListeners(e)) out.push(pad + '  on ' + e + ' x' + (observers && observers[e] ? observers[e].length : '?'));
  }
  const bindings = v.bindings;
  if (bindings && typeof bindings.forEach === 'function') {
    const lines: string[] = [];
    bindings.forEach((b: any, key: any) => lines.push(pad + '  bind ' + String(key) + ' ' + fmt(b.options && b.options.sourceProperty) + ' ' + fmt(b.options && b.options.expression) + ' ' + fmt(b.options && b.options.twoWay) + ' compiled=' + typeof (b.options && b.options.compiled)));
    lines.sort().forEach((l) => out.push(l));
  }
  if (typeof v.itemTemplate === 'function') {
    out.push(pad + '  itemTemplate()');
    try { dump(v.itemTemplate(), depth + 2, out); } catch (err) { out.push(pad + '    threw ' + err); }
  }
  if (Array.isArray(v.itemTemplates)) for (const t of v.itemTemplates) {
    out.push(pad + '  template ' + fmt(t.key));
    try { dump(t.createView(), depth + 2, out); } catch (err) { out.push(pad + '    threw ' + err); }
  }
  const items = v.actionItems && typeof v.actionItems.getItems === 'function' ? v.actionItems.getItems() : null;
  if (items) for (const i of items) { out.push(pad + '  actionItem'); dump(i, depth + 2, out); }
  const spans = v.formattedText && v.formattedText.spans;
  if (spans && typeof spans.forEach === 'function') spans.forEach((s: any) => { out.push(pad + '  span'); dump(s, depth + 2, out); });
  if (typeof v.eachChild === 'function') v.eachChild((c: any) => { dump(c, depth + 1, out); return true; });
}

function build(module: string): string[] {
  const out: string[] = [];
  try {
    const code = resolveModuleName(module, '');
    const exports = code ? (global as any).loadModule(code) : null;
    dump(Builder.load(module, exports), 0, out);
  } catch (err) {
    out.push('threw ' + err);
  }
  return out;
}

setTimeout(() => {
  let equal = 0;
  const differ: string[] = [];
  for (const [file, module, factory, codeModule] of PAGES) {
    const built = build(module);
    __nsRegisterPage(file, undefined);
    const parsed = build(module);
    __nsRegisterPage(file, factory, codeModule, codeModule ? (global as any).loadModule(codeModule) : undefined);
    const a = built.join('\\n'), b = parsed.join('\\n');
    if (a === b) {
      equal++;
      console.log('XMLTREE ' + file + ' equal ' + built.length + ' lines');
    } else {
      differ.push(file);
      console.log('XMLTREE ' + file + ' DIFF');
      for (let i = 0; i < Math.max(built.length, parsed.length); i++) if (built[i] !== parsed[i]) console.log('XMLTREE   ' + i + ' factory: ' + built[i] + ' | builder: ' + parsed[i]);
    }
    for (const l of built) console.log('XMLDUMP ' + file + ' ' + l);
  }
  console.log('XMLTREE-RESULT pages=' + PAGES.length + ' equal=' + equal + ' differ=' + differ.length + (differ.length ? ' ' + differ.join(',') : ''));
}, 1500);
export {};
`;
}
