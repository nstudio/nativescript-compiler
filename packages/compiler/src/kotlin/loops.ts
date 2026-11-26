// Loops as Kotlin: stepped loops, labels, loop bodies, iteration and for statements.
import ts from 'typescript';
import { ident, kotlinString, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { capturedIn, continuesTo, containsJump } from '../semantics/ast.ts';
import { iteratedType, iteratesCheckedResult, redeclaredBeside } from '../semantics/lang.ts';
import { isBuiltinIterable } from '../semantics/classes.ts';
import { isKit, isUntyped, spelledType } from '../semantics/types.ts';

export const loopsMethods = {
	/**
	 * A `for…of` stepping through its value's iterator (`forOfSteps`): a throw leaving it closes the iterator in the
	 * catch, every other exit in the finally, which runs after the body's own. A return in a lowered function completes
	 * it before the finally runs, so it closes the iterator first (`withClosingReturns`).
	 */
	steppedLoop(this: Translator, s: ts.ForOfStatement): string {
		const i = this.indent;
		const list = s.initializer;
		const item = ts.isVariableDeclarationList(list) ? null : this.fresh('__item');
		const assigned = item ? this.assignIterated(list as ts.Expression, item, null, s.expression) : [];
		const js = this.iteratorCode(s.expression);
		const it = this.fresh('__it');
		const bind = () => {
			if (!ts.isVariableDeclarationList(list)) return [`val ${item}: Any? = ${it}.jsCurrent`, ...assigned].map((l) => this.indent + l).join('\n');
			// An untyped iterable's values, read as the binding types them.
			return this.bindTo(list.declarations[0].name, `${it}.jsCurrent`, this.isAny(s.expression) ? 'Any?' : '', !(list.flags & ts.NodeFlags.Const));
		};
		return this.loopBody(() => {
			const label = this.takeLabel();
			const body = this.withClosingReturns(it, () => this.nested(() => this.nested(() => this.block(s.statement))));
			const bound = this.nested(() => this.nested(() => this.nested(bind)));
			return [`${i}run {`, `${i}    val ${it} = ${js}`, `${i}    try {`, `${i}        ${label}while (${it}.jsAdvance()) {`, bound, `${i}            run ${body}`, `${i}        }`, `${i}    } catch (__thrown: Throwable) {`, `${i}        ${it}.jsClose()`, `${i}        throw __thrown`, `${i}    } finally {`, `${i}        ${it}.jsCloseChecked()`, `${i}    }`, `${i}}`].join('\n');
		});
	},

	takeLabel(this: Translator): string {
		const l = this.label;
		this.label = null;
		return l ? `${l}@ ` : '';
	},

	loopBody(this: Translator, body: () => string): string {
		this.plainBreak++;
		this.plainContinue++;
		this.jumps.push({ kind: 'loop' });
		try {
			return body();
		} finally {
			this.plainBreak--;
			this.plainContinue--;
			this.jumps.pop();
		}
	},

	/** `for (x of xs)` and `for ([k, v] of map)`: each value assigned to variables or members declared elsewhere. */
	forOfExisting(this: Translator, s: ts.ForOfStatement, target: ts.Expression): string {
		if (this.forOfSteps(s.expression)) return this.steppedLoop(s);
		const i = this.indent;
		const item = this.fresh('__item');
		const iterated = this.forOfValueType(s.expression);
		const typed = !!iterated && !this.jsIteration(s.expression) && !this.isAny(s.expression);
		const seq = typed ? this.iterable(s.expression) : `${RT.jsIteratorOf}(${this.coerce(s.expression, 'Any?')}).jsCollect()`;
		const assigns = this.assignIterated(target, item, typed ? iterated : null, s.expression);
		return this.loopBody(() => {
			const label = this.takeLabel();
			const body = this.block(s.statement);
			return `${i}${label}for (${item} in ${seq}) {\n${assigns.map((a) => `${i}    ${a}`).join('\n')}\n${body.slice(2)}`;
		});
	},

	/** The type of the values `for…of` gives, by the iterable's type; null where its iteration is unknown. */
	forOfValueType(this: Translator, e: ts.Expression): ts.Type | null {
		const t = this.checker.getNonNullableType(this.checker.getTypeAtLocation(e));
		if (this.checker.isArrayType(t)) return this.checker.getTypeArguments(t as ts.TypeReference)[0];
		if (t.flags & ts.TypeFlags.StringLike) return this.checker.getStringType();
		return iteratedType(t, this.checker, e) ?? null;
	},

	/** What `for…of` iterates: arrays, sets and iterators as they are, a map's entries, a string's code points. */
	iterable(this: Translator, e: ts.Expression): string {
		const js = this.jsIteration(e);
		if (js) return `${js}.jsCollect()`;
		if (this.isAny(e)) return `${RT.jsIteratorOf}(${this.expr(e)}).jsCollect()`;
		const t = this.typeOf(e).replace(/\?$/, '');
		if (t === 'String') return `${RT.jsCodePoints}(${this.expr(e)})`;
		if (isKit(spelledType(t), 'JSMap')) return `${this.expr(e)}.entries()`;
		if (t === 'JSMatch') return `${this.expr(e)}.values`;
		if (t.startsWith('Pair<') || t.startsWith('Triple<')) return `${RT.jsTupleList}(${this.expr(e)})`;
		// An untyped value: whatever its iteration gives, a TypeError where it has none.
		if (this.isAny(e)) return `${RT.jsIteratorOf}(${this.expr(e)}).jsCollect()`;
		return this.expr(e);
	},

	resumedValue(this: Translator, code: string, type: string): string {
		return ['String', 'Double', 'Boolean'].includes(type) ? this.undefinedAs(`(${code} as? ${type})`, type) : this.fromAnyCode(code, type, true);
	},

	/** `e[Symbol.iterator]()`: an iterator over any iterable; `called`, the script's own call of it, whose untyped result is the method's. */
	iteratorCode(this: Translator, e: ts.Expression, called = false, message?: string): string {
		const t = this.typeOf(e).replace(/\?$/, '');
		const code = this.expr(e);
		if (/^JS(Iterator|Generator)</.test(t)) return code;
		if (isKit(spelledType(t), 'JSIterable')) return `${code}.jsIterator()`;
		if (isUntyped(spelledType(t)) || t === 'Any') return `${called ? RT.jsCallSymbolIterator : RT.jsIteratorOf}(${code}${message ? `, ${kotlinString(message)}` : ''})`;
		if (isBuiltinIterable(t, e, this.checker)) return `${RT.jsIterator}(${code})`;
		if (t === 'JSMatch') {
			const values = `${this.typeOf(e).endsWith('?') ? this.present(code, 'values', e) : code}.values`;
			return this.elementTypeOf(e) === 'String' && !this.unsetMatch(e) ? `${RT.jsIterator}(JSArray(ArrayList(${values}.storage.map { it ?: "undefined" })))` : `${RT.jsIterator}(${values})`;
		}
		// The generated kit's class gives its own generator, its element type erased.
		if (this.generatedKit && this.core?.has(t) && this.core.kitMember(t, 'jsSymbolIterator')?.type.startsWith('JSGenerator<')) return this.unchecked(`JSGenerator<${this.elementTypeOf(e)}>`, `${code}.jsSymbolIterator()`);
		// A `[Symbol.iterator]()` giving other than an iterator class: its result checked as the class's `jsAnyIterator` checks it.
		if (iteratesCheckedResult(e, this.checker, (m) => this.returnTypeOf(m))) return `JSIteratorAdapter<${this.elementTypeOf(e)}>(${code}.jsAnyIterator())`;
		return `JSIteratorAdapter<${this.elementTypeOf(e)}>(${code}.jsSymbolIterator())`;
	},

	/** GetIterator(e, async), for `for await`: an async iterable's own iterator, or a sync one's adapted. */
	asyncIteration(this: Translator, e: ts.Expression): string {
		const t = this.typeOf(e).replace(/\?$/, '');
		const code = this.expr(e);
		if (/^JS(AsyncIterator|AsyncGenerator)</.test(t)) return code;
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
		return isAsync ? this.asyncIteration(e) : this.iteratorCode(e);
	},

	forStatement(this: Translator, s: ts.ForStatement, scoped = false): string {
		const i = this.indent;
		const list = s.initializer && ts.isVariableDeclarationList(s.initializer) ? s.initializer : null;
		// A `let` loop variable is the loop's own: a sibling declaring the same name needs the loop in a scope of its own.
		if (!scoped && list && list.flags & ts.NodeFlags.BlockScoped && redeclaredBeside(s, list)) {
			return `${i}run {\n${this.nested(() => this.forStatement(s, true))}\n${i}}`;
		}
		const init = list ? this.declarationList(list, true) : s.initializer ? i + this.exprStatement(s.initializer as ts.Expression) : '';
		const cond = s.condition ? this.cond(s.condition) : 'true';
		const step = s.incrementor ? this.exprStatement(s.incrementor) : '';
		const captured = list && list.flags & ts.NodeFlags.Let && list.declarations.some((d) => ts.isIdentifier(d.name) && capturedIn(d.name, s.statement, this.checker));
		const labelName = ts.isLabeledStatement(s.parent) ? s.parent.label.text : null;
		const hasContinue = containsJump(s.statement, ts.SyntaxKind.ContinueStatement) || (!!labelName && continuesTo(s.statement, labelName));
		const label = this.takeLabel();
		return this.loopBody(() => {
			if (captured) {
				// `let` loop variables a closure in the body captures are a fresh binding per iteration, as in JavaScript.
				const names = list!.declarations.map((d) => ident((d.name as ts.Identifier).text));
				const first = this.fresh('__first');
				const outer = names.map((n) => `__outer_${n}`);
				const types = list!.declarations.map((d) => this.typeOf(d.name));
				const lines = [`${i}run {`, ...init.split('\n').map((l) => '    ' + l)];
				lines.push(...names.map((n, k) => `${i}    var ${outer[k]}: ${types[k]} = ${n}`), `${i}    var ${first} = true`, `${i}    ${label}while (true) {`);
				lines.push(...names.map((n, k) => `${i}        var ${n}: ${types[k]} = ${outer[k]}`));
				const body = this.nested(() => this.nested(() => this.nested(() => this.block(s.statement))));
				lines.push(`${i}        try {`, `${i}            if (!${first}) { ${step} }`, `${i}            ${first} = false`, ...(cond === 'true' ? [] : [`${i}            if (!(${cond})) break`]), `${i}            run ${body}`, `${i}        } finally { ${names.map((n, k) => `${outer[k]} = ${n}`).join('; ')} }`, `${i}    }`, `${i}}`);
				return lines.join('\n');
			}
			if (!step) return `${init ? init + '\n' : ''}${i}${label}while (${cond}) ${this.block(s.statement)}`;
			if (hasContinue) {
				const first = this.fresh('__first');
				return `${init ? init + '\n' : ''}${i}var ${first} = true\n${i}${label}while (true) {\n${i}    if (!${first}) { ${step} }\n${i}    ${first} = false\n${cond === 'true' ? '' : `${i}    if (!(${cond})) break\n`}${i}    run ${this.nested(() => this.block(s.statement))}\n${i}}`;
			}
			const body = this.block(s.statement).replace(/\n\s*}$/, '');
			return `${init ? init + '\n' : ''}${i}${label}while (${cond}) ${body}\n${i}    ${step}\n${i}}`;
		});
	},
};
