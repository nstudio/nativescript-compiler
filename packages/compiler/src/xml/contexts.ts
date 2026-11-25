// The binding context of each `{{ }}` site of a plain XML app, proved from the program: a page's context is proved when
// every write to it is seen and all have one type (an app class, an `Observable` built with literal `set` keys in the
// writing function, or an object type); a template's rows take the element type of their owner's `items`; a custom XML
// component's root takes its use sites' context. Anything else (`any`, a computed key, an unseen write) is unknown.
// A proof only chooses how a closure reads: a typed read is still guarded at run time, so an unsound proof costs speed,
// never behavior.
import ts from 'typescript';
import { relative } from 'node:path';
import type { BindingPlan, ElementPlan, PagePlan } from './plan.ts';

export type SiteKind = 'typed' | 'record' | 'object' | 'template' | 'inherited' | 'unknown';

/** A class whose instances a closure reads members of directly, behind `instanceof`. */
export interface TypedRead {
	className: string;
	module: string;
	exportName: string;
	members: string[];
}

export interface SiteContext {
	key: string;
	binding: BindingPlan;
	kind: SiteKind;
	why?: string;
	typed?: TypedRead;
}

type Context = { kind: 'class'; type: ts.Type; symbol: ts.Symbol } | { kind: 'record'; keys: Map<string, ts.Type>; at: ts.Node } | { kind: 'object'; type: ts.Type } | { kind: 'unknown'; why: string };

