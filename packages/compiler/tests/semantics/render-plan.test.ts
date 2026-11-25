// The template plan (src/template/plan.ts): what a component's render() does, and in which order, under a framework's
// behaviour; the same plan for both backends but where a ledger entry names the difference.
//   node --test tests/semantics/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ComponentIR, TNode } from '../../src/api/ir.ts';
import type { TemplateBehaviour } from '../../src/api/adapter-api.ts';
import { DEFAULT_BEHAVIOUR, type ComponentInfo } from '../../src/template/model.ts';
import { COMPONENT_MEMBERS, componentMembers, renderPlan, type Block, type Step } from '../../src/template/plan.ts';
import { KOTLIN_LEDGER, SWIFT_LEDGER } from '../../src/semantics/ledger.ts';

const component = (template: TNode[], extra: Partial<ComponentIR> = {}): ComponentIR => ({ name: 'Home', file: '/app/home.ts', source: '', props: [], template, ...extra });
const label = (attrs: { name: string; method: string }[], events: { name: string; method: string }[] = []): TNode => ({ kind: 'element', tag: 'Label', attrs, events, children: [] });
const stack = (children: TNode[]): TNode => ({ kind: 'element', tag: 'StackLayout', attrs: [], events: [], children });
const kinds = (b: Block) => b.steps.map((s) => s.kind);
const body = (c: ComponentIR, behaviour: TemplateBehaviour = DEFAULT_BEHAVIOUR, ledger = SWIFT_LEDGER) => {
	const plan = renderPlan(c, new Map(), behaviour, ledger);
	return plan.root.body;
};

test("a template's views, then its deferred bindings, then listeners added after bindings", () => {
	const c = component([stack([label([{ name: 'text', method: '$b0' }], [{ name: 'tap', method: '$e0' }])])]);
	assert.deepEqual(kinds(body(c)), ['create', 'create', 'bindAttr', 'listen', 'attach']);
	const deferred: TemplateBehaviour = { ...DEFAULT_BEHAVIOUR, deferBindings: true, listenersAfterBindings: true };
	assert.deepEqual(kinds(body(c, deferred)), ['create', 'create', 'attach', 'bindAttr', 'listen']);
});

test('a view joins its parent as it is created, once its subtree is built, or when its block mounts', () => {
	const c = component([stack([label([])])]);
	const attachAt = (insertion: TemplateBehaviour['insertion']) => kinds(body(c, { ...DEFAULT_BEHAVIOUR, insertion }));
	assert.deepEqual(attachAt('built'), ['create', 'create', 'attach']);
	assert.deepEqual(attachAt('created'), ['create', 'create', 'attach']);
	// Mounted: the inserts follow the template's own steps.
	const nested = component([stack([stack([label([])])])]);
	assert.deepEqual(kinds(body(nested, { ...DEFAULT_BEHAVIOUR, insertion: 'mounted' })), ['create', 'create', 'create', 'attach', 'attach']);
	assert.deepEqual(kinds(body(nested, { ...DEFAULT_BEHAVIOUR, insertion: 'built' })), ['create', 'create', 'create', 'attach', 'attach']);
	const order = (insertion: TemplateBehaviour['insertion']) => body(nested, { ...DEFAULT_BEHAVIOUR, insertion }).steps.filter((s): s is Extract<Step, { kind: 'attach' }> => s.kind === 'attach').map((s) => s.view);
	assert.deepEqual(order('built'), ['v2', 'v1']);
	assert.deepEqual(order('created'), ['v1', 'v2']);
	assert.deepEqual(order('mounted'), ['v1', 'v2']);
});

