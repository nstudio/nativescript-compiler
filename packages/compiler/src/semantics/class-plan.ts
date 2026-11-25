// A class's layout, decided once for both class emitters (swift/classes.ts, kotlin/classes.ts): its program base, its
// constructor with the parameter properties it assigns and where it calls `super(…)`, the members its bases declare,
// its accessors paired into properties, and the conversions JavaScript calls on its instances without the program
// naming them. Each emitter spells the plan in its platform's phases (Swift's two-phase initializer, Kotlin's property
// initializers).
import ts from 'typescript';
import { inheritsToString, programBase, toStringGivesNonString } from './classes.ts';
import { hasModifier, isWriteTarget } from './ast.ts';
import { isStatic } from './throws.ts';

export interface ClassPlan {
	/** The program class the class extends (not a declaration file's). */
	readonly base: ts.ClassLikeDeclaration | undefined;
	/** The constructor with a body, and the parameters it declares as properties (`constructor(private x: T)`), in order. */
	readonly ctor: ts.ConstructorDeclaration | undefined;
	readonly paramProps: readonly ts.ParameterDeclaration[];
	/**
	 * The constructor assigns its parameter properties before the field initializers it runs: TypeScript's emit where
	 * class fields are assigned (`useDefineForClassFields` off). Where they are defined (ES2022), the initializers run
	 * first, as `super()` returns, and the parameter properties are assigned after them.
	 */
	readonly paramPropsFirst: boolean;
	/**
	 * The field initializers that run in the constructor after the parameter properties are assigned (`paramPropsFirst`)
	 * and may read them: those using `this` other than in a function they make.
	 */
	readonly initializersAfterParamProps: readonly ts.PropertyDeclaration[];
	/** The constructor's `super(…)` statement: its index among the body's statements (-1: none) and its call. */
	readonly superAt: number;
	readonly superCall: ts.CallExpression | null;
	/**
	 * The names of the instance members its program base classes declare, which its own members of those names override:
	 * no static member, and no method declared without a body that is not abstract (an overload's signature, an optional
	 * method), which no instance has.
	 */
	readonly inherited: ReadonlySet<string>;
	/** The static methods with a body its program base classes declare, by name: the nearest base's. */
	readonly inheritedStatics: ReadonlyMap<string, ts.MethodDeclaration>;
	/** The class's own `toString()`, which JavaScript's string conversion calls, where no base class declares one. */
	readonly toString: boolean;
	/** `toString` where that method may give no string (`toStringGivesNonString`): conversion goes on to valueOf. */
	readonly objectToString: boolean;
	/**
	 * The class's own `valueOf()` and `toJSON(key?)`, which conversion to a primitive and `JSON.stringify` call, where no
	 * base class's instances have one already: a base's static method of the name, or one without a body, is none.
	 */
	readonly valueOf: ts.MethodDeclaration | undefined;
	readonly toJSON: ts.MethodDeclaration | undefined;
	/**
	 * Get and set accessors paired into one property each, by name; a well-known symbol's accessor (`get
	 * [Symbol.toStringTag]()`) under its kit member, `member` naming it from the computed name (null: not a symbol's).
	 */
	readonly accessors: ReadonlyMap<string, AccessorPair>;
	/** The first accessor named by a symbol other than `Symbol.toStringTag`'s getter: no native property can be named by it. */
	readonly symbolAccessor: ts.PropertyName | undefined;
}

export interface AccessorPair {
	get?: ts.GetAccessorDeclaration;
	set?: ts.SetAccessorDeclaration;
}

/**
 * Whether the program's class fields are assigned in the constructor (`useDefineForClassFields` off): the app's
 * configuration says so, or the code is checked and built as core is (lenient), which assigns them.
 */
export function assignsClassFields(t: { readonly assignFields: boolean; readonly lenient: boolean }): boolean {
	return t.assignFields || t.lenient;
}

const PARAMETER_PROPERTY = new Set([ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.ReadonlyKeyword]);

