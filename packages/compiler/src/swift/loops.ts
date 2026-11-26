// Loops as Swift: stepped loops, labels, loop bodies, iteration and for statements.
import ts from 'typescript';
import { ident, isOptional, optionalType, splitTopLevel, swiftString, RT } from './syntax.ts';
import type { ClosingLoop, PendingReturn, Translator } from './translator.ts';
import { iteratesCheckedResult, redeclaredBeside } from '../semantics/lang.ts';
import { capturedIn, continuesTo, containsJump, notIterable } from '../semantics/ast.ts';
import { isBuiltinIterable } from '../semantics/classes.ts';
import { isKit, isUntyped, spelledType } from '../semantics/types.ts';

export const loopsMethods = {
	/** Whether a declaration refers to anything a function around it declares. */
	capturesLocals(this: Translator, decl: ts.Node): boolean {
		let found = false;
		const visit = (n: ts.Node) => {
			if (found) return;
			if (ts.isIdentifier(n)) {
				const d = this.resolve(n)?.declarations?.[0];
				if (d && d.getSourceFile() === decl.getSourceFile() && !(d.pos >= decl.pos && d.end <= decl.end) && ts.findAncestor(d, (x) => ts.isFunctionLike(x) && x.pos <= decl.pos && x.end >= decl.end)) found = true;
			}
			ts.forEachChild(n, visit);
		};
		visit(decl);
		return found;
	},
	/**
	 * A `for…of` stepping through its value's iterator (`forOfSteps`). A throw leaving it closes the iterator in a catch
	 * that rethrows; every other exit leaves the loop (a `return` recorded as a try whose finally throws records it, a
	 * labeled jump past it in `closingLoops`) and the iterator is closed after it, then the exit is made; a return in a
	 * lowered function closes it first (`withClosingReturns`). No
	 * `defer`: Swift checks a `defer` in a closure a stored property's initializer holds as nonisolated, and the
	 * iterator's methods are main-actor isolated.
	 */
	steppedLoop(this: Translator, s: ts.ForOfStatement): string {
		const i = this.indent;
		const list = s.initializer;
		const item = ts.isVariableDeclarationList(list) ? null : this.fresh('__item');
		const lines = item ? this.assignIterated(list as ts.Expression, item, null, s.expression) : [];
		const iterator = `try ${this.iteratorCode(s.expression)}`;
		const it = this.fresh('__it');
		const bind = () => {
			if (!ts.isVariableDeclarationList(list)) return [`let ${item}: Any? = ${it}.jsCurrent`, ...lines].map((l) => this.indent + l).join('\n');
			const untyped = /^Any\??$/.test(this.typeOf(s.expression)) ? 'Any?' : '';
			return this.bindTo(list.declarations[0].name, `${it}.jsCurrent`, untyped, !(list.flags & ts.NodeFlags.Const));
		};
		return this.loopBody(() => {
			const own = this.takeLabel();
			const returns = !this.asyncCtx && containsJump(s.statement, ts.SyntaxKind.ReturnStatement);
			const loop: ClosingLoop = { node: s, label: own ? own.slice(0, -2) : returns ? this.fresh('__for') : '', jump: '', exits: [] };
			const flag = returns ? this.fresh('__returned') : null;
			const value = returns && this.returnType && this.returnType !== 'Void' ? this.fresh('__value') : null;
			const saved = this.pendingReturn;
			if (returns) this.pendingReturn = { label: loop.label, flag, value };
			this.closingLoops.push(loop);
			let bound: string, body: string;
			try {
				// The binding first: how it declares each name (an element past the end as optional) is how the body reads it.
				bound = this.nested(() => this.nested(() => this.nested(bind)));
				body = this.withClosingReturns(it, () => this.nested(() => this.nested(() => this.block(s.statement))));
			} finally {
				this.pendingReturn = saved;
				this.closingLoops.pop();
			}
			const exits = loop.exits.map((exit, k) => `${i}    if ${loop.jump} == ${k + 1} { ${this.labeledJump(exit)} }`);
			return [
				`${i}do {`,
				`${i}    let ${it} = ${iterator}`,
				...(flag ? [`${i}    var ${flag} = false`] : []),
				...(value ? [`${i}    var ${value}: ${optionalType(this.returnType)} = nil`] : []),
				...(exits.length ? [`${i}    var ${loop.jump} = 0`] : []),
				`${i}    do {`,
				`${i}        ${loop.label ? `${loop.label}: ` : ''}while try ${it}.jsAdvance() {`,
				bound,
				`${i}            do ${body}`,
				`${i}        }`,
				`${i}    } catch {`,
				`${i}        ${this.syntax.closeIterator(it)}`,
				`${i}        throw error`,
				`${i}    }`,
				`${i}    ${this.syntax.closeIteratorChecked(it)}`,
				...(flag ? [`${i}    if ${flag} { ${this.resumedReturn(value, saved)} }`] : []),
				...exits,
				`${i}}`,
			].join('\n');
		});
	},

	/** `break label` or `continue label`; one leaving a stepped loop (`closingLoops`) leaves the innermost such loop first. */
	labeledJump(this: Translator, s: ts.BreakOrContinueStatement): string {
		const name = s.label!.text;
		const code = `${ts.isBreakStatement(s) ? 'break' : 'continue'} ${ident(name)}`;
		const target = ts.findAncestor(s.parent, (n) => ts.isLabeledStatement(n) && n.label.text === name) as ts.LabeledStatement | undefined;
		const loop = target && this.closingLoops.findLast((l) => l.node !== target.statement && !!ts.findAncestor(l.node.parent, (n) => n === target.statement));
		if (!loop) return code;
		let k = loop.exits.findIndex((x) => x.kind === s.kind && x.label!.text === name);
		if (k < 0) k = loop.exits.push(s) - 1;
		loop.label ||= this.fresh('__for');
		loop.jump ||= this.fresh('__jump');
		return `${loop.jump} = ${k + 1}; break ${loop.label}`;
	},

	/** A recorded return made once its try's finally or its loop's close has run: recorded in turn by `saved`, or made. */
	resumedReturn(this: Translator, value: string | null, saved: PendingReturn | null): string {
		const made = value ? this.marks.unwrappedIf(value, !isOptional(this.returnType)) : '';
		return saved ? `${saved.value && value ? `${saved.value} = ${made}; ` : ''}${saved.flag ? `${saved.flag} = true; ` : ''}break ${saved.label}` : `return${made ? ` ${made}` : ''}`;
	},

	takeLabel(this: Translator): string {
		const l = this.label;
		this.label = null;
		return l ? `${l}: ` : '';
	},

	loopBody(this: Translator, body: () => string): string {
		this.plainBreak++;
		this.plainContinue++;
		this.breakTargets.push(null);
		try {
			return body();
		} finally {
			this.plainBreak--;
			this.plainContinue--;
			this.breakTargets.pop();
		}
	},

	/** What `for…of` iterates in Swift: arrays, sets and iterators as they are, a map's entries, a string's code points. */
	iterable(this: Translator, e: ts.Expression): string {
		// A Foundation collection Swift bridges (`NSArray` as `[Any]`): its elements, as the runtime iterates them.
		if (/^\[[^:]*\][?!]?$/.test(this.typeOf(e))) return /[?!]$/.test(this.typeOf(e)) ? `(${this.expr(e)} ?? [])` : this.expr(e);
		const js = this.jsIteration(e);
		if (js) return `${js}.jsCollect()`;
		const t = this.typeOf(e);
		// A tuple (`['a', 'b'] as const`) iterates its elements.
		if (t.startsWith('(') && this.checker.isTupleType(this.checker.getTypeAtLocation(e))) {
			const n = this.checker.getTypeArguments(this.checker.getTypeAtLocation(e) as ts.TypeReference).length;
			const el = splitTopLevel(t.slice(1, -1));
			const element = el.every((x) => x === el[0]) ? el[0] : 'Any?';
			return `({ (__t: ${t}) -> [${element}] in [${Array.from({ length: n }, (_, k) => `__t.${k}`).join(', ')}] }(${this.expr(e)}))`;
		}
		if (t === 'String') return `${RT.jsCodePoints}(${this.expr(e)})`;
		// An untyped value iterates as script would: an array's elements, an iterable's values.
		if (isUntyped(spelledType(t))) return `${RT.jsIteratorOf}(${this.expr(e)}).jsCollect()`;
		const code = this.expr(e);
		if (isKit(spelledType(t), 'JSMap')) return `${code}.entries()`;
		if (t === 'JSMatch') return `${code}.values`;
		return code;
	},

	resumedValue(this: Translator, code: string, type: string): string {
		return ['String', 'Double', 'Bool'].includes(type) ? this.undefinedAs(this.marks.castCode(code, type, 'as?'), type) : this.fromAnyCode(code, type, true);
	},

	/** `e[Symbol.iterator]()`: an iterator over any iterable; `called`, the script's own call of it, whose untyped result is the method's. */
	iteratorCode(this: Translator, e: ts.Expression, called = false, message?: string): string {
		const t = this.typeOf(e).replace(/[?!]$/, '');
		const code = this.expr(e);
		// Lenient code holds a generator a method returns implicitly unwrapped (`this.values()`): the generator itself.
		if (/^JS(Iterator|Generator)</.test(t)) {
			const decl = ts.isCallExpression(e) ? this.checker.getResolvedSignature(e)?.getDeclaration() : undefined;
			const own = !!decl && !ts.isJSDocSignature(decl) && !decl.getSourceFile().isDeclarationFile && (ts.isMethodDeclaration(decl) || ts.isFunctionDeclaration(decl)) && !!decl.body;
			return own && this.lenient && this.lenientRef(t) !== t ? `${RT.jsIterated}(${code}, ${swiftString(notIterable(e))})` : code;
		}
		// A match's groups; one that matched nothing is undefined, read as the string TypeScript types it.
		if (t === 'JSMatch') return this.elementTypeOf(e) === 'String' && !this.unsetMatch(e) ? `${RT.jsIterator}(${code}.values.map { (s: String?) in s ?? "" })` : `${RT.jsIterator}(${code}.values)`;
		if (isKit(spelledType(t), 'JSIterable')) return `${code}.jsIterator()`;
		if (isUntyped(spelledType(t)) || t === 'Any') return `${called ? RT.jsCallSymbolIterator : RT.jsIteratorOf}(${code}${message ? `, ${swiftString(message)}` : ''})`;
		if (isBuiltinIterable(t, e, this.checker)) return `${RT.jsIterator}(${code})`;
		// A `[Symbol.iterator]()` giving other than an iterator class: its result checked as the class's `jsAnyIterator` checks it.
		if (iteratesCheckedResult(e, this.checker, (m) => this.returnTypeOf(m))) return `JSIteratorAdapter<${this.elementTypeOf(e)}>(try ${code}.jsAnyIterator())`;
		return `JSIteratorAdapter<${this.elementTypeOf(e)}>(${code}.jsSymbolIterator())`;
	},

	/** GetIterator(e, async), for `for await`: an async iterable's own iterator, or a sync one's adapted. */
	asyncIteration(this: Translator, e: ts.Expression): string {
		const t = this.typeOf(e).replace(/[?!]$/, '');
		const code = this.expr(e);
		// A module's variable is implicitly unwrapped (its initializer sets it): read as its type, as a `let` would hold its optional.
		const d = ts.isIdentifier(e) ? this.resolve(e)?.valueDeclaration : undefined;
		const moduleVar = !!d && ts.isVariableDeclaration(d) && ts.isSourceFile(d.parent.parent.parent) && !this.typeOf(e).endsWith('?');
		if (/^JS(AsyncIterator|AsyncGenerator)</.test(t)) return moduleVar ? `(${code} as ${t})` : code;
		if (isKit(spelledType(t), 'JSAsyncIterable')) return `${code}.jsAsyncIterator()`;
		if (isUntyped(spelledType(t)) || t === 'Any') return `${RT.jsAsyncIteratorOf}(${code})`;
		const el = this.elementTypeOf(e);
		if (
			this.checker
				.getTypeAtLocation(e)
				.getProperties()
				.some((p) => p.escapedName.toString().startsWith('__@asyncIterator@'))
		)
			return `JSAsyncIteratorAdapter<${el}>(${code}.jsSymbolAsyncIterator())`;
		return `JSAsyncFromSyncIterator<${el}>(${this.iteratorCode(e)})`;
	},

	/** The iterator `yield*` delegates to. */
	delegateIteration(this: Translator, e: ts.Expression, isAsync: boolean): string {
		return this.marks.tryCode(`${isAsync ? this.asyncIteration(e) : this.iteratorCode(e)}`);
	},

	forStatement(this: Translator, s: ts.ForStatement, scoped = false): string {
		const i = this.indent;
		const list = s.initializer && ts.isVariableDeclarationList(s.initializer) ? s.initializer : null;
		// A `let` loop variable is the loop's own: a sibling declaring the same name needs the loop in a scope of its own.
		if (!scoped && list && list.flags & ts.NodeFlags.BlockScoped && redeclaredBeside(s, list)) {
			return `${i}do {\n${this.nested(() => this.forStatement(s, true))}\n${i}}`;
		}
		const init = list ? this.declarationList(list, false) : s.initializer ? i + this.tryPrefix(s.initializer) + this.exprStatement(s.initializer as ts.Expression) : '';
		const cond = s.condition ? `${this.tryPrefix(s.condition)}${this.cond(s.condition)}` : 'true';
		const step = s.incrementor ? this.tryPrefix(s.incrementor) + this.exprStatement(s.incrementor) : '';
		// `let` loop variables a closure in the body captures are a fresh binding per iteration, as in JavaScript; `var` is one binding.
		const captured = list && list.flags & ts.NodeFlags.Let && list.declarations.some((d) => ts.isIdentifier(d.name) && capturedIn(d.name, s.statement, this.checker));
		const labelName = ts.isLabeledStatement(s.parent) ? s.parent.label.text : null;
		const hasContinue = containsJump(s.statement, ts.SyntaxKind.ContinueStatement) || (!!labelName && continuesTo(s.statement, labelName));
		const label = this.takeLabel();
		return this.loopBody(() => {
			if (captured) {
				const names = list!.declarations.map((d) => ident((d.name as ts.Identifier).text));
				const first = this.fresh('__first');
				const outer = names.map((n) => `__outer_${n}`);
				const lines = [`${i}do {`, ...init.split('\n').map((l) => '    ' + l)];
				lines.push(...names.map((n, k) => `${i}    var ${outer[k]} = ${n}`), `${i}    var ${first} = true`, `${i}    ${label}while true {`);
				lines.push(...names.map((n, k) => `${i}        var ${n} = ${outer[k]}`));
				lines.push(`${i}        defer { ${names.map((n, k) => `${outer[k]} = ${n}`).join('; ')} }`);
				const body = this.nested(() => this.nested(() => this.block(s.statement)));
				lines.push(`${i}        if !${first} { ${step} }`, `${i}        ${first} = false`, `${i}        if !(${cond}) { break }`, `${i}        do ${body}`, `${i}    }`, `${i}}`);
				return lines.join('\n');
			}
			if (!step) return `${init ? init + '\n' : ''}${i}${label}while ${cond} ${this.block(s.statement)}`;
			if (hasContinue) {
				const first = this.fresh('__first');
				return `${init ? init + '\n' : ''}${i}var ${first} = true\n${i}${label}while true {\n${i}    if !${first} { ${step} }\n${i}    ${first} = false\n${i}    if !(${cond}) { break }\n${i}    do ${this.nested(() => this.block(s.statement))}\n${i}}`;
			}
			const body = this.block(s.statement).replace(/\n\s*}$/, '');
			return `${init ? init + '\n' : ''}${i}${label}while ${cond} ${body}\n${i}    ${step}\n${i}}`;
		});
	},
};