test("an if's branches each own the region it adds; a body with regions of its own is a fragment", () => {
	const branch = (inner: TNode[]): TNode => ({ kind: 'if', branches: [{ cond: '$c0', body: inner }, { cond: null, body: [label([])] }] });
	const flat = body(component([stack([branch([label([])])])]));
	const choose = flat.steps.find((s) => s.kind === 'choose')!;
	assert.equal(choose.kind === 'choose' && choose.fragment, false);
	assert.deepEqual(choose.kind === 'choose' && choose.host, { parent: 'v0' });
	const nested = body(component([stack([branch([{ kind: 'for', items: '$i0', key: null, item: 'x', index: 'i', body: [label([])] }])])]));
	const outer = nested.steps.find((s) => s.kind === 'choose')!;
	assert.equal(outer.kind === 'choose' && outer.fragment, true);
	assert.deepEqual(outer.kind === 'choose' && outer.branches.map((b) => b.fragment), ['f2', 'f4']);
});

test('the two backends get one plan but where a template ledger entry names the difference', () => {
	const list: TNode = {
		kind: 'element',
		tag: 'ListView',
		sections: true,
		attrs: [{ name: 'items', method: '$items' }],
		events: [],
		children: [
			{ kind: 'template', key: 'default', item: 'x', index: 'i', body: [label([{ name: 'text', method: '$t' }])] },
			{ kind: 'template', key: 'header', item: 's', index: 'j', header: true, xml: '<Label text="{{ title }}"/>', body: [label([])] },
		],
	};
	const c = component([stack([{ kind: 'if', branches: [{ cond: '$c', body: [label([])] }] }, { kind: 'for', items: '$xs', key: '$k', item: 'x', index: 'i', body: [label([])] }, { kind: 'component', name: 'Child', props: [{ name: 'size', method: '$s' }, { name: 'tone', method: '$t' }], events: [] }, list])]);
	const infos = new Map<string, ComponentInfo>([['Child', { props: ['size', 'tone'], optional: ['tone'] }]]);
	const swift = renderPlan(c, infos, DEFAULT_BEHAVIOUR, SWIFT_LEDGER);
	const kotlin = renderPlan(c, infos, DEFAULT_BEHAVIOUR, KOTLIN_LEDGER);
	// What the ledger keys: whether an optional input whose read throws is left out, and whether a sectioned list's
	// header is rendered or handed over as XML (the list is last: a rendered header names views, which moves the names
	// of the views after it).
	const unkeyed = (x: unknown): unknown =>
		JSON.parse(JSON.stringify(x, (k, v) => (k === 'optional' || k === 'header' || k === 'headerXml' ? undefined : v)));
	assert.deepEqual(unkeyed(kotlin), unkeyed(swift));
	const argsOf = (p: typeof swift) => (p.root.body.steps.find((s) => s.kind === 'component') as Extract<Step, { kind: 'component' }>).args.map((a) => 'optional' in a && a.optional);
	assert.deepEqual(argsOf(swift), [false, true]);
	assert.deepEqual(argsOf(kotlin), [false, false]);
	const listOf = (p: typeof swift) => p.root.body.steps.find((s) => s.kind === 'list') as Extract<Step, { kind: 'list' }>;
	assert.equal(listOf(swift).headerXml, null);
	assert.ok(listOf(swift).header);
	assert.equal(listOf(kotlin).headerXml, '<Label text="{{ title }}"/>');
	assert.equal(listOf(kotlin).header, null);
});

