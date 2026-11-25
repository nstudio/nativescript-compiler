// The build-time page plan of a plain XML app: each XML file parsed by core's own `xml` module and each `{{ }}` by core's
// own `getBindingOptions`, walked the way core's Builder walks them (`ui/builder/index.ts` ComponentParser,
// `component-builder/index.ts`), with the target platform's blocks and attribute prefixes resolved. Also the app code's
// run-time XML sites (`Builder.parse`/`load`, template strings, `bind({ expression })`, `moduleName`). A debug artifact:
// `NS_XML_PLAN=<file>` writes it; nothing of it reaches app output.
import ts from 'typescript';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { byName, compareText } from '../program/order.ts';

export type PlanPlatform = 'ios' | 'android';

export interface XmlPlan {
	version: 1;
	platform: PlanPlatform;
	/** The target's pages; a file qualified for the other platform (`page.android.xml` on iOS) is in `excluded` instead. */
	pages: PagePlan[];
	excluded: string[];
	/** Per module name, the variants core's qualifier matcher chooses among on the device. */
	modules: ModuleVariants[];
	/** App code that hands XML or binding text to core at run time. */
	dynamic: DynamicSite[];
	/** The XML text of each constant `Builder.parse`/`itemTemplate`/`itemTemplates` site, planned as the Builder parses it. */
	texts: TextPlan[];
	/** Where core itself loads XML at run time, by module name or from text. */
	coreSites: CoreSite[];
	counts: PlanCounts;
}

/**
 * Only the platform is decided at build time. Orientation and size qualifiers (`land`, `port`, `minWH600`, `minW…`,
 * `minH…`) are the device's, and core ranks them above the platform one (`page.land.xml` beats `page.ios.xml`), so every
 * variant for the target stays an alternative, the target's own platform-qualified files included.
 */
export interface ModuleVariants {
	module: string;
	xml: Variant[];
	code: Variant[];
	css: Variant[];
}

export interface Variant {
	file: string;
	/** Empty for the unqualified file. */
	qualifiers: string[];
}

export interface CoreSite {
	/** Relative to core's folder. */
	file: string;
	line: number;
	/** `Class.method` or the function holding the call. */
	in: string;
	call: string;
	/** moduleName: resolves a module name to XML/code/CSS (`createViewFromEntry`, `load`, `resolveModuleName`); text: parses XML text. */
	by: 'moduleName' | 'text';
}

export interface PagePlan {
	/** Relative to the app folder: `main-page.xml`, `components/badge.xml`. */
	file: string;
	/** The name `resolveModuleName` finds this file under, qualifiers removed (`main-page`). */
	module: string;
	/** File-name qualifiers (`land`, `minWH600`, `ios`); the alternatives are in `XmlPlan.modules`. */
	qualifiers: string[];
	/** The unqualified (or target-platform) code-behind and stylesheet, or null; device-qualified ones are in `XmlPlan.modules`. */
	codeBehind: string | null;
	css: string | null;
	lines: number;
	root: ElementPlan | null;
	/** Platform blocks and prefixed attributes, those dropped for the target included. */
	platformBlocks: { platform: string; line: number; kept: boolean }[];
	droppedAttributes: { element: string; name: string; offset: number }[];
	/** A parse error or a template without exactly one root: the builder throws where this file loads. */
	errors: string[];
}

export type ElementKind = 'core' | 'custom-class' | 'custom-xml' | 'unknown';

export interface ElementPlan {
	tag: string;
	prefix?: string;
	namespace?: string;
	/** `line`/`column` of the `<`, 1-based, as core's parser reports them (`ParserEvent.position`); `offset` 0-based in the file. */
	line: number;
	column: number;
	offset: number;
	kind: ElementKind;
	/**
	 * core: the class of `@nativescript/core/ui`; custom-class: the export `name` of the app module `file`;
	 * custom-xml: the component's XML `file` and its code module `code` (null: the use site's exports).
	 */
	component: { name: string; module: string; file?: string | null; code?: string | null };
	/** The module whose exports the element's event attributes resolve against (`codeFile`/`import` or the context), or null. */
	exports: string | null;
	/** `codeFile`/`import`/`cssFile`, resolved relative to the app folder (`resolved` null: the builder throws). */
	codeFile?: { spec: string; resolved: string | null };
	cssFile?: { spec: string; resolved: string | null };
	/** The element is inside a template (its bindings take the item's context). */
	inTemplate: boolean;
	/** Platform block the element sits in, if any. */
	platform?: string;
	/** An attribute name has a prefix (`ios:text`, `xmlns:x`), kept or dropped. */
	prefixed?: true;
	attributes: AttributePlan[];
	/** In source order; each attaches to this element at its start tag (`_addChildFromBuilder`). */
	children: ElementPlan[];
	properties: PropertyPlan[];
}

export type AttributeKind = 'literal' | 'binding' | 'event' | 'function';

