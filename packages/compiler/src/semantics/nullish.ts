// Which slots may hold null and undefined both, decided once for the program: what each backend's optional alone
// can't tell apart, and the program facts that decide it (what a function gives, which variables code reassigns).
import ts from 'typescript';
import type { FrameworkModel } from '../api/adapter-api.ts';
import { alwaysEnds } from './lang.ts';

/**
 * Strict code's slots that may hold null and undefined both, which a backend's optional alone can't tell apart:
 * one whose type admits both, one typed `T | null` that receives an untyped value, and a field typed `T | null` that may be
 * read before it is written. `held` (variables, parameters, function returns, and the parameters and results of function
 * types, function values and override families that admit both) are held untyped; `fields` (class fields, object-type
 * members) note which of their nils is null. `refused` are such slots neither can cover (an element of an array, Map or
 * Set, a function or native value, a slot whose signature a library or an interface fixes), each with what it is, and
 * with the slot whose value form may cover it instead: the declaration whose type's element it is, or a callback's
 * parameter. `functions` are the parameters and local variables holding a function that may be null or undefined
 * both, which value forms decide (`ValueStates.nullish`), each with what it is where its code tells null from undefined.
 */
export interface NullishSlots {
	held: Set<ts.Declaration>;
	fields: Set<ts.Declaration>;
	refused: [ts.Node, string, NullishCover?][];
	functions: Map<ts.Declaration, string | null>;
}

/** A refused slot a backend may hold by its value form after all (`ValueStates.nullish`). */
export interface NullishCover {
	kind: 'element' | 'value';
	slot: ts.Declaration;
}

/** The first of `refused` inside each top-level statement of `sf`: the declaration a refusal leaves out, its module's others kept. */
export function refusedStatements(sf: ts.SourceFile, refused: NullishSlots['refused']): Map<ts.Statement, [ts.Node, string]> {
	const out = new Map<ts.Statement, [ts.Node, string]>();
	for (const [n, why] of refused.filter(([x]) => x.getSourceFile() === sf).sort(([a], [b]) => a.getStart() - b.getStart())) {
		let st: ts.Node = n;
		while (st.parent && st.parent !== sf) st = st.parent;
		if (!out.has(st as ts.Statement)) out.set(st as ts.Statement, [n, why]);
	}
	return out;
}

