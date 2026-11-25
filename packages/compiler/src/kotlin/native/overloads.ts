// Which Java overload a call takes, chosen by its arguments' TypeScript types.
import ts from 'typescript';
import { ACC_INTERFACE, ACC_VARARGS, javaTypeName, signatureTypes, type JavaMember } from './classfiles.ts';
import type { AndroidNativeAPI } from './api.ts';
import { BOXED_NUMBERS, NATIVE_BUFFER_TYPES, NUMBER_RANK, NUMERIC, atom, extensionClasses, numericLiteral, type Callable, type Kind } from './bridging.ts';
import { argumentSlot, place } from '../../semantics/placement.ts';
import { cast } from '../syntax.ts';
import { rethrowUnlessRefused } from '../../semantics/refusals.ts';
import { isKit, isUntyped, spelledType } from '../../semantics/types.ts';

export const nativeOverloadsMethods = {
	kind(this: AndroidNativeAPI, e: ts.Expression): Kind {
		while (ts.isParenthesizedExpression(e)) e = e.expression;
		const self = this.extensionOfThis(e);
		if (self) return { kind: 'object', classes: extensionClasses(self) };
		const own = this.ownMember(e);
		if (own && !own.fn) return this.kindOfType(this.t.checker.getTypeAtLocation(own.p.name!), e);
		const made = ts.isNewExpression(e) ? this.extensionNamed(e.expression) : null;
		if (made) return { kind: 'object', classes: extensionClasses(made) };
		if (e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined')) return { kind: 'null' };
		// `x as never` passes x as it is: the Java classes its type includes pick the overload.
		if (ts.isAsExpression(e) && this.t.checker.getTypeAtLocation(e).flags & ts.TypeFlags.Never) {
			if (this.isBuffer(e)) return { kind: 'object', classes: ['java/nio/ByteBuffer'] };
			const inner = this.t.checker.getNonNullableType(this.t.checker.getTypeAtLocation(e.expression));
			const classes = (inner.isUnion() ? inner.types : [inner]).flatMap((p) => this.classesOf(p) ?? []);
			if (classes.length) return { kind: 'object', classes };
		}
		const forced = this.forced(e);
		if (forced) return { kind: 'number', forced: forced.desc };
		const literal = numericLiteral(e);
		if (literal !== null) return { kind: 'number', literal };
		if (ts.isStringLiteralLike(e)) return { kind: 'string', literal: e.text };
		const type = this.t.checker.getTypeAtLocation(e);
		// A Java member read through an untyped package root: the type Java gives it.
		if (type.flags & ts.TypeFlags.Any) {
			const raw = this.raw(e) ?? this.createdArray(e);
			if (raw) return this.kindOfDescriptor(raw.desc);
		}
		return this.kindOfType(type, e);
	},

	/** An ArrayBuffer or a typed array (through `as never`): its bytes are what a ByteBuffer parameter takes, as NativeScript passes them. */
	isBuffer(this: AndroidNativeAPI, e: ts.Expression): boolean {
		while (ts.isParenthesizedExpression(e)) e = e.expression;
		const c = this.t.checker;
		const type = c.getNonNullableType(c.getTypeAtLocation(ts.isAsExpression(e) && c.getTypeAtLocation(e).flags & ts.TypeFlags.Never ? e.expression : e));
		const parts = type.isUnion() ? type.types : [type];
		return parts.every((p) => NATIVE_BUFFER_TYPES.has(p.getSymbol()?.name ?? ''));
	},

	kindOfDescriptor(this: AndroidNativeAPI, desc: string): Kind {
		if (NUMERIC.has(desc)) return { kind: 'number' };
		if (desc === 'Z') return { kind: 'boolean' };
		if (desc === 'Ljava/lang/String;' || desc === 'Ljava/lang/CharSequence;' || desc === 'C') return { kind: 'string' };
		if (desc.startsWith('[')) return { kind: 'array', elem: this.kindOfDescriptor(desc.slice(1)) };
		if (desc.startsWith('L')) return desc === 'Ljava/lang/Object;' ? { kind: 'any' } : { kind: 'object', classes: [desc.slice(1, -1)] };
		return { kind: 'other' };
	},

	kindOfType(this: AndroidNativeAPI, type: ts.Type, where?: ts.Node): Kind {
		const c = this.t.checker;
		const nn = c.getNonNullableType(type);
		if (nn.flags & ts.TypeFlags.Never) return { kind: 'null' };
		let kt: string;
		try {
			kt = this.t.type(nn, where);
		} catch (e) {
			rethrowUnlessRefused(e);
			return { kind: 'other' };
		}
		if (kt === 'Double') return { kind: 'number' };
		if (kt === 'String') return { kind: 'string' };
		if (kt === 'Boolean') return { kind: 'boolean' };
		if (isUntyped(spelledType(kt)) || kt === 'Any') return { kind: 'any' };
		if (isKit(spelledType(kt), 'JSArray')) {
			const el = c.isArrayType(nn) || this.isJavaArray(nn) ? c.getTypeArguments(nn as ts.TypeReference)[0] : undefined;
			return { kind: 'array', elem: el ? this.kindOfType(el, where) : { kind: 'any' } };
		}
		const classes = this.classesOf(nn);
		return classes ? { kind: 'object', classes } : { kind: 'other' };
	},

	/** How well a value of `k` fits a parameter of Java type `desc`: lower is closer, null is not at all. */
	score(this: AndroidNativeAPI, k: Kind, desc: string): number | null {
		const ref = desc.startsWith('L') || desc.startsWith('[');
		const cls = desc.startsWith('L') ? desc.slice(1, -1) : '';
		switch (k.kind) {
			case 'null':
				return ref ? 1 : null;
			case 'any':
				return 20;
			case 'number':
				if (k.forced) return desc === k.forced ? 0 : null;
				if (NUMERIC.has(desc)) return k.literal !== undefined && !Number.isInteger(k.literal) ? (desc === 'D' ? 0 : desc === 'F' ? 1 : null) : NUMBER_RANK[desc];
				if (desc === 'C') return 8;
				if (BOXED_NUMBERS.has(cls)) return 9;
				return cls === 'java/lang/Object' ? 30 : null;
			case 'string':
				if (cls === 'java/lang/String') return 0;
				if (cls === 'java/lang/CharSequence') return 1;
				if (desc === 'C' && k.literal?.length === 1) return 3;
				return cls && this.classpath.distance('java/lang/String', cls) !== null ? 2 + this.classpath.distance('java/lang/String', cls)! : null;
			case 'boolean':
				if (desc === 'Z') return 0;
				if (cls === 'java/lang/Boolean') return 1;
				return cls === 'java/lang/Object' ? 30 : null;
			case 'array': {
				if (cls === 'java/lang/Object') return 40;
				if (!desc.startsWith('[')) return null;
				const inner = k.elem.kind === 'any' ? 5 : this.score(k.elem, desc.slice(1));
				return inner === null ? null : inner;
			}
			case 'object': {
				if (!ref || desc.startsWith('[')) return null;
				let best: number | null = null;
				for (const from of k.classes) {
					const d = this.classpath.distance(from, cls);
					if (d !== null && (best === null || d < best)) best = d;
				}
				return best;
			}
		}
		return null;
	},

	resolveOverload(this: AndroidNativeAPI, candidates: Callable[], args: ts.Expression[], node: ts.Node, owner: string, name: string): Callable {
		const chosen = this.chooseOverload(candidates, args, node, owner, name);
		this.used(chosen.m);
		return chosen;
	},

	/**
	 * What marks an override of a deprecated Java method: `@Deprecated`, as Android Studio marks one, or for an interface's
	 * method, which Kotlin 2.2 flags whatever marks the override, the warning suppressed.
	 */
	deprecatedOverride(this: AndroidNativeAPI, m: JavaMember, indent: string): string {
		if (!m.deprecated) return '';
		const iface = !!((this.classpath.get(m.owner)?.access ?? 0) & ACC_INTERFACE);
		return `${indent}${iface ? '@Suppress("OVERRIDE_DEPRECATION")' : '@Deprecated("Deprecated in Java")'}\n`;
	},

	/** A member translated code uses: its deprecation noted, for the declaration using it. */
	used<M extends JavaMember>(this: AndroidNativeAPI, m: M): M {
		if (m.deprecated) this.t.noteDeprecated(`${m.owner}#${m.name}`);
		this.t.noteThreadRestricted(`${m.owner}#${m.name}`);
		return m;
	},

	chooseOverload(this: AndroidNativeAPI, candidates: Callable[], args: ts.Expression[], node: ts.Node, owner: string, name: string): Callable {
		const what = name === '<init>' ? `new ${javaTypeName(`L${owner};`)}` : `${javaTypeName(`L${owner};`)}.${name}()`;
		if (args.some(ts.isSpreadElement)) throw this.t.error(node, `${what} with a spread argument`, 'native');
		if (!candidates.length) throw this.t.error(node, `${what} (no accessible Java constructor)`, 'native');
		const kinds = args.map((a) => this.kind(a));
		// A varargs method also takes its last parameter's elements one by one, ranked after every fixed-arity match as Java ranks it.
		const spread = candidates.flatMap((c): Callable[] => {
			const fixed = c.params.length - 1;
			if (!(c.m.access & ACC_VARARGS) || !c.params[fixed]?.startsWith('[') || args.length < fixed) return [];
			return [{ ...c, params: [...c.params.slice(0, fixed), ...Array(args.length - fixed).fill(c.params[fixed].slice(1))], fixed }];
		});
		const scored = [...candidates, ...spread]
			.filter((c) => c.params.length === args.length)
			.map((c) => {
				let total = c.fixed === undefined ? 0 : 100;
				for (let k = 0; k < args.length; k++) {
					const s = this.score(kinds[k], c.params[k]);
					if (s === null) return null;
					total += s;
				}
				return { c, total };
			})
			.filter((x): x is { c: Callable; total: number } => !!x);
		const list = () => candidates.map((c) => this.display(owner, name, c)).join('; ');
		if (!scored.length) throw this.t.error(node, `${what} (no Java overload takes these ${args.length} arguments; there are ${list()})`, 'native');
		const best = Math.min(...scored.map((x) => x.total));
		const top = scored.filter((x) => x.total === best).map((x) => x.c);
		if (top.length === 1) return top[0];
		const specific = top.filter((a) => top.every((b) => a === b || this.moreSpecific(a, b)));
		if (specific.length === 1) return specific[0];
		throw this.t.error(node, `${what} (ambiguous between ${top.map((c) => this.display(owner, name, c)).join(' and ')}; cast the argument to pick one)`, 'native');
	},

	moreSpecific(this: AndroidNativeAPI, a: Callable, b: Callable): boolean {
		return a.params.every((p, k) => {
			const q = b.params[k];
			if (p === q) return true;
			if (NUMERIC.has(p) && NUMERIC.has(q)) return 'BSIJFD'.indexOf(p) < 'BSIJFD'.indexOf(q);
			if (p.startsWith('L') && q.startsWith('L')) return this.classpath.distance(p.slice(1, -1), q.slice(1, -1)) !== null;
			return false;
		});
	},

	argList(this: AndroidNativeAPI, call: ts.CallExpression | ts.NewExpression, args: readonly ts.Expression[], chosen: Callable, candidates: Callable[], typeVar?: (name: string) => string): string {
		const overloaded = candidates.filter((c) => c.params.length === chosen.params.length).length > 1;
		const last = chosen.fixed === undefined && chosen.m.access & ACC_VARARGS ? chosen.params.length - 1 : -1;
		return args
			.map((a, k) => {
				const desc = chosen.params[k];
				const nonNull = !!chosen.m.nonNullParams?.[k];
				const generic = chosen.m.signature ? signatureTypes(chosen.m.signature) : null;
				const at = call.arguments?.indexOf(a) ?? -1;
				const native = { nullable: !!chosen.m.nullableParams?.[k], nonNull, signature: generic && generic.params.length === chosen.params.length ? generic.params[k] : undefined, typeVar };
				let code = place(this.t.placement, a, argumentSlot(this.t.placement, desc, undefined, { call, k: at, a: at < 0 ? undefined : a }, { native }));
				// Kotlin resolves the overload again: a null or untyped argument names the parameter type it means.
				const loose = this.kind(a).kind;
				if (overloaded && (desc.startsWith('L') || desc.startsWith('[')) && (loose === 'null' || loose === 'any')) code = cast(code, `${this.kotlinType(desc, 'Any?')}${nonNull && loose === 'any' ? '' : '?'}`);
				// An array where Kotlin declares `vararg`: spread, or Kotlin passes it as one element.
				if (k === last && code !== 'null') return `*${code.endsWith('?)') ? this.t.asserted(code) : /\?\.to\w*Array\(\)$/.test(code) ? `(${code} ?: arrayOf())` : atom(code)}`;
				// `getMethod(name, null)`: Java's null array is no arguments there.
				if (k === last && code === 'null' && args.length === chosen.params.length) return '*arrayOf()';
				return code;
			})
			.join(', ');
	},
};
