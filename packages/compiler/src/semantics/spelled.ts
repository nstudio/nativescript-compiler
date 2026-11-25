// Questions the front answers from the native type a backend holds a value or a type as (`TypeReader`): untyped, the
// kit's record, symbol or promise.
import ts from 'typescript';
import { memberOrKey } from './conversion.ts';
import { isKit, isUntyped, parseNativeType, type NativeType } from './types.ts';
import type { StateBackend } from './states/value-states.ts';

/** The native types a translator holds nodes and types as (`typeMethods.nativeOf`, `nativeOfType`). */
export interface TypeReader {
	readonly checker: ts.TypeChecker;
	nativeOf(n: ts.Node): NativeType;
	nativeOfType(t: ts.Type, at: ts.Node): NativeType;
}

/** A translator's held types as its StateBackend gives them to the shared deciders. */
export function heldTypes(t: TypeReader & { returnTypeOf(d: ts.SignatureDeclaration): string }): Pick<StateBackend, 'typeOf' | 'type' | 'returnTypeOf'> {
	return { typeOf: (n) => t.nativeOf(n), type: (type, at) => t.nativeOfType(type, at), returnTypeOf: (d) => parseNativeType(t.returnTypeOf(d)) };
}

/** Whether a `null` here lands in an optional typed slot rather than an untyped one. */
export function optionalContext(b: TypeReader, e: ts.Expression): boolean {
	const ctx = b.checker.getContextualType(e);
	return !!ctx && !(ctx.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) && !isUntyped(b.nativeOfType(ctx, e));
}

/** A parameter type computed from type parameters (indexed access, conditional), which the backend holds untyped. */
export function untypedGeneric(b: TypeReader, node: ts.TypeNode): boolean {
	const t = b.checker.getTypeFromTypeNode(node);
	return !!(t.flags & (ts.TypeFlags.IndexedAccess | ts.TypeFlags.Conditional | ts.TypeFlags.Substitution)) && isUntyped(b.nativeOfType(t, node));
}

/** `o.k` read and written as the receiver's entry of key `k` (`memberOrKey`). */
export function byKey(b: Pick<TypeReader, 'nativeOf'>, e: ts.PropertyAccessExpression): boolean {
	return memberOrKey(isKit(b.nativeOf(e.expression), 'JSRecord') ? 'record' : 'other', { literal: true }) === 'key';
}

/** The member a symbol key names on a type declaring it (`this[messages_]`), which the backend holds as a field. */
export function symbolField(b: TypeReader & { resolve(n: ts.Node): ts.Symbol | undefined }, e: ts.ElementAccessExpression): ts.Symbol | undefined {
	const key = e.argumentExpression;
	const k = ts.isIdentifier(key) ? b.nativeOf(key) : undefined;
	return k && k.head === 'JSSymbol' && !k.optional && !k.implicit
		? b.checker
				.getTypeAtLocation(e.expression)
				.getProperties()
				.find((p) => {
					const n = p.valueDeclaration && (p.valueDeclaration as ts.NamedDeclaration).name;
					return !!n && ts.isComputedPropertyName(n) && b.resolve(n.expression) === b.resolve(key);
				})
		: undefined;
}

export function isPromiseType(t: NativeType): boolean {
	return isKit(t, 'JSPromise');
}

/** A function value whose call gives a promise (`then`'s callback returning one is adopted). */
export function returnsPromise(b: TypeReader, e: ts.Expression): boolean {
	const sig = b.checker.getTypeAtLocation(e).getCallSignatures()[0];
	return !!sig && isPromiseType(b.nativeOfType(sig.getReturnType(), e));
}
