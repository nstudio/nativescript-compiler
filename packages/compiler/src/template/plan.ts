// A component's template as one plan both backends render (swift/render.ts, kotlin/render.ts): which views and
// components are made, which properties set and bound, which listeners added, which regions own which branches and rows,
// in the order the framework's behaviour runs them, and what a read that throws does. A backend spells each step; it
// decides nothing the plan states.
import { basename } from 'node:path';
import ts from 'typescript';
import { withoutLocals, type Attr, type ComponentIR, type DirectiveUse, type QueryHook, type TNode } from '../api/ir.ts';
import type { ComponentMembers, TemplateBehaviour, TemplateKit } from '../api/adapter-api.ts';
import type { Ledger } from '../semantics/ledger.ts';
import { DEFAULT_BEHAVIOUR, LIST_BINDINGS, TEMPLATE_HOSTS, isFragment, kitName, type ComponentInfo } from './model.ts';

/**
 * A name in scope that binding methods take, in order, before their own arguments: a loop's item and index, a local's
 * value, or a directive. An item template's or a signal row's item and index are its row's signals (`itemExpr`).
 */
export interface Loop {
	item: string;
	index?: string;
	itemExpr?: string;
	indexExpr?: string;
}

/**
 * An argument after the names in scope: a name the step binds (`event`, `value`, a view), a string literal, the value
 * a check gives its apply closure, or the event data a component's output makes of what it emits.
 */
export type Arg = string | { string: string } | { checked: true } | { eventData: string; object: string | null };

/** A call of one of the component's methods with the names in scope; what it throws is reported unless the step says otherwise. */
export interface Call {
	method: string;
	loops: readonly Loop[];
	extra: readonly Arg[];
}

/** A child component's input as it takes the value a binding (`method`) or a static attribute (`method` null) gives. */
export interface Conversion {
	component: string;
	prop: string;
	method: string | null;
}

/** How a child component's input is written: its setter method, or its signal (converted), then its change hook and onPush mark. */
export interface PropWrite {
	component: string;
	prop: string;
	setter: boolean;
	throwingSetter: boolean;
	convert: Conversion | null;
	changes: boolean;
	inputChanged: boolean;
}

/** A constructor argument of a child component: a static attribute's value, or a binding's first value read untracked. */
export type ComponentArg =
	| { prop: string; value: string; convert: Conversion | null }
	| {
			prop: string;
			read: Call;
			convert: Conversion | null;
			/**
			 * A read that throws leaves the input out, at its default (`Ledger.throwingOptionalInputsLeftOut`); otherwise it
			 * starts at its type's zero. Either way it is not reported here: the prop's binding, which follows the
			 * component's construction, reads it again and reports what it throws.
			 */
			optional: boolean;
	  };

/** The scope a template or region renders in (`TemplateBehaviour.effectScope`), spelled by the kit's `scope` names. */
export interface Scope {
	call: string;
	/** A view scope: given the component's injector, the component itself (`component`) and whether it is `onPush` (`template` only). */
	view: { component: boolean; onPush: boolean; injector: string | null } | null;
	/** A region's scope is made from the view's scope, `__view`. */
	inView: boolean;
}

/** Where a region's views go: a region already named, or one added to `parent` where the step is. */
export type Host = { region: string } | { parent: string };

/** A sequence of steps: a template's own, then (in that order) its deferred inserts, bindings, listeners and after-view hooks. */
export interface Block {
	steps: Step[];
	/**
	 * Under `TemplateBehaviour.passes`, a component's template or a branch's or row's body: `steps` is the creation pass
	 * and this the update pass (the bindings and regions, the updates of the branches and rows they made, the children's
	 * updates, then the after-view hooks). An item template's body holds both in `steps`.
	 */
	update?: Step[];
	/** The views made at the block's top level, which a branch, row or item template returns. */
	made: string[];
	/** The block's body reads its view's effect scope as `__view` (a view scope with regions of its own). */
	viewMark: boolean;
	/** A fragmented body: its views and nested regions collected in this `RegionFragment` over the step's host. */
	fragment: string | null;
}

