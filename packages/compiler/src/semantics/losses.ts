// Held losses (tests/checks/held-loss.ts): every place a backend spells a value that stands in for undefined or null
// (NaN, "undefined", "", 0, false, a type's zero) or asserts one away (Swift `!`, Kotlin `!!`) reports here, with the
// node being translated, what the value is used as there, and why the loss is allowed (`LossReason`) or that nothing
// says (`unnamed`). With NS_HELD_LOSS unset nothing is recorded; set to a folder, each process (and worker thread)
// appends its sites there as JSON lines, as translations run in processes the check does not own (kits, apps).
import ts from 'typescript';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';
import type { Entry, SlotKind, Step } from './conversion.ts';
import type { Form } from './forms/forms.ts';

/**
 * Why a value that stands in for undefined or null is allowed where it is held. `nativeBinding`: a platform parameter or
 * result that takes or gives neither. `kitSurface`: a kit field or result the kit holds with one empty value.
 * `libraryZero`: core's own primitive field, parameter or result holding its zero (or NaN, "undefined", false).
 * `lenientZero`: the same in lenient app or plugin code. `foreignNumberRead`: Swift's typed read of a foreign value in a
 * `number[]`. `stringifyUndefined`: `JSON.stringify`'s undefined (of undefined, a function, a symbol), which TypeScript
 * types `string`, held as the text "undefined" (the same where it is printed).
 */
export type LossReason = 'nativeBinding' | 'kitSurface' | 'libraryZero' | 'lenientZero' | 'foreignNumberRead' | 'stringifyUndefined';

/** Why a value read as present is there: `flow` (its form has no empty state), `made` (constructed on this path), `native` (the binding says non-nil), `tested` (a guard dominates). */
export type Proof = 'flow' | 'made' | 'native' | 'tested';

export type LossMode = 'strict' | 'lenient' | 'library';

/**
 * Where a library or lenient zero's empty value comes from: `own`, the program's own code (a null or undefined it writes,
 * an argument it leaves out, a read it finds missing: a loss to fix or name one by one); `entry`, a caller the program
 * doesn't contain (the kit's surface, a foreign caller: a counted loss); `unknown` where the site has no slot to ask.
 */
export type LossSource = 'own' | 'entry' | 'unknown';

export interface HeldLoss {
	backend: 'swift' | 'kotlin';
	/** `file:line:column`, of the node being translated. */
	at: string;
	/** The node's kind and its source text, cut. */
	node: string;
	/** The backend emitter that spelled it (`undefinedAs`, `unwrappedCode`). */
	emitter: string;
	/** What stands in for the empty value: `NaN`, `"undefined"`, `""`, `0`, `false`, `zero` (another of a type's), `!`, `!!`, `implicit` (Swift's implicitly unwrapped optional). */
	spelled: string;
	/** `default`: a value stands in; `unwrap`: the empty value is asserted away. */
	form: 'default' | 'unwrap';
	/** What the value is used as where it is read (`operand` and `condition` are JavaScript's own conversions). */
	use: SlotKind;
	mode: LossMode;
	/** Null where JavaScript itself converts (an operand, a condition), else the reason or `unnamed`. */
	reason: LossReason | 'unnamed' | null;
	/** For a `libraryZero` or `lenientZero`: where its empty value comes from. */
	source?: LossSource;
	/** For an unwrap: why the value is present, or `unproven`. */
	proof: Proof | 'unproven' | null;
}

export const HELD_LOSS = !!process.env.NS_HELD_LOSS;
const folder = HELD_LOSS && process.env.NS_HELD_LOSS !== '1' ? process.env.NS_HELD_LOSS! : null;

interface Site {
	backend: 'swift' | 'kotlin';
	mode: LossMode;
	node: ts.Node;
	forms?: () => FormReader;
}

interface FormReader {
	formOf(e: ts.Expression): Form;
	formOfSlot(d: ts.Declaration): Form;
}

let site: Site | undefined;
const seen = new Set<string>();
let taken: HeldLoss[] = [];

/** A translator as losses read its mode: core's code, lenient app or plugin code, or strict app code. */
interface Moded {
	library: unknown;
	lenient: boolean;
	lenientApp?: boolean;
	states?: { forms(): FormReader };
}