test("in two passes, a view makes its children and their templates, then in template order applies its bindings and regions, then updates the branches they made, then the children's updates and after-view hooks", () => {
	const kid = (name: string, props: Extract<TNode, { kind: 'component' }>['props']): TNode => ({ kind: 'component', name, props, events: [] });
	const c = component([stack([kid('K1', [{ name: 'a', method: '$a' }, { name: 'b', value: 'lit' }]), { kind: 'if', branches: [{ cond: '$c', body: [label([])] }] }, kid('K2', [{ name: 'a', method: '$a2' }])])], { init: 'onInit', afterViewInit: 'afterView' });
	const infos = new Map<string, ComponentInfo>([['K1', { props: ['a', 'b'], changes: true }], ['K2', { props: ['a'] }]]);
	const passes: TemplateBehaviour = { ...DEFAULT_BEHAVIOUR, deferBindings: true, insertion: 'created', inputsAfterConstruction: true, passes: true };
	const plan = renderPlan(c, infos, passes, SWIFT_LEDGER);
	assert.deepEqual(kinds(plan.root.body), ['create', 'component', 'write', 'createView', 'attach', 'region', 'component', 'createView', 'attach']);
	const update = plan.root.body.update ?? [];
	assert.deepEqual(update.map((s) => s.kind), ['embeddedViews', 'updateChild', 'updateChild', 'childHook', 'childHook']);
	const bindings = update[0].kind === 'embeddedViews' ? update[0].steps : [];
	assert.deepEqual(bindings.map((s) => s.kind), ['bindProp', 'flushChanges', 'childHook', 'choose', 'bindProp', 'childHook']);
	// A branch is made at its place; its update pass is held until the view's bindings have run.
	const branch = bindings.find((s): s is Extract<Step, { kind: 'choose' }> => s.kind === 'choose')!.branches[0];
	assert.deepEqual(kinds(branch), ['create', 'attach']);
	assert.deepEqual(branch.update, []);
	assert.equal(plan.init, null);
	assert.equal(plan.afterView, null);
	assert.deepEqual(plan.passes, { init: { method: 'onInit', loops: [], extra: [] }, doCheck: null, afterContent: null, contentChecked: null, afterView: { method: 'afterView', loops: [], extra: [] }, viewChecked: null, before: [{ member: '__init', every: null }], after: [{ member: '__afterView', every: null }] });
	assert.deepEqual(plan.members, COMPONENT_MEMBERS);
	const plain = renderPlan(c, infos, { ...passes, passes: false }, SWIFT_LEDGER);
	assert.equal(plain.root.body.update, undefined);
	assert.equal(plain.passes, undefined);
});

test("the members a parent, the entry and navigation call are renamed clear of the component's own members, as both backends spell them", () => {
	assert.deepEqual(componentMembers(['__create', '$_init', '__init_', 'render', 'render_', '__doCheck', '__viewChecked']), { ...COMPONENT_MEMBERS, render: 'render__', create: '__create_', init: '__init__', doCheck: '__doCheck_', viewChecked: '__viewChecked_' });
	const c = component([stack([{ kind: 'component', name: 'K1', props: [], events: [] }])], { name: 'Host' });
	const own = componentMembers(['__afterView', 'render']);
	const kid = componentMembers(['__create', '__init', 'render']);
	const infos = new Map<string, ComponentInfo>([['Host', { props: [], members: own }], ['K1', { props: [], members: kid }]]);
	const plan = renderPlan(c, infos, { ...DEFAULT_BEHAVIOUR, deferBindings: true, insertion: 'created', inputsAfterConstruction: true, passes: true }, SWIFT_LEDGER);
	assert.deepEqual(plan.members, { ...COMPONENT_MEMBERS, render: 'render_', afterView: '__afterView_' });
	const steps = [...plan.root.body.steps, ...(plan.root.body.update ?? [])];
	assert.deepEqual(steps.flatMap((s) => (s.kind === 'createView' || s.kind === 'childHook' ? [s.member] : [])), ['__create_', '__init_', '__afterView']);
	const single = renderPlan(c, infos, DEFAULT_BEHAVIOUR, SWIFT_LEDGER);
	assert.deepEqual(single.root.body.steps.flatMap((s) => (s.kind === 'renderView' ? [s.member] : [])), ['render_']);
});

