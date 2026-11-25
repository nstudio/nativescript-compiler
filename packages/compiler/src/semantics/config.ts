// What a translator is given when it is made, and nothing it is given later: the build it is part of, the program's
// mode and inputs, and where its output goes. Each backend's config adds what only it reads. A translator holds its
// config and its emission state; what the whole program answers is ProgramFacts' (facts.ts).
import type { ActiveAdapter } from '../adapters/active.ts';
import type { TranslatorHooks, TranslatorView } from '../api/adapter-api.ts';
import { BuildContext } from '../program/build-context.ts';
import type { Properties } from '../program/properties.ts';
import type { Reach } from '../program/reach.ts';
import type { SourceLines } from '../program/source-lines.ts';
import type { Ledger } from './ledger.ts';
import { tracedLedger } from './decision-trace.ts';
import type { RefusalLog } from './refusals.ts';
import type { XmlMemberKeys } from './states/value-states.ts';

export interface TranslatorConfig<V extends TranslatorView = TranslatorView, L = unknown> {
	/** The build's framework adapter (`BuildContext.adapter`): its kit, its runtime's sources, the classes it reads by name. */
	readonly adapter?: ActiveAdapter;
	/** Where the build's refusals are made and logged (`BuildContext.refusals`). */
	readonly refusals?: RefusalLog;
	/** A source of one of the build's plugin bindings (`BuildContext.isBindingSource`): packaged code. */
	readonly isBindingSource?: (file: string) => boolean;
	/** The framework adapter's translator hooks. */
	readonly hooks?: TranslatorHooks<V>;
	/** The backend's differences from the other (ledger.ts); its own unless an experiment gives another. */
	readonly ledger?: Ledger;
	/** Library mode (the kit generated from core) and what it leaves out or replaces; absent for an app. */
	readonly library?: L | null;
	/** Files of the plugins compiled from source. */
	readonly pluginFiles?: Iterable<string>;
	/** Files of plugins written without strictNullChecks, translated as core is. */
	readonly lenientFiles?: Iterable<string>;
	/** Where plugins' sources are: a file under one is a plugin's however it is compiled. */
	readonly pluginRoots?: Iterable<string>;
	/** What of the plugins the app reaches; everything when absent. */
	readonly reach?: Reach;
	/** The view properties the program registers with core's `Property`. */
	readonly properties?: Properties;
	/** Code checked without strictNullChecks, as core is. */
	readonly lenient?: boolean;
	/** The app's own configuration is not strict. */
	readonly lenientApp?: boolean;
	/** The app's configuration assigns class fields in the constructor rather than defining them (`useDefineForClassFields` off). */
	readonly assignFields?: boolean;
	/** An app whose XML is all built at build time: the keys its classes' members are read by. */
	readonly xmlMemberKeys?: XmlMemberKeys | null;
	/** The app's module (Swift) or package (Kotlin), which qualifies a module function a class member's name shadows. */
	readonly appModule?: string;
	/** The app's objects are read by name at run time (an XML app's bindings, through core's Builder). */
	readonly appMembersByName?: boolean;
	/** Component fields without an initializer are state, not props: the framework declares props otherwise. */
	readonly plainFields?: boolean;
	/** `--allow-unimplemented-properties`: a core property the kit does not apply is set by name, with a warning. */
	readonly allowUnapplied?: boolean;
	/** Marks each statement with its source line (`#sourceLocation` in Swift, a line table for Kotlin). */
	readonly lines?: SourceLines | null;
	/** With `--all-errors`: where what each statement could not translate is collected, so one run reports them all. */
	readonly errors?: string[] | null;
}

/** What both translators hold of their config, its defaults filled in (`configFields`). */
export interface ConfigFields<L> {
	/** The backend's differences from the other (ledger.ts). */
	readonly ledger: Ledger;
	/**
	 * Library mode (the kit generated from core): what of core's modules the kit leaves out or replaces; each module's
	 * functions and variables are members of an object named for the module. Null for an app.
	 */
	readonly library: L | null;
	/** Files of the plugins compiled from source. */
	readonly pluginFiles: Set<string>;
	/** Files of plugins written without strictNullChecks, translated as core is. */
	readonly lenientFiles: ReadonlySet<string>;
	/** Where plugins' sources are: a file under one is a plugin's however it is compiled (its components as the app's). */
	readonly pluginRoots: readonly string[];
	/** What of the plugins the app reaches; everything when absent. */
	readonly reach: Reach | null;
	/** The view properties the program registers with core's `Property`. */
	readonly properties: Properties | null;
	/** The app's configuration is not strict: a variable declared without a value may be read before one is assigned. */
	readonly lenientApp: boolean;
	/** The app's configuration assigns class fields in the constructor rather than defining them (`useDefineForClassFields` off). */
	readonly assignFields: boolean;
	/** An app whose XML is all built at build time: the keys its classes' members are read by (`ValueStates.byNameMember`). */
	readonly xmlMemberKeys: XmlMemberKeys | null;
	/** The app's module (Swift) or package (Kotlin), which qualifies a module function a class member's name shadows. */
	readonly appModule: string;
	/**
	 * The app's objects are read by name at run time (an XML app's bindings and `{{ onTap }}` handlers, through core's
	 * Builder): its classes' accessors and methods by name, as a library's are.
	 */
	readonly appMembersByName: boolean;
	/** Component fields without an initializer are state, not props: the framework declares props otherwise. */
	readonly plainFields: boolean;
	/** `--allow-unimplemented-properties`: a core property the kit does not apply is set by name, with a warning. */
	readonly allowUnapplied: boolean;
	/** Marks each statement with its source line (`#sourceLocation` in Swift, a line table for Kotlin). */
	readonly lines: SourceLines | null;
	/** With `--all-errors`: what each statement could not translate, collected so one run reports them all. */
	readonly errors: string[] | null;
}

/** The fields both translators hold of `config`; `ledger` where the config gives none. */
export function configFields<L>(config: TranslatorConfig<never, L>, ledger: Ledger): ConfigFields<L> {
	return {
		ledger: tracedLedger(config.ledger ?? ledger),
		library: config.library ?? null,
		pluginFiles: new Set(config.pluginFiles ?? []),
		lenientFiles: new Set(config.lenientFiles ?? []),
		pluginRoots: [...(config.pluginRoots ?? [])],
		reach: config.reach ?? null,
		properties: config.properties ?? null,
		lenientApp: config.lenientApp ?? false,
		assignFields: config.assignFields ?? false,
		xmlMemberKeys: config.xmlMemberKeys ?? null,
		appModule: config.appModule ?? '',
		appMembersByName: config.appMembersByName ?? false,
		plainFields: config.plainFields ?? false,
		allowUnapplied: config.allowUnapplied ?? false,
		lines: config.lines ?? null,
		errors: config.errors ?? null,
	};
}

/** What a translator reads of its build, from a config that may leave it out: a build of its own, with no framework. */
export function buildOf<C extends TranslatorConfig<never>>(config: C): C & Required<Pick<TranslatorConfig, 'adapter' | 'refusals' | 'isBindingSource'>> {
	if (config.adapter && config.refusals && config.isBindingSource) return config as C & Required<Pick<TranslatorConfig, 'adapter' | 'refusals' | 'isBindingSource'>>;
	return { ...new BuildContext().translation(), ...config } as C & Required<Pick<TranslatorConfig, 'adapter' | 'refusals' | 'isBindingSource'>>;
}