export interface AttributePlan {
	/** As written: `ios:visibility`, `style.color`. */
	name: string;
	/** Prefix removed, dotted path kept: `visibility`, `style.color`. */
	target: string;
	platform?: PlanPlatform;
	kind: AttributeKind;
	value: string;
	/** 0-based offset of the attribute name in the file. */
	offset: number;
	/** `file:line:column:name` of the element and attribute, which the run-time builder can form from its parser event. */
	key: string;
	binding?: BindingPlan;
	/** event / function: the export named, looked up on `module` (`found`: the module exports it). */
	handler?: { name: string; module: string | null; found: boolean };
}

export interface BindingPlan {
	/** The text between `{{` and `}}`, trimmed, as the builder hands it to `getBindingOptions`. */
	source: string;
	form: 'name' | 'path' | 'expression' | 'long';
	sourceProperty: string;
	expression?: string;
	twoWay: boolean;
	/** `tap="{{ onTap }}"`: a binding on an event name, which yields the handler. */
	event: boolean;
	/** The long form's `source = …`, which the Builder passes to `bind` as the source. */
	bindingSource?: string;
	usesValue: boolean;
	usesParent: boolean;
	/** Each `$parents[...]` index as written (`'ListView'`, `0`). */
	parents: string[];
	converters: string[];
}

export interface PropertyPlan {
	/** `itemTemplate` of `<ListView.itemTemplate>`. */
	name: string;
	tag: string;
	line: number;
	/** 0-based offset of the property element's `<`, which orders it among the owner's children. */
	offset: number;
	/** template: `root` built per call; templates: keyed roots; collection: `_addArrayFromBuilder`; property: each child set or added. */
	kind: 'template' | 'templates' | 'collection' | 'property';
	root?: ElementPlan | null;
	templates?: { key: string | undefined; line: number; root: ElementPlan | null }[];
	children?: ElementPlan[];
	/** The end tag's position, where the parser hands the property its items. */
	end?: { line: number; column: number };
}

export interface DynamicSite {
	file: string;
	line: number;
	/** The site's node in the source file's text: the call, the assigned value, the options object or the property. */
	start: number;
	end: number;
	kind: 'Builder.parse' | 'Builder.load' | 'Builder.parseMultipleTemplates' | 'itemTemplate' | 'itemTemplates' | 'bind' | 'moduleName';
	/** The text is a build-time constant (a literal, or typed as a string literal type). */
	literal: boolean;
	value?: string;
}

export interface TextPlan {
	/** Index of the site in `XmlPlan.dynamic`. */
	site: number;
	/**
	 * The text as core parses it: `Builder.parse`'s and `itemTemplate`'s as is; `itemTemplates`' inside the
	 * `<ListView><ListView.itemTemplates>…` that `parseMultipleTemplates` wraps it in. Its `file` is `<source file>@<start>`.
	 */
	page: PagePlan;
}

export interface PlanCounts {
	files: number;
	lines: number;
	elements: { core: number; custom: number; unknown: number };
	platformBlocks: number;
	bindings: { total: number; name: number; path: number; expression: number; long: number; event: number; value: number; parent: number; converter: number; inTemplate: number };
	templates: { itemTemplate: number; itemTemplates: number; template: number };
	events: { toExport: number; other: number };
	prefixedAttributes: number;
	qualifiedFiles: number;
	dottedAttributes: number;
	dynamic: Record<string, { literal: number; other: number }>;
}

export interface CoreXml {
	XmlParser: new (onEvent: (e: any) => void, onError: (e: Error, p: any) => void, processNamespaces: boolean) => { parse(text: string): void };
	getBindingOptions: (name: string, value: string) => Record<string, any>;
	sites: CoreSite[];
}

const KNOWN_TEMPLATES = new Set(['itemTemplate']);
const KNOWN_MULTI_TEMPLATES = new Set(['itemTemplates']);
const KNOWN_COLLECTIONS = new Set(['items', 'spans', 'actionItems']);
const GESTURES = new Set(['tap', 'doubletap', 'pinch', 'pan', 'swipe', 'rotation', 'longpress', 'touch']);
const PLATFORM_TAGS = new Set(['android', 'ios', 'visionos', 'apple']);
const QUALIFIER = /^(ios|android|land|port|minWH\d+|minW\d+|minH\d+)$/;
const DEFAULT_NAMESPACE = /tns\.xsd$/i;

/** Default `@nativescript/core` source dir when running checks without an explicit path. */
function defaultCoreDir(): string {
	const inMonorepo = fileURLToPath(new URL('../../../core/', import.meta.url));
	const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
	const candidates = [process.env.NS_CORE_REPO && join(process.env.NS_CORE_REPO, 'packages/core'), inMonorepo, join(repoRoot, 'core/packages/core'), join(repoRoot, '../../NativeScript/NativeScript/packages/core')].filter((c): c is string => !!c);
	return candidates.find((c) => existsSync(join(c, 'package.json'))) ?? inMonorepo;
}

