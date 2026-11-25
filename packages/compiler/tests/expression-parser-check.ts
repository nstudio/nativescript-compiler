#!/usr/bin/env node
// Parity check for the compiler's TypeScript binding-expression parser against acorn 8.x:
// every case must produce the identical ESTree structure (positions, raw, regexps, bigints, holes)
// or throw identically.
//   node tests/expression-parser-check.ts
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const parserUrl = pathToFileURL(join(here, '../tools/kit/sources/expression-parser.ts')).href;
const { parseExpressionNode } = (await import(parserUrl)) as { parseExpressionNode: (text: string) => any };
const monorepo = resolve(here, '../../..');
const coreRepo = [process.env.NS_CORE_REPO, monorepo, join(monorepo, 'core'), resolve(monorepo, '../../NativeScript/NativeScript')].find((c): c is string => !!c && existsSync(join(c, 'packages/core/package.json'))) ?? monorepo;
const corePkg = join(coreRepo, 'packages/core/package.json');
const { parse } = createRequire(corePkg)('acorn') as { parse(text: string, options: { ecmaVersion: number }): any };

function acornExpression(text: string): any {
	const program = parse(text, { ecmaVersion: 2020 });
	for (const statement of program.body) {
		if (statement.type === 'ExpressionStatement') {
			return statement.expression;
		}
	}
	return undefined;
}

// acorn nodes are class instances; compare structure, keeping regexps, bigints and holes distinguishable.
function plain(value: any): any {
	if (value === undefined) {
		return { $undefined: true };
	}
	if (value === null || typeof value !== 'object') {
		return typeof value === 'bigint' ? { $bigint: value.toString() } : value;
	}
	if (value instanceof RegExp) {
		return { $regexp: value.source, flags: value.flags };
	}
	if (Array.isArray(value)) {
		const out = [];
		for (let i = 0; i < value.length; i++) {
			out.push(i in value ? plain(value[i]) : { $hole: true });
		}
		return out;
	}
	const out: Record<string, any> = {};
	for (const key of Object.keys(value)) {
		out[key] = plain(value[key]);
	}
	return out;
}

const sameAsAcorn = [
	// binding forms core hands to parseExpression
	"$parents['ListView'].test + 2",
	'$value',
	'$newPropertyValue | converter',
	"date | dateConverter('dd.mm.yyyy')",
	'value | conv.toView | new Upper()',
	"items.length > 0 ? 'some' : 'none'",
	'isLoading || isBusy',
	'`${firstName} ${lastName}`',
	// literals
	'0x1F + 0o17 + 0b101 + 010 + 08 + .5 + 5. + 1e-3',
	'1n + 0x10n',
	`'\\n\\t\\x41\\u0042\\u{1F600}\\101' + "q\\"q"`,
	'null, true, false, this',
	'/[/]+/gi.test(a)',
	'a / b / c',
	'`a${b}c${`${d}`}`',
	'tag`\\unicode`',
	'`\\``',
	// precedence and associativity
	'a + b * c - d / e % f',
	'a ** b ** c',
	'(-a) ** 2',
	'a << b >> c >>> d',
	'a < b <= c in d instanceof e',
	'a == b != c === d !== e',
	'a & b ^ c | d',
	'a && b || c',
	'a ?? (b || c)',
	'a ? b : c ? d : e',
	'!~-+a',
	'typeof void delete a.b',
	'a++ + --b',
	'(a, b), c',
	'(a + b) * c',
	// members, calls, chains
	'a.b[c](d)?.e?.[f]?.(g).h',
	'(a?.b).c',
	'a.class.if?.new',
	'f(...a, b,)',
	'new X',
	'new X.Y(a)(b)',
	'new (f())()',
	// collections
	'[, a, , ...b, ]',
	'({ a, b: 1, "c": 2, 3: d, [e]: f, ...g, if: h, get: i, __proto__: j })',
	// assignment, arrows, patterns
	'a.b += c = d',
	'[a, { b = 1 }, ...c] = d',
	'(x, [y], { z } = {}) => x + y',
	'async x => await x',
	'import(a)',
	// statements and ASI
	';a',
	'a\n(b)',
	'a\n++b',
	'"use strict"; a',
	'a <!-- comment',
	'/* c */ a // c',
];

const rejectedLikeAcorn = ['a +', 'a b', '-a ** 2', 'a ?? b || c', '1_000', '3in x', '08n', "'abc", '`\\x`', '/a/gg', '/(?i:a)/', '(a, a) => 1', 'a?.b = 1', '({ a = 1 })', '"use strict"; 010', '"use strict"; delete a', '\\u0074rue', 'super.x', 'new.target', 'a ||= b', 'return a'];

const unsupported = ['a + function () {}', 'a + class {}', '({ m() {} })', '({ get a() { return 1; } })', 'x => { return x; }', 'if (a) b', 'var a = 1'];

let passed = 0;

for (const text of sameAsAcorn) {
	assert.deepStrictEqual(plain(parseExpressionNode(text)), plain(acornExpression(text)), `mismatch for ${JSON.stringify(text)}`);
	passed++;
}

for (const text of rejectedLikeAcorn) {
	assert.throws(() => acornExpression(text), `acorn did not throw for ${JSON.stringify(text)}`);
	assert.throws(() => parseExpressionNode(text), SyntaxError, `parser did not throw SyntaxError for ${JSON.stringify(text)}`);
	passed++;
}

for (const text of unsupported) {
	assert.doesNotThrow(() => acornExpression(text), `acorn threw for ${JSON.stringify(text)}`);
	assert.throws(() => parseExpressionNode(text), /Unsupported/, `parser did not throw Unsupported for ${JSON.stringify(text)}`);
	passed++;
}

for (const empty of ['{ a: 1 }', 'label: a', ';', '']) {
	assert.equal(parseExpressionNode(empty), undefined, `expected undefined for ${JSON.stringify(empty)}`);
	passed++;
}

const node = parseExpressionNode('value | converter(arg)');
assert.ok(node);
assert.equal(Object.getPrototypeOf(node), Object.prototype);
assert.equal(node.right.arguments.length, 1);
assert.equal(node.right.arguments[0].type, 'Identifier');
assert.equal(node.right.arguments[0].name, 'arg');
passed++;

console.log(`expression-parser: ${passed} checks passed`);
