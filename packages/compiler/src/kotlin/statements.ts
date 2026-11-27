// Statements as Kotlin: declarations, bindings, patterns, loops and returns.
import ts from 'typescript';
import { atLossSite, HELD_LOSS } from '../semantics/losses.ts';
import { place, returnCell, type ResultSlot, type ReturnCell } from '../semantics/placement.ts';
import { TYPED_ARRAYS } from '../semantics/globals.ts';
import { assignsTo, breaksOut, ident, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { containsJump } from '../semantics/ast.ts';
import { isPromiseType } from '../semantics/spelled.ts';

export const statementsMethods = {
	statements(this: Translator, list: ts.Statement[]): string[] {
		const hoisted: ts.Statement[] = this.hoistedFunctions(list);
		// What follows a statement that never completes never runs: left out, as Kotlin would flag it.
		const end = list.findIndex((s) => this.exits(s));
		const live = end < 0 ? list : list.slice(0, end + 1);
		return [...this.scopedVars(list), ...this.forwardDeclarations(list), ...[...hoisted, ...live.filter((s) => !hoisted.includes(s))].map((s) => this.stmt(s)).filter(Boolean)];
	},

	/**
	 * A function's `var`s declared in an inner block (a loop's head, a branch) and used or declared again outside it:
	 * declared at the top of the function body, as JavaScript hoists them, and assigned where they are declared.
	 */
	scopedVars(this: Translator, list: ts.Statement[]): string[] {
		const body = list[0]?.parent;
		if (!body || !ts.isBlock(body) || !ts.isFunctionLike(body.parent)) return [];
		const scope = (n: ts.Node) => ts.findAncestor(n.parent, (a) => ts.isBlock(a) || ts.isIterationStatement(a, false) || ts.isCaseBlock(a) || ts.isCatchClause(a) || ts.isFunctionLike(a))!;
		const decls = new Map<ts.Symbol, ts.VariableDeclaration[]>();
		const refs = new Map<ts.Symbol, ts.Identifier[]>();
		const collect = (n: ts.Node): void => {
			if (ts.isVariableDeclarationList(n) && !(n.flags & ts.NodeFlags.BlockScoped) && !ts.isForInStatement(n.parent) && !ts.isForOfStatement(n.parent)) {
				for (const d of n.declarations) {
					const sym = ts.isIdentifier(d.name) ? this.checker.getSymbolAtLocation(d.name) : undefined;
					if (sym && !ts.isFunctionLike(scope(d))) decls.set(sym, [...(decls.get(sym) ?? []), d]);
				}
			}
			if (!ts.isFunctionLike(n)) ts.forEachChild(n, collect);
		};
		const collectRefs = (n: ts.Node): void => {
			const sym = ts.isIdentifier(n) ? this.checker.getSymbolAtLocation(n) : undefined;
			if (sym && decls.has(sym)) refs.set(sym, [...(refs.get(sym) ?? []), n as ts.Identifier]);
			ts.forEachChild(n, collectRefs);
		};
		list.forEach(collect);
		if (!decls.size) return [];
		list.forEach(collectRefs);
		const out: string[] = [];
		for (const [sym, ds] of decls) {
			// Declared in a for-in or for-of head too: Kotlin's loop declares its own.
			if (sym.declarations?.some((d) => ts.isVariableDeclaration(d) && (ts.isForInStatement(d.parent.parent) || ts.isForOfStatement(d.parent.parent)))) continue;
			const inner = ds.filter((d) => scope(d) !== body);
			const escapes = inner.some((d) => (refs.get(sym) ?? []).some((r) => !ts.findAncestor(r, (a) => a === scope(d))));
			if (!escapes) continue;
			for (const d of sym.declarations ?? []) if (ts.isVariableDeclaration(d)) this.scopedDeclared.add(d);
			out.push(`${this.indent}${this.deferredDeclaration(ident((ds[0].name as ts.Identifier).text), this.typeOf(ds[0].name))}`);
		}
		return out;
	},

	/** Whether a statement never completes normally (it returns, throws or calls what never returns), as Kotlin's flow analysis finds. */
	exits(this: Translator, s: ts.Statement): boolean {
		if (ts.isReturnStatement(s) || ts.isThrowStatement(s)) return true;
		if (ts.isExpressionStatement(s)) return ts.isCallExpression(s.expression) && this.typeOf(s.expression) === 'Nothing';
		if (ts.isBlock(s)) return s.statements.some((x) => this.exits(x));
		if (ts.isIfStatement(s)) {
			const fixed = this.staticTruth(s.expression);
			if (fixed !== undefined) {
				const live = fixed ? s.thenStatement : s.elseStatement;
				return !!live && this.exits(live);
			}
			return !!s.elseStatement && this.exits(s.thenStatement) && this.exits(s.elseStatement);
		}
		if (ts.isSwitchStatement(s)) return this.endingWhens.has(s);
		if (ts.isTryStatement(s)) return (!!s.finallyBlock && this.exits(s.finallyBlock)) || (this.exits(s.tryBlock) && (!s.catchClause || this.exits(s.catchClause.block)));
		// A loop whose condition always holds, left by no `break`.
		if ((ts.isWhileStatement(s) || ts.isDoStatement(s)) && this.staticTruth(s.expression) === true) return !breaksOut(s);
		if (ts.isForStatement(s) && (!s.condition || this.staticTruth(s.condition) === true)) return !breaksOut(s);
		return false;
	},

	/** The variables of a list that a function declared before them reads, declared up front (see `forwardDeclared`). */
	forwardDeclarations(this: Translator, list: ts.Statement[]): string[] {
		const hoisted: ts.Statement[] = this.hoistedFunctions(list);
		const forward: string[] = [];
		list.forEach((st, k) => {
			if (!ts.isVariableStatement(st)) return;
			// A `var` is its function's from the start (hoisted), undefined until its declaration runs.
			const isVar = !(st.declarationList.flags & ts.NodeFlags.BlockScoped);
			for (const d of st.declarationList.declarations) {
				if (!ts.isIdentifier(d.name) || !d.initializer || this.scopedDeclared.has(d)) continue;
				const sym = this.checker.getSymbolAtLocation(d.name);
				const hoistedVar = isVar && (sym?.declarations?.length ?? 0) < 2;
				let early = false,
					read = false;
				const visit = (n: ts.Node, inFn: boolean) => {
					if (early) return;
					if ((inFn || hoistedVar) && ts.isIdentifier(n) && n !== d.name && this.checker.getSymbolAtLocation(n) === sym) {
						early = true;
						read = !inFn;
						return;
					}
					ts.forEachChild(n, (c) => visit(c, inFn || ts.isFunctionLike(c)));
				};
				list.forEach((other, j) => {
					if (j < k || hoisted.includes(other)) visit(other, ts.isFunctionLike(other));
				});
				if (!early) continue;
				this.forwardDeclared.add(d);
				const t = this.typeOf(d.name);
				// Read before it is set: undefined, which a number reads as NaN.
				forward.push(`${this.indent}${read && t === 'Double' ? `var ${ident(d.name.text)}: Double = Double.NaN` : this.deferredDeclaration(ident(d.name.text), t)}`);
			}
		});
		return forward;
	},

	/* block is installed from semantics/lowering-methods.ts */

	stmt(this: Translator, s: ts.Statement): string {
		let code: string;
		const at = this.translating;
		this.translating = s;
		try {
			code = HELD_LOSS ? atLossSite('kotlin', this, s, () => this.statementCode(s)) : this.statementCode(s);
		} catch (e) {
			const located = this.located(e, s);
			if (!this.errors) throw located;
			this.errors.push((located as Error).message ?? String(located));
			return '';
		} finally {
			this.translating = at;
		}
		// The statement's own `return`s, at its indent; an anonymous function's inside it (deeper) return from that function.
		if (this.lambdaReturn && ts.isReturnStatement(s)) {
			const at = /^[ \t]*/.exec(code)![0];
			code = code.replace(/(^|\n)([ \t]*)return\b(?!@)/g, (m, start: string, pad: string) => (pad === at ? `${start}${pad}return@${this.lambdaReturn}` : m));
		}
		// A block's statements in place carry their own lines.
		return code && this.lines && !code.startsWith('/*@ns:') ? this.lines.mark(s) + code : code;
	},

	statementCode(this: Translator, s: ts.Statement): string {
		const i = this.indent;
		const a = this.asyncCtx;
		if (ts.isExpressionStatement(s)) {
			const code = this.exprStatement(s.expression);
			const note = this.keyNotes?.get(s);
			if (note)
				return [note.before, code, note.after]
					.filter(Boolean)
					.map((l) => i + l)
					.join('\n');
			// A call is evaluated even when its value is unused: a signal's or computed's read runs it and subscribes.
			const called = ts.isCallExpression(ts.skipOuterExpressions(s.expression)) && !/^(Unit|true|false|null)$/.test(code);
			return this.marks.isPure(code) && !called ? '' : i + code;
		}
		if (ts.isReturnStatement(s)) {
			const slot = this.resultSlot(s);
			return this.returned(returnCell(this.returns, s.expression, slot), slot);
		}
		if (ts.isIfStatement(s)) {
			// A condition the parameters' constant values decide: only the branch that runs.
			const fixed = this.staticTruth(s.expression);
			if (fixed !== undefined) {
				const live = fixed ? s.thenStatement : s.elseStatement;
				if (!live) return '';
				// A branch declaring nothing runs in the enclosing scope; one declaring names keeps a scope of its own.
				const scoped = (ts.isBlock(live) ? live.statements : [live]).some((x) => ts.isVariableStatement(x) || ts.isFunctionDeclaration(x) || ts.isClassDeclaration(x));
				return scoped ? `${i}run ${this.block(live)}` : this.statements(ts.isBlock(live) ? [...live.statements] : [live]).join('\n');
			}
			let out = `${i}if (${this.cond(s.expression)}) ${this.block(s.thenStatement)}`;
			// An `else if` the types decide is its live branch, or nothing.
			let other: ts.Statement | undefined = s.elseStatement;
			while (other && ts.isIfStatement(other) && this.staticTruth(other.expression) !== undefined) other = this.staticTruth(other.expression) ? other.thenStatement : other.elseStatement;
			if (other) out += ts.isIfStatement(other) ? ` else ${this.stmt(other).trimStart()}` : ` else ${this.block(other)}`;
			return out;
		}
		if (ts.isVariableStatement(s)) return this.declarationList(s.declarationList, false);
		if (ts.isFunctionDeclaration(s)) {
			if (!s.name || !s.body) return '';
			return i + this.func(s, ident(s.name.text));
		}
		if (ts.isForOfStatement(s)) {
			if (s.awaitModifier) throw this.error(s, 'for await');
			const list = s.initializer;
			if (!ts.isVariableDeclarationList(list)) return this.forOfExisting(s, list);
			const decl = list.declarations[0];
			const mutable = !(list.flags & ts.NodeFlags.Const);
			// Declared before the body is translated: its reads take the binding as it holds it.
			for (const n of ts.isIdentifier(decl.name) ? [decl.name] : decl.name.elements.flatMap((el) => (ts.isBindingElement(el) && ts.isIdentifier(el.name) ? [el.name] : []))) {
				if (this.states.optionalBinding(n)) this.bindsOptional(n, this.typeOf(n));
			}
			if (this.forOfSteps(s.expression)) return this.steppedLoop(s);
			const seq = this.iterable(s.expression);
			const indexed = this.typeOf(s.expression);
			const typedArray = new RegExp(`^JS(${TYPED_ARRAYS.join('|')})$`).test(indexed);
			// A typed array is read by index up to its live length (an Iterator object per loop is garbage on hot paths); a
			// JSArray's own iterator, which `for (x in a)` takes, reads so as well.
			if (typedArray) {
				return this.loopBody(() => {
					const label = this.takeLabel();
					const array = this.fresh('__a');
					const k = this.fresh('__k');
					const read = `${array}[${k}++]`;
					const body = this.block(s.statement);
					const simple = ts.isIdentifier(decl.name) && !mutable;
					const item = simple ? '' : this.fresh('__item');
					const bind = simple ? `${i}    val ${ident((decl.name as ts.Identifier).text)} = ${read}` : `${i}    val ${item} = ${read}\n${this.nested(() => this.bindTo(decl.name, item, '', mutable))}`;
					return `${i}val ${array} = ${seq}\n${i}var ${k} = 0\n${i}${label}while (${k} < ${array}.jsLength) {\n${bind}\n${body.slice(2)}`;
				});
			}
			return this.loopBody(() => {
				const label = this.takeLabel();
				if (ts.isIdentifier(decl.name) && !mutable) return `${i}${label}for (${ident(decl.name.text)} in ${seq}) ${this.block(s.statement)}`;
				const item = this.fresh('__item');
				const body = this.block(s.statement);
				return `${i}${label}for (${item} in ${seq}) {\n${this.nested(() => this.bindTo(decl.name, item, '', mutable))}\n${body.slice(2)}`;
			});
		}
		if (ts.isForInStatement(s)) {
			if (!ts.isVariableDeclarationList(s.initializer)) {
				const k = this.fresh('__key');
				const assigns = this.assignIterated(s.initializer, k, this.checker.getStringType(), s.expression);
				return this.loopBody(() => {
					const label = this.takeLabel();
					const body = this.block(s.statement);
					return `${i}${label}for (${k} in ${RT.jsKeysOf}(${this.expr(s.expression)})) {\n${assigns.map((a) => `${i}    ${a}`).join('\n')}\n${body.slice(2)}`;
				});
			}
			const list = s.initializer;
			const name = ident((list.declarations[0].name as ts.Identifier).text);
			if (!assignsTo(s.statement, this.checker.getSymbolAtLocation(list.declarations[0].name), this.checker)) return this.loopBody(() => `${i}${this.takeLabel()}for (${name} in ${RT.jsKeysOf}(${this.expr(s.expression)})) ${this.block(s.statement)}`);
			// A key the body reassigns: a variable of each key (Kotlin's loop variable is a val).
			return this.loopBody(() => {
				const label = this.takeLabel();
				const key = this.fresh('__key');
				const body = this.block(s.statement);
				return `${i}${label}for (${key} in ${RT.jsKeysOf}(${this.expr(s.expression)})) {\n${this.nested(() => this.bindTo(list.declarations[0].name, key, '', true))}\n${body.slice(2)}`;
			});
		}
		if (ts.isForStatement(s)) return this.forStatement(s);
		if (ts.isWhileStatement(s)) return this.loopBody(() => `${i}${this.takeLabel()}while (${this.cond(s.expression)}) ${this.block(s.statement)}`);
		if (ts.isDoStatement(s)) {
			return this.loopBody(() => {
				const label = this.takeLabel();
				if (containsJump(s.statement, ts.SyntaxKind.ContinueStatement)) {
					// `continue` in a do-while goes to its condition: the body is a block that `continue` leaves.
					const inner = this.fresh('body');
					(this.jumps.at(-1) as { continueLabel?: string }).continueLabel = inner;
					return `${i}${label}do {\n${i}    ${inner}@ do ${this.nested(() => this.block(s.statement))} while (false)\n${i}} while (${this.cond(s.expression)})`;
				}
				return `${i}${label}do ${this.block(s.statement)} while (${this.cond(s.expression)})`;
			});
		}
		if (ts.isBreakStatement(s) || ts.isContinueStatement(s)) {
			const isBreak = ts.isBreakStatement(s);
			if (s.label && isBreak && this.blockLabels.has(s.label.text)) return `${i}return@${s.label.text}`;
			if (s.label) return `${i}${isBreak ? 'break' : 'continue'}@${s.label.text}`;
			if (a && (isBreak ? a.brk && !this.plainBreak : a.cont && !this.plainContinue)) return `${i}${isBreak ? a.brk : a.cont}\n${i}return`;
			const top = this.jumps.at(-1);
			if (isBreak && top?.kind === 'switch') return `${i}return@${top.label}`;
			if (!isBreak) {
				const loop = [...this.jumps].reverse().find((j) => j.kind === 'loop') as { continueLabel?: string } | undefined;
				if (loop?.continueLabel) return `${i}break@${loop.continueLabel}`;
			}
			return i + (isBreak ? 'break' : 'continue');
		}
		// A block declaring nothing needs no scope of its own: its statements, in place.
		if (ts.isBlock(s) && !s.statements.some((x) => ts.isVariableStatement(x) || ts.isFunctionDeclaration(x) || ts.isClassDeclaration(x))) return this.statements([...s.statements]).join('\n');
		if (ts.isBlock(s)) return `${i}run ${this.block(s)}`;
		if (ts.isEmptyStatement(s)) return '';
		if (ts.isSwitchStatement(s)) return this.switchStatement(s);
		if (ts.isThrowStatement(s)) return `${i}throw JSException(${this.coerce(s.expression, 'Any?')})`;
		if (ts.isTryStatement(s)) return this.tryStatement(s);
		if (ts.isLabeledStatement(s)) {
			if (this.asyncCtx) throw this.error(s, 'a labeled statement in an async function');
			if (!ts.isIterationStatement(s.statement, false)) {
				// A labeled block, `if` or `switch` is a labeled lambda that `break label` returns from.
				const label = s.label.text;
				this.blockLabels.add(label);
				try {
					return `${i}run ${label}@ {\n${this.nested(() => this.stmt(s.statement))}\n${i}}`;
				} finally {
					this.blockLabels.delete(label);
				}
			}
			this.label = s.label.text;
			return this.stmt(s.statement);
		}
		if (ts.isClassDeclaration(s) || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) {
			if (ts.isClassDeclaration(s) && this.capturesNothing(s)) {
				// Core's and plugins' lazily defined classes (`@NativeClass class Impl extends android.…` inside `initializeX()`): declared once, at the top level.
				const saved = this.indent;
				try {
					this.hoisted.push(this.classDecl(s));
				} finally {
					this.indent = saved;
				}
				return '';
			}
			// Library mode: one reading the function's locals (`RoleTypeMap`) is Kotlin's local class, which captures them.
			if (ts.isClassDeclaration(s) && this.library) {
				const saved = this.indent;
				try {
					return this.classDecl(s)
						.split('\n')
						.map((l) => saved + l)
						.join('\n');
				} finally {
					this.indent = saved;
				}
			}
			if (ts.isClassDeclaration(s)) throw this.error(s, `a class declared inside a function${this.captured.has(s) ? ` (reading its ${this.captured.get(s)})` : ''}`);
			return '';
		}
		throw this.error(s, 'statement');
	},

	tryPrefix(this: Translator, _e: ts.Node): string {
		return '';
	},

	/** A `return` statement's cell, as Kotlin writes it. */
	returned(this: Translator, cell: ReturnCell, slot: ResultSlot): string {
		const i = this.indent,
			a = this.asyncCtx;
		switch (cell.step) {
			case 'empty':
				return a ? `${i}${a.ret(null, false)}\n${i}return` : cell.code ? `${i}return ${cell.code}` : this.returnLabel ? `${i}return@${this.returnLabel}` : `${i}return`;
			case 'drop': {
				const code = this.exprStatement(cell.e);
				return this.marks.isPure(code) ? `${i}return` : `${i}${code}\n${i}return`;
			}
			case 'never':
				return `${i}${this.exprStatement(cell.e)}`;
			case 'voidCall':
				return `${i}${this.exprStatement(cell.e)}\n${i}return ${cell.empty}`;
		}
		const e = cell.e;
		if (cell.code !== undefined) return `${i}return ${cell.code}`;
		if (a) {
			if (a.generator === 'async') return `${i}${this.lowering.returnIn(a, e)}\n${i}return`;
			return `${i}${a.ret(...this.loweredReturn(e, slot))}\n${i}return`;
		}
		return `${i}return ${place(this.placement, e, slot)}`;
	},

	loweredReturn(this: Translator, e: ts.Expression, slot: ResultSlot): [string, boolean] {
		const isPromise = isPromiseType(this.nativeOf(e));
		return [isPromise ? this.expr(e) : place(this.placement, e, slot), isPromise];
	},

	/** An expression body's cell, as Kotlin writes it. */
	bodyReturned(this: Translator, cell: ReturnCell, slot: ResultSlot): string {
		const i = this.indent,
			back = this.returnKeyword();
		switch (cell.step) {
			case 'empty':
			case 'drop':
				return i + this.exprStatement(cell.e!);
			case 'voidCall':
				return `${i}${this.exprStatement(cell.e)}\n${i}${back} ${cell.empty}`;
			case 'never':
				throw new Error('unreachable: an expression body never ends the function by its call');
		}
		return `${i}${back} ${cell.code ?? place(this.placement, cell.e, slot)}`;
	},
};
