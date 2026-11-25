// The slots that must share one form, joined by union-find.
import ts from 'typescript';
import { A, F, G, M, N, O, Slot, U, elementType, isAsync, isGeneric, sourceOf, typeNodeStates, typeStates, withAbsent, writtenByCallers, type Part } from './flow.ts';
import type { Forms } from './forms.ts';

export const unionFindMethods = {
	find(this: Forms, s: Slot): Slot {
		while (s.up !== s) s = s.up = s.up.up;
		return s;
	},

	union(this: Forms, a: Slot, b: Slot): void {
		const x = this.find(a),
			y = this.find(b);
		if (x === y) return;
		y.up = x;
		if (x.fixed && y.fixed) x.give(y.states);
		else if (y.fixed) {
			x.fixed = true;
			x.states = x.local = y.states;
		} else if (!x.fixed) {
			x.states |= y.states;
			x.local |= y.local;
		}
		x.observed ||= y.observed;
		x.typeObserved ||= y.typeObserved;
		for (const [p, c] of y.children) {
			const mine = x.children.get(p);
			if (mine) this.share(mine, c);
			else x.children.set(p, c);
		}
	},

	/**
	 * Slots that must agree: one form, unless one is typed by a type parameter and the other isn't. Their
	 * states then flow by edges, masked where they cross (`crossing`): `from` to `to`, and back unless `oneWay`.
	 * Returns whether they were merged.
	 */
	share(this: Forms, from: Slot, to: Slot, oneWay = false): boolean {
		const x = this.find(from),
			y = this.find(to);
		if (x === y) return false;
		if (x.generic === y.generic) {
			this.union(x, y);
			return true;
		}
		this.cross(x, y);
		if (!oneWay) this.cross(y, x);
		return false;
	},

	cross(this: Forms, from: Slot, to: Slot): void {
		const seen = this.crossed.get(from) ?? new Set<Slot>();
		this.crossed.set(from, seen);
		if (seen.has(to)) return;
		seen.add(to);
		this.edges.push([from, to, ~0]);
	},

	/**
	 * What an instantiation lets cross between a type parameter's slot and a concrete one: foreign never enters the type
	 * parameter's; in strict code, only the empty states the concrete slot's type admits.
	 */
	crossing(this: Forms, concrete: Slot, intoGeneric: boolean): number {
		const admitted = withAbsent(concrete.typed && concrete.type ? typeStates(concrete.type) : U | N);
		return ~((U | M | O | N | A | G) & ~admitted) & (intoGeneric ? ~F : ~0);
	},

	child(this: Forms, s: Slot, part: Part): Slot {
		const r = this.find(s);
		let c = r.children.get(part);
		if (!c) {
			const t = r.type ? elementType(this.checker, r.type, part) : null;
			c = new Slot(t ?? null);
			c.generic = isGeneric(t);
			if (!this.solved) this.made.push(c);
			if (r.fixed) {
				c.fixed = true;
				c.give(typeStates(t ?? undefined));
			} else if (r.typed) {
				c.typed = true;
				c.give(typeStates(t ?? undefined));
			}
			if (this.solved) return c;
			r.children.set(part, c);
			this.parts.add(c);
		}
		return this.find(c);
	},

	/** The slot a declaration is, or an expression's own (an array literal's, a call's result built here). */
	slotFor(this: Forms, n: ts.Node): Slot {
		let s = this.slots.get(n);
		if (s) return s;
		const declared = ts.isExpression(n) ? null : this.declaredType(n as ts.Declaration);
		s = new Slot(declared ?? (ts.isExpression(n) ? this.checker.getTypeAtLocation(n) : null), ts.isExpression(n) ? null : (n as ts.Declaration));
		s.generic = isGeneric(s.type);
		this.made.push(s);
		this.slots.set(n, s);
		s.typed = this.strict(n);
		if (!ts.isExpression(n)) {
			const file = sourceOf(n);
			if (!file) return s;
			const unset = (ts.isPropertySignature(n) || ts.isPropertyDeclaration(n)) && !!this.unsetMembers?.(n, this.checker);
			if (file.isDeclarationFile) {
				s.states = this.declaredStates(n as ts.Declaration);
				// A library's own declarations are its surface, which its callers write; others are fixed at what they say, and
				// a platform's at what its binding holds.
				if (unset) s.states |= U | G;
				else if (!this.ownDeclaration(n as ts.Declaration)) {
					s.fixed = true;
					if (this.nativeNil(n as ts.Declaration)) s.states |= N;
				} else if (writtenByCallers(n) && !this.strict(n)) s.states |= this.openStates(n as ts.Declaration);
			} else {
				if (this.strictFile(file)) s.states = this.declaredStates(n as ts.Declaration);
				if (unset) s.states |= U | G;
			}
			s.local = s.states;
		}
		return s;
	},

	declaredType(this: Forms, d: ts.Declaration): ts.Type | null {
		if (ts.isFunctionLike(d)) return this.checker.getSignatureFromDeclaration(d as ts.SignatureDeclaration)?.getReturnType() ?? null;
		const name = (d as ts.NamedDeclaration).name;
		const sym = name && this.checker.getSymbolAtLocation(name);
		return sym ? this.checker.getTypeOfSymbolAtLocation(sym, d) : name ? this.checker.getTypeAtLocation(name) : null;
	},

	/** What a declaration's own type says it holds: the checker's type (strict code), its type node (any code), `?`. */
	declaredStates(this: Forms, d: ts.Declaration): number {
		const node = (d as { type?: ts.TypeNode }).type;
		let s = typeNodeStates(node);
		if (!ts.isFunctionLike(d) || !isAsync(d as ts.SignatureDeclaration)) s |= typeStates(this.declaredType(d) ?? undefined);
		if ((d as { questionToken?: ts.Node }).questionToken && !ts.isMethodDeclaration(d)) s |= U;
		return s;
	},

	/** The slot a function's returns go to: its result, or its Promise's for an async function. */
	resultOf(this: Forms, fn: ts.SignatureDeclaration): Slot | null {
		if ((fn as ts.FunctionLikeDeclaration).asteriskToken) return null;
		const s = this.slotFor(fn);
		return isAsync(fn) ? this.child(s, 'result') : s;
	},
};

export type UnionFindMethods = typeof unionFindMethods;
