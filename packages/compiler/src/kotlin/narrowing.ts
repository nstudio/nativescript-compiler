// Narrowed reads as Kotlin: narrowing, smart casts and assignment targets.
import ts from 'typescript';
import { ident, kotlinString, optionalType, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { storedOperand } from '../semantics/placement.ts';
import { isSelf } from '../semantics/lang.ts';
import { isWriteTarget } from '../semantics/ast.ts';
import { isUntyped, spelledType } from '../semantics/types.ts';
import { byKey } from '../semantics/spelled.ts';
import { nullAs } from './expressions.ts';

export const narrowingMethods = {
	/** A read the checker has narrowed (`if (x) x.length`, `if (e instanceof Error) e.message`): Kotlin needs the unwrap or cast. */
	narrowed(this: Translator, e: ts.Expression, code: string): string {
		return this.narrowing(e)?.(code) ?? code;
	},

	/** How `narrowed` makes a read's code the checker's type (`typeOf(e)`), or null where it stays as declared. `readHeld` reports a converted read from this alone. */
	narrowing(this: Translator, e: ts.Expression): ((code: string) => string) | null {
		// A `JSNullish` cell: its reader (`nullishCode`'s caller) takes `.present`/`.optional`, which a narrowing doesn't change.
		if (isWriteTarget(e) || this.rawNames.has(e) || this.nullishCalls.has(e) || storedOperand(this.placement, e)) return null;
		const sym = ts.isIdentifier(e) ? this.resolve(e) : undefined;
		if (sym && this.undefinedVars.has(sym)) {
			const actual = this.typeOf(e);
			// Library mode: narrowed to another type by a guard (`_isCssPendingSubstitution(value)` of a string): cast.
			if (this.library && !isUntyped(spelledType(actual)) && this.undefinedVars.get(sym)!.replace(/\?$/, '') !== actual.replace(/\?$/, '') && this.isObjectType(actual)) return (code) => `(${code} as ${actual})`;
			if (this.states.nullVars.has(sym) && ['Double', 'String', 'Boolean'].includes(actual)) return (code) => nullAs(code, actual);
			return actual.endsWith('?') ? null : (code) => this.undefinedAs(code, actual);
		}
		const declared = this.declaredTypeOf(e);
		if (!declared) return null;
		const actual = this.typeOf(e);
		if (declared === actual || isUntyped(spelledType(actual))) return null;
		// A string, number or boolean that may be undefined reads as JavaScript reads undefined there; never refused.
		if (declared === optionalType(actual)) {
			if (this.nullTolerant(e) || this.nullableArgument(e) || this.states.takesUndefined(e)) return null;
			const field = isWriteTarget(e) ? null : this.states.placedField(e);
			if (field) return (code) => `${RT.jsRequired}(${code}, ${kotlinString(field.name)})`;
			const keyed = (actual === 'Double' || actual === 'String') && this.states.unsetNullField(e) ? this.states.nullableEntry(e, () => this.expr(e)) : null;
			if (keyed) return () => `${actual === 'Double' ? RT.jsToNumber : RT.jsToString}(${keyed})`;
			const nullishDefault = !!sym?.valueDeclaration && ts.isParameter(sym.valueDeclaration) && !!sym.valueDeclaration.initializer && this.states.nullishHeld(sym.valueDeclaration);
			if (['String', 'Double', 'Boolean'].includes(actual) && (this.states.nilIsNull(e) || nullishDefault)) return (code) => nullAs(code, actual);
			if (this.lenient || ['String', 'Double', 'Boolean'].includes(actual)) return (code) => this.undefinedAs(code, actual);
			return ts.isIdentifier(e) && this.smartCast(e) ? null : (code) => this.asserted(code);
		}
		// `property` converts this read itself, from the member as declared, once it is present.
		if (ts.isPropertyAccessExpression(e) && this.convertingMember(e, false)) return null;
		if (isUntyped(spelledType(declared))) return (code) => this.fromAny(code, actual);
		if (declared.replace(/\?$/, '') !== actual.replace(/\?$/, '') && (this.isObjectRef(e) || ['Double', 'String', 'Boolean'].includes(actual))) return (code) => `(${code} as ${actual})`;
		return null;
	},

	/**
	 * Whether Kotlin smart-casts this read of a local held nullable to its non-null type: a null test written as
	 * `x != null` / `x == null` decides it on every path here (an `if` around it, an `&&`/`||`/`?:` operand, or an
	 * earlier `if (…) return/throw/break/continue` in an enclosing block), and a `var` is written neither in between, nor
	 * in a loop around the read that the test is outside of, nor by any closure. Kotlin rejects the read where this is
	 * wrong, so it can fail to compile but never run differently.
	 */
	smartCast(this: Translator, e: ts.Identifier): boolean {
		if (this.library || this.asyncCtx || this.subst.has(e) || this.refName(e) !== ident(e.text)) return false;
		const sym = this.resolve(e);
		const d = sym?.valueDeclaration;
		if (!sym || !d || !(ts.isVariableDeclaration(d) || ts.isParameter(d)) || !ts.isIdentifier(d.name) || (ts.isParameter(d) && ts.getModifiers(d)?.length)) return false;
		const fn = ts.isParameter(d) ? d.parent : ts.findAncestor(d.parent, ts.isFunctionLike);
		if (!fn || !ts.findAncestor(e.parent, (a) => a === fn)) return false;
		let writes = this.localWrites.get(sym);
		if (!writes) {
			const own = d.name,
				name = d.name.text;
			const found: ts.Node[] = [];
			const visit = (n: ts.Node) => {
				if (ts.isIdentifier(n) && n !== own && n.text === name && this.checker.getSymbolAtLocation(n) === sym) {
					const p = ts.walkUpParenthesizedExpressions(n.parent);
					if (isWriteTarget(n) || ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === n)) found.push(n);
				}
				ts.forEachChild(n, visit);
			};
			visit(fn);
			this.localWrites.set(sym, (writes = found));
		}
		if (writes.some((w) => ts.findAncestor(w.parent, ts.isFunctionLike) !== fn)) return false;
		// A local never written is a Kotlin `val`, smart-cast inside the closures that capture it as well.
		if (writes.length && ts.findAncestor(e.parent, ts.isFunctionLike) !== fn) return false;
		const x = ident(e.text);
		// Whether the condition, when it evaluates to `truth`, leaves x non-null in Kotlin's eyes.
		const implies = (c: ts.Expression, truth: boolean): boolean => {
			const code = this.condCodes.get(c);
			// `x?.k != null`, and a string member's truth (`isNullOrEmpty`'s contract), hold only where x is present too.
			const member = `${x.replace(/[$`]/g, '\\$&')}\\?\\.\\w+`;
			if (code === `${x} != null` || (code !== undefined && new RegExp(`^(${member} != null|!\\(\\(${member}\\)\\.isNullOrEmpty\\(\\)\\))$`).test(code))) return truth;
			if (code === `${x} == null` || (code !== undefined && new RegExp(`^(${member} == null|\\(${member}\\)\\.isNullOrEmpty\\(\\))$`).test(code))) return !truth;
			if (ts.isParenthesizedExpression(c)) return implies(c.expression, truth);
			if (ts.isPrefixUnaryExpression(c) && c.operator === ts.SyntaxKind.ExclamationToken) return implies(c.operand, !truth);
			if (ts.isBinaryExpression(c)) {
				const op = c.operatorToken.kind;
				if (op === ts.SyntaxKind.AmpersandAmpersandToken) return truth ? implies(c.left, true) || implies(c.right, true) : implies(c.left, false) && implies(c.right, false);
				if (op === ts.SyntaxKind.BarBarToken) return truth ? implies(c.left, true) && implies(c.right, true) : implies(c.left, false) || implies(c.right, false);
			}
			return false;
		};
		const exits = (s: ts.Statement): boolean => ts.isReturnStatement(s) || ts.isThrowStatement(s) || ts.isBreakStatement(s) || ts.isContinueStatement(s) || (ts.isBlock(s) && s.statements.length > 0 && exits(s.statements[s.statements.length - 1]));
		// The guard: where the code that decides x non-null ends.
		let from: number | undefined;
		let guard: ts.Node | undefined;
		for (let n: ts.Node = e; n.parent && n !== fn && from === undefined; n = n.parent) {
			const p = n.parent;
			if (ts.isClassLike(p) || ts.isFunctionDeclaration(p)) break;
			if (ts.isIfStatement(p) && n !== p.expression && implies(p.expression, n === p.thenStatement)) [from, guard] = [p.expression.end, p.expression];
			else if (ts.isBinaryExpression(p) && n === p.right && (p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || p.operatorToken.kind === ts.SyntaxKind.BarBarToken) && implies(p.left, p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)) [from, guard] = [p.left.end, p.left];
			else if (ts.isConditionalExpression(p) && n !== p.condition && implies(p.condition, n === p.whenTrue)) [from, guard] = [p.condition.end, p.condition];
			else if (ts.isBlock(p) || ts.isSourceFile(p) || ts.isCaseClause(p) || ts.isDefaultClause(p)) {
				const at = (p.statements as ts.NodeArray<ts.Statement>).indexOf(n as ts.Statement);
				for (let k = at - 1; k >= 0; k--) {
					const s = p.statements[k];
					if (ts.isIfStatement(s) && !s.elseStatement && exits(s.thenStatement) && implies(s.expression, false)) {
						[from, guard] = [s.end, s];
						break;
					}
				}
			}
		}
		if (from === undefined || !guard) return false;
		const start = from;
		const g = guard;
		const within = (w: ts.Node, a: ts.Node) => w.pos >= a.pos && w.end <= a.end;
		return !writes.some((w) => (w.pos >= start && w.end <= e.pos) || ts.findAncestor(e, (a) => (a === fn || within(g, a) ? 'quit' : ts.isIterationStatement(a, false) && within(w, a))));
	},

	/** An assignable place: a component prop is its signal's value. */
	lvalue(this: Translator, e: ts.Expression): string {
		if (ts.isParenthesizedExpression(e)) return this.lvalue(e.expression);
		if (ts.isPropertyAccessExpression(e) && byKey(this, e)) return `${this.expr(e.expression)}${this.typeOf(e.expression).endsWith('?') ? '!!' : ''}[${kotlinString(e.name.text)}]`;
		if (ts.isPropertyAccessExpression(e) && isSelf(e.expression, this.subst) && this.props.has(e.name.text)) return `this.${ident(e.name.text)}.value`;
		if (ts.isPropertyAccessExpression(e) && this.isAmbient(e)) return `${RT.jsGetIfPresent}(${this.expr(e.expression)}, ${kotlinString(e.name.text)})`;
		if (ts.isPropertyAccessExpression(e)) {
			const member = this.namespaceMember(e);
			if (member) return member;
			const core = this.core?.lvalue(e);
			if (core) return core;
			const code = this.expr(e.expression);
			const target = this.typeOf(e.expression).endsWith('?') || this.isAsserted(code) ? this.present(code, e.name.text, e.expression, true) : code;
			return `${target}.${ident(e.name.text)}`;
		}
		if (ts.isElementAccessExpression(e)) return this.elementAccess(e);
		if (ts.isIdentifier(e)) return this.globalAlias(e) ?? this.refName(e);
		return this.expr(e);
	},
};