export function nullishSlots(checker: ts.TypeChecker, files: readonly ts.SourceFile[], skip: (file: ts.SourceFile) => boolean, formBoth: (d: ts.Declaration) => boolean = () => false, framework: FrameworkModel = {}): NullishSlots {
	const held = new Set<ts.Declaration>(),
		fields = new Set<ts.Declaration>();
	const refused: [ts.Node, string, NullishCover?][] = [];
	const functions = new Map<ts.Declaration, string | null>();
	const refuse = (n: ts.Node, what: string, cover?: NullishCover) => {
		if (!refused.some(([m]) => m === n)) refused.push([n, what, cover]);
	};
	const callable = (t: ts.Type) =>
		parts(t)
			.filter((x) => !(x.flags & nullish))
			.every((x) => x.getCallSignatures().length && !x.getProperties().length);
	const parts = (t: ts.Type) => (t.isUnion() ? t.types : [t]);
	const loose = (t: ts.Type) => parts(t).some((x) => x.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
	const hasNull = (t: ts.Type) => !loose(t) && parts(t).some((x) => x.flags & ts.TypeFlags.Null);
	const both = (t: ts.Type) => hasNull(t) && parts(t).some((x) => x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void));
	// A result typed `void | null` is one callers ignore.
	const bothResult = (t: ts.Type) => both(t) && !parts(t).some((x) => x.flags & ts.TypeFlags.Void);
	const nullish = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void;
	// Held untyped, a function would be called through the runtime and a library or native object reached by name: such
	// slots are refused, covered by their form (`NullishCover`), which holds them typed as one nil or `JSNullish<T>`.
	const primitive = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike | nullish;
	const value = (t: ts.Type) => parts(t).every((x) => x.flags & primitive || (!x.getCallSignatures().length && !!x.getSymbol()?.declarations?.length && x.getSymbol()!.declarations!.every((d) => own(d))));
	const untyped = (e: ts.Expression | undefined) => !!e && e.kind !== ts.SyntaxKind.NullKeyword && !!(checker.getTypeAtLocation(e).flags & ts.TypeFlags.Any);
	const own = (d: ts.Declaration | undefined) => !!d && !d.getSourceFile().isDeclarationFile && !skip(d.getSourceFile());
	const typeOf = (d: ts.Declaration) => {
		const name = (d as ts.NamedDeclaration).name,
			sym = name && checker.getSymbolAtLocation(name);
		return sym ? checker.getTypeOfSymbolAtLocation(sym, d) : checker.getTypeAtLocation(d);
	};
	const text = (t: ts.Type) => checker.typeToString(t);
	const NATIVE = 'a function or library object that may be null or undefined both';
	// Values of more than one kind (`number | string`) are held untyped already, null apart from undefined.
	const oneKind = (t: ts.Type) => {
		const kinds = new Set(
			parts(t)
				.filter((x) => !(x.flags & nullish))
				.map((x) => (x.flags & ts.TypeFlags.StringLike ? 's' : x.flags & ts.TypeFlags.NumberLike ? 'n' : x.flags & ts.TypeFlags.BooleanLike ? 'b' : x.flags & ts.TypeFlags.BigIntLike ? 'g' : (x.getSymbol() ?? x))),
		);
		return kinds.size === 1;
	};
	// A variable only compared, assigned, passed or returned: held untyped, a library object is never reached by name.
	const refs = new Map<ts.Symbol, ts.Identifier[]>();
	const opaque = (d: ts.Declaration) => {
		const sym = (d as ts.NamedDeclaration).name && checker.getSymbolAtLocation((d as ts.NamedDeclaration).name!);
		return (
			!!sym &&
			(refs.get(sym) ?? []).every((r) => {
				let x: ts.Node = r;
				while (ts.isParenthesizedExpression(x.parent) || ts.isNonNullExpression(x.parent) || ts.isAsExpression(x.parent)) x = x.parent;
				const p = x.parent;
				if (ts.isBinaryExpression(p)) return [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(p.operatorToken.kind);
				return ts.isReturnStatement(p) || ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression !== x) || ts.isVariableDeclaration(p) || ts.isIfStatement(p) || ts.isConditionalExpression(p) || ts.isPrefixUnaryExpression(p);
			})
		);
	};
	// A variable or parameter whose code tells null from undefined: compared strictly with either, or `typeof`.
	const observes = (d: ts.Declaration) => {
		const sym = (d as ts.NamedDeclaration).name && checker.getSymbolAtLocation((d as ts.NamedDeclaration).name!);
		return (
			!sym ||
			(refs.get(sym) ?? []).some((r) => {
				let x: ts.Node = r;
				while (ts.isParenthesizedExpression(x.parent) || ts.isNonNullExpression(x.parent)) x = x.parent;
				const p = x.parent;
				if (ts.isTypeOfExpression(p)) return true;
				if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(p.operatorToken.kind)) {
					const other = p.left === x ? p.right : p.left;
					return other.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(other) && other.text === 'undefined');
				}
				return false;
			})
		);
	};
	// Where `x`'s value is only tested: null and undefined give the same there.
	const tested = (x: ts.Node): boolean => {
		while (ts.isParenthesizedExpression(x.parent) || ts.isNonNullExpression(x.parent)) x = x.parent;
		const p = x.parent;
		if (ts.isPrefixUnaryExpression(p)) return p.operator === ts.SyntaxKind.ExclamationToken;
		if ((ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) && p.expression === x) return true;
		if ((ts.isConditionalExpression(p) || ts.isForStatement(p)) && p.condition === x) return true;
		if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p) || ts.isCallExpression(p)) && p.expression === x && !!p.questionDotToken) return true;
		if (ts.isCallExpression(p) && p.arguments.length === 1 && p.expression.getText() === 'Array.isArray') return true;
		if (!ts.isBinaryExpression(p)) return false;
		const op = p.operatorToken.kind;
		if (op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) return true;
		if ((op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) && p.left === x) return true;
		return (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.QuestionQuestionToken) && tested(p);
	};
	// A parameter whose value goes on (printed, stored, passed) where it may still be null or undefined both.
	const escapes = (d: ts.Declaration) => {
		const sym = (d as ts.NamedDeclaration).name && checker.getSymbolAtLocation((d as ts.NamedDeclaration).name!);
		return !sym || (refs.get(sym) ?? []).some((r) => both(checker.getTypeAtLocation(r)) && !tested(r));
	};
	/**
	 * A slot typed `T | null` whose value form holds undefined too (a missing value reaches it) and tells them apart
	 * (`formBoth`): held as one whose type admits both. Never refused for it: where it can't be held it keeps one nil.
	 */
	const formHeld = (d: ts.Declaration, t: ts.Type | undefined) => !!t && !(ts.isParameter(d) && d.initializer) && hasNull(t) && !parts(t).some((x) => x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) && oneKind(t) && value(t) && formBoth(d);
	/**
	 * Holds `d` when its type admits both; refuses it when that type isn't one a held slot can carry and its code tells
	 * them apart. A function or library object held untyped would be reached by name.
	 */
	const hold = (d: ts.Declaration, t: ts.Type | undefined, at: ts.Node = d) => {
		if (formHeld(d, t)) {
			held.add(d);
			return;
		}
		if (!t || !(ts.isFunctionLike(d) ? bothResult(t) : both(t)) || !oneKind(t)) return;
		if (value(t) || (ts.isVariableDeclaration(d) && !parts(t).some((x) => x.getCallSignatures().length) && opaque(d))) held.add(d);
		else if ((ts.isParameter(d) || ts.isVariableDeclaration(d)) && ts.isIdentifier(d.name) && callable(t)) functions.set(d, observes(d) ? `${NATIVE} (\`${text(t)}\`)` : null);
		else if (ts.isFunctionLike(d) || observes(d)) refuse(at, `${NATIVE} (\`${text(t)}\`)`, { kind: 'value', slot: d });
	};
	// Functions whose signature only this program's direct calls see.
	const fixed = new Set<ts.Node>();
	const fns: ts.FunctionLikeDeclaration[] = [];
	const values: ts.SignatureDeclaration[] = [];
	const signatures: ts.SignatureDeclaration[] = [];
	const classes: ts.ClassLikeDeclaration[] = [];
	const anyArgs: [ts.ParameterDeclaration, ts.Expression][] = [];
	const anyStores: [ts.Declaration, ts.Expression][] = [];
	const isCallee = (n: ts.Node) => {
		let x: ts.Node = n;
		while (ts.isPropertyAccessExpression(x.parent) && x.parent.name === x) x = x.parent;
		return (ts.isCallExpression(x.parent) || ts.isNewExpression(x.parent)) && x.parent.expression === x;
	};
	const extended = new Set<ts.Symbol>();
	const visit = (n: ts.Node): void => {
		if (ts.isClassLike(n)) {
			classes.push(n);
			for (const h of n.heritageClauses ?? [])
				for (const x of h.types) {
					const b = checker.getTypeAtLocation(x.expression).getSymbol();
					if (b) extended.add(b);
				}
		}
		if ((ts.isFunctionDeclaration(n) || (ts.isMethodDeclaration(n) && ts.isClassLike(n.parent)) || ts.isConstructorDeclaration(n)) && n.body) fns.push(n);
		if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || (ts.isMethodDeclaration(n) && ts.isObjectLiteralExpression(n.parent))) values.push(n);
		if (ts.isFunctionTypeNode(n) || ts.isCallSignatureDeclaration(n) || ts.isMethodSignature(n)) signatures.push(n);
		if (ts.isIdentifier(n)) {
			const sym = checker.getSymbolAtLocation(n);
			if (sym && sym.valueDeclaration && (sym.valueDeclaration as ts.NamedDeclaration).name !== n) refs.set(sym, [...(refs.get(sym) ?? []), n]);
		}
		if ((ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) && !isCallee(n)) {
			const d = checker.getSymbolAtLocation(n)?.valueDeclaration;
			if (d && (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) && d.name !== n) fixed.add(d);
		}
		if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
			const d = checker.getResolvedSignature(n)?.getDeclaration();
			if (d && !ts.isJSDocSignature(d))
				(n.arguments ?? []).forEach((a, k) => {
					const p = d.parameters[k];
					if (p && !p.dotDotDotToken && !ts.isSpreadElement(a) && untyped(a)) anyArgs.push([p, a]);
				});
		}
		if (ts.isVariableDeclaration(n) && untyped(n.initializer)) anyStores.push([n, n.initializer!]);
		if (ts.isPropertyDeclaration(n) && untyped(n.initializer)) anyStores.push([n, n.initializer!]);
		if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && untyped(n.right)) {
			const d = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(n.left) ? n.left.name : n.left)?.valueDeclaration;
			if (d) anyStores.push([d, n.right]);
		}
		ts.forEachChild(n, visit);
	};
	for (const f of files) if (!f.isDeclarationFile && !skip(f)) visit(f);
	const isAsync = (fn: ts.SignatureDeclaration) => !!(ts.canHaveModifiers(fn) ? ts.getModifiers(fn) : undefined)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) || !!(fn as ts.FunctionLikeDeclaration).asteriskToken;
	const named = (p: ts.ParameterDeclaration) => ts.isIdentifier(p.name) && !p.dotDotDotToken;
	const returnOf = (fn: ts.SignatureDeclaration) => checker.getSignatureFromDeclaration(fn)?.getReturnType();
	const holdSignature = (fn: ts.SignatureDeclaration) => {
		for (const p of fn.parameters) if (named(p)) hold(p, typeOf(p));
		if (!isAsync(fn) && !ts.isConstructorDeclaration(fn)) hold(fn, returnOf(fn), fn.type ?? fn);
	};
	const openSignature = (fn: ts.FunctionLikeDeclaration): boolean => {
		if (fixed.has(fn) || !fn.body || (ts.canHaveDecorators(fn) && ts.getDecorators(fn)?.length)) return true;
		const sym = ts.isConstructorDeclaration(fn) ? undefined : checker.getSymbolAtLocation(fn.name!);
		if (sym && (sym.declarations?.length ?? 0) > 1) return true;
		if (ts.isMethodDeclaration(fn)) {
			const cls = fn.parent;
			if (!ts.isClassLike(cls) || cls.heritageClauses?.length || ts.getDecorators(cls)?.length) return true;
			// Another class extending this one may override it.
			if (extended.has(checker.getTypeAtLocation(cls).getSymbol()!)) return true;
		}
		if (ts.isConstructorDeclaration(fn) && (fn.parent.heritageClauses?.length || ts.getDecorators(fn.parent)?.length)) return true;
		return false;
	};
	// Any parameter or result of `fn` that may hold both, refused as `why`.
	const refuseBoth = (fn: ts.SignatureDeclaration, why: string) => {
		for (const p of fn.parameters) {
			const t = typeOf(p);
			if (both(t) && oneKind(t)) refuse(p, `${why} (\`${text(t)}\`)`);
		}
		const ret = returnOf(fn);
		if (!ts.isConstructorDeclaration(fn) && ret && bothResult(ret) && oneKind(ret)) refuse(fn.type ?? fn, `${why} (\`${text(ret)}\`)`);
	};
	// A function type's parameters and result: what every function of that type, and every call through it, uses.
	for (const sig of signatures) if (own(sig)) holdSignature(sig);
	const ownBase = (c: ts.ClassLikeDeclaration): ts.ClassLikeDeclaration | 'library' | undefined => {
		const h = c.heritageClauses?.find((x) => x.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
		if (!h) return undefined;
		const d = checker.getTypeAtLocation(h.expression).getSymbol()?.valueDeclaration;
		return d && ts.isClassLike(d) && own(d) ? d : 'library';
	};
	const memberName = (m: ts.MethodDeclaration) => (ts.isIdentifier(m.name) || ts.isPrivateIdentifier(m.name) ? m.name.text : undefined);
	const isStatic = (m: ts.Node) => !!ts.getModifiers(m as ts.HasModifiers)?.some((k) => k.kind === ts.SyntaxKind.StaticKeyword);
	type Family = { members: ts.MethodDeclaration[]; why?: string };
	const families = new Map<ts.MethodDeclaration, Family>();
	// A decorated class's methods: the framework's decorators leave its plain methods to this program (templates compile
	// to methods of the class itself) and say which the framework calls by name; any other decorator may call any.
	const frameworkCalled = (c: ts.ClassLikeDeclaration, name: string): string | undefined => {
		if (!ts.getDecorators(c)?.length) return undefined;
		return framework.frameworkCalled ? framework.frameworkCalled(c, name, checker) : 'a method of a decorated class';
	};
	/** The methods overriding one another with `m`, and why their signatures are fixed elsewhere if they are. */
	const familyOf = (m: ts.MethodDeclaration): Family => {
		const name = memberName(m),
			cls = m.parent as ts.ClassLikeDeclaration;
		if (!name) return { members: [m], why: 'a method with a computed name' };
		let top = cls,
			why: string | undefined;
		for (let c: ts.ClassLikeDeclaration | 'library' | undefined = cls; c; c = ownBase(c)) {
			if (c === 'library') {
				const h = top.heritageClauses!.find((x) => x.token === ts.SyntaxKind.ExtendsKeyword)!.types[0];
				if (checker.getTypeAtLocation(h).getProperty(name)) why = "a method overriding a library class's";
				break;
			}
			top = c;
		}
		const tree = [top];
		for (let k = 0; k < tree.length; k++) for (const c of classes) if (ownBase(c) === tree[k] && !tree.includes(c)) tree.push(c);
		const members = tree.flatMap((c) => c.members.filter((x): x is ts.MethodDeclaration => ts.isMethodDeclaration(x) && !isStatic(x) && memberName(x) === name));
		for (const c of tree) for (const h of c.heritageClauses ?? []) if (h.token === ts.SyntaxKind.ImplementsKeyword && h.types.some((x) => checker.getTypeAtLocation(x).getProperty(name))) why ??= 'a method an interface declares';
		if (members.some((x) => !x.body || (ts.canHaveDecorators(x) && ts.getDecorators(x)?.length) || (checker.getSymbolAtLocation(x.name)?.declarations?.length ?? 0) > 1)) why ??= 'an overloaded or decorated method';
		for (const c of tree) why ??= frameworkCalled(c, name);
		const result = { members, why };
		for (const x of members) families.set(x, result);
		return result;
	};
	for (const fn of fns) {
		if (!own(fn)) continue;
		if (ts.isMethodDeclaration(fn) && !isStatic(fn)) {
			if (families.has(fn)) continue;
			const { members: family, why } = familyOf(fn);
			if (why) {
				for (const x of family) refuseBoth(x, why);
				continue;
			}
			const width = Math.max(...family.map((x) => x.parameters.length));
			for (let k = 0; k < width; k++) {
				const ps = family.map((x) => x.parameters[k]).filter((p): p is ts.ParameterDeclaration => !!p);
				const wide = ps.find((p) => both(typeOf(p)) && oneKind(typeOf(p)));
				if (!wide) {
					if (ps.every(named) && ps.every((p) => formHeld(p, typeOf(p)))) for (const p of ps) held.add(p);
					continue;
				}
				// A slot no member tells apart or lets go on while it may be either keeps one nil.
				if (!ps.every(named) || !ps.every((p) => value(typeOf(p)))) {
					if (ps.some((p) => observes(p) || escapes(p))) refuse(wide, `${NATIVE} (\`${text(typeOf(wide))}\`)`, ps.length === 1 && named(wide) ? { kind: 'value', slot: wide } : undefined);
					continue;
				}
				for (const p of ps) held.add(p);
			}
			const wide = family.find((x) => {
				const r = returnOf(x);
				return !!r && bothResult(r) && oneKind(r) && !isAsync(x);
			});
			if (wide) {
				if (
					family.every((x) => {
						const r = returnOf(x);
						return !r || value(r);
					}) &&
					family.every((x) => !isAsync(x))
				)
					for (const x of family) held.add(x);
				else refuse(wide.type ?? wide, `${NATIVE} (\`${text(returnOf(wide)!)}\`)`, family.length === 1 && !isAsync(wide) ? { kind: 'value', slot: wide } : undefined);
			} else if (family.every((x) => !isAsync(x) && formHeld(x, returnOf(x)))) for (const x of family) held.add(x);
			continue;
		}
		if (ts.isConstructorDeclaration(fn) && (fn.parent.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword) || ts.getDecorators(fn.parent)?.length)) {
			refuseBoth(fn, 'a constructor parameter of a class that extends another or is decorated');
			continue;
		}
		if (ts.isFunctionDeclaration(fn) && (checker.getSymbolAtLocation(fn.name!)?.declarations?.length ?? 0) > 1) {
			refuseBoth(fn, 'an overloaded function');
			continue;
		}
		if (ts.canHaveDecorators(fn) && ts.getDecorators(fn)?.length) {
			refuseBoth(fn, 'a decorated member');
			continue;
		}
		for (const p of fn.parameters) {
			if (!named(p)) continue;
			// A parameter property's field is held as a field (`KeyState.nulls`); its parameter only by its form.
			if (ts.isConstructorDeclaration(fn) && ts.isParameterPropertyDeclaration(p, fn)) {
				const t = typeOf(p);
				if (formHeld(p, t) || (both(t) && oneKind(t) && value(t) && formBoth(p))) held.add(p);
				continue;
			}
			hold(p, typeOf(p));
		}
		if (!ts.isConstructorDeclaration(fn) && !isAsync(fn)) hold(fn, returnOf(fn), fn.type ?? fn);
	}
	// A function value takes the slots of the function type it is given as: held where that type's are, else refused where
	// that type may pass (or take) both.
	for (const fn of values) {
		if (!own(fn)) continue;
		const contextual = ts.isMethodDeclaration(fn)
			? (() => {
					const o = checker.getContextualType(fn.parent as ts.ObjectLiteralExpression);
					const m = o && ts.isIdentifier(fn.name) ? o.getProperty(fn.name.text) : undefined;
					return m ? checker.getTypeOfSymbolAtLocation(m, fn) : undefined;
				})()
			: checker.getContextualType(fn as ts.Expression);
		const ctx = contextual?.getNonNullableType().getCallSignatures()[0];
		if (!ctx) {
			holdSignature(fn);
			continue;
		}
		const decl = ctx.getDeclaration() as ts.SignatureDeclaration | undefined;
		const ownDecl = !!decl && !ts.isJSDocSignature(decl) && own(decl);
		fn.parameters.forEach((p, k) => {
			const sym = ctx.getParameters()[k];
			const given = sym && checker.getTypeOfSymbolAtLocation(sym, fn);
			const slot = ownDecl ? decl!.parameters[k] : undefined;
			if (given && slot && !both(given) && held.has(slot) && named(p) && formBoth(slot)) held.add(p);
			if (!given || !both(given) || !oneKind(given)) return;
			if (slot && held.has(slot) && named(p)) held.add(p);
			else refuse(p, `a callback parameter that may be null or undefined both (\`${text(given)}\`)`, named(p) ? { kind: 'value', slot: p } : undefined);
		});
		const ret = ctx.getReturnType();
		if (bothResult(ret) && oneKind(ret) && !isAsync(fn)) {
			if (ownDecl && held.has(decl!)) held.add(fn);
			else refuse(fn, `a callback that may return null or undefined both (\`${text(ret)}\`)`, { kind: 'value', slot: fn });
		} else if (ownDecl && held.has(decl!) && formBoth(decl!) && !isAsync(fn)) held.add(fn);
	}
	for (const [p] of anyArgs) {
		const fn = p.parent;
		if (own(p) && ts.isIdentifier(p.name) && (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn) || ts.isConstructorDeclaration(fn)) && !(ts.isConstructorDeclaration(fn) && ts.isParameterPropertyDeclaration(p, fn)) && fns.includes(fn) && !openSignature(fn) && hasNull(typeOf(p)) && value(typeOf(p))) held.add(p);
	}
	const local = (d: ts.VariableDeclaration) => ts.isVariableDeclarationList(d.parent) && ts.isVariableStatement(d.parent.parent);
	const fieldLike = (d: ts.Declaration): d is ts.PropertyDeclaration | ts.PropertySignature => (ts.isPropertyDeclaration(d) && ts.isClassLike(d.parent) && !d.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)) || ts.isPropertySignature(d);
	for (const [d] of anyStores) {
		if (!own(d) || !(d as ts.NamedDeclaration).name || !ts.isIdentifier((d as ts.NamedDeclaration).name!) || !hasNull(typeOf(d))) continue;
		if (ts.isVariableDeclaration(d)) {
			if (local(d) && value(typeOf(d))) held.add(d);
		} else if (fieldLike(d)) fields.add(d);
	}
	/** An element, entry or type argument of `t` that may be null or undefined both (what no held slot carries). */
	const nested = (t: ts.Type, depth = 0, seen = new Set<ts.Type>()): [ts.Type, number] | undefined => {
		if (seen.has(t) || depth > 4 || loose(t)) return undefined;
		seen.add(t);
		if (depth > 0 && both(t) && oneKind(t)) return [t, depth];
		for (const x of parts(t)) {
			if (!(x.flags & ts.TypeFlags.Object) || x.getCallSignatures().length) continue;
			const args = (x as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference ? checker.getTypeArguments(x as ts.TypeReference) : (x.aliasTypeArguments ?? []);
			for (const a of [...args, ...checker.getIndexInfosOfType(x).map((i) => i.type)]) {
				const r = nested(a, depth + 1, seen);
				if (r) return r;
			}
		}
		return undefined;
	};
	// Only an array's or Set's element and a Map's value have a form of their own (`Form.element`).
	const collectionElement = (t: ts.Type) => {
		const x = checker.getNonNullableType(t),
			name = x.getSymbol()?.name ?? '';
		if (!checker.isArrayType(x) && !['Set', 'ReadonlySet', 'Map', 'ReadonlyMap'].includes(name)) return undefined;
		return checker.getTypeArguments(x as ts.TypeReference)[name === 'Map' || name === 'ReadonlyMap' ? 1 : 0];
	};
	const checkNested = (n: ts.Node, t: ts.Type | undefined, slot = n as ts.Declaration) => {
		const [inner, depth] = (t && nested(t)) || [];
		if (inner) refuse(n, `an array, Map or Set element (or other type argument) that may be null or undefined both (\`${text(inner)}\` in \`${text(t!)}\`)`, depth === 1 && collectionElement(t!) === inner ? { kind: 'element', slot } : undefined);
	};
	for (const f of files) {
		if (f.isDeclarationFile || skip(f)) continue;
		const scan = (n: ts.Node): void => {
			if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && local(n) && (both(typeOf(n)) || formHeld(n, typeOf(n)))) hold(n, typeOf(n));
			else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && both(typeOf(n)) && oneKind(typeOf(n))) refuse(n, `a loop variable that may be null or undefined both (\`${text(typeOf(n))}\`)`, { kind: 'value', slot: n });
			else if (ts.isBindingElement(n) && ts.isIdentifier(n.name) && both(typeOf(n)) && oneKind(typeOf(n))) refuse(n, `a destructured binding that may be null or undefined both (\`${text(typeOf(n))}\`)`);
			else if (ts.isPropertyDeclaration(n) && fieldLike(n) && ts.isIdentifier(n.name) && hasNull(typeOf(n)) && (!n.initializer || both(typeOf(n)))) fields.add(n);
			else if (ts.isPropertySignature(n) && ts.isIdentifier(n.name) && both(typeOf(n))) fields.add(n);
			else if ((ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) && n.body) refuseBoth(n, 'an accessor that may take or give null or undefined both');
			if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isPropertyDeclaration(n) || ts.isPropertySignature(n)) && (n as ts.NamedDeclaration).name && checker.getSymbolAtLocation((n as ts.NamedDeclaration).name!)) checkNested(n, typeOf(n));
			if (ts.isFunctionLike(n) && !ts.isConstructorDeclaration(n)) checkNested(n.type ?? n, returnOf(n as ts.SignatureDeclaration), n);
			ts.forEachChild(n, scan);
		};
		scan(f);
	}
	missingAndNull(
		checker,
		files,
		skip,
		held,
		(fn) => fns.includes(fn) && own(fn) && !openSignature(fn),
		(d) => {
			if (!ts.isFunctionLike(d) && !ts.isIdentifier((d as ts.NamedDeclaration).name!)) return false;
			const t = ts.isFunctionLike(d) ? checker.getSignatureFromDeclaration(d)?.getReturnType() : typeOf(d);
			return own(d) && !!t && !hasNull(t) && value(t);
		},
		local,
	);
	// `const field = args.view as TextField`: TypeScript checks no class at run time, so the value may be another class's object
	// (a SearchBar), which script reads by name. Only the program's own classes are read so in every backend.
	for (const f of files) {
		if (f.isDeclarationFile || skip(f)) continue;
		const scan = (n: ts.Node): void => {
			if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && !n.type && local(n) && n.initializer) {
				const init = ts.skipOuterExpressions(n.initializer, ts.OuterExpressionKinds.Parentheses);
				if ((ts.isAsExpression(init) || ts.isTypeAssertionExpression(init)) && downcast(checker, init, own)) held.add(n);
			}
			ts.forEachChild(n, scan);
		};
		scan(f);
	}
	return { held, fields, refused, functions };
}