/** Core's `xml` and `binding-builder` modules, run in node from core's sources. */
export async function loadCoreXml(coreDir = defaultCoreDir()): Promise<CoreXml> {
	const source = (f: string) => {
		const file = [f + '.ts', f + '.js'].map((x) => join(coreDir, x)).find(existsSync);
		if (!file) throw new Error(`${join(coreDir, f)}: not found`);
		return ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
	};
	const url = (js: string) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
	const easysax = url(source('js-libs/easysax/easysax'));
	const xml = await import(url(source('xml/index').replace(/(['"])\.\.\/js-libs\/easysax\/easysax(\.js)?\1/, JSON.stringify(easysax))));
	const bindings = await import(url(source('ui/builder/binding-builder')));
	return { XmlParser: xml.XmlParser, getBindingOptions: bindings.getBindingOptions, sites: coreSites(coreDir) };
}

const BY_NAME = new Set(['createViewFromEntry', 'load', 'loadInternal', 'loadCustomComponent', 'resolveModuleName']);
const BY_TEXT = new Set(['parse', 'parseMultipleTemplates', 'parseInternal']);

/** Core's calls that load XML at run time: `Builder.*` entry points, and the builder's own module-name resolution. */
function coreSites(coreDir: string): CoreSite[] {
	const sites: CoreSite[] = [];
	const walk = (dir: string): string[] =>
		readdirSync(dir, { withFileTypes: true })
			.sort(byName)
			.flatMap((d) => (d.isDirectory() ? (d.name === 'node_modules' ? [] : walk(join(dir, d.name))) : /\.ts$/.test(d.name) && !/\.(d|spec)\.ts$/.test(d.name) ? [join(dir, d.name)] : []));
	for (const file of walk(coreDir)) {
		const text = readFileSync(file, 'utf8');
		if (!/\b(Builder\.|loadInternal|loadCustomComponent|resolveModuleName|parseInternal)/.test(text)) continue;
		const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
		const holder = (n: ts.Node): string => {
			const names: string[] = [];
			let variable: string | undefined;
			for (let p = n.parent; p; p = p.parent) {
				if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p) || ts.isClassDeclaration(p) || ts.isPropertyDeclaration(p)) && p.name) names.unshift(p.name.getText(sf));
				else if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) variable = p.name.text;
			}
			return names.join('.') || variable || '(module)';
		};
		const visit = (n: ts.Node): void => {
			if (ts.isCallExpression(n)) {
				const callee = n.expression;
				const name = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'Builder' ? callee.name.text : ts.isIdentifier(callee) && /^(loadInternal|loadCustomComponent|resolveModuleName|parseInternal)$/.test(callee.text) ? callee.text : undefined;
				// `resolveModuleName(path, '')` finds code modules too; only XML and CSS lookups are the builder's.
				const ext = name === 'resolveModuleName' ? n.arguments[1] : undefined;
				const xmlLookup = name !== 'resolveModuleName' || (ext && ts.isStringLiteral(ext) && /^(xml|css)$/.test(ext.text));
				if (name && (BY_NAME.has(name) || BY_TEXT.has(name)) && xmlLookup) {
					sites.push({ file: relative(coreDir, file).split('\\').join('/'), line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, in: holder(n), call: callee.getText(sf), by: BY_NAME.has(name) ? 'moduleName' : 'text' });
				}
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
	}
	return sites.sort((a, b) => compareText(a.file, b.file) || a.line - b.line);
}

/** Each attribute's name offset in the start tag at `start` (the `<`). */
function attributeOffsets(text: string, start: number): Map<string, number> {
	const offsets = new Map<string, number>();
	let i = start + 1;
	while (i < text.length && !/[\s/>]/.test(text[i])) i++;
	for (; i < text.length && text[i] !== '>';) {
		const m = /^\s*([^\s=/>]+)\s*=\s*("[^"]*"|'[^']*')/.exec(text.slice(i, i + 4096));
		if (!m) {
			i++;
			continue;
		}
		const at = i + m[0].indexOf(m[1]);
		if (!offsets.has(m[1])) offsets.set(m[1], at);
		i += m[0].length;
	}
	return offsets;
}

function bindingPlan(core: CoreXml, name: string, value: string, event: boolean): BindingPlan {
	// `getBindingExpressionFromAttribute` of component-builder.
	const source = value.replace('{{', '').replace('}}', '').trim();
	const o = core.getBindingOptions(name, source);
	const sourceProperty = String(o.sourceProperty);
	const expression = o.expression === undefined ? undefined : String(o.expression);
	const form = expression !== undefined ? (sourceProperty === '$value' ? 'expression' : 'long') : /[.[]/.test(sourceProperty) ? 'path' : 'name';
	const code = (expression ?? sourceProperty).replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, "''");
	return {
		source,
		form,
		sourceProperty,
		...(expression !== undefined ? { expression } : {}),
		twoWay: o.twoWay === true,
		event,
		...(o.source !== undefined ? { bindingSource: String(o.source) } : {}),
		usesValue: /\$value\b/.test(code),
		usesParent: /\$parent\b(?!s)/.test(code),
		parents: [...(expression ?? sourceProperty).matchAll(/\$parents\s*\[\s*([^\]]*?)\s*\]/g)].map((m) => m[1]),
		converters: [...code.matchAll(/(?<!\|)\|(?!\|)\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
	};
}

interface Resolver {
	/** An app file for a module name and extensions, relative to the app folder, as `resolveModuleName` finds it. */
	file(name: string, exts: string[]): string | null;
	/** The export names of an app module, or null if the program does not hold it. */
	exports(file: string): Set<string> | null;
	/** The class an element names: its static members, or null if there is none. */
	statics(module: { core: true } | { file: string }, name: string): Set<string> | null;
}

/** `sanitizeModuleName`: `~/x`, `/x`, `./x` name the app's `x`. */
const sanitize = (spec: string) =>
	spec
		.trim()
		.replace(/^~\//, '')
		.replace(/^\.?\//, '')
		.replace(/\.(xml|css|scss|ts|js)$/, '');

/** A file's module name and its qualifiers (`main-page.land.ios.xml`: `main-page`, `land`, `ios`), as `stripQualifiers` reads them. */
function qualified(file: string): { module: string; qualifiers: string[] } {
	const parts = file.replace(/\.(xml|ts|js|css|scss)$/, '').split('.');
	const qualifiers: string[] = [];
	while (parts.length > 1 && QUALIFIER.test(parts[parts.length - 1])) qualifiers.unshift(parts.pop()!);
	return { module: parts.join('.'), qualifiers };
}

/** `asText`: XML text handed to the Builder, which has no module of its own (no code-behind or stylesheet). */
function pagePlan(core: CoreXml, file: string, text: string, platform: PlanPlatform, resolve: Resolver, asText = false): PagePlan {
	const { module, qualifiers } = asText ? { module: file, qualifiers: [] } : qualified(file);
	const codeBehind = asText ? null : resolve.file(module, ['ts', 'js']);
	const plan: PagePlan = {
		file,
		module,
		qualifiers,
		codeBehind,
		css: asText ? null : resolve.file(module, ['css', 'scss']),
		lines: text.split('\n').length - (text.endsWith('\n') ? 1 : 0),
		root: null,
		platformBlocks: [],
		droppedAttributes: [],
		errors: [],
	};
	const lineStarts = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
	const offsetOf = (p: { line: number; column: number }) => lineStarts[p.line - 1] + p.column - 1;

	// The ComponentParser's state: open elements, open complex properties, open templates, and the context exports module.
	const parents: ElementPlan[] = [];
	const complex: { property: PropertyPlan; parent: ElementPlan | undefined; depth: number; open: boolean }[] = [];
	const templates: { set: (root: ElementPlan) => void; depth: number; roots: number }[] = [];
	let platformBlock: { name: string; kept: boolean } | undefined;
	let context: string | null = codeBehind;

	const element = (e: any, inTemplate: boolean): ElementPlan => {
		const offset = offsetOf(e.position);
		const offsets = attributeOffsets(text, offset);
		const custom = !!(e.prefix && e.namespace);
		const ns = custom || (e.namespace && !DEFAULT_NAMESPACE.test(e.namespace)) ? e.namespace : undefined;
		let kind: ElementKind = 'unknown';
		let component: ElementPlan['component'];
		let statics: Set<string> | null = null;
		const raw: Record<string, string> = e.attributes ?? {};
		const codeSpec = raw.codeFile ?? raw.import;
		const codeFile = codeSpec !== undefined ? { spec: codeSpec, resolved: resolve.file(sanitize(codeSpec), ['ts', 'js']) } : undefined;
		const cssFile = raw.cssFile !== undefined ? { spec: raw.cssFile, resolved: resolve.file(sanitize(raw.cssFile), ['css', 'scss']) } : undefined;
		let exportsModule = codeFile?.resolved ?? context;
		if (custom) {
			const name = `${sanitize(e.namespace)}/${e.elementName}`;
			const xmlFile = resolve.file(name, ['xml']);
			if (xmlFile) {
				kind = 'custom-xml';
				component = { name: e.elementName, module: name, file: xmlFile, code: resolve.file(name, ['ts', 'js']) };
			} else {
				const moduleFile = resolve.file(sanitize(e.namespace), ['ts', 'js']);
				component = { name: e.elementName, module: sanitize(e.namespace), file: moduleFile };
				statics = moduleFile ? resolve.statics({ file: moduleFile }, e.elementName) : null;
				kind = statics ? 'custom-class' : 'unknown';
			}
		} else {
			// `getComponentModule`: `list-view` names `ListView`.
			const name = e.elementName
				.split('-')
				.map((s: string) => s[0].toUpperCase() + s.substring(1))
				.join('');
			if (ns) {
				const moduleFile = resolve.file(sanitize(ns), ['ts', 'js']);
				component = { name, module: sanitize(ns), file: moduleFile };
				statics = moduleFile ? resolve.statics({ file: moduleFile }, name) : null;
				kind = statics ? 'custom-class' : 'unknown';
			} else {
				component = { name, module: '@nativescript/core/ui' };
				statics = resolve.statics({ core: true }, name);
				kind = statics ? 'core' : 'unknown';
			}
		}
		// `loadCustomComponent` applies the use site's attributes against the use site's context, not the component's code module.
		if (kind === 'custom-xml') exportsModule = context;
		const pos = `${file}:${e.position.line}:${e.position.column}`;
		const attributes: AttributePlan[] = [];
		for (const [name, value] of Object.entries(raw)) {
			const at = offsets.get(name) ?? offset;
			let target = name;
			let attrPlatform: PlanPlatform | undefined;
			if (name.includes(':')) {
				// `applyComponentAttributes`: any prefix other than the running platform's drops the attribute (`xmlns:my` too).
				const prefix = name.split(':')[0].trim();
				if (prefix.toLowerCase() !== platform) {
					plan.droppedAttributes.push({ element: e.elementName, name, offset: at });
					continue;
				}
				target = name.split(':')[1].trim();
				attrPlatform = platform;
			}
			const dotted = target.includes('.');
			const leaf = dotted ? target.split('.').pop()! : target;
			// `isEventOrGesture` asks the instance's class; a dotted attribute's holder is some other object.
			const eventName = leaf.startsWith('on') ? leaf.slice(2) : leaf;
			const isEvent = !dotted && ((statics?.has(`${eventName}Event`) ?? false) || GESTURES.has(eventName.trim().toLowerCase()));
			const isBinding = value.trim().startsWith('{{') && value.trim().lastIndexOf('}}') === value.trim().length - 2;
			const a: AttributePlan = { name, target, ...(attrPlatform ? { platform: attrPlatform } : {}), kind: 'literal', value, offset: at, key: `${pos}:${name}` };
			const handler = () => ({ name: value, module: exportsModule, found: !!exportsModule && !!resolve.exports(exportsModule)?.has(value) });
			// A dotted attribute's holder (`style`, `ios`) has no `bind`: its `{{ }}` text is set as is.
			if (isBinding && !dotted && kind !== 'unknown') {
				a.kind = 'binding';
				a.binding = bindingPlan(core, leaf, value, isEvent);
			} else if (isEvent) {
				a.kind = 'event';
				a.handler = handler();
			} else if (!dotted && statics?.has('knownFunctions') && knownFunctions(component.name).includes(leaf) && handler().found) {
				a.kind = 'function';
				a.handler = handler();
			}
			attributes.push(a);
		}
		return {
			tag: e.elementName,
			...(e.prefix ? { prefix: e.prefix } : {}),
			...(e.namespace ? { namespace: e.namespace } : {}),
			line: e.position.line,
			column: e.position.column,
			offset,
			kind,
			component: component!,
			exports: exportsModule,
			...(codeFile ? { codeFile } : {}),
			...(cssFile ? { cssFile } : {}),
			inTemplate,
			...(platformBlock ? { platform: platformBlock.name } : {}),
			...(Object.keys(raw).some((n) => n.includes(':')) ? { prefixed: true as const } : {}),
			attributes,
			children: [],
			properties: [],
		};
	};

	const onEvent = (e: any) => {
		if (e.eventType !== 'StartElement' && e.eventType !== 'EndElement') return;
		const start = e.eventType === 'StartElement';
		// PlatformFilter.
		if (PLATFORM_TAGS.has(String(e.elementName).toLowerCase())) {
			const name = e.elementName.toLowerCase();
			if (start) {
				if (platformBlock) throw new Error(`Already in '${platformBlock.name}' platform context and cannot switch to '${e.elementName}' platform! Platform tags cannot be nested.`);
				platformBlock = { name, kept: name === platform || (name === 'apple' && platform === 'ios') };
				plan.platformBlocks.push({ platform: name, line: e.position.line, kept: platformBlock.kept });
			} else platformBlock = undefined;
			return;
		}
		if (platformBlock && !platformBlock.kept) return;
		const prop = complex[complex.length - 1];
		const top = templates[templates.length - 1];
		const closeTemplate = (line: number) => {
			if (templates.pop()?.roots === 0) plan.errors.push(`${file}:${line}: Template must have exactly one root element but none was found.`);
		};
		// MultiTemplateParser: directly inside `<X.itemTemplates>`, only `<template key>` counts, opening one template.
		const atTemplates = prop?.property.kind === 'templates' && prop.depth === parents.length && !prop.open;
		if (start) {
			if (atTemplates) {
				if (e.elementName === 'template') {
					const t: { key: string | undefined; line: number; root: ElementPlan | null } = { key: e.attributes?.key, line: e.position.line, root: null };
					prop.property.templates!.push(t);
					prop.open = true;
					templates.push({ set: (root) => (t.root = root), depth: 0, roots: 0 });
				}
				return;
			}
			if (String(e.elementName).includes('.')) {
				const name = e.elementName.split('.').pop();
				const parent = parents[parents.length - 1];
				const kind = KNOWN_TEMPLATES.has(name) ? 'template' : KNOWN_MULTI_TEMPLATES.has(name) ? 'templates' : KNOWN_COLLECTIONS.has(name) ? 'collection' : 'property';
				const property: PropertyPlan = { name, tag: e.elementName, line: e.position.line, offset: offsetOf(e.position), kind, ...(kind === 'template' ? { root: null } : kind === 'templates' ? { templates: [] } : { children: [] }) };
				parent?.properties.push(property);
				complex.push({ property, parent, depth: parents.length, open: false });
				if (kind === 'template') templates.push({ set: (root) => (property.root = root), depth: 0, roots: 0 });
				return;
			}
			const el = element(e, templates.length > 0);
			if (top && top.depth === 0) {
				if (++top.roots > 1) plan.errors.push(`${file}:${e.position.line}: Template must have exactly one root element but multiple elements were found.`);
				top.set(el);
			} else if (prop && prop.property.children && prop.depth === parents.length) prop.property.children.push(el);
			else if (parents.length) parents[parents.length - 1].children.push(el);
			else if (!plan.root) {
				plan.root = el;
				if (el.codeFile?.resolved) context = el.codeFile.resolved;
			}
			if (top) top.depth++;
			parents.push(el);
			return;
		}
		if (prop?.property.kind === 'templates' && prop.depth === parents.length) {
			if (prop.open && e.elementName === 'template') {
				prop.open = false;
				closeTemplate(e.position.line);
				return;
			}
			if (!prop.open && !String(e.elementName).includes('.')) return;
		}
		if (String(e.elementName).includes('.')) {
			const closed = complex.pop()?.property;
			if (closed) closed.end = { line: e.position.line, column: e.position.column };
			if (closed?.kind === 'template') closeTemplate(e.position.line);
			return;
		}
		if (top) top.depth--;
		parents.pop();
	};
	try {
		new core.XmlParser(
			onEvent,
			(err: Error, p: any) => {
				throw new Error(`Parsing XML at ${p?.line}:${p?.column}: ${err.message}`);
			},
			true,
		).parse(text);
	} catch (err) {
		plan.errors.push(`${file}: ${(err as Error).message}`);
	}
	return plan;
}

/** `knownFunctions` of core's ListView and Repeater: attributes that take a code-behind function (`itemTemplateSelector`). */
function knownFunctions(name: string): string[] {
	return name === 'ListView' ? ['itemTemplateSelector', 'itemIdGenerator'] : name === 'Repeater' ? ['itemTemplateSelector'] : [];
}

/**
 * The string a build-time constant expression evaluates to, or undefined: literals, `+` and substitution templates of
 * constants, `const`s initialized to one, and expressions typed as a string literal type.
 */
export function constantString(checker: ts.TypeChecker, e: ts.Expression | undefined): string | undefined {
	const fold = (e: ts.Expression, seen: Set<ts.Node>): string | undefined => {
		if (ts.isStringLiteralLike(e)) return e.text;
		if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) return fold(e.expression, seen);
		if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
			const l = fold(e.left, seen),
				r = l === undefined ? undefined : fold(e.right, seen);
			return r === undefined ? undefined : l! + r;
		}
		if (ts.isTemplateExpression(e)) {
			let out = e.head.text;
			for (const span of e.templateSpans) {
				const v = fold(span.expression, seen);
				if (v === undefined) return undefined;
				out += v + span.literal.text;
			}
			return out;
		}
		if (ts.isIdentifier(e)) {
			const d = checker.getSymbolAtLocation(e)?.valueDeclaration;
			if (d && ts.isVariableDeclaration(d) && d.initializer && !seen.has(d) && ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const) return fold(d.initializer, new Set(seen).add(d));
		}
		const t = checker.getTypeAtLocation(e);
		return t.isStringLiteral() ? t.value : undefined;
	};
	return e && fold(e, new Set());
}

function dynamicSites(appDir: string, sources: ts.SourceFile[], checker: ts.TypeChecker): DynamicSite[] {
	const sites: DynamicSite[] = [];
	const constant = (e: ts.Expression | undefined): { literal: boolean; value?: string } => {
		const value = constantString(checker, e);
		return value === undefined ? { literal: false } : { literal: true, value };
	};
	for (const sf of sources) {
		const file = relative(appDir, sf.fileName).split('\\').join('/');
		const add = (n: ts.Node, kind: DynamicSite['kind'], c: { literal: boolean; value?: string }, at: ts.Node = n) => sites.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, start: at.getStart(sf), end: at.getEnd(), kind, ...c });
		const visit = (n: ts.Node): void => {
			if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
				const m = n.expression.name.text;
				const owner = n.expression.expression;
				if (/^(parse|load|parseMultipleTemplates)$/.test(m) && ts.isIdentifier(owner) && checker.getSymbolAtLocation(owner)?.getName() === 'Builder') {
					const arg = n.arguments[0];
					const path = arg && ts.isObjectLiteralExpression(arg) ? arg.properties.find((p) => p.name && ts.isIdentifier(p.name) && p.name.text === 'path') : undefined;
					add(n, `Builder.${m}` as DynamicSite['kind'], path && ts.isPropertyAssignment(path) ? constant(path.initializer) : constant(arg));
				}
				if (m === 'bind' && n.arguments[0] && ts.isObjectLiteralExpression(n.arguments[0])) {
					const p = n.arguments[0].properties.find((q) => q.name && ts.isIdentifier(q.name) && q.name.text === 'expression');
					if (p) add(n, 'bind', ts.isPropertyAssignment(p) ? constant(p.initializer) : { literal: false }, n.arguments[0]);
				}
			}
			if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left) && /^itemTemplates?$/.test(n.left.name.text)) {
				const t = checker.getTypeAtLocation(n.right);
				if (t.flags & ts.TypeFlags.StringLike) add(n, n.left.name.text as DynamicSite['kind'], constant(n.right), n.right);
			}
			if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === 'moduleName') add(n, 'moduleName', constant(n.initializer));
			if (ts.isShorthandPropertyAssignment(n) && n.name.text === 'moduleName') {
				const d = checker.getShorthandAssignmentValueSymbol(n)?.valueDeclaration;
				add(n, 'moduleName', d && ts.isVariableDeclaration(d) && ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const ? constant(d.initializer) : { literal: false });
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
	}
	return sites;
}

