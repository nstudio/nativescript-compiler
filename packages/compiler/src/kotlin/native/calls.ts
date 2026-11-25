// Reads, writes and calls of Java classes and their members, as Kotlin.
import ts from 'typescript';
import { ACC_ABSTRACT, ACC_FINAL, ACC_INTERFACE, ACC_PROTECTED, javaTypeName, type JavaClass } from './classfiles.ts';
import type { AndroidNativeAPI } from './api.ts';
import { BOXED_NUMBERS, CONVERT, KOTLIN_MAPPED, NUMERIC, skipCasts, type Callable, type Raw } from './bridging.ts';
import { functionTypeParts, ident, kotlinString, RT } from '../syntax.ts';
import { Refusal } from '../../semantics/refusals.ts';
import { appMember } from '../../semantics/ast.ts';
import { isNamed, isUntyped, spelledType } from '../../semantics/types.ts';

export const nativeCallsMethods = {
	property(this: AndroidNativeAPI, e: ts.PropertyAccessExpression): string | null {
		const own = this.ownMember(e);
		if (own) return `${this.t.expr(e.expression)}${own.fn ? '::' : '.'}${ident(e.name.text)}`;
		if (e.name.text === 'super' && this.extensionOfThis(e.expression)) throw this.t.error(e, 'this.super other than to call a superclass method (`this.super.onDraw(canvas)`)', 'native');
		if (appMember(e.name, this.t.checker)) return null;
		const held = ts.isIdentifier(e.expression) ? this.t.resolve(e.expression)?.valueDeclaration : undefined;
		const proto = this.t.library && held && ts.isVariableDeclaration(held) ? this.prototypeOf(held) : null;
		if (proto) return this.superMethodValue(e, proto);
		const raw = this.read(e);
		if (raw?.script) return raw.code;
		if (!raw) return null;
		const code = this.unwrap(raw, e);
		return this.fromJava(code, raw.desc, raw.optional || (raw.recentlyNullable && raw.desc.startsWith('[') && !this.t.isAsserted(code)));
	},

	/** `layout?.getImeInsets`, probing for a method through an optional chain: undefined where the chain stops, else the method found at run time. */
	methodValue(this: AndroidNativeAPI, e: ts.PropertyAccessExpression, target?: string): string | null {
		if (!e.questionDotToken || (ts.isCallExpression(e.parent) && e.parent.expression === e) || this.ownMember(e) || appMember(e.name, this.t.checker)) return null;
		const r = this.receiver(e.expression);
		if (!r || r.isStatic === true || this.field(r.classes, e.name.text, false) || !this.methods(r.classes, e.name.text, false).length) return null;
		return `(${target ?? this.t.expr(e.expression)})?.let { ${RT.jsJavaGet}(it, ${JSON.stringify(e.name.text)}) }`;
	},

	/** Library mode: a static Java method used as a function value of the type the code gives it (`setPixels: ViewHelper.setMarginTop`). */
	staticMethodValue(this: AndroidNativeAPI, e: ts.PropertyAccessExpression, cls: string): Raw | null {
		const parts = functionTypeParts(this.t.typeOf(e).replace(/^\((.*)\)\?$/, '$1'));
		const m = parts && this.methods([cls], e.name.text, true).find((c) => c.params.length === parts.params.length);
		if (!parts || !m) return null;
		const args = m.params.map((desc, k) => {
			const p = parts.params[k];
			if (NUMERIC.has(desc)) return `${p === 'Double' ? `__a${k}` : this.t.asserted(`__a${k}`)}${CONVERT[desc]}`;
			return p.endsWith('?') && !m.m.nullableParams?.[k] ? this.t.asserted(`__a${k}`) : `__a${k}`;
		});
		const call = `${this.kotlinValueName(m.m.owner, e)}.${ident(e.name.text)}(${args.join(', ')})`;
		return { code: `{ ${parts.params.map((p, k) => `__a${k}: ${p}`).join(', ')} -> ${parts.ret === 'Unit' ? `${call}; Unit` : this.fromJava(call, m.ret)} }`, desc: '', script: true };
	},

	/** `X.FIELD`, `obj.field`, `X.class`: the Kotlin code and the Java type it has. */
	read(this: AndroidNativeAPI, e: ts.PropertyAccessExpression): Raw | null {
		const r = this.receiver(e.expression);
		if (!r) return null;
		const name = e.name.text;
		if (r.isStatic === true) {
			if (name === 'class') return { code: `${this.kotlinValueName(r.cls.name, e)}::class.java`, desc: 'Ljava/lang/Class;' };
			const f = this.field([r.cls.name], name, true);
			if (!f) {
				const fn = this.staticMethodValue(e, r.cls.name);
				if (fn) return fn;
				if (this.classOf(this.t.resolve(e))) throw this.t.error(e, `${javaTypeName(`L${r.cls.name};`)}.${name} (a Java class used as a value)`, 'native');
				throw this.t.error(e, `${javaTypeName(`L${r.cls.name};`)}.${name} (no static Java field of that name)`, 'native');
			}
			return { code: `${this.kotlinValueName(f.owner, e)}.${ident(name)}`, desc: f.descriptor, nullable: f.nullable };
		}
		const f = this.field(r.classes, name, false);
		if (!f) {
			// A method read as a value (`if (layout.addRowsFromJSON)`, probing for it): the method found at run time, as the runtime finds it.
			if (this.methods(r.classes, name, false).length) return { code: `${RT.jsJavaGet}(${this.t.asserted(this.t.expr(e.expression))}, ${JSON.stringify(name)})`, desc: 'Ljava/lang/Object;' };
			// A property script sets on an extend class's instance: kept beside the object, as NativeScript keeps it on the JavaScript side.
			if (this.extensionOfThis(e.expression)) return null;
			throw this.t.error(e, `${javaTypeName(`L${r.classes[0]};`)}.${name} (no Java field of that name)`, 'native');
		}
		const target = this.target(e.expression, e);
		return { code: `${target}.${ident(name)}`, desc: f.descriptor, optional: target.endsWith('?'), nullable: f.nullable, recentlyNullable: f.recentlyNullable };
	},

	/** A `@Nullable` result where TypeScript's type says it is there. */
	unwrap(this: AndroidNativeAPI, raw: Raw, e: ts.Expression): string {
		const tsType = this.t.typeOf(e);
		if (tsType.endsWith('?') || isUntyped(spelledType(tsType))) return raw.code;
		if (!this.t.lenient && !raw.optional && this.t.states.nilKept(e)) return raw.code;
		// An optional chain (`?.`) TypeScript types as present: the value, as the code reads it.
		if (raw.optional && !ts.isPropertyAccessExpression(e.parent) && !ts.isCallExpression(e.parent) && !ts.isElementAccessExpression(e.parent)) return this.t.asserted(raw.code);
		// Tested or passed on as it is (`intent.getAction() && …`): null is the test's to see.
		if (raw.nullable && this.t.library && raw.desc.startsWith('L') && raw.desc !== 'Ljava/lang/CharSequence;' && this.t.nullTolerant(e)) return raw.code;
		// `@RecentlyNullable` (android.jar): null passes on as Kotlin's platform types let it, except into a member read or an array's elements.
		if (raw.recentlyNullable && !raw.optional && ((ts.isPropertyAccessExpression(e.parent) && e.parent.expression === e) || raw.desc.startsWith('['))) return this.t.asserted(raw.code);
		return raw.nullable && !raw.optional ? this.t.asserted(raw.code) : raw.code;
	},

	/** The receiver's code, unwrapped when TypeScript has narrowed a nullable one, with the dot that follows it. */
	target(this: AndroidNativeAPI, e: ts.Expression, access: ts.PropertyAccessExpression): string {
		if (this.extensionOfThis(e)) return this.t.expr(e);
		const code = this.t.expr(e);
		const own = this.ownMember(e);
		const nullable = (own ? this.t.typeOf(own.p.name!) : this.t.typeOf(e)).endsWith('?');
		if (access.questionDotToken || (access.flags & ts.NodeFlags.OptionalChain && nullable)) return `${code}?`;
		const write = ts.isBinaryExpression(access.parent) && access.parent.left === access && access.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && access.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
		return nullable || this.t.isAsserted(code) ? this.t.present(code, access.name.text, e, write) : code;
	},

	assign(this: AndroidNativeAPI, left: ts.PropertyAccessExpression, value: ts.Expression): string | null {
		const own = this.ownMember(left);
		if (own) {
			if (own.fn) throw this.t.error(left, `${left.name.text} (a method of the extend class, assigned)`, 'native');
			return `${this.t.expr(left.expression)}.${ident(left.name.text)} = ${this.t.coerce(value, this.t.typeOf(own.p.name!))}`;
		}
		if (appMember(left.name, this.t.checker)) return null;
		const r = this.receiver(left.expression);
		if (!r) return null;
		const name = left.name.text;
		const f = this.field(r.isStatic === true ? [r.cls.name] : r.classes, name, r.isStatic);
		if (!f && this.extensionOfThis(left.expression)) return null;
		// Library mode: a property script sets that Java has only a setter for (`params.diskCacheSize = …`): the setter, as NativeScript's runtime calls it.
		const setter = !f && this.t.library ? this.methods(r.isStatic === true ? [r.cls.name] : r.classes, `set${name[0].toUpperCase()}${name.slice(1)}`, r.isStatic).find((c) => c.params.length === 1) : undefined;
		if (setter) return `${r.isStatic ? this.kotlinValueName(setter.m.owner, left) : this.target(left.expression, left)}.${ident(setter.m.name)}(${this.toJava(value, setter.params[0], !!setter.m.nullableParams?.[0], !!setter.m.nonNullParams?.[0])})`;
		// Library mode: one Java has neither (a widgets version without it): kept beside the object, as NativeScript's runtime keeps it.
		if (!f && this.t.library && !r.isStatic) return `${RT.jsSet}(${this.t.coerce(left.expression, 'Any?')}, ${kotlinString(name)}, ${this.t.coerce(value, 'Any?')})`;
		if (!f) throw this.t.error(left, `${name} (no Java field of that name; call its setter)`, 'native');
		if (f.access & ACC_FINAL) throw this.t.error(left, `${name} (a final Java field)`, 'native');
		const target = r.isStatic ? this.kotlinValueName(f.owner, left) : this.target(left.expression, left);
		return `${target}.${ident(name)} = ${this.toJava(value, f.descriptor)}`;
	},

	call(this: AndroidNativeAPI, e: ts.CallExpression): string | null {
		// Library mode: `Base.extend('com.tns.NativeScriptActivity', { … })` as a statement declares that class.
		const named = this.t.library && ts.isExpressionStatement(e.parent) ? this.extension(e) : null;
		if (named?.javaName && !named.owner) {
			this.extensionCode(named);
			return 'Unit';
		}
		const made = this.arrayCreate(e);
		if (made) {
			// Held as the Java array itself (Java methods fill it in place), unless the code declares a JavaScript array.
			const ctx = this.t.checker.getContextualType(e);
			return ctx && (this.isJavaArray(ctx) || this.t.checker.isArrayType(ctx)) ? this.fromJava(made.code, made.desc) : made.code;
		}
		const raw = this.invoke(e);
		if (raw?.script) return this.t.fromAnyCode(raw.code, this.t.typeOf(e), true);
		// Library mode: a Java object where core's code reads a string (`input.getText()`, an Editable): its text.
		if (raw && this.t.library && this.t.typeOf(e) === 'String' && raw.desc.startsWith('L') && raw.desc !== 'Ljava/lang/String;') return `${RT.jsToString}(${this.unwrap(raw, e)})`;
		if (!raw) return null;
		const code = this.unwrap(raw, e);
		return this.fromJava(code, raw.desc, raw.optional || (raw.recentlyNullable && raw.desc.startsWith('[') && !this.t.isAsserted(code)));
	},

	invoke(this: AndroidNativeAPI, e: ts.CallExpression): Raw | null {
		const callee = e.expression;
		if (ts.isIdentifier(callee)) {
			// NativeScript's `float(n)`, `long(n)`: the number itself, outside a Java argument.
			const sym = this.t.resolve(callee);
			if ((callee.text === 'float' || callee.text === 'long') && this.isNativeSymbol(sym)) return { code: this.t.toNumber(e.arguments[0]), desc: 'D' };
			return null;
		}
		if (!ts.isPropertyAccessExpression(callee)) return null;
		if (this.extension(e)) throw this.t.error(e, `${skipCasts(callee.expression).getText()}.extend(…) other than as a variable's value (\`const Name = ….extend({ … })\`)`, 'native');
		const own = this.ownMember(callee);
		if (own) return own.fn ? { code: this.ownCall(own.fn, callee.name.text, e), desc: 'Ljava/lang/Object;' } : null;
		const zuper = ts.isPropertyAccessExpression(callee.expression) && callee.expression.name.text === 'super' ? this.extensionOfThis(callee.expression.expression) : null;
		if (zuper) return this.superCall(zuper, callee.name.text, e);
		// A method of the program's overriding a Java method (`this.getCount()` of an adapter): Kotlin's override has Java's signature.
		const appMethod = this.t.checker.getSymbolAtLocation(callee.name)?.valueDeclaration;
		const appClass = appMethod && ts.isMethodDeclaration(appMethod) && appMethod.body && ts.isClassDeclaration(appMethod.parent) ? appMethod.parent : undefined;
		const heritage = appClass ? this.nativeHeritage(appClass) : null;
		if (heritage && appMethod && ts.isMethodDeclaration(appMethod)) {
			const target = this.overrideTargets(appMethod, [heritage.base.name, ...heritage.interfaces.map((i) => i.name)], callee.name.text)[0];
			if (target && target.params.length === e.arguments.length) return { code: `${this.t.expr(callee.expression)}.${ident(callee.name.text)}(${this.argList(e, e.arguments, target, [target])})`, desc: target.ret, nullable: target.m.nullable };
		}
		// Library mode: `super.m(…)` where the Java base is reached through an alias script types loosely (`View['AccessibilityDelegate']`).
		const zuperClass = this.t.library && callee.expression.kind === ts.SyntaxKind.SuperKeyword ? ts.findAncestor(callee, ts.isClassDeclaration) : undefined;
		const zuperBase = zuperClass ? this.nativeHeritage(zuperClass)?.base : undefined;
		if (zuperBase) {
			const candidates = this.methods([zuperBase.name], callee.name.text, false);
			const chosen = candidates.length ? this.overloadOrNull(candidates, [...e.arguments], e, zuperBase.name, callee.name.text) : null;
			if (chosen) return { code: `super.${ident(callee.name.text)}(${this.argList(e, e.arguments, chosen, candidates)})`, desc: chosen.ret, nullable: chosen.m.nullable };
		}
		// Library mode: `superProto.toString()` in a method of a Java subclass, the superclass's method.
		const held = this.t.library && ts.isIdentifier(callee.expression) ? this.t.resolve(callee.expression)?.valueDeclaration : undefined;
		const proto = held && ts.isVariableDeclaration(held) ? this.prototypeOf(held) : null;
		if (proto) {
			const candidates = this.methods([proto.name], callee.name.text, false);
			const chosen = this.resolveOverload(candidates, [...e.arguments], e, proto.name, callee.name.text);
			return { code: `super.${ident(callee.name.text)}(${this.argList(e, e.arguments, chosen, candidates)})`, desc: chosen.ret, nullable: chosen.m.nullable };
		}
		if (appMember(callee.name, this.t.checker)) return null;
		const r = this.receiver(callee.expression);
		if (!r) return null;
		const name = callee.name.text;
		const classes = r.isStatic === true ? [r.cls.name] : r.classes;
		const owner = classes[0];
		const candidates = this.methods(classes, name, r.isStatic);
		if (!candidates.length && this.extensionOfThis(callee.expression)) return null;
		if (!candidates.length) {
			const other = this.methods(classes, name, !r.isStatic).length;
			throw this.t.error(e, `${javaTypeName(`L${owner};`)}.${name}() (${other ? (r.isStatic ? 'an instance method called on the class' : 'a static method called on an instance') : 'no Java method of that name'})`, 'native');
		}
		const chosen = this.overloadOrNull(candidates, [...e.arguments], e, owner, name);
		if (!chosen) {
			const recv = r.isStatic ? `${this.kotlinValueName(owner, e)}::class.java` : this.t.coerce(callee.expression, 'Any?');
			return { code: `${RT.jsCallMethod}(${[recv, kotlinString(name), ...e.arguments.map((a) => this.t.coerce(a, 'Any?'))].join(', ')})`, desc: '', script: true };
		}
		// Library mode: a protected method core calls from outside a subclass (`ViewGroup.addViewInLayout`), as NativeScript's runtime may: through reflection.
		if (this.t.library && chosen.m.access & ACC_PROTECTED && !r.isStatic && !this.insideSubclassOf(callee, chosen.m.owner)) {
			return { code: `${RT.jsCallDeclared}(${[this.t.coerce(callee.expression, 'Any?'), kotlinString(name), ...e.arguments.map((a) => this.t.coerce(a, 'Any?'))].join(', ')})`, desc: '', script: true };
		}
		// The receiver's type arguments (`LruCache<string, Bitmap>`), for parameters its class's type variables type.
		const given = !r.isStatic && chosen.m.owner === owner ? (this.t.checker.getNonNullableType(this.t.checker.getTypeAtLocation(callee.expression)) as ts.TypeReference).typeArguments : undefined;
		const ownerClass = given?.length ? this.classpath.get(owner) : undefined;
		const typeVar = ownerClass
			? (n: string) => {
					const k = this.typeParamNames(ownerClass).indexOf(n);
					return k >= 0 && given![k] ? this.t.type(given![k], e) : 'Any?';
				}
			: undefined;
		const args = this.argList(e, e.arguments, chosen, candidates, typeVar);
		let target = r.isStatic ? this.kotlinValueName(chosen.m.owner, e) : this.target(callee.expression, callee);
		// Library mode: a receiver held as a wider class than script types it (`nativeTextViewProtected`, a TextView): the method's class, as script trusts it.
		// The class Kotlin holds it as: its type, or the class a cast in its code names (an unchecked script cast, widened).
		const cast = /\bas ([a-z][\w.]*\.[A-Z][\w.]*)\??\)(!!| \?: jsCannot\w+\("[^"]*"\)\))?$/.exec(target)?.[1];
		const holder = this.t.library && !r.isStatic ? (cast ?? this.t.typeOf(callee.expression).replace(/\?$/, '')) : '';
		const heldClass = holder && /^[a-z][\w.]*\.[A-Z]/.test(holder) ? this.classpath.get(holder.replace(/\./g, '/')) : undefined;
		if (heldClass && this.classpath.distance(heldClass.name, chosen.m.owner) === null) target = `(${target.replace(/^\((.*) \?: jsCannot\w+\("[^"]*"\)\)$/, '$1').replace(/(\?|!!)$/, '')} as ${this.kotlinTypeName(chosen.m.owner)})`;
		// `java.lang.String` methods Kotlin's String does not have (`getBytes`): on the Java class it is.
		if (!r.isStatic && chosen.m.owner === 'java/lang/String' && ['getBytes', 'getChars', 'intern', 'codePointAt'].includes(name)) {
			return { code: `(${this.t.expr(callee.expression)} as java.lang.String).${ident(name)}(${args})`, desc: chosen.ret, nullable: chosen.m.nullable };
		}
		const property = r.isStatic ? null : this.kotlinProperty(chosen);
		if (property) return { code: e.arguments.length ? `run { ${target}.${ident(property)} = ${args} }` : `${target}.${ident(property)}`, desc: e.arguments.length ? 'V' : chosen.ret, optional: target.endsWith('?'), nullable: chosen.m.nullable, recentlyNullable: chosen.m.recentlyNullable };
		const mapped = r.isStatic ? null : this.mapped(classes, name, chosen.m.descriptor);
		// Kotlin's own member keeps a function's call parentheses (`toInt()`, `get(i)`) and drops a property's.
		const call = mapped ? (/^\.(get|to\w+)$/.test(mapped) ? `${mapped}(${args})` : mapped) : `.${ident(name)}(${args})`;
		return { code: `${target}${call}`, desc: chosen.ret, optional: target.endsWith('?'), nullable: chosen.m.nullable, recentlyNullable: chosen.m.recentlyNullable };
	},

	/** `const AccessibilityDelegate = android.view.View['AccessibilityDelegate']`: the nested Java class the alias names. */
	nestedAlias(this: AndroidNativeAPI, e: ts.Expression): JavaClass | null {
		const d = ts.isIdentifier(e) ? this.t.resolve(e)?.valueDeclaration : undefined;
		const init = d && ts.isVariableDeclaration(d) && d.initializer ? skipCasts(d.initializer) : undefined;
		if (!init || !ts.isElementAccessExpression(init) || !ts.isStringLiteralLike(init.argumentExpression)) return null;
		const outer = this.classOf(this.classSymbol(init.expression), init.expression);
		return outer ? (this.classpath.get(`${outer.name}$${init.argumentExpression.text}`) ?? null) : null;
	},

	/** Whether code is in a method of a class extending a Java class (or of an extend class of it), where its protected members are reachable. */
	insideSubclassOf(this: AndroidNativeAPI, at: ts.Node, owner: string): boolean {
		for (let n: ts.Node | undefined = at.parent; n; n = n.parent) {
			if (ts.isClassDeclaration(n)) {
				const native = this.nativeHeritage(n);
				if (native && this.classpath.distance(native.base.name, owner) !== null) return true;
			}
			if (ts.isObjectLiteralExpression(n) && ts.isCallExpression(n.parent)) {
				const x = this.extension(n.parent);
				if (x && this.classpath.distance(x.base.name, owner) !== null) return true;
			}
		}
		return false;
	},

	/**
	 * A getter or setter of a class compiled from Kotlin (`OnBackPressedCallback.setEnabled`), which Kotlin calls only as its
	 * property (`isEnabled`): the property's name, known by the field or delegate holding it, or by its accessor pair.
	 */
	kotlinProperty(this: AndroidNativeAPI, c: Callable): string | null {
		const m = /^(get|set|is)([A-Z]\w*)$/.exec(c.m.name);
		if (!m || (m[1] === 'set' ? c.params.length !== 1 : c.params.length)) return null;
		// A Java class's getter of a property a Kotlin interface it implements declares (`ComponentActivity.getOnBackPressedDispatcher`).
		const kotlinInterface = m[1] !== 'set' && this.classpath.supertypes(c.m.owner).some((x) => x.kotlin && x.access & ACC_INTERFACE && x.methods.some((y) => y.name === c.m.name && y.descriptor === c.m.descriptor));
		if (kotlinInterface) return m[1] === 'is' ? c.m.name : m[2][0].toLowerCase() + m[2].slice(1);
		const owner = this.classpath.get(c.m.owner);
		if (!owner?.kotlin) return null;
		const base = m[2][0].toLowerCase() + m[2].slice(1);
		const names = m[1] === 'is' ? [c.m.name] : m[1] === 'set' ? [`is${m[2]}`, base] : [base];
		const has = (n: string) => owner.fields.some((f) => f.name === n || f.name === `${n}$delegate`) || (n.startsWith('is') ? owner.methods.some((x) => x.name === n) && owner.methods.some((x) => x.name === `set${m[2]}`) : owner.methods.some((x) => x.name === `set${m[2]}`) && owner.methods.some((x) => x.name === `get${m[2]}`));
		// An abstract getter of a Kotlin class (`Lifecycle.getCurrentState`) is an abstract property's, which has no field.
		if (m[1] === 'get' && c.m.access & ACC_ABSTRACT) return base;
		return names.find(has) ?? null;
	},

	mapped(this: AndroidNativeAPI, classes: string[], name: string, descriptor: string): string | null {
		for (const c of this.classpath.supertypes(classes[0])) {
			const k = KOTLIN_MAPPED[`${c.name}.${name}${descriptor}`];
			if (k) return k;
		}
		return null;
	},

	construct(this: AndroidNativeAPI, e: ts.NewExpression): string | null {
		const args = [...(e.arguments ?? [])];
		const made = this.extensionNamed(e.expression);
		if (made) {
			if (made.base.name === 'java/lang/Object') {
				if (args.length) throw this.t.error(e, `new ${e.expression.getText()} with arguments (it extends java.lang.Object, whose constructor takes none)`, 'native');
				return `${made.name}()`;
			}
			const ctors = this.constructors(made.base);
			const chosen = this.resolveOverload(ctors, args, e, made.base.name, '<init>');
			return `${made.name}(${this.argList(e, args, chosen, ctors)})`;
		}
		const sym = this.classSymbol(e.expression);
		const decl = sym?.valueDeclaration;
		if (decl && ts.isClassDeclaration(decl) && !decl.getSourceFile().isDeclarationFile) {
			const native = this.nativeHeritage(decl);
			if (!native || decl.members.some((m) => ts.isConstructorDeclaration(m) && m.body)) return null;
			const chosen = this.resolveOverload(this.constructors(native.base), args, e, native.base.name, '<init>');
			return `${ident(decl.name!.text)}(${this.argList(e, args, chosen, this.constructors(native.base))})`;
		}
		const cls = this.untypedClass(e.expression) ?? this.classOf(sym, e);
		if (!cls) return null;
		const literal = args.length === 1 && ts.isObjectLiteralExpression(args[0]) ? args[0] : null;
		if (cls.access & (ACC_INTERFACE | ACC_ABSTRACT)) {
			if (!literal) throw this.t.error(e, `new ${javaTypeName(`L${cls.name};`)} (an ${cls.access & ACC_INTERFACE ? 'interface' : 'abstract class'} takes one object literal implementing it)`, 'native');
			return this.implementation(cls, literal, e);
		}
		// `new java.lang.Integer(n)` and the other boxes: Kotlin's number, boxed where a Java parameter takes the box.
		const box = ({ 'java/lang/Integer': 'I', 'java/lang/Long': 'J', 'java/lang/Float': 'F', 'java/lang/Double': 'D', 'java/lang/Short': 'S', 'java/lang/Byte': 'B', 'java/lang/Boolean': 'Z' } as Record<string, string>)[cls.name];
		if (box && args.length === 1 && this.t.library) return this.toJava(args[0], box);
		// `new java.lang.String(text)`: Kotlin holds Java's strings as its own.
		if (cls.name === 'java/lang/String' && args.length === 1 && isNamed(spelledType(this.t.typeOf(args[0])), 'String', false)) return this.t.str(args[0]);
		const ctors = this.constructors(cls);
		const chosen = this.overloadOrNull(ctors, args, e, cls.name, '<init>');
		if (!chosen) return this.t.fromAnyCode(`${RT.jsNew}(${[`${this.kotlinValueName(cls.name, e)}::class.java`, ...args.map((a) => this.t.coerce(a, 'Any?'))].join(', ')})`, this.t.typeOf(e));
		// Library mode: a generic class made without type arguments (`new java.util.ArrayList()`), of any values.
		const generic = this.t.library && !e.typeArguments?.length && this.typeParamCount(cls) ? this.classRef(cls, undefined, 'Any?', e) : this.kotlinValueName(cls.name, e);
		return `${generic}(${this.argList(e, args, chosen, ctors)})`;
	},

	/**
	 * Library mode and plugins: an overload the argument types cannot pick (untyped arguments, or none fits their declared types)
	 * is null, the call then made through reflection, chosen by the values it is given as NativeScript's runtime chooses.
	 */
	overloadOrNull(this: AndroidNativeAPI, candidates: Callable[], args: ts.Expression[], node: ts.Node, owner: string, name: string): Callable | null {
		try {
			return this.resolveOverload(candidates, args, node, owner, name);
		} catch (e) {
			// So is a plugin's, written against NativeScript's runtime choosing them.
			const reflective = this.t.library || this.t.pluginFiles.has(node.getSourceFile().fileName);
			if (reflective && candidates.length && !args.some(ts.isSpreadElement) && e instanceof Refusal && /\((ambiguous between|no Java overload takes)/.test(e.message)) return null;
			throw e;
		}
	},

	identifier(this: AndroidNativeAPI, e: ts.Identifier): string | null {
		// A class alias read as a value (`if (!PageLayout)`): the class.
		const decl = this.t.resolve(e)?.valueDeclaration;
		if (!decl || !ts.isVariableDeclaration(decl)) return null;
		const made = this.extensionOf(decl);
		if (made) return `${made.name}::class.java`;
		if (!this.nativeAlias(decl)) return null;
		const cls = this.untypedClass(e) ?? this.classOf(this.aliasedClass(decl), e);
		return cls ? `${this.kotlinValueName(cls.name, e)}::class.java` : null;
	},

	structLiteral(this: AndroidNativeAPI, _e: ts.ObjectLiteralExpression, _t: ts.Type): string | null {
		return null;
	},

	toNumber(this: AndroidNativeAPI, e: ts.Expression, _t: string): string | null {
		const classes = this.classesOf(this.t.checker.getTypeAtLocation(e));
		return classes && BOXED_NUMBERS.has(classes[0]) ? `(${this.t.expr(e)} as Number).toDouble()` : null;
	},
};
