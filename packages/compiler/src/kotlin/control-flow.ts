// switch (when) and try as Kotlin.
import ts from 'typescript';
import { assignsTo, ident, isNullable, mentions, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { boundNames } from '../semantics/ast.ts';
import { isUntyped, spelledType } from '../semantics/types.ts';

export const controlFlowMethods = {
	/**
	 * A switch as a labeled block: the clause execution starts at is found
	 * first, then each clause runs if it is at or after it (fallthrough), and
	 * `break` leaves the block.
	 */
	switchStatement(this: Translator, s: ts.SwitchStatement): string {
		const i = this.indent;
		const label = this.fresh('switch');
		const subject = this.fresh('__switch');
		const start = this.fresh('__start');
		const clauses = s.caseBlock.clauses;
		const missing = (x: ts.Expression) => x.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(x) && x.text === 'undefined');
		// `case undefined:` on a string or boolean: the subject held nullable, as its missing value reads "undefined" otherwise.
		const nullCase = clauses.some((c) => ts.isCaseClause(c) && missing(c.expression));
		const declared = this.typeOf(s.expression);
		// A subject read converting undefined is switched on as the undefined it is.
		const held = this.library ? null : this.undefinedConverted(this.expr(s.expression));
		const st = (nullCase && ['String', 'Boolean'].includes(declared)) || held ? `${declared}?` : declared;
		const value = held ?? (st === declared ? this.expr(s.expression) : this.coerce(s.expression, st));
		// A subject held nullable only for its `case undefined:` is typed so, as Kotlin would warn of a null label otherwise.
		const plain = this.whenSwitch(s, st, st !== declared && !held ? `val ${subject}: ${st} = ${value}` : value, label);
		if (plain !== null) return plain;
		const lines = [`${i}run ${label}@ {`, `${i}    val ${subject}: ${st} = ${value}`];
		// A case testing what an earlier one tests (`case undefined: case null:`) is never the one chosen: left out.
		const tests = new Map<string, number>();
		clauses.forEach((c, k) => {
			if (!ts.isCaseClause(c)) return;
			// `switch (true) { case a === x && b === y: … }`: the case is one operand of `==`.
			const operand = (code: string) => (ts.isBinaryExpression(ts.skipParentheses(c.expression)) || ts.isConditionalExpression(ts.skipParentheses(c.expression)) ? `(${code})` : code);
			const eq = missing(c.expression) && !isUntyped(spelledType(st)) && isNullable(st) ? `${subject} == null` : missing(c.expression) && st === 'Double' ? `${subject}.isNaN()` : isUntyped(spelledType(st)) || this.isAny(c.expression) || /^[A-Z]\??$/.test(st) ? `${RT.jsStrictEquals}(${subject}, ${this.coerce(c.expression, 'Any?')})` : this.isObjectType(st) ? `${subject} === ${this.expr(c.expression)}` : `${subject} == ${operand(this.coerce(c.expression, st.replace(/\?$/, '')))}`;
			if (!tests.has(eq)) tests.set(eq, k);
		});
		const fallback = clauses.findIndex(ts.isDefaultClause);
		lines.push(`${i}    val ${start} = when {`, ...[...tests].map(([eq, k]) => `${i}        ${eq} -> ${k}`), `${i}        else -> ${fallback >= 0 ? fallback : clauses.length}`, `${i}    }`);
		this.jumps.push({ kind: 'switch', label });
		this.plainBreak++;
		try {
			clauses.forEach((c, k) => {
				if (!c.statements.length) return;
				const body = [...c.statements];
				const last = body.at(-1)!;
				const leaves = ts.isBreakStatement(last) && !last.label;
				if (leaves) body.pop();
				const code = this.nested(() => this.nested(() => this.statements(body)));
				if (leaves && k < clauses.length - 1) code.push(`${i}        return@${label}`);
				if (code.length) lines.push(`${i}    if (${start} <= ${k}) {`, ...code, `${i}    }`);
			});
		} finally {
			this.jumps.pop();
			this.plainBreak--;
		}
		lines.push(`${i}}`);
		return lines.join('\n');
	},

	/**
	 * A switch none of whose clauses falls through to the next (each one with statements ends by leaving the switch or
	 * the function) over a string or number: Kotlin's `when`, whose `==` is JavaScript's `===` for these (`-0.0` matches
	 * `0.0`, NaN matches nothing). Labels are tested in order, as JavaScript tests them, the default last. Null where
	 * the clauses need the jump table.
	 */
	whenSwitch(this: Translator, s: ts.SwitchStatement, st: string, value: string, label: string): string | null {
		if (!['String', 'String?', 'Double', 'Double?'].includes(st)) return null;
		const i = this.indent;
		const clauses = s.caseBlock.clauses;
		const missing = (x: ts.Expression) => x.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(x) && x.text === 'undefined');
		const leaves = (x: ts.Statement): boolean => ts.isBreakStatement(x) || ts.isReturnStatement(x) || ts.isContinueStatement(x) || ts.isThrowStatement(x) || (ts.isBlock(x) && x.statements.length > 0 && leaves(x.statements[x.statements.length - 1]));
		// Each run of clauses ending in one with statements: its labels (null for `default`) and those statements.
		const groups: { labels: (ts.Expression | null)[]; body: ts.Statement[] }[] = [];
		let labels: (ts.Expression | null)[] = [];
		for (const [k, c] of clauses.entries()) {
			labels.push(ts.isCaseClause(c) ? c.expression : null);
			if (!c.statements.length && k < clauses.length - 1) continue;
			const last = c.statements.at(-1);
			if (last && k < clauses.length - 1 && !leaves(last)) return null;
			if (labels.some((x) => x && (missing(x) ? !isNullable(st) : this.isAny(x)))) return null;
			groups.push({ labels, body: c.statements.length === 1 && ts.isBlock(c.statements[0]) ? [...c.statements[0].statements] : [...c.statements] });
			labels = [];
		}
		// Kotlin evaluates no subject of a `when` without branches.
		if (!groups.length) groups.push({ labels: [null], body: [] });
		// Labels beside `default` (`case 'x': default:`) lead to its statements as no label does, unless a later label
		// equal to one would then be chosen in its place: each must be a constant no later label (all constants) equals.
		const dflt = groups.findIndex((g) => g.labels.includes(null));
		if (dflt >= 0 && groups[dflt].labels.length > 1) {
			const key = (x: ts.Expression | null): string | null => {
				if (!x) return null;
				const b = ts.skipParentheses(x);
				const v = ts.isStringLiteralLike(b) ? b.text : ts.isNumericLiteral(b) ? Number(b.text) : ts.isPrefixUnaryExpression(b) && b.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(b.operand) ? -Number(b.operand.text) : ts.isPropertyAccessExpression(b) && (this.resolve(b.expression)?.flags ?? 0) & ts.SymbolFlags.Enum ? ((d) => (d && ts.isEnumMember(d) ? this.checker.getConstantValue(d) : undefined))(this.resolve(b.name)?.valueDeclaration) : undefined;
				return typeof v === 'string' ? `s${v}` : typeof v === 'number' ? `n${v === 0 ? 0 : v}` : null;
			};
			const own = groups[dflt].labels.filter((x) => x !== null).map(key);
			const later = groups
				.slice(dflt + 1)
				.flatMap((g) => g.labels)
				.map(key);
			if (own.some((k) => k === null) || later.some((k) => k === null || own.includes(k))) return null;
			groups[dflt].labels = [null];
		}
		for (const g of groups) {
			const last = g.body.at(-1);
			if (last && ts.isBreakStatement(last) && !last.label) g.body.pop();
		}
		// A `break` left inside a clause (`if (x) break`) leaves the switch: the `when` is a block it returns from.
		const breaks = (n: ts.Node): boolean => !ts.isFunctionLike(n) && !ts.isClassLike(n) && !ts.isIterationStatement(n, false) && !ts.isSwitchStatement(n) && ((ts.isBreakStatement(n) && !n.label) || (ts.forEachChild(n, breaks) ?? false));
		const wrapped = groups.some((g) => g.body.some(breaks));
		const pad = wrapped ? `${i}    ` : i;
		const seen = new Set<string>();
		const lines = [...(wrapped ? [`${i}run ${label}@ {`] : []), `${pad}when (${value}) {`];
		const branches: string[][] = [];
		let fallback: string[] | null = null;
		this.jumps.push({ kind: 'switch', label });
		this.plainBreak++;
		try {
			for (const g of groups) {
				const tests =
					g.labels[0] === null
						? ['else']
						: g.labels
								.map((x) => {
									if (missing(x!)) return 'null';
									const b = ts.skipParentheses(x!);
									const code = this.coerce(x!, st.replace(/\?$/, ''));
									return ts.isBinaryExpression(b) || ts.isConditionalExpression(b) ? `(${code})` : code;
								})
								.filter((t) => !seen.has(t) && !!seen.add(t));
				// A clause whose every label an earlier one tests is never chosen.
				if (!tests.length) continue;
				const body = wrapped ? this.nested(() => this.nested(() => this.nested(() => this.statements(g.body)))) : this.nested(() => this.nested(() => this.statements(g.body)));
				const code = body.filter((l) => l.trim());
				const branch = code.length ? [`${pad}    ${tests.join(', ')} -> {`, ...code, `${pad}    }`] : [`${pad}    ${tests.join(', ')} -> {}`];
				if (tests[0] === 'else') fallback = branch;
				else branches.push(branch);
			}
		} finally {
			this.jumps.pop();
			this.plainBreak--;
		}
		lines.push(...branches.flat(), ...(fallback ?? []), `${pad}}`, ...(wrapped ? [`${i}}`] : []));
		// Kotlin sees past a `when` none of whose branches, the default's included, goes on: what follows is unreachable.
		if (fallback && !wrapped && groups.every((g) => g.body.some((x) => this.exits(x)))) this.endingWhens.add(s);
		return lines.join('\n');
	},

	tryStatement(this: Translator, s: ts.TryStatement): string {
		const i = this.indent;
		let code = `${i}try ${this.block(s.tryBlock)}`;
		if (s.catchClause) {
			const binding = s.catchClause.variableDeclaration;
			const caught = this.fresh('__e');
			const body = this.block(s.catchClause.block);
			const block = s.catchClause.block;
			const names = binding ? boundNames(binding.name) : [];
			const bind = names.some((n) => mentions(body, ident(n.text)))
				? this.nested(() =>
						this.bindTo(
							binding!.name,
							`${RT.jsCaught}(${caught})`,
							'',
							names.some((n) => assignsTo(block, this.checker.getSymbolAtLocation(n), this.checker)),
						),
					) + '\n'
				: '';
			code += ` catch (${caught}: Throwable) {\n${bind}${body.slice(2)}`;
		}
		if (s.finallyBlock) code += ` finally ${this.block(s.finallyBlock)}`;
		return code;
	},
};