/**
 * Code checked without strictNullChecks: what a function's body gives where it gives nothing, which its type can't say.
 * `null`: only `null` itself; `missing`: undefined (a bare `return`, `undefined`, a void call, a library result typed
 * `T | undefined`, an optional parameter, a body whose end may be reached); `unknown`: a value that may be either (a
 * local, a signal, a library result typed with both).
 */
export function nothingGiven(fn: ts.FunctionLikeDeclaration, checker: ts.TypeChecker, seen = new Set<ts.Node>()): { null: boolean; missing: boolean; unknown: boolean } {
	const out = { null: false, missing: false, unknown: false };
	if (!fn.body || !ts.isBlock(fn.body)) return out;
	seen.add(fn);
	const optional = new Set(fn.parameters.filter((p) => p.questionToken && !p.initializer).map((p) => checker.getSymbolAtLocation(p.name)));
	const gives = (e: ts.Expression | undefined): void => {
		if (!e) {
			out.missing = true;
			return;
		}
		e = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
		if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)) return gives(e.right);
		if (ts.isConditionalExpression(e)) {
			gives(e.whenTrue);
			gives(e.whenFalse);
			return;
		}
		if (e.kind === ts.SyntaxKind.NullKeyword) {
			out.null = true;
			return;
		}
		if ((ts.isIdentifier(e) && e.text === 'undefined') || ts.isVoidExpression(e)) {
			out.missing = true;
			return;
		}
		if (ts.isIdentifier(e)) {
			const sym = checker.getSymbolAtLocation(e);
			if (optional.has(sym)) {
				out.missing = true;
				return;
			}
			const d = sym?.valueDeclaration;
			// A local declared without a value may still be undefined; one starting null may still be null.
			if (d && ts.isVariableDeclaration(d) && ts.findAncestor(d, (n) => n === fn) && !ts.isForOfStatement(d.parent.parent) && !ts.isForInStatement(d.parent.parent)) {
				if (!d.initializer) out.missing = true;
				else gives(d.initializer.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(d.initializer) && d.initializer.text === 'undefined') ? d.initializer : ts.factory.createTrue());
			}
			return;
		}
		if (ts.isCallExpression(e)) {
			const t = checker.getTypeAtLocation(e);
			if (t.flags & ts.TypeFlags.Void) {
				out.missing = true;
				return;
			}
			const sig = checker.getResolvedSignature(e)?.getDeclaration();
			const declared = sig && !ts.isJSDocSignature(sig) && sig.getSourceFile().isDeclarationFile ? sig.type : undefined;
			// The program's own function: what its body gives.
			if (sig && !ts.isJSDocSignature(sig) && (ts.isFunctionDeclaration(sig) || ts.isMethodDeclaration(sig)) && sig.body && !sig.getSourceFile().isDeclarationFile) {
				if (seen.has(sig)) return;
				const inner = nothingGiven(sig, checker, seen);
				out.null ||= inner.null;
				out.missing ||= inner.missing;
				out.unknown ||= inner.unknown;
			} else if (declared && ts.isUnionTypeNode(declared)) {
				const n = declared.types.some((x) => ts.isLiteralTypeNode(x) && x.literal.kind === ts.SyntaxKind.NullKeyword);
				const u = declared.types.some((x) => x.kind === ts.SyntaxKind.UndefinedKeyword);
				if (n && u) out.unknown = true;
				else if (n) out.null = true;
				else if (u) out.missing = true;
			}
			// A function's or signal's result read without its own declaration's evidence (a signal made with null).
			else if (!e.arguments.length && !(sig && !ts.isJSDocSignature(sig) && !sig.getSourceFile().isDeclarationFile)) out.unknown = true;
		}
	};
	const visit = (n: ts.Node): void => {
		if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
		if (ts.isReturnStatement(n)) gives(n.expression);
		ts.forEachChild(n, visit);
	};
	visit(fn.body);
	if (!leaves(fn.body)) out.missing = true;
	return out;
}