/** The constructor with a body, and the parameters it declares as properties. */
function parameterProperties(cls: ts.ClassLikeDeclaration): { ctor: ts.ConstructorDeclaration | undefined; paramProps: ts.ParameterDeclaration[] } {
	const ctor = cls.members.find((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m) && !!m.body);
	return { ctor, paramProps: (ctor?.parameters ?? []).filter((p) => ts.canHaveModifiers(p) && !!ts.getModifiers(p)?.some((m) => PARAMETER_PROPERTY.has(m.kind))) };
}

/** Whether evaluating `e` may use `this` (or `super`): outside a function it makes, or in an arrow function it calls at once. */
function runsWithThis(e: ts.Node): boolean {
	const visit = (n: ts.Node): boolean => {
		if (n.kind === ts.SyntaxKind.ThisKeyword || n.kind === ts.SyntaxKind.SuperKeyword) return true;
		if ((ts.isFunctionLike(n) || ts.isClassLike(n)) && !(ts.isArrowFunction(n) && isCalledAtOnce(n))) return false;
		return !!ts.forEachChild(n, visit);
	};
	return visit(e);
}

/** A function expression called where it is made (`(() => …)()`). */
function isCalledAtOnce(fn: ts.Node): boolean {
	let x: ts.Node = fn;
	while (ts.isParenthesizedExpression(x.parent)) x = x.parent;
	return ts.isCallExpression(x.parent) && x.parent.expression === x;
}

/** The instance fields whose initializers may use `this`, in order. */
function initializersWithThis(cls: ts.ClassLikeDeclaration): ts.PropertyDeclaration[] {
	return cls.members.filter((m): m is ts.PropertyDeclaration => ts.isPropertyDeclaration(m) && !isStatic(m) && !!m.initializer && runsWithThis(m.initializer));
}

/**
 * The fields of its class the initializer of `m` may read before the constructor sets them: each it reads as
 * `this.<field>`, or every field (`'all'`) where it uses `this` or `super` any other way (a call, a write, `this` passed
 * on). Not a base class's field, nor one of its own initialized before it.
 */
function readsUnset(m: ts.PropertyDeclaration, checker: ts.TypeChecker): Set<ts.Declaration> | 'all' {
	const cls = m.parent;
	const read = new Set<ts.Declaration>();
	const visit = (n: ts.Node): boolean => {
		if (n.kind === ts.SyntaxKind.ThisKeyword || n.kind === ts.SyntaxKind.SuperKeyword) {
			const access = n.parent;
			const d = ts.isPropertyAccessExpression(access) && access.expression === n ? checker.getSymbolAtLocation(access.name)?.valueDeclaration : undefined;
			const field = !!d && (ts.isPropertyDeclaration(d) || (ts.isParameter(d) && ts.isParameterPropertyDeclaration(d, d.parent)));
			const set = field && (ts.isPropertyDeclaration(d) ? d.parent !== cls || (!!d.initializer && d.end <= m.pos) : d.parent.parent !== cls);
			const p = ts.walkUpParenthesizedExpressions(access.parent);
			if (!field || (ts.isCallExpression(p) && ts.skipOuterExpressions(p.expression) === access) || isWriteTarget(access)) return true;
			if (!set) read.add(d!);
			return false;
		}
		if ((ts.isFunctionLike(n) || ts.isClassLike(n)) && !(ts.isArrowFunction(n) && isCalledAtOnce(n))) return false;
		return !!ts.forEachChild(n, visit);
	};
	return visit(m.initializer!) ? 'all' : read;
}

const readEarly = new WeakMap<ts.ClassLikeDeclaration, ReadonlySet<ts.Declaration> | 'all'>();

/**
 * The fields of `cls` a field initializer may read before the constructor sets them (`y = this.x`, every field for
 * `y = this.read()`): initializers run before the constructor's body, and where class fields are defined, before its
 * parameter properties are assigned too. What they read then is undefined.
 */
export function fieldsReadEarly(cls: ts.ClassLikeDeclaration, checker: ts.TypeChecker): ReadonlySet<ts.Declaration> | 'all' {
	let made = readEarly.get(cls);
	if (!made) {
		const read = new Set<ts.Declaration>();
		for (const m of cls.members) {
			if (!ts.isPropertyDeclaration(m) || isStatic(m) || !m.initializer) continue;
			const r = readsUnset(m, checker);
			if (r === 'all') {
				made = 'all';
				break;
			}
			for (const d of r) read.add(d);
		}
		readEarly.set(cls, (made ??= read));
	}
	return made;
}

