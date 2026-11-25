// The keys an object or class defines: declared and defined fields, keys read by name, and what construction defines.
import ts from 'typescript';
import { hasStatic, literalKey } from './lang.ts';
import type { ValueStates } from './states/value-states.ts';
import type { ShapeFacts } from './shapes.ts';

/** Where `Object.defineProperty`/`defineProperties` may give a program class's declared field a descriptor (`JSDefinable`). */
export interface DefinedKeys {
	/** Keys named on an object of no class type: any program class's field of that name may be the one defined. */
	readonly untyped: ReadonlySet<string>;
	/** Declared fields a literal key names on an object of a program class. */
	readonly fields: ReadonlySet<ts.Node>;
	/** Every key either names. */
	readonly names: ReadonlySet<string>;
}

/** The program class's own field (or parameter property) the key names on an object of the type, if any. */
export function declaredFieldOf(type: ts.Type, key: string): ts.PropertyDeclaration | ts.ParameterDeclaration | undefined {
	const d = type.getProperty(key)?.valueDeclaration;
	if (!d || d.getSourceFile().isDeclarationFile) return undefined;
	if (ts.isPropertyDeclaration(d) && !hasStatic(d) && ts.isIdentifier(d.name) && ts.isClassLike(d.parent)) return d;
	return ts.isParameter(d) && ts.isConstructorDeclaration(d.parent) && ts.isParameterPropertyDeclaration(d, d.parent) ? d : undefined;
}

export function definedKeysOf(files: readonly ts.SourceFile[], checker: ts.TypeChecker): DefinedKeys {
	const untyped = new Set<string>(),
		fields = new Set<ts.Node>(),
		names = new Set<string>();
	const open = (t: ts.Type) => !!(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.NonPrimitive | ts.TypeFlags.TypeParameter));
	const add = (target: ts.Expression, t: ts.Type, key: string, descriptor: ts.Node | undefined) => {
		if (open(t)) {
			untyped.add(key);
			names.add(key);
			return;
		}
		if (!descriptor || !restrictsField(descriptor)) return;
		// `X.prototype`'s accessors are the class's own (`prototypeDefined`), no object's descriptor.
		if (ts.isPropertyAccessExpression(target) && target.name.text === 'prototype') return;
		const nonNull = checker.getNonNullableType(t);
		for (const part of nonNull.isUnion() ? nonNull.types : [nonNull]) {
			const field = declaredFieldOf(part, key);
			if (field) {
				fields.add(field);
				names.add(key);
			}
		}
	};
	const visit = (n: ts.Node) => {
		if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === 'Object' && n.arguments.length >= 2) {
			const [target, key] = n.arguments,
				t = checker.getTypeAtLocation(target);
			if (n.expression.name.text === 'defineProperty') {
				const k = checker.getTypeAtLocation(key);
				for (const part of k.isUnion() ? k.types : [k]) if (part.isStringLiteral()) add(target, t, part.value, n.arguments[2]);
			} else if (n.expression.name.text === 'defineProperties' && ts.isObjectLiteralExpression(key)) {
				for (const p of key.properties) {
					const k = p.name && literalKey(p.name, checker);
					if (k !== null && k !== undefined) add(target, t, k, ts.isPropertyAssignment(p) ? p.initializer : p);
				}
			}
		}
		ts.forEachChild(n, visit);
	};
	for (const sf of files) if (!sf.isDeclarationFile) visit(sf);
	return { untyped, fields, names };
}

