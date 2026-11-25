/**
 * The kit's XML-free overlay: core's Builder and Binding modules generated a second time without the XML run time
 * (the parser, the expression evaluator). An app whose XML the plan builds entirely at build time (the plan
 * finds no site that needs the run time) compiles these two in place of the shared kit's, so the link can leave the
 * run time out; every other app builds with the shared kit as it is.
 */
import * as ts from 'typescript';

/** The overlay's folder beside each kit's generated sources, and its description file there. */
export const XML_FREE_OVERLAY = 'xml-free';
export const OVERLAY_FILE = 'overlay.json';

/** What the overlay's description lists (overlay.json). */
export interface KitOverlay {
	/** The shared kit's files the overlay's files replace (Swift: relative to the kit's sources; Kotlin: file names). */
	replaces: string[];
	/** Swift: the replaced files' module graph entries, as the manifest's graph has them. */
	graph?: Record<string, { init?: string; imports: string[] }>;
	/** Kotlin: the classes only the XML run time uses, which an app built with the overlay does not keep (R8). */
	unkept?: string[];
}

/** The two core files the overlay replaces. */
export const XML_FREE_FILES = ['ui/builder/index.ts', 'ui/core/bindable/index.ts'];

/** Core modules the replaced files no longer import. */
export const XML_FREE_DROPPED_IMPORTS: Record<string, string[]> = {
	'ui/builder/index.ts': ['xml/index.ts'],
	'ui/core/bindable/index.ts': ['ui/core/bindable/bindable-expressions.ts', 'ui/core/bindable/expression-parser.ts'],
};

/** The core files of the XML run time itself. */
export const XML_RUN_TIME_FILES = ['xml/index.ts', 'js-libs/easysax/easysax.ts', 'ui/core/bindable/expression-parser.ts', 'ui/core/bindable/bindable-expressions.ts'];

export const XML_NOT_LINKED = 'the XML run time is not linked in this app: its XML was built at build time, and this needs the Builder or the expression evaluator';

/** The functions the overlay's code calls in place of the run time's, by core file and name. */
export function xmlFreeCounterparts(fn: { parse: string; expression: string }): Record<string, Record<string, string>> {
	return {
		'ui/builder/index.ts': { parseInternal: fn.parse },
		'ui/core/bindable/bindable-expressions.ts': { parseExpression: fn.expression, convertExpressionToValue: fn.expression },
	};
}

/** `xml2ui`'s members the overlay keeps: the error formatters and the source tracker the page factories call. */
const XML2UI_KEPT = new Set(['ErrorFormatter', 'PositionErrorFormat', 'SourceErrorFormat', 'SourceTracker', 'ComponentSourceTracker']);

/**
 * Takes the XML parsing classes out of core's Builder module (in place, as the kit generator's report mode drops a
 * member): what is left names none of the parser's values.
 */
export function pruneXmlFree(sf: ts.SourceFile): void {
	for (const st of sf.statements) {
		if (!ts.isModuleDeclaration(st) || st.name.getText(sf) !== 'xml2ui' || !st.body || !ts.isModuleBlock(st.body)) continue;
		const block = st.body as unknown as Record<string, ts.NodeArray<ts.Statement>>;
		const list = block.statements;
		const name = (s: ts.Statement) => ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s) || ts.isInterfaceDeclaration(s)) && s.name ? s.name.text : '');
		const kept = Object.assign(
			list.filter((s) => XML2UI_KEPT.has(name(s))),
			{ pos: list.pos, end: list.end, hasTrailingComma: list.hasTrailingComma },
		);
		if (kept.length !== XML2UI_KEPT.size) throw new Error(`core's xml2ui no longer declares ${[...XML2UI_KEPT].filter((n) => !kept.some((s) => name(s) === n)).join(', ')}: update kit-overlay.ts`);
		Object.defineProperty(block, 'statements', { value: kept, writable: true, configurable: true, enumerable: true });
		return;
	}
	throw new Error(`${sf.fileName}: no namespace xml2ui (kit-overlay.ts)`);
}

/**
 * The interfaces a pruned module declared that its overlay still names: those of the parser's classes go with them.
 * `declared` is the interfaces' code; a name it declares and `body` uses keeps all of it.
 */
export function overlayInterfaces(declared: string, body: string): string {
	const names = [...declared.matchAll(/^(?:public |open |final )*(?:protocol|class|interface)\s+(\w+)/gm)].map((m) => m[1]);
	return names.some((n) => new RegExp(`\\b${n}\\b`).test(body)) ? declared : '';
}