test("in two passes, a check hook runs after its init hook; a branch's update holds its children's hooks and updates; a list's items are bound in the update pass", () => {
	const kid = (name: string): TNode => ({ kind: 'component', name, props: [{ name: 'a', method: '$a' }], events: [] });
	const list: TNode = { kind: 'element', tag: 'ListView', attrs: [{ name: 'items', method: '$items' }], events: [], children: [{ kind: 'template', key: 'default', item: 'r', index: 'i', body: [stack([{ kind: 'if', branches: [{ cond: '$on', body: [label([])] }] }])] }] };
	const c = component([stack([kid('K1'), { kind: 'if', branches: [{ cond: '$c', body: [kid('K1')] }] }, list])], { doCheck: 'check' });
	const infos = new Map<string, ComponentInfo>([['K1', { props: ['a'], doCheck: true }]]);
	const plan = renderPlan(c, infos, { ...DEFAULT_BEHAVIOUR, deferBindings: true, insertion: 'created', inputsAfterConstruction: true, passes: true, kit: { everyCheck: { check: 'E', content: 'C', view: 'V' } } }, SWIFT_LEDGER);
	assert.deepEqual(plan.passes?.doCheck, { method: 'check', loops: [], extra: [] });
	assert.ok(!kinds(plan.root.body).includes('list'));
	const update = plan.root.body.update ?? [];
	const bindings = update[0].kind === 'embeddedViews' ? update[0].steps : [];
	assert.deepEqual(bindings.map((s) => s.kind), ['bindProp', 'childHook', 'everyCheck', 'choose', 'list']);
	const branch = bindings.find((s): s is Extract<Step, { kind: 'choose' }> => s.kind === 'choose')!.branches[0];
	assert.deepEqual(kinds(branch), ['component', 'createView', 'attach']);
	assert.deepEqual(branch.update?.map((s) => s.kind), ['bindProp', 'childHook', 'everyCheck', 'updateChild', 'childHook']);
	// An item template's body is one pass, its own branches updated after its bindings.
	const row = bindings.find((s): s is Extract<Step, { kind: 'list' }> => s.kind === 'list')!.templates[0].body;
	assert.deepEqual(kinds(row), ['create', 'region', 'embeddedViews']);
});

test("in two passes, a let is read into its slot at its place, before the hooks of the nodes since the last one bound; its body's methods take the slot", () => {
	const kid = (name: string, method: string): TNode => ({ kind: 'component', name, props: [{ name: 'a', method }], events: [] });
	const read = label([{ name: 'text', method: '$x' }]);
	const c = component([stack([kid('K1', '$a'), { kind: 'let', name: '$l0', value: '$v', body: [kid('K2', '$b'), { kind: 'let', name: '$l1', value: '$w', body: [read] }] }])]);
	const infos = new Map<string, ComponentInfo>([['K1', { props: ['a'], changes: true, doCheck: true }], ['K2', { props: ['a'] }]]);
	const plan = renderPlan(c, infos, { ...DEFAULT_BEHAVIOUR, deferBindings: true, insertion: 'created', inputsAfterConstruction: true, passes: true, kit: { everyCheck: { check: 'E', content: 'C', view: 'V' } } }, SWIFT_LEDGER);
	const steps = plan.root.body.steps;
	const slots = steps.filter((s): s is Extract<Step, { kind: 'letSlot' }> => s.kind === 'letSlot');
	assert.deepEqual(slots.map((s) => [s.read.method, s.read.loops.map((l) => l.itemExpr)]), [['$v', []], ['$w', [slots[0].name]]]);
	const update = plan.root.body.update ?? [];
	assert.deepEqual(update.map((s) => (s.kind === 'storeLet' ? `store ${s.slot}` : s.kind)), ['bindProp', `store ${slots[0].name}`, 'flushChanges', 'childHook', 'everyCheck', 'bindProp', `store ${slots[1].name}`, 'childHook', 'bindAttr', 'updateChild', 'updateChild', 'childHook', 'childHook']);
	const text = update.find((s): s is Extract<Step, { kind: 'bindAttr' }> => s.kind === 'bindAttr')!;
	assert.deepEqual(text.call.loops, [{ item: '$l0', itemExpr: slots[0].name }, { item: '$l1', itemExpr: slots[1].name }]);
	const reached = component([stack([kid('K1', '$a'), { kind: 'let', name: '$l0', value: '$v', afterHooks: true, body: [read] }])]);
	const after = renderPlan(reached, infos, { ...DEFAULT_BEHAVIOUR, deferBindings: true, insertion: 'created', inputsAfterConstruction: true, passes: true, kit: { everyCheck: { check: 'E', content: 'C', view: 'V' } } }, SWIFT_LEDGER).root.body.update ?? [];
	assert.deepEqual(after.map((s) => s.kind), ['bindProp', 'flushChanges', 'childHook', 'everyCheck', 'storeLet', 'bindAttr', 'updateChild', 'childHook']);
});

