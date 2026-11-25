// Narrowed reads as Swift: narrowing, narrowing casts, assignment targets and places.
import { heldLoss } from '../semantics/losses.ts';
import ts from 'typescript';
import { storedOperand } from '../semantics/placement.ts';
import { ident, isOptional, optionalType, swiftString } from './syntax.ts';
import type { Translator } from './translator.ts';
import { isSelf } from '../semantics/lang.ts';
import { isLibDeclaration, isWriteTarget } from '../semantics/ast.ts';
import { isLibGlobal } from '../semantics/globals.ts';
import { byKey, symbolField } from '../semantics/spelled.ts';
import { isUntyped, spelledType } from '../semantics/types.ts';

export const narrowingMethods = {
	/** A read of a member its interface or class declares optional (`backstackVisible?: boolean`), not a write: the access. */
	optionalMember(this: Translator, e: ts.Expression): ts.PropertyAccessExpression | null {
		while (ts.isParenthesizedExpression(e)) e = e.expression;
		if (!ts.isPropertyAccessExpression(e) || isWriteTarget(e) || e.questionDotToken) return null;
		const sym = this.checker.getSymbolAtLocation(e.name);
		return sym && sym.flags & ts.SymbolFlags.Optional && sym.declarations?.some((d) => (ts.isPropertySignature(d) || ts.isPropertyDeclaration(d)) && !!d.questionToken) ? e : null;
	},

	/**
	 * `const merged: T[] = new Array(n)`, filled by index and returned: Swift holds the
	 * slots as optional until the return, which gives the array of the declared type.
	 * Any other use would see a hole the element type cannot hold.
	 */
	holeyArray(this: Translator, d: ts.VariableDeclaration, t: string): { type: string; length: ts.Expression } | null {
		let init = d.initializer;
		while (init && ts.isParenthesizedExpression(init)) init = init.expression;
		if (!init || !ts.isNewExpression(init) || !ts.isIdentifier(init.expression) || init.expression.text !== 'Array' || !isLibGlobal(this, init.expression)) return null;
		if (init.arguments?.length !== 1 || this.typeOf(init.arguments[0]) !== 'Double' || this.typeOf(init) !== 'JSArray<Any?>') return null;
		const el = /^JSArray<(.*)>!?$/.exec(t)?.[1];
		if (!el || isUntyped(spelledType(el)) || isOptional(el) || ['Double', 'String', 'Bool'].includes(el)) return null;
		const sym = this.resolve(d.name as ts.Identifier);
		const scope = ts.findAncestor(d, ts.isFunctionLike);
		if (!sym || !scope) return null;
		const visit = (n: ts.Node): void => {
			if (ts.isIdentifier(n) && n !== d.name && this.resolve(n) === sym) {
				const p = n.parent;
				const filled = ts.isElementAccessExpression(p) && p.expression === n && isWriteTarget(p) && ts.isBinaryExpression(p.parent) && p.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
				const length = ts.isPropertyAccessExpression(p) && p.expression === n && p.name.text === 'length' && !isWriteTarget(p);
				if (!filled && !length && !(ts.isReturnStatement(p) && p.expression === n)) throw this.error(n, `new Array of a length, of ${el}, used other than filled by index and returned (empty slots need an optional element type)`);
			}
			ts.forEachChild(n, visit);
		};
		visit(scope);
		this.holeyArrays.add(sym);
		return { type: `JSArray<${optionalType(el)}>`, length: init.arguments[0] };
	},

	/** A read the checker has narrowed (`if (x) x.length`, `if (e instanceof Error) e.message`): Swift needs the unwrap or cast. */
	narrowed(this: Translator, e: ts.Expression, code: string): string {
		const how = this.narrowing(e);
		if (how === 'optional') {
			this.optionalReads.set(e, true);
			return code;
		}
		return how ? how(code) : code;
	},

	/**
	 * How `narrowed` makes a read's code the checker's type (`typeOf(e)`): null where the code stays as declared, `optional`
	 * where it stays optional for a reader that takes it so (`optionalReads`). `readHeld` reports a converted read from this alone.
	 */
	narrowing(this: Translator, e: ts.Expression): ((code: string) => string) | 'optional' | null {
		// A `JSNullish` cell: its reader (`nullishCode`'s caller) takes `.present`/`.optional`, which a narrowing doesn't change.
		if (isWriteTarget(e) || this.nullishCalls.has(e) || storedOperand(this.placement, e)) return null;
		const sym = ts.isIdentifier(e) ? this.resolve(e) : undefined;
		if (sym && this.undefinedVars.has(sym)) {
			// `x?.m`: the chain reads the optional itself.
			const p = e.parent;
			if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p) || ts.isCallExpression(p)) && p.expression === e && p.questionDotToken) return null;
			const actual = this.typeOf(e);
			if (actual === 'Never') return null;
			const was = this.undefinedVars.get(sym)!;
			if (isUntyped(spelledType(was))) return isUntyped(spelledType(actual)) ? null : (code) => this.fromAny(code, actual);
			// Narrowed by a test (`value instanceof LinearGradient`): what the test found.
			const held = was.replace(/[?!]$/, '');
			if (held !== actual.replace(/[?!]$/, '') && !isUntyped(spelledType(actual)) && this.isObjectRef(e) && /^[A-Z][\w.]*$/.test(held)) return (code) => this.narrowCast(e, code, actual.replace(/[?!]$/, ''));
			if (this.states.nullVars.has(sym) && (actual === 'Double' || actual === 'String')) return (code) => (heldLoss('nullVariable', actual === 'Double' ? '0' : '"null"'), `(${code} ?? ${actual === 'Double' ? '0' : '"null"'})`);
			return isOptional(actual) ? null : (code) => this.undefinedAs(code, actual, was);
		}
		const declared = this.declaredTypeOf(e);
		if (!declared) return null;
		const actual = this.typeOf(e);
		// Narrowed to `never` (a branch the checker deems unreachable): the declared value as it is.
		if (declared === actual || isUntyped(spelledType(actual)) || actual === 'Never') return null;
		if (declared === optionalType(actual)) {
			// Inside an optional chain (`group?.items[i]`): the chain goes on through the optional.
			const p = e.parent;
			if (ts.isOptionalChain(e) && (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p) || ts.isCallExpression(p)) && p.expression === e && ts.isOptionalChain(p)) return null;
			if (this.optionalReads.has(e)) return 'optional';
			// `Error.stack`, optional in the ES library, is always a string in the runtime (`JSError.stack`).
			if (ts.isPropertyAccessExpression(e) && e.name.text === 'stack' && isLibDeclaration(this.checker.getSymbolAtLocation(e.name)?.declarations?.[0])) return null;
			const propSym = ts.isPropertyAccessExpression(e) ? this.checker.getSymbolAtLocation(e.name) : undefined;
			if ((this.states.narrowedMissing(e) || (!!propSym && this.states.shapeFieldOptional(propSym))) && ['String', 'Double', 'Bool'].includes(actual)) return (code) => this.undefinedAs(code, actual, declared);
			if (this.requiredNarrowed(e)) return (code) => this.marks.tryCode(this.marks.helper('jsObjectRequired', code));
			return ts.isOptionalChain(e) ? (code) => this.marks.unwrappedCode(`(${code})`) : (code) => this.marks.unwrappedCode(code);
		}
		// `property` converts this read itself, from the member as declared, once it is present.
		if (ts.isPropertyAccessExpression(e) && this.convertingMember(e)) return null;
		if (isUntyped(spelledType(declared))) return (code) => this.fromAny(code, actual);
		// A collection Swift holds as one type whatever TypeScript narrows it to (`frames[time]` of a `new Array()` is held as
		// the record its reads make it): a cast between two of these generic classes could only fail.
		if (/^JS(Array|Record)</.test(declared) && /^JS(Array|Record)</.test(actual)) return null;
		if (declared.replace(/\?$/, '') !== actual.replace(/\?$/, '') && this.isObjectRef(e)) return (code) => (this.marks.alreadyAs(code, actual) ? code : this.narrowCast(e, code, actual));
		if (sym && this.checker.getTypeOfSymbol(sym).flags & ts.TypeFlags.TypeParameter) return (code) => this.forcedCast(code, actual);
		return null;
	},

	/**
	 * A value narrowed to a subclass (`if (parent instanceof LayoutBase) parent.x`). Lenient code holds it optional, so the
	 * cast is conditional and the read checks it present where Swift needs it (see `required`).
	 */
	narrowCast(this: Translator, e: ts.Expression, code: string, to: string): string {
		if (this.lenient && this.loose(e) && !/^(CG|CT|CF)[A-Z]\w*$/.test(to)) return this.marks.castCode(code, to, 'as?', true);
		return this.forcedCast(code, to);
	},

	/** An assignable place: a component prop is its signal's value. */
	lvalue(this: Translator, e: ts.Expression): string {
		return this.place(e).code;
	},

	/** An assignable place, and whether evaluating it can throw (a Swift setter cannot; an element's place, but a symbol-keyed field, is taken to throw). */
	place(this: Translator, e: ts.Expression): { code: string; throws: boolean } {
		if (ts.isPropertyAccessExpression(e) && isSelf(e.expression, this.subst) && this.props.has(e.name.text)) return { code: `self.${ident(e.name.text)}.value`, throws: false };
		if (ts.isPropertyAccessExpression(e)) {
			const ns = this.namespaceMember(e);
			if (ns) return { code: ns, throws: false };
			// Writing a member of an object Swift holds as optional (`this._webglContext._type = …` just after making it): JavaScript's TypeError where it is missing.
			// An element that may be missing (`items[i].x = …`): JavaScript's TypeError where it is.
			if (byKey(this, e)) return { code: `${this.expr(e.expression)}${this.typeOf(e.expression).endsWith('?') ? '?' : ''}[${swiftString(e.name.text)}]`, throws: this.receiverThrows(e.expression) };
			const checked = !e.questionDotToken ? this.receiver(e.expression, e.name.text) : null;
			if (checked) return { code: `${checked}.${this.memberName(e)}`, throws: true };
			const receiver = this.typeOf(e.expression);
			const unwrap = receiver.endsWith('?') && !isUntyped(spelledType(receiver)) && this.isObjectRef(e.expression) && !e.questionDotToken ? '!' : '';
			const recv = this.expr(e.expression);
			return { code: this.marks.leading(`${recv}${unwrap}.${this.memberName(e)}`, recv), throws: this.receiverThrows(e.expression) };
		}
		if (ts.isElementAccessExpression(e)) return { code: this.elementAccess(e), throws: !symbolField(this, e) || this.receiverThrows(e.expression) };
		if (ts.isIdentifier(e)) return { code: this.globalAlias(e) ?? this.refName(e), throws: false };
		return { code: this.expr(e), throws: true };
	},
};
