// What every framework front end produces, and the back ends consume.
//
// A component is a virtual TypeScript class (its state as `$signal(...)`
// fields, derived values as getters, handlers as methods, and one method per
// template expression) plus a template tree that names those methods. The
// TypeScript checker types the class, so the back end translates typed code
// no matter which framework the source was written in.

export type Attr = (
	| { name: string; value: string }
	/** A binding: the method that computes the value, called with the loop variables in scope. */
	| { name: string; method: string }
) & {
	/** A prop of the component's own that a spread passes on only when the parent gave it (`{...rest}`). */
	ifPassed?: string;
};

export interface Event {
	name: string;
	/** Called with the loop variables in scope, then the event. */
	method: string;
	ifPassed?: string;
	/** A method deciding, when the view is made, whether to listen at all (`onX={cond ? fn : undefined}`). */
	when?: string;
	/** The handler takes the emitted value itself (a component output's), not event data. */
	payload?: boolean;
}

/**
 * A view query's hooks on the node it matches: `set` and `unset` called, after the names in scope, with the
 * node's view (`view`) or the component made there (`instance`), when the view is made and when it goes.
 */
export interface QueryHook {
	set: string;
	unset?: string;
	on: 'view' | 'instance';
	/** A content query targeting the enclosing projected component instance (`$host` passed as first argument). */
	contentHost?: boolean;
}

/**
 * A directive on an element, one per view of it. Its methods take the names in scope, then the directive
 * (`name`): `make` gives it, made with the element as its host; each input's `set` takes the value too, from its
 * binding's `method` or the attribute's `value`; `listeners` take the event; `bindings` give a host property's value.
 */
export interface DirectiveUse {
	name: string;
	make: string;
	inputs: ({ set: string; method: string } | { set: string; value: string })[];
	listeners: { event: string; method: string }[];
	bindings: { prop: string; method: string }[];
	/** Host attributes it sets (`host: { role: 'x' }`). */
	attributes: { name: string; value: string }[];
	init?: string;
	/** A hook run after `init` and again on every check of the element's view (`TemplateKit.everyCheck.check`). */
	doCheck?: string;
	destroy?: string;
	/** Run once its view's embedded views are first updated, before its child components are. */
	afterContentInit?: string;
	/** Run after `afterContentInit`, and again at that point of every check of its view (`TemplateKit.everyCheck.content`). */
	afterContentChecked?: string;
	afterViewInit?: string;
	/** Run after `afterViewInit`, and again at that point of every check of its view (`TemplateKit.everyCheck.view`). */
	afterViewChecked?: string;
	/** It has a change hook: its inputs record their changes, flushed by one check after them. */
	changes?: boolean;
	/** Its outputs (`ngModelChange`): the handler each event of the directive's emitter of that name runs, as a listener. */
	outputs?: { name: string; method: string }[];
	/**
	 * The template's code after it reads it by its name (a template reference, a forms directive below it): the
	 * directives made after it on the element, the element's bindings and events, its children and the nodes after it.
	 */
	exposed?: boolean;
	/** Queries matched against this directive instance (e.g. `contentChild(SomeDirective)`). */
	queries?: QueryHook[];
}

export type TNode =
	| {
			kind: 'element';
			tag: string;
			attrs: Attr[];
			events: Event[];
			children: TNode[];
			/** A method returning the ref object (`useRef`) the view is stored in, as `ref={…}` does. */
			ref?: string;
			queries?: QueryHook[];
			/** The component's `init` runs once this view is made (a static query resolves before the init hook). */
			init?: boolean;
			directives?: DirectiveUse[];
			/** A ListView whose items are sections (`sectioned`), each holding its rows in `items`. */
			sections?: boolean;
	  }
	| { kind: 'component'; name: string; props: Attr[]; events: Event[]; queries?: QueryHook[]; slots?: Record<string, TNode[]> }
	/** A content projection slot (`<ng-content>`): `name` is `'default'` or the `select` selector; `fallback` renders when the parent gives no content. */
	| { kind: 'slot'; name: string; fallback?: TNode[] }
	| { kind: 'if'; branches: { cond: string | null; body: TNode[] }[] }
	/**
	 * A value of the view the body is in, made when the view is (a pipe): `make` is called with the names in
	 * scope, the body's methods take the value as `name` after them, and `destroy`, with the value too, runs when the
	 * view goes.
	 */
	| { kind: 'local'; name: string; make: string; destroy?: string; body: TNode[] }
	/**
	 * A template's own variable (Angular's `@let`): `value`, called with the names in scope, is read once on each check
	 * of the view, at the variable's place in its update pass, into a slot (`TemplateKit.letSlot`) the view makes; the
	 * body's methods take that slot as `name` after the names in scope. Its read precedes the change, init and check
	 * hooks of the nodes since the last node bound, unless `afterHooks` (the framework reaches it as a bound node).
	 */
	| { kind: 'let'; name: string; value: string; afterHooks?: boolean; body: TNode[] }
	/** `items` and `key` are methods; `vars` are the item and index names the body sees. */
	| { kind: 'for'; items: string; key: string | null; item: string; index: string; body: TNode[] }
	/**
	 * A ListView item template, a child of its ListView element; `key` is what `itemTemplateSelector` returns
	 * for it. The ListView's `items` attribute is a method; its `itemTemplateSelector` attribute is a method
	 * called with the loop variables in scope, then a row's item and index.
	 */
	| {
			kind: 'template';
			key: string;
			item: string;
			index: string;
			body: TNode[];
			/** A sectioned ListView's sticky header: its item is the section, its index the section's. */
			header?: boolean;
			/** The header's NativeScript XML as written, for a kit whose ListView parses it as core does (`Builder.parse`). */
			xml?: string;
	  };

