#!/usr/bin/env node
// What Node answers for each library function the API tables (src/semantics/apis/) describe, written to
// js-answers.json, which apis.test.ts holds the tables to: the function's `length`, what `typeof` gives for the result
// of the first probe, and whether any probe throws. A table entry that may throw has a probe that does; one that
// may not has none. Run it again when an entry or a probe changes, and review the answers' diff.
//   node tests/semantics/record-js-answers.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Probes = readonly (readonly unknown[])[];
const TYPED = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array'];
const one = [[1.5]] as const;

/** Each function by its table's name (`Math.floor`, `parseInt`), with its probes. */
const PROBES: Record<string, Probes> = {
	...Object.fromEntries(['abs', 'acos', 'asin', 'atan', 'cbrt', 'ceil', 'clz32', 'cos', 'cosh', 'exp', 'expm1', 'floor', 'fround', 'log', 'log10', 'log1p', 'log2', 'round', 'sign', 'sin', 'sinh', 'sqrt', 'tan', 'tanh', 'trunc'].map((n) => [`Math.${n}`, one])),
	'Math.atan2': [[1, 2]],
	'Math.imul': [[3, 4]],
	'Math.pow': [[2, 3]],
	'Math.hypot': [[3, 4]],
	'Math.max': [[3, 4, 5]],
	'Math.min': [[3, 4, 5]],
	'Math.random': [[]],
	String: [[1]],
	Number: [['1'], [Symbol()]],
	Boolean: [[1]],
	parseInt: [['12', 10]],
	parseFloat: [['1.5']],
	isNaN: [[1]],
	isFinite: [[1]],
	queueMicrotask: [[() => {}]],
	unescape: [['%41']],
	atob: [['QQ=='], ['*']],
	btoa: [['A'], ['€']],
	encodeURIComponent: [['a b'], ['\uD800']],
	encodeURI: [['a b'], ['\uD800']],
	decodeURIComponent: [['%41'], ['%']],
	decodeURI: [['%41'], ['%']],
	Symbol: [['x']],
	BigInt: [[1], [1.5]],
	'Object.assign': [[{}, { a: 1 }]],
	'Object.create': [[null]],
	'Object.defineProperties': [
		[{}, { a: { value: 1 } }],
		[Object.freeze({}), { a: { value: 1 } }],
	],
	'Object.defineProperty': [
		[{}, 'a', { value: 1 }],
		[Object.freeze({}), 'a', { value: 1 }],
	],
	'Object.entries': [[{ a: 1 }]],
	'Object.freeze': [[{}]],
	'Object.fromEntries': [[[['a', 1]]]],
	'Object.getOwnPropertyDescriptor': [
		[{ a: 1 }, 'a'],
		[null, 'a'],
	],
	'Object.getOwnPropertyNames': [[{}], [null]],
	'Object.getOwnPropertySymbols': [[{}], [null]],
	'Object.getPrototypeOf': [[{}], [null]],
	'Object.groupBy': [[[1, 2], (x: number) => x % 2]],
	'Object.hasOwn': [[{ a: 1 }, 'a']],
	'Object.is': [[1, 1]],
	'Object.isExtensible': [[{}]],
	'Object.isFrozen': [[{}]],
	'Object.isSealed': [[{}]],
	'Object.keys': [[{ a: 1 }]],
	'Object.preventExtensions': [[{}]],
	'Object.seal': [[{}]],
	'Object.values': [[{ a: 1 }]],
	'Number.isFinite': [[1]],
	'Number.isInteger': [[1]],
	'Number.isNaN': [[1]],
	'Number.isSafeInteger': [[1]],
	'Number.parseFloat': [['1.5']],
	'Number.parseInt': [['12']],
	'BigInt.asIntN': [
		[8, 255n],
		[-1, 1n],
	],
	'BigInt.asUintN': [
		[8, 255n],
		[-1, 1n],
	],
	'String.fromCharCode': [[65, 66]],
	'String.fromCodePoint': [[65], [-1]],
	'Array.apply': [[null, [3]]],
	'Array.from': [['ab']],
	'Array.isArray': [[[]]],
	'Array.of': [[1, 2]],
	'ArrayBuffer.isView': [[new Uint8Array(1)]],
	...Object.fromEntries(
		TYPED.flatMap((t): [string, Probes][] => {
			const [a, b]: unknown[] = t.startsWith('Big') ? [1n, 2n] : [1, 2];
			return [
				[`${t}.from`, [[[a]]]],
				[`${t}.of`, [[a, b]]],
			];
		}),
	),
	'Promise.all': [[[]]],
	'Promise.allSettled': [[[]]],
	'Promise.any': [[[1]]],
	'Promise.race': [[[1]]],
	'Promise.reject': [[1]],
	'Promise.resolve': [[1]],
	'Promise.withResolvers': [[]],
	'Date.UTC': [[2020, 0]],
	'Date.now': [[]],
	'Date.parse': [['2020-01-01']],
	'JSON.parse': [['{}'], ['{']],
	'JSON.stringify': [[{}], [1n]],
	'Map.groupBy': [[[1, 2], (x: number) => x % 2]],
	'Symbol.for': [['x']],
	'Symbol.keyFor': [[Symbol.for('x')]],
	...Object.fromEntries(['log', 'info', 'debug', 'dirxml', 'error', 'warn', 'assert', 'count', 'countReset', 'dir', 'group', 'groupCollapsed', 'groupEnd', 'table', 'time', 'timeLog', 'timeEnd', 'trace'].map((n) => [`console.${n}`, [['x']]])),
};

/**
 * Each method by `<Constructor>.prototype.<name>` (`/regexp` after one given a RegExp), with the receiver its probes
 * are called on.
 */
