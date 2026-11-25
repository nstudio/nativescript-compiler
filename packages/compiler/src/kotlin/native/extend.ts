// `Base.extend({ … })` and `Array.create(type, length)` as Kotlin.
import ts from 'typescript';
import { ACC_ABSTRACT, ACC_FINAL, ACC_INTERFACE, ACC_STATIC, javaTypeName, type JavaClass } from './classfiles.ts';
import { ARRAY_OF, KOTLIN_PRIMITIVE, atom, contains, extensionClasses, functionOf, propertyName, scopeOf, skipCasts, withRealm, type Extension, type Raw } from './bridging.ts';
import type { AndroidNativeAPI } from './api.ts';
import { ident } from '../syntax.ts';
import { rethrowUnlessRefused } from '../../semantics/refusals.ts';
import { refersToThis } from '../../semantics/ast.ts';

export const nativeExtendMethods = {
	/**
	 * `Base.extend({ … })`, `Base.extend('Name', { … })`, `(Base as any).extend(…)`:
	 * NativeScript's Java subclass of Base (of java.lang.Object implementing
	 * `interfaces`), whose methods are the literal's, its value the class.
	 */
	extension(this: AndroidNativeAPI, call: ts.CallExpression): Extension | null {
		if (!this.extensions.has(call)) this.extensions.set(call, this.makeExtension(call));
		return this.extensions.get(call)!;
	},

	makeExtension(this: AndroidNativeAPI, call: ts.CallExpression): Extension | null {
		const callee = call.expression;
		if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'extend') return null;
		const args = call.arguments;
		const literal = args.length === 1 ? args[0] : args.length === 2 && ts.isStringLiteralLike(args[0]) ? args[1] : undefined;
		if (!literal || !ts.isObjectLiteralExpression(literal)) return null;
		const recv = skipCasts(callee.expression);
		if (!ts.isIdentifier(recv) && !ts.isPropertyAccessExpression(recv)) return null;
		const sym = this.classSymbol(recv);
		let base = this.untypedClass(recv) ?? (sym && sym.flags & ts.SymbolFlags.Class && this.isNativeSymbol(sym) ? this.classOf(sym, recv) : null);
		if (!base) {
			const decl = sym?.valueDeclaration;
			if (decl && ts.isVariableDeclaration(decl) && this.extensionOf(decl)) throw this.t.error(call, `extending ${recv.getText()}, a class made by extend`, 'native');
			return null;
		}
		if (this.methods([base.name], 'extend', true).length) return null;
		const interfaces: JavaClass[] = [];
		if (base.access & ACC_INTERFACE) {
			interfaces.push(base);
			base = this.classpath.get('java/lang/Object')!;
		}
		const listed = literal.properties.find((p) => propertyName(p) === 'interfaces');
		if (listed) {
			if (!ts.isPropertyAssignment(listed) || !ts.isArrayLiteralExpression(listed.initializer)) throw this.t.error(listed, 'interfaces other than an array literal of Java interfaces', 'native');
			for (const el of listed.initializer.elements) {
				const i = this.untypedClass(el) ?? this.classOf(this.classSymbol(el), el);
				if (!i || !(i.access & ACC_INTERFACE)) throw this.t.error(el, `${el.getText()} (not a Java interface)`, 'native');
				if (!interfaces.includes(i)) interfaces.push(i);
			}
		}
		// The class is declared where the variable holding it is: `const X = Base.extend(…)`, or `let X` assigned it later.
		let at: ts.Node = call;
		while (ts.isParenthesizedExpression(at.parent) || ts.isAsExpression(at.parent) || ts.isTypeAssertionExpression(at.parent) || ts.isNonNullExpression(at.parent)) at = at.parent;
		const p = at.parent;
		let owner: ts.VariableDeclaration | null = null;
		if (ts.isVariableDeclaration(p) && p.initializer === at && ts.isIdentifier(p.name)) owner = p;
		else if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === at && ts.isIdentifier(p.left) && ts.isExpressionStatement(p.parent)) {
			const d = this.t.resolve(p.left)?.valueDeclaration;
			if (d && ts.isVariableDeclaration(d) && ts.isIdentifier(d.name)) owner = d;
		}
		// Library mode: `extend('com.tns.NativeScriptActivity', { … })` is that Java class, as an app's manifest names it.
		const javaName = this.t.library && args.length === 2 && ts.isStringLiteralLike(args[0]) && args[0].text.includes('.') ? args[0].text : undefined;
		const name = javaName ?? (!owner ? '' : ts.isSourceFile(owner.parent.parent.parent) ? ident(this.t.topName(owner, owner.name.getText())) : ident(owner.name.getText()));
		return { call, literal, base, interfaces, owner, name, javaName };
	},

	/** The extend class a variable holds. */
	extensionOf(this: AndroidNativeAPI, d: ts.VariableDeclaration): Extension | null {
		const sf = d.getSourceFile();
		if (!this.scanned.has(sf) && !sf.isDeclarationFile) {
			this.scanned.add(sf);
			const visit = (n: ts.Node) => {
				if (ts.isCallExpression(n)) {
					let x: Extension | null = null;
					// A class Kotlin cannot make is reported where code uses it, not where a module is scanned.
					try {
						x = this.extension(n);
					} catch (e) {
						rethrowUnlessRefused(e);
						this.extensions.delete(n);
					}
					if (x?.owner) {
						if (this.extensionOwners.has(x.owner)) throw this.t.error(n, `${x.owner.name.getText()} assigned a second class made by extend`, 'native');
						this.extensionOwners.set(x.owner, x);
					}
				}
				ts.forEachChild(n, visit);
			};
			visit(sf);
		}
		return this.extensionOwners.get(d) ?? null;
	},

	extensionNamed(this: AndroidNativeAPI, e: ts.Expression): Extension | null {
		if (!ts.isIdentifier(e)) return null;
		const d = this.t.resolve(e)?.valueDeclaration;
		return d && ts.isVariableDeclaration(d) ? this.extensionOf(d) : null;
	},

	/** The extend class whose instance `this` is: in a method of the literal, or an arrow function inside one. */
	extensionOfThis(this: AndroidNativeAPI, e: ts.Node): Extension | null {
		if (e.kind !== ts.SyntaxKind.ThisKeyword) return null;
		let f: ts.Node | undefined = e.parent;
		while (f && !(ts.isFunctionLike(f) && !ts.isArrowFunction(f)) && !ts.isClassLike(f)) f = f.parent;
		if (!f || !ts.isFunctionLike(f)) return null;
		const member = ts.isMethodDeclaration(f) ? f : ts.isFunctionExpression(f) && ts.isPropertyAssignment(f.parent) ? f.parent : null;
		if (!member || !ts.isObjectLiteralExpression(member.parent) || !ts.isCallExpression(member.parent.parent)) return null;
		const x = this.extension(member.parent.parent);
		return x?.literal === member.parent ? x : null;
	},

	/** `this.name` where the literal declares `name`: a member of the Kotlin class. */
	ownMember(this: AndroidNativeAPI, e: ts.Expression): { x: Extension; p: ts.ObjectLiteralElementLike; fn: ts.FunctionLikeDeclaration | null } | null {
		if (!ts.isPropertyAccessExpression(e)) return null;
		const x = this.extensionOfThis(e.expression);
		const name = e.name.text;
		const p = name === 'interfaces' ? undefined : x?.literal.properties.find((q) => propertyName(q) === name);
		return p ? { x: x!, p, fn: functionOf(p) } : null;
	},

	ownCall(this: AndroidNativeAPI, fn: ts.FunctionLikeDeclaration, name: string, e: ts.CallExpression): string {
		if (fn.parameters.some((p) => p.dotDotDotToken)) throw this.t.error(e, `${name}() (a rest parameter in an extend class)`, 'native');
		// As the method declares its parameters in Kotlin: a lenient one nullable.
		const args = e.arguments.slice(0, fn.parameters.length).map((a, k) => this.t.coerce(a, this.t.library ? this.t.paramType(fn.parameters[k]) : this.t.typeOf(fn.parameters[k].name)));
		return `${this.t.expr((e.expression as ts.PropertyAccessExpression).expression)}.${ident(name)}(${args.join(', ')})`;
	},

	/** `this.super.name(…)`: the superclass's method. */
	superCall(this: AndroidNativeAPI, x: Extension, name: string, e: ts.CallExpression): Raw {
		const what = `this.super.${name}()`;
		const candidates = this.methods([x.base.name], name, false);
		if (!candidates.length) throw this.t.error(e, `${what} (${javaTypeName(`L${x.base.name};`)} has no method of that name)`, 'native');
		const chosen = this.resolveOverload(candidates, [...e.arguments], e, x.base.name, name);
		if (chosen.m.access & ACC_ABSTRACT) throw this.t.error(e, `${what} (abstract in ${javaTypeName(`L${chosen.m.owner};`)})`, 'native');
		// Inside an object expression the method makes, plain `super` would be that object's.
		const zuper = this.t.thisAlias ? `super@${x.name}` : 'super';
		return { code: `${zuper}.${ident(name)}(${this.argList(e, e.arguments, chosen, candidates)})`, desc: chosen.ret, nullable: chosen.m.nullable };
	},

	/** A local of a function between the variable's scope and the extend call, which a class declared with the variable cannot see. */
	capturedLocal(this: AndroidNativeAPI, x: Extension): ts.Identifier | null {
		const ownerScope = scopeOf(x.owner!);
		let found: ts.Identifier | null = null;
		const visit = (n: ts.Node) => {
			if (found) return;
			if (ts.isIdentifier(n)) {
				const d = this.t.resolve(n)?.valueDeclaration;
				const s = d && d.getSourceFile() === x.call.getSourceFile() ? scopeOf(d) : null;
				if (s && s !== ownerScope && !ts.isSourceFile(s) && contains(s, x.call) && contains(ownerScope, s) && !contains(x.literal, d!)) found = n;
			}
			ts.forEachChild(n, visit);
		};
		visit(x.literal);
		return found;
	},

	/**
	 * The Kotlin class an extend call makes, declared where the variable
	 * holding it is: Base's constructors, the literal's other properties as
	 * fields, its methods overriding Base's or the interfaces' with Java's
	 * signatures (else plain members), and `init()` run once constructed.
	 */
	extensionClass(this: AndroidNativeAPI, d: ts.VariableDeclaration): string | null {
		const x = this.extensionOf(d);
		return x ? this.extensionCode(x) : null;
	},

	/** A Java class's name a class takes: its own package's, declared in a file of that package; '' where the class is declared so. */
	declared(this: AndroidNativeAPI, name: string, at: ts.Node, code: (simple: string) => string): string {
		if (!name.includes('.')) return (ts.isClassDeclaration(at) ? '' : this.t.threadAnnotation(at)) + code(name);
		this.t.foreign.push({ name, code: this.t.threadAnnotation(at) + this.t.suppressingDeprecations(() => code(name.slice(name.lastIndexOf('.') + 1)), false) });
		return '';
	},

	extensionCode(this: AndroidNativeAPI, x: Extension): string {
		const t = this.t;
		const d = x.owner;
		const { base, interfaces, literal } = x;
		if (base.access & ACC_FINAL) throw t.error(x.call, `extending the final Java class ${javaTypeName(`L${base.name};`)}`, 'native');
		const captured = d ? this.capturedLocal(x) : null;
		if (captured) throw t.error(captured, `${captured.text} in an extend class assigned to ${d!.name.getText()} (a local the class, declared with ${d!.name.getText()}, cannot see)`, 'native');
		const plain = base.name === 'java/lang/Object';
		const supers = [...(plain ? [] : [this.classRef(base, undefined, 'Any?', x.call)]), ...interfaces.map((i) => this.classRef(i, undefined, 'Any?', x.call))];
		const classes = extensionClasses(x);
		const outer = x.javaName ? '' : t.indent;
		const inner = outer + '    ';
		const fields: string[] = [];
		const ctors: string[] = [];
		const methods: string[] = [];
		const provided = new Set<string>();
		let init = false;
		const savedAlias = t.thisAlias;
		t.thisAlias = null;
		t.indent = inner;
		try {
			if (!plain) {
				const all = this.constructors(base);
				if (!all.length) throw t.error(x.call, `extending ${javaTypeName(`L${base.name};`)} (no accessible Java constructor)`, 'native');
				for (const c of all) {
					const ps = c.params.map((desc, k) => `p${k}: ${this.kotlinType(desc, 'Any?')}${c.m.nullableParams?.[k] ? '?' : ''}`);
					ctors.push(`${inner}constructor(${ps.join(', ')}) : super(${c.params.map((_, k) => `p${k}`).join(', ')})`);
				}
			}
			for (const p of literal.properties) {
				const name = propertyName(p);
				if (name === 'interfaces') continue;
				if (name === undefined || !(ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p))) throw t.error(p, 'a member of an extend class other than a method or a named value', 'native');
				const fn = functionOf(p);
				if (!fn) {
					const type = t.typeOf(p.name);
					const value = ts.isPropertyAssignment(p) ? p.initializer : (p as ts.ShorthandPropertyAssignment).name;
					fields.push(`${inner}@JvmField var ${ident(name)}: ${type} = ${t.coerce(value, type)}`);
					continue;
				}
				if (ts.isArrowFunction(fn) && refersToThis(fn.body)) throw t.error(p, `${name} (an arrow function using this; write it as a method)`, 'native');
				provided.add(name);
				if (name === 'init') {
					if (fn.parameters.length) throw t.error(p, 'init with parameters in an extend class', 'native');
					init = true;
				}
				const targets = name === 'init' ? [] : this.overrideTargets(fn, classes, name);
				methods.push(targets.length ? targets.map((target) => this.overrideMethod(fn, name, target, inner)).join('\n') : inner + t.func(fn as ts.MethodDeclaration, ident(name)));
			}
		} finally {
			t.indent = outer;
			t.thisAlias = savedAlias;
		}
		if (plain) {
			const objectMethods = new Set((this.classpath.get('java/lang/Object')?.methods ?? []).map((m) => m.name + m.descriptor));
			const missing = interfaces.flatMap((i) => this.classpath.supertypes(i.name)).flatMap((c) => c.methods.filter((m) => m.access & ACC_ABSTRACT && !(m.access & ACC_STATIC) && !provided.has(m.name) && !objectMethods.has(m.name + m.descriptor)).map((m) => m.name));
			if (missing.length) throw t.error(literal, `an extend class implementing ${interfaces.map((i) => javaTypeName(`L${i.name};`)).join(', ')} without ${[...new Set(missing)].join(', ')}`, 'native');
		}
		const body = withRealm([...fields, ...ctors, ...(init ? [`${inner}init { init() }`] : []), ...methods], inner);
		return this.declared(x.name, x.call, (simple) => [`${x.javaName ? '' : outer}class ${simple}${supers.length ? ` : ${supers.join(', ')}` : ''} {`, ...body, `${x.javaName ? '' : outer}}`].join('\n'));
	},

	/** `Array.create(java.lang.String, n)`, `Array.create('int', n)`: a Java array of n default elements. */
	arrayCreate(this: AndroidNativeAPI, e: ts.CallExpression): Raw | null {
		const callee = e.expression;
		if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'create' || !ts.isIdentifier(callee.expression) || callee.expression.text !== 'Array' || e.arguments.length !== 2) return null;
		if (!(this.t.resolve(callee) ?? this.t.resolve(callee.name))?.declarations?.some((d) => this.isNativeDeclaration(d))) return null;
		const [type, length] = e.arguments;
		let el: string;
		if (ts.isStringLiteralLike(type) && /^\[+([ZBCSIJFD]|L[\w.$]+;)$/.test(type.text)) {
			// A JVM descriptor (`'[I'`): an array of arrays.
			el = type.text.replace(/\./g, '/');
		} else if (ts.isStringLiteralLike(type)) {
			const prim = Object.keys(ARRAY_OF).find((k) => ARRAY_OF[k] === type.text);
			const cls = prim ? null : this.classpath.get(type.text.replace(/\./g, '/'));
			if (!prim && !cls) throw this.t.error(type, `Array.create of ${type.text} (no class file of that name on the classpath)`, 'native');
			el = prim ?? `L${cls!.name};`;
		} else {
			const cls = this.untypedClass(type) ?? this.classOf(this.classSymbol(type), type);
			if (!cls) throw this.t.error(type, `Array.create of ${type.getText()} (not a Java class)`, 'native');
			el = `L${cls.name};`;
		}
		const n = `${atom(this.t.toNumber(length))}.toInt()`;
		return { code: ARRAY_OF[el] ? `${KOTLIN_PRIMITIVE[el]}Array(${n})` : `arrayOfNulls<${this.kotlinType(el, 'Any?')}>(${n})`, desc: `[${el}` };
	},

	/** A `const` holding an `Array.create(…)`: the Java array's type, for choosing an overload. */
	createdArray(this: AndroidNativeAPI, e: ts.Expression): Raw | null {
		const d = ts.isIdentifier(e) ? this.t.resolve(e)?.valueDeclaration : undefined;
		if (!d || !ts.isVariableDeclaration(d) || !d.initializer || !ts.isCallExpression(d.initializer)) return null;
		// A `var` or `let` holds the array while nothing assigns it again (`objectAnimators[0] = …` sets an element).
		if (!(d.parent.flags & ts.NodeFlags.Const)) {
			const sym = this.t.checker.getSymbolAtLocation(d.name);
			const reassigned = (n: ts.Node): boolean => (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && this.t.checker.getSymbolAtLocation(n.left) === sym) || !!ts.forEachChild(n, reassigned);
			const scope = ts.findAncestor(d, (x) => ts.isFunctionLike(x) || ts.isSourceFile(x));
			if (!sym || !scope || reassigned(scope)) return null;
		}
		return this.arrayCreate(d.initializer);
	},
};