/** Whether a statement always returns or throws, as far as its last statements, both branches of an `if` and a `try`'s blocks show. */
function leaves(st: ts.Statement | undefined): boolean {
	if (!st) return false;
	if (ts.isReturnStatement(st) || ts.isThrowStatement(st)) return true;
	if (ts.isBlock(st)) return leaves(st.statements[st.statements.length - 1]);
	if (ts.isTryStatement(st)) return (!!st.finallyBlock && leaves(st.finallyBlock)) || (leaves(st.tryBlock) && (!st.catchClause || leaves(st.catchClause.block)));
	return ts.isIfStatement(st) && !!st.elseStatement && leaves(st.thenStatement) && leaves(st.elseStatement);
}

/** Whether code assigns a variable anywhere after its declaration. */
export function reassigned(d: ts.VariableDeclaration, checker: ts.TypeChecker): boolean {
	if (!ts.isIdentifier(d.name)) return true;
	const sym = checker.getSymbolAtLocation(d.name);
	if (!sym) return true;
	const target = (x: ts.Expression) => ts.isIdentifier(ts.skipOuterExpressions(x)) && checker.getSymbolAtLocation(ts.skipOuterExpressions(x)) === sym;
	const visit = (n: ts.Node): boolean => {
		if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && target(n.left)) return true;
		if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) && target(n.operand)) return true;
		return !!ts.forEachChild(n, visit);
	};
	return visit(d.getSourceFile());
}

