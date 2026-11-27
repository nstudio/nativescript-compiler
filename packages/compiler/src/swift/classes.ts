// Classes as Swift: declarations, members, decorators, mixins, statics and constructors.
import ts from 'typescript';
import { BUILTIN_CLASSES } from './library.ts';
import { ERRORS } from '../semantics/globals.ts';
import { escapingParam, functionParts, ident, identPath, optionalType, sameClass, scriptLength, splitTopLevel, swiftString, RT } from './syntax.ts';
import type { IteratorMethod, Translator } from './translator.ts';
import type { KitMember } from '../kit/kit-index.ts';
import type { RecordedMember } from '../kit/manifest.ts';
import { forwardedSetter, isObjectToStringCall, isSelf } from '../semantics/lang.ts';
import { isLibDeclaration, withoutDefault, isWriteTarget } from '../semantics/ast.ts';
import { isAsync, isStatic } from '../semantics/throws.ts';
import { isCoreDeclaration, isShimDeclaration } from '../program/core-facts.ts';
import { isNativePropertyDecorator } from '../program/patterns.ts';
import { prototypeDecorated } from '../semantics/classes.ts';
import { isKit, isUntyped, spelledType } from '../semantics/types.ts';

export const classesMethods = {
	/** A class's memo field (`computed(fn)`): the memo the instance makes when it is first read, and the field reading its value (a throw rethrown to each reader). */
	memoField(this: Translator, m: ts.PropertyDeclaration, name: string): string[] {
		const fn = this.framework.memoized(m, this.checker)!;
		const t = this.computedType(m.initializer as ts.CallExpression);
		const throws = this.throwsInfo.fn(fn);
		const memo = ident(`${name}__memo`);
		this.declare(name, { kind: 'var', type: t });
		return [`    lazy var ${memo} = ${this.memo(fn, t, throws, true)}`, `    var ${ident(name)}: ${t} ${throws ? `{\n        get throws { try ${memo}.read() }\n    }` : `{ ${memo}.value }`}`];
	},

	/** A class decorator the class's translation neither refuses nor runs: core's (`@CSSType`, `@NativeClass`) and the framework's. */
	keptDecorator(this: Translator, d: ts.Decorator): boolean {
		return new RegExp(`^(${['CSSType', 'NativeClass', 'ObjCClass', ...this.framework.readDecorators()].join('|')})\\b`).test(d.expression.getText());
	},

	/**
	 * A class or object with `next` (and `return`, `throw`) is an iterator
	 * script wrote: the kit steps it through these, async when `next` returns a promise.
	 */
	iteratorProtocol(this: Translator, methods: IteratorMethod[]): { conformance: string; lines: string[]; members: [string, RecordedMember][] } | null {
		const next = methods.find((m) => m.name === 'next');
		if (!next || next.params > 1 || next.ret === 'Void') return null;
		// A method declaring its parameter's type takes the protocol's untyped value as that type.
		const call = (m: IteratorMethod, arg: string) => this.marks.tryIf(m.throws || !!m.optional, `${m.optional ? `${RT.jsCallable}(${ident(m.name)}, ${swiftString(m.name)})` : ident(m.name)}(${m.params ? (m.param ? this.fromAny(arg, m.param.replace(/!$/, '?')) : arg) : ''})`);
		const ret = methods.find((m) => m.name === 'return'),
			thr = methods.find((m) => m.name === 'throw');
		if (isKit(spelledType(next.ret), 'JSPromise')) {
			const promise = (m: IteratorMethod, arg: string) => {
				const c = call(m, arg);
				const body = m.ret === 'JSPromise<Any?>' ? c : `${c}.then { (__v: ${m.ret.replace(/^JSPromise<(.*)>$/, '$1')}) -> Any? in ${this.convert('__v', m.ret.replace(/^JSPromise<(.*)>$/, '$1'), 'Any?')} }`;
				return m.throws ? `{ do { return try { () throws -> JSPromise<Any?> in ${body} }() } catch { return JSPromise<Any?>.reject(${RT.jsCaught}(error)) } }()` : body;
			};
			return {
				conformance: 'JSAsyncIteratorProtocol',
				members: [
					['jsNextPromise', { kind: 'func', params: '_ value: Any?', type: 'JSPromise<Any?>' }],
					['jsReturnPromise', { kind: 'func', params: '_ value: Any?', type: 'JSPromise<Any?>?' }],
					['jsThrowPromise', { kind: 'func', params: '_ error: Any?', type: 'JSPromise<Any?>?' }],
				],
				lines: [`    func jsNextPromise(_ value: Any?) -> JSPromise<Any?> { ${promise(next, 'value')} }`, `    func jsReturnPromise(_ value: Any?) -> JSPromise<Any?>? { ${ret ? promise(ret, 'value') : 'nil'} }`, `    func jsThrowPromise(_ error: Any?) -> JSPromise<Any?>? { ${thr ? promise(thr, 'error') : 'nil'} }`],
			};
		}
		const step = (m: IteratorMethod, arg: string) => this.marks.tryCode(`${RT.jsStepOf}(${this.convert(call(m, arg), m.ret, 'Any?')})`);
		return {
			conformance: 'JSIteratorProtocol',
			members: [
				['jsNext', { kind: 'func', params: '_ value: Any?', throws: true, type: 'JSStep' }],
				['jsReturn', { kind: 'func', params: '_ value: Any?', throws: true, type: 'JSStep' }],
				['jsThrow', { kind: 'func', params: '_ error: Any?', throws: true, type: 'JSStep' }],
				['jsHasReturn', { kind: 'var', type: 'Bool' }],
				['jsHasThrow', { kind: 'var', type: 'Bool' }],
			],
			lines: [`    func jsNext(_ value: Any?) throws -> JSStep { ${step(next, 'value')} }`, `    func jsReturn(_ value: Any?) throws -> JSStep { ${ret ? step(ret, 'value') : 'JSStep(value, true)'} }`, `    func jsThrow(_ error: Any?) throws -> JSStep { ${thr ? step(thr, 'error') : 'throw JSException(error)'} }`, `    var jsHasReturn: Bool { ${!!ret} }`, `    var jsHasThrow: Bool { ${!!thr} }`],
		};
	},

	/** Whether an initializer may throw (`staticInModuleOrder`). */
	initializerThrows(this: Translator, e: ts.Expression): boolean {
		return this.throwsInfo.expr(e);
	},

	/** A member named by a symbol (`symbolMemberOf`), its property key spelled. */
	symbolMember(this: Translator, name: ts.PropertyName): { member: string; key: string | null; fixed: boolean; of: ts.Expression | null } | null {
		const s = this.symbolMemberOf(name);
		if (!s) return null;
		if (!s.key) return { member: s.member, key: null, fixed: false, of: null };
		if (s.key.fixed) return { member: s.member, key: `${this.expr(s.key.of)}.key`, fixed: true, of: s.key.of };
		const saved = this.chainingLoose;
		this.chainingLoose = true;
		const key = this.propertyKey(s.key.of);
		this.chainingLoose = saved;
		return { member: s.member, key, fixed: false, of: s.key.of };
	},

	/**
	 * `x instanceof C` where Swift already holds x as C or a subclass ('present' where it may hold none, 'always' where it cannot),
	 * or C has no Swift type of its own (any value is of it): null where the test checks the class.
	 */
	heldInstance(this: Translator, e: ts.BinaryExpression): 'present' | 'always' | null {
		if (BUILTIN_CLASSES[e.right.getText()] || ERRORS[e.right.getText()]) return null;
		const swiftType = this.typeOf(e.right)
			.replace(/^typeof /, '')
			.replace(/\.Type$/, '');
		if (isUntyped(spelledType(swiftType))) return isLibDeclaration(this.resolve(e.right)?.declarations?.[0]) ? null : 'always';
		const held = this.typeOf(e.left);
		// A narrowed read (`value` of `string | Source` after a typeof test) is held as declared, which the test checks.
		const declared = this.declaredTypeOf(e.left);
		// Read narrowed to the class itself (`value as? C`, after an earlier test): whether the cast found one.
		if (declared && declared !== held) return sameClass(held, swiftType) && this.isObjectRef(e.left) ? 'present' : null;
		if (!/^[A-Z][\w.]*[?!]?$/.test(held) || !(sameClass(held, swiftType) || this.extendsNamed(this.checker.getTypeAtLocation(e.left), swiftType))) return null;
		return /[?!]$/.test(held) || !this.definitelyPresent(e.left) ? 'present' : 'always';
	},

	/** An expression the translation does not evaluate as code that may throw: a test it decides, a `delete` it writes with `try?`. */
	unevaluated(this: Translator, n: ts.Node): boolean {
		if (ts.isDeleteExpression(n)) return this.quietDelete(n);
		// An awaited value already settled is read from its continuation's parameter.
		if (ts.isAwaitExpression(n)) return this.subst.has(n);
		// `Object.prototype.toString` of `.call(x)` is never read.
		if (ts.isPropertyAccessExpression(n) && ts.isCallExpression(n.parent) && n.parent.expression === n) return isObjectToStringCall(n, this.checker);
		if (!ts.isBinaryExpression(n)) return false;
		if (n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) return this.pure(n.left) && this.heldInstance(n) === 'always';
		return [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(n.operatorToken.kind) && this.neverNullish(n) !== undefined;
	},

	/** The keys a spread object has when it runs: a program class's or an object shape's own, any other value's as it is a dynamic object. */
	spreadKeys(this: Translator, e: ts.Expression): string {
		const t = this.typeOf(e);
		const base = t.replace(/[?!]$/, '');
		// Held implicitly unwrapped, or maybe missing: through an optional.
		if (this.classNamed(base) || this.isObjectShape(base)) return this.definitelyPresent(e) && !/[?!]$/.test(t) ? `(${this.expr(e)}).jsKeys` : `((${this.expr(e)} as ${base}?)?.jsKeys ?? [])`;
		return `((${this.expr(e)}) as? JSDynamic)?.jsKeys ?? []`;
	},

	/** Whether calling a function value throws: one naming a function declaration throws as its body does; any other may. */
	valueThrows(this: Translator, e: ts.Expression): boolean {
		const decl = ts.isIdentifier(e) ? this.resolve(e)?.valueDeclaration : undefined;
		return !(decl && ts.isFunctionDeclaration(decl) && decl.body && !decl.getSourceFile().isDeclarationFile && !isAsync(decl) && !decl.asteriskToken && !this.throwsInfo.fn(decl));
	},

	/** An expression written as a runtime helper that cannot throw: a class read through `.constructor` (library mode), `Object.prototype.toString.call(x)`. */
	plainHelper(this: Translator, n: ts.Node): boolean {
		// An identity (`profile(name, fn)`) is its last argument: the call itself runs nothing.
		if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && this.library?.identities?.has(n.expression.text) && n.arguments.length) return true;
		if (ts.isCallExpression(n)) return isObjectToStringCall(n.expression, this.checker);
		if (!ts.isPropertyAccessExpression(n) || isWriteTarget(n)) return false;
		if (n.name.text === 'name' && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'constructor') return true;
		return (this.library && n.name.text === 'constructor') ?? false;
	},

	/** A `delete` of a member script added (library mode), written so that nothing it throws escapes: as sloppy JavaScript, false where it fails. */
	quietDelete(this: Translator, e: ts.DeleteExpression): boolean {
		const target = e.expression;
		if (!this.library || !(ts.isElementAccessExpression(target) || ts.isPropertyAccessExpression(target))) return false;
		if (isKit(spelledType(this.typeOf(target.expression)), 'JSRecord') || this.isAny(target.expression)) return false;
		if (ts.isPropertyAccessExpression(target) && !(isSelf(target.expression, this.subst) && this.props.has(target.name.text))) {
			const decl = this.checker.getSymbolAtLocation(target.name)?.valueDeclaration;
			const field = decl && ts.isPropertyDeclaration(decl) && ts.isClassLike(decl.parent) && !decl.getSourceFile().isDeclarationFile && !isStatic(decl) ? this.declaredTypeOf(target) : null;
			if (field?.endsWith('?')) return false;
		}
		return true;
	},

	/**
	 * The Swift name of a method keyed by a symbol known when the program runs (`[directionProperty.setNative]`): after
	 * the symbol (`setNative_direction`), with the class's own name where a base class of the program, or the kit's
	 * classes for an app's, could declare one of that name too.
	 */
	symbolMethodName(this: Translator, cls: ts.ClassLikeDeclaration, m: ts.MethodDeclaration): string {
		const key = (n: ts.PropertyName) => (ts.isComputedPropertyName(n) ? n.expression.getText() : null);
		const own = key(m.name)!;
		const parts = own.split('.').map((p) => p.replace(/[^A-Za-z0-9_]/g, '_'));
		const base =
			parts.length > 1
				? `${parts.at(-1)}_${parts
						.slice(0, -1)
						.join('_')
						.replace(/(Css)?Property$/, '')}`
				: parts[0];
		const name = `symbol_${base}`;
		let inherited = !this.library;
		for (let b = this.sourceBase(cls); b && !inherited; b = this.sourceBase(b)) inherited = b.members.some((x) => ts.isMethodDeclaration(x) && key(x.name) === own);
		return inherited && cls.name ? `${name}_${cls.name.text}` : name;
	},

	/** A declaration's JSDoc comment, as Swift's `///` lines at `indent`. */
	docLines(this: Translator, node: ts.Node, indent: string): string[] {
		const sf = node.getSourceFile();
		const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart()) ?? [];
		const doc = ranges.filter((r) => r.kind === ts.SyntaxKind.MultiLineCommentTrivia && sf.text.startsWith('/**', r.pos) && !sf.text.startsWith('/**/', r.pos)).at(-1);
		if (!doc) return [];
		const body = sf.text
			.slice(doc.pos + 3, doc.end - 2)
			.split('\n')
			.map((l) => l.replace(/^\s*\* ?/, '').trimEnd());
		while (body.length && !body[0].trim()) body.shift();
		while (body.length && !body.at(-1)!.trim()) body.pop();
		return body.map((l) => `${indent}///${l ? ` ${l}` : ''}`);
	},

	/** Each member's JSDoc put before the line declaring it, found by its name among a class's lines. */
	documentMembers(this: Translator, cls: ts.ClassLikeDeclaration, lines: string[]): void {
		for (const m of cls.members) {
			const doc = this.docLines(m, '    ');
			if (!doc.length) continue;
			const name = m.name && !ts.isComputedPropertyName(m.name) ? ident(m.name.getText().replace(/^['"]|['"]$/g, '')).replace(/[$^*+?.()|[\]{}\\]/g, '\\$&') : null;
			const decl = ts.isConstructorDeclaration(m) ? /^ {4}(?:@\S+ )*(?:\w+ )*init\(/ : name && (ts.isMethodDeclaration(m) ? new RegExp(`^ {4}(?:@\\S+ )*(?:\\w+ )*func ${name}[(<]`) : new RegExp(`^ {4}(?:@\\S+ )*(?:\\w+ )*var ${name}\\b`));
			const at = decl ? lines.findIndex((l) => decl.test(l)) : -1;
			if (at > 0) lines.splice(at, 0, ...doc);
		}
	},

	/** The class `X.new()` makes (`super.new()` in a native subclass's static method, its own class), whatever TypeScript types it. */
	madeClass(this: Translator, e: ts.Expression): string | null {
		while (ts.isParenthesizedExpression(e)) e = e.expression;
		if (!ts.isCallExpression(e) || e.arguments.length || !ts.isPropertyAccessExpression(e.expression) || e.expression.name.text !== 'new') return null;
		const made = e.expression.expression;
		const cls = made.kind === ts.SyntaxKind.SuperKeyword ? ts.findAncestor(e, ts.isClassLike) : ts.isIdentifier(made) ? this.resolve(made)?.valueDeclaration : undefined;
		return cls && ts.isClassLike(cls) && cls.name && !cls.getSourceFile().isDeclarationFile ? this.className(cls) : null;
	},

	/** Whether a class type extends the class Swift names `name` (by declared bases, not structure). */
	extendsNamed(this: Translator, t: ts.Type, name: string): boolean {
		const want = name.replace(/[?!]$/, '').replace(/^NativeScriptKit\./, '');
		const target = (t as ts.TypeReference).target ?? t;
		if (typeof target.isClassOrInterface !== 'function' || !target.isClassOrInterface()) return false;
		for (const b of this.checker.getBaseTypes(target)) {
			if (b.getSymbol()?.name === want || this.extendsNamed(b, name)) return true;
		}
		return false;
	},

	/** The class's field decorators, run on its prototype once it is defined (`__decorate([d], Cls.prototype, key, void 0)`). */
	fieldDecorators(this: Translator, cls: ts.ClassDeclaration): string | null {
		const fields = cls.members.filter((m): m is ts.PropertyDeclaration => ts.isPropertyDeclaration(m) && prototypeDecorated(this, m) && !this.nativePropertyOf(m));
		if (!fields.length) return null;
		const name = this.className(cls);
		// A factory overloaded as plugins declare them (`colorProperty(options)` beside `colorProperty(target, key)`) gives what its implementation returns.
		const value = (e: ts.Expression) => {
			const sym = ts.isCallExpression(e) ? this.resolve(e.expression) : undefined;
			const impl = sym && sym.declarations && sym.declarations.length > 1 ? sym.declarations.find((x): x is ts.FunctionDeclaration => ts.isFunctionDeclaration(x) && !!x.body) : undefined;
			return impl ? this.convert(this.expr(e), this.returnTypeOf(impl), 'Any?') : this.coerce(e, 'Any?');
		};
		return fields
			.map(
				(m) =>
					`${this.indent}try ${RT.jsDecorateField}(${name}.self, ${swiftString(m.name.getText())}, [${ts
						.getDecorators(m)!
						.map((d) => value(d.expression))
						.join(', ')}])`,
			)
			.join('\n');
	},

	/**
	 * A field decorated with a native-property decorator (gesturehandler's
	 * `@nativeProperty`): a decorator that defines, with `Object.defineProperty`,
	 * a getter reading `this.native[getterName]()` (else `this.options[key]`,
	 * else the default) and a setter writing `this.options[key]` and calling
	 * `this.native[setterName](value)`, each through an optional converter.
	 * The accessor goes through the native object by key.
	 */
	nativePropertyOf(this: Translator, m: ts.PropertyDeclaration): string | null {
		const d = (ts.getDecorators(m) ?? [])[0];
		if (!d) return null;
		const call = ts.isCallExpression(d.expression) ? d.expression : null;
		const fnName = call ? call.expression : d.expression;
		const fn = this.resolve(fnName)?.declarations?.find((x): x is ts.FunctionDeclaration => ts.isFunctionDeclaration(x) && !!x.body);
		if (!fn) {
			if (prototypeDecorated(this, m)) return null;
			throw this.error(d, `the property decorator ${d.expression.getText()}`);
		}
		if (!isNativePropertyDecorator(fn)) {
			if (prototypeDecorated(this, m)) return null;
			throw this.error(d, `the property decorator ${d.expression.getText()} (not a native-property decorator this build recognizes)`);
		}
		const key = m.name.getText();
		const options = call?.arguments[0] && ts.isObjectLiteralExpression(call.arguments[0]) ? call.arguments[0] : undefined;
		const option = (o: ts.ObjectLiteralExpression | undefined, name: string) => o?.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === name)?.initializer;
		const ios = option(options, 'ios');
		const own = ios && ts.isObjectLiteralExpression(ios) ? ios : options;
		const text = (e?: ts.Expression) => (e && ts.isStringLiteralLike(e) ? e.text : null);
		const cap = key[0].toUpperCase() + key.slice(1);
		const getterName = text(option(own, 'nativeGetterName')) ?? `get${cap}`;
		const setterName = text(option(own, 'nativeSetterName')) ?? `set${cap}`;
		const converter = option(options, 'converter');
		const fromNative = converter && ts.isObjectLiteralExpression(converter) ? option(converter, 'fromNative') : undefined;
		const toNative = converter && ts.isObjectLiteralExpression(converter) ? option(converter, 'toNative') : undefined;
		const fallback = option(options, 'defaultValue');
		const t = this.typeOf(m.name);
		const read = `${RT.jsNativePropertyGet}(self.native, ${swiftString(getterName)}, fallback: ${RT.jsOr}(${RT.jsField}(self.options, ${swiftString(key)}), ${fallback ? this.coerce(fallback, 'Any?') : 'nil'}))`;
		const converted = fromNative ? `${RT.jsCall}(${this.coerce(fromNative, 'Any?')}, ${read}, ${swiftString(key)})` : read;
		const write = toNative ? `${RT.jsCall}(${this.coerce(toNative, 'Any?')}, value, ${swiftString(key)})` : 'value';
		return [`    var ${ident(key)}: ${optionalType(t)} {`, `        get { ${fromNative ? `(try? ${converted}).flatMap { ${this.fromAnyCode('$0', optionalType(t))} } ?? nil` : this.fromAnyCode(converted, optionalType(t))} }`, '        set {', `            let value: Any? = ${this.convert('newValue', optionalType(t), 'Any?')}`, `            ${RT.jsReport} { try ${RT.jsSet}(self.options, ${swiftString(key)}, value) }`, `            ${RT.jsReport} { ${RT.jsNativePropertySet}(self.native, ${swiftString(setterName)}, try ${write}) }`, '        }', '    }'].join('\n');
	},

	/** A class's instance accessors on its prototype, registered before static initializers run. */
	prototypeAccessors(this: Translator, cls: ts.ClassDeclaration): string {
		const i = this.indent;
		const name = this.className(cls);
		const accessors = new Map<string, { member: string; get?: ts.GetAccessorDeclaration; set?: ts.SetAccessorDeclaration }>();
		for (const m of cls.members) {
			if (!(ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) || isStatic(m)) continue;
			// `get ['class']()` is the property `class`.
			const key = !ts.isComputedPropertyName(m.name) ? m.name.getText() : ts.isStringLiteral(m.name.expression) ? m.name.expression.text : null;
			if (key === null) continue;
			const a = accessors.get(key) ?? { member: m.name.getText() };
			if (ts.isGetAccessorDeclaration(m)) a.get = m;
			else a.set = m;
			accessors.set(key, a);
		}
		// A generic class is no one Swift class to declare them on.
		if (!accessors.size || this.native.classDecl(cls) || cls.typeParameters?.some((p) => !this.erasesTypeParameter(p))) return '';
		return [...accessors]
			.map(([key, a]) => {
				const n = a.member;
				const t = (a.get && this.narrowedFrom(a.get)) ?? (a.get ? this.returnTypeOf(a.get) : optionalType(this.typeOf(a.set!.parameters[0].name)));
				const self = `guard let __o = __this as? ${name} else { throw JSException(JSTypeError("Illegal invocation")) }`;
				const get = a.get ? `{ (__this: Any?) throws -> Any? in ${self}; return ${this.convert(this.marks.tryIf(this.throwsInfo.fn(a.get) && !this.reportedGetter(a.get), `__o.${ident(n)}`), t, 'Any?')} }` : 'nil';
				const forward = a.set ? forwardedSetter(a.set) : null;
				const set = !a.set
					? 'nil'
					: // `set color(value) { this.style.color = value; }`: the value script gives (a string the style converts) goes on as it is.
						forward
						? `{ (__this: Any?, __v: Any?) throws -> Void in ${self}; try ${RT.jsSet}(${this.withThis(a.set, '__o', false, () => this.expr(forward.expression))}, ${swiftString(forward.name.text)}, __v) }`
						: this.setterTakesAny(a.set)
							? `{ (__this: Any?, __v: Any?) throws -> Void in ${self}; __o.__set_${n.replace(/\W/g, '_')}(__v) }`
							: `{ (__this: Any?, __v: Any?) throws -> Void in ${self}; __o.${ident(n)} = ${this.fromAny('__v', t)} }`;
				return `${i}JSPrototypes.declare(${name}.self, ${swiftString(key)}, get: ${get}, set: ${set})`;
			})
			.join('\n');
	},

	/** What defining a class does after its static initializers (library mode): its statics when held as a value, then its decorators, the last first. */
	classDefinition(this: Translator, cls: ts.ClassDeclaration): string {
		const i = this.indent;
		const name = this.className(cls);
		const lines: string[] = [];
		// A class script holds as a value (`TouchControlHandler = TouchHandlerImpl`) is asked for its statics by name.
		if (this.heldAsValue(cls)) {
			const statics = this.staticsDeclaration(cls, i);
			if (statics) lines.push(statics);
		}
		const decorators = (ts.getDecorators(cls) ?? []).filter((d) => !(ts.isIdentifier(d.expression) && this.library?.identities?.has(d.expression.text)) && !this.keptDecorator(d));
		if (decorators.length) lines.push(`${i}try ${RT.jsDecorate}(${name}.self, [${decorators.map((d) => this.coerce(d.expression, 'Any?')).join(', ')}])`);
		return lines.join('\n');
	},

	/** `JSPrototypes.declareStatics` of the class's static methods and properties, for script reading them by name; null where it has none. */
	staticsDeclaration(this: Translator, cls: ts.ClassDeclaration, i?: string): string | null {
		if (i === undefined) i = this.indent;
		const name = this.className(cls);
		const statics = cls.members.flatMap((m): string[] => {
			// A native subclass's `ObjCProtocols` and `ObjCExposedMethods` are the runtime's metadata, compiled into its declaration, no members.
			if (!isStatic(m) || !m.name || !ts.isIdentifier(m.name) || ['ObjCProtocols', 'ObjCExposedMethods'].includes(m.name.text)) return [];
			const n = m.name.text,
				ref = `${name}.${ident(n)}`;
			if (ts.isMethodDeclaration(m)) {
				if (!m.body || m.typeParameters?.length || m.asteriskToken || isAsync(m) || cls.members.filter((x) => ts.isMethodDeclaration(x) && x.name.getText() === n).length > 1) return [];
				const sig = this.signatureOf(m);
				// Implicitly unwrapped in a signature, optional in a function type.
				const plainOpt = (t: string) => t.replace(/^\((.*)\)!$/, '($1)?').replace(/!$/, '?');
				return [`(${swiftString(n)}, { () -> Any? in ${this.boxFunction(ref, `(${sig.params.map((p) => escapingParam(plainOpt(p.type))).join(', ')}) throws -> ${plainOpt(sig.ret)}`, -1, n, scriptLength(m), undefined, false)} })`];
			}
			if (ts.isPropertyDeclaration(m) || (ts.isGetAccessorDeclaration(m) && !this.throwsInfo.fn(m))) return [`(${swiftString(n)}, { () -> Any? in ${this.convert(ref, this.typeOf(m.name), 'Any?')} })`];
			return [];
		});
		return statics.length ? `${i}JSPrototypes.declareStatics(${name}.self, [${statics.join(', ')}])` : null;
	},
	/**
	 * Whether the program holds a class as a value (assigned, stored, passed, returned) rather than
	 * only constructing it, extending it, testing against it or reaching its statics through its name,
	 * or reads a static the class declares from some instance's class: script then reads its statics
	 * from wherever it is held.
	 */
	heldAsValue(this: Translator, cls: ts.ClassDeclaration): boolean {
		if (!this.valueClasses) {
			const found = new Set<ts.Symbol>();
			const visit = (x: ts.Node): void => {
				if (this.library && (ts.isElementAccessExpression(x) || ts.isPropertyAccessExpression(x)) && ts.isPropertyAccessExpression(x.expression) && x.expression.name.text === 'constructor') {
					const key = ts.isPropertyAccessExpression(x) ? x.name.text : this.checker.getTypeAtLocation(x.argumentExpression);
					if (typeof key === 'string') this.constructorKeys.add(key);
					else if (key.isStringLiteral()) this.constructorKeys.add(key.value);
				}
				if (ts.isIdentifier(x)) {
					// A class read from a module's namespace (`code.Model`) is used where the whole read stands.
					const at: ts.Expression = ts.isPropertyAccessExpression(x.parent) && x.parent.name === x && !!this.resolve(x.parent.expression)?.valueDeclaration && ts.isSourceFile(this.resolve(x.parent.expression)!.valueDeclaration!) ? x.parent : x;
					const p = at.parent;
					const plainUse = (ts.isNewExpression(p) && p.expression === at) || (ts.isPropertyAccessExpression(p) && p.expression === at) || (ts.isCallExpression(p) && p.expression === at) || ts.isExpressionWithTypeArguments(p) || (ts.isBinaryExpression(p) && p.right === at && p.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) || ts.isTypeReferenceNode(p) || ts.isTypeQueryNode(p) || ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isClassDeclaration(p) || ts.isDecorator(p) || ts.isQualifiedName(p) || (ts.isPropertyAccessExpression(p) && p.name === at);
					if (!plainUse) {
						const sym = this.checker.getSymbolAtLocation(x);
						const target = sym && sym.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(sym) : sym;
						if (target && target.flags & ts.SymbolFlags.Class) found.add(target);
					}
				}
				ts.forEachChild(x, visit);
			};
			for (const sf of this.sourceFiles) if (!sf.isDeclarationFile) visit(sf);
			this.valueClasses = found;
		}
		const sym = cls.name && this.checker.getSymbolAtLocation(cls.name);
		return (!!sym && this.valueClasses.has(sym)) || cls.members.some((m) => isStatic(m) && !!m.name && ts.isIdentifier(m.name) && this.constructorKeys.has(m.name.text));
	},

	/** The core class at the root of a class's chain of app and plugin classes, when NativeScriptKit has it. */
	kitRootOf(this: Translator, cls: ts.ClassLikeDeclaration): string | null {
		for (let b: ts.ClassLikeDeclaration | undefined = cls; b;) {
			const h: ts.ExpressionWithTypeArguments | undefined = b.heritageClauses?.find((x) => x.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
			if (!h) return null;
			const d: ts.Declaration | undefined = this.checker.getTypeAtLocation(h.expression).getSymbol()?.valueDeclaration;
			const kit = d && isCoreDeclaration(d) && ts.isClassLike(d) && d.name ? this.core.kitTypeName(d.name.text) : null;
			if (kit) return kit;
			if (d && isShimDeclaration(d) && ts.isClassLike(d) && d.name && this.core.subclassable(d.name.text)) return d.name.text;
			b = d && ts.isClassLike(d) && !d.getSourceFile().isDeclarationFile ? d : undefined;
		}
		return null;
	},

	/** The Swift name of a class the program declares. */
	className(this: Translator, decl: ts.ClassLikeDeclaration): string {
		if (ts.isClassExpression(decl)) return this.classExprs.name(decl);
		return decl.name ? identPath(this.topName(decl, decl.name.text)) : 'AnonymousClass';
	},

	/** `x[prop.setNative](…)` where x's class keeps such methods under their symbol (library mode, or a class over a kit class): called by key. */
	keyedSetNative(this: Translator, target: ts.Expression): boolean {
		if (this.library) return true;
		const t = this.checker.getNonNullableType(this.checker.getTypeAtLocation(target));
		const cls = (t.isTypeParameter() ? (t.getConstraint() ?? t) : t).getSymbol()?.valueDeclaration;
		return !!cls && ts.isClassLike(cls) && !!this.kitRootOf(cls);
	},

	/**
	 * A method overriding NativeScriptKit's: the kit's Swift signature, the
	 * TypeScript body seeing its own types; what it throws is reported, as an
	 * error escaping a native callback is.
	 */
	kitOverride(this: Translator, m: ts.MethodDeclaration, kit: KitMember, overridesProgram = false): string {
		const kitParams = (kit.params ?? '').trim() ? splitTopLevel(kit.params!) : [];
		const parsed = kitParams.map((p, k) => {
			const colon = p.indexOf(':');
			const names = p.slice(0, colon).trim().split(/\s+/);
			const type = withoutDefault(p.slice(colon + 1)).trim();
			// `_ child: View` → `_ __k0: View`; `name: T` → `name __k0: T`; `label name: T` → `label __k0: T`.
			return { decl: `${names[0]} __k${k}: ${type}`, type: type.replace(/^@escaping\s+/, '') };
		});
		const tsRet = this.lenientRef(this.returnTypeOf(m));
		const ret = kit.type === 'Void' ? 'Void' : kit.type;
		const throws = this.throwsInfo.fn(m);
		// Taking other types than the kit's (`callback: any` over a listener's function type): the method as the program
		// declares it, for the program's calls, and the kit's override passing the kit's arguments on to it.
		const own = this.signatureOf(m);
		const plain = (t: string) => t.replace(/^@escaping\s+/, '');
		// Only parameters that differ: Swift cannot tell apart two methods differing in their result alone.
		// An implicitly unwrapped parameter takes what the plain one does: a method of both would call itself.
		const sameParams = own.params.length === parsed.length && own.params.every((p, k) => plain(p.type).replace(/!$/, '') === parsed[k].type.replace(/!$/, ''));
		// Taking functions of subclasses of the kit's parameters (`(View?) -> Bool` over `(ViewCommon?) -> Bool`): by contravariance Swift
		// reads the method as overriding the kit's, so it is the override itself.
		const narrower = (a: string, b: string) => a === b || (/[?!]$/.test(a) === /[?!]$/.test(b) && (this.isSubclassOf(a.replace(/[?!]$/, ''), b.replace(/[?!]$/, '')) || this.core.extendsKit(a.replace(/[?!]$/, ''), b.replace(/[?!]$/, ''))));
		const overriding = (a: string, b: string) => {
			if (a === b) return true;
			const x = functionParts(a),
				y = functionParts(b);
			return !!x && !!y && x.params.length === y.params.length && x.result === y.result && /\bthrows\b/.test(a) === /\bthrows\b/.test(b) && x.params.every((p, k) => narrower(p, y.params[k]));
		};
		if (!sameParams && own.params.length === parsed.length && own.params.every((p, k) => overriding(plain(p.type), parsed[k].type)) && (!throws || kit.throws) && tsRet === ret) {
			return `    ${this.memberFunc(m, ident(m.name.getText()), 'override ')}`;
		}
		const overrideParams = parsed.map((p) => p.decl).join(', ');
		this.declare(m.name.getText(), { kind: 'func', mods: 'override ', params: overrideParams, throws: !!kit.throws, type: ret });
		if (!sameParams && (!throws || kit.throws) && !m.parameters.some((p) => p.dotDotDotToken)) {
			const name = ident(m.name.getText());
			const declared = this.memberFunc(m, name, overridesProgram ? 'override ' : '');
			const args = m.parameters.map((p, k) => (parsed[k] ? this.convert(`__k${k}`, parsed[k].type, this.typeOf(p.name)) : (this.zero(this.typeOf(p.name)) ?? 'nil')));
			const call = this.marks.tryIf(throws, `self.${name}(${args.join(', ')})`);
			const forward = ret === 'Void' ? `        ${tsRet === 'Void' ? call : `_ = ${call}`}` : `        return ${this.convert(call, tsRet, ret)}`;
			return [`    ${declared}`, `    override func ${name}(${parsed.map((p) => p.decl).join(', ')})${kit.throws ? ' throws' : ''}${ret === 'Void' ? '' : ` -> ${ret}`} {`, forward, '    }'].join('\n');
		}
		const binds = m.parameters
			.map((p, k) => {
				const tsType = this.typeOf(p.name);
				let value = parsed[k] ? this.convert(`__k${k}`, parsed[k].type, tsType) : (this.zero(tsType) ?? 'nil');
				// A parameter the override declares as a subclass of the kit's (`child: View` over `ViewBase`): the argument as that class.
				const own = tsType.replace(/[?!]$/, '');
				if (parsed[k] && value === `__k${k}` && own !== parsed[k].type.replace(/[?!]$/, '') && /^[A-Z]\w*$/.test(own) && (this.isSubclassOf(own, parsed[k].type.replace(/[?!]$/, '')) || this.core.extendsKit(own, parsed[k].type.replace(/[?!]$/, '')))) value = `${RT.jsImplicit}(__k${k} as? ${own})`;
				return ts.isIdentifier(p.name) && this.isRead(p.name) ? `        let ${ident(p.name.text)}: ${this.lenientRef(tsType)} = ${value}` : '';
			})
			.filter(Boolean);
		const body = this.inFunction(tsRet, () => this.functionBody(m, tsRet, '        '));
		const call = `{ () ${throws ? 'throws ' : ''}-> ${tsRet} in${body.slice(1)}()`;
		// A kit method that throws passes on what the override throws, as core's caller catches it.
		const result = ret === 'Void' ? (throws ? (kit.throws ? `        _ = try ${call}` : `        ${RT.jsReport} { _ = try ${call} }`) : `        _ = ${call}`) : `        let __result: ${tsRet} = ${throws && !kit.throws ? `${RT.jsReportedOrZero} { () throws -> ${tsRet} in${body.slice(1)}` : this.marks.tryIf(throws, `${call}`)}\n        return ${this.convert('__result', tsRet, ret)}`;
		return [`    override func ${ident(m.name.getText())}(${parsed.map((p) => p.decl).join(', ')})${kit.throws ? ' throws' : ''}${ret === 'Void' ? '' : ` -> ${ret}`} {`, ...binds, result, '    }'].join('\n');
	},
};
