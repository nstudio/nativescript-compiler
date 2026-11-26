import type { ComponentIR } from '../api/ir.ts';
import { DEFAULT_BEHAVIOUR, kitName, type ComponentInfo } from '../template/model.ts';
import { regionHost, renderPlan, type Arg, type Block, type Call, type ComponentArg, type PropWrite, type Scope, type Step, type RootHook } from '../template/plan.ts';
import type { TemplateBehaviour, TemplateKit } from '../api/adapter-api.ts';
import { KOTLIN_LEDGER } from '../semantics/ledger.ts';
import { ident, kotlinString, RT } from './syntax.ts';

export interface RenderOptions {
	behaviour?: TemplateBehaviour;
	/** A binding method's value (or a static attribute's, method null) as a child component's input holds it, where the two are held apart. */
	propValue?: (component: string, prop: string, method: string | null) => ((value: string) => string) | null;
	/** The Kotlin name of a class the template names by its TypeScript name (a component, a registered element). */
	kotlinClass?: (name: string) => string;
}

/**
 * A component's template (template/plan.ts) as a Kotlin `render()`: views are created once, each binding is one effect
 * that sets one property, and each `if`/`for` owns a region of its container. Nothing is diffed at run time. What a
 * binding or handler throws is reported.
 */
export function render(c: ComponentIR, components: Map<string, ComponentInfo>, options: RenderOptions = {}): string[] {
	const behaviour = options.behaviour ?? DEFAULT_BEHAVIOUR;
	const plan = renderPlan(c, components, behaviour, KOTLIN_LEDGER);
	const lines: string[] = [];
	const say = (depth: number, text: string): void => {
		lines.push('    '.repeat(depth) + text);
	};
	const kit = <K extends keyof TemplateKit>(key: K) => kitName(behaviour, key);
	const arg = (a: Arg) => (typeof a === 'string' ? a : 'string' in a ? kotlinString(a.string) : 'checked' in a ? 'it' : `EventData(${kotlinString(a.eventData)}, ${a.object ?? 'null'}, value)`);
	const call = (k: Call) => `this.${ident(k.method)}(${[...k.loops.flatMap((l) => (l.index === undefined ? [l.itemExpr ?? ident(l.item)] : [l.itemExpr ?? ident(l.item), l.indexExpr ?? ident(l.index)])), ...k.extra.map(arg)].join(', ')})`;
	const run = (k: Call) => `${RT.jsReport} { ${call(k)} }`;
	const handler = (k: Call) => (behaviour.eventScope === 'none' ? run(k) : behaviour.eventScope === 'event+dirtyView' ? `Reactivity.event(__dv) { ${run(k)} }` : `Reactivity.event { ${run(k)} }`);
	// A listener marking its view dirty holds the view current where it is added.
	const held = (listen: string) => (behaviour.eventScope === 'event+dirtyView' ? `${kit('currentView')}.let { __dv -> ${listen} }` : listen);
	/** A value a read computes; what it throws is reported and the value is undefined. */
	const caught = (code: string) => `try { ${code} } catch (__e: Throwable) { ${RT.jsReportUncaught}(${RT.jsCaught}(__e)); null }`;
	const read = (k: Call, report: boolean) => (report ? caught(call(k)) : call(k));
	const cond = (k: Call, report: boolean) => `${RT.jsTruthy}(${read(k, report)})`;
	const check = (k: Call, apply: string) => `${kit('check')}({ ${call(k)} }) { ${apply} }`;
	const site = (text: string) => kotlinString(text);
	const scope = (s: Scope) => {
		if (s.inView) return `${s.call}(__view) {`;
		const v = s.view;
		if (v?.component) return `${s.call}(${v.injector ? `this.${ident(v.injector)}` : 'null'}, this${v.onPush ? ', true' : ''}) {`;
		return `${s.call}${v?.onPush ? `(${v.injector ? `this.${ident(v.injector)}` : 'null'}, this)` : v?.injector ? `(this.${ident(v.injector)})` : ''} {`;
	};
	const converted = (w: { convert: PropWrite['convert'] }, value: string) => {
		const conv = w.convert ? options.propValue?.(w.convert.component, w.convert.prop, w.convert.method) : null;
		return conv ? conv(value) : value;
	};
	/** A prop's binding as it applies: the setter's method called (reporting what it throws), or the prop's signal written. */
	const write = (w: PropWrite, value: string) => (w.setter ? `${RT.jsReport} { ${w.component}.${ident('$set_' + w.prop)}(${value}) }` : `${w.component}.${ident(w.prop)}.value = ${converted(w, value)}`) + (w.changes ? `; ${w.component}._change(${kotlinString(w.prop)}, ${value})` : '') + (w.inputChanged ? `; ${kit('inputChanged')}(${w.component})` : '');
	/** A child's input as its constructor takes it: a static value, or a binding's first value read untracked, its type's zero where the read throws. */
	const componentArg = (a: ComponentArg) => {
		if ('value' in a) return `${ident(a.prop)} = ${converted(a, kotlinString(a.value))}`;
		if (a.optional) throw new Error(`${c.name}: Kotlin's component construction takes every input it is given (Ledger.throwingOptionalInputsLeftOut)`);
		return `${ident(a.prop)} = ${RT.untrack} { ${RT.jsReadOrZero} { ${converted(a, call(a.read))} } }`;
	};

	const steps = (list: Step[], depth: number) => {
		for (const s of list) step(s, depth);
	};
	/** A branch's or row's steps; under `passes`, its update pass held until its region's template has run its bindings. */
	const body = (b: Block, d: number) => {
		steps(b.steps, d);
		if (!b.update) return;
		say(d, `${kit('embedded').later} {`);
		steps(b.update, d + 1);
		say(d, '}');
	};
	/** A fragmented branch or row body: its views and nested regions. */
	const fragment = (b: Block, depth: number, host: string) => {
		say(depth, `val ${b.fragment} = RegionFragment(${host})`);
		body(b, depth);
		say(depth, b.fragment!);
	};
	/** A branch's or row's views, in the region's scope when it has one. */
	const views = (s: Scope | null, viewMark: boolean, depth: number, body: (d: number) => void) => {
		const wrap = s ? scope(s) : null;
		const d = wrap ? depth + 1 : depth;
		if (wrap) say(depth + 1, wrap);
		if (viewMark) say(d + 1, 'val __view = EffectOrder.current');
		body(d);
		if (wrap) say(depth + 1, '}');
	};
	const step = (s: Step, depth: number): void => {
		switch (s.kind) {
			case 'local':
				return say(depth, `val ${s.name} = ${call(s.make)}`);
			case 'letSlot':
				return say(depth, `val ${s.name} = ${kit('letSlot')} { ${call(s.read)} }`);
			case 'storeLet':
				return say(depth, `${s.slot}.store()`);
			case 'cleanup':
				return say(depth, `Owner.current?.onCleanup { ${run(s.call)} }`);
			case 'run':
				return say(depth, run(s.call));
			case 'outlet':
				// The outlet `primary` names is the call's default.
				return say(depth, `val ${s.view} = ${s.call}(${s.name !== null && !s.primary ? kotlinString(s.name) : ''})`);
			case 'create':
				return say(depth, `val ${s.view} = ${options.kotlinClass?.(s.tag) ?? s.tag}()`);
			case 'hostAttach':
				return say(depth, `this.${ident(s.host)}.attach(${s.view})`);
			case 'ref':
				return say(depth, `${call(s.call)}.current = ${s.view}`);
			case 'setAttr':
				return say(depth, s.name === 'class' ? `${s.view}.className = ${kotlinString(s.value)}` : `${s.view}.kitSet(${kotlinString(s.name)}, ${kotlinString(s.value)})`);
			case 'bindAttr': {
				if (s.mode === 'check') return say(depth, check(s.call, s.name === 'class' ? `${s.view}.className = it` : `${s.view}.kitSet(${kotlinString(s.name)}, it)`));
				if (s.name === 'class') return say(depth, `Effect { ${RT.jsReport} { ${s.view}.className = ${s.slots ? `${kit('className')}(${call(s.call)})` : call(s.call)} } }`);
				return say(depth, `Effect { ${RT.jsReport} { ${s.view}.kitSet(${kotlinString(s.name)}, ${s.slots ? `${kit('attributeValue')}(${call(s.call)})` : call(s.call)}) } }`);
			}
			case 'ifPassed':
				say(depth, `if (this._passed.contains(${kotlinString(s.prop)})) {`);
				steps(s.steps, depth + 1);
				return say(depth, '}');
			case 'directive':
				return say(depth, `val ${s.name} = ${kit('directiveHost')}(${s.view}) { ${call(s.make)} }`);
			case 'checkRun':
				return say(depth, check(s.read, run(s.run)));
			case 'flushChanges':
				return say(depth, `${kit('check')}({ ${s.target}._changed.value }) { ${RT.jsReport} { ${s.target}._flushChanges() } }`);
			case 'checkSet':
				return say(depth, check(s.call, `${s.view}.kitSet(${kotlinString(s.prop)}, it)`));
			case 'listen': {
				const listen = held(`${s.view}.kitOn(${kotlinString(s.event)}) { event -> ${handler(s.call)} }`);
				const guarded = s.when ? `if (${cond(s.when, true)}) ${listen}` : listen;
				return say(depth, s.ifPassed !== null ? `if (this._passed.contains(${kotlinString(s.ifPassed)})) ${guarded}` : guarded);
			}
			case 'subscribe':
				return say(depth, held(`${s.target}.${s.output}.subscribe { event: Any? -> ${handler(s.call)} }`));
			case 'attach':
				return say(depth, s.parent ? (s.slots ? `${s.parent}.kitAddTemplateChild(${s.view})` : `${s.parent}.kitAddChild(${s.view})`) : `${s.region}.attach(${s.view})`);
			case 'component': {
				const args = s.args.map(componentArg);
				if (s.passed) args.push(`_passed = setOf(${s.passed.map((p) => kotlinString(p)).join(', ')})`);
				const made = `${options.kotlinClass?.(s.type) ?? s.type}(${args.join(', ')})`;
				const ctor = behaviour.kit?.construct ? `${behaviour.kit.construct} { ${made} }` : made;
				return say(depth, `val ${s.name} = ${ctor}`);
			}
			case 'write':
				return say(depth, write(s.write, kotlinString(s.value)));
			case 'change':
				return say(depth, `${s.component}._change(${kotlinString(s.prop)}, ${kotlinString(s.value)})`);
			case 'bindProp':
				return say(depth, s.mode === 'check' ? check(s.call, write(s.write, 'it')) : `Effect { ${RT.jsReport} { ${write(s.write, call(s.call))} } }`);
			case 'output':
				return say(depth, held(`${s.component}.${ident(s.field)}.on { value -> ${handler(s.call)} }`));
			case 'renderInto':
				return say(depth, `${s.component}.${s.member}(${s.parent}.kitAddRegion())`);
			case 'renderView':
				return say(depth, `val ${s.view} = ${s.component}.${s.member}()`);
			case 'createView':
				return say(depth, `val (${s.view}, ${s.update}) = ${s.component}.${s.member}()`);
			case 'createInto':
				return say(depth, `val ${s.update} = ${s.component}.${s.member}(${s.parent}.kitAddRegion())`);
			case 'childHook':
				return say(depth, `${s.component}.${s.member}()`);
			case 'flushEffects':
				return say(depth, `${s.call}(${s.component})`);
			case 'updateChild':
				return say(depth, `${s.update}()`);
			case 'everyCheck':
				say(depth, `${s.call} {`);
				step(s.hook, depth + 1);
				return say(depth, '}');
			case 'embeddedViews':
				say(depth, `${kit('embedded').collect} {`);
				steps(s.steps, depth + 1);
				return say(depth, '}');
			case 'region':
				return say(depth, s.detached ? `val ${s.name} = Region(null)` : `val ${s.name} = ${s.parent}.kitAddRegion()`);
			case 'addRegion':
				return say(depth, `${s.parent}.kitAddRegion(${s.region})`);
			case 'setSlot': {
				say(depth, `${s.component}.__slots[${kotlinString(s.name)}] = { __sr: Region ->`);
				const wrap = s.scope ? scope(s.scope) : null;
				const d = wrap ? depth + 2 : depth + 1;
				if (wrap) say(depth + 1, wrap);
				if (s.viewMark) say(d, 'val __view = EffectOrder.current');
				say(d, `val ${s.body.fragment} = RegionFragment(__sr)`);
				steps(s.body.steps, d);
				say(d, `${s.body.fragment}.fill()`);
				if (wrap) say(depth + 1, '}');
				return say(depth, '}');
			}
			case 'slot': {
				const host = regionHost(s.host);
				if (s.fallback) {
					say(depth, `this.__slots[${kotlinString(s.name)}]?.invoke(${host}) ?: run {`);
					say(depth + 1, `val ${s.fallback.fragment} = RegionFragment(${host})`);
					steps(s.fallback.steps, depth + 1);
					say(depth + 1, `${s.fallback.fragment}.fill()`);
					return say(depth, '}');
				}
				return say(depth, `this.__slots[${kotlinString(s.name)}]?.invoke(${host})`);
			}
			case 'choose': {
				const host = regionHost(s.host);
				const which = s.conds.map((k, i) => (k ? `if (${cond(k, s.caught)}) ${i} else ` : `${i}`)).join('') + (s.conds.at(-1) ? `${s.conds.length}` : '');
				if (s.fragment) {
					say(depth, `${RT.ChooseFragment}(${host}, { ${which} }, site = ${site(s.site)}) { branch ->`);
					say(depth + 1, 'when (branch) {');
					s.branches.forEach((b, i) => {
						say(depth + 2, `${i} -> {`);
						fragment(b, depth + 3, host);
						say(depth + 2, '}');
					});
					say(depth + 2, `else -> RegionFragment(${host})`);
					say(depth + 1, '}');
					return say(depth, '}');
				}
				say(depth, `${RT.Choose}(${host}, { ${which} }, site = ${site(s.site)}) { branch ->`);
				views(s.scope, s.viewMark, depth, (d) => {
					say(d + 1, 'when (branch) {');
					s.branches.forEach((b, i) => {
						say(d + 2, `${i} -> {`);
						body(b, d + 3);
						say(d + 3, `listOf(${b.made.join(', ')})`);
						say(d + 2, '}');
					});
					say(d + 2, 'else -> listOf()');
					say(d + 1, '}');
				});
				return say(depth, '}');
			}
			case 'for': {
				const host = regionHost(s.host);
				// A key may be any value (`:key="i"`); rows are kept by its string form.
				const key = s.key ? `{ ${ident(s.item)}, ${ident(s.index)} -> ${RT.jsKey}(${read(s.key, s.caught)}) }` : `{ item, _ -> ${RT.jsKey}(item) }`;
				const row = (d: number) => {
					if (s.fragment) return fragment(s.body, d, host);
					body(s.body, d);
					say(d, `listOf(${s.body.made.join(', ')})`);
				};
				if (s.rows === 'value') {
					// `{list?.map(…)}`: an absent list renders no rows.
					say(depth, `${s.fragment ? RT.ForEachFragment : RT.ForEach}(${host}, { ${kit('rowItems')}(${read(s.items, s.caught)}) }, ${key}, site = ${site(s.site)}) { ${s.row} ->`);
					row(depth + 1);
					return say(depth, '}');
				}
				const kind = s.row ? (s.fragment ? RT.ForEachFragment : RT.ForEach) : s.fragment ? RT.ForFragment : RT.For;
				// Iterating reads the array through its tracker: pushing to an array a ref holds re-renders the rows.
				say(depth, `${kind}(${host}, { ${call(s.items)}.forItems }, ${key}, site = ${site(s.site)}) { ${s.row ?? `${ident(s.item)}, ${ident(s.index)}`} ->`);
				if (s.fragment) row(depth + 1);
				else views(s.scope, s.viewMark, depth, (d) => row(d + 1));
				return say(depth, '}');
			}
			case 'list': {
				const sel = s.selector ? `, selector = { item, index -> ${call(s.selector)} }` : '';
				if (s.headerXml !== null) say(depth, `${s.view}.kitSet("stickyHeaderTemplate", ${kotlinString(s.headerXml)})`);
				// Core's ListView binds its own; another host (a plugin's Pager) through the bridge's. A sectioned list's items are
				// its sections, a row's item one of a section's `items`.
				const bind = s.sections ? 'kitBindSections' : s.tag === 'ListView' ? 'bind' : 'kitBindItems';
				const source = s.sections ? `sections = { ${call(s.items)} }, rows = { it.items.elements }` : `items = { ${call(s.items)} }`;
				if (!s.templates.length) return say(depth, `${s.view}.${bind}(${source}${sel})`);
				if (s.header) throw new Error(`${c.name}: Kotlin's lists hand core a sectioned list's header as XML (Ledger.listHeaderRendered)`);
				say(depth, `${s.view}.${bind}(${source}, templates = listOf(${s.keys.map((k) => kotlinString(k)).join(', ')})${sel}) { key, ${s.row} ->`);
				say(depth + 1, 'when (key) {');
				for (const t of s.templates) {
					say(depth + 2, `${t.fallback ? 'else' : kotlinString(t.key)} -> {`);
					const wrap = s.scope ? scope(s.scope) : null;
					const d = wrap ? depth + 3 : depth + 2;
					if (wrap) say(depth + 3, wrap);
					if (t.body.viewMark) say(d + 1, 'val __view = EffectOrder.current');
					steps(t.body.steps, d + 1);
					say(d + 1, t.body.made[0]);
					if (wrap) say(depth + 3, '}');
					say(depth + 2, '}');
				}
				say(depth + 1, '}');
				return say(depth, '}');
			}
		}
	};

	const passes = plan.passes;
	const m = plan.members;
	if (plan.hasSlots) say(1, 'var __slots: MutableMap<String, (Region) -> Unit> = mutableMapOf()');
	if (passes) {
		// Both passes, with the hooks a parent runs for its child between and after them.
		const hooks = (list: RootHook[]) => list.map((h) => (h.flush ? `${h.flush}(this)` : h.every ? `${h.every} { this.${h.member}() }` : `this.${h.member}()`)).join('; ');
		const before = hooks(passes.before);
		const after = hooks(passes.after);
		const rs = behaviour.kit?.rootScope;
		if (plan.fragment) say(1, `fun ${m.render}(into: Region) { ${rs ? `${rs} { val update = ${m.create}(into); ${before}; update(); ${after} }` : `val update = ${m.create}(into); ${before}; update(); ${after}`} }`);
		else say(1, `fun ${m.render}(): View { ${rs ? `return ${rs} { val (view, update) = ${m.create}(); ${before}; update(); ${after}; view }` : `val (view, update) = ${m.create}(); ${before}; update(); ${after}; return view`} }`);
		say(1, plan.fragment ? `fun ${m.create}(into: Region): () -> Unit {` : `fun ${m.create}(): Pair<View, () -> Unit> {`);
	} else say(1, plan.fragment ? `fun ${m.render}(into: Region) {` : `fun ${m.render}(): View {`);
	const wrap = plan.scope ? scope(plan.scope) : null;
	const d = wrap ? 3 : 2;
	if (wrap) say(2, `return ${wrap}`);
	if (passes && wrap) say(d, 'val __scope = EffectOrder.current');
	if (plan.viewMark) say(d, 'val __view = EffectOrder.current');
	for (const x of plan.derived) say(d, `${RT.derive} { ${RT.jsReport} { this.${ident(x.name)}.value = ${call(x.call)} } }`);
	// Inside the scope lambda the result is its last expression.
	const result = (v: string) => say(d, wrap ? v : `return ${v}`);
	// The destroy hook runs when the scope the component was made in ends.
	if (plan.destroy) say(d, `Owner.current?.onCleanup { ${run(plan.destroy)} }`);
	if (plan.init) say(d, run(plan.init));
	// A watcher runs before the bindings of its component (a pre-flush job).
	for (const w of plan.watchers) say(d, `${RT.Watch}(${w.immediate}, { ${call(w.source)} }) { value, old -> ${run(w.handler)} }`);
	const after = (d: number) => {
		for (const h of plan.userEffects) say(d, `EffectOrder.user { Effect { ${run(h)} } }`);
		for (const e of plan.effects) say(d, `ComponentEffect(${e.layout}, ${e.deps ? `{ ${call(e.deps)}.elements }` : 'null'}) { ${call(e.run)} }`);
		if (plan.afterView) say(d, run(plan.afterView));
	};
	/** The rest of the template once its own steps are made, and what it gives. */
	const end = (b: Block, v?: string) => {
		if (!passes) {
			after(d);
			if (v) result(v);
			return;
		}
		// The update pass runs later, in the scope the creation pass v.
		say(d, 'val __update: () -> Unit = {');
		if (wrap) say(d + 1, 'EffectOrder.resume(__scope) {');
		const at = wrap ? d + 2 : d + 1;
		steps(b.update ?? [], at);
		after(at);
		if (wrap) say(d + 1, '}');
		say(d, '}');
		result(v ? `Pair(${v}, __update)` : '__update');
	};
	const root = plan.root;
	if (root.kind === 'page') {
		say(d, 'val page = routedPage()');
		if (root.host) say(d, `this.${ident(root.host)}.attach(page)`);
		steps(root.body.steps, d);
		if (root.content) say(d, `page.kitAddChild(${root.content})`);
		end(root.body, 'page');
	} else if (root.kind === 'fragment') {
		say(d, 'val root = RegionFragment(into)');
		steps(root.body.steps, d);
		say(d, 'root.fill()');
		end(root.body);
	} else {
		steps(root.body.steps, d);
		end(root.body, root.view);
	}
	if (wrap) say(2, '}');
	say(1, '}');
	if (passes) {
		say(1, `fun ${m.init}() {${passes.init ? ` ${run(passes.init)} ` : ''}}`);
		if (passes.doCheck) say(1, `fun ${m.doCheck}() { ${run(passes.doCheck)} }`);
		if (passes.afterContent) say(1, `fun ${m.afterContent}() { ${run(passes.afterContent)} }`);
		if (passes.contentChecked) say(1, `fun ${m.contentChecked}() { ${run(passes.contentChecked)} }`);
		say(1, `fun ${m.afterView}() {${passes.afterView ? ` ${run(passes.afterView)} ` : ''}}`);
		if (passes.viewChecked) say(1, `fun ${m.viewChecked}() { ${run(passes.viewChecked)} }`);
	}
	return lines;
}