/** Whether a function other than the one declaring a variable assigns it: a narrowing at a read in the declaring function does not see that write. */
export function assignedInOtherFunction(d: ts.VariableDeclaration, checker: ts.TypeChecker): boolean {
	if (!ts.isIdentifier(d.name)) return false;
	const sym = checker.getSymbolAtLocation(d.name);
	if (!sym) return false;
	const home = ts.findAncestor(d, ts.isFunctionLike);
	const target = (x: ts.Expression) => ts.isIdentifier(ts.skipOuterExpressions(x)) && checker.getSymbolAtLocation(ts.skipOuterExpressions(x)) === sym;
	const visit = (n: ts.Node): boolean => {
		if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && target(n.left) && ts.findAncestor(n, ts.isFunctionLike) !== home) return true;
		return !!ts.forEachChild(n, visit);
	};
	return visit(d.getSourceFile());
}

/** Whether an array destructuring assignment (`[a, ...[b]] = xs`) writes a variable: an element past the array's end is undefined, whatever its type says. */
export function assignedByArrayPattern(d: ts.VariableDeclaration, checker: ts.TypeChecker): boolean {
	if (!ts.isIdentifier(d.name)) return false;
	const sym = checker.getSymbolAtLocation(d.name);
	if (!sym) return false;
	const inPattern = (x: ts.Expression): boolean => {
		x = ts.skipOuterExpressions(x);
		if (ts.isIdentifier(x)) return checker.getSymbolAtLocation(x) === sym;
		if (ts.isSpreadElement(x)) return inPattern(x.expression);
		if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.EqualsToken) return inPattern(x.left);
		return ts.isArrayLiteralExpression(x) && x.elements.some(inPattern);
	};
	const visit = (n: ts.Node): boolean => (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isArrayLiteralExpression(ts.skipOuterExpressions(n.left)) && inPattern(n.left)) || !!ts.forEachChild(n, visit);
	return visit(d.getSourceFile());
}

