// The operator plans of src/semantics/apis/ (bigint.ts, operators.ts), and the code they spell from a backend's tables.
//   node --test tests/semantics/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { bigIntArithmetic, bigIntPlan } from '../../src/semantics/apis/bigint.ts';
import { BIT_ASSIGNMENTS, bitOperation } from '../../src/semantics/apis/operators.ts';
import { KOTLIN_RUNTIME, SWIFT_RUNTIME } from '../../src/semantics/runtime.ts';

const K = ts.SyntaxKind;

test('BigInt arithmetic of two BigInts, compound or not; none of a BigInt and a number', () => {
	assert.deepEqual(bigIntPlan(K.PlusToken, true, true), { kind: 'arithmetic', op: 'add', assigns: false });
	assert.deepEqual(bigIntPlan(K.AsteriskAsteriskEqualsToken, true, true), { kind: 'arithmetic', op: 'power', assigns: true });
	// `1n + 1` throws a TypeError, which the runtime's mixed addition gives.
	assert.equal(bigIntPlan(K.PlusToken, true, false), null);
	assert.equal(bigIntPlan(K.PlusToken, false, false), null);
	assert.equal(bigIntPlan(K.GreaterThanGreaterThanGreaterThanToken, true, true), null);
});

test('BigInt comparison, exact against a number on either side', () => {
	assert.deepEqual(bigIntPlan(K.LessThanToken, true, true), { kind: 'compare', operator: '<', big: null });
	assert.deepEqual(bigIntPlan(K.GreaterThanEqualsToken, false, true), { kind: 'compare', operator: '>=', big: 'right' });
	assert.equal(bigIntPlan(K.EqualsEqualsEqualsToken, true, false), null);
});

test("BigInt arithmetic spelled from a backend's infix operators and the runtime's functions", () => {
	const infix = { add: '+', subtract: '-', multiply: '*', and: 'and', or: 'or', xor: 'xor' };
	assert.equal(bigIntArithmetic('xor', 'a', 'b', KOTLIN_RUNTIME, infix), '(a xor b)');
	assert.equal(bigIntArithmetic('divide', 'a', 'b', SWIFT_RUNTIME, infix), 'JSBigInt.divide(a, b)');
});

test('each bitwise operator and its compound assignment take one runtime function', () => {
	assert.equal(bitOperation(K.BarToken, SWIFT_RUNTIME), 'jsBitOr');
	assert.equal(bitOperation(K.BarEqualsToken, KOTLIN_RUNTIME), 'jsBitOr');
	assert.equal(bitOperation(K.PlusToken, SWIFT_RUNTIME), undefined);
	for (const [assign, op] of Object.entries(BIT_ASSIGNMENTS)) assert.equal(bitOperation(+assign, SWIFT_RUNTIME), bitOperation(op, SWIFT_RUNTIME));
});
