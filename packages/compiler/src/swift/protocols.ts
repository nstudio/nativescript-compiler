// Protocol conformance as Swift: the protocols a class implements and their witnesses.
import ts from 'typescript';
import { ident, isOptional, metatype, optionalType, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { implementedInterfaces, isEmittedInterface } from '../semantics/lang.ts';
import { UNKEYED } from '../semantics/shapes.ts';
import { hasModifier, isLibDeclaration } from '../semantics/ast.ts';
import { isCoreDeclaration } from '../program/core-facts.ts';
import { isNamed, isUntyped, spelledType } from '../semantics/types.ts';
import { ownClassMember, programBase, redeclaredMember } from '../semantics/classes.ts';

export const protocolsMethods = {
	/** Whether a class's source base class (or one above it) implements an interface. */
	baseImplements(this: Translator, cls: ts.ClassLikeDeclaration, iface: string): boolean {
		for (let c = this.sourceBase(cls); c; c = this.sourceBase(c)) {
			if ((c.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ImplementsKeyword)?.types ?? []).some((t) => this.heritageName(t) === iface)) return true;
		}
		return false;
	},

	/** Whether a program class named `cls` extends the program class or implements the interface named `ancestor`. */
	sourceExtends(this: Translator, cls: string, ancestor: string): boolean {
		for (let c = this.classNamed(cls) as ts.ClassLikeDeclaration | undefined; c && ts.isClassLike(c); c = this.sourceBase(c)) {
			if (c !== this.classNamed(cls) && c.name?.text === ancestor) return true;
			if (implementedInterfaces(this.checker, c).some((i) => this.heritageName(i) === ancestor)) return true;
		}
		return false;
	},

	/** The adapter API's name for `programBase`. */
	sourceBase(this: Translator, cls: ts.ClassLikeDeclaration): ts.ClassLikeDeclaration | undefined {
		return programBase(cls, this.checker);
	},

	/** The interfaces a class implements, named or met, that are Swift protocols it conforms to; `witnesses` gets the adapters its methods need. */
	implementedProtocols(this: Translator, cls: ts.ClassLikeDeclaration, kitRoot: string | null, witnesses: string[]) {
		const named = implementedInterfaces(this.checker, cls).map((i) => ({ name: this.heritageName(i), type: this.checker.getTypeAtLocation(i) }));
		const met = [...(this.structural.get(cls) ?? [])].map((d) => ({ name: this.topName(d, d.name.text), type: this.checker.getTypeAtLocation(d.name) }));
		const implemented = [...named, ...met.filter((m) => !named.some((n) => n.name === m.name))]
			.filter((i) => isEmittedInterface(i.type) && !isLibDeclaration(i.type.getSymbol()?.declarations?.[0]) && !this.uncompiledType(i.type))
			// An interface only a declaration file has is no Swift protocol (a plugin's `IHttpsResponseLegacy` in its `.d.ts`), unless core's
			// that the kit has; nor is one the program has no declaration of (a plugin's `import { IOptions } from '.'`, which the platform
			// suffix resolves to the importing file itself).
			.filter((i) => !(i.type.getSymbol()?.declarations ?? []).every((d) => d.getSourceFile().isDeclarationFile && (this.library || !isCoreDeclaration(d) || !this.core.has(i.name))))
			// A protocol a base class conforms to is inherited; one the class's signatures cannot meet is left out.
			.filter((i) => !this.baseImplements(cls, i.name) && this.protocolWitnesses(cls, i.name, i.type, witnesses))
			// An interface a kit class's own methods meet (a plugin's `IChartBase.on` by View's `on`): script's structural typing, no Swift protocol.
			.filter((i) => !kitRoot || !i.type.getProperties().some((p) => !!this.core.kitMember(kitRoot, p.name)))
			.map((i) => i.name);
		for (const i of implemented) this.used.add(i);
		return { named, met, implemented };
	},

	/**
	 * A component class's conformance to the app interfaces it implements, as an extension of it. Every app protocol
	 * refines JSDynamic, which here reads and writes the interfaces' fields only.
	 */
	componentConformance(this: Translator, cls: ts.ClassDeclaration, name: string): string {
		const witnesses: string[] = [];
		const { named, met, implemented } = this.implementedProtocols(cls, null, witnesses);
		if (!implemented.length) return '';
		const seen = new Set<string>();
		const fields: { name: string; type: string }[] = [];
		const readOnly: { name: string; get: string; set: null }[] = [];
		for (const i of [...named, ...met].filter((x) => implemented.includes(x.name))) {
			const decl = i.type.getSymbol()?.declarations?.find(ts.isInterfaceDeclaration);
			for (const m of decl?.members ?? []) {
				if (!ts.isPropertySignature(m) || !ts.isIdentifier(m.name) || seen.has(m.name.text)) continue;
				seen.add(m.name.text);
				const type = m.questionToken ? optionalType(this.typeOf(m)) : this.typeOf(m);
				if (hasModifier(m, ts.SyntaxKind.ReadonlyKeyword) || this.implementedReadOnly(i.name, m.name.text)) readOnly.push({ name: m.name.text, get: this.untypedEnum(`self.${ident(m.name.text)}`, type), set: null });
				else fields.push({ name: m.name.text, type });
			}
		}
		return [`extension ${name}: ${implemented.join(', ')} {`, ...witnesses, ...this.dynamicMembers(UNKEYED, { fields, className: cls.name?.text ?? name, accessors: readOnly }), '}'].join('\n');
	},

	/**
	 * A field of an app's generic interface, which its protocol holds as any value, that a generic class meets with a field
	 * or getter typed by its own type parameter: Swift can't overload a property by its type, so no witness meets it.
	 */
	fieldByOwnParameter(this: Translator, cls: ts.ClassLikeDeclaration, req: ts.TypeElement): boolean {
		if (!ts.isPropertySignature(req) || !ts.isIdentifier(req.name) || !cls.typeParameters?.length || !isNamed(spelledType(this.typeOf(req)), 'Any', false)) return false;
		const name = req.name.text;
		const field = cls.members.find((x) => x.name?.getText() === name) ?? cls.members.find(ts.isConstructorDeclaration)?.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === name && !!ts.getModifiers(p)?.length);
		if (!field || !(ts.isPropertyDeclaration(field) || ts.isParameter(field) || ts.isGetAccessorDeclaration(field) || ts.isSetAccessorDeclaration(field))) return false;
		const t = this.checker.getTypeAtLocation(field.name);
		return !!(t.flags & ts.TypeFlags.TypeParameter) && t.symbol?.declarations?.[0]?.parent === cls;
	},

	/**
	 * Whether a class can conform to an interface's protocol. A method whose
	 * untyped parameters the protocol types (`handlerError(error)` for
	 * `handlerError(error: Error)`) conforms through a witness of the protocol's
	 * signature that calls it; any other difference leaves the protocol out.
	 */
	protocolWitnesses(this: Translator, cls: ts.ClassLikeDeclaration, name: string, type: ts.Type, out: string[]): boolean {
		const decl = type.getSymbol()?.declarations?.find(ts.isInterfaceDeclaration);
		if (!decl || !this.protocols.has(name)) return true;
		const added: string[] = [];
		// The protocol refines its interface's bases: their members are required too.
		const inherited = type
			.getProperties()
			.flatMap((p) => p.declarations ?? [])
			.filter((d): d is ts.PropertySignature | ts.MethodSignature => (ts.isPropertySignature(d) || ts.isMethodSignature(d)) && ts.isInterfaceDeclaration(d.parent) && d.parent !== decl && !d.parent.typeParameters?.length && !d.getSourceFile().isDeclarationFile && !decl.members.some((m) => m.name?.getText() === d.name.getText()));
		for (const req of [...decl.members, ...new Map(inherited.map((d) => [d.name.getText(), d])).values()]) {
			const name = req.name?.getText();
			if (!name) continue;
			if (this.fieldByOwnParameter(cls, req)) return false;
			const m = ownClassMember(cls, name, this.checker);
			// A parameter property or an inherited member the class does not declare: Swift checks it.
			if (!m) continue;
			if (ts.isPropertySignature(req)) {
				const want = req.questionToken ? optionalType(this.typeOf(req)) : this.typeOf(req);
				const root = redeclaredMember(m, this.checker);
				const fieldType = ts.isPropertyDeclaration(m) ? this.typeOf(m.name) : ts.isParameter(m) ? (!!m.questionToken && !isOptional(this.typeOf(m.name)) && !isUntyped(spelledType(this.typeOf(m.name))) ? optionalType(this.typeOf(m.name)) : this.typeOf(m.name)) : null;
				const have = ts.isGetAccessorDeclaration(m) ? (this.narrowedFrom(m) ?? this.returnTypeOf(m)) : root ? this.redeclaredType(root) : fieldType;
				if (have !== want) return false;
				continue;
			}
			if (!ts.isMethodSignature(req) || !ts.isMethodDeclaration(m)) return false;
			const want = req.parameters.map((p) => this.requirementParamType(p));
			const have = m.parameters.map((p) => this.paramType(p));
			const ret = this.returnTypeOf(req),
				ownRet = this.returnTypeOf(m);
			if (want.length === have.length && want.every((t, k) => t === have[k]) && ret === ownRet) continue;
			// A generic class's own type parameter where the protocol, which erases the interface's, takes or gives any value.
			const typeParameter = (t: string) => !!cls.typeParameters?.some((p) => p.name.text === t);
			const erased = (t: string, k: number) => isUntyped(spelledType(want[k])) && typeParameter(t);
			if (want.length !== have.length || have.some((t, k) => t !== want[k] && !isUntyped(spelledType(t)) && !erased(t, k)) || (ret !== ownRet && !isUntyped(spelledType(ret)))) return false;
			// Same parameters and another result is an overload by result alone, which a call can tell apart only by a typed binding.
			const byResult = want.every((t, k) => t === have[k]);
			if (byResult && !typeParameter(ownRet)) return false;
			const args = want.map((_, k) => `__p${k}`);
			const call = this.marks.tryCode(`self.${ident(name)}(${args.map((a, k) => (have[k] === want[k] ? a : erased(have[k], k) ? this.marks.ownTried(`${RT.jsChecked}(${a}, ${metatype(have[k])})`) : `${a} as Any?`)).join(', ')})`);
			const body = ret === 'Void' ? call : ownRet === 'Void' ? `${call}; return nil` : byResult ? `let __r: ${ownRet} = ${call}; return __r` : `return ${call}`;
			added.push(`    func ${ident(name)}(${want.map((t, k) => `_ ${args[k]}: ${t}`).join(', ')}) throws${ret === 'Void' ? '' : ` -> ${ret}`} { ${body} }`);
			this.declare(name, { kind: 'func', params: want.map((t, k) => `_ ${args[k]}: ${t}`).join(', '), throws: true, type: ret });
		}
		out.push(...added);
		return true;
	},
};