test("in two passes, content hooks follow the embedded views and precede the children's updates, after-view-checked hooks follow the after-view hooks, both in the order their elements end", () => {
	const kid = (name: string): TNode => ({ kind: 'component', name, props: [], events: [] });
	const dir = (name: string): NonNullable<Extract<TNode, { kind: 'element' }>['directives']>[number] => ({ name, make: `$${name}`, inputs: [], listeners: [], bindings: [], attributes: [], afterContentInit: `$${name}ci`, afterContentChecked: `$${name}cc`, afterViewInit: `$${name}vi`, afterViewChecked: `$${name}vc` });
	const wrapped: TNode = { kind: 'element', tag: 'StackLayout', attrs: [], events: [], children: [kid('K1')], directives: [dir('D1')] };
	const c = component([stack([wrapped, { kind: 'if', branches: [{ cond: '$c', body: [kid('K2')] }] }, kid('K2')])], { afterContentInit: 'aci', afterContentChecked: 'acc', afterViewChecked: 'avc' });
	const all = { afterContentInit: true, afterContentChecked: true, afterViewChecked: true };
	const infos = new Map<string, ComponentInfo>([['K1', { props: [], ...all }], ['K2', { props: [], afterContentChecked: true }]]);
	const plan = renderPlan(c, infos, { ...DEFAULT_BEHAVIOUR, deferBindings: true, insertion: 'created', inputsAfterConstruction: true, passes: true, kit: { everyCheck: { check: 'E', content: 'C', view: 'V' } } }, SWIFT_LEDGER);
	const named = (s: Step): string => (s.kind === 'childHook' ? `${s.component}.${s.member}` : s.kind === 'run' ? s.call.method : s.kind === 'everyCheck' ? `${s.phase}(${named(s.hook)})` : s.kind);
	const update = plan.root.body.update ?? [];
	const [k1, k2] = plan.root.body.steps.filter((s) => s.kind === 'component').map((s) => (s.kind === 'component' ? s.name : ''));
	assert.deepEqual(update.slice(1).map(named), [
		`${k1}.__afterContent`, `content(${k1}.__contentChecked)`, '$D1ci', 'content($D1cc)', `content(${k2}.__contentChecked)`,
		'updateChild', 'updateChild', `${k1}.__afterView`, `view(${k1}.__viewChecked)`, '$D1vi', 'view($D1vc)', `${k2}.__afterView`,
	]);
	const branch = (update[0].kind === 'embeddedViews' ? update[0].steps : []).find((s): s is Extract<Step, { kind: 'choose' }> => s.kind === 'choose')!.branches[0];
	const k = branch.steps.find((s) => s.kind === 'component')!;
	const kn = k.kind === 'component' ? k.name : '';
	assert.deepEqual(branch.update?.map(named), [`${kn}.__init`, `content(${kn}.__contentChecked)`, 'updateChild', `${kn}.__afterView`]);
	assert.deepEqual(plan.passes && [plan.passes.afterContent?.method, plan.passes.contentChecked?.method, plan.passes.viewChecked?.method], ['aci', 'acc', 'avc']);
	assert.deepEqual(plan.passes && [...plan.passes.before, ...plan.passes.after].map((h) => `${h.member} ${h.every}`), ['__init null', '__afterContent null', '__contentChecked C', '__afterView null', '__viewChecked V']);
});
