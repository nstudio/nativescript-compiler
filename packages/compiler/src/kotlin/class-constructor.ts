// A class declaration's constructors as Kotlin: its own (with the private one statements before `super(…)` need), the one its base or Error gives it, and the one a literal makes it with.
import ts from 'typescript';
import { ERRORS } from '../semantics/globals.ts';
import { assignsTo, ident, kotlinString, optionalType, splitTopLevel, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import type { ClassParts } from './class-declaration.ts';
import { notesNull } from '../semantics/shapes.ts';
import { isConstant } from '../semantics/lang.ts';
import { boundNames } from '../semantics/ast.ts';
import { constructorOf } from '../semantics/classes.ts';

export const classConstructorMethods = {
	constructorMembersCode(this: Translator, k: ClassParts): void {
		const { cls, appBase, base, isError, lines } = k;
		const { ctor } = k.layout;
		const baseCtor = appBase && constructorOf(appBase, this.checker);
		const early = this.statementsBeforeSuper(k.layout);
		if (ctor && early) this.beforeSuperInitCode(k, ctor, early);
		else if (ctor) this.declaredInitCode(k, ctor);
		else if (base) {
			const level = this.levelStart(cls);
			if (baseCtor) lines.push(`    constructor(${this.params(baseCtor, false)}) : super(${this.readsArguments(baseCtor) ? '__arguments' : baseCtor.parameters.map((p) => ident((p.name as ts.Identifier).text)).join(', ')})${level.length ? ' {' : ''}`, ...(level.length ? [...level, '    }'] : []));
			// `new HttpError(message, { cause })` of a class that declares no constructor: Error's.
			else if (isError && base !== 'JSAggregateError') lines.push(`    constructor(message: Any? = null, options: Any? = null) : super(if (message == null) "" else ${RT.jsToString}(message), ${RT.jsGetIfPresent}(options, "cause"))`);
			else if (k.collection) {
				lines.push(`    constructor() : super()${level.length ? ' {' : ''}`, ...(level.length ? [...level, '    }'] : []));
				const mapArgs = /^JSMap<(.*)>$/.exec(k.collection)?.[1];
				const setArg = /^JSSet<(.*)>$/.exec(k.collection)?.[1];
				if (mapArgs) {
					const [kt, vt] = splitTopLevel(mapArgs);
					lines.push(`    constructor(entries: Iterable<Pair<${kt}, ${vt}>>) : super(entries)${level.length ? ' {' : ''}`, ...(level.length ? [...level, '    }'] : []));
				} else if (setArg) {
					lines.push(`    constructor(values: Iterable<${setArg}>) : super(values)${level.length ? ' {' : ''}`, ...(level.length ? [...level, '    }'] : []));
				}
			} else lines.push(`    constructor() : super()${level.length ? ' {' : ''}`, ...(level.length ? [...level, '    }'] : []));
		} else if (k.literalMade) {
			const body = [...this.levelStart(cls), ...k.initsAfterParamProps];
			lines.push(...(body.length ? ['    constructor() {', ...body, '    }'] : ['    constructor()']));
		}
		this.literalInitCode(k);
	},

	beforeSuperInitCode(this: Translator, k: ClassParts, ctor: ts.ConstructorDeclaration, early: { pre: ts.Statement[]; superCall: ts.CallExpression; rest: ts.Statement[] }): void {
		const { cls, initsAfterParamProps, lines } = k;
		const { paramProps } = k.layout;
		// Statements before `super(…)` (Kotlin's delegation comes first) run in a function of the class's; the
		// super arguments, the parameters and the locals they declare go to a private constructor, which runs the rest.
		const { pre, superCall, rest } = early;
		const helper = `__beforeSuper${this.tmp++}`;
		const names = ctor.parameters.map((p, k) => (ts.isIdentifier(p.name) ? ident(p.name.text) : `__p${k}`));
		const locals = pre.flatMap((st) => (ts.isVariableStatement(st) ? st.declarationList.declarations.flatMap((d) => boundNames(d.name)) : []));
		const sig = this.checker.getResolvedSignature(superCall);
		const superTypes = (sig?.getParameters() ?? []).slice(0, superCall.arguments.length).map((p) => {
			const d = p.valueDeclaration;
			const t = this.type(this.checker.getTypeOfSymbolAtLocation(p, superCall), superCall);
			// As `args` passes them: optional where the program's constructor declares no constant default.
			const declared = !!d && ts.isParameter(d) && !d.getSourceFile().isDeclarationFile;
			return (declared && (d as ts.ParameterDeclaration).questionToken) || (declared && (d as ts.ParameterDeclaration).initializer && !isConstant((d as ts.ParameterDeclaration).initializer!)) ? optionalType(t) : t;
		});
		this.indent = '            ';
		const helperBody = this.inFunction('Unit', () => [...this.paramPrelude(ctor), ...this.statements(pre)]);
		const superArgs = superCall.arguments.map((a) => this.restArgument(superCall, a, 'Any?'));
		k.statics.push(`        private fun ${helper}(${this.params(ctor, true)}): Array<Any?> {`, ...helperBody, `            return arrayOf(${[...superArgs, ...names, ...locals.map((n) => ident(n.text))].join(', ')})`, '        }');
		this.indent = '        ';
		const restBody = this.inFunction('Unit', () => {
			const binds = [...ctor.parameters.map((p, k) => `        ${assignsTo(ctor.body!, this.checker.getSymbolAtLocation(p.name), this.checker) ? 'var' : 'val'} ${names[k]}: ${this.paramType(p)} = (__s[${superArgs.length + k}] as ${this.paramType(p)})`), ...locals.map((n, k) => `        var ${ident(n.text)}: ${optionalType(this.typeOf(n))} = (__s[${superArgs.length + names.length + k}] as ${optionalType(this.typeOf(n))})`)];
			const own = paramProps.map((p) => `        this.${ident((p.name as ts.Identifier).text)} = ${ident((p.name as ts.Identifier).text)}`);
			const notes = this.keyNotes;
			this.keyNotes = this.initKeyNotes(cls);
			try {
				return [...binds, ...this.levelStart(cls), ...own, ...initsAfterParamProps, ...this.statements(rest)];
			} finally {
				this.keyNotes = notes;
			}
		});
		for (const n of locals) {
			const sym = this.checker.getSymbolAtLocation(n);
			if (sym) this.nullableDecls.add(sym);
		}
		this.indent = '    ';
		lines.push(`    constructor(${this.params(ctor, false)}) : this(${helper}(${names.join(', ')}), Unit)`);
		lines.push(`    private constructor(__s: Array<Any?>, @Suppress("UNUSED_PARAMETER") __m: Unit) : super(${superTypes.map((t, k) => this.fromAnyCode(`__s[${k}]`, t, true)).join(', ')}) {`, ...restBody, '    }');
	},

	declaredInitCode(this: Translator, k: ClassParts, ctor: ts.ConstructorDeclaration): void {
		const { cls, appBase, base, kitRoot, isError, narrowedParams, initsAfterParamProps } = k;
		const { paramProps, superAt, superCall } = k.layout;
		// Before the body: the signature decides which parameters Kotlin holds nullable, which the body's reads follow.
		const signature = this.params(ctor, false);
		const body = this.inFunction('Unit', () => {
			this.indent = '        ';
			const out: string[] = [...this.paramPrelude(ctor)];
			const stmts = [...ctor.body!.statements];
			if (superAt > 0) throw this.error(stmts[0], 'statements before super() in a constructor');
			const own = paramProps.flatMap((p) => {
				const n = ident((p.name as ts.Identifier).text);
				if (!this.states.nullishHeld(p)) return [`        this.${n} = ${narrowedParams.has(p) ? `(${n} as ${narrowedParams.get(p)})` : n}`];
				const note = notesNull(this.shapePlan(cls)?.fieldNulls.get((p.name as ts.Identifier).text)) ? [`        jsNulls = ${RT.jsNoteNull}(jsNulls, ${kotlinString((p.name as ts.Identifier).text)}, ${n}.jsAny)`] : [];
				return [`        this.${n} = ${n}.${this.isAny(p.name) ? 'jsAny' : 'optional'}`, ...note];
			});
			const notes = this.keyNotes;
			this.keyNotes = this.initKeyNotes(cls);
			try {
				out.push(...this.levelStart(cls), ...own, ...initsAfterParamProps, ...this.statements(stmts.slice(superAt + 1)));
			} finally {
				this.keyNotes = notes;
			}
			return out;
		});
		const errorName = isError ? Object.keys(ERRORS).find((k) => ERRORS[k] === base) : undefined;
		const superArgs = !superCall ? [] : errorName ? this.errorArgs(errorName, superCall.arguments) : !appBase && k.collection && superCall.arguments.length === 1 && /^JS(Map|Set)</.test(k.collection) ? [this.iterable(superCall.arguments[0])] : kitRoot && !appBase && this.core?.superArgs ? this.core.superArgs(kitRoot, superCall, this.args(superCall)) : this.args(superCall);
		const delegation = superCall ? ` : super(${superArgs.join(', ')})` : base ? ' : super()' : '';
		this.indent = '    ';
		k.lines.push(`    constructor(${signature})${delegation} {`, ...body, '    }');
	},

	literalInitCode(this: Translator, k: ClassParts): void {
		// The constructor a literal's object is made with (`classLiteral`).
		if (k.literalMade) k.lines.push('    constructor(@Suppress("UNUSED_PARAMETER") __literal: Unit)');
	},
};