export type Step =
	| { kind: 'local'; name: string; make: Call }
	/** A `let` variable's slot (`TemplateKit.letSlot`), made from the closure reading its value. */
	| { kind: 'letSlot'; name: string; read: Call }
	/** A `let` variable's value read into its slot, now and on every check of the view (`store()`). */
	| { kind: 'storeLet'; slot: string }
	| { kind: 'cleanup'; call: Call }
	| { kind: 'run'; call: Call }
	| { kind: 'outlet'; view: string; call: string; name: string | null; primary: boolean }
	| { kind: 'create'; view: string; tag: string }
	| { kind: 'hostAttach'; host: string; view: string }
	| { kind: 'ref'; call: Call; view: string }
	/** A static attribute; `class` is the view's class name. */
	| { kind: 'setAttr'; view: string; name: string; value: string }
	/** A bound attribute: re-read on each check (`check`), or an effect; under `slots`, the value as JSX gives it. */
	| { kind: 'bindAttr'; view: string; name: string; call: Call; mode: 'check' | 'effect'; slots: boolean }
	/** Steps run only when the parent gave the prop a spread passes on. */
	| { kind: 'ifPassed'; prop: string; steps: Step[] }
	| { kind: 'directive'; name: string; view: string; make: Call }
	| { kind: 'checkRun'; read: Call; run: Call }
	| { kind: 'flushChanges'; target: string }
	| { kind: 'checkSet'; view: string; prop: string; call: Call }
	/** A view's listener; added only when `when` gives a truthy value (reported and false where it throws), and only if the prop was passed. */
	| { kind: 'listen'; view: string; event: string; call: Call; when: Call | null; ifPassed: string | null }
	| { kind: 'subscribe'; target: string; output: string; call: Call }
	| { kind: 'attach'; view: string; parent: string | null; region: string | null; slots: boolean }
	| { kind: 'component'; name: string; type: string; args: ComponentArg[]; passed: string[] | null; initThrows: boolean }
	| { kind: 'write'; write: PropWrite; value: string }
	| { kind: 'change'; component: string; prop: string; value: string }
	| { kind: 'bindProp'; call: Call; write: PropWrite; mode: 'check' | 'effect' }
	| { kind: 'output'; component: string; field: string; call: Call }
	/** A child's `render` member (`member`): its views in a region added to `parent`, or its view. */
	| { kind: 'renderInto'; component: string; parent: string; member: string }
	| { kind: 'renderView'; view: string; component: string; member: string }
	/**
	 * Under `passes`: a child's creation pass (`member`), its view (`createView`) or its views in a region added to
	 * `parent` (`createInto`), its update pass named `update`.
	 */
	| { kind: 'createView'; view: string; component: string; member: string; update: string }
	| { kind: 'createInto'; component: string; parent: string; member: string; update: string }
	/** A child's hook (`ComponentMembers`), which its parent runs. */
	| { kind: 'childHook'; component: string; member: string }
	/** Flushes a child component's construction-scoped initial effects (`TemplateKit.flushEffects`). */
	| { kind: 'flushEffects'; component: string; call: string }
	/** A child's or a directive's checked hook, run now and at `phase` of every check of the view: `call { hook }` (`TemplateKit.everyCheck`). */
	| { kind: 'everyCheck'; hook: Step; phase: Phase; call: string }
	/** Steps whose regions' branches and rows are updated once they have run (`TemplateKit.embedded`). */
	| { kind: 'embeddedViews'; steps: Step[] }
	| { kind: 'updateChild'; update: string }
	/** A region added to `parent` (`detached`: made apart, its insert deferred as an `addRegion`). */
	| { kind: 'region'; name: string; parent: string; detached: boolean }
	| { kind: 'addRegion'; parent: string; region: string }
	| {
			kind: 'choose';
			host: Host;
			/** Each branch is a fragment of views and nested regions (`Block.fragment`). */
			fragment: boolean;
			/**
			 * The conditions of the branches in order, null for an `else`. A condition that throws is reported and the region
			 * keeps the branch it shows (none before a read succeeds); under `slots` it is reported and false (`caught`).
			 */
			conds: (Call | null)[];
			caught: boolean;
			site: string;
			scope: Scope | null;
			viewMark: boolean;
			branches: Block[];
	  }
	| {
			kind: 'for';
			host: Host;
			fragment: boolean;
			item: string;
			index: string;
			items: Call;
			key: Call | null;
			/** The rows are signal rows named `row` (`rowSignals`); `value` rows read any value as the items, an absent one giving none. */
			rows: 'off' | 'array' | 'value';
			row: string | null;
			/**
			 * Items or a key that throw are reported and the rows stay as they are (none before a read succeeds). `value`
			 * rows leave out what their items and key throw, giving no rows; reported too where `caught`
			 * (`Ledger.valueRowReadsReported`).
			 */
			caught: boolean;
			site: string;
			scope: Scope | null;
			viewMark: boolean;
			body: Block;
	  }
	| {
			kind: 'list';
			view: string;
			tag: string;
			sections: boolean;
			/** Items that throw are reported and the list keeps its items (the kit's list binding). */
			items: Call;
			/** A selector that throws is reported and the row takes the default template (the kit's list binding). */
			selector: Call | null;
			/** A sectioned list's header as core's XML, which the platform's ListView parses itself (`Ledger.listHeaderRendered` false). */
			headerXml: string | null;
			row: string | null;
			scope: Scope | null;
			/** The item templates' keys as declared. */
			keys: string[];
			/** The item templates, the default one last (`fallback`). */
			templates: { key: string; fallback: boolean; body: Block }[];
			header: Block | null;
	  };

/** A point of a view's check a hook runs at again on each check (`TemplateKit.everyCheck`). */
export type Phase = 'check' | 'content' | 'view';

/** One of a root component's hooks its `render()` runs: its member, run now, and again on every check where `every` names the kit's call. */
export interface RootHook {
	member: string;
	every: string | null;
	flush?: string;
}

