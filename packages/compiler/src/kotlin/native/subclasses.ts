// Java interfaces implemented from object literals, and `@NativeClass()` classes extending a Java class, as Kotlin.
import ts from 'typescript';
import { ACC_ABSTRACT, ACC_FINAL, ACC_INTERFACE, ACC_STATIC, javaTypeName, signatureTypes, type JavaClass } from './classfiles.ts';
import { ARRAY_OF, CONVERT, KOTLIN_PRIMITIVE, NUMERIC, enteredGuard, hasStatic, isNativeReturn, mainThreadOverride, reportingOverride, splitArgs, withRealm, type Callable } from './bridging.ts';
import type { AndroidNativeAPI } from './api.ts';
import { cast, ident, kotlinString, mentions, optionalType, RT } from '../syntax.ts';
import { refersToThis } from '../../semantics/ast.ts';
import { isNamed, isUntyped, spelledType } from '../../semantics/types.ts';

export const nativeSubclassesMethods = {
	/** The overridable instance methods of these classes named `name`. */
	overridable(this: AndroidNativeAPI, classes: string[], name: string): Callable[] {
		return this.methods(classes, name, false).filter((c) => !(c.m.access & ACC_FINAL));
	},

	/** The Java method a TypeScript method implements: by name, then by its parameter count and types. */
	overrideTarget(this: AndroidNativeAPI, fn: ts.SignatureDeclaration, classes: string[], name: string): Callable | null {
		return this.overrideTargets(fn, classes, name, false)[0] ?? null;
	},

	/**
	 * A TypeScript function as a Kotlin override of a Java method: Java's
	 * parameter types, bound to the TypeScript names as TypeScript types them,
	 * and the result converted back to Java's return type.
	 */
	overrideMethod(this: AndroidNativeAPI, fn: ts.FunctionLikeDeclaration, name: string, target: Callable, indent: string, typeVar: string | ((name: string) => string) = 'Any?'): string {
		return this.t.suppressingDeprecations(() => {
			// The guard calls the method itself again: a deprecated one is a use of it.
			if (target.m.deprecated) this.t.noteDeprecated(`${target.m.owner}#${target.m.name}`);
			const code = this.overrideMethodCode(fn, name, target, indent, typeVar);
			return reportingOverride(this.t.threadAnnotation(fn) === '@UiThread ' ? mainThreadOverride(code) : code, target.ret);
		});
	},

	overrideMethodCode(this: AndroidNativeAPI, fn: ts.FunctionLikeDeclaration, name: string, target: Callable, indent: string, typeVar: string | ((name: string) => string)): string {
		const t = this.t;
		const sig = target.m.signature ? signatureTypes(target.m.signature) : null;
		const types = (sig && sig.params.length === target.params.length ? sig.params : target.params).map((s) => this.kotlinType(s, typeVar));
		const declaredRet = t.returnTypeOf(fn);
		// Library mode: an object result may be null whatever the declaration says (`instantiateItem(…): java.lang.Object` returning null).
		const tsRet = t.library && declaredRet === 'Any' && (target.ret.startsWith('L') || target.ret.startsWith('[')) ? 'Any?' : declaredRet;
		const nullableRet = tsRet.endsWith('?') || isUntyped(spelledType(tsRet));
		// A parameter of a type variable takes the type argument as given (a Kotlin library's `Binder<CalendarDay, …>` is non-null).
		const typeVarParam = (k: number) => !!sig && sig.params.length === target.params.length && /^T[\w$]+;$/.test(sig.params[k]) && !isUntyped(spelledType(types[k]));
		const paramTypes = target.params.map((desc, k) => {
			const p = fn.parameters[k];
			const tsType = p ? t.typeOf(p.name) : 'Any?';
			const ref = desc.startsWith('L') || desc.startsWith('[');
			return `${types[k]}${ref && !types[k].endsWith('?') && !target.m.nonNullParams?.[k] && !typeVarParam(k) && (tsType.endsWith('?') || !p || target.m.nullableParams?.[k]) ? '?' : ''}`;
		});
		// `onReceivedError(...args)`, reading `arguments`: what Java passes, as one list.
		const rest = t.library && fn.parameters.length === 1 && !!fn.parameters[0].dotDotDotToken;
		const packed = rest ? `${RT.jsArrayOf}<Any?>(${target.params.map((d, k) => this.fromJava(`__a${k}`, d)).join(', ')})` : '';
		// Java's parameters take the script's names (`__aN` past them); one script types otherwise is bound, as it types it, under its name.
		const names = target.params.map((_, k) => {
			const p = fn.parameters[k];
			return !rest && p && ts.isIdentifier(p.name) ? ident(p.name.text) : `__a${k}`;
		});
		const binds = rest
			? [t.readsArguments(fn) ? `${indent}    val __arguments: JSArray<Any?> = ${packed}` : `${indent}    val ${ident((fn.parameters[0].name as ts.Identifier).text)}: JSArray<Any?> = ${packed}`]
			: fn.parameters
					.map((p, k) => {
						if (!target.params[k] || !ts.isIdentifier(p.name)) return '';
						const own = names[k];
						if (t.typeOf(p.name) === paramTypes[k] && this.fromJava(own, target.params[k]) === own && !(target.m.nullableParams?.[k] && !paramTypes[k].endsWith('?'))) return '';
						const tsType = t.typeOf(p.name);
						const unwrapped = target.m.nullableParams?.[k] && !tsType.endsWith('?') && !isUntyped(spelledType(tsType)) ? this.t.asserted(own) : own;
						const desc = target.params[k];
						// Script types a parameter more narrowly than Java (`activity: AppCompatActivity` for an Activity, `result: string` for an Object): cast, as script trusts it.
						const narrowed = t.library && desc.startsWith('L') && !isUntyped(spelledType(tsType)) && types[k].replace(/\?$/, '') !== tsType.replace(/\?$/, '');
						// A Java class narrower than Java's (`host: ViewGroup` for any View): held as Java's, its methods cast to as script trusts.
						if (narrowed && desc !== 'Ljava/lang/Object;' && /^[a-z]\w*[._]/.test(tsType)) {
							t.widenedAccessors.set(p, types[k]);
							return types[k] === paramTypes[k] ? '' : `${indent}    val ${own}: ${types[k]} = ${own}`;
						}
						// A CharSequence script reads as a string (an EditText's Editable): its text.
						const text = narrowed && desc === 'Ljava/lang/CharSequence;' && isNamed(spelledType(tsType), 'String', false) ? `${unwrapped}${tsType.endsWith('?') ? '?' : ''}.toString()` : null;
						const value = text ?? (narrowed ? (desc === 'Ljava/lang/Object;' ? t.fromAnyCode(unwrapped, tsType, true) : cast(unwrapped, tsType)) : this.fromJava(unwrapped, desc));
						return `${indent}    val ${ident(p.name.text)}: ${tsType} = ${value}`;
					})
					.filter(Boolean);
		const head = `${this.deprecatedOverride(target.m, indent)}${indent}override fun ${ident(name)}(${paramTypes.map((pt, k) => `${names[k]}: ${pt}`).join(', ')})`;
		const guard = enteredGuard(name, names, target, indent);
		// A binding the body never reads is left out.
		const read = (body: string) => binds.filter((b) => mentions(body, /^\s*val (\S+):/.exec(b)![1]));
		if (target.ret === 'V') {
			const body = t.functionBody(fn, 'Unit', indent);
			binds.splice(0, binds.length, ...read(body));
			// A parameter the body assigns is a variable of its own there, in a scope apart from its binding.
			if (binds.length && t.paramPrelude(fn).length) return `${head} {\n${guard}\n${binds.join('\n')}\n${indent}    kotlin.run ${body.replace(/\n/g, '\n    ')}\n${indent}}`;
			return `${head} {\n${[guard, ...binds].join('\n')}\n${body.slice(2)}`;
		}
		const retType = sig ? this.kotlinType(sig.ret, typeVar) : this.kotlinType(target.ret, typeVar);
		const ref = target.ret.startsWith('L') || target.ret.startsWith('[');
		const result = NUMERIC.has(target.ret) ? `${tsRet === 'Double' ? '__result' : `${RT.jsToNumber}(__result)`}${CONVERT[target.ret]}` : target.ret === 'C' ? '__result[0]' : target.ret.startsWith('[') ? this.arrayValue('__result', target.ret) : isUntyped(spelledType(tsRet)) && ref && retType !== 'Any' ? t.checkedCast('__result', `${retType}${target.m.nonNull ? '' : '?'}`) : ref && nullableRet && target.m.nonNull ? `${RT.jsJavaResult}(__result, ${kotlinString(target.m.name)})` : '__result';
		const declared = `${retType}${ref && nullableRet && !target.m.nonNull ? '?' : ''}`;
		// A result Java takes as script gives it: the body is the override's own.
		if (result === '__result' && declared === tsRet && !(binds.length && t.paramPrelude(fn).length)) {
			const body = t.functionBody(fn, tsRet, indent);
			binds.splice(0, binds.length, ...read(body));
			return `${head}: ${declared} {\n${[guard, ...binds].join('\n')}\n${body.slice(2)}`;
		}
		const body = t.functionBody(fn, tsRet, indent + '    ');
		binds.splice(0, binds.length, ...read(body));
		return [`${head}: ${declared} {`, guard, ...binds, `${indent}    val __result: ${tsRet} = (fun(): ${tsRet} ${body})()`, `${indent}    return ${result}`, `${indent}}`].join('\n');
	},

	/** An override that calls a function value with the Java arguments as its declaration types them. */
	overrideWithValue(this: AndroidNativeAPI, value: ts.Expression, decl: ts.SignatureDeclaration, name: string, target: Callable, indent: string, typeVar: string | ((name: string) => string) = 'Any?'): string {
		return this.t.suppressingDeprecations(() => {
			// The guard calls the method itself again: a deprecated one is a use of it.
			if (target.m.deprecated) this.t.noteDeprecated(`${target.m.owner}#${target.m.name}`);
			const code = this.overrideWithValueCode(value, decl, name, target, indent, typeVar);
			return reportingOverride(this.t.threadAnnotation(value) === '@UiThread ' ? mainThreadOverride(code) : code, target.ret);
		});
	},

	overrideWithValueCode(this: AndroidNativeAPI, value: ts.Expression, decl: ts.SignatureDeclaration, name: string, target: Callable, indent: string, typeVar: string | ((name: string) => string)): string {
		const t = this.t;
		const sig = target.m.signature ? signatureTypes(target.m.signature) : null;
		const types = (sig && sig.params.length === target.params.length ? sig.params : target.params).map((s) => this.kotlinType(s, typeVar));
		const params = target.params.map((desc, k) => `__a${k}: ${desc.startsWith('L') || desc.startsWith('[') ? optionalType(types[k]) : types[k]}`);
		const args = decl.parameters.map((p, k) => {
			if (!target.params[k]) return 'null';
			const tsType = t.typeOf(p.name);
			const read = this.fromJava(`__a${k}`, target.params[k]);
			return isUntyped(spelledType(tsType)) ? read : target.params[k].startsWith('L') && !tsType.endsWith('?') ? this.t.asserted(read) : read;
		});
		const call = `(${t.expr(value)})(${args.join(', ')})`;
		const head = `${this.deprecatedOverride(target.m, indent)}${indent}override fun ${ident(name)}(${params.join(', ')})`;
		const guard = enteredGuard(
			name,
			target.params.map((_, k) => `__a${k}`),
			target,
			indent,
		);
		if (target.ret === 'V')
			return `${head} {
${guard}
${indent}    ${call}
${indent}}`;
		const retType = sig ? this.kotlinType(sig.ret, typeVar) : this.kotlinType(target.ret, typeVar);
		const tsRet = t.returnTypeOf(decl);
		const result = NUMERIC.has(target.ret) ? `${tsRet === 'Double' ? '__result' : `${RT.jsToNumber}(__result)`}${CONVERT[target.ret]}` : target.ret === 'C' ? '__result[0]' : '__result';
		const ref = target.ret.startsWith('L') || target.ret.startsWith('[');
		return `${head}: ${retType}${ref ? '?' : ''} {
${guard}
${indent}    val __result = ${call}
${indent}    return ${result}
${indent}}`;
	},

	arrayValue(this: AndroidNativeAPI, code: string, desc: string): string {
		const el = desc.slice(1);
		if (!ARRAY_OF[el]) return `${code}.elements.toTypedArray()`;
		if (el === 'D' || el === 'Z') return `${code}.elements.to${KOTLIN_PRIMITIVE[el]}Array()`;
		return `${code}.elements.map { it${CONVERT[el] ?? ''} }.to${KOTLIN_PRIMITIVE[el]}Array()`;
	},

	/** `new android.view.View.OnClickListener({ onClick(v) { … } })`: a Kotlin object expression. */
	implementation(this: AndroidNativeAPI, cls: JavaClass, literal: ts.ObjectLiteralExpression, e: ts.NewExpression): string {
		// Arrow functions and function values in the literal see the enclosing `this`, not the object Kotlin makes.
		const lexicalThis = literal.properties.some((p) => ts.isPropertyAssignment(p) && !ts.isFunctionExpression(p.initializer) && refersToThis(p.initializer));
		if (lexicalThis && !this.t.thisAlias) {
			const self = this.t.fresh('__self');
			this.t.thisAlias = self;
			try {
				return `run { val ${self} = this; ${this.implementation(cls, literal, e)} }`;
			} finally {
				this.t.thisAlias = null;
			}
		}
		const t = this.t;
		// The variable the object initializes, read in its own methods (`v.removeOnLayoutChangeListener(layoutListener)`): the object.
		const own = ts.isVariableDeclaration(e.parent) && e.parent.initializer === e && ts.isIdentifier(e.parent.name) ? t.checker.getSymbolAtLocation(e.parent.name) : undefined;
		const selfRefs: ts.Node[] = [];
		if (own) {
			const visit = (n: ts.Node): void => {
				if (ts.isIdentifier(n) && t.checker.getSymbolAtLocation(n) === own && ts.findAncestor(n, (a) => (ts.isFunctionLike(a) && a.parent === literal) || (ts.isPropertyAssignment(a) && a.parent === literal))) selfRefs.push(n);
				ts.forEachChild(n, visit);
			};
			visit(literal);
		}
		for (const n of selfRefs) t.subst.set(n, 'this');
		try {
			return this.implementationBody(cls, literal, e);
		} finally {
			for (const n of selfRefs) t.subst.delete(n);
		}
	},

	implementationBody(this: AndroidNativeAPI, cls: JavaClass, literal: ts.ObjectLiteralExpression, e: ts.NewExpression): string {
		const t = this.t;
		const base = t.indent;
		const isInterface = !!(cls.access & ACC_INTERFACE);
		const typeArgs = (t.checker.getTypeAtLocation(e) as ts.TypeReference).typeArguments;
		let supertype = this.classRef(cls, typeArgs, 'Any?', e);
		// The interface's type variables in its methods are the arguments the implementation gives them.
		const argsGiven = /<(.*)>$/.exec(supertype)?.[1];
		const typeNames = this.typeParamNames(cls);
		const chosen = argsGiven ? splitArgs(argsGiven) : [];
		const typeVar = (n: string) => chosen[typeNames.indexOf(n)] ?? 'Any?';
		// A method an interface inherits takes its own interface's type variables, as the implemented one's arguments give them.
		const ownerVar = (owner: string) => (owner === cls.name ? typeVar : this.supertypeVars(cls, chosen, owner));
		if (!isInterface) {
			if (!this.constructors(cls).some((c) => !c.params.length)) throw t.error(e, `new ${javaTypeName(`L${cls.name};`)} with an implementation (its constructors all take arguments)`, 'native');
			supertype += '()';
		}
		const members: string[] = [];
		const provided = new Set<string>();
		for (const p of literal.properties) {
			const name = p.name?.getText().replace(/^['"]|['"]$/g, '') ?? '';
			const fn = ts.isMethodDeclaration(p) ? p : ts.isPropertyAssignment(p) && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer)) ? p.initializer : null;
			// A function value (`this.onTouch.bind(this)`): the override calls it.
			const value = !fn && ts.isPropertyAssignment(p) ? t.checker.getTypeAtLocation(p.initializer).getCallSignatures()[0] : undefined;
			const declared = value?.getDeclaration();
			if (!fn && !(declared && !ts.isJSDocSignature(declared))) throw t.error(p, `${name} in an implementation of ${javaTypeName(`L${cls.name};`)} (only methods and functions)`, 'native');
			const target = this.overrideTarget(fn ?? (declared as ts.SignatureDeclaration), [cls.name], name);
			if (!target) throw t.error(p, `${name} (${javaTypeName(`L${cls.name};`)} has no method of that name to implement)`, 'native');
			provided.add(name);
			members.push(fn ? this.overrideMethod(fn, name, target, base + '    ', ownerVar(target.m.owner)) : this.overrideWithValue((p as ts.PropertyAssignment).initializer, declared as ts.SignatureDeclaration, name, target, base + '    ', ownerVar(target.m.owner)));
		}
		if (isInterface) {
			const objectMethods = new Set((this.classpath.get('java/lang/Object')?.methods ?? []).map((m) => m.name + m.descriptor));
			const missing = this.classpath.supertypes(cls.name).flatMap((c) => c.methods.filter((m) => m.access & ACC_ABSTRACT && !(m.access & ACC_STATIC) && !provided.has(m.name) && !objectMethods.has(m.name + m.descriptor)).map((m) => m.name));
			if (missing.length) throw t.error(literal, `an implementation of ${javaTypeName(`L${cls.name};`)} without ${[...new Set(missing)].join(', ')}`, 'native');
		}
		return `object : ${supertype} {\n${withRealm(members, base + '    ').join('\n')}\n${base}}`;
	},

	/**
	 * A TypeScript class extending a Java class (`@NativeClass() class
	 * Sparkline extends android.view.View`): a Kotlin subclass whose methods
	 * that override the base class or implement a listed interface take Java's
	 * signatures, whose constructor calls the Java constructor its `super(…)`
	 * arguments pick, and whose own members translate as any class's do.
	 * Without a constructor, it has each of the base class's.
	 */
	classDecl(this: AndroidNativeAPI, cls: ts.ClassDeclaration): string | null {
		const t = this.t;
		const native = this.nativeHeritage(cls);
		if (!native) {
			const heritage = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
			const baseDecl = heritage && t.resolve(heritage.expression)?.valueDeclaration;
			if (baseDecl && ts.isClassDeclaration(baseDecl) && !baseDecl.getSourceFile().isDeclarationFile && this.nativeHeritage(baseDecl)) throw t.error(heritage, `extending ${heritage.getText()}, an app class that extends a Java class`, 'native');
			return null;
		}
		let { base, interfaces, listed } = native;
		// Library mode: `class Impl extends android.app.Application.ActivityLifecycleCallbacks`, as NativeScript's runtime takes it: implementing the interface.
		if (base.access & ACC_INTERFACE && t.library) {
			interfaces = [base, ...interfaces.filter((i) => i !== base)];
			base = this.classpath.get('java/lang/Object')!;
		}
		if (base.access & ACC_INTERFACE) throw t.error(cls, `extending the Java interface ${javaTypeName(`L${base.name};`)} (implement it: \`static interfaces = [...]\` or \`new ${javaTypeName(`L${base.name};`)}({ … })\`)`, 'native');
		if (base.access & ACC_FINAL) throw t.error(cls, `extending the final Java class ${javaTypeName(`L${base.name};`)}`, 'native');
		const name = t.topName(cls, cls.name!.text);
		const heritage = cls.heritageClauses!.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)!.types[0];
		const baseType = this.classRef(
			base,
			heritage.typeArguments?.map((a) => t.checker.getTypeFromTypeNode(a)),
			'Any?',
			heritage,
		);
		// The base's type variables in its methods are the arguments the subclass gives them (`LruCache<string, Bitmap>`).
		const baseArgs = /<(.*)>$/.exec(baseType)?.[1];
		const baseChosen = baseArgs ? splitArgs(baseArgs) : [];
		const baseNames = this.typeParamNames(base);
		const baseTypeVar = (n: string) => baseChosen[baseNames.indexOf(n)] ?? 'Any?';
		const plain = base.name === 'java/lang/Object';
		const supers = [...(plain ? [] : [baseType]), ...interfaces.map((i) => this.classRef(i, undefined, 'Any?', cls))];
		const classes = [base.name, ...interfaces.map((i) => i.name)];
		const lines: string[] = [];
		const statics: string[] = [];
		t.indent = '    ';
		try {
			for (const m of cls.members) {
				if (!ts.isPropertyDeclaration(m) || m === listed) continue;
				const n = m.name.getText();
				const type = t.typeOf(m.name);
				if (hasStatic(m)) {
					t.indent = '        ';
					statics.push(`        var ${ident(n)}: ${type} = ${m.initializer ? t.coerce(m.initializer, type) : (t.zero(type) ?? 'null')}`);
					t.indent = '    ';
					continue;
				}
				// A field, not a property: its accessors would be JVM methods that could clash with the Java class's (`getTag()`).
				const nullish = t.nullishStorage(m);
				if (nullish) lines.push(`    @JvmField var ${ident(n)}: ${nullish.type} = ${nullish.init}`);
				else if (m.initializer) lines.push(`    @JvmField var ${ident(n)}: ${type} = ${t.coerce(m.initializer, type)}`);
				else {
					const d = t.deferredDeclaration(ident(n), type);
					lines.push(`    ${d.startsWith('lateinit') ? '' : '@JvmField '}${d}`);
				}
			}
			const ctor = cls.members.find((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m) && !!m.body);
			const ctors = this.constructors(base);
			// `constructor(public owner: ListView)`: a field the constructor sets.
			const paramProps = (ctor?.parameters ?? []).filter((p) => ts.isIdentifier(p.name) && ts.getModifiers(p)?.some((x) => [ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.ReadonlyKeyword].includes(x.kind)));
			for (const p of paramProps) {
				const d = t.deferredDeclaration(ident((p.name as ts.Identifier).text), t.typeOf(p.name));
				lines.push(`    ${d.startsWith('lateinit') ? '' : '@JvmField '}${d}`);
			}
			if (ctor) {
				const stmts = [...ctor.body!.statements];
				const superAt = stmts.findIndex((s) => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && s.expression.expression.kind === ts.SyntaxKind.SuperKeyword);
				if (superAt !== 0) throw t.error(ctor, `a constructor of a class extending ${javaTypeName(`L${base.name};`)} that does not start with super(…)`, 'native');
				const superCall = (stmts[0] as ts.ExpressionStatement).expression as ts.CallExpression;
				const chosen = this.resolveOverload(ctors, [...superCall.arguments], superCall, base.name, '<init>');
				const rest = stmts.slice(1).filter((s) => !isNativeReturn(s));
				const params = ctor.parameters.map((p, k) => {
					const pn = ts.isIdentifier(p.name) ? ident(p.name.text) : `__p${k}`;
					const pt = t.typeOf(p.name);
					return `${pn}: ${p.questionToken || p.initializer ? (pt.endsWith('?') ? pt : pt + '?') : pt}`;
				});
				t.indent = '        ';
				const body = [...t.paramPrelude(ctor), ...paramProps.map((p) => `        this.${ident((p.name as ts.Identifier).text)} = ${ident((p.name as ts.Identifier).text)}`), ...t.statements(rest)];
				t.indent = '    ';
				const head = `    constructor(${params.join(', ')}) : super(${this.argList(superCall, superCall.arguments, chosen, ctors)})`;
				lines.push(body.length ? `${head} {\n${body.join('\n')}\n    }` : head);
			} else if (!plain) {
				for (const c of ctors) {
					const ps = c.params.map((d, k) => `p${k}: ${this.kotlinType(d, 'Any?')}${c.m.nullableParams?.[k] ? '?' : ''}`);
					lines.push(`    constructor(${ps.join(', ')}) : super(${c.params.map((_, k) => `p${k}`).join(', ')})`);
				}
			}
			const accessors = new Map<string, { get?: ts.GetAccessorDeclaration; set?: ts.SetAccessorDeclaration }>();
			for (const m of cls.members) {
				if (!ts.isGetAccessorDeclaration(m) && !ts.isSetAccessorDeclaration(m)) continue;
				if (hasStatic(m) || !ts.isIdentifier(m.name)) throw t.error(m, `a static or computed accessor in a class extending ${javaTypeName(`L${base.name};`)}`, 'native');
				const a = accessors.get(m.name.text) ?? {};
				if (ts.isGetAccessorDeclaration(m)) a.get = m;
				else a.set = m;
				accessors.set(m.name.text, a);
			}
			for (const [n, a] of accessors) {
				// A Kotlin property whose JVM accessors (`getView()`) the Java class has would override them, which NativeScript's would not.
				const jvm = `${n[0].toUpperCase()}${n.slice(1)}`;
				if (this.methods(classes, `get${jvm}`, false).length || this.methods(classes, `set${jvm}`, false).length) throw t.error((a.get ?? a.set)!, `an accessor named like a method of ${javaTypeName(`L${base.name};`)}`, 'native');
				const type = a.get ? t.returnTypeOf(a.get) : optionalType(t.typeOf(a.set!.parameters[0].name));
				lines.push(`    ${a.set ? 'var' : 'val'} ${ident(n)}: ${type}`);
				lines.push(a.get ? `        get() ${t.functionBody(a.get, type, '        ')}` : '        get() = null');
				if (a.set) lines.push(`        set(${ident((a.set.parameters[0].name as ts.Identifier).text)}) ${t.functionBody(a.set, 'Unit', '        ')}`);
			}
			for (const m of cls.members) {
				if (!ts.isMethodDeclaration(m) || !m.body) continue;
				const n = m.name.getText();
				// A method named like a final Java method is script's alone, as NativeScript's runtime cannot override it: one script never calls is left out.
				if (!hasStatic(m) && !this.overridable(classes, n).length && this.methods(classes, n, false).length && !this.calledByName(n)) continue;
				if (hasStatic(m)) {
					t.indent = '        ';
					statics.push('        ' + t.func(m, ident(n)));
					t.indent = '    ';
					continue;
				}
				const targets = this.overrideTargets(m, classes, n);
				lines.push(targets.length ? targets.map((target) => this.overrideMethod(m, n, target, '    ', target.m.owner === base.name ? baseTypeVar : baseChosen.length ? this.supertypeVars(base, baseChosen, target.m.owner) : 'Any?')).join('\n') : '    ' + t.func(m, ident(n)));
			}
		} finally {
			t.indent = '';
		}
		if (statics.length) lines.push('    companion object {', ...statics, '    }');
		return this.declared(name, cls, (simple) => [`class ${ident(simple)}${supers.length ? ` : ${supers.join(', ')}` : ''} {`, ...withRealm(lines, '    '), '}'].join('\n'));
	},
};
