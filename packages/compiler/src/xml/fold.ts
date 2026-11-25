// App code's constant XML and binding text, folded at build time: `Builder.parse(<text>)`, `itemTemplate = <text>` and
// `itemTemplates = <text>` call the text's factory (`textsModule` of xml/pages.ts) in place of the Builder's parser, and
// `bind({ expression: <text> })` passes the expression's compiled closure as `compiled`, which core's `Binding` takes in
// place of its evaluator. The app's source files are rewritten in place, keeping every line where it was. Every other
// site that hands text or a module name to core at run time is kept, and listed with the reason.
import ts from 'typescript';
import { dirname, join, relative } from 'node:path';
import { constantString, type BindingPlan, type DynamicSite, type XmlPlan } from './plan.ts';
import type { TextsModule } from './pages.ts';

/** A constant `bind({ expression })` site and the binding its closure is compiled from. */
export interface BindSite {
	site: number;
	key: string;
	binding: BindingPlan;
	/** The options object literal, and the end of its last property. */
	object: ts.ObjectLiteralExpression;
	/** Set when the site cannot be folded. */
	reason?: string;
}

const bindingOf = (expression: string, sourceProperty: string, twoWay: boolean): BindingPlan => ({
	source: expression,
	form: 'expression',
	sourceProperty,
	expression,
	twoWay,
	event: false,
	usesValue: false,
	usesParent: false,
	parents: [],
	converters: [],
});

function nodeAt(sf: ts.SourceFile, start: number, end: number): ts.Node | undefined {
	let found: ts.Node | undefined;
	const visit = (n: ts.Node): void => {
		if (found || n.getEnd() < start || n.getStart(sf) > start) return;
		if (n.getStart(sf) === start && n.getEnd() === end) found = n;
		else ts.forEachChild(n, visit);
	};
	visit(sf);
	return found;
}

const sourceFileOf = (program: ts.Program, appDir: string, d: DynamicSite) => program.getSourceFile(join(appDir, d.file));

/** The member `node` names is declared by core (`Builder.parse`, `ListViewBase.itemTemplate`, `ViewBase.bind`), not by app code. */
function fromCore(checker: ts.TypeChecker, node: ts.Node): boolean {
	let symbol = checker.getSymbolAtLocation(node);
	if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
	return !!symbol?.declarations?.length && symbol.declarations.every((d) => /[\\/](@nativescript[\\/]core|packages[\\/]core)[\\/]/.test(d.getSourceFile().fileName));
}

/**
 * The plan's constant `bind` sites. A twoWay that is not a literal `false` (or absent) needs the update closure too,
 * compiled only when `sourceProperty` is a constant, as core substitutes it in the expression text.
 */
export function bindSites(plan: XmlPlan, program: ts.Program, appDir: string): BindSite[] {
	const checker = program.getTypeChecker();
	const out: BindSite[] = [];
	plan.dynamic.forEach((d, site) => {
		if (d.kind !== 'bind' || !d.literal || d.value === undefined) return;
		const sf = sourceFileOf(program, appDir, d);
		const object = sf && nodeAt(sf, d.start, d.end);
		if (!object || !ts.isObjectLiteralExpression(object)) return;
		const call = object.parent;
		const property = (name: string) => object.properties.find((p) => p.name && ts.isIdentifier(p.name) && p.name.text === name);
		const value = (name: string) => {
			const p = property(name);
			return p && ts.isPropertyAssignment(p) ? p.initializer : undefined;
		};
		const twoWayNode = value('twoWay');
		const twoWay = !property('twoWay') ? false : twoWayNode?.kind === ts.SyntaxKind.FalseKeyword ? false : twoWayNode?.kind === ts.SyntaxKind.TrueKeyword ? true : undefined;
		const sourceProperty = constantString(checker, value('sourceProperty'));
		const back = twoWay !== false && sourceProperty !== undefined;
		const s: BindSite = { site, key: `${d.file}@${d.start}:bind`, binding: bindingOf(d.value, sourceProperty ?? '', back), object };
		if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression) || !fromCore(checker, call.expression.name)) s.reason = "the `bind` is not core's";
		else if (object.properties.some((p) => !ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p))) s.reason = 'the options object has a spread or method';
		else if (property('compiled')) s.reason = 'the options object names `compiled` itself';
		else if (!checker.getContextualType(object)?.getProperty('compiled')) s.reason = "the app's core has no `BindingOptions.compiled`";
		out.push(s);
	});
	return out;
}

export interface Folded {
	/** Rewritten app source files, by path. */
	files: Map<string, string>;
	folded: { site: number; as: string }[];
	/** Every site left to core's run time, with the reason. */
	kept: { site: number; reason: string }[];
}

/**
 * The app files with each folded site replaced. `texts`: the texts module; `binds`: the bind sites; `closures`: each
 * binding key's closure constant, as the bindings module exports it. A replacement takes the newlines of what it
 * replaces, and the imports go before the file's first line, so every line keeps its number.
 */
