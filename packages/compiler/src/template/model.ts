// What both backends' template renderers share: a template's default behaviour, the adapter kit's names, the hosts
// whose children are item templates, and what a component tells the components that use it.
import { withoutLocals, type TNode } from '../api/ir.ts';
import type { ComponentMembers, TemplateBehaviour, TemplateKit } from '../api/adapter-api.ts';

/** How a template renders when its caller gives no framework's behaviour: views attach once built, handlers run in `Reactivity.event`. */
export const DEFAULT_BEHAVIOUR: TemplateBehaviour = {
	schedule: 'event',
	eventScope: 'event',
	propsOrder: 'pre',
	deferBindings: false,
	insertion: 'built',
	listenersAfterBindings: false,
	effectScope: null,
	checkEveryBinding: 'off',
	slots: false,
	rowSignals: 'off',
	fragments: false,
};

/** The adapter kit's name for something a template does that the core kit does not (`TemplateBehaviour.kit`). */
export function kitName<K extends keyof TemplateKit>(behaviour: TemplateBehaviour, key: K): NonNullable<TemplateKit[K]> {
	const name = behaviour.kit?.[key];
	if (name === undefined) throw new Error(`a template needs the kit's ${key}, which the framework's adapter does not name (TemplateBehaviour.kit)`);
	return name;
}

/** Views whose children are item templates, rendered through one `bind`: core's ListView and the kit's Pager. */
export const TEMPLATE_HOSTS = new Set(['ListView', 'Pager']);

/** Item-template host attributes that `bind` takes rather than `set`. */
export const LIST_BINDINGS = new Set(['items', 'itemTemplateSelector']);

/** What a template needs of a component it creates. */
export interface ComponentInfo {
	props: string[];
	outputs?: string[];
	outputFields?: Record<string, string>;
	optional?: string[];
	passed?: boolean;
	fragment?: boolean;
	initThrows?: boolean;
	/** Props set through the component's `$set_<prop>` method (`ComponentIR.setters`), and those whose method throws. */
	setters?: string[];
	throwingSetters?: string[];
	propAliases?: Record<string, string>;
	/** The component has a change hook (`ComponentIR.changes`). */
	changes?: boolean;
	/** The component has a check hook (`ComponentIR.doCheck`). */
	doCheck?: boolean;
	/** The component's content and after-view-checked hooks it has (`ComponentIR`). */
	afterContentInit?: boolean;
	afterContentChecked?: boolean;
	afterViewChecked?: boolean;
	/** Checked only once marked dirty (`ComponentIR.onPush`): under `check+onPush`, an input it is given a new value marks its view dirty. */
	onPush?: boolean;
	/** Content projection slot names declared by this component (`ComponentIR.slots`). */
	slots?: string[];
	/** The names of its generated members (`componentMembersOf`); `COMPONENT_MEMBERS` where none are given. */
	members?: ComponentMembers;
}

/** A template that is not a single element: its views join the parent of the component's host. */
export function isFragment(nodes: TNode[], components?: ReadonlyMap<string, { fragment?: boolean }>): boolean {
	const shown = withoutLocals(nodes);
	if (shown.length !== 1) return true;
	// A template that is one component is a fragment when that component's template is.
	if (shown[0].kind === 'component') return !!components?.get(shown[0].name)?.fragment;
	return shown[0].kind !== 'element';
}
