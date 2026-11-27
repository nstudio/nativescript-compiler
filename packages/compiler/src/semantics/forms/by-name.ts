// Calls and classes script reaches by name (a framework calling a method by its name, viewed classes): their slots open to what such a caller gives.
import ts from 'typescript';
import { O, U, declarationFile, hasStatic, unionOfObjects, untyped, type Owner, type Slot } from './flow.ts';
import type { Forms } from './forms.ts';
import { LIB_FILE, isTemplateMethod } from '../trust.ts';
import { implementedInterfaces, literalKey, mergedInterfaceMemberOf } from '../lang.ts';
import { programBase } from '../classes.ts';

export const byNameCallsMethods = {
	/**
	 * Members the framework may call where the program can't see (`FrameworkModel.calledByFramework`), but the template
	 * glue this compiler writes. Other decorators (`@CSSType`, `@profile`) register or wrap a class or method and call
	 * nothing; a platform calls a subclass of its class (`extendsNative`).
	 */
	frameworkCalled(this: Forms, cls: ts.ClassLikeDeclaration, m: ts.MethodDeclaration | ts.SetAccessorDeclaration): boolean {
		if (isTemplateMethod(m)) return false;
		return !!this.calledByFramework?.(cls, m, this.checker);
	},

	/** A call through a computed key (`this[name](x)`, `obj[k].call(o, x)`): see `calledByName`. */
	placeCallByName(this: Forms, call: ts.CallExpression): void {
		let callee = ts.skipOuterExpressions(call.expression);
		if (ts.isPropertyAccessExpression(callee) && (callee.name.text === 'call' || callee.name.text === 'apply')) callee = ts.skipOuterExpressions(callee.expression);
		if (!ts.isElementAccessExpression(callee)) return;
		const key = ts.skipOuterExpressions(callee.argumentExpression);
		if (ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)) return;
		const t = this.checker.getTypeAtLocation(key),
			parts = t.isUnion() ? t.types : [t];
		const names = parts.every((x) => x.isStringLiteral()) ? new Set(parts.map((x) => (x as ts.StringLiteralType).value)) : null;
		for (const { owner, statics } of this.ownersOf(callee.expression)) this.calledByName.push({ owner, names, statics });
	},

	/**
	 * The declarations whose members a receiver's are: classes (`statics` where it is the class itself), interfaces, type
	 * literals and object literals of the program. An untyped receiver is followed to its variable's initializer
	 * (`const self: any = this`); one that can't be is null.
	 */
	ownersOf(this: Forms, e: ts.Expression, depth = 0): { owner: Owner | null; statics: boolean }[] {
		const c = this.checker,
			x = ts.skipOuterExpressions(e);
		let t = c.getNonNullableType(c.getTypeAtLocation(x));
		if (t.flags & ts.TypeFlags.TypeParameter) t = c.getBaseConstraintOfType(t) ?? t;
		if (untyped(t)) {
			const d = ts.isIdentifier(x) ? c.getSymbolAtLocation(x)?.valueDeclaration : undefined;
			return d && ts.isVariableDeclaration(d) && d.initializer && depth < 4 ? this.ownersOf(d.initializer, depth + 1) : [{ owner: null, statics: false }];
		}
		const owners: { owner: Owner; statics: boolean }[] = [];
		for (const part of t.isUnionOrIntersection() ? t.types : [t]) {
			for (const d of part.getSymbol()?.declarations ?? []) {
				if (declarationFile(d)) continue;
				if (ts.isClassLike(d)) owners.push({ owner: d, statics: part.getConstructSignatures().length > 0 });
				else if (ts.isInterfaceDeclaration(d) || ts.isTypeLiteralNode(d) || ts.isObjectLiteralExpression(d)) owners.push({ owner: d, statics: false });
			}
		}
		return owners;
	},

	/**
	 * The parameters of members called by a computed key are entry points: the owner's members the key may name, and a
	 * class's subclasses' (an override is what the call reaches); every non-strict class's where the receiver is untraced.
	 */
	openCalledByName(this: Forms): void {
		const c = this.checker;
		const derives = (t: ts.Type, owner: Owner, depth = 0): boolean => depth < 32 && t.isClassOrInterface() && c.getBaseTypes(t).some((b) => !!b.getSymbol()?.declarations?.includes(owner as ts.Declaration) || derives(b, owner, depth + 1));
		for (const { owner, names, statics } of this.calledByName) {
			const owners: Owner[] = owner === null ? this.classes.filter((x) => !this.strict(x)) : ts.isClassLike(owner) ? [owner, ...this.classes.filter((x) => x !== owner && derives(c.getTypeAtLocation(x.name ?? x), owner))] : [owner];
			for (const o of owners) {
				for (const m of ts.isObjectLiteralExpression(o) ? o.properties : o.members) {
					if (!m.name || hasStatic(m) !== statics) continue;
					const name = literalKey(m.name, c);
					if (name === null || (names && !names.has(name))) continue;
					const fn = ts.isPropertyAssignment(m) ? this.functionDeclarationOf(m.initializer) : ts.isMethodDeclaration(m) || ts.isMethodSignature(m) ? m : null;
					if (fn) this.openParameters(fn);
				}
			}
		}
	},

	/**
	 * The program's classes whose instances script reaches by name (methods and accessors): a value of the class
	 * placed in an untyped slot (one of the program's, or a library's `any` other than TypeScript's own lib), asserted to
	 * `any`/`unknown`, the receiver of a member access by a key the program doesn't spell, or tested with `in`. A class's
	 * whole hierarchy goes with it: a subclass's object is held as its base, and a base's members are the subclass's too.
	 * A type parameter reached so reaches the classes of the arguments its function is called with.
	 */
	byNameClasses(this: Forms): ReadonlySet<ts.ClassLikeDeclaration> {
		this.build();
		return this.byName!;
	},

	/** The `byNameClasses` that only `keyedFile`'s placements reach by name: script reads them by `memberKeys` alone. */
	keyedByNameClasses(this: Forms): ReadonlySet<ts.ClassLikeDeclaration> {
		this.build();
		return this.keyedByName;
	},

	findByName(this: Forms): void {
		const c = this.checker,
			found = new Set<ts.ClassLikeDeclaration>(),
			statics = this.byNameStatic,
			keyed = new Set<ts.ClassLikeDeclaration>();
		const generic = new Set<ts.Symbol>(),
			calls: (ts.CallExpression | ts.NewExpression)[] = [];
		const keyedFile = this.keyedFile;
		const keyedSlot = (d: ts.Declaration | null) => !!d && !!keyedFile && (keyedFile(d.getSourceFile()) || (!!(d as ts.NamedDeclaration).name && (d as ts.NamedDeclaration).name!.getText() === 'bindingContext' && !ts.isParameter(d)));
		const classOf = (e: ts.Expression, keysOnly = false) => {
			let t = c.getNonNullableType(c.getTypeAtLocation(e));
			if (t.flags & ts.TypeFlags.TypeParameter) {
				const s = t.getSymbol();
				if (s) generic.add(s);
				t = c.getBaseConstraintOfType(t) ?? t;
			}
			for (const part of t.isUnionOrIntersection() ? t.types : [t]) {
				const into = part.getConstructSignatures().length ? statics : keysOnly ? keyed : found;
				for (const d of part.getSymbol()?.declarations ?? []) {
					if (ts.isClassLike(d) && !declarationFile(d)) into.add(d);
					else if (ts.isObjectLiteralExpression(d)) this.byNameLiterals.add(d);
				}
			}
		};
		const open = (slots: Slot[]) =>
			slots.filter((s) => {
				const r = this.find(s);
				// A part's type is the value's own (an array literal's elements), not the type its holder declares.
				return !!r.type && (untyped(r.type) || (!!r.decl && unionOfObjects(r.type))) && !(r.decl && LIB_FILE.test(r.decl.getSourceFile().fileName));
			});
		// Placed by generated code, or only into `bindingContext`s and the generated code's own slots.
		const byKeys = (x: ts.Expression, slots: Slot[]) => !!keyedFile && (keyedFile(x.getSourceFile()) || (!this.heldUntyped.has(x) && slots.every((s) => keyedSlot(s.decl))));
		for (const [x, slots] of this.placed) {
			const untypedSlots = open(slots);
			if (untypedSlots.length) classOf(x, byKeys(x, untypedSlots));
		}
		for (const x of this.placedUntyped) classOf(x, byKeys(x, open(this.placed.get(x) ?? [])));
		const visit = (n: ts.Node): void => {
			if ((ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) && untyped(c.getTypeAtLocation(n))) classOf(n.expression);
			if (ts.isElementAccessExpression(n)) {
				const key = ts.skipOuterExpressions(n.argumentExpression);
				if (!ts.isStringLiteralLike(key) && !ts.isNumericLiteral(key) && c.getTypeAtLocation(key).flags & ts.TypeFlags.StringLike) {
					for (const { owner, statics: s } of this.ownersOf(n.expression)) if (owner && ts.isClassLike(owner)) (s ? statics : found).add(owner);
					if (c.getTypeAtLocation(n.expression).flags & ts.TypeFlags.TypeParameter) classOf(n.expression);
				}
			}
			if (ts.isPropertyAccessExpression(n) && !ts.isPrivateIdentifier(n.name) && unionOfObjects(c.getNonNullableType(c.getTypeAtLocation(n.expression)))) {
				for (const { owner, statics: s } of this.ownersOf(n.expression)) if (owner && ts.isClassLike(owner)) (s ? statics : found).add(owner);
			}
			if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InKeyword) classOf(n.right);
			// A member the static type only declares (`m?(): T;`, a merged interface's): a subclass's method of the name answers it.
			if (ts.isPropertyAccessExpression(n) && mergedInterfaceMemberOf(n, c)) classOf(n.expression);
			if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.arguments[0] && !ts.isSpreadElement(n.arguments[0])) {
				const obj = n.expression.expression.text,
					fn = n.expression.name.text;
				if ((obj === 'Object' && (fn === 'assign' || fn === 'defineProperty' || fn === 'defineProperties')) || (obj === 'Reflect' && (fn === 'set' || fn === 'defineProperty'))) classOf(n.arguments[0]);
			}
			if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && n.arguments?.length) calls.push(n);
			ts.forEachChild(n, visit);
		};
		for (const f of this.files) if (!f.isDeclarationFile) visit(f);
		// `f<T>(x: T) { (x as any)[k]() }`: the arguments given for `x`, through other generic functions passing it on.
		for (let size = 0; generic.size > size;) {
			size = generic.size;
			for (const call of calls) {
				const decl = c.getResolvedSignature(call)?.declaration;
				if (!decl || ts.isJSDocSignature(decl)) continue;
				decl.parameters.forEach((p, k) => {
					const arg = call.arguments![k];
					if (!arg || p.dotDotDotToken || !p.type || !ts.isTypeReferenceNode(p.type)) return;
					const s = c.getSymbolAtLocation(p.type.typeName);
					if (s && generic.has(s)) classOf(arg);
				});
			}
		}
		const own = (t: ts.Type) => t.getSymbol()?.declarations?.find((d): d is ts.ClassLikeDeclaration => ts.isClassLike(d) && !declarationFile(d));
		// Bases go with a class: a subclass's object is held as its base, and a subclass's statics include its bases'.
		for (const set of [found, statics, keyed]) {
			for (const cls of [...set]) {
				for (let t: ts.Type | undefined = c.getTypeAtLocation(cls.name ?? cls); t?.isClassOrInterface(); t = c.getBaseTypes(t)[0]) {
					const d = own(t);
					if (!d) break;
					set.add(d);
				}
			}
		}
		const derived = (cls: ts.ClassLikeDeclaration, depth = 0): boolean => {
			const t = c.getTypeAtLocation(cls.name ?? cls);
			return (
				depth < 32 &&
				t.isClassOrInterface() &&
				c.getBaseTypes(t).some((b) => {
					const d = own(b);
					return !!d && (found.has(d) || derived(d, depth + 1));
				})
			);
		};
		for (const cls of this.classes) if (!found.has(cls) && derived(cls)) found.add(cls);
		const derivedKeyed = (cls: ts.ClassLikeDeclaration, depth = 0): boolean => {
			const t = c.getTypeAtLocation(cls.name ?? cls);
			return (
				depth < 32 &&
				t.isClassOrInterface() &&
				c.getBaseTypes(t).some((b) => {
					const d = own(b);
					return !!d && (keyed.has(d) || derivedKeyed(d, depth + 1));
				})
			);
		};
		for (const cls of this.classes) if (!keyed.has(cls) && derivedKeyed(cls)) keyed.add(cls);
		for (const cls of found) keyed.delete(cls);
		this.keyedByName = keyed;
		this.byName = new Set([...found, ...keyed]);
	},

	/**
	 * The methods of an app object script holds (`byNameClasses`, `byNameLiterals`) are script's to call: any
	 * parameter may be given null or nothing. An override of a declaration file's method keeps its form (a fixed slot).
	 */
	openEscaped(this: Forms): void {
		if (this.library) return;
		const primitive = (d: ts.Declaration): boolean => {
			const t = this.declaredType(d);
			if (!t || t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
			const parts = t.isUnion() ? t.types : [t];
			return parts.length > 0 && parts.every((p) => !(p.flags & ts.TypeFlags.EnumLike)) && (parts.every((p) => !!(p.flags & ts.TypeFlags.StringLike)) || parts.every((p) => !!(p.flags & ts.TypeFlags.NumberLike)) || parts.every((p) => !!(p.flags & ts.TypeFlags.BooleanLike)));
		};
		const openField = (d: ts.PropertyDeclaration | ts.ParameterDeclaration) => {
			if (!this.ownCode(d) || !d.name || ts.isPrivateIdentifier(d.name)) return;
			if (ts.getCombinedModifierFlags(d) & (ts.ModifierFlags.Readonly | ts.ModifierFlags.Ambient | ts.ModifierFlags.Abstract)) return;
			if (!primitive(d)) return;
			this.seed(this.slotFor(d), U | O);
		};
		const open = (members: readonly (ts.ClassElement | ts.ObjectLiteralElementLike)[], statics: boolean, fields: boolean) => {
			for (const m of members) {
				if (!this.ownCode(m) || hasStatic(m) !== statics) continue;
				const fn = ts.isMethodDeclaration(m) ? m : ts.isPropertyAssignment(m) || ts.isPropertyDeclaration(m) ? m.initializer && this.functionDeclarationOf(m.initializer) : null;
				if (fn && 'body' in fn && fn.body) this.openParameters(fn, { escaped: true });
				if (fields && ts.isPropertyDeclaration(m)) openField(m);
				if (fields && !statics && ts.isConstructorDeclaration(m)) {
					for (const p of m.parameters) if (ts.isParameterPropertyDeclaration(p, m)) openField(p);
				}
			}
		};
		for (const cls of this.byName!) open(cls.members, false, !this.keyedByName.has(cls));
		for (const cls of this.byNameStatic) open(cls.members, true, true);
		for (const o of this.byNameLiterals) open(o.properties, false, false);
	},

	/** The program's classes whose statics script reaches by name: the class itself held untyped, or indexed by a key the program doesn't spell. */
	byNameStaticClasses(this: Forms): ReadonlySet<ts.ClassLikeDeclaration> {
		this.byNameClasses();
		return this.byNameStatic;
	},

	/**
	 * The program's classes whose objects are placed where an object type they don't implement is wanted (a type
	 * literal's, or an interface neither the class nor a base names in `implements`, naming some member): that type
	 * reads them by name. By class, the member names the wanted types have; a class's program bases go with it, as its
	 * members are theirs.
	 */
	viewedClasses(this: Forms): ReadonlyMap<ts.ClassLikeDeclaration, ReadonlySet<string>> {
		this.findViewed();
		return this.viewed!;
	},

	/** The program's classes placed themselves where an object type is wanted (`f({ name: string })` given `Widget`): it reads their statics by name. */
	viewedStaticClasses(this: Forms): ReadonlySet<ts.ClassLikeDeclaration> {
		this.findViewed();
		return this.viewedStatic;
	},

	findViewed(this: Forms): void {
		this.build();
		if (this.viewed) return;
		const c = this.checker,
			viewed = new Map<ts.ClassLikeDeclaration, Set<string>>();
		const extendsInterface = (t: ts.Type, wanted: ts.Symbol, depth = 0): boolean => depth < 32 && (t.getSymbol() === wanted || (t.isClassOrInterface() && c.getBaseTypes(t).some((b) => extendsInterface(b, wanted, depth + 1))));
		const names = (cls: ts.ClassLikeDeclaration, wanted: ts.Symbol): boolean => {
			if (!(wanted.declarations ?? []).some(ts.isInterfaceDeclaration)) return false;
			// A library base's own interface (`extends Error` where `Error` is wanted) is the class's too.
			if (extendsInterface(c.getTypeAtLocation(cls.name ?? cls), wanted)) return true;
			for (let b: ts.ClassLikeDeclaration | undefined = cls; b; b = programBase(b, c)) {
				for (const i of implementedInterfaces(c, b)) if (extendsInterface(c.getTypeAtLocation(i), wanted)) return true;
			}
			return false;
		};
		for (const [x, slots] of this.placed) {
			const rawTypes: ts.Type[] = [];
			const at = c.getContextualType(x);
			if (at) rawTypes.push(at);
			for (const s of slots) {
				const rt = this.find(s).type;
				if (rt) rawTypes.push(rt);
			}
			const t = c.getNonNullableType(c.getTypeAtLocation(x));
			for (const raw of rawTypes) {
				const wt = c.getNonNullableType(raw);
				const wanted = wt.getSymbol();
				if (!wanted || !(wanted.flags & (ts.SymbolFlags.TypeLiteral | ts.SymbolFlags.Interface)) || wanted.flags & ts.SymbolFlags.Class || wt.getCallSignatures().length || wt.getConstructSignatures().length || !wt.getProperties().length) continue;
				for (const part of t.isUnion() ? t.types : [t]) {
					const cls = part.getSymbol()?.declarations?.find((d): d is ts.ClassLikeDeclaration => ts.isClassLike(d) && !declarationFile(d));
					if (cls && part.getConstructSignatures().length) {
						for (let b: ts.ClassLikeDeclaration | undefined = cls; b; b = programBase(b, c)) this.viewedStatic.add(b);
						continue;
					}
					if (!cls || names(cls, wanted)) continue;
					const keys = wt.getProperties().map((p) => p.name);
					for (let b: ts.ClassLikeDeclaration | undefined = cls; b; b = programBase(b, c)) {
						const into = viewed.get(b) ?? viewed.set(b, new Set()).get(b)!;
						for (const k of keys) into.add(k);
					}
				}
			}
		}
		this.viewed = viewed;
	},
};

export type ByNameCallsMethods = typeof byNameCallsMethods;
