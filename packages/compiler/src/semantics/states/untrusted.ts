// Values the program can't vouch for: untrusted and nil values, loose holders and a library's results that may be missing.
import ts from 'typescript';
import { onlyTested, sameObjectType } from './predicates.ts';
import { isUntyped } from '../types.ts';
import { originOf, ownSlot, slotOf } from '../trust.ts';
import { implementedInterfaceDeclarations, slotType } from '../lang.ts';
import { rethrowUnlessRefused } from '../refusals.ts';
import type { ValueStates } from './value-states.ts';

export const untrustedMethods = {
	/** A value that may be undefined, null or another kind than the native type for it says. */
	untrustedValue(this: ValueStates, e: ts.Expression): boolean {
		try {
			const origin = originOf(e, this.backend.trust);
			// An untyped read by key or an assertion counts only where what it reads is untyped: a typed array's element is the type's.
			if (origin === 'dynamic' || origin === 'asserted') {
				const x = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
				return isUntyped(this.backend.typeOf(ts.isElementAccessExpression(x) ? x : (x as ts.AsExpression | ts.TypeAssertion | ts.NonNullExpression).expression));
			}
			return origin === 'any' || origin === 'loose';
		} catch (e) {
			rethrowUnlessRefused(e);
			return false;
		}
	},

	/** An object the platform's binding or the kit may give as nil, or a read of a slot one is placed in. */
	nilValue(this: ValueStates, e: ts.Expression): boolean {
		const b = this.backend;
		const x = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
		if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) return this.nilValue(x.right);
		if (ts.isAsExpression(x) && sameObjectType(this.checker, x.expression, x)) return this.nilValue(x.expression);
		if (ts.isConditionalExpression(x)) return this.nilValue(x.whenTrue) || this.nilValue(x.whenFalse);
		if (ts.isOptionalChain(x)) return false;
		try {
			if (ts.isIdentifier(x) || ts.isPropertyAccessExpression(x)) {
				const d = this.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(x) ? x.name : x)?.valueDeclaration;
				if (d && !d.getSourceFile().isDeclarationFile) return this.nilSlots.has(d);
			}
			const d = ts.isCallExpression(x) ? this.checker.getResolvedSignature(x)?.getDeclaration() : ts.isPropertyAccessExpression(x) ? this.checker.getSymbolAtLocation(x.name)?.valueDeclaration : undefined;
			if (!d || ts.isJSDocSignature(d)) return false;
			const nil = b.trust.nativeDeclaration(d) ? !!b.native?.holdsNil?.(d) : !!b.kitNil?.(x);
			return nil && b.looseObjectType(b.typeOf(x));
		} catch (e) {
			rethrowUnlessRefused(e);
			return false;
		}
	},

	/** An app declaration holding an object whose form the backend may choose alone; a non-strict app's fields keep theirs. */
	holdsNilObject(this: ValueStates, d: ts.Declaration): boolean {
		const b = this.backend;
		if (b.library || b.lenient || !this.appCode(d)) return false;
		const strict = b.trust.strictFile(d.getSourceFile());
		if (!strict && (!b.lenientApp || ts.isPropertySignature(d) || ts.isPropertyDeclaration(d) || ts.isPropertyAssignment(d))) return false;
		if (!ownSlot(d, (this.implementedInterfaceSet ??= implementedInterfaceDeclarations(b.sourceFiles, this.checker)))) return false;
		try {
			const st = slotType(d, this.checker);
			return !!st && b.looseObjectType(b.type(st, d));
		} catch (e) {
			rethrowUnlessRefused(e);
			return false;
		}
	},

	/** A declaration of strict code (not the kit's) holding a string, number, boolean or object, in a form the backend may choose alone. */
	holdsLoose(this: ValueStates, d: ts.Declaration): boolean {
		const b = this.backend;
		const strict = b.trust.strictFile(d.getSourceFile());
		// A non-strict app's fields keep their representation: every reader, a template's binding among them, would see it change.
		const lenientSlot = b.lenientApp && this.appCode(d) && !ts.isPropertySignature(d) && !ts.isPropertyDeclaration(d) && !ts.isPropertyAssignment(d);
		if (b.library || !(strict || lenientSlot) || !ownSlot(d, (this.implementedInterfaceSet ??= implementedInterfaceDeclarations(b.sourceFiles, this.checker)))) return false;
		try {
			const st = slotType(d, this.checker);
			if (!st) return false;
			const t = b.type(st, d);
			// A non-strict app's object slot keeps its checked conversion: held optional, a wrong-typed value would read as missing.
			return this.primitive(t) || (strict && b.looseObjectType(t));
		} catch (e) {
			rethrowUnlessRefused(e);
			return false;
		}
	},

	/**
	 * Strict code: where a native object the binding may give as nil goes as the nullable it is: `??`'s left operand, its
	 * right or a conditional's branch where the whole is only tested or goes to a slot held optional for it
	 * (`looseSlots`), and such a slot.
	 */
	nilKept(this: ValueStates, e: ts.Expression): boolean {
		let x: ts.Node = e;
		for (;;) {
			while (ts.isParenthesizedExpression(x.parent) || (ts.isAsExpression(x.parent) && sameObjectType(this.checker, x as ts.Expression, x.parent))) x = x.parent;
			const p = x.parent;
			if (ts.isConditionalExpression(p) && p.condition !== x) {
				x = p;
				continue;
			}
			if (!ts.isBinaryExpression(p) || p.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken) break;
			if (p.left === x) return true;
			x = p;
		}
		return this.takesUndefined(x as ts.Expression) || (x !== e && onlyTested(x as ts.Expression));
	},

	/** A slot that holds undefined as it is: one an untrusted value is placed in, or a program's optional parameter. */
	takesUndefined(this: ValueStates, x: ts.Expression): boolean {
		if (this.backend.library) return false;
		const slot = slotOf(x, this.checker);
		return !!slot && !slot.getSourceFile().isDeclarationFile && (this.looseSlots.has(slot) || (ts.isParameter(slot) && !!slot.questionToken));
	},

	/**
	 * A non-strict app's call of a library function declared to give `T | undefined` or `T | null` (`find`, `exec`),
	 * which the checker, without strictNullChecks, types `T`: the backends hold what it gives optional, and a member read
	 * of it is JavaScript's TypeError where it is missing.
	 */
	libraryResultMissing(this: ValueStates, x: ts.Expression): 'undefined' | 'null' | null {
		const b = this.backend;
		if (!b.lenientApp || b.library || !ts.isCallExpression(x) || b.trust.strictFile(x.getSourceFile()) || isUntyped(b.typeOf(x)) || b.optional(b.typeOf(x))) return null;
		const sig = this.checker.getResolvedSignature(x)?.getDeclaration();
		const t = sig && !ts.isJSDocSignature(sig) ? sig.type : undefined;
		if (!t || !ts.isUnionTypeNode(t) || !/[\\/]typescript[\\/]lib[\\/]/.test(sig!.getSourceFile().fileName)) return null;
		if (t.types.some((u) => u.kind === ts.SyntaxKind.UndefinedKeyword)) return 'undefined';
		return t.types.some((u) => ts.isLiteralTypeNode(u) && u.literal.kind === ts.SyntaxKind.NullKeyword) ? 'null' : null;
	},
};

export type UntrustedMethods = typeof untrustedMethods;
