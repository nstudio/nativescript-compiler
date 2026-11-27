// Backend-neutral lowered expression IR foundation: classifies JavaScript operators and expression shapes once in
// semantics/ so both Swift and Kotlin backends spell from one plan rather than duplicating operator dispatch trees.
import ts from 'typescript';

const K = ts.SyntaxKind;

export type RelationalSymbol = '<' | '>' | '<=' | '>=';
export type ArithmeticSymbol = '+' | '-' | '*' | '/' | '%' | '**';
export type LogicalAssignSymbol = '??=' | '||=' | '&&=';
export type EqualityKind = 'strict' | 'loose';

export type EqualityPlan = {
	readonly kind: EqualityKind;
	readonly negated: boolean;
	readonly mode: 'nullish' | 'dynamic' | 'direct';
};

export type NullishCoalescePlan = { readonly kind: 'dynamic' | 'optional' | 'identity' };

export interface TypeofComparison {
	readonly operand: ts.Expression;
	readonly tag: string;
	readonly negated: boolean;
	readonly strict: boolean;
}

export type RelationalPlan =
	| { readonly kind: 'string'; readonly op: RelationalSymbol }
	| { readonly kind: 'dynamic'; readonly op: RelationalSymbol }
	| { readonly kind: 'numeric'; readonly op: RelationalSymbol };

export type ArithmeticPlan =
	| { readonly kind: 'concat'; readonly assigns: boolean }
	| { readonly kind: 'dynamicAdd'; readonly assigns: boolean }
	| { readonly kind: 'numeric'; readonly op: ArithmeticSymbol; readonly assigns: boolean };

export type LogicalAssignPlan = { readonly kind: 'logicalAssign'; readonly op: LogicalAssignSymbol };

export type UnaryPlan =
	| { readonly kind: 'not' }
	| { readonly kind: 'negate'; readonly bigInt: boolean }
	| { readonly kind: 'plus' }
	| { readonly kind: 'bitNot'; readonly bigInt: boolean };

const RELATIONAL_OPS: Partial<Record<ts.SyntaxKind, RelationalSymbol>> = {
	[K.LessThanToken]: '<',
	[K.GreaterThanToken]: '>',
	[K.LessThanEqualsToken]: '<=',
	[K.GreaterThanEqualsToken]: '>=',
};

const ARITHMETIC_OPS: Partial<Record<ts.SyntaxKind, { readonly sym: ArithmeticSymbol; readonly assigns: boolean }>> = {
	[K.PlusToken]: { sym: '+', assigns: false },
	[K.MinusToken]: { sym: '-', assigns: false },
	[K.AsteriskToken]: { sym: '*', assigns: false },
	[K.SlashToken]: { sym: '/', assigns: false },
	[K.PercentToken]: { sym: '%', assigns: false },
	[K.AsteriskAsteriskToken]: { sym: '**', assigns: false },
	[K.PlusEqualsToken]: { sym: '+', assigns: true },
	[K.MinusEqualsToken]: { sym: '-', assigns: true },
	[K.AsteriskEqualsToken]: { sym: '*', assigns: true },
	[K.SlashEqualsToken]: { sym: '/', assigns: true },
	[K.PercentEqualsToken]: { sym: '%', assigns: true },
	[K.AsteriskAsteriskEqualsToken]: { sym: '**', assigns: true },
};

const LOGICAL_ASSIGN_OPS: Partial<Record<ts.SyntaxKind, LogicalAssignSymbol>> = {
	[K.QuestionQuestionEqualsToken]: '??=',
	[K.BarBarEqualsToken]: '||=',
	[K.AmpersandAmpersandEqualsToken]: '&&=',
};

/** Classifies `<`, `>`, `<=`, `>=` once for both backends: string comparison, dynamic runtime helper, or numeric infix. */
export function planRelational(op: ts.SyntaxKind, leftString: boolean, rightString: boolean, dynamicOperand: boolean): RelationalPlan | null {
	const sym = RELATIONAL_OPS[op];
	if (!sym) return null;
	if (leftString && rightString) return { kind: 'string', op: sym };
	if (dynamicOperand) return { kind: 'dynamic', op: sym };
	return { kind: 'numeric', op: sym };
}