/** Whether a field initializer of its class may read `field` before the constructor sets it (`fieldsReadEarly`). */
export function fieldReadEarly(field: ts.PropertyDeclaration | ts.ParameterDeclaration, cls: ts.ClassLikeDeclaration, checker: ts.TypeChecker): boolean {
	const read = fieldsReadEarly(cls, checker);
	return read === 'all' || read.has(field);
}

/** The parameter properties a field initializer may read before the constructor assigns them (`fieldsReadEarly`). */
export function parameterPropertiesReadEarly(cls: ts.ClassLikeDeclaration, assignFields: boolean, checker: ts.TypeChecker): readonly ts.ParameterDeclaration[] {
	return assignFields ? [] : parameterProperties(cls).paramProps.filter((p) => fieldReadEarly(p, cls, checker));
}

/**
 * The plan of `cls`. `member` is the kit member a computed name names (a well-known symbol's, a symbol constant's), null
 * for any other name. `assignFields`: the app's configuration assigns class fields (`useDefineForClassFields` off).
 */
export function classPlanOf(cls: ts.ClassLikeDeclaration, checker: ts.TypeChecker, member: (name: ts.PropertyName) => string | null, assignFields: boolean): ClassPlan {
	const { ctor, paramProps } = parameterProperties(cls);
	const statements = ctor?.body?.statements ?? ts.factory.createNodeArray<ts.Statement>();
	const superAt = statements.findIndex((s) => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && s.expression.expression.kind === ts.SyntaxKind.SuperKeyword);
	const accessors = new Map<string, AccessorPair>();
	let symbolAccessor: ts.PropertyName | undefined;
	for (const m of cls.members) {
		if (!ts.isGetAccessorDeclaration(m) && !ts.isSetAccessorDeclaration(m)) continue;
		const keyed = member(m.name);
		if (keyed !== null && (keyed !== 'jsToStringTag' || ts.isSetAccessorDeclaration(m))) symbolAccessor ??= m.name;
		const key = keyed ?? m.name.getText();
		const a = accessors.get(key) ?? {};
		if (ts.isGetAccessorDeclaration(m)) a.get = m;
		else a.set = m;
		accessors.set(key, a);
	}
	const inherited = new Set<string>();
	const inheritedStatics = new Map<string, ts.MethodDeclaration>();
	const implemented = new Set<string>();
	for (let b = programBase(cls, checker); b; b = programBase(b, checker))
		for (const m of b.members) {
			if (!m.name) continue;
			const name = m.name.getText();
			if (isStatic(m)) {
				if (ts.isMethodDeclaration(m) && m.body && !inheritedStatics.has(name)) inheritedStatics.set(name, m);
				continue;
			}
			if (ts.isMethodDeclaration(m) && !m.body && !hasModifier(m, ts.SyntaxKind.AbstractKeyword)) continue;
			inherited.add(name);
			if (ts.isMethodDeclaration(m) && m.body) implemented.add(name);
		}
	const ownToString = cls.members.find((m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m) && m.name.getText() === 'toString' && !m.parameters.length);
	const own = (name: string, params: number) => (implemented.has(name) ? undefined : cls.members.find((m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m) && !isStatic(m) && !!m.body && m.name.getText() === name && m.parameters.length <= params));
	return {
		base: programBase(cls, checker),
		ctor,
		paramProps,
		paramPropsFirst: assignFields,
		initializersAfterParamProps: assignFields && paramProps.length ? initializersWithThis(cls) : [],
		superAt,
		superCall: superAt < 0 ? null : ((statements[superAt] as ts.ExpressionStatement).expression as ts.CallExpression),
		inherited,
		inheritedStatics,
		toString: !!ownToString && !inheritsToString(cls, checker) && !toStringGivesNonString(ownToString, checker),
		objectToString: !!ownToString && !inheritsToString(cls, checker) && toStringGivesNonString(ownToString, checker),
		valueOf: own('valueOf', 0),
		toJSON: own('toJSON', 1),
		accessors,
		symbolAccessor,
	};
}
