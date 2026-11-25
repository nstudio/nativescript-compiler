// Constructions and Intl members neither runtime provides: each decision made here, both backends report it as given.
import ts from 'typescript';
import { INTL_MODELLED, intlConstructor } from './lang.ts';
import { isLibDeclaration } from './ast.ts';
import type { RefusalId } from './refusals.ts';

/** A construct the build refuses: the refusal's kind, the construct as its message names it, and where it is. */
export interface Refused {
	id: RefusalId;
	what: string;
	node: ts.Node;
}

/** What a decision reads of the translator: library mode (the core kit) refuses none of these. */
interface Context {
	checker: ts.TypeChecker;
	library: unknown;
	resolve(n: ts.Node): ts.Symbol | undefined;
}

/**
 * The `new` expression as written: a backend may construct through a copy of it (`new (C as any)()` as `new C()`), whose
 * callee is not the one TypeScript typed.
 */
const written = (e: ts.NewExpression) => ts.getOriginalNode(e, ts.isNewExpression) ?? e;

/** `new f()` of a function that is no class (a function declaration or expression, typed with no construct signature). */
export function functionNew(c: Context, made: ts.NewExpression): Refused | undefined {
	if (c.library) return undefined;
	const e = written(made);
	const t = c.checker.getTypeAtLocation(e.expression);
	if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) return undefined;
	if (t.getConstructSignatures().length || !t.getCallSignatures().length) return undefined;
	return { id: 'function-new', what: '`new` of a function', node: e };
}

/** The library's constructor types of the primitives' wrapper objects: the primitive each wraps. */
const WRAPPED: Readonly<Record<string, string>> = { StringConstructor: 'String', NumberConstructor: 'Number', BooleanConstructor: 'Boolean' };

/** `new String(x)`, `new Number(x)`, `new Boolean(x)` (or of a variable holding one of them): a wrapper object, which compiled code holds as no object. */
export function wrapperObject(c: Context, made: ts.NewExpression): Refused | undefined {
	if (c.library) return undefined;
	const e = written(made);
	const ctor = c.checker.getTypeAtLocation(e.expression).getSymbol();
	const name = ctor && ctor.declarations?.length && ctor.declarations.every(isLibDeclaration) && Object.hasOwn(WRAPPED, ctor.name) ? WRAPPED[ctor.name] : undefined;
	return name ? { id: 'wrapper-object', what: `a wrapper object (new ${name})`, node: e } : undefined;
}

/**
 * `Intl.X` read where the runtimes have no `X`, or where `X` is one of their constructors read other than as the callee
 * of `new` or a call (`Intl.NumberFormat.supportedLocalesOf`, `Intl.DateTimeFormat` as a value).
 */
export function unmodelledIntl(c: Context, e: ts.PropertyAccessExpression): Refused | undefined {
	if (c.library || !ts.isIdentifier(e.expression) || e.expression.text !== 'Intl' || !isLibDeclaration(c.resolve(e.expression)?.declarations?.[0])) return undefined;
	const name = e.name.text;
	if (!Object.hasOwn(INTL_MODELLED, name)) return { id: 'library-member', what: `Intl.${name}`, node: e };
	if (intlConstructor(e, c.checker) && (ts.isNewExpression(e.parent) || ts.isCallExpression(e.parent)) && e.parent.expression === e) return undefined;
	const member = ts.isPropertyAccessExpression(e.parent) && e.parent.expression === e ? e.parent : undefined;
	if (member) return { id: member.name.text === 'prototype' ? 'builtin-prototype' : 'library-member', what: `Intl.${name}.${member.name.text}`, node: member };
	return { id: 'function-value', what: `Intl.${name}`, node: e };
}

/** A member of an `Intl.NumberFormat` or `Intl.DateTimeFormat` the runtimes' formatters do not have (`formatToParts`, `nf['formatRange']`). */
export function unmodelledIntlMember(c: Context, e: ts.PropertyAccessExpression | ts.ElementAccessExpression): Refused | undefined {
	if (c.library) return undefined;
	const key = ts.isPropertyAccessExpression(e) ? e.name.text : ts.isStringLiteralLike(e.argumentExpression) ? e.argumentExpression.text : undefined;
	if (key === undefined) return undefined;
	const sym = c.checker.getTypeAtLocation(e.expression).getSymbol();
	if (!sym || !sym.declarations?.length || !sym.declarations.every(isLibDeclaration)) return undefined;
	const owner = /^Intl\.(\w+)$/.exec(c.checker.getFullyQualifiedName(sym))?.[1];
	if (!owner || !Object.hasOwn(INTL_MODELLED, owner) || (INTL_MODELLED[owner as keyof typeof INTL_MODELLED] as readonly string[]).includes(key)) return undefined;
	return { id: 'library-member', what: `Intl.${owner}.prototype.${key}`, node: e };
}