/** A component's `render()`. */
export interface RenderPlan {
	/** It renders into its parent's region rather than returning one view. */
	fragment: boolean;
	scope: Scope | null;
	viewMark: boolean;
	derived: { name: string; call: Call }[];
	destroy: Call | null;
	init: Call | null;
	watchers: { immediate: boolean; source: Call; handler: Call }[];
	root: { kind: 'page'; host: string | null; body: Block; content: string | null } | { kind: 'fragment'; body: Block } | { kind: 'view'; body: Block; view: string };
	/** Once the template is made: user effects, the component's effects, then the after-view hook. */
	userEffects: Call[];
	effects: { layout: boolean; deps: Call | null; run: Call }[];
	afterView: Call | null;
	/** The names of its generated members. */
	members: ComponentMembers;
	/**
	 * Under `passes`: its hooks, which its parent's `childHook`s run, or its `render`: `before` its update pass, `after`
	 * it, in that order.
	 */
	passes?: { init: Call | null; doCheck: Call | null; afterContent: Call | null; contentChecked: Call | null; afterView: Call | null; viewChecked: Call | null; before: RootHook[]; after: RootHook[] };
}

/** The generated members' names, where no member of the component is spelled as one. */
export const COMPONENT_MEMBERS: ComponentMembers = { render: 'render', create: '__create', init: '__init', doCheck: '__doCheck', afterContent: '__afterContent', contentChecked: '__contentChecked', afterView: '__afterView', viewChecked: '__viewChecked' };

/**
 * The generated members of a component class whose own members (inherited and static ones too) are `taken`: each name
 * with `_` appended until no member is spelled as it, by the identifier rule both backends share (`$` and every other
 * character no identifier holds as `_`, a leading `#` as `_p_`).
 */
