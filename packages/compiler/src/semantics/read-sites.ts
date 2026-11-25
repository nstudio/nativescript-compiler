// Reads a backend may answer from what it kept, at the read's site or per class, instead of the full lookup: each gives
// exactly what the lookup gives, so none is a JavaScript-semantics decision, only which reads may be kept.
import ts from 'typescript';
import { isStatic } from './throws.ts';

/**
 * A field read through its instance's prototype chain under its constant name (a field under a registered property's
 * name, or one a prototype accessor or value backs): what the chain holds for the name changes only with the
 * instance's class and the prototypes' keys, so the read may keep what it found for the class it last read until the
 * prototypes' keys change.
 */
export function prototypeReadSite(field: ts.PropertyDeclaration): boolean {
	return !isStatic(field) && !ts.isComputedPropertyName(field.name);
}

/**
 * Whether a class declares an instance member a symbol may name: a computed name other than a string or number
 * literal, or a name holding a NUL (how the kits spell a symbol's key). An instance whose class and superclasses
 * declare none holds a symbol-keyed property only as its own or on its prototype chain, so a read or test of a symbol
 * key may skip the class's members.
 */
export function namesMembersBySymbol(cls: ts.ClassLikeDeclaration): boolean {
	return cls.members.some((m) => {
		if (isStatic(m) || !m.name) return false;
		if (!ts.isComputedPropertyName(m.name)) return (ts.isStringLiteral(m.name) || ts.isIdentifier(m.name)) && m.name.text.includes('\0');
		const e = m.name.expression;
		return !(ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isNumericLiteral(e)) || e.text.includes('\0');
	});
}