/** Whether a variable's initializer or a later `=` to it gives a value `test` accepts. */
export function givenBy(d: ts.VariableDeclaration, checker: ts.TypeChecker, test: (e: ts.Expression) => boolean): boolean {
	const sym = ts.isIdentifier(d.name) ? checker.getSymbolAtLocation(d.name) : undefined;
	if (!sym) return false;
	if (d.initializer && test(ts.skipOuterExpressions(d.initializer))) return true;
	const visit = (n: ts.Node): boolean => (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(ts.skipOuterExpressions(n.left)) && checker.getSymbolAtLocation(ts.skipOuterExpressions(n.left)) === sym && test(ts.skipOuterExpressions(n.right))) || !!ts.forEachChild(n, visit);
	return visit(d.getSourceFile());
}

/**
 * A variable whose every value, its initializer's and each `=`'s, is one `nullOnly` accepts or one never null or undefined
 * (`new`, a literal other than null, a function): where it holds nothing, that is null. Any other write (compound, `++`,
 * destructuring, a `for … of` target) makes it false. With `unset`, a variable declared without a value answers too:
 * it holds undefined until its first write, which only a read `assignedBefore` has passed.
 */
export function onlyNullOrPresent(d: ts.VariableDeclaration, checker: ts.TypeChecker, nullOnly: (e: ts.Expression) => boolean, unset = false): boolean {
	if (!ts.isIdentifier(d.name) || (!d.initializer && !unset)) return false;
	const sym = checker.getSymbolAtLocation(d.name);
	if (!sym) return false;
	const given = (e: ts.Expression) => {
		const v = ts.skipOuterExpressions(e);
		return nullOnly(v) || v.kind === ts.SyntaxKind.NullKeyword || ts.isNewExpression(v) || ts.isObjectLiteralExpression(v) || ts.isArrayLiteralExpression(v) || ts.isStringLiteralLike(v) || ts.isNumericLiteral(v) || ts.isTemplateExpression(v) || ts.isArrowFunction(v) || ts.isFunctionExpression(v);
	};
	if (d.initializer && !given(d.initializer)) return false;
	let ok = true;
	const visit = (n: ts.Node): void => {
		if (!ok) return;
		const named = ts.isShorthandPropertyAssignment(n) ? checker.getShorthandAssignmentValueSymbol(n) : ts.isIdentifier(n) && n !== d.name ? checker.getSymbolAtLocation(n) : undefined;
		if (named === sym) {
			let t: ts.Node = n;
			while (ts.isParenthesizedExpression(t.parent)) t = t.parent;
			const p = t.parent;
			if (ts.isBinaryExpression(p) && p.left === t && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
				if (p.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !given(p.right) || ts.isArrayLiteralExpression(p.parent) || ts.isPropertyAssignment(p.parent)) ok = false;
			} else if ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) && (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)) ok = false;
			else if ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === t) ok = false;
			else if (inPattern(ts.isShorthandPropertyAssignment(n) ? n : t)) ok = false;
		}
		ts.forEachChild(n, visit);
	};
	const inPattern = (n: ts.Node): boolean => {
		for (let p = n.parent; p; n = p, p = p.parent) {
			if (ts.isParenthesizedExpression(p) || ts.isSpreadElement(p) || ts.isSpreadAssignment(p) || ts.isShorthandPropertyAssignment(p) || (ts.isPropertyAssignment(p) && p.initializer === n)) continue;
			if (!ts.isArrayLiteralExpression(p) && !ts.isObjectLiteralExpression(p)) return false;
			const q = p.parent;
			if ((ts.isBinaryExpression(q) && q.left === p && q.operatorToken.kind === ts.SyntaxKind.EqualsToken) || ((ts.isForOfStatement(q) || ts.isForInStatement(q)) && q.initializer === p)) return true;
		}
		return false;
	};
	visit(d.getSourceFile());
	return ok;
}