function countPlan(pages: PagePlan[], excluded: string[], dynamic: DynamicSite[]): PlanCounts {
	const c: PlanCounts = {
		files: pages.length + excluded.length,
		lines: 0,
		elements: { core: 0, custom: 0, unknown: 0 },
		platformBlocks: 0,
		bindings: { total: 0, name: 0, path: 0, expression: 0, long: 0, event: 0, value: 0, parent: 0, converter: 0, inTemplate: 0 },
		templates: { itemTemplate: 0, itemTemplates: 0, template: 0 },
		events: { toExport: 0, other: 0 },
		prefixedAttributes: 0,
		qualifiedFiles: 0,
		dottedAttributes: 0,
		dynamic: {},
	};
	const walk = (el: ElementPlan | null | undefined) => {
		if (!el) return;
		if (el.kind === 'core') c.elements.core++;
		else if (el.kind === 'unknown') c.elements.unknown++;
		else c.elements.custom++;
		for (const a of el.attributes) {
			if (a.platform) c.prefixedAttributes++;
			if (a.target.includes('.')) c.dottedAttributes++;
			if (a.binding) {
				const b = a.binding;
				c.bindings.total++;
				c.bindings[b.form]++;
				if (b.event) c.bindings.event++;
				if (b.usesValue) c.bindings.value++;
				if (b.usesParent || b.parents.length) c.bindings.parent++;
				if (b.converters.length) c.bindings.converter++;
				if (el.inTemplate) c.bindings.inTemplate++;
			}
			if (a.kind === 'event') {
				if (a.handler?.found) c.events.toExport++;
				else c.events.other++;
			}
		}
		el.children.forEach(walk);
		for (const p of el.properties) {
			if (p.kind === 'template') c.templates.itemTemplate++;
			if (p.kind === 'templates') {
				c.templates.itemTemplates++;
				c.templates.template += p.templates!.length;
			}
			walk(p.root);
			p.templates?.forEach((t) => walk(t.root));
			p.children?.forEach(walk);
		}
	};
	for (const p of pages) {
		c.lines += p.lines;
		c.platformBlocks += p.platformBlocks.length;
		c.prefixedAttributes += p.droppedAttributes.filter((d) => /^(ios|android):/i.test(d.name)).length;
		if (p.qualifiers.length) c.qualifiedFiles++;
		walk(p.root);
	}
	for (const d of dynamic) {
		const k = (c.dynamic[d.kind] ??= { literal: 0, other: 0 });
		if (d.literal) k.literal++;
		else k.other++;
	}
	return c;
}

