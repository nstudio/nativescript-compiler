// A class declaration's initializers as Swift: its constructor or the initializer its fields need, the one a literal makes it with, and jsConstruct.
import ts from 'typescript';
import { ident, optionalType, swiftString, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import type { ClassParts } from './class-declaration.ts';
import { notesNull } from '../semantics/shapes.ts';
import { refersToThis } from '../semantics/ast.ts';
import { isStatic } from '../semantics/throws.ts';
import { constructorOf } from '../semantics/classes.ts';
import { ERRORS, errorArguments } from '../semantics/globals.ts';

export const classConstructorMethods = {
	constructorMembers(this: Translator, k: ClassParts): void {
		const { cls, name, appBase, base, kitRoot, lines, fieldInits } = k;
		const { ctor } = k.layout;
		if (appBase) this.warnConstructionOrder(cls, appBase);
		// The constructor: super() first, then parameter properties and field initializers in the plan's order, then the body (JavaScript's order).
		const baseCtor = appBase && constructorOf(appBase, this.checker);
		if (ctor) this.declaredInit(k, ctor, baseCtor);
		else if (fieldInits.length || this.throwsInfo.initThrows(cls) || this.levelStart(cls).length) {
			const baseThrows = appBase ? this.throwsInfo.initThrows(appBase) : !!kitRoot && this.core.initThrows(kitRoot);
			if (baseCtor) this.declareInit(this.params(baseCtor, false), baseThrows || this.throwsInfo.initThrows(cls));
			else this.declareInit('', this.throwsInfo.initThrows(cls));
			if (baseCtor) lines.push(`    override init(${this.params(baseCtor, false)})${baseThrows || this.throwsInfo.initThrows(cls) ? ' throws' : ''} {`, `        ${baseThrows ? 'try ' : ''}super.init(${this.readsArguments(baseCtor) ? '__arguments' : baseCtor.parameters.map((p) => ident((p.name as ts.Identifier).text)).join(', ')})`, ...this.levelStart(cls), ...fieldInits, '    }');
			else lines.push(`    ${appBase || kitRoot || k.collection ? 'override ' : ''}init()${this.throwsInfo.initThrows(cls) ? ' throws' : ''} {`, ...(appBase || kitRoot || k.collection ? [`        ${baseThrows ? 'try ' : ''}super.init()`] : []), ...this.levelStart(cls), ...fieldInits, '    }');
		} else if ((this.library || this.extended.has(name) || this.extendedDecls.has(cls)) && !base && !cls.members.some((m) => ts.isConstructorDeclaration(m)) && !(ts.isClassDeclaration(cls) && this.literalClasses().has(cls))) {
			// Library mode: Swift's implicit initializer is internal; an app makes the class (`new StyleScope()`) from another module.
			// A class subclassed: Swift would leave its implicit initializer nonisolated, and a subclass's, isolated to the main actor, could not override it.
			lines.push('    init() {}');
			this.declareInit('', false);
		}
		this.literalInit(k);
	},

	declaredInit(this: Translator, k: ClassParts, ctor: ts.ConstructorDeclaration, baseCtor: ts.ConstructorDeclaration | undefined): void {
		const { cls, layout, appBase, kitRoot, fieldInits, paramPropValues } = k;
		const { paramProps, superAt } = layout;
		const throws = this.throwsInfo.fn(ctor) ? ' throws' : '';
		// Swift matches an initializer by its labels and types (treating T! and T? as the same optional), not its parameters' names.
		const signature = (fn: ts.ConstructorDeclaration) =>
			this.params(fn, false)
				.replace(/_ [\w`]+: /g, '_: ')
				.replace(/ = [^,]*(?=,|$)/g, '')
				.replace(/!(?=,|$)/g, '?');
		const sameAsBase = baseCtor ? signature(baseCtor) === signature(ctor) : ctor.parameters.length === 0 && (!!appBase || !!kitRoot || !!k.collection);
		const body = this.inFunction('Void', () => {
			this.indent = '        ';
			this.lenientParams(ctor);
			const out: string[] = [...this.paramPrelude(ctor)];
			const stmts = [...ctor.body!.statements];
			const own = () => {
				const props = paramProps.flatMap((p) => {
					const n = (p.name as ts.Identifier).text;
					const note = this.states.nullishHeld(p) && notesNull(this.shapePlan(cls)?.fieldNulls.get(n)) ? [`        ${RT.jsNoteNull}(&jsNulls, ${swiftString(n)}, ${ident(n)}.jsAny)`] : [];
					return [`        self.${ident(n)} = ${paramPropValues.get(p)}`, ...note];
				});
				return layout.paramPropsFirst ? [...props, ...fieldInits] : [...fieldInits, ...props];
			};
			const notes = this.keyNotes;
			this.keyNotes = this.initKeyNotes(cls, ctor);
			try {
				if (superAt < 0) out.push(...own(), ...this.statements(stmts));
				else {
					out.push(...this.statements(stmts.slice(0, superAt)));
					const call = layout.superCall!;
					// Over a kit class: its initializer's parameter types.
					// Over a library error given options (`super(message, { cause })`): the cause they give.
					const errorName = k.isError ? Object.keys(ERRORS).find((n) => ERRORS[n] === k.base) : undefined;
					const given = !appBase && kitRoot ? this.core.kitInitArgs(kitRoot, call.arguments) : null;
					const collectionPopulate =
						!appBase && k.collection && call.arguments.length === 1 && /^JS(Map|Set)</.test(k.collection)
							? k.collection.startsWith('JSMap<')
								? [`        for (__k, __v) in ${this.iterable(call.arguments[0])} { self.set(__k, __v) }`]
								: [`        for __v in ${this.iterable(call.arguments[0])} { self.add(__v) }`]
							: [];
					const init = errorName && errorArguments(errorName, call.arguments).options ? this.errorCall('super.init', errorName, call.arguments) : collectionPopulate.length ? 'super.init()' : `super.init(${(given ?? this.args(call)).join(', ')})`;
					out.push(`        ${this.tryPrefix(call)}${init}`, ...collectionPopulate, ...this.levelStart(cls), ...own(), ...this.statements(stmts.slice(superAt + 1)));
				}
			} finally {
				this.keyNotes = notes;
			}
			return out;
		});
		this.indent = '    ';
		k.lines.push(`    ${sameAsBase ? 'override ' : ''}init(${this.params(ctor, false)})${throws} {`, ...body, '    }');
		this.declareInit(this.params(ctor, false), !!throws);
	},

	literalInit(this: Translator, k: ClassParts): void {
		const { cls, lines } = k;
		// A class object literals are typed as (`const info = <Info>{}`): an instance made without its constructor or field initializers, as such a literal has none.
		if (ts.isClassDeclaration(cls) && this.literalMade(cls)) {
			const resets = cls.members
				.filter((m): m is ts.PropertyDeclaration => ts.isPropertyDeclaration(m) && !isStatic(m) && !!m.initializer && this.pure(m.initializer) && !refersToThis(m.initializer) && k.fields.some((f) => f.name === m.name.getText()))
				.flatMap((m) => {
					const z = this.zero(this.typeOf(m.name));
					return z ? [`        self.${ident(m.name.getText())} = ${z}`] : [];
				});
			lines.push('    init(jsLiteral: Void) {', ...resets, '    }');
			this.declareInit('jsLiteral: Void', false);
			// A class Swift gave `init()` only while it declared no other.
			if (!k.layout.ctor && !k.fieldInits.length) {
				lines.push('    init() {}');
				this.declareInit('', false);
			}
		}
	},

	constructibleMember(this: Translator, k: ClassParts): void {
		const { cls, name, appBase, kitRoot } = k;
		const { ctor } = k.layout;
		const hierarchyRoot = (c: ts.ClassLikeDeclaration) => {
			let r = c;
			for (let b = this.sourceBase(r); b; b = this.sourceBase(b)) r = b;
			return r;
		};
		const root = hierarchyRoot(cls);
		const rootConstructible = !kitRoot && !k.collection && !k.isError && !this.inNativeClass(cls) && (!root.typeParameters?.some((p) => !this.erasesTypeParameter(p)) || this.erasesGenerics(root)) && this.facts.classes().some((c) => ts.isClassDeclaration(c) && hierarchyRoot(c) === root && this.heldAsValue(c));
		if (rootConstructible && (!cls.typeParameters?.some((p) => !this.erasesTypeParameter(p)) || this.erasesGenerics(cls))) {
			if (!appBase) k.conformances.push('JSConstructibleType');
			const initCtor = constructorOf(cls, this.checker);
			const ctorArgs = !initCtor
				? []
				: this.inFile(initCtor.getSourceFile().fileName, () =>
						this.readsArguments(initCtor)
							? ['JSArray(__a)']
							: initCtor.parameters.map((p, k) => {
									const pt = this.typeOf(p.name);
									if (p.dotDotDotToken) return `JSArray(__a.dropFirst(${k}).map { ${this.fromAnyCode('$0', pt.replace(/^JSArray<(.*)>$/, '$1'), true)} })`;
									if (this.constantDefault(p)) return `(${RT.jsFlat}(${RT.jsArg}(__a, ${k})) == nil ? ${this.storedInit(p.initializer!, pt, false, p)} : ${this.presentFromAny(`${RT.jsArg}(__a, ${k})`, pt, true, true)})`;
									if (p.questionToken || p.initializer || this.states.mayBeNull(p)) return this.fromAnyCode(`${RT.jsArg}(__a, ${k})`, optionalType(pt), true);
									return this.presentFromAny(`${RT.jsArg}(__a, ${k})`, pt, true, true);
								}),
					);
			const initThrows = ctor ? this.throwsInfo.fn(ctor) : (appBase ? this.throwsInfo.initThrows(appBase) : false) || this.throwsInfo.initThrows(cls) || (!!initCtor && this.throwsInfo.fn(initCtor));
			k.lines.push(`    ${appBase ? 'override ' : ''}class func jsConstruct(_ __a: [Any?]) throws -> Any? { ${initThrows ? 'try ' : ''}${ident(name)}(${ctorArgs.join(', ')}) }`);
			this.declare('jsConstruct', { kind: 'func', mods: `${appBase ? 'override ' : ''}class `, params: '_ __a: [Any?]', throws: true, type: 'Any?' });
		}
	},
};
