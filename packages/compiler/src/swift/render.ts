import type { ComponentIR } from '../api/ir.ts';
import { DEFAULT_BEHAVIOUR, kitName, type ComponentInfo } from '../template/model.ts';
import { regionHost, renderPlan, type Arg, type Block, type Call, type ComponentArg, type PropWrite, type Scope, type Step, type RootHook } from '../template/plan.ts';
import type { TemplateBehaviour, TemplateKit } from '../api/adapter-api.ts';
import { SWIFT_LEDGER } from '../semantics/ledger.ts';
import { ident, swiftString, RT } from './syntax.ts';
import { isUntyped, spelledType } from '../semantics/types.ts';

export interface RenderOptions {
	/** The element type of a binding method returning a loop's items, which spares Swift inferring it through the loop's closures. */
	itemType?: (method: string) => string | null;
	/** A component's or element's Swift class, which may be named apart from its TypeScript class (a name the app module's Swift also has). */
	swiftClass?: (name: string) => string;
	/** A binding method's value as a child component's input holds it, where the two are held apart; null where they are one. */
	propValue?: (component: string, prop: string, method: string | null) => PropValue | null;
}

/** A conversion of a binding's value to the input it is written to, and whether it throws. */
export interface PropValue {
	convert: (value: string) => string;
	throws: boolean;
}

/**
 * A component's template (template/plan.ts) as a Swift `render()`: views are created once, each binding is one effect
 * that sets one property, and each `if`/`for` owns a region of its container. Nothing is diffed at run time. `throws`
 * says which of the component's methods throw: only those are called with `try` and have what they throw reported.
 */