/** Classifies `+`, `-`, `*`, `/`, `%`, `**` and their compound assignments (`+=`, etc.) once for both backends. */
export function planArithmetic(op: ts.SyntaxKind, leftString: boolean, rightString: boolean, leftAny: boolean, rightAny: boolean): ArithmeticPlan | null {
	const entry = ARITHMETIC_OPS[op];
	if (!entry) return null;
	if (entry.sym === '+') {
		if (!entry.assigns && (leftString || rightString)) return { kind: 'concat', assigns: false };
		if (entry.assigns && leftString) return { kind: 'concat', assigns: true };
		if (leftAny || (!entry.assigns && rightAny)) return { kind: 'dynamicAdd', assigns: entry.assigns };
	}
	return { kind: 'numeric', op: entry.sym, assigns: entry.assigns };
}

/** Classifies `??=`, `||=`, `&&=`. */
export function planLogicalAssign(op: ts.SyntaxKind): LogicalAssignPlan | null {
	const sym = LOGICAL_ASSIGN_OPS[op];
	return sym ? { kind: 'logicalAssign', op: sym } : null;
}

/** Classifies `!`, `-`, `+`, `~` prefix unary operators. */
export function planUnary(op: ts.SyntaxKind, isBigInt: boolean): UnaryPlan | null {
	switch (op) {
		case K.ExclamationToken:
			return { kind: 'not' };
		case K.MinusToken:
			return { kind: 'negate', bigInt: isBigInt };
		case K.PlusToken:
			return { kind: 'plus' };
		case K.TildeToken:
			return { kind: 'bitNot', bigInt: isBigInt };
		default:
			return null;
	}
}

/** Flattens left-nested string `+` concatenation chains into an ordered list of leaf operands for builder/buffer emission. */
export function flattenStringConcat(expr: ts.Expression, isString: (e: ts.Expression) => boolean): ts.Expression[] {
	const out: ts.Expression[] = [];
	const visit = (x: ts.Expression): void => {
		const inner = ts.skipParentheses(x);
		if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === K.PlusToken && (isString(inner.left) || isString(inner.right))) {
			visit(inner.left);
			visit(inner.right);
			return;
		}
		out.push(x);
	};
	visit(expr);
	return out;
}

/** Classifies `===`, `!==`, `==`, `!=` into nullish comparison, dynamic runtime helper, or direct backend comparison. */
export function planEquality(op: ts.SyntaxKind, leftAny: boolean, rightAny: boolean, leftNullish: boolean, rightNullish: boolean): EqualityPlan | null {
	let kind: EqualityKind;
	let negated: boolean;
	switch (op) {
		case K.EqualsEqualsEqualsToken:
			kind = 'strict';
			negated = false;
			break;
		case K.ExclamationEqualsEqualsToken:
			kind = 'strict';
			negated = true;
			break;
		case K.EqualsEqualsToken:
			kind = 'loose';
			negated = false;
			break;
		case K.ExclamationEqualsToken:
			kind = 'loose';
			negated = true;
			break;
		default:
			return null;
	}
	if (leftNullish || rightNullish) return { kind, negated, mode: 'nullish' };
	if (leftAny || rightAny || kind === 'loose') return { kind, negated, mode: 'dynamic' };
	return { kind, negated, mode: 'direct' };
}

/** Classifies `a ?? b` based on whether the left operand is untyped, optional, or statically present. */
export function planNullishCoalesce(leftAny: boolean, leftOptional: boolean): NullishCoalescePlan {
	if (leftAny) return { kind: 'dynamic' };
	if (leftOptional) return { kind: 'optional' };
	return { kind: 'identity' };
}

/** Extracts `typeof x === 'tag'` (or `!==`, `==`, `!=`, in either operand order) into a backend-neutral descriptor. */
export function typeofComparison(e: ts.BinaryExpression): TypeofComparison | null {
	const op = e.operatorToken.kind;
	const strict = op === K.EqualsEqualsEqualsToken || op === K.ExclamationEqualsEqualsToken;
	const loose = op === K.EqualsEqualsToken || op === K.ExclamationEqualsToken;
	if (!strict && !loose) return null;
	const negated = op === K.ExclamationEqualsEqualsToken || op === K.ExclamationEqualsToken;
	const left = ts.skipParentheses(e.left);
	const right = ts.skipParentheses(e.right);
	if (ts.isTypeOfExpression(left) && ts.isStringLiteralLike(right)) return { operand: left.expression, tag: right.text, negated, strict };
	if (ts.isTypeOfExpression(right) && ts.isStringLiteralLike(left)) return { operand: right.expression, tag: left.text, negated, strict };
	return null;
}
