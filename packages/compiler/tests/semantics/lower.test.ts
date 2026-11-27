import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { flattenStringConcat, planArithmetic, planEquality, planLogicalAssign, planNullishCoalesce, planRelational, planUnary, typeofComparison } from '../../src/semantics/lower.ts';
import { CodeMarks, emitted, exprText, markedExpr, pureExpr } from '../../src/semantics/marks.ts';

const K = ts.SyntaxKind;

describe('semantics/lower', () => {
	it('plans relational operators into string, dynamic, or numeric forms', () => {
		assert.deepEqual(planRelational(K.LessThanToken, true, true, false), { kind: 'string', op: '<' });
		assert.deepEqual(planRelational(K.GreaterThanEqualsToken, false, false, true), { kind: 'dynamic', op: '>=' });
		assert.deepEqual(planRelational(K.LessThanEqualsToken, false, false, false), { kind: 'numeric', op: '<=' });
		assert.equal(planRelational(K.PlusToken, false, false, false), null);
	});

	it('plans arithmetic and compound assignment operators', () => {
		assert.deepEqual(planArithmetic(K.PlusToken, true, false, false, false), { kind: 'concat', assigns: false });
		assert.deepEqual(planArithmetic(K.PlusToken, false, false, true, false), { kind: 'dynamicAdd', assigns: false });
		assert.deepEqual(planArithmetic(K.PlusEqualsToken, true, false, false, false), { kind: 'concat', assigns: true });
		assert.deepEqual(planArithmetic(K.AsteriskAsteriskToken, false, false, false, false), { kind: 'numeric', op: '**', assigns: false });
		assert.equal(planArithmetic(K.AmpersandToken, false, false, false, false), null);
	});

	it('plans logical assignments and unary operators', () => {
		assert.deepEqual(planLogicalAssign(K.QuestionQuestionEqualsToken), { kind: 'logicalAssign', op: '??=' });
		assert.deepEqual(planLogicalAssign(K.BarBarEqualsToken), { kind: 'logicalAssign', op: '||=' });
		assert.equal(planLogicalAssign(K.EqualsToken), null);
		assert.deepEqual(planUnary(K.MinusToken, true), { kind: 'negate', bigInt: true });
		assert.deepEqual(planUnary(K.TildeToken, false), { kind: 'bitNot', bigInt: false });
		assert.equal(planUnary(K.PlusPlusToken, false), null);
	});

	it('flattens string concatenation chains while preserving numeric subexpressions', () => {
		const sf = ts.createSourceFile('t.ts', "const x = ('item' + (a + b) + ';' + n);", ts.ScriptTarget.ES2022, true);
		const expr = ((sf.statements[0] as ts.VariableStatement).declarationList.declarations[0].initializer)!;
		const isStr = (e: ts.Expression): boolean => {
			const inner = ts.skipParentheses(e);
			if (ts.isStringLiteral(inner)) return true;
			if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === K.PlusToken) return isStr(inner.left) || isStr(inner.right);
			return false;
		};
		const parts = flattenStringConcat(expr, isStr).map((p) => p.getText(sf));
		assert.deepEqual(parts, ["'item'", '(a + b)', "';'", 'n']);
	});

	it('plans equality, nullish coalescing, and typeof comparisons', () => {
		assert.deepEqual(planEquality(K.EqualsEqualsEqualsToken, false, false, false, false), { kind: 'strict', negated: false, mode: 'direct' });
		assert.deepEqual(planEquality(K.ExclamationEqualsEqualsToken, true, false, false, false), { kind: 'strict', negated: true, mode: 'dynamic' });
		assert.deepEqual(planEquality(K.EqualsEqualsToken, false, false, false, true), { kind: 'loose', negated: false, mode: 'nullish' });
		assert.deepEqual(planEquality(K.ExclamationEqualsToken, false, false, false, false), { kind: 'loose', negated: true, mode: 'dynamic' });
		assert.equal(planEquality(K.LessThanToken, false, false, false, false), null);

		assert.deepEqual(planNullishCoalesce(true, false), { kind: 'dynamic' });
		assert.deepEqual(planNullishCoalesce(false, true), { kind: 'optional' });
		assert.deepEqual(planNullishCoalesce(false, false), { kind: 'identity' });

		const sf = ts.createSourceFile('t.ts', "const a = typeof x === 'string'; const b = 'number' !== typeof y; const c = x === 'string';", ts.ScriptTarget.ES2022, true);
		const exprAt = (i: number) => ((sf.statements[i] as ts.VariableStatement).declarationList.declarations[0].initializer)! as ts.BinaryExpression;
		const cmpA = typeofComparison(exprAt(0));
		assert.equal(cmpA?.tag, 'string');
		assert.equal(cmpA?.negated, false);
		assert.equal(cmpA?.strict, true);
		assert.equal(cmpA?.operand.getText(sf), 'x');

		const cmpB = typeofComparison(exprAt(1));
		assert.equal(cmpB?.tag, 'number');
		assert.equal(cmpB?.negated, true);
		assert.equal(cmpB?.operand.getText(sf), 'y');

		assert.equal(typeofComparison(exprAt(2)), null);
	});
});

describe('semantics/marks EmittedExpr', () => {
	it('constructs and bridges structured EmittedExpr values through CodeMarks', () => {
		const marks = new CodeMarks();
		const p = pureExpr('x');
		assert.equal(marks.emit(p), 'x');
		assert.equal(marks.isPure('x'), true);
		assert.equal(exprText(p), 'x');
		assert.equal(exprText('raw'), 'raw');

		const m = markedExpr('o.a', { op: 'member', of: emitted('o', { pure: true }), name: 'a' });
		marks.emit(m);
		assert.equal(marks.read(m).mark?.op, 'member');
		assert.equal(marks.read('o.a').mark?.op, 'member');
		assert.equal(marks.isPath('o.a'), false);
		marks.pureCode('o');
		assert.equal(marks.isPath('o.a'), true);
	});
});