export interface ComponentIR {
	name: string;
	/** Virtual TypeScript file path, next to the source so its imports resolve. */
	file: string;
	source: string;
	props: string[];
	/** Events the component raises itself, as opposed to its root view's. */
	outputs?: string[];
	/** A routed component whose template is a page's content (an ActionBar plus a view). */
	page?: boolean;
	template: TNode[];
	/** Props a parent may leave out. */
	optional?: string[];
	/** Props set through the component's `$set_<prop>` method (an input's setter) when the binding changes, not passed to its constructor. */
	setters?: string[];
	/** Props the parent names otherwise (an aliased input), by prop. */
	propAliases?: Record<string, string>;
	/** Whether the component takes the names of the props its parent gave (`$passed`), for a spread of its rest props. */
	passed?: boolean;
	/** Derived state: the state `name`, which `method` recomputes before the bindings update. */
	derived?: { name: string; method: string }[];
	/** `useEffect`/`useLayoutEffect`: the method that runs it (returning its cleanup) and the one returning its dependencies. */
	effects?: { run: string; deps: string | null; layout: boolean }[];
	/** The fields that raise `outputs`, where they are not named as the events. */
	outputFields?: Record<string, string>;
	/** Watchers and user effects, in declaration order. */
	watchers?: Watcher[];
	/** The init hook: a method run once the props are set, before the template. */
	init?: string;
	/** `init` runs where the template's element marked `init` is made, not before the template. */
	lateInit?: boolean;
	/** Under `TemplateBehaviour.passes`, a hook run after `init` and again on every check of its parent's view (`TemplateKit.everyCheck.check`). */
	doCheck?: string;
	/**
	 * Under `passes`, the content hooks: run once its parent's view has updated its embedded views, before that view's
	 * child components are updated; the checked one again at that point of every check (`TemplateKit.everyCheck.content`).
	 */
	afterContentInit?: string;
	afterContentChecked?: string;
	/** The after-view hook: run once the template is made and its bindings applied. */
	afterViewInit?: string;
	/** Under `passes`, run after `afterViewInit`, and again at that point of every check of its parent's view (`TemplateKit.everyCheck.view`). */
	afterViewChecked?: string;
	/** The destroy hook: run when the component's scope ends. */
	destroy?: string;
	/** A field holding the reference to the component's own host, given the template's root view once it is made. */
	host?: string;
	/** A field holding the component's own injector (its providers), which its view injects from. */
	injector?: string;
	/** A change hook: the parent records each input it sets with `$change(name, value)`, then calls `$flushChanges()` once its `$changed` signal moves. */
	changes?: boolean;
	/** Under `check+onPush`, a check refreshes the component's view only once it is marked dirty. */
	onPush?: boolean;
	/** The component's own stylesheets, scoped by its framework, which the app's build adds after app.css. */
	styles?: ComponentStyle[];
	/** Content projection slot names declared in this component's template (`'default'` or `select` selectors). */
	slots?: string[];
	/** Lines of the virtual file (0-based) its template's bindings were made from, with their line (1-based) in `file`, the template's own. */
	templateLines?: { file: string; lines: [number, number][] };
}

/** A component's stylesheet as plain CSS for the app's CSS chain, under a path of its own that names its component. */
export interface ComponentStyle {
	file: string;
	css: string;
}

/** The template with `attribute` on each of its own elements (not a child component's), which its scoped styles select. */
export function scopeTemplate(nodes: TNode[], attribute: string): TNode[] {
	return nodes.map((n): TNode => {
		switch (n.kind) {
			case 'element':
				return { ...n, attrs: [...n.attrs, { name: attribute, value: '' }], children: scopeTemplate(n.children, attribute) };
			case 'if':
				return { ...n, branches: n.branches.map((b) => ({ ...b, body: scopeTemplate(b.body, attribute) })) };
			case 'for':
			case 'template':
			case 'local':
			case 'let':
				return { ...n, body: scopeTemplate(n.body, attribute) };
			case 'component':
				return n.slots ? { ...n, slots: Object.fromEntries(Object.entries(n.slots).map(([k, v]) => [k, scopeTemplate(v, attribute)])) } : n;
			case 'slot':
				return n.fallback ? { ...n, fallback: scopeTemplate(n.fallback, attribute) } : n;
			default:
				return n;
		}
	});
}

/** The nodes with each `local` and `let` replaced by its body: what renders where the local is. */
export function withoutLocals(nodes: TNode[]): TNode[] {
	return nodes.flatMap((n) => (n.kind === 'local' || n.kind === 'let' ? withoutLocals(n.body) : [n]));
}

export interface Watcher {
	/** The method returning the watched value, or null for an effect that tracks what it reads. */
	source: string | null;
	/** The method run, given the new value and then the old one when it takes them. */
	handler: string;
	arity: number;
	immediate: boolean;
}