/**
 * A read of a variable declared without a value, in the declaring function's own statements (no closure) after a
 * statement of the same list that assigns it (`let c: T; c = find(); … c …`): every path to the read has written it.
 */
export function assignedBefore(d: ts.VariableDeclaration, read: ts.Expression, checker: ts.TypeChecker): boolean {
	const list = d.parent,
		statement = list.parent;
	if (!ts.isIdentifier(d.name) || !ts.isVariableDeclarationList(list) || !ts.isVariableStatement(statement)) return false;
	const sym = checker.getSymbolAtLocation(d.name);
	if (!sym || ts.findAncestor(read.parent, ts.isFunctionLike) !== ts.findAncestor(d, ts.isFunctionLike)) return false;
	const owner = statement.parent;
	if (!ts.isBlock(owner) && !ts.isSourceFile(owner) && !ts.isModuleBlock(owner) && !ts.isCaseOrDefaultClause(owner)) return false;
	const statements: readonly ts.Statement[] = owner.statements;
	const at = ts.findAncestor(read, (x) => x.parent === owner) as ts.Statement | undefined;
	const from = statements.indexOf(statement);
	const to = at ? statements.indexOf(at) : -1;
	return statements.slice(from + 1, Math.max(to, from + 1)).some((s) => {
		if (!ts.isExpressionStatement(s)) return false;
		const e = ts.skipOuterExpressions(s.expression);
		return ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(ts.skipOuterExpressions(e.left)) && checker.getSymbolAtLocation(ts.skipOuterExpressions(e.left)) === sym;
	});
}

/** The key JavaScript reads of `e` where `e` (parenthesized or not) is a member read's receiver, without `?.`. */
export function readKeyOf(e: ts.Expression): string | null {
	const p = ts.walkUpParenthesizedExpressions(e.parent);
	if (ts.isPropertyAccessExpression(p) && !p.questionDotToken && ts.skipOuterExpressions(p.expression, ts.OuterExpressionKinds.Parentheses) === e) return p.name.text;
	if (ts.isElementAccessExpression(p) && !p.questionDotToken && ts.skipOuterExpressions(p.expression, ts.OuterExpressionKinds.Parentheses) === e) {
		const k = p.argumentExpression;
		return ts.isStringLiteralLike(k) || ts.isNumericLiteral(k) ? k.text : k.getText();
	}
	return null;
}

/**
 * Downcasts read untyped (`const field = view as TextField`, `(view as TextField).text`): `receivers`, the ones read for a
 * member in place, and `classes`, the program's classes whose objects any of them may hold (each one assignable to the type
 * cast from), whose members are read and called by name.
 */
