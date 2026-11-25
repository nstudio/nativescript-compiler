// switch and try as Swift.
import ts from 'typescript';
import { isStringType, optionalType, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { containsJump } from '../semantics/ast.ts';
import { isUntyped, spelledType } from '../semantics/types.ts';
import { refusedFinally } from '../semantics/limits.ts';

export const controlFlowMethods = {
	switchStatement(this: Translator, s: ts.SwitchStatement): string {
		const i = this.indent;
		const subject = this.fresh('__switch');
		// A string, number or boolean that may be undefined (`s[i]` past its end) is matched as the optional it is, so `case undefined` can match.
		const raw = ['String', 'Double', 'Bool'].includes(this.typeOf(s.expression)) ? this.maybeUndefined(s.expression) : null;
		const subjectType = raw ? optionalType(this.typeOf(s.expression)) : this.typeOf(s.expression);
		const subjectCode = `${this.marks.tryBefore(this.tryPrefix(s.expression), raw ?? this.expr(s.expression))}`;
		const clauses = s.caseBlock.clauses;
		if (clauses.every((c) => ts.isDefaultClause(c) && !c.statements.length)) return `${i}_ = ${subjectCode}`;
		const fallback = clauses.findIndex(ts.isDefaultClause);
		if (fallback >= 0 && fallback < clauses.length - 1) return this.switchBlock(s, subject, subjectType, subjectCode);
		const literal = (l: ts.Expression) => ts.isLiteralExpression(l) || (ts.isPrefixUnaryExpression(l) && ts.isNumericLiteral(l.operand));
		// Cases of literals match by pattern, which names no subject: Swift's switch evaluates its own once.
		const direct = !isUntyped(spelledType(subjectType)) && clauses.every((c) => !ts.isCaseClause(c) || literal(c.expression));
		const lines = direct ? [`${i}switch ${subjectCode} {`] : [`${i}let ${subject}: ${subjectType} = ${subjectCode}`, `${i}switch ${subject} {`];
		let labels: ts.Expression[] = [];
		this.plainBreak++;
		this.breakTargets.push(null);
		try {
			clauses.forEach((c, k) => {
				if (ts.isCaseClause(c)) labels.push(c.expression);
				if (!c.statements.length && k < clauses.length - 1) return;
				if (ts.isDefaultClause(c)) {
					if (k < clauses.length - 1) throw this.error(c, 'a default clause before other cases');
					lines.push(`${i}default:`);
				} else if (isUntyped(spelledType(subjectType))) {
					// An untyped subject matches as `===` does.
					lines.push(`${i}case _ where ${labels.some((l) => this.tryPrefix(l)) ? 'try ' : ''}${labels.map((l) => `${RT.jsStrictEquals}(${subject}, ${this.coerce(l, 'Any?')})`).join(' || ')}:`);
				} else if (labels.every(literal)) {
					lines.push(`${i}case ${labels.map((l) => this.expr(l)).join(', ')}:`);
				} else {
					lines.push(`${i}case _ where ${labels.some((l) => this.tryPrefix(l)) ? 'try ' : ''}${labels.map((l) => this.sameAs(subject, this.coerce(l, subjectType), subjectType, s.expression)).join(' || ')}:`);
				}
				labels = [];
				const body = [...c.statements];
				const last = body.at(-1);
				const ends = last && this.endUnreachable(last, true);
				if (last && ts.isBreakStatement(last) && !last.label) body.pop();
				const code = this.nested(() => this.statements(body));
				lines.push(...(code.length ? code : [`${i}    break`]));
				if (!ends && k < clauses.length - 1) lines.push(`${i}    fallthrough`);
			});
		} finally {
			this.plainBreak--;
			this.breakTargets.pop();
		}
		if (!clauses.some(ts.isDefaultClause)) lines.push(`${i}default:`, `${i}    break`);
		lines.push(`${i}}`);
		return lines.join('\n');
	},

	/**
	 * `a === b` of a switch's subject `s`, of Swift type `t`, and a case: strings by their code units, as Swift's `==` equates
	 * canonically equivalent ones; objects by identity, as `===` compares them.
	 */
	sameAs(this: Translator, a: string, b: string, t: string, s: ts.Expression): string {
		return isStringType(t) ? `${RT.jsStringEquals}(${a}, ${b})` : this.isObjectRef(s) ? `${a} === (${b})` : `${a} == (${b})`;
	},

	/**
	 * A switch whose default clause precedes cases, which Swift's switch cannot
	 * say: the clause execution starts at is found first, then each clause runs
	 * if it is at or after it (fallthrough), and `break` leaves the labeled block.
	 */
	switchBlock(this: Translator, s: ts.SwitchStatement, subject: string, subjectType: string, subjectCode: string): string {
		const i = this.indent;
		const label = this.fresh('__switchBlock');
		const start = this.fresh('__start');
		const clauses = s.caseBlock.clauses;
		const lines = [`${i}${label}: do {`, `${i}    let ${subject}: ${subjectType} = ${subjectCode}`, `${i}    var ${start} = ${clauses.findIndex(ts.isDefaultClause)}`];
		const tests = clauses.flatMap((c, k) => {
			if (!ts.isCaseClause(c)) return [];
			const l = c.expression;
			const test = isUntyped(spelledType(subjectType)) || this.isAny(l) ? `${RT.jsStrictEquals}(${subject}, ${this.coerce(l, 'Any?')})` : this.sameAs(subject, this.coerce(l, subjectType), subjectType, s.expression);
			return [`if ${this.tryPrefix(l)}${test} { ${start} = ${k} }`];
		});
		lines.push(`${i}    ${tests.join(' else ')}`);
		this.plainBreak++;
		this.breakTargets.push(label);
		try {
			clauses.forEach((c, k) => {
				if (!c.statements.length) return;
				const code = this.nested(() => this.nested(() => this.statements([...c.statements])));
				// The last clause runs from every start: unconditional, so Swift sees what it returns.
				lines.push(k === clauses.length - 1 ? `${i}    do {` : `${i}    if ${start} <= ${k} {`, ...code, `${i}    }`);
			});
		} finally {
			this.plainBreak--;
			this.breakTargets.pop();
		}
		lines.push(`${i}}`);
		return lines.join('\n');
	},

	/**
	 * Whether the end of a statement is unreachable as Swift sees the code written for it: every
	 * path returns, throws or jumps (`break` too where `breaks`, a switch clause's end). Where unsure, false.
	 */
	endUnreachable(this: Translator, st: ts.Statement, breaks = false): boolean {
		if (ts.isReturnStatement(st) || ts.isThrowStatement(st) || ts.isContinueStatement(st)) return true;
		if (ts.isBreakStatement(st)) return breaks || !!st.label;
		// A call of a function that never returns (Swift's `-> Never`).
		if (ts.isExpressionStatement(st) && ts.isCallExpression(st.expression) && this.typeOf(st.expression) === 'Never') return true;
		if (ts.isBlock(st)) return st.statements.length > 0 && this.endUnreachable(st.statements[st.statements.length - 1], breaks);
		if (ts.isIfStatement(st)) {
			// A condition decided at translation leaves only its live branch.
			const fixed = this.reach?.constant(st.expression) ?? this.staticTypeof(st.expression);
			if (fixed !== undefined) {
				const live = fixed ? st.thenStatement : st.elseStatement;
				return !!live && this.endUnreachable(live, breaks);
			}
			return !!st.elseStatement && this.endUnreachable(st.thenStatement, breaks) && this.endUnreachable(st.elseStatement, breaks);
		}
		if (ts.isTryStatement(st)) {
			if (st.finallyBlock && this.endUnreachable(st.finallyBlock, breaks)) return true;
			// A finally that throws resumes what the try recorded: unconditionally only for a function's last statement the checker finds always returns.
			if (st.finallyBlock && this.throwsInfo.expr(st.finallyBlock) && !this.asyncCtx) {
				const fn = ts.findAncestor(st.parent, ts.isFunctionLike);
				const body = fn && 'body' in fn && fn.body && ts.isBlock(fn.body) ? fn.body : undefined;
				const returns = [st.tryBlock, st.catchClause?.block].some((b) => !!b && containsJump(b, ts.SyntaxKind.ReturnStatement));
				return returns && !this.pendingReturn && body?.statements.at(-1) === st && !(fn!.flags & ts.NodeFlags.HasImplicitReturn);
			}
			const caught = st.catchClause && !this.catchless.has(st.tryBlock);
			return this.endUnreachable(st.tryBlock, breaks) && (!caught || this.endUnreachable(st.catchClause!.block, breaks));
		}
		// Swift's switch, with the default clause written where the source has one, ends where no clause leaves it.
		if (ts.isSwitchStatement(st)) {
			const clauses = st.caseBlock.clauses;
			const fallback = clauses.findIndex(ts.isDefaultClause);
			return fallback >= 0 && fallback === clauses.length - 1 && clauses.every((c, k) => (c.statements.length ? this.endUnreachable(c.statements[c.statements.length - 1]) : k < clauses.length - 1));
		}
		return false;
	},

	tryStatement(this: Translator, s: ts.TryStatement): string {
		const i = this.indent;
		let code: string;
		const block = s.catchClause ? this.block(s.tryBlock) : '';
		// A catch whose try block cannot throw never runs: the block alone.
		if (s.catchClause && !this.throwsInfo.statements([s.tryBlock])) {
			this.catchless.add(s.tryBlock);
			code = this.scope(s.tryBlock);
		} else if (s.catchClause) {
			const binding = s.catchClause.variableDeclaration;
			const bind = binding && (!ts.isIdentifier(binding.name) || this.isRead(binding.name)) ? this.nested(() => this.bindTo(binding.name, `${RT.jsCaught}(error)`, '', true)) + '\n' : '';
			const body = this.block(s.catchClause.block);
			code = `${i}do ${block} catch {\n${bind}${body.slice(2)}`;
		} else code = this.scope(s.tryBlock);
		if (!s.finallyBlock) return code;
		if (refusedFinally(s, this.ledger)) throw this.error(s.finallyBlock, 'return or throw in a finally block', 'finally-jump');
		const fin = this.nested(() => this.block(s.finallyBlock!));
		if (!this.throwsInfo.expr(s.finallyBlock) || this.asyncCtx) {
			const inner = this.nested(() => this.tryStatement(ts.factory.updateTryStatement(s, s.tryBlock, s.catchClause, undefined)));
			return `${i}do {\n${i}    defer ${fin}\n${inner}\n${i}}`;
		}
		// A finally that throws, which a Swift `defer` cannot: the try's completion (an error, a return) is
		// recorded, the finally runs, and the completion is resumed after it, unless the finally throws first.
		const guarded = [s.tryBlock, s.catchClause?.block].filter((b): b is ts.Block => !!b);
		if (!this.ledger.finallyJumps && guarded.some((b) => containsJump(b, ts.SyntaxKind.BreakStatement) || containsJump(b, ts.SyntaxKind.ContinueStatement))) throw this.error(s, 'break or continue in a try whose finally block throws', 'finally-jump');
		const returns = guarded.some((b) => containsJump(b, ts.SyntaxKind.ReturnStatement));
		// The function's last statement, whose end the checker finds unreachable: every completion that gets past the finally is a return.
		const fn = ts.findAncestor(s.parent, ts.isFunctionLike);
		const body = fn && 'body' in fn && fn.body && ts.isBlock(fn.body) ? fn.body : undefined;
		const ends = !!body && body.statements.at(-1) === s && !(fn!.flags & ts.NodeFlags.HasImplicitReturn);
		const saved = this.pendingReturn;
		// Whether a return was recorded is read only where the finally may also be passed without one.
		const label = this.fresh('__try'),
			error = this.fresh('__error'),
			flag = returns && !(ends && !saved) ? this.fresh('__returned') : null;
		const value = this.returnType && this.returnType !== 'Void' ? this.fresh('__value') : null;
		this.pendingReturn = { label, flag, value };
		let inner: string;
		try {
			inner = this.nested(() => this.nested(() => this.tryStatement(ts.factory.updateTryStatement(s, s.tryBlock, s.catchClause, undefined))));
		} finally {
			this.pendingReturn = saved;
		}
		// Inside another such try, the return goes on to that one's finally.
		const resume = this.resumedReturn(value, saved);
		return [`${i}do {`, `${i}    var ${error}: Error? = nil`, ...(flag ? [`${i}    var ${flag} = false`] : []), ...(returns && value ? [`${i}    var ${value}: ${optionalType(this.returnType)} = nil`] : []), `${i}    ${label}: do {`, inner, `${i}    } catch {`, `${i}        ${error} = error`, `${i}    }`, `${i}    do ${fin.trimStart()}`, `${i}    if let ${error} { throw ${error} }`, ...(returns ? [flag ? `${i}    if ${flag} { ${resume} }` : `${i}    ${resume}`] : []), `${i}}`].join('\n');
	},
};