/** `f()`, the losses it reports placed at `node` (where none inside it is translated). */
export function atLossSite<T>(backend: 'swift' | 'kotlin', t: Moded, node: ts.Node, f: () => T): T {
	if (!HELD_LOSS) return f();
	const prev = site;
	site = { backend, mode: lossMode(t), node, forms: formsOf(t) };
	try {
		return f();
	} finally {
		site = prev;
	}
}

/** Places the losses reported next at `node` (a module's statement), or nowhere. */
export function setLossSite(backend: 'swift' | 'kotlin', t: Moded, node: ts.Node | undefined): void {
	if (HELD_LOSS) site = node && { backend, mode: lossMode(t), node, forms: formsOf(t) };
}

/**
 * The loss a plan cell's step makes for a slot of `kind` entered as `entry`: none for an operand or a condition, which
 * is JavaScript's own conversion; the mode's reason in library and lenient code; else `unnamed`.
 */
export function lossOf(step: Step, kind: SlotKind, entry: Entry): LossReason | 'unnamed' | undefined {
	if (!LOSSY_STEPS.has(step)) return undefined;
	return reasonOf(kind, entry === 'library' ? 'library' : entry === 'lenient' ? 'lenient' : 'strict', false) ?? undefined;
}

/** Why a value standing in for an empty one is allowed in a slot of `use`: null where JavaScript itself converts it. */
function reasonOf(use: SlotKind, mode: LossMode, native: boolean): LossReason | 'unnamed' | null {
	if (use === 'operand' || use === 'condition') return null;
	if (native) return 'nativeBinding';
	return mode === 'library' ? 'libraryZero' : mode === 'lenient' ? 'lenientZero' : 'unnamed';
}
const LOSSY_STEPS: ReadonlySet<Step> = new Set(['undefinedAs', 'nullAs', 'zero', 'libraryDefault']);

/**
 * Reports a loss at the node being translated (or `o.node`). `o.native`: the value comes from or goes to a platform
 * binding; `o.proof`: why an unwrapped value is present.
 */
export function heldLoss(emitter: string, spelled: string, o: { node?: ts.Node; proof?: Proof; native?: boolean } = {}): void {
	if (!HELD_LOSS || !site) return;
	const node = realNode(o.node ?? site.node);
	if (!node) return;
	const sf = node.getSourceFile();
	const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
	spelled = SPELLED[spelled] ?? (/^".*"$/.test(spelled) || ['!', '!!', 'implicit'].includes(spelled) ? spelled : 'zero');
	const form = spelled === '!' || spelled === '!!' || spelled === 'implicit' ? 'unwrap' : 'default';
	const use = useOf(node);
	const plain = form === 'unwrap' ? null : reasonOf(use, site.mode, !!o.native);
	const reason = plain && spelled === '"undefined"' && isStringify(node) ? 'stringifyUndefined' : plain;
	const loss: HeldLoss = {
		backend: site.backend,
		at: `${sf.fileName}:${line + 1}:${character + 1}`,
		node: `${ts.SyntaxKind[node.kind]} ${node.getText(sf).replace(/\s+/g, ' ').slice(0, 80)}`,
		emitter,
		spelled,
		form,
		use,
		mode: site.mode,
		reason,
		...(reason === 'libraryZero' || reason === 'lenientZero' ? { source: sourceOf(node, site.forms) } : {}),
		proof: form === 'unwrap' ? (o.proof ?? 'unproven') : null,
	};
	const key = JSON.stringify(loss);
	if (seen.has(key)) return;
	seen.add(key);
	taken.push(loss);
	if (folder) {
		mkdirSync(folder, { recursive: true });
		appendFileSync(join(folder, `${process.pid}-${threadId}.jsonl`), key + '\n');
	}
}

/** A backend's spelling of a stand-in value, as the list shows it. */
const SPELLED: Readonly<Record<string, string>> = { '.nan': 'NaN', 'Double.nan': 'NaN', 'Double.NaN': 'NaN', '0': '0', '0.0': '0', false: 'false', '""': '""' };

/** The losses reported since the last take. */
export function takeHeldLosses(): HeldLoss[] {
	const out = taken;
	taken = [];
	seen.clear();
	return out;
}

function realNode(n: ts.Node | undefined): ts.Node | undefined {
	while (n && (n.pos < 0 || !n.getSourceFile())) n = n.parent;
	return n;
}