function fileResolver(appDir: string, platform: PlanPlatform, present: (rel: string) => boolean): Resolver['file'] {
	const file = (name: string, exts: string[]): string | null => {
		// The platform-qualified variant first, as core's matcher does for the running platform.
		for (const n of [`${name}.${platform}`, name]) for (const ext of exts) if (present(`${n}.${ext}`)) return `${n}.${ext}`;
		if (!exts.includes('ts')) return null;
		// A folder module: its package.json `main`, else its index.
		let main: string | undefined;
		try {
			main = JSON.parse(readFileSync(join(appDir, name, 'package.json'), 'utf8')).main;
		} catch {}
		return main ? file(`${name}/${main.replace(/\.(js|ts)$/, '')}`, exts) : (exts.map((e) => `${name}/index.${e}`).find(present) ?? null);
	};
	return file;
}

const forTarget = (f: string, platform: PlanPlatform) => !qualified(f).qualifiers.some((q) => (q === 'ios' || q === 'android') && q !== platform);

/**
 * The `{{ }}` attributes of an app's XML files for `platform`, without a program: every element whose module resolves
 * counts as a class with a `bind`. A key an element never reaches at run time is never looked up.
 */
export function xmlBindingSites(core: CoreXml, appDir: string, xml: { name: string; text: string }[], platform: PlanPlatform): { key: string; binding: BindingPlan }[] {
	const resolver: Resolver = { file: fileResolver(appDir, platform, (rel) => existsSync(join(appDir, rel))), exports: () => null, statics: () => new Set() };
	const sites: { key: string; binding: BindingPlan }[] = [];
	const visit = (e: ElementPlan | null | undefined): void => {
		if (!e) return;
		for (const a of e.attributes) if (a.kind === 'binding' && a.binding) sites.push({ key: a.key, binding: a.binding });
		e.children.forEach(visit);
		for (const p of e.properties) {
			visit(p.root);
			p.templates?.forEach((t) => visit(t.root));
			p.children?.forEach(visit);
		}
	};
	for (const x of [...xml].sort((a, b) => compareText(a.name, b.name))) if (forTarget(x.name, platform)) visit(pagePlan(core, x.name, x.text, platform, resolver).root);
	return sites;
}