/** A descriptor that may leave a field other than a writable, enumerable, configurable value: an accessor, read-only, hidden or fixed. */
export function restrictsField(descriptor: ts.Node): boolean {
	return (
		!ts.isObjectLiteralExpression(descriptor) ||
		descriptor.properties.some((p) => {
			const name = p.name && !ts.isComputedPropertyName(p.name) ? p.name.getText().replace(/^['"]|['"]$/g, '') : undefined;
			if (name === 'get' || name === 'set') return true;
			if (name === 'value') return false;
			if (name === 'writable' || name === 'enumerable' || name === 'configurable') return !ts.isPropertyAssignment(p) || p.initializer.kind !== ts.SyntaxKind.TrueKeyword;
			return !name;
		})
	);
}

/** The field `definable` lists for its class that `key` of the object names, if any (`const { field } = obj`, `obj['field']`). */
export function definedFieldOf(object: ts.Node, key: string, checker: ts.TypeChecker, defined: DefinedKeys, definable: (cls: ts.ClassLikeDeclaration) => string[]): ts.NamedDeclaration | undefined {
	if (!defined.names.has(key)) return undefined;
	const d = checker.getNonNullableType(checker.getTypeAtLocation(object)).getProperty(key)?.valueDeclaration;
	const cls = d && (ts.isPropertyDeclaration(d) ? d.parent : ts.isParameter(d) && ts.isConstructorDeclaration(d.parent) ? d.parent.parent : undefined);
	return cls && ts.isClassLike(cls) && definable(cls).includes(key) ? (d as ts.NamedDeclaration) : undefined;
}

/**
 * `obj.field` of a field its object may give a descriptor (`defines`), read or written by key so that the descriptor
 * applies. The class's own constructor writes `this.field` directly: nothing has been defined on the object it is making.
 */
export function readByKey(e: ts.PropertyAccessExpression, defines: (object: ts.Node, key: string) => boolean): boolean {
	if (e.expression.kind === ts.SyntaxKind.SuperKeyword || !defines(e.expression, e.name.text)) return false;
	if (e.expression.kind === ts.SyntaxKind.ThisKeyword) {
		const fn = ts.getThisContainer(e, false, false);
		if (ts.isConstructorDeclaration(fn) || ts.isPropertyDeclaration(fn)) return false;
	}
	return true;
}

/** The class's own fields `defined` lists: their objects may give them a descriptor. */
const definedTables = new WeakMap<ValueStates, DefinedKeys>();

/** App mode: the fields `Object.defineProperty` may give a descriptor; none in a library. */
export function definedKeysIn(states: ValueStates): DefinedKeys {
	let t = definedTables.get(states);
	if (!t) definedTables.set(states, (t = states.backend.library ? { untyped: new Set(), fields: new Set(), names: new Set() } : definedKeysOf(states.backend.sourceFiles, states.backend.checker)));
	return t;
}

/** The class's own fields whose objects `Object.defineProperty` may give a descriptor (`JSDefinable`). */
export function definedNamesOf(cls: ts.ClassLikeDeclaration, states: ValueStates, facts: ShapeFacts): string[] {
	const b = states.backend,
		file = cls.getSourceFile(),
		defined = definedKeysIn(states);
	if (b.library || !defined.names.size || file.isDeclarationFile || b.pluginFiles.has(file.fileName) || !facts.descriptors(cls)) return [];
	return definedFieldNames(cls, defined);
}

export function definedFieldNames(cls: ts.ClassLikeDeclaration, defined: DefinedKeys): string[] {
	if (!defined.names.size) return [];
	const ctor = cls.members.find(ts.isConstructorDeclaration);
	const own = [...cls.members.filter((m) => ts.isPropertyDeclaration(m) && !hasStatic(m) && ts.isIdentifier(m.name)), ...(ctor?.parameters.filter((p) => ts.isParameterPropertyDeclaration(p, ctor)) ?? [])];
	return own.filter((m) => defined.fields.has(m) || defined.untyped.has((m.name as ts.Identifier).text)).map((m) => (m.name as ts.Identifier).text);
}

/** `Object.defineProperty(this, …)` in its class's constructor or a field's initializer, which read the fields directly. */
export function definesDuringConstruction(target: ts.Expression): boolean {
	let t: ts.Expression = target;
	while (ts.isParenthesizedExpression(t) || ts.isAsExpression(t) || ts.isNonNullExpression(t) || ts.isTypeAssertionExpression(t)) t = t.expression;
	if (t.kind !== ts.SyntaxKind.ThisKeyword) return false;
	let c: ts.Node | undefined = target.parent;
	while (c && (ts.isArrowFunction(c) || !(ts.isFunctionLike(c) || ts.isPropertyDeclaration(c) || ts.isClassStaticBlockDeclaration(c) || ts.isSourceFile(c)))) c = c.parent;
	return !!c && (ts.isConstructorDeclaration(c) || ts.isPropertyDeclaration(c));
}

/**
 * `Object.assign(target, …, list)` onto an object that is no array: TypeScript types the result as the array (it reduces
 * `{} & T[]`), while the value is the target holding the elements under index keys "0", "1", ….
 */
export function assignsArrayIntoObject(e: ts.CallExpression, checker: ts.TypeChecker): boolean {
	const arrayLike = (x: ts.Expression) => {
		const t = checker.getTypeAtLocation(x);
		return checker.isArrayType(t) || checker.isTupleType(t);
	};
	const target = e.arguments[0];
	return !!target && !(checker.getTypeAtLocation(target).flags & ts.TypeFlags.Any) && !arrayLike(target) && e.arguments.slice(1).some((x) => !ts.isSpreadElement(x) && arrayLike(x));
}

/** An object literal's type joined with an array's (`Object.assign({ a: 1 }, list)`): the literal's object, holding index keys. */
export function literalOverArray(t: ts.Type, checker: ts.TypeChecker): boolean {
	return t.isIntersection() && t.types.some((u) => !!u.getSymbol()?.declarations?.some(ts.isObjectLiteralExpression)) && t.types.some((u) => checker.isArrayType(u) || checker.isTupleType(u));
}
