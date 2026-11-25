// The API tables (src/semantics/apis/) against what Node answers (js-answers.json, from record-js-answers.ts): each
// entry's arity is the function's `length`, its result what `typeof` gives, and it may throw exactly where a probe
// does. Entries of a host (the web platform's timers, NativeScript's) or of one native SDK are no ECMAScript Node answers for.
//   node --test tests/semantics/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { runtimeCall, type ApiEntry, type CallArguments } from '../../src/semantics/apis/api.ts';
import { GLOBALS, globalFunction } from '../../src/semantics/apis/globals.ts';
import { mathFunction, mathFunctionValue } from '../../src/semantics/apis/math.ts';
import { staticFunction } from '../../src/semantics/apis/statics.ts';
import { ARRAY_METHODS } from '../../src/semantics/apis/array.ts';
import { COLLECTION_METHODS } from '../../src/semantics/apis/mapset.ts';
import { NUMBER_METHODS } from '../../src/semantics/apis/number.ts';
import { PROMISE_METHODS } from '../../src/semantics/apis/promise.ts';
import { REGEXP_STRING_METHODS } from '../../src/semantics/apis/regexp.ts';
import { STRING_METHODS } from '../../src/semantics/apis/string.ts';
import { SHARED_OPS } from '../../src/semantics/runtime.ts';

const { answers } = JSON.parse(readFileSync(join(import.meta.dirname, 'js-answers.json'), 'utf8')) as { answers: Record<string, { length: number; result: string; throws: boolean }> };
const OWNERS = ['Array', 'ArrayBuffer', 'BigInt', 'Date', 'JSON', 'Map', 'Math', 'Number', 'Object', 'Promise', 'String', 'Symbol', 'console', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array'];

/** The method tables, each with the name Node knows a member by. */
const METHOD_TABLES: [Readonly<Record<string, ApiEntry>>, (name: string) => string][] = [
	[STRING_METHODS, (n) => `String.prototype.${n}`],
	[REGEXP_STRING_METHODS, (n) => `String.prototype.${n}/regexp`],
	[ARRAY_METHODS, (n) => `Array.prototype.${n}`],
	[NUMBER_METHODS, (n) => `Number.prototype.${n}`],
	[PROMISE_METHODS, (n) => `Promise.prototype.${n}`],
	[COLLECTION_METHODS, (n) => `${n === 'add' ? 'Set' : 'Map'}.prototype.${n}`],
];

/** Every entry the tables hold, by the name Node knows it by. */
function entries(): [string, ApiEntry][] {
	const out: [string, ApiEntry][] = Object.entries(GLOBALS);
	for (const [table, named] of METHOD_TABLES) for (const [n, entry] of Object.entries(table)) out.push([named(n), entry]);
	for (const [name] of Object.entries(answers)) {
		const dot = name.indexOf('.');
		if (dot < 0 || name.includes('.prototype.')) continue;
		const s = staticFunction(name.slice(0, dot), name.slice(dot + 1));
		if (s) out.push([name, s]);
	}
	return out;
}

test('every entry answers as Node does', () => {
	for (const [name, entry] of entries()) {
		if (entry.host || entry.sdk) continue;
		const js = answers[name];
		assert.ok(js, `${name}: no answer from Node (record-js-answers.ts has no probe for it)`);
		assert.equal(entry.arity, js.length, `${name}: arity`);
		if (entry.result !== 'any') assert.equal(entry.result, js.result, `${name}: result`);
		assert.equal(entry.throws, js.throws, `${name}: throws`);
	}
});

test('every answer names an entry', () => {
	const methods = new Set(entries().map(([n]) => n));
	for (const name of Object.keys(answers)) {
		if (name.includes('.prototype.')) {
			assert.ok(methods.has(name), `${name}: answered, but no table has it`);
			continue;
		}
		const dot = name.indexOf('.');
		const entry = dot < 0 ? globalFunction(name) : OWNERS.includes(name.slice(0, dot)) ? staticFunction(name.slice(0, dot), name.slice(dot + 1)) : null;
		assert.ok(entry, `${name}: answered, but no table has it`);
	}
});

test('a member a table lacks is no entry, inherited names included', () => {
	assert.equal(staticFunction('Math', 'toString'), null);
	assert.equal(staticFunction('Object', 'constructor'), null);
	assert.equal(staticFunction('Reflect', 'has'), null);
	assert.equal(globalFunction('hasOwnProperty'), null);
	assert.equal(mathFunction('sumPrecise'), null);
});

test('only a function of one number is a Math function value', () => {
	assert.equal(mathFunctionValue('floor'), 'floor');
	assert.equal(mathFunctionValue('max'), null);
	assert.equal(mathFunctionValue('random'), null);
});

test('a plain runtime call names a shared runtime function and spells each argument in its form', () => {
	for (const [name, entry] of entries()) if (entry.args) assert.ok(entry.runtime && (SHARED_OPS as readonly string[]).includes(entry.runtime), `${name}: ${entry.runtime}`);
	const call = ts.factory.createCallExpression(ts.factory.createIdentifier('f'), undefined, [ts.factory.createIdentifier('a'), ts.factory.createIdentifier('b')]);
	const spelled = (x: ts.Expression) => (x as ts.Identifier).text;
	const t: CallArguments = {
		syntax: { runtime: { jsHasOwn: 'RT_jsHasOwn', jsFromCodePoint: 'RT_jsFromCodePoint' }, untypedType: 'U' } as unknown as CallArguments['syntax'],
		expr: spelled,
		restArgument: (_, x, type) => `${spelled(x)} as ${type}`,
		str: (x) => `str(${spelled(x)})`,
		propertyKey: (x) => `key(${spelled(x)})`,
		iterable: (x) => `it(${spelled(x)})`,
		callback: (x) => `cb(${spelled(x)})`,
		args: (c) => c.arguments.map(spelled),
	};
	assert.equal(runtimeCall(t, staticFunction('Object', 'hasOwn')!, call), 'RT_jsHasOwn(a as U, key(b))');
	assert.equal(runtimeCall(t, staticFunction('String', 'fromCodePoint')!, call), 'RT_jsFromCodePoint(a, b)');
});