export function render(c: ComponentIR, components: Map<string, ComponentInfo>, throws: (method: string) => boolean = () => false, behaviour: TemplateBehaviour = DEFAULT_BEHAVIOUR, options: RenderOptions = {}): string[] {
	const plan = renderPlan(c, components, behaviour, SWIFT_LEDGER);
	const lines: string[] = [];
	const say = (depth: number, text: string): void => {
		lines.push('    '.repeat(depth) + text);
	};
	const kit = <K extends keyof TemplateKit>(key: K) => kitName(behaviour, key);
	const arg = (a: Arg, checked: string) => (typeof a === 'string' ? a : 'string' in a ? swiftString(a.string) : 'checked' in a ? checked : `EventData(eventName: ${swiftString(a.eventData)}, object: ${a.object ?? 'nil'}, value: value)`);
	const call = (k: Call, checked = '$0') => `${throws(k.method) ? 'try ' : ''}self.${ident(k.method)}(${[...k.loops.flatMap((l) => (l.index === undefined ? [l.itemExpr ?? ident(l.item)] : [l.itemExpr ?? ident(l.item), l.indexExpr ?? ident(l.index)])), ...k.extra.map((a) => arg(a, checked))].join(', ')})`;
	const reported = (method: string, code: string) => (throws(method) ? `${RT.jsReport} { ${code} }` : code);
	const run = (k: Call, checked?: string) => reported(k.method, call(k, checked));
	// A listener marking its view dirty holds the view it is added in.
	const captures = behaviour.eventScope === 'event+dirtyView' ? `[__dv = ${kit('currentView')}] ` : '';
	const handler = (k: Call) => (behaviour.eventScope === 'none' ? run(k) : behaviour.eventScope === 'event+dirtyView' ? `Reactivity.event(dirty: __dv) { ${run(k)} }` : `Reactivity.event { ${run(k)} }`);
	/** A binding that also re-reads when its view is checked. What it throws is reported by the check, and the binding keeps its value. */
	const check = (k: Call, apply: string) => `${kit('check')}({ ${call(k)} }) { ${apply} }`;
	const cond = (k: Call, caught: boolean) => (caught && throws(k.method) ? `${RT.jsReportedTruthy}({ ${call(k)} })` : `${RT.jsTruthy}(${call(k)})`);
	const site = (text: string) => swiftString(text);
	const scope = (s: Scope, result: string) => {
		const args = s.view ? [...(s.view.component ? ['for: self', ...(s.view.onPush ? ['onPush: true'] : [])] : s.view.onPush ? ['onPush: self'] : []), ...(s.view.injector ? [`injector: self.${ident(s.view.injector)}`] : [])] : [];
		return `try ${s.call}${s.inView ? '(in: __view)' : args.length ? `(${args.join(', ')})` : ''} { () throws -> ${result} in`;
	};
	const converted = (w: { convert: PropWrite['convert'] }) => (w.convert ? (options.propValue?.(w.convert.component, w.convert.prop, w.convert.method) ?? null) : null);
	/** A prop's binding as it applies: the setter's method called (reporting what it throws), or the prop's signal written. */
	const write = (w: PropWrite, value: string) => {
		const c0 = w.component;
		const change = (w.changes ? `; ${c0}._change(${swiftString(w.prop)}, ${value})` : '') + (w.inputChanged ? `; ${kit('inputChanged')}(${c0})` : '');
		const conv = converted(w);
		if (conv?.throws) {
			const held = value === '$0';
			return `${held ? 'let __v = $0; ' : ''}${RT.jsReport} { ${c0}.${ident(w.prop)}.value = ${conv.convert(held ? '__v' : value)} }${change}`;
		}
		if (!w.setter) return `${c0}.${ident(w.prop)}.value = ${conv ? conv.convert(value) : value}${change}`;
		// `$0` names the Check's value only outside the closure jsReport takes.
		const held = w.throwingSetter && value === '$0';
		const set = `${c0}.${ident('$set_' + w.prop)}(${held ? '__v' : value})`;
		return (w.throwingSetter ? `${held ? 'let __v = $0; ' : ''}${RT.jsReport} { try ${set} }` : set) + change;
	};
	const componentArg = (a: ComponentArg): string[] => {
		const conv = converted(a);
		if ('value' in a) return [`${ident(a.prop)}: ${conv ? conv.convert(swiftString(a.value)) : swiftString(a.value)}`];
		const read = conv ? conv.convert(`${throws(a.read.method) ? 'try ' : ''}${call(a.read)}`) : call(a.read);
		if (!throws(a.read.method) && !conv?.throws) return [`${ident(a.prop)}: ${RT.untrack} { ${read} }`];
		if (a.optional) return [];
		return [`${ident(a.prop)}: try ${RT.untrack} { try ${RT.jsReadOrZero} { ${conv ? read : call(a.read)} } }`];
	};

	const steps = (list: Step[], depth: number) => {
		for (const s of list) step(s, depth);
	};
	/** A branch's or row's steps; under `passes`, its update pass held until its region's template has run its bindings. */
	const body = (b: Block, d: number) => {
		steps(b.steps, d);
		if (!b.update) return;
		say(d, `try ${kit('embedded').later} { () throws -> Void in`);
		steps(b.update, d + 1);
		say(d, '}');
	};
	/** A fragmented branch or row body: its views and nested regions. */
	const fragment = (b: Block, depth: number, host: string) => {
		say(depth, `let ${b.fragment} = RegionFragment(${host})`);
		body(b, depth);
		say(depth, `return ${b.fragment}`);
	};
	/** A branch's or row's views, in the region's scope when it has one. */
	const views = (s: Scope | null, viewMark: boolean, depth: number, body: (d: number) => void) => {
		const wrap = s ? scope(s, '[View]') : null;
		const d = wrap ? depth + 1 : depth;
		if (wrap) say(depth + 1, wrap);
		if (viewMark) say(d + 1, 'let __view = EffectOrder.current');
		body(d);
		if (wrap) say(depth + 1, '}');
	};
	const step = (s: Step, depth: number): void => {
		switch (s.kind) {
			case 'local':
				return say(depth, `let ${s.name} = ${call(s.make)}`);
			case 'letSlot':
				return say(depth, `let ${s.name} = ${kit('letSlot')} { ${call(s.read)} }`);
			case 'storeLet':
				return say(depth, `${s.slot}.store()`);
			case 'cleanup':
				return say(depth, `Owner.current?.onCleanup { ${run(s.call)} }`);
			case 'run':
				return say(depth, run(s.call));
			case 'outlet':
				return say(depth, `let ${s.view} = try ${s.call}(${s.name !== null ? swiftString(s.name) : ''})`);
			case 'create':
				return say(depth, `let ${s.view} = try ${options.swiftClass?.(s.tag) ?? s.tag}()`);
			case 'hostAttach':
				return say(depth, `self.${ident(s.host)}.attach(${s.view})`);
			case 'ref':
				return say(depth, `${call(s.call)}.current = ${s.view}`);
			case 'setAttr':
				return say(depth, s.name === 'class' ? `${s.view}.className = ${swiftString(s.value)}` : `${s.view}.kitSet(${swiftString(s.name)}, ${swiftString(s.value)})`);
			case 'bindAttr': {
				if (s.mode === 'check') return say(depth, check(s.call, s.name === 'class' ? `${s.view}.className = $0` : `${s.view}.kitSet(${swiftString(s.name)}, $0)`));
				if (s.name === 'class') return say(depth, `Effect { ${reported(s.call.method, `${s.view}.className = ${s.slots ? `${kit('className')}(${call(s.call)})` : call(s.call)}`)} }`);
				return say(depth, `Effect { ${reported(s.call.method, `${s.view}.kitSet(${swiftString(s.name)}, ${s.slots ? `${kit('attributeValue')}(${call(s.call)})` : call(s.call)})`)} }`);
			}
			case 'ifPassed':
				say(depth, `if self._passed.contains(${swiftString(s.prop)}) {`);
				steps(s.steps, depth + 1);
				return say(depth, '}');
			case 'directive': {
				const made = call(s.make);
				return say(depth, `let ${s.name} = ${made.startsWith('try ') ? 'try ' : ''}${kit('directiveHost')}(${s.view}) { ${made} }`);
			}
			case 'checkRun':
				return say(depth, `${kit('check')}({ ${call(s.read)} }) { ${throws(s.run.method) ? `let __v = $0; ${run(s.run, '__v')}` : run(s.run)} }`);
			case 'flushChanges':
				return say(depth, `${kit('check')}({ ${s.target}._changed.value }) { _ in ${RT.jsReport} { try ${s.target}._flushChanges() } }`);
			case 'checkSet':
				return say(depth, check(s.call, `${s.view}.kitSet(${swiftString(s.prop)}, $0)`));
			case 'listen': {
				const listen = `${s.view}.kitOn(${swiftString(s.event)}) { ${captures}event in ${handler(s.call)} }`;
				const guarded = s.when ? `if ${cond(s.when, true)} { ${listen} }` : listen;
				return say(depth, s.ifPassed !== null ? `if self._passed.contains(${swiftString(s.ifPassed)}) { ${guarded} }` : guarded);
			}
			case 'subscribe':
				return say(depth, `${s.target}.${s.output}.subscribe { ${captures}(event: Any?) in ${handler(s.call)} }`);
			case 'attach':
				return say(depth, s.parent ? (s.slots ? `${s.parent}.kitAddTemplateChild(${s.view})` : `${s.parent}.kitAddChild(${s.view})`) : `${s.region}.attach(${s.view})`);
			case 'component': {
				const args = s.args.flatMap(componentArg);
				if (s.passed) args.push(`_passed: [${s.passed.map((p) => swiftString(p)).join(', ')}]`);
				const made = `${s.initThrows ? 'try ' : ''}${options.swiftClass?.(s.type) ?? s.type}(${args.join(', ')})`;
				const ctor = behaviour.kit?.construct ? `${s.initThrows ? 'try ' : ''}${behaviour.kit.construct} { ${made} }` : made;
				return say(depth, `let ${s.name} = ${ctor}`);
			}
			case 'write':
				return say(depth, write(s.write, swiftString(s.value)));
			case 'change':
				return say(depth, `${s.component}._change(${swiftString(s.prop)}, ${swiftString(s.value)})`);
			case 'bindProp':
				return say(depth, s.mode === 'check' ? check(s.call, write(s.write, '$0')) : `Effect { ${reported(s.call.method, write(s.write, call(s.call)))} }`);
			case 'output':
				return say(depth, `${s.component}.${ident(s.field)}.on { ${captures}value in ${handler(s.call)} }`);
			case 'renderInto':
				return say(depth, `try ${s.component}.${s.member}(into: ${s.parent}.kitAddRegion())`);
			case 'renderView':
				return say(depth, `let ${s.view} = try ${s.component}.${s.member}()`);
			case 'createView':
				return say(depth, `let (${s.view}, ${s.update}) = try ${s.component}.${s.member}()`);
			case 'createInto':
				return say(depth, `let ${s.update} = try ${s.component}.${s.member}(into: ${s.parent}.kitAddRegion())`);
			case 'childHook':
				return say(depth, `${s.component}.${s.member}()`);
			case 'flushEffects':
				return say(depth, `${s.call}(for: ${s.component})`);
			case 'updateChild':
				return say(depth, `try ${s.update}()`);
			case 'everyCheck':
				say(depth, `${s.call} {`);
				step(s.hook, depth + 1);
				return say(depth, '}');
			case 'embeddedViews':
				say(depth, `try ${kit('embedded').collect} { () throws -> Void in`);
				steps(s.steps, depth + 1);
				return say(depth, '}');
			case 'region':
				return say(depth, s.detached ? `let ${s.name} = Region(host: nil)` : `let ${s.name} = ${s.parent}.kitAddRegion()`);
			case 'addRegion':
				return say(depth, `${s.parent}.kitAddRegion(${s.region})`);
			case 'setSlot': {
				say(depth, `${s.component}.__slots[${swiftString(s.name)}] = { (__sr: Region) throws -> Void in`);
				const wrap = s.scope ? scope(s.scope, 'Void') : null;
				const d = wrap ? depth + 2 : depth + 1;
				if (wrap) say(depth + 1, wrap);
				if (s.viewMark) say(d, 'let __view = EffectOrder.current');
				say(d, `let ${s.body.fragment} = RegionFragment(__sr)`);
				steps(s.body.steps, d);
				say(d, `__sr.set(parts: ${s.body.fragment}.parts)`);
				if (wrap) say(depth + 1, '}');
				return say(depth, '}');
			}
			case 'slot': {
				const host = regionHost(s.host);
				if (s.fallback) {
					say(depth, `if let __slot = self.__slots[${swiftString(s.name)}] {`);
					say(depth + 1, `try __slot(${host})`);
					say(depth, '} else {');
					say(depth + 1, `let ${s.fallback.fragment} = RegionFragment(${host})`);
					steps(s.fallback.steps, depth + 1);
					say(depth + 1, `${host}.set(parts: ${s.fallback.fragment}.parts)`);
					return say(depth, '}');
				}
				return say(depth, `if let __slot = self.__slots[${swiftString(s.name)}] { try __slot(${host}) }`);
			}
			case 'choose': {
				const host = regionHost(s.host);
				const which = s.conds.map((k, i) => (k ? `${cond(k, s.caught)} ? ${i} : ` : `${i}`)).join('') + (s.conds.at(-1) ? `${s.conds.length}` : '');
				if (s.fragment) {
					say(depth, `${RT.ChooseFragment}(${host}, { ${which} }, site: ${site(s.site)}) { branch in`);
					say(depth + 1, 'switch branch {');
					s.branches.forEach((b, i) => {
						say(depth + 1, `case ${i}:`);
						fragment(b, depth + 2, host);
					});
					say(depth + 1, `default: return RegionFragment(${host})`);
					say(depth + 1, '}');
					return say(depth, '}');
				}
				say(depth, `${RT.Choose}(${host}, { ${which} }, site: ${site(s.site)}) { branch in`);
				views(s.scope, s.viewMark, depth, (d) => {
					say(d + 1, 'switch branch {');
					s.branches.forEach((b, i) => {
						say(d + 1, `case ${i}:`);
						body(b, d + 2);
						say(d + 2, `return [${b.made.join(', ')}]`);
					});
					say(d + 1, 'default: return []');
					say(d + 1, '}');
				});
				return say(depth, '}');
			}
			case 'for': {
				const host = regionHost(s.host);
				const opening = (fragmented: boolean, items: string, key: string) => {
					const kind = s.row ? (fragmented ? RT.ForEachFragment : RT.ForEach) : fragmented ? RT.ForFragment : RT.For;
					return `${kind}(${host}, ${items}, key: ${key}, site: ${site(s.site)}) { ${s.row ?? `${ident(s.item)}, ${ident(s.index)}`} in`;
				};
				const keyed = (read: string) => (s.key ? `{ ${ident(s.item)}, ${ident(s.index)} in ${RT.jsKey}(${read}) }` : `{ item, _ in ${RT.jsKey}(item) }`);
				const row = (d: number) => {
					if (s.fragment) return fragment(s.body, d, host);
					body(s.body, d);
					say(d, `return [${s.body.made.join(', ')}]`);
				};
				if (s.rows === 'value') {
					// What a list's items or keys throw is left out: the list then renders nothing, the row keyed by nothing.
					if (s.caught) throw new Error(`${c.name}: Swift's value rows leave out what their items and keys throw (Ledger.valueRowReadsReported)`);
					const key = keyed(s.key && throws(s.key.method) ? `(try? ${call(s.key).replace(/^try /, '')}) as Any?` : s.key ? call(s.key) : '');
					// `{list?.map(…)}`: an absent list renders no rows.
					const items = throws(s.items.method) ? `{ (try? ${call(s.items).replace(/^try /, '')}).map { ${kit('rowItems')}($0) } ?? [] }` : `{ ${kit('rowItems')}(${call(s.items)}) }`;
					say(depth, opening(s.fragment, items, key));
					row(depth + 1);
					return say(depth, '}');
				}
				// A key may be any value (`:key="i"`); rows are kept by its string form.
				const key = keyed(s.key ? call(s.key) : '');
				const element = options.itemType?.(s.items.method);
				// Untyped items (`Any?`) are iterated as JavaScript iterates them.
				const read = isUntyped(spelledType(element)) ? `try ${RT.jsItemsOf}(${call(s.items).replace(/^try /, '')})` : `Array(${call(s.items)})`;
				const items = `{ ${element ? `() throws -> [${element}] in ` : ''}${read} }`;
				// Iterating reads the array through its tracker: pushing to an array a ref holds re-renders the rows.
				say(depth, opening(s.fragment, items, key));
				if (s.fragment) row(depth + 1);
				else views(s.scope, s.viewMark, depth, (d) => row(d + 1));
				return say(depth, '}');
			}
			case 'list': {
				const sel = s.selector ? `, selector: { item, index in ${call(s.selector)} }` : '';
				// A sectioned list's items are its sections; a row's item is one of a section's `items`.
				const source = s.sections ? `sections: { ${call(s.items)} }, rows: { Array($0.items) }` : `items: { ${call(s.items)} }`;
				if (s.headerXml !== null) say(depth, `${s.view}.kitSet("stickyHeaderTemplate", ${swiftString(s.headerXml)})`);
				if (!s.templates.length) return say(depth, `${s.view}.bind(${source}${sel})`);
				/** One template's view for a row: the closure body rendering it. */
				const rendered = (b: Block, at: number) => {
					const wrap = s.scope ? scope(s.scope, 'View') : null;
					const d = wrap ? at : at - 1;
					if (wrap) say(at, `return ${wrap}`);
					if (b.viewMark) say(d + 1, 'let __view = EffectOrder.current');
					steps(b.steps, d + 1);
					say(d + 1, `return ${b.made[0]}`);
					if (wrap) say(at, '}');
				};
				say(depth, `${s.view}.bind(${source}, templates: [${s.keys.map((k) => swiftString(k)).join(', ')}]${sel}, render: { key, ${s.row} in`);
				say(depth + 1, 'switch key {');
				for (const t of s.templates) {
					say(depth + 1, t.fallback ? 'default:' : `case ${swiftString(t.key)}:`);
					rendered(t.body, depth + 2);
				}
				say(depth + 1, '}');
				if (s.header) {
					say(depth, `}, header: { ${s.row} in`);
					rendered(s.header, depth + 1);
				}
				return say(depth, '})');
			}
		}
	};

	const passes = plan.passes;
	const m = plan.members;
	if (plan.hasSlots) say(1, 'var __slots: [String: (Region) throws -> Void] = [:]');
	if (passes) {
		// Both passes, with the hooks a parent runs for its child between and after them.
		const hooks = (list: RootHook[]) => list.map((h) => (h.flush ? `${h.flush}(for: self)` : h.every ? `${h.every} { self.${h.member}() }` : `self.${h.member}()`)).join('; ');
		const before = hooks(passes.before);
		const after = hooks(passes.after);
		const wrapRoot = (body: string, ret = false) => (behaviour.kit?.rootScope ? `${ret ? 'return ' : ''}try ${behaviour.kit.rootScope} { ${body} }` : body);
		if (plan.fragment) say(1, `func ${m.render}(into region: Region) throws { ${wrapRoot(`let update = try self.${m.create}(into: region); ${before}; try update(); ${after}`)} }`);
		else say(1, `func ${m.render}() throws -> View { ${wrapRoot(`let (view, update) = try self.${m.create}(); ${before}; try update(); ${after}; return view`, true)} }`);
		say(1, plan.fragment ? `func ${m.create}(into region: Region) throws -> () throws -> Void {` : `func ${m.create}() throws -> (View, () throws -> Void) {`);
	} else say(1, plan.fragment ? `func ${m.render}(into region: Region) throws {` : `func ${m.render}() throws -> View {`);
	const result = passes ? (plan.fragment ? '() throws -> Void' : '(View, () throws -> Void)') : plan.fragment ? 'Void' : 'View';
	const wrap = plan.scope ? scope(plan.scope, result) : null;
	const d = wrap ? 3 : 2;
	if (wrap) say(2, `return ${wrap}`);
	if (passes && wrap) say(d, 'let __scope = EffectOrder.current');
	if (plan.viewMark) say(d, 'let __view = EffectOrder.current');
	for (const x of plan.derived) say(d, `${RT.derive} { ${reported(x.call.method, `self.${ident(x.name)}.value = ${call(x.call)}`)} }`);
	// The destroy hook runs when the scope the component was made in ends.
	if (plan.destroy) say(d, `Owner.current?.onCleanup { ${run(plan.destroy)} }`);
	if (plan.init) say(d, run(plan.init));
	// A watcher runs before the bindings of its component (a pre-flush job).
	for (const w of plan.watchers) say(d, `${RT.Watch}(immediate: ${w.immediate}, { ${call(w.source)} }) { value, old in ${run(w.handler)} }`);
	const after = (d: number) => {
		for (const h of plan.userEffects) say(d, `EffectOrder.user { Effect { ${run(h)} } }`);
		for (const e of plan.effects) say(d, `ComponentEffect(layout: ${e.layout}, deps: ${e.deps ? `{ ${call(e.deps)}.storage }` : 'nil'}) { ${call(e.run)} }`);
		if (plan.afterView) say(d, run(plan.afterView));
	};
	/** The rest of the template once its own steps are made, and what it returns. */
	const end = (b: Block, v?: string) => {
		if (!passes) {
			after(d);
			if (v) say(d, `return ${v}`);
			return;
		}
		// The update pass runs later, in the scope the creation pass v.
		say(d, v ? `return (${v}, {` : 'return {');
		if (wrap) say(d + 1, 'try EffectOrder.resume(__scope) { () throws -> Void in');
		const at = wrap ? d + 2 : d + 1;
		steps(b.update ?? [], at);
		after(at);
		if (wrap) say(d + 1, '}');
		say(d, v ? '})' : '}');
	};
	const root = plan.root;
	if (root.kind === 'page') {
		say(d, 'let page = try Page.routed()');
		if (root.host) say(d, `self.${ident(root.host)}.attach(page)`);
		steps(root.body.steps, d);
		if (root.content) say(d, `page.kitAddChild(${root.content})`);
		end(root.body, 'page');
	} else if (root.kind === 'fragment') {
		say(d, 'let root = RegionFragment(region)');
		steps(root.body.steps, d);
		say(d, 'region.set(parts: root.parts)');
		end(root.body);
	} else {
		steps(root.body.steps, d);
		end(root.body, root.view);
	}
	if (wrap) say(2, '}');
	say(1, '}');
	if (passes) {
		say(1, `func ${m.init}() {${passes.init ? ` ${run(passes.init)} ` : ''}}`);
		if (passes.doCheck) say(1, `func ${m.doCheck}() { ${run(passes.doCheck)} }`);
		if (passes.afterContent) say(1, `func ${m.afterContent}() { ${run(passes.afterContent)} }`);
		if (passes.contentChecked) say(1, `func ${m.contentChecked}() { ${run(passes.contentChecked)} }`);
		say(1, `func ${m.afterView}() {${passes.afterView ? ` ${run(passes.afterView)} ` : ''}}`);
		if (passes.viewChecked) say(1, `func ${m.viewChecked}() { ${run(passes.viewChecked)} }`);
	}
	return lines;
}