/**
 * The plan of an app's XML files (`xml`: relative to `appDir`, with their text) against the program holding its sources.
 * Elements' classes and events come from the checker: core's from `@nativescript/core/ui`, custom ones from the app module.
 */
export function xmlPlan(core: CoreXml, appDir: string, xml: { name: string; text: string }[], program: ts.Program, platform: PlanPlatform, styles: string[] = []): XmlPlan {
	const checker = program.getTypeChecker();
	const appFiles = program.getSourceFiles().filter((sf) => sf.fileName.startsWith(appDir + '/') && !sf.fileName.includes('/node_modules/') && !sf.isDeclarationFile);
	const byRel = new Map(appFiles.map((sf) => [relative(appDir, sf.fileName).split('\\').join('/'), sf]));
	const present = (rel: string) => byRel.has(rel) || existsSync(join(appDir, rel));
	const resolver: Resolver = {
		file: fileResolver(appDir, platform, present),
		exports(file) {
			const sf = byRel.get(file);
			const sym = sf && checker.getSymbolAtLocation(sf);
			return sym ? new Set(checker.getExportsOfModule(sym).map((s) => s.getName())) : null;
		},
		statics(module, name) {
			let moduleSymbol: ts.Symbol | undefined;
			if ('core' in module) moduleSymbol = coreUi();
			else {
				const sf = byRel.get(module.file);
				moduleSymbol = sf && checker.getSymbolAtLocation(sf);
			}
			const exp = moduleSymbol && checker.getExportsOfModule(moduleSymbol).find((s) => s.getName() === name);
			if (!exp) return null;
			const target = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
			if (!(target.flags & ts.SymbolFlags.Class)) return null;
			return new Set(checker.getPropertiesOfType(checker.getTypeOfSymbol(target)).map((p) => p.getName()));
		},
	};
	let coreUiSymbol: ts.Symbol | undefined | null = null;
	const coreUi = () => {
		if (coreUiSymbol !== null) return coreUiSymbol;
		for (const spec of ['@nativescript/core/ui', '@nativescript/core']) {
			const r = ts.resolveModuleName(spec, join(appDir, '__plan.ts'), program.getCompilerOptions(), ts.sys).resolvedModule;
			const sf = r && program.getSourceFile(r.resolvedFileName);
			coreUiSymbol = sf && checker.getSymbolAtLocation(sf);
			if (coreUiSymbol) return coreUiSymbol;
		}
		return (coreUiSymbol = undefined);
	};
	const sorted = [...xml].sort((a, b) => compareText(a.name, b.name));
	const pages = sorted.filter((x) => forTarget(x.name, platform)).map((x) => pagePlan(core, x.name, x.text, platform, resolver));
	const excluded = sorted.filter((x) => !forTarget(x.name, platform)).map((x) => x.name);
	const modules = new Map<string, ModuleVariants>();
	for (const x of sorted)
		if (forTarget(x.name, platform)) {
			const { module, qualifiers } = qualified(x.name);
			const m = modules.get(module) ?? modules.set(module, { module, xml: [], code: [], css: [] }).get(module)!;
			m.xml.push({ file: x.name, qualifiers });
		}
	for (const [file, kind] of [...[...byRel.keys()].map((f) => [f, 'code'] as const), ...styles.map((f) => [f, 'css'] as const)]) {
		const { module, qualifiers } = qualified(file);
		if (forTarget(file, platform)) modules.get(module)?.[kind].push({ file, qualifiers });
	}
	const dynamic = dynamicSites(appDir, appFiles, checker);
	const texts: TextPlan[] = [];
	dynamic.forEach((d, site) => {
		if (!d.literal || d.value === undefined || !/^(Builder\.parse|itemTemplates?)$/.test(d.kind)) return;
		const text = d.kind === 'itemTemplates' ? `<ListView><ListView.itemTemplates>${d.value}</ListView.itemTemplates></ListView>` : d.value;
		texts.push({ site, page: pagePlan(core, `${d.file}@${d.start}`, text, platform, resolver, true) });
	});
	return { version: 1, platform, pages, excluded, modules: [...modules.values()], dynamic, texts, coreSites: core.sites, counts: countPlan(pages, excluded, dynamic) };
}
