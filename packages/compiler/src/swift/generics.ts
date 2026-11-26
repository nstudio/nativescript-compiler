// Generics as Swift: kept and erased generics, type parameters and type arguments.
import ts from 'typescript';
import type { Translator } from './translator.ts';
import { isCoreDeclaration } from '../program/core-facts.ts';
import { memberOwner, namesOwnTypeParameter } from '../semantics/lang.ts';
import { isUntyped, spelledType } from '../semantics/types.ts';

export const genericsMethods = {
	/**
	 * Library mode: a function whose type parameters its parameters use is generic in Swift too, so the
	 * arrays and objects it takes stay the caller's; a plugin's other generics are erased.
	 */
	keepsGenerics(this: Translator, fn: ts.Node): boolean {
		if (!ts.isFunctionDeclaration(fn) || !fn.body || !fn.typeParameters?.length) return false;
		// A plugin's function taking a `T[]` stays generic too, so its `push`/`splice` land on the caller's array.
		if (!this.library && !fn.parameters.some((p) => p.type && this.typeParameterArray(p.type, fn))) return false;
		let found = this.genericFunctions.get(fn);
		if (found !== undefined) return found;
		const params = new Set(fn.typeParameters.map((p) => this.checker.getSymbolAtLocation(p.name)));
		// Bounded by a class or not at all, and named only as a whole value or an array of them: what Swift's generics say alike.
		found = fn.typeParameters.every((p) => !p.constraint || !!this.checker.getTypeFromTypeNode(p.constraint).getSymbol()?.declarations?.some(ts.isClassDeclaration));
		const plain = (n: ts.Node): boolean => {
			let at = n.parent;
			while (ts.isArrayTypeNode(at) || (!this.library && ts.isUnionTypeNode(at) && ts.isParameter(at.parent) && this.typeParameterArray(at, fn))) at = at.parent;
			return ts.isParameter(at) || ts.isFunctionDeclaration(at) || ts.isVariableDeclaration(at) || ts.isAsExpression(at) || ts.isTypeAssertionExpression(at) || ts.isNewExpression(at) || ts.isCallExpression(at);
		};
		const visit = (n: ts.Node) => {
			if (!found) return;
			if (ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName) && params.has(this.checker.getSymbolAtLocation(n.typeName)) && !plain(n)) found = false;
			ts.forEachChild(n, visit);
		};
		visit(fn);
		this.genericFunctions.set(fn, found);
		return found;
	},

	/** Whether `type` is an array of one of `fn`'s type parameters (`T[]`, `Array<T>`), maybe or null or undefined. */
	typeParameterArray(this: Translator, type: ts.TypeNode, fn: ts.FunctionDeclaration): boolean {
		if (ts.isUnionTypeNode(type)) {
			const rest = type.types.filter((t) => !(t.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword)));
			return rest.length === 1 && this.typeParameterArray(rest[0], fn);
		}
		const element = ts.isArrayTypeNode(type) ? type.elementType : ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === 'Array' && type.typeArguments?.length === 1 ? type.typeArguments[0] : undefined;
		return !!element && ts.isTypeReferenceNode(element) && ts.isIdentifier(element.typeName) && !element.typeArguments && fn.typeParameters!.some((p) => p.name.text === (element.typeName as ts.Identifier).text);
	},

	/**
	 * Whether Swift has a generic class or function of a plugin's (or of the kit's, in library mode) without its type
	 * parameters: TypeScript's generic classes are structurally variant, Swift's invariant, so plugin code assigning
	 * `Plot<Point>` where `Plot<any>` is taken compiles only erased. Each parameter is then any value.
	 */
	erasesGenerics(this: Translator, decl: ts.Node): boolean {
		if (decl.getSourceFile().isDeclarationFile) return false;
		if (ts.isClassDeclaration(decl) && this.framework.hooks.erasesGenericClass?.(decl)) return true;
		return this.pluginFiles.has(decl.getSourceFile().fileName) && !this.keepsGenerics(decl);
	},

	/** The Swift type of a member whose declared type names a type parameter of its erased generic class (`data: T` as `Any?`); null for any other. */
	erasedMemberType(this: Translator, decl: ts.NamedDeclaration): string | null {
		if (this.library) return null;
		const owner = memberOwner(decl);
		if (!owner || !this.erasesGenerics(owner) || !namesOwnTypeParameter(decl, this.checker) || !decl.name) return null;
		// As the plugin's own file declares it, whatever file reads it.
		const t = this.inFile(decl.getSourceFile().fileName, () => (ts.isParameter(decl) ? this.paramType(decl) : this.typeOf(decl.name!)));
		return t.replace(/!$/, '?');
	},

	generics(this: Translator, fn: ts.SignatureDeclaration | ts.ClassLikeDeclaration): string {
		if (this.erasesGenerics(fn)) return '';
		const kept = (fn.typeParameters ?? []).filter((p) => !this.erasesTypeParameter(p));
		for (const p of kept) this.genericNames.add(p.name.text);
		// A constraint naming a class: what the body may read of the parameter.
		const bound = (p: ts.TypeParameterDeclaration) => {
			const c = p.constraint && this.checker.getTypeFromTypeNode(p.constraint);
			const cls = c?.getSymbol()?.declarations?.find(ts.isClassDeclaration);
			return cls && (!cls.getSourceFile().isDeclarationFile || (!this.library && isCoreDeclaration(cls) && !!cls.name && this.core.has(cls.name.text))) ? `: ${this.type(c!, p)}` : '';
		};
		return kept.length ? `<${kept.map((p) => `${p.name.text}${bound(p)}`).join(', ')}>` : '';
	},

	/** `<DatePicker>` of `extends UITest<DatePicker>`: the arguments a generic program class is extended with. */
	typeArguments(this: Translator, heritage: ts.ExpressionWithTypeArguments, base: ts.ClassLikeDeclaration): string {
		const params = (base.typeParameters ?? []).filter((p) => !this.erasesTypeParameter(p));
		if (!params.length || this.erasesGenerics(base)) return '';
		const args = (base.typeParameters ?? []).map((p, k) => (this.erasesTypeParameter(p) ? null : this.typeArgument(p, heritage.typeArguments?.[k]))).filter((a): a is string => a !== null);
		return `<${args.join(', ')}>`;
	},

	/** A type parameter's argument as a type: its constraint's class where it is any value. */
	typeArgumentOf(this: Translator, p: ts.TypeParameterDeclaration, a: ts.Type, where?: ts.Node): string {
		const t = this.type(a, where);
		if (!isUntyped(spelledType(t)) || !p.constraint) return t;
		const bound = this.checker.getTypeFromTypeNode(p.constraint);
		return bound.getSymbol()?.flags! & ts.SymbolFlags.Class ? this.type(bound, p.constraint) : t;
	},

	/** A type parameter's argument: `any`, or none, is what the parameter is bound to (`UITest<any>` is `UITest<View>`). */
	typeArgument(this: Translator, p: ts.TypeParameterDeclaration, a: ts.TypeNode | undefined): string {
		const node = a ?? p.default;
		const t = node ? this.type(this.checker.getTypeFromTypeNode(node), node) : 'Any?';
		if (!isUntyped(spelledType(t)) || !p.constraint) return t;
		const bound = this.checker.getTypeFromTypeNode(p.constraint);
		return bound.getSymbol()?.flags! & ts.SymbolFlags.Class ? this.type(bound, p.constraint) : t;
	},

	/** The Swift types a class binds an ancestor's type parameters to (`T` of `UITest<T>` as `DatePicker` from `extends UITest<DatePicker>`). */
	boundTypeParameters(this: Translator, cls: ts.ClassLikeDeclaration, ancestor: ts.ClassLikeDeclaration): Map<string, string> {
		let bound = new Map<string, string>();
		for (let c: ts.ClassLikeDeclaration | undefined = cls; c && c !== ancestor;) {
			const h = c.heritageClauses?.find((x) => x.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
			const base = this.sourceBase(c);
			if (!h || !base) break;
			const below = bound;
			bound = new Map(
				(base.typeParameters ?? []).map((p, k): [string, string] => {
					const t = this.typeArgument(p, h.typeArguments?.[k]);
					return [p.name.text, t.replace(/\b[A-Z]\w*\b/g, (n) => below.get(n) ?? n)];
				}),
			);
			c = base;
		}
		return bound;
	},
};