/** What the value of `e` is used as where it stands: the slot it is placed in, or the operation reading it. */
export function useOf(e: ts.Node): SlotKind {
	let x = e;
	while (x.parent && (ts.isParenthesizedExpression(x.parent) || ts.isAsExpression(x.parent) || ts.isTypeAssertionExpression(x.parent) || ts.isNonNullExpression(x.parent) || ts.isSatisfiesExpression(x.parent))) x = x.parent;
	const p = x.parent;
	if (ts.isClassLike(x)) return 'field';
	if (!p) return 'untyped';
	if (ts.isVariableStatement(x) || ts.isVariableDeclarationList(x)) return 'variable';
	if (ts.isBindingElement(x) || ts.isArrayBindingPattern(p) || ts.isObjectBindingPattern(p)) return 'binding';
	if (ts.isVariableDeclaration(p)) return ts.isIdentifier(p.name) ? 'variable' : 'binding';
	if (ts.isBindingElement(p)) return 'binding';
	if ((ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) && p.expression === x) return 'condition';
	if (ts.isForStatement(p) && p.condition === x) return 'condition';
	if (ts.isConditionalExpression(p)) return p.condition === x ? 'condition' : useOf(p);
	if (ts.isPrefixUnaryExpression(p)) return p.operator === ts.SyntaxKind.ExclamationToken ? 'condition' : 'operand';
	if (ts.isPostfixUnaryExpression(p) || ts.isTemplateSpan(p) || ts.isTypeOfExpression(p) || ts.isVoidExpression(p)) return 'operand';
	if (ts.isBinaryExpression(p)) {
		const op = p.operatorToken.kind;
		if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) return p.left === x ? 'condition' : useOf(p);
		if (op === ts.SyntaxKind.QuestionQuestionToken) return useOf(p);
		if (op === ts.SyntaxKind.CommaToken) return p.right === x ? useOf(p) : 'operand';
		if (op === ts.SyntaxKind.EqualsToken) {
			if (p.left === x) return 'untyped';
			const l = ts.skipOuterExpressions(p.left);
			return ts.isPropertyAccessExpression(l) ? 'field' : ts.isElementAccessExpression(l) ? 'element' : ts.isIdentifier(l) ? 'variable' : 'binding';
		}
		return 'operand';
	}
	if (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) return p.expression === x ? 'receiver' : 'operand';
	if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression !== x) return 'argument';
	if (ts.isCallExpression(p)) return 'receiver';
	if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) return 'literalField';
	if (ts.isArrayLiteralExpression(p)) return 'element';
	if (ts.isSpreadElement(p) || ts.isSpreadAssignment(p)) return 'spread';
	if (ts.isAwaitExpression(p)) return 'await';
	if (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === x)) return 'return';
	if (ts.isPropertyDeclaration(p) || ts.isParameter(p)) return 'field';
	if (ts.isExpressionStatement(p)) return 'untyped';
	return 'untyped';
}

function isStringify(n: ts.Node): boolean {
	const x = ts.skipOuterExpressions(n as ts.Expression);
	return ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && x.expression.name.text === 'stringify' && ts.isIdentifier(x.expression.expression) && x.expression.expression.text === 'JSON';
}

function formsOf(t: Moded): (() => FormReader) | undefined {
	const states = t.states;
	return states && (() => states.forms());
}

/** Where the empty value a zero stands in for at `node` comes from, as the flow's form of its value or slot says. */
function sourceOf(node: ts.Node, forms: (() => FormReader) | undefined): LossSource {
	let x = node;
	while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x)) x = x.expression;
	if (x.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(x) || (ts.isIdentifier(x) && x.text === 'undefined')) return 'own';
	if (!forms) return 'unknown';
	try {
		const slot = ts.isParameter(x) || ts.isPropertyDeclaration(x) || ts.isVariableDeclaration(x) || ts.isPropertySignature(x) || ts.isBindingElement(x) ? (x as ts.Declaration) : null;
		if (!slot && !(ts.isExpression(x) && !ts.isClassLike(x))) return 'unknown';
		const f = slot ? forms().formOfSlot(slot) : forms().formOf(x as ts.Expression);
		return f.given || f.absent || f.missing ? 'own' : 'entry';
	} catch {
		return 'unknown';
	}
}

function lossMode(t: Moded): LossMode {
	return t.library ? 'library' : t.lenient || t.lenientApp ? 'lenient' : 'strict';
}