export function componentMembers(taken: Iterable<string>): ComponentMembers {
	const spelled = new Set([...taken].map((n) => n.replace(/^#/, '_p_').replace(/\W/g, '_')));
	const free = (n: string): string => (spelled.has(n) ? free(n + '_') : n);
	return Object.fromEntries(Object.entries(COMPONENT_MEMBERS).map(([k, v]) => [k, free(v)])) as unknown as ComponentMembers;
}

/** `componentMembers` of a component's class: its instance members, inherited ones included, and its static ones. */
export function componentMembersOf(cls: ts.ClassDeclaration, checker: ts.TypeChecker): ComponentMembers {
	const sym = cls.name && checker.getSymbolAtLocation(cls.name);
	const instance = sym ? checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(sym)).map((p) => p.name) : [];
	const statics = cls.members.flatMap((m) => (m.name && ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Static ? [m.name.getText()] : []));
	return componentMembers([...instance, ...statics]);
}

/** Where a region's views go, as the kit spells it: a region already named, or one added to its parent now. */
export const regionHost = (h: Host): string => ('region' in h ? h.region : `${h.parent}.kitAddRegion()`);

/**
 * The plan of a component's template under its framework's behaviour. `ledger` is the backend's, for the differences
 * between the two kits' templates it names.
 */
export function renderPlan(c: ComponentIR, components: ReadonlyMap<string, ComponentInfo>, behaviour: TemplateBehaviour = DEFAULT_BEHAVIOUR, ledger: Pick<Ledger, 'throwingOptionalInputsLeftOut' | 'valueRowReadsReported' | 'listHeaderRendered' | 'pageContentLayout'>): RenderPlan {
	const postOrder = behaviour.propsOrder === 'post';
	const { deferBindings, insertion, slots } = behaviour;
	const passes = !!behaviour.passes;
	const members = (component: string) => components.get(component)?.members ?? COMPONENT_MEMBERS;
	const onPush = behaviour.checkEveryBinding === 'check+onPush';
	const checkAll = behaviour.checkEveryBinding !== 'off';
	const kit = <K extends keyof TemplateKit>(key: K) => kitName(behaviour, key);
	const every = (hook: Step, phase: Phase): Step => ({ kind: 'everyCheck', hook, phase, call: kit('everyCheck')[phase] });
	let n = 0;
	const site = (what: string) => `${c.name} (${basename(c.file).replace(/\.ts$/, '')}): ${what}`;
	const call = (method: string, loops: readonly Loop[], extra: readonly Arg[] = []): Call => ({ method, loops, extra });

	/**
	 * The scope a template (`template`), a list's item template (`item`) or an `if` branch's or `for` row's body (`region`)
	 * renders in. An item template's view is never its component's, so never checked `onPush`: Angular checks a row with the
	 * view declaring its template.
	 */
	const scoped = (kind: 'template' | 'item' | 'region'): Scope | null => {
		if (!behaviour.effectScope) return null;
		const scope = kit('scope');
		if (behaviour.effectScope === 'component') return kind !== 'region' ? { call: scope.template, view: null, inView: false } : null;
		if (kind !== 'region') return { call: scope.template, view: behaviour.effectScope === 'view' ? { component: kind === 'template' && !!behaviour.kit?.construct, onPush: kind === 'template' && onPush && !!c.onPush, injector: c.injector ?? null } : null, inView: false };
		return { call: scope.region!, view: null, inView: behaviour.effectScope === 'view' };
	};
	const viewMark = (nodes: TNode[]) => behaviour.effectScope === 'view' && hasRegion(nodes);

	// The steps being written, innermost last, and the template scopes whose deferred steps follow their own.
	const out: Step[][] = [];
	const say = (step: Step) => out.at(-1)!.push(step);
	type Deferred = { inserts: Step[]; bindings: Step[]; listeners: Step[]; content: Step[]; children: Step[]; after: Step[] };
	const templates: Deferred[] = [];
	/** A node's change, init and check hooks, which run once the next node bound is reached: a `let` before it precedes them. */
	const pending = new Set<Step>();
	const block = (made: string[] = [], fragment: string | null = null, mark = false): Block => ({ steps: [], made, viewMark: mark, fragment });
	/**
	 * A template's body written into `b`, then its deferred inserts, bindings, listeners added after bindings, content
	 * hooks and after-view hooks; under `passes`, all but the inserts are its update pass (its bindings, the updates of
	 * the branches and rows they made, the content hooks, its children's updates, its after-view hooks): `b.update` for a
	 * component's template or a branch's or row's body (`passed`), the rest of `b.steps` for an item template's.
	 */
	const template = (b: Block, body: () => void, passed = false): Block => {
		templates.push({ inserts: [], bindings: [], listeners: [], content: [], children: [], after: [] });
		out.push(b.steps);
		body();
		const t = templates.pop()!;
		const regions = t.bindings.some((s) => s.kind === 'choose' || s.kind === 'for');
		const update = [...(regions ? [{ kind: 'embeddedViews' as const, steps: t.bindings }] : t.bindings), ...t.listeners, ...t.content, ...t.children, ...t.after];
		if (passes && passed) {
			b.steps.push(...t.inserts);
			b.update = update;
		} else if (passes) b.steps.push(...t.inserts, ...update);
		else b.steps.push(...t.inserts, ...t.bindings, ...t.listeners, ...t.content, ...t.after);
		out.pop();
		return b;
	};
	const binding = (step: Step) => ((deferBindings || passes) && templates.length ? templates.at(-1)!.bindings.push(step) : say(step));
	const hook = (step: Step) => {
		pending.add(step);
		binding(step);
	};
	/** Steps run once the template's embedded views are updated (`content`) or its children are (`after`); now, outside a template. */
	const later = (when: 'content' | 'after', ...steps: Step[]) => {
		if (templates.length) templates.at(-1)![when].push(...steps);
		else for (const s of steps) say(s);
	};
	const listener = (step: Step) => (behaviour.listenersAfterBindings && templates.length ? templates.at(-1)!.listeners.push(step) : say(step));
	/** Puts a view into its container or region at the point its framework inserts it. */
	const attach = (view: string, parent: string | null, region: string | null, at: 'created' | 'built') => {
		if (!parent && !region) return;
		const step: Step = { kind: 'attach', view, parent, region: parent ? null : region, slots };
		if (insertion === 'mounted' && templates.length) {
			if (at === 'created') templates.at(-1)!.inserts.push(step);
			return;
		}
		if ((insertion === 'created') === (at === 'created')) say(step);
	};
	const attr = (view: string, a: Attr, loops: readonly Loop[]) => {
		if (a.ifPassed) {
			const steps: Step[] = [];
			say({ kind: 'ifPassed', prop: a.ifPassed, steps });
			out.push(steps);
			attr(view, { ...a, ifPassed: undefined }, loops);
			out.pop();
			return;
		}
		if ('value' in a) say({ kind: 'setAttr', view, name: a.name, value: a.value });
		else binding({ kind: 'bindAttr', view, name: a.name, call: call(a.method, loops), mode: checkAll ? 'check' : 'effect', slots });
	};

	/**
	 * Directives on an element's view: each made with the view as its host, destroyed with its scope; its inputs, change
	 * hook, init and check hooks and host bindings applied with the template's bindings, in that order, its host
	 * listeners on the view; its content and after-view hooks, which `end` adds once the element's children are written.
	 * Under `passes` an input a static attribute gives is set as the directive is made, in the creation pass.
	 */
	const directed = (uses: DirectiveUse[] | undefined, outer: readonly Loop[], view: string): { loops: readonly Loop[]; end: () => void } => {
		let loops = outer;
		const content: Step[] = [],
			after: Step[] = [];
		for (const u of uses ?? []) {
			const d = `d${n++}`;
			say({ kind: 'directive', name: d, view, make: call(u.make, loops) });
			const inner = [...loops, { item: u.name, itemExpr: d }];
			if (u.destroy) say({ kind: 'cleanup', call: call(u.destroy, inner) });
			for (const a of u.attributes) say({ kind: 'setAttr', view, name: a.name, value: a.value });
			for (const i of u.inputs) {
				if ('value' in i) (passes ? say : binding)({ kind: 'run', call: call(i.set, inner, [{ string: i.value }]) });
				else binding({ kind: 'checkRun', read: call(i.method, loops), run: call(i.set, inner, [{ checked: true }]) });
			}
			if (u.changes) hook({ kind: 'flushChanges', target: d });
			if (u.init) hook({ kind: 'run', call: call(u.init, inner) });
			if (u.doCheck) hook(every({ kind: 'run', call: call(u.doCheck, inner) }, 'check'));
			for (const b of u.bindings) binding({ kind: 'checkSet', view, prop: b.prop, call: call(b.method, inner) });
			for (const l of u.listeners) listener({ kind: 'listen', view, event: l.event, call: call(l.method, inner, ['event']), when: null, ifPassed: null });
			for (const o of u.outputs ?? []) listener({ kind: 'subscribe', target: d, output: o.name, call: call(o.method, inner, ['event']) });
			if (u.afterContentInit) content.push({ kind: 'run', call: call(u.afterContentInit, inner) });
			if (u.afterContentChecked) content.push(every({ kind: 'run', call: call(u.afterContentChecked, inner) }, 'content'));
			if (u.afterViewInit) after.push({ kind: 'run', call: call(u.afterViewInit, inner) });
			if (u.afterViewChecked) after.push(every({ kind: 'run', call: call(u.afterViewChecked, inner) }, 'view'));
			if (u.exposed) loops = inner;
		}
		return {
			loops,
			end: () => {
				later('content', ...content);
				later('after', ...after);
			},
		};
	};

	/** A view query's field set to what a node made (its view, or the component made there), and cleared when it goes. */
	const queried = (hooks: QueryHook[] | undefined, loops: readonly Loop[], view: string, instance: string) => {
		for (const q of hooks ?? []) {
			const made = q.on === 'view' ? view : instance;
			say({ kind: 'run', call: call(q.set, loops, [made]) });
			if (q.unset) say({ kind: 'cleanup', call: call(q.unset, loops, [made]) });
		}
	};

	const component = (node: Extract<TNode, { kind: 'component' }>, loops: readonly Loop[], view: string, parent: string | null, region: string | null): boolean => {
		const info = components.get(node.name);
		if (!info) throw new Error(`${c.name}: <${node.name}> is not a component`);
		const bound = new Map(node.props.map((p) => [p.name, p]));
		const given = (p: string) => bound.get(info.propAliases?.[p] ?? p);
		const setter = (p: string) => !!info.setters?.includes(p);
		const cv = `c${n++}`;
		const conversion = (p: string, a: Attr): Conversion | null => (setter(p) ? null : { component: node.name, prop: p, method: 'method' in a ? a.method : null });
		const afterConstruction = !!behaviour.inputsAfterConstruction;
		const args = info.props.flatMap((p): ComponentArg[] => {
			if (setter(p)) return [];
			const a = given(p);
			if (!a && info.optional?.includes(p)) return [];
			if (!a) throw new Error(`${c.name}: <${node.name}> needs the prop "${p}"`);
			if (afterConstruction) return [];
			if ('value' in a) return [{ prop: p, value: a.value, convert: conversion(p, a) }];
			return [{ prop: p, read: call(a.method, loops), convert: conversion(p, a), optional: !!info.optional?.includes(p) && ledger.throwingOptionalInputsLeftOut }];
		});
		const passed = info.passed ? node.props.map((a) => a.name).concat(node.events.map((e) => 'on' + e.name[0].toUpperCase() + e.name.slice(1))) : null;
		say({ kind: 'component', name: cv, type: node.name, args, passed, initThrows: !!info.initThrows });
		const write = (p: string): PropWrite => {
			const a = given(p);
			return { component: cv, prop: p, setter: setter(p), throwingSetter: !!info.throwingSetters?.includes(p), convert: a ? conversion(p, a) : null, changes: !!info.changes, inputChanged: onPush && !!info.onPush };
		};
		/** The props the parent gives, in the order it sets them: the component's, or (`inputsAfterConstruction`) the template's. */
		const givenProps = afterConstruction ? node.props.flatMap((a) => info.props.filter((p) => (info.propAliases?.[p] ?? p) === a.name)) : info.props;
		for (const p of givenProps) {
			const a = given(p);
			if (a && 'value' in a && (setter(p) || afterConstruction)) say({ kind: 'write', write: write(p), value: a.value });
			else if (a && 'value' in a && info.changes) say({ kind: 'change', component: cv, prop: p, value: a.value });
		}
		/** Where a child's bound inputs and change hook go: under `passes`, the update pass. */
		const update = passes ? binding : say;
		const props = () => {
			for (const p of givenProps) {
				const a = given(p);
				if (a && 'method' in a) update({ kind: 'bindProp', call: call(a.method, loops), write: write(p), mode: checkAll || setter(p) ? 'check' : 'effect' });
			}
		};
		/** After the props' bindings: the change hook with what they changed, before the component's own check. */
		const changed = () => {
			if (info.changes) (passes ? hook : say)({ kind: 'flushChanges', target: cv });
		};
		const output = (e: (typeof node.events)[number], object: string | null): Step => ({ kind: 'output', component: cv, field: info.outputFields?.[e.name] ?? e.name, call: call(e.method, loops, [e.payload ? 'value' : { eventData: e.name, object }]) });
		const fallThrough = () => {
			// Attributes that are not props fall through to the component's root view.
			for (const a of node.props) if (!info.props.some((p) => (info.propAliases?.[p] ?? p) === a.name)) attr(view, a, loops);
		};
		const events = () => {
			for (const e of node.events) say(info.outputs?.includes(e.name) ? output(e, view) : { kind: 'listen', view, event: e.name, call: call(e.method, loops, ['event']), when: null, ifPassed: null });
		};
		if (info.fragment) {
			// A component whose template is not one element: its views join the parent where its host is, as a ProxyViewContainer's do.
			if (!parent) throw new Error(`${c.name}: <${node.name}>, whose template has no single root element, at the root of a template`);
			for (const e of node.events) if (!info.outputs?.includes(e.name)) throw new Error(`${c.name}: <${node.name}> takes no ${e.name} event: its template has no single root view`);
			if (node.queries?.some((q) => q.on === 'view')) throw new Error(`${c.name}: a view query reading <${node.name}>'s view, whose template has no single root view`);
		}
		if (passes) {
			// Its template is made at once; in the update pass come its bound inputs, change and init hooks, its own update
			// pass once the template's bindings have run, then its after-view hook.
			const u = `u${n++}`;
			if (info.fragment) {
				for (const e of node.events) say(output(e, null));
				queried(node.queries, loops, cv, cv);
				say({ kind: 'createInto', component: cv, parent: parent!, member: members(node.name).create, update: u });
			} else {
				say({ kind: 'createView', view, component: cv, member: members(node.name).create, update: u });
				queried(node.queries, loops, view, cv);
				events();
				attach(view, parent, region, 'created');
			}
			props();
			if (!info.fragment) fallThrough();
			changed();
			const m = members(node.name);
			const child = (member: string): Step => ({ kind: 'childHook', component: cv, member });
			hook(child(m.init));
			if (info.doCheck) hook(every(child(m.doCheck), 'check'));
			if (behaviour.kit?.flushEffects) hook({ kind: 'flushEffects', component: cv, call: behaviour.kit.flushEffects });
			if (info.afterContentInit) templates.at(-1)!.content.push(child(m.afterContent));
			if (info.afterContentChecked) templates.at(-1)!.content.push(every(child(m.contentChecked), 'content'));
			templates.at(-1)!.children.push({ kind: 'updateChild', update: u });
			templates.at(-1)!.after.push(child(m.afterView));
			if (info.afterViewChecked) templates.at(-1)!.after.push(every(child(m.viewChecked), 'view'));
			return !info.fragment;
		}
		if (info.fragment) {
			props();
			for (const e of node.events) say(output(e, null));
			changed();
			queried(node.queries, loops, cv, cv);
			say({ kind: 'renderInto', component: cv, parent: parent!, member: members(node.name).render });
			return false;
		}
		props();
		changed();
		say({ kind: 'renderView', view, component: cv, member: members(node.name).render });
		queried(node.queries, loops, view, cv);
		fallThrough();
		events();
		attach(view, parent, region, 'created');
		return true;
	};

	/** Writes the nodes into the container `parent`; collects the views made at this level in `collect` when given. */
	const emit = (nodes: TNode[], outer: readonly Loop[], parent: string | null, collect: string[] | null, region: string | null = null) => {
		// A directive an element exposes is in scope for the nodes after the element.
		let scope = outer;
		for (const node of nodes) {
			const loops = scope;
			if (node.kind === 'local') {
				const l = `l${n++}`;
				say({ kind: 'local', name: l, make: call(node.make, loops) });
				const inner = [...loops, { item: node.name, itemExpr: l }];
				if (node.destroy) say({ kind: 'cleanup', call: call(node.destroy, inner) });
				emit(node.body, inner, parent, collect, region);
				continue;
			}
			if (node.kind === 'let') {
				const l = `l${n++}`;
				say({ kind: 'letSlot', name: l, read: call(node.value, loops) });
				const store: Step = { kind: 'storeLet', slot: l };
				const bindings = (deferBindings || passes) && templates.length ? templates.at(-1)!.bindings : null;
				if (bindings && node.afterHooks) bindings.push(store);
				else if (bindings) {
					let at = bindings.length;
					while (at > 0 && pending.has(bindings[at - 1])) at--;
					bindings.splice(at, 0, store);
				} else say(store);
				emit(node.body, [...loops, { item: node.name, itemExpr: l }], parent, collect, region);
				continue;
			}
			if (node.kind === 'element' || node.kind === 'component') {
				const v = `v${n++}`;
				if (node.kind === 'element' && node.tag === 'Frame' && node.attrs.some((a) => a.name === 'router')) {
					const name = node.attrs.find((a) => a.name === 'router')!;
					const outlet = kit('routerOutlet');
					const named = 'value' in name && name.value !== 'true' ? name.value : null;
					say({ kind: 'outlet', view: v, call: outlet.call, name: named, primary: named === outlet.primary });
					for (const a of node.attrs) if (a !== name) attr(v, a, scope);
					attach(v, parent, region, 'created');
				} else if (node.kind === 'element') {
					say({ kind: 'create', view: v, tag: node.tag });
					// The component's host is its template's root view.
					if (c.host && !parent && !region && !loops.length) say({ kind: 'hostAttach', host: c.host, view: v });
					if (node.ref) say({ kind: 'ref', call: call(node.ref, loops), view: v });
					queried(node.queries, loops, v, v);
					const { loops: own, end } = directed(node.directives, loops, v);
					scope = own;
					const isList = TEMPLATE_HOSTS.has(node.tag);
					const props = () => {
						for (const a of node.attrs) if (!isList || !LIST_BINDINGS.has(a.name)) attr(v, a, own);
						for (const e of node.events) listener({ kind: 'listen', view: v, event: e.name, call: call(e.method, own, ['event']), when: e.when ? call(e.when, own) : null, ifPassed: e.ifPassed ?? null });
					};
					if (isList || !postOrder) props();
					attach(v, parent, region, 'created');
					if (node.init && c.init && !passes) say({ kind: 'run', call: call(c.init, []) });
					if (isList) list(node, own, v);
					else emit(node.children, own, v, null);
					end();
					if (!isList && postOrder) props();
				} else if (!component(node, loops, v, parent, region)) continue;
				attach(v, parent, region, 'built');
				collect?.push(v);
				continue;
			}
			if (node.kind === 'template') throw new Error(`${c.name}: an item template outside a ListView or Pager`);
			if (!parent) throw new Error(`${c.name}: an if/for at the root of a template`);
			// A component whose views join its parent (no single root) is a region of the body it is in.
			const nested = (body: TNode[]) => withoutLocals(body).some((x) => x.kind === 'if' || x.kind === 'for' || (x.kind === 'component' && !!components.get(x.name)?.fragment));
			const nestedBody = node.kind === 'if' ? node.branches.some((b) => nested(b.body)) : nested(node.body);
			// A framework that inserts top-down puts a branch's views in place as it builds them; a body with regions of its own attaches as a fragment.
			const live = insertion !== 'built' && !nestedBody ? `r${n++}` : null;
			if (live && insertion === 'mounted' && templates.length) {
				say({ kind: 'region', name: live, parent, detached: true });
				templates.at(-1)!.inserts.push({ kind: 'addRegion', parent, region: live });
			} else if (live) say({ kind: 'region', name: live, parent, detached: false });
			// A branch or row with an if/for of its own (where views attach once built) returns a fragment holding the regions nested in this one.
			const fragmented = !live && nestedBody;
			let host: Host = live ? { region: live } : { parent };
			// The update pass fills a region the creation pass put in place.
			if (fragmented || (passes && !live)) {
				const r = `r${n++}`;
				say({ kind: 'region', name: r, parent, detached: false });
				host = { region: r };
			}
			/** A branch's or row's body: its views, returned (or put in place in a live region), or a fragment of them and the regions nested in it. */
			const body = (nodes: TNode[], ls: readonly Loop[], mark: boolean): Block => {
				if (fragmented) {
					const f = `f${n++}`;
					return template(block([], f), () => emit(nodes, ls, f, null), true);
				}
				const made: string[] = [];
				return template(block(made, null, mark), () => emit(nodes, ls, null, made, live), true);
			};
			if (node.kind === 'if') {
				const mark = !fragmented && viewMark(node.branches.flatMap((b) => b.body));
				(passes ? binding : say)({
					kind: 'choose',
					host,
					fragment: fragmented,
					conds: node.branches.map((b) => (b.cond ? call(b.cond, loops) : null)),
					caught: slots,
					site: site('if'),
					scope: fragmented ? null : scoped('region'),
					viewMark: mark,
					branches: node.branches.map((b) => body(b.body, loops, false)),
				});
				continue;
			}
			const inner = [...loops, { item: node.item, index: node.index }];
			const row = behaviour.rowSignals !== 'off' ? `row${n++}` : null;
			const rowLoops = row ? [...loops, { item: node.item, index: node.index, itemExpr: `${row}.item.value`, indexExpr: `${row}.index.value` }] : inner;
			const value = behaviour.rowSignals === 'value';
			const mark = !fragmented && !value && viewMark(node.body);
			(passes ? binding : say)({
				kind: 'for',
				host,
				fragment: fragmented,
				item: node.item,
				index: node.index,
				items: call(node.items, loops),
				key: node.key ? call(node.key, inner) : null,
				rows: behaviour.rowSignals,
				row,
				caught: value && ledger.valueRowReadsReported,
				site: site('for'),
				scope: fragmented || value ? null : scoped('region'),
				viewMark: mark,
				body: body(node.body, rowLoops, false),
			});
		}
	};

	/** An item-template host's items, selector and templates: one `bind`, whose closure renders a template for a row. */
	const list = (node: Extract<TNode, { kind: 'element' }>, loops: readonly Loop[], v: string) => {
		const items = node.attrs.find((a) => a.name === 'items');
		if (!items || !('method' in items)) throw new Error(`${c.name}: <${node.tag}> needs bound items`);
		const selector = node.attrs.find((a) => a.name === 'itemTemplateSelector');
		const all = node.children.filter((t): t is Extract<TNode, { kind: 'template' }> => t.kind === 'template');
		const rowTemplates = all.filter((t) => !t.header);
		const header = all.find((t) => t.header);
		const row = rowTemplates.length ? `row${n++}` : null;
		/** One template's view for a row. */
		const rendered = (t: Extract<TNode, { kind: 'template' }>): Block => {
			const made: string[] = [];
			const b = template(block(made, null, viewMark(t.body)), () => emit(t.body, [...loops, { item: t.item, index: t.index, itemExpr: `${row}.item.value`, indexExpr: `${row}.index.value` }], null, made));
			if (made.length !== 1) throw new Error(`${c.name}: a ${node.tag} template needs exactly one root element`);
			return b;
		};
		const fallback = rowTemplates.find((t) => t.key === 'default') ?? rowTemplates[0];
		(passes ? binding : say)({
			kind: 'list',
			view: v,
			tag: node.tag,
			sections: !!node.sections,
			items: call(items.method, loops),
			selector: selector && 'method' in selector ? call(selector.method, loops, ['item', 'index']) : null,
			headerXml: !ledger.listHeaderRendered && header?.xml !== undefined ? header.xml : null,
			row,
			scope: scoped('item'),
			keys: rowTemplates.map((t) => t.key),
			templates: [...rowTemplates.filter((t) => t !== fallback), ...(fallback ? [fallback] : [])].map((t) => ({ key: t.key, fallback: t === fallback, body: rendered(t) })),
			header: ledger.listHeaderRendered && header && rowTemplates.length ? rendered(header) : null,
		});
	};

	const fragment = behaviour.fragments && !c.page && isFragment(c.template, components);
	const member = (m: string, extra: Arg[] = []) => call(m, [], extra);
	/** A root's hooks in Angular's order around its update pass: init, check and content hooks, then after-view hooks. */
	const rootHooks = (): NonNullable<RenderPlan['passes']> => {
		const m = members(c.name);
		const at = (name: string, phase: Phase | null): RootHook => ({ member: name, every: phase ? kit('everyCheck')[phase] : null });
		return {
			init: c.init ? member(c.init) : null,
			doCheck: c.doCheck ? member(c.doCheck) : null,
			afterContent: c.afterContentInit ? member(c.afterContentInit) : null,
			contentChecked: c.afterContentChecked ? member(c.afterContentChecked) : null,
			afterView: c.afterViewInit ? member(c.afterViewInit) : null,
			viewChecked: c.afterViewChecked ? member(c.afterViewChecked) : null,
			before: [at(m.init, null), ...(c.doCheck ? [at(m.doCheck, 'check')] : []), ...(behaviour.kit?.flushEffects ? [{ member: '', every: null, flush: behaviour.kit.flushEffects }] : []), ...(c.afterContentInit ? [at(m.afterContent, null)] : []), ...(c.afterContentChecked ? [at(m.contentChecked, 'content')] : [])],
			after: [at(m.afterView, null), ...(c.afterViewChecked ? [at(m.viewChecked, 'view')] : [])],
		};
	};
	const plan: Omit<RenderPlan, 'root'> = {
		fragment,
		scope: scoped('template'),
		viewMark: viewMark(c.template),
		derived: (c.derived ?? []).map((x) => ({ name: x.name, call: member(x.method) })),
		destroy: c.destroy ? member(c.destroy) : null,
		init: c.init && !c.lateInit && !passes ? member(c.init) : null,
		watchers: (c.watchers ?? []).flatMap((w) => (w.source ? [{ immediate: w.immediate, source: member(w.source), handler: member(w.handler, ['value', 'old'].slice(0, w.arity)) }] : [])),
		// A user effect runs after the template effects a write invalidates.
		userEffects: (c.watchers ?? []).flatMap((w) => (w.source ? [] : [member(w.handler)])),
		// Effects run once the component's views exist, as a renderer runs them after its commit.
		effects: fragment || c.page ? [] : (c.effects ?? []).map((e) => ({ layout: e.layout, deps: e.deps ? member(e.deps) : null, run: member(e.run) })),
		// The after-view hook, once the template's views and its children's are made and their bindings applied.
		afterView: c.afterViewInit && !passes ? member(c.afterViewInit) : null,
		members: members(c.name),
		...(passes ? { passes: rootHooks() } : {}),
	};
	if (c.page) {
		// A routed component's template is its page's content: the action bar and the view.
		const content = ledger.pageContentLayout ? behaviour.pageContentAttrs : undefined;
		const body = block();
		if (content) {
			const isBar = (x: TNode) => x.kind === 'element' && x.tag === 'ActionBar';
			template(
				body,
				() => {
					emit(c.template.filter(isBar), [], 'page', null);
					say({ kind: 'create', view: 'content', tag: 'FlexboxLayout' });
					for (const [name, value] of Object.entries(content)) say({ kind: 'setAttr', view: 'content', name, value });
					emit(
						c.template.filter((x) => !isBar(x)),
						[],
						'content',
						null,
					);
				},
				true,
			);
		} else template(body, () => emit(c.template, [], 'page', null), true);
		return { ...plan, root: { kind: 'page', host: c.host ?? null, body, content: content ? 'content' : null } };
	}
	if (fragment) return { ...plan, root: { kind: 'fragment', body: template(block(), () => emit(c.template, [], 'root', null), true) } };
	const roots: string[] = [];
	const body = template(block(roots), () => emit(c.template, [], null, roots), true);
	if (roots.length !== 1) throw new Error(`${c.name}: a template needs exactly one root element`);
	return { ...plan, root: { kind: 'view', body, view: roots[0] } };
}

/** Whether a template holds an `if` or `for` of its own (not inside an item template). */
function hasRegion(nodes: TNode[]): boolean {
	return withoutLocals(nodes).some((n) => n.kind === 'if' || n.kind === 'for' || (n.kind === 'element' && !TEMPLATE_HOSTS.has(n.tag) && hasRegion(n.children)));
}