const METHODS: Record<string, { self: () => unknown; probes: Probes }> = {};
const methods = (owner: string, self: () => unknown, probes: Record<string, Probes>, suffix = '') => {
	for (const [name, p] of Object.entries(probes)) METHODS[`${owner}.prototype.${name}${suffix}`] = { self, probes: p };
};
const fn = (x: number) => x;
methods('String', () => 'abcab', {
	at: [[1]],
	charAt: [[1]],
	charCodeAt: [[1]],
	codePointAt: [[1]],
	concat: [['d']],
	endsWith: [['b']],
	includes: [['b']],
	indexOf: [['b']],
	lastIndexOf: [['b']],
	localeCompare: [['b']],
	match: [['b']],
	padEnd: [[8]],
	padStart: [[8]],
	repeat: [[2], [-1]],
	replace: [['a', 'x']],
	replaceAll: [['a', 'x'], [/a/, 'x']],
	search: [['b']],
	slice: [[1]],
	split: [['b']],
	startsWith: [['a']],
	substr: [[1]],
	substring: [[1]],
	toLocaleLowerCase: [[]],
	toLocaleUpperCase: [[]],
	toLowerCase: [[]],
	toString: [[]],
	toUpperCase: [[]],
	trim: [[]],
	trimEnd: [[]],
	trimStart: [[]],
	valueOf: [[]],
});
methods(
	'String',
	() => 'abcab',
	{ match: [[/b/g]], matchAll: [[/b/g], [/b/]], replace: [[/a/g, 'x']], replaceAll: [[/a/g, 'x'], [/a/, 'x']], search: [[/b/]], split: [[/b/]] },
	'/regexp',
);
const array = () => [3, 1, 2];
methods('Array', array, {
	at: [[1]],
	concat: [[[4]]],
	entries: [[]],
	every: [[fn]],
	fill: [[0]],
	filter: [[fn]],
	find: [[fn]],
	findIndex: [[fn]],
	findLast: [[fn]],
	findLastIndex: [[fn]],
	flat: [[]],
	flatMap: [[fn]],
	forEach: [[fn]],
	includes: [[1]],
	indexOf: [[1]],
	join: [['-']],
	keys: [[]],
	lastIndexOf: [[1]],
	map: [[fn]],
	pop: [[]],
	push: [[4]],
	reduce: [[(a: number, b: number) => a + b]],
	reduceRight: [[(a: number, b: number) => a + b]],
	reverse: [[]],
	shift: [[]],
	slice: [[1]],
	some: [[fn]],
	sort: [[]],
	splice: [[1, 1]],
	toLocaleString: [[]],
	toReversed: [[]],
	toSorted: [[]],
	toSpliced: [[1, 1]],
	toString: [[]],
	unshift: [[0]],
	values: [[]],
	with: [[0, 9], [9, 9]],
});
const emptyReduce = { self: () => [], probes: [[(a: number, b: number) => a + b]] as Probes };
methods('Number', () => 1.5, { toExponential: [[2], [-1]], toFixed: [[2], [101]], toLocaleString: [[], ['!!']], toPrecision: [[2], [0]], toString: [[16], [1]], valueOf: [[]] });
methods('Promise', () => Promise.resolve(1), { catch: [[fn]], finally: [[() => {}]], then: [[fn]] });
methods('Map', () => new Map([[1, 2]]), { clear: [[]], delete: [[1]], entries: [[]], forEach: [[fn]], get: [[1]], has: [[1]], keys: [[]], set: [[3, 4]], values: [[]] });
methods('Set', () => new Set([1]), { add: [[2]] });

const answers: Record<string, { length: number; result: string; throws: boolean }> = {};
// The console's output (and its warnings for timers never started) is no answer.
const write = { out: process.stdout.write, err: process.stderr.write };
process.stdout.write = process.stderr.write = (() => true) as typeof process.stdout.write;
for (const [name, probes] of Object.entries(PROBES)) {
	const path = name.split('.');
	const owner = path.length > 1 ? (globalThis as Record<string, any>)[path[0]] : globalThis;
	const fn = owner[path.at(-1)!] as (...a: unknown[]) => unknown;
	let result = '';
	let throws = false;
	for (const [k, args] of probes.entries()) {
		try {
			const r = fn.apply(owner, args as unknown[]);
			if (r instanceof Promise) r.catch(() => {});
			if (k === 0) result = typeof r;
		} catch {
			throws = true;
		}
	}
	answers[name] = { length: fn.length, result, throws };
}
for (const [name, m] of Object.entries(METHODS)) {
	const [owner, , method] = name.replace(/\/regexp$/, '').split('.');
	const f = (globalThis as Record<string, any>)[owner].prototype[method] as (...a: unknown[]) => unknown;
	let result = '';
	let throws = false;
	// The reductions throw for an empty array given no initial value.
	const calls = /\.reduce(Right)?$/.test(name) ? [...m.probes.map((p) => [m.self, p] as const), [emptyReduce.self, emptyReduce.probes[0]] as const] : m.probes.map((p) => [m.self, p] as const);
	for (const [k, [self, args]] of calls.entries()) {
		try {
			const r = f.apply(self(), args as unknown[]);
			if (r instanceof Promise) r.catch(() => {});
			if (k === 0) result = typeof r;
		} catch {
			throws = true;
		}
	}
	answers[name] = { length: f.length, result, throws };
}
process.stdout.write = write.out;
process.stderr.write = write.err;
writeFileSync(join(import.meta.dirname, 'js-answers.json'), JSON.stringify({ node: process.version, answers }, null, '\t') + '\n');
console.log(`${Object.keys(answers).length} answers from Node ${process.version}`);