const UNKNOWN = (why: string): Context => ({ kind: 'unknown', why });
const sanitize = (spec: string) =>
	spec
		.trim()
		.replace(/^~\//, '')
		.replace(/^\.?\//, '')
		.replace(/\.(xml|ts|js)$/, '');

export function xmlBindingContexts(pages: PagePlan[], program: ts.Program, appDir: string): { sites: SiteContext[]; counts: Record<SiteKind, number>; unseen: string[] } {
	const checker = program.getTypeChecker();
	const isApp = (sf: ts.SourceFile) => !sf.isDeclarationFile && !sf.fileName.includes('/node_modules/') && sf.fileName.startsWith(appDir + '/') && !/\/__[^/]*$/.test(sf.fileName);
	const appFiles = program.getSourceFiles().filter(isApp);
	const rel = (sf: ts.SourceFile) => relative(appDir, sf.fileName).split('\\').join('/');
	const where = (n: ts.Node) => `${rel(n.getSourceFile())}:${n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1}`;

	const chain = (t: ts.Type): string[] => {
		const names: string[] = [];
		const seen = new Set<ts.Type>();
		const visit = (x: ts.Type) => {
			if (seen.has(x)) return;
			seen.add(x);
			if (x.symbol) names.push(x.symbol.getName());
			if (x.isClassOrInterface()) for (const b of checker.getBaseTypes(x)) visit(b);
			else if (x.symbol?.flags & ts.SymbolFlags.Class) visit(checker.getDeclaredTypeOfSymbol(x.symbol));
		};
		visit(t);
		return names;
	};
	const isAny = (t: ts.Type) => !!(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) || (t.isUnion() && t.types.some(isAny));
	const coreClass = (s: ts.Symbol | undefined, name: string) => ((s = s && s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s), !!s) && s.getName() === name && !!s.declarations?.every((d) => !isApp(d.getSourceFile()));

	/** The context a written value gives. */
	const valueContext = (e: ts.Expression): Context => {
		while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e)) {
			if (!ts.isNonNullExpression(e) && !ts.isParenthesizedExpression(e) && isAny(checker.getTypeAtLocation(e))) return UNKNOWN(`any at ${where(e)}`);
			e = e.expression;
		}
		const record = observableRecord(e);
		if (record) return record;
		return typeContext(checker.getTypeAtLocation(e), where(e));
	};
	const typeContext = (t: ts.Type, at: string): Context => {
		if (isAny(t)) return UNKNOWN(`any at ${at}`);
		if (t.isUnion()) {
			const parts = t.types.filter((x) => !(x.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)));
			if (parts.length !== 1) return UNKNOWN(`union at ${at}`);
			t = parts[0];
		}
		const s = t.getSymbol();
		if (s && s.flags & ts.SymbolFlags.Class && s.declarations?.some((d) => isApp(d.getSourceFile()))) return { kind: 'class', type: t, symbol: s };
		if (chain(t).includes('Observable')) return UNKNOWN(`an Observable without literal keys at ${at}`);
		if (t.flags & ts.TypeFlags.Object && !checker.getSignaturesOfType(t, ts.SignatureKind.Call).length) return { kind: 'object', type: t };
		return UNKNOWN(`${checker.typeToString(t)} at ${at}`);
	};
	/** `new Observable()`, directly or through a local of the writing function, with its literal `set` keys there. */
	const observableRecord = (e: ts.Expression): Context | null => {
		const isNew = (x: ts.Node | undefined) => !!x && ts.isNewExpression(x) && !x.arguments?.length && coreClass(checker.getSymbolAtLocation(x.expression), 'Observable');
		if (isNew(e)) return { kind: 'record', keys: new Map(), at: e };
		if (!ts.isIdentifier(e)) return null;
		const symbol = checker.getSymbolAtLocation(e);
		const decl = symbol?.valueDeclaration;
		if (!decl || !ts.isVariableDeclaration(decl) || !isNew(decl.initializer)) return null;
		const scope = ts.findAncestor(decl, ts.isFunctionLike);
		if (!scope || ts.findAncestor(e, ts.isFunctionLike) !== scope) return null;
		const keys = new Map<string, ts.Type>();
		let computed: ts.Node | undefined;
		const visit = (n: ts.Node): void => {
			if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'set' && ts.isIdentifier(n.expression.expression) && checker.getSymbolAtLocation(n.expression.expression) === symbol) {
				const [k, v] = n.arguments;
				if (k && ts.isStringLiteralLike(k) && v) keys.set(k.text, checker.getTypeAtLocation(v));
				else computed ??= n;
			}
			ts.forEachChild(n, visit);
		};
		visit(scope);
		return computed ? UNKNOWN(`a computed set key at ${where(computed)}`) : { kind: 'record', keys, at: decl };
	};
	const join = (cs: Context[], none: string): Context => {
		if (!cs.length) return UNKNOWN(none);
		const [first, ...rest] = cs;
		for (const c of rest) {
			if (c.kind === 'unknown') return c;
			const same = first.kind === 'class' ? c.kind === 'class' && c.symbol === first.symbol : first.kind === 'record' ? c.kind === 'record' && c.at === first.at : first.kind === 'object' ? c.kind === 'object' && c.type === first.type : false;
			if (!same) return UNKNOWN('writes of different types');
		}
		return first;
	};

	// Every write of a view's `bindingContext` in app code, and every navigation entry carrying one.
	const codeBehinds = new Map<string, PagePlan>();
	for (const p of pages) {
		const code = p.root?.codeFile?.resolved ?? p.codeBehind;
		if (code) codeBehinds.set(code, p);
	}
	const writes = new Map<PagePlan, Context[]>();
	const unseen: string[] = [];
	const write = (p: PagePlan, c: Context) => writes.set(p, [...(writes.get(p) ?? []), c]);
	const viewTarget = (target: ts.Expression): 'page' | 'view' | null => {
		const t = checker.getTypeAtLocation(target);
		if (isAny(t)) return 'page';
		const names = chain(t);
		return names.includes('Page') ? 'page' : names.includes('ViewBase') ? 'view' : null;
	};
	for (const sf of appFiles) {
		const page = codeBehinds.get(rel(sf));
		const visit = (n: ts.Node): void => {
			if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
				const l = n.left;
				const target = ts.isPropertyAccessExpression(l) && l.name.text === 'bindingContext' ? l.expression : ts.isElementAccessExpression(l) && ts.isStringLiteralLike(l.argumentExpression) && l.argumentExpression.text === 'bindingContext' ? l.expression : null;
				const kind = target && viewTarget(target);
				if (kind === 'page' && page) write(page, valueContext(n.right));
				else if (kind === 'view' && page) write(page, UNKNOWN(`a view's context written at ${where(n)}`));
				else if (kind) unseen.push(where(n));
			} else if (ts.isObjectLiteralExpression(n)) {
				const prop = (name: string) => n.properties.find((p): p is ts.PropertyAssignment | ts.ShorthandPropertyAssignment => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText() === name);
				const bc = prop('bindingContext');
				const contextual = checker.getContextualType(n);
				if (bc && (prop('moduleName') || contextual?.getProperty('moduleName'))) {
					const mn = prop('moduleName');
					const value = mn && (ts.isPropertyAssignment(mn) ? mn.initializer : mn.name);
					const t = value && checker.getTypeAtLocation(value);
					const name = t?.isStringLiteral() ? sanitize(t.value) : undefined;
					const target = name !== undefined ? pages.find((p) => p.module === name) : undefined;
					const v = ts.isPropertyAssignment(bc) ? bc.initializer : bc.name;
					if (target) write(target, valueContext(v));
					else unseen.push(where(n));
				}
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
	}

	// Contexts down each file's tree; a component file's root takes its use sites' contexts, settled over passes.
	const components = new Map<string, Context[]>();
	const settled = new Map<string, Context>();
	const used = new Set<string>();
	const fileContext = (p: PagePlan): Context | undefined => {
		if (unseenAll) return UNKNOWN(`unseen writes (${unseen[0]})`);
		if (writes.has(p)) return join(writes.get(p)!, '');
		if (used.has(p.file)) return settled.get(p.file);
		return UNKNOWN('no write seen');
	};
	let unseenAll = unseen.length > 0;
	const memberType = (c: Context, name: string): ts.Type | undefined =>
		c.kind === 'record'
			? c.keys.get(name)
			: c.kind === 'class' || c.kind === 'object'
				? (() => {
						const p = c.type.getProperty(name);
						return p && checker.getTypeOfSymbol(p);
					})()
				: undefined;
	const elementType = (t: ts.Type): ts.Type | undefined => {
		if (isAny(t)) return t;
		if (checker.isArrayType(t) || checker.isTupleType(t)) return checker.getIndexTypeOfType(t, ts.IndexKind.Number);
		if (chain(t).includes('ObservableArray')) return checker.getTypeArguments(t as ts.TypeReference)[0];
		return undefined;
	};

	const typedCache = new Map<ts.Symbol, TypedRead>();
	const out: SiteContext[] = [];
	const walk = (p: PagePlan, record: boolean) => {
		const root = fileContext(p);
		const origin: SiteKind | null = writes.has(p) ? null : used.has(p.file) && !unseenAll ? 'inherited' : null;
		const label = (c: Context | undefined, from: SiteKind | null): { kind: SiteKind; why?: string; c: Context } => {
			if (!c) return { kind: 'unknown', why: 'component context not settled', c: UNKNOWN('') };
			if (c.kind === 'unknown') return { kind: 'unknown', why: c.why, c };
			return { kind: from ?? (c.kind === 'class' ? 'typed' : c.kind), c };
		};
		const visit = (e: ElementPlan | null | undefined, ctx: Context | undefined, from: SiteKind | null): void => {
			if (!e) return;
			const bc = e.attributes.find((a) => a.target === 'bindingContext');
			for (const a of e.attributes) {
				if (a.kind !== 'binding' || !a.binding) continue;
				const l = label(ctx, from);
				if (record) out.push({ key: a.key, binding: a.binding, kind: l.kind, ...(l.why ? { why: l.why } : {}), ...(l.c.kind === 'class' ? { typed: typedRead(l.c) } : {}) });
			}
			let own = ctx;
			let ownFrom = from;
			if (bc) {
				const t = bc.binding?.form === 'name' && ctx && ctx.kind !== 'unknown' ? memberType(ctx, bc.binding.sourceProperty) : undefined;
				own = t ? typeContext(t, `${p.file}:${e.line}`) : UNKNOWN(`bindingContext at ${p.file}:${e.line}`);
				ownFrom = null;
			}
			if (e.kind === 'custom-xml' && e.component.file && record) {
				used.add(e.component.file);
				components.set(e.component.file, [...(components.get(e.component.file) ?? []), own ?? UNKNOWN('')]);
			}
			e.children.forEach((c) => visit(c, own, ownFrom));
			for (const prop of e.properties) {
				let rows: Context = UNKNOWN(`${e.tag}.${prop.name} at ${p.file}:${prop.line}`);
				const items = e.attributes.find((a) => a.target === 'items');
				const listed = (e.component.name === 'ListView' || e.component.name === 'Repeater') && !e.attributes.some((a) => a.target === 'sectioned');
				if (listed && (prop.name === 'itemTemplate' || prop.name === 'itemTemplates') && items?.binding?.form === 'name' && own && own.kind !== 'unknown') {
					const t = memberType(own, items.binding.sourceProperty);
					const el = t && elementType(t);
					rows = el ? typeContext(el, `${p.file}:${e.line} items`) : UNKNOWN(`items of ${p.file}:${e.line}`);
				}
				const tmpl = prop.kind === 'template' || prop.kind === 'templates';
				visit(prop.root, tmpl ? rows : own, tmpl ? 'template' : ownFrom);
				prop.templates?.forEach((t) => visit(t.root, rows, 'template'));
				prop.children?.forEach((c) => visit(c, own, ownFrom));
			}
		};
		visit(p.root, root, origin);
	};
	// Component contexts: each pass walks every file with the contexts settled so far.
	for (let pass = 0; pass < 6; pass++) {
		components.clear();
		for (const p of pages) walk(p, true);
		out.length = 0;
		let changed = false;
		for (const [file, cs] of components) {
			const next = join(cs, 'no use site');
			const prev = settled.get(file);
			if (!prev || prev.kind !== next.kind || (prev.kind === 'unknown' ? prev.why !== (next as any).why : false)) changed = true;
			settled.set(file, next);
		}
		if (!changed) break;
	}
	components.clear();
	for (const p of pages) walk(p, true);

	function typedRead(c: Extract<Context, { kind: 'class' }>): TypedRead {
		const cached = typedCache.get(c.symbol);
		if (cached) return cached;
		const decl = c.symbol.declarations!.find((d) => isApp(d.getSourceFile()))!;
		const sf = decl.getSourceFile();
		const moduleSymbol = checker.getSymbolAtLocation(sf);
		const exp = moduleSymbol && checker.getExportsOfModule(moduleSymbol).find((s) => (s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s) === c.symbol);
		const members: string[] = [];
		for (const p of checker.getPropertiesOfType(c.type)) {
			const name = p.getName();
			if (!/^[A-Za-z_][\w$]*$/.test(name) || name in Object.prototype) continue;
			const decls = p.declarations ?? [];
			// Present on every instance (`k in m` holds, as the evaluator's scope rule needs): an initialized field, a
			// parameter property or a getter, public and declared only by app code.
			const present = decls.length > 0 && decls.every((d) => isApp(d.getSourceFile()) && !(ts.getCombinedModifierFlags(d as ts.Declaration) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected | ts.ModifierFlags.Static)) && ((ts.isPropertyDeclaration(d) && !!d.initializer && !d.questionToken) || (ts.isParameter(d) && !d.questionToken) || ts.isGetAccessor(d) || ts.isSetAccessor(d))) && decls.some((d) => !ts.isSetAccessor(d));
			if (present) members.push(name);
		}
		const t: TypedRead = { className: c.symbol.getName(), module: rel(sf).replace(/\.ts$/, ''), exportName: exp?.getName() ?? '', members };
		typedCache.set(c.symbol, t);
		return t;
	}

	const counts: Record<SiteKind, number> = { typed: 0, record: 0, object: 0, template: 0, inherited: 0, unknown: 0 };
	for (const s of out) counts[s.kind]++;
	return { sites: out, counts, unseen };
}