export function heldDowncasts(checker: ts.TypeChecker, files: readonly ts.SourceFile[], skip: (file: ts.SourceFile) => boolean, held: Set<ts.Declaration>): { receivers: Set<ts.Expression>; classes: Set<ts.ClassLikeDeclaration> } {
	const own = (d: ts.Declaration | undefined) => !!d && !d.getSourceFile().isDeclarationFile && !skip(d.getSourceFile());
	const receivers = new Set<ts.Expression>(),
		classes = new Set<ts.ClassLikeDeclaration>(),
		cast: ts.Expression[] = [],
		declared: ts.ClassLikeDeclaration[] = [];
	const visit = (n: ts.Node): void => {
		if ((ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) && downcast(checker, n, own)) {
			const holder = ts.findAncestor(n.parent, (p) => !ts.isParenthesizedExpression(p));
			const inPlace = !!holder && ts.isPropertyAccessExpression(holder) && ts.skipParentheses(holder.expression) === n;
			if (inPlace) receivers.add(n);
			if (inPlace || (holder && ts.isVariableDeclaration(holder) && held.has(holder))) cast.push(n.expression);
		}
		if (ts.isClassLike(n)) declared.push(n);
		ts.forEachChild(n, visit);
	};
	for (const f of files) if (!f.isDeclarationFile && !skip(f)) visit(f);
	const from = cast.map((e) => checker.getNonNullableType(checker.getTypeAtLocation(e)));
	for (const c of declared) if (from.some((f) => checker.isTypeAssignableTo(checker.getTypeAtLocation(c.name ?? c), f))) classes.add(c);
	return { receivers, classes };
}

/** `x as C` of an object typed as a class or interface above C, C a class of the program's own. */
export function downcast(checker: ts.TypeChecker, e: ts.AsExpression | ts.TypeAssertion, own: (d: ts.Declaration | undefined) => boolean): boolean {
	const to = checker.getTypeAtLocation(e),
		from = checker.getNonNullableType(checker.getTypeAtLocation(e.expression));
	const cls = to.getSymbol();
	if (!cls || !(cls.flags & ts.SymbolFlags.Class) || !own(cls.valueDeclaration) || from.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) || from === to) return false;
	// A class extending a native or the kit's class keeps its checked cast: such objects are not all read by name.
	for (let t: ts.Type | undefined = to; t; t = checker.getBaseTypes(t as ts.InterfaceType)[0]) {
		if (!own(t.getSymbol()?.valueDeclaration)) return false;
		if (!(t.flags & ts.TypeFlags.Object) || !((t as ts.ObjectType).objectFlags & ts.ObjectFlags.ClassOrInterface)) break;
	}
	if (!(from.flags & ts.TypeFlags.Object) || from.getCallSignatures().length) return false;
	return checker.isTypeAssignableTo(to, from) && !checker.isTypeAssignableTo(from, to);
}

/**
 * Non-strict code, whose checker types no slot with null: a parameter, local or function result the program gives both a null
 * and a missing value (`getString(key, fallback?: string)` called with `null` and without it, and returning `fallback`), held
 * untyped as strict code's `T | null | undefined` is. `fixed`: a function whose every call the program shows.
 */
function missingAndNull(checker: ts.TypeChecker, files: readonly ts.SourceFile[], skip: (file: ts.SourceFile) => boolean, held: Set<ts.Declaration>, fixed: (fn: ts.FunctionLikeDeclaration) => boolean, slot: (d: ts.Declaration) => boolean, local: (d: ts.VariableDeclaration) => boolean): void {
	const NULL = 1,
		MISSING = 2;
	const given = new Map<ts.Declaration, (ts.Expression | undefined)[]>();
	const give = (d: ts.Declaration, e: ts.Expression | undefined) => {
		const list = given.get(d) ?? [];
		list.push(e);
		given.set(d, list);
	};
	const declarationOf = (n: ts.Node) => checker.getSymbolAtLocation(n)?.valueDeclaration;
	const visit = (n: ts.Node): void => {
		if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
			const d = checker.getResolvedSignature(n)?.getDeclaration();
			const args = n.arguments ?? ts.factory.createNodeArray();
			if (d && !ts.isJSDocSignature(d) && (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d) || ts.isConstructorDeclaration(d)) && fixed(d) && !args.some(ts.isSpreadElement)) {
				d.parameters.forEach((p, k) => {
					if (!p.dotDotDotToken) give(p, args[k]);
				});
			}
		}
		if (ts.isReturnStatement(n)) {
			const fn = ts.findAncestor(n.parent, ts.isFunctionLike);
			if (fn && (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn))) give(fn, n.expression);
		}
		if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && ts.isVariableDeclarationList(n.parent) && local(n)) give(n, n.initializer);
		if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) {
			const d = declarationOf(n.left);
			if (d && ts.isVariableDeclaration(d)) give(d, n.right);
		}
		ts.forEachChild(n, visit);
	};
	for (const f of files) if (!f.isDeclarationFile && !skip(f)) visit(f);
	const kinds = (e: ts.Expression | undefined): number => {
		if (!e) return MISSING;
		e = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses | ts.OuterExpressionKinds.Assertions);
		if (e.kind === ts.SyntaxKind.NullKeyword) return NULL;
		if (ts.isVoidExpression(e)) return MISSING;
		if (ts.isIdentifier(e)) {
			const d = declarationOf(e);
			if (e.text === 'undefined' && !d) return MISSING;
			return d && held.has(d) ? NULL | MISSING : 0;
		}
		if (ts.isCallExpression(e)) {
			const d = checker.getResolvedSignature(e)?.getDeclaration();
			return d && held.has(d as ts.Declaration) ? NULL | MISSING : 0;
		}
		if (ts.isConditionalExpression(e)) return kinds(e.whenTrue) | kinds(e.whenFalse);
		if (ts.isBinaryExpression(e)) {
			const op = e.operatorToken.kind;
			if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return kinds(e.right);
			if (op === ts.SyntaxKind.AmpersandAmpersandToken) return kinds(e.left) | kinds(e.right);
		}
		return 0;
	};
	const fallsThrough = (fn: ts.FunctionLikeDeclaration) => !fn.body || (ts.isBlock(fn.body) && !alwaysEnds(fn.body));
	for (let changed = true; changed;) {
		changed = false;
		for (const [d, list] of given) {
			if (held.has(d) || !slot(d)) continue;
			let mask = list.reduce((m, e) => m | kinds(e), 0);
			if (ts.isParameter(d)) {
				if (!ts.isIdentifier(d.name) || (ts.isConstructorDeclaration(d.parent) && ts.isParameterPropertyDeclaration(d, d.parent))) continue;
				if (d.questionToken) mask |= MISSING;
				// A default takes the place of a missing value.
				if (d.initializer) mask &= NULL;
			} else if (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) {
				if (!fixed(d) || d.asteriskToken || ts.getModifiers(d)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) continue;
				if (fallsThrough(d)) mask |= MISSING;
			}
			if (mask === (NULL | MISSING)) {
				held.add(d);
				changed = true;
			}
		}
	}
}
