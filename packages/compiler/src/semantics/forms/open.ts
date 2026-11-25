// Slots whose values come from outside the program (open parameters, a library's surface) and the classes a union of values makes.
import ts from 'typescript';
import { F, N, O, U, declarationFile, hasStatic, isPublic, isReadonly, stringReplacer, typeNodeStates, untyped, valueParameters } from './flow.ts';
import type { Forms } from './forms.ts';
import { LIB_FILE } from '../trust.ts';
import { regexpMayLeaveGroupUnset } from '../regexp.ts';

export const openMethods = {
	/**
	 * The parameters of a function whose callers the program can't see: in strict code what their declared types
	 * admit, which their slots hold already; in other code `openStates`. JavaScript's built-ins (`lib`) give what their
	 * declarations say; a platform's binding may give nil; script (a function reached through an untyped slot) may give
	 * fewer arguments, null, and anything for a primitive; an escaped object's method (`openEscaped`)
	 * fewer arguments or null.
	 */
	openParameters(this: Forms, fn: ts.SignatureDeclaration, caller: { lib?: ts.SignatureDeclaration; platform?: ts.SignatureDeclaration; script?: boolean; escaped?: boolean } = {}): void {
		const lib = caller.lib && valueParameters(caller.lib),
			platform = caller.platform && valueParameters(caller.platform);
		const rest = lib?.at(-1)?.dotDotDotToken ? lib.at(-1) : undefined;
		valueParameters(fn).forEach((p, k) => {
			let states: number;
			if (lib) {
				const q = k < lib.length && lib[k] !== rest ? lib[k] : rest;
				const given = q === rest && q?.type && ts.isArrayTypeNode(q.type) ? q.type.elementType : q?.type;
				// A built-in's `any` says nothing of the value's type; a parameter that declares its own type is believed.
				states = q ? (typeNodeStates(given) & (p.type ? ~F : ~0)) | (q.questionToken ? U : 0) : U;
				// A replacer's `...args: any[]` are groups (a string, or undefined where one is unset), the offset, the input and the
				// named groups: never null, which the `any` an untyped parameter takes from them says it may be.
				if (q === rest && stringReplacer(caller.lib!)) {
					states &= ~N;
					if (states & U && this.groupsMayBeUnset(fn)) states |= O;
					if (!p.type) {
						const r = this.find(this.slotFor(p));
						r.states &= ~N;
						r.local &= ~N;
					}
				}
			} else states = this.strict(p) ? 0 : this.openStates(p);
			const q = platform?.[k];
			if (q && this.nativeNil(q)) states |= N;
			// Script's null reaches app code only: library parameters keep their declared types.
			const scriptNull = this.library || !this.ownCode(fn) ? 0 : N;
			if (caller.script && !p.dotDotDotToken) states |= U | O | scriptNull | (this.primitive(p) ? F : 0);
			if (caller.escaped && !p.dotDotDotToken) states |= U | O | scriptNull;
			if (states) this.seed(p.dotDotDotToken ? this.child(this.slotFor(p), 'element') : this.slotFor(p), states);
		});
	},

	/** A replacer whose call's pattern may leave a group unset, or one not seen given to a call: the built-in gives it undefined. */
	groupsMayBeUnset(this: Forms, fn: ts.SignatureDeclaration): boolean {
		let x: ts.Node = fn;
		while (ts.isParenthesizedExpression(x.parent)) x = x.parent;
		const call = x.parent;
		return !ts.isCallExpression(call) || call.arguments[1] !== x || regexpMayLeaveGroupUnset(call.arguments[0], this.checker);
	},

	/**
	 * What non-strict code's entry point takes: undefined and null over its declared type, and values of
	 * another type only where it declares none (`any`, `unknown`, or no type).
	 */
	openStates(this: Forms, d: ts.Declaration): number {
		const t = this.declaredType(d);
		return U | N | (!t || untyped(t) ? F : 0);
	},

	/** A string, number or boolean slot, which script may give a value of another type it then converts. */
	primitive(this: Forms, d: ts.Declaration): boolean {
		const t = this.declaredType(d);
		if (!t) return false;
		const parts = (t.isUnion() ? t.types : [t]).filter((x) => !(x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)));
		const kinds = new Set(parts.map((x) => (x.flags & ts.TypeFlags.StringLike ? 's' : x.flags & ts.TypeFlags.NumberLike ? 'n' : x.flags & ts.TypeFlags.BooleanLike ? 'b' : 'o')));
		return kinds.size === 1 && !kinds.has('o');
	},

	/** A library's exported functions and public members, and the fields its callers may write: entry points. */
	openLibrarySurface(this: Forms): void {
		const c = this.checker;
		const seen = new Set<ts.Symbol>();
		const openMembers = (members: ts.NodeArray<ts.ClassElement | ts.TypeElement>) => {
			for (const m of members) {
				if (!isPublic(m)) continue;
				if (ts.isPropertyDeclaration(m) || ts.isPropertySignature(m)) {
					if (!isReadonly(m) && !(ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Ambient) && !this.strict(m)) this.seed(this.slotFor(m), this.openStates(m));
					this.observedSlots.push(this.slotFor(m));
				} else if (ts.isFunctionLike(m)) {
					this.openParameters(m);
					this.readByCallers(m);
				}
			}
		};
		const open = (sym: ts.Symbol) => {
			if (sym.flags & ts.SymbolFlags.Alias) sym = c.getAliasedSymbol(sym);
			if (seen.has(sym)) return;
			seen.add(sym);
			for (const d of sym.declarations ?? []) {
				if (declarationFile(d)) continue;
				if (ts.isClassLike(d) || ts.isInterfaceDeclaration(d)) openMembers(d.members);
				else if (ts.isTypeAliasDeclaration(d) && ts.isTypeLiteralNode(d.type)) openMembers(d.type.members);
				else if (ts.isFunctionDeclaration(d)) {
					this.openParameters(d);
					this.readByCallers(d);
				} else if (ts.isVariableDeclaration(d)) {
					this.observedSlots.push(this.slotFor(d));
					const fn = d.initializer && this.functionDeclarationOf(d.initializer);
					if (fn) {
						this.openParameters(fn);
						this.readByCallers(fn);
					} else if (d.initializer && ts.isObjectLiteralExpression(ts.skipOuterExpressions(d.initializer))) {
						for (const p of (ts.skipOuterExpressions(d.initializer) as ts.ObjectLiteralExpression).properties) {
							const f = ts.isMethodDeclaration(p) ? p : ts.isPropertyAssignment(p) ? this.functionDeclarationOf(p.initializer) : null;
							if (f) {
								this.openParameters(f);
								this.readByCallers(f);
							}
						}
					}
				}
				if (ts.isModuleDeclaration(d)) for (const x of c.getExportsOfModule(sym)) open(x);
			}
		};
		for (const f of this.files) {
			const module = !f.isDeclarationFile && c.getSymbolAtLocation(f);
			if (module) for (const x of c.getExportsOfModule(module)) open(x);
		}
	},

	/** An entry point's result, which its callers read. */
	readByCallers(this: Forms, fn: ts.SignatureDeclaration): void {
		if (ts.isConstructorDeclaration(fn) || ts.isSetAccessorDeclaration(fn)) return;
		const r = this.resultOf(fn);
		if (r) this.observedSlots.push(r);
	},

	/**
	 * Override families, implemented interfaces' members and accessor pairs: one form each. A platform class's subclass
	 * is called by the platform (an exposed method, a selector): its methods are entry points, except where they override
	 * the platform's own, whose declared form they take.
	 */
	unionClass(this: Forms, cls: ts.ClassLikeDeclaration): void {
		const c = this.checker;
		const type = c.getTypeAtLocation(cls.name ?? cls);
		const bases = [...(type.isClassOrInterface() ? c.getBaseTypes(type) : []), ...(cls.heritageClauses ?? []).filter((h) => h.token === ts.SyntaxKind.ImplementsKeyword).flatMap((h) => h.types.map((x) => c.getTypeAtLocation(x)))];
		const native = type.isClassOrInterface() && this.extendsNative(type);
		this.classes.push(cls);
		for (const m of cls.members) if ((ts.isMethodDeclaration(m) || ts.isSetAccessorDeclaration(m)) && m.body && !hasStatic(m) && (native || this.frameworkCalled(cls, m))) this.openParameters(m);
		for (const m of cls.members) {
			if (hasStatic(m) || !m.name || !(ts.isIdentifier(m.name) || ts.isPrivateIdentifier(m.name) || ts.isStringLiteral(m.name))) continue;
			const name = m.name.text;
			for (const b of bases) {
				for (const d of b.getProperty(name)?.declarations ?? []) {
					// A declaration file's member is read by its platform or library: a field's value, a method's result.
					const read = declarationFile(d) && this.unseenReader(d);
					if (ts.isFunctionLike(m) && ts.isFunctionLike(d)) {
						this.unionSignature(m as ts.SignatureDeclaration, d as ts.SignatureDeclaration);
						const r = read && this.resultOf(m as ts.SignatureDeclaration);
						if (r) this.observedSlots.push(r);
					} else if (!ts.isFunctionLike(m) && !ts.isFunctionLike(d)) {
						this.share(this.slotFor(m), this.slotFor(d));
						if (read) this.observedSlots.push(this.slotFor(m));
					}
				}
			}
			if (ts.isGetAccessorDeclaration(m)) {
				const set = cls.members.find((x): x is ts.SetAccessorDeclaration => ts.isSetAccessorDeclaration(x) && x.name.getText() === m.name.getText() && hasStatic(x) === hasStatic(m));
				if (set?.parameters[0]) this.share(this.slotFor(m), this.slotFor(set.parameters[0]));
			}
		}
		// A parameter property is a member as a field is: one form with the member it implements.
		for (const p of cls.members.find(ts.isConstructorDeclaration)?.parameters ?? []) {
			if (!ts.isParameterPropertyDeclaration(p, p.parent) || !ts.isIdentifier(p.name)) continue;
			for (const b of bases) {
				for (const d of b.getProperty(p.name.text)?.declarations ?? []) {
					if (d === p || ts.isFunctionLike(d)) continue;
					this.share(this.slotFor(p), this.slotFor(d));
					if (declarationFile(d) && this.unseenReader(d)) this.observedSlots.push(this.slotFor(p));
				}
			}
		}
	},

	/** A declaration file of the library being compiled (core's own `index.d.ts` definitions), not a platform's or JavaScript's. */
	ownDeclaration(this: Forms, d: ts.Declaration): boolean {
		const name = d.getSourceFile().fileName;
		return this.library && !LIB_FILE.test(name) && !/[\\/]node_modules[\\/]/.test(name) && !this.native(d);
	},

	extendsNative(this: Forms, t: ts.InterfaceType, depth = 0): boolean {
		return (
			depth < 32 &&
			this.checker.getBaseTypes(t).some((b) => {
				const d = b.getSymbol()?.declarations?.[0];
				return (!!d && declarationFile(d) && this.native(d)) || (b.isClassOrInterface() && this.extendsNative(b, depth + 1));
			})
		);
	},
};

export type OpenMethods = typeof openMethods;