export function foldSites(plan: XmlPlan, program: ts.Program, appDir: string, texts: TextsModule, binds: BindSite[], closures: Map<string, string>, textsFile: string, bindingsFile: string | null): Folded {
	const edits = new Map<string, { start: number; end: number; text: string }[]>();
	const imports = new Map<string, { texts: Set<string>; bindings: Set<string> }>();
	const folded: Folded['folded'] = [];
	const kept: Folded['kept'] = [];
	const checker = program.getTypeChecker();
	const textReasons = new Map(texts.runtime.map((r) => [r.site, r.reason]));
	const bindBySite = new Map(binds.map((b) => [b.site, b]));
	const keep = (newlines: string, text: string) => text + '\n'.repeat(Math.max(0, (newlines.match(/\n/g) ?? []).length - (text.match(/\n/g) ?? []).length));
	plan.dynamic.forEach((d, site) => {
		const sf = sourceFileOf(program, appDir, d);
		const edit = (start: number, end: number, text: string, from: 'texts' | 'bindings', name: string) => {
			const file = sf!.fileName;
			(edits.get(file) ?? edits.set(file, []).get(file)!).push({ start, end, text });
			const i = imports.get(file) ?? imports.set(file, { texts: new Set(), bindings: new Set() }).get(file)!;
			i[from].add(name);
			folded.push({ site, as: name });
		};
		const fold = texts.folded.get(site);
		if (fold && sf) {
			const node = nodeAt(sf, d.start, d.end);
			const original = sf.text.slice(d.start, d.end);
			// The member the site reaches is core's: an app's own `parse` or `itemTemplate` keeps its text.
			const member = node && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node && ts.isBinaryExpression(node.parent) && ts.isPropertyAccessExpression(node.parent.left) ? node.parent.left.name : undefined;
			if (!member || !fromCore(checker, member)) return kept.push({ site, reason: `the ${fold.kind} is not core's` });
			if (fold.kind === 'Builder.parse' && node && ts.isCallExpression(node) && node.arguments.length <= 2) {
				const context = node.arguments[1] ? node.arguments[1].getText(sf) : '';
				return edit(d.start, d.end, keep(original, `${fold.name}(${context}`) + ')', 'texts', fold.name);
			}
			if (fold.kind === 'itemTemplate') return edit(d.start, d.end, keep(original, `(${fold.name}`) + ')', 'texts', fold.name);
			if (fold.kind === 'itemTemplates') return edit(d.start, d.end, keep(original, `${fold.name}(`) + ')', 'texts', fold.name);
			return kept.push({ site, reason: 'Builder.parse with more than two arguments' });
		}
		if (textReasons.has(site)) return kept.push({ site, reason: textReasons.get(site)! });
		const bind = bindBySite.get(site);
		if (bind && sf) {
			const closure = closures.get(bind.key);
			if (bind.reason || !closure || !bindingsFile) return kept.push({ site, reason: bind.reason ?? "the expression stays on core's evaluator (it does not compile to a closure)" });
			const last = bind.object.properties[bind.object.properties.length - 1];
			return edit(last.getEnd(), last.getEnd(), `, compiled: ${closure}`, 'bindings', closure);
		}
		if (d.literal && (d.kind === 'Builder.load' || d.kind === 'moduleName')) return;
		kept.push({ site, reason: d.literal ? `a constant ${d.kind} text that is not folded` : d.kind === 'moduleName' || d.kind === 'Builder.load' ? 'a module name computed at run time' : 'text computed at run time' });
	});
	const files = new Map<string, string>();
	for (const [file, list] of edits) {
		let text = program.getSourceFile(file)!.text;
		for (const e of [...list].sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end);
		const spec = (target: string) => {
			const r = relative(dirname(file), target).split('\\').join('/').replace(/\.ts$/, '');
			return r.startsWith('.') ? r : './' + r;
		};
		const i = imports.get(file)!;
		const head = [...(i.texts.size ? [`import { ${[...i.texts].sort().join(', ')} } from ${JSON.stringify(spec(textsFile))};`] : []), ...(i.bindings.size && bindingsFile ? [`import { ${[...i.bindings].sort().join(', ')} } from ${JSON.stringify(spec(bindingsFile))};`] : [])];
		// Before the first statement, after any leading comments and directives, on that statement's line.
		const at = program.getSourceFile(file)!.statements[0].getStart();
		files.set(file, text.slice(0, at) + head.join(' ') + ' ' + text.slice(at));
	}
	return { files, folded, kept };
}

/** The `{{ }}` attributes of the plan's texts, keyed as their factories look their closures up. */
export function textBindingSites(plan: XmlPlan): { key: string; binding: BindingPlan }[] {
	const sites: { key: string; binding: BindingPlan }[] = [];
	const visit = (e: import('./plan.ts').ElementPlan | null | undefined): void => {
		if (!e) return;
		for (const a of e.attributes) if (a.kind === 'binding' && a.binding) sites.push({ key: a.key, binding: a.binding });
		e.children.forEach(visit);
		for (const p of e.properties) {
			visit(p.root);
			p.templates?.forEach((t) => visit(t.root));
			p.children?.forEach(visit);
		}
	};
	for (const t of plan.texts) visit(t.page.root);
	return sites;
}
