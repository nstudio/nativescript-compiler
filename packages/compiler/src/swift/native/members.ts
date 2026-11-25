// Native members as Swift: protocol requirements, property reads, chains of optional reads and enum members.
import ts from 'typescript';
import { DEPLOYMENT, NUMBERS, base, bridge, onlyTested, optional, tested, unboxed } from './bridging.ts';
import { optionalType, RT } from '../syntax.ts';
import type { NativeAPI } from './api.ts';
import { lookupClass, lookupEnum, lookupMember, lookupStruct, type NativeMethod, type NativeProperty, type SwiftType } from './sdk.ts';
import { implementedInterfaces } from '../../semantics/lang.ts';
import { isStatic } from '../../semantics/throws.ts';
import { rethrowUnlessRefused } from '../../semantics/refusals.ts';
import { isWriteTarget, appMember } from '../../semantics/ast.ts';
import { isNamed, isUntyped, spelledType } from '../../semantics/types.ts';

export const nativeMembersMethods = {
	/**
	 * An app class's method implementing a native protocol's (`collectionViewNumberOfItemsInSection` of a
	 * UICollectionViewDataSource), which Swift declares and calls by the protocol's name.
	 */
	protocolRequirement(this: NativeAPI, name: ts.MemberName): NativeMethod | NativeProperty | null {
		const decl = this.t.checker.getSymbolAtLocation(name)?.declarations?.[0];
		if (!decl || !ts.isMethodDeclaration(decl) || !ts.isClassLike(decl.parent) || isStatic(decl)) return null;
		for (const i of implementedInterfaces(this.t.checker, decl.parent)) {
			const p = this.symbolModule(this.t.checker.getTypeAtLocation(i).getSymbol());
			if (p && lookupClass(p.module, p.name)?.kind === 'protocol') {
				const m = this.found(lookupMember(p.module, p.name, name.getText(), false));
				if (m) return m;
			}
		}
		return null;
	},

	/** The Objective-C protocols a class adopts: `implements`, `@ObjCClass(…)` and `ObjCProtocols`. */
	adoptedProtocols(this: NativeAPI, cls: ts.ClassLikeDeclaration): { module: string; name: string; swift: string }[] {
		const t = this.t;
		const protocols: { module: string; name: string; swift: string }[] = [];
		const addProtocol = (e: ts.Expression) => {
			const p = this.symbolModule(t.resolve(e));
			const pc = p && lookupClass(p.module, p.name);
			if (!p || !pc || pc.kind !== 'protocol') throw t.error(e, `${e.getText()} (not an Objective-C protocol)`, 'native');
			if (!protocols.some((x) => x.name === p.name)) protocols.push({ ...p, swift: pc.swift });
		};
		for (const i of cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ImplementsKeyword)?.types ?? []) addProtocol(i.expression);
		for (const d of ts.getDecorators(cls) ?? []) if (ts.isCallExpression(d.expression) && d.expression.expression.getText() === 'ObjCClass') d.expression.arguments.forEach(addProtocol);
		const listed = cls.members.find((m): m is ts.PropertyDeclaration => ts.isPropertyDeclaration(m) && m.name.getText() === 'ObjCProtocols' && ts.getModifiers(m)?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword) === true);
		if (listed?.initializer && ts.isArrayLiteralExpression(listed.initializer)) for (const e of listed.initializer.elements) addProtocol(e);
		return protocols;
	},

	/** The property named `n` that a native base or an adopted protocol declares (`UIApplicationDelegate.window`), if any. */
	nativeProperty(this: NativeAPI, base: { module: string; name: string }, protocols: { module: string; name: string }[], n: string) {
		const fromBase = this.found(lookupMember(base.module, base.name, n, false));
		const native = fromBase?.kind === 'property' ? fromBase : (protocols.map((p) => lookupMember(p.module, p.name, n, false)).find((m) => m?.kind === 'property') ?? fromBase);
		return { native: native?.kind === 'property' ? native : null, viaProtocol: native !== fromBase };
	},

	/** Whether a getter of a class extending a native one is a native property's, which Swift types as the SDK does. */
	nativeGetter(this: NativeAPI, get: ts.GetAccessorDeclaration): boolean {
		return this.nativeGetterType(get) !== null;
	},

	/** The Swift type of the native property a getter of a class extending a native one is (`UIWindow?` of `window`), or null. */
	nativeGetterType(this: NativeAPI, get: ts.GetAccessorDeclaration): SwiftType | null {
		const cls = get.parent;
		const heritage = ts.isClassLike(cls) ? cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0] : undefined;
		const base = heritage && this.symbolModule(this.t.resolve(heritage.expression));
		return (base && this.nativeProperty(base, this.adoptedProtocols(cls as ts.ClassLikeDeclaration), get.name.getText()).native?.type) || null;
	},

	/** A call of an app class's override of its native base's method: Swift calls it by the native signature. */
	overrideCall(this: NativeAPI, e: ts.CallExpression): boolean {
		return ts.isPropertyAccessExpression(e.expression) && appMember(e.expression.name, this.t.checker) && this.nativeOverride(e.expression.name);
	},

	/** An app class's override of its native base's method (`setViewControllersAnimated` in a UINavigationController subclass): called by the native name. */
	nativeOverride(this: NativeAPI, name: ts.Node): boolean {
		const decl = this.t.checker.getSymbolAtLocation(name)?.declarations?.[0];
		if (!decl || !ts.isMethodDeclaration(decl) || !ts.isClassLike(decl.parent)) return false;
		const base = this.nativeBase(this.t.checker.getTypeAtLocation(decl.parent));
		return !!base && !!lookupMember(base.module, base.name, decl.name.getText(), false);
	},

	/** The Swift type of a native property or struct field a read reaches (null for anything else, or a property newer than the deployment target). */
	propertyType(this: NativeAPI, e: ts.PropertyAccessExpression): SwiftType | null {
		try {
			if (appMember(e.name, this.t.checker) || (ts.isIdentifier(e.expression) && this.t.untypedLetReceiver(e.expression))) return null;
			const r = this.receiver(e.expression);
			if (!r) return null;
			const struct = !r.isStatic && lookupStruct(r.module, r.name);
			if (struct) return struct.fields[e.name.text] ?? null;
			const m = lookupMember(r.module, r.name, e.name.text, r.isStatic);
			return m && m.kind === 'property' && !(m.introduced && parseFloat(m.introduced) > DEPLOYMENT) ? m.type : null;
		} catch (e) {
			rethrowUnlessRefused(e);
			return null;
		}
	},

	/** `x.prop` and `X.classProp` on native types; also enum members (`UIViewContentMode.Center`). */
	property(this: NativeAPI, e: ts.PropertyAccessExpression): string | null {
		const enumCase = this.enumMember(e);
		if (enumCase) return enumCase;
		if (appMember(e.name, this.t.checker)) return null;
		if (ts.isIdentifier(e.expression) && this.t.untypedLetReceiver(e.expression)) return null;
		const either = this.eitherRead(e);
		if (either) return either;
		const r = this.receiver(e.expression);
		if (!r) return null;
		const struct = !r.isStatic && lookupStruct(r.module, r.name);
		if (struct) {
			const field = struct.fields[e.name.text];
			if (!field) throw this.t.error(e, `${r.name}.${e.name.text} (not a field of ${struct.swift})`, 'native');
			if (e.questionDotToken || ts.isOptionalChain(e)) return this.chainEnd(e, `${this.chainHead(e.expression)}${e.name.text}`, field);
			return this.fromSwift(`${this.t.expr(e.expression)}.${e.name.text}`, field, e);
		}
		const collection = !r.isStatic ? this.collectionMember(e.expression, e.name.text, null, e) : null;
		if (collection) return collection;
		const m = this.found(lookupMember(r.module, r.name, e.name.text, r.isStatic));
		if (!m) throw this.t.error(e, `${r.name}.${e.name.text} (${this.noCounterpart(r.module)})`, 'native');
		// A property newer than the deployment target, read (core's feature test `x.newProperty !== undefined`): undefined on an older OS, as script reads it there.
		const newer = m.kind === 'property' && m.introduced && parseFloat(m.introduced) > DEPLOYMENT && !this.t.availabilityChecked(parseFloat(m.introduced)) ? parseFloat(m.introduced) : 0;
		const absent = newer && !e.questionDotToken && !ts.isOptionalChain(e) && !isWriteTarget(e) ? this.t.undefinedValue(this.t.typeOf(e)) : null;
		if (!absent) this.checkAvailable(m, e, `${r.name}.${e.name.text}`);
		if ((e.questionDotToken || ts.isOptionalChain(e)) && !r.isStatic && m.kind === 'property') return this.chainEnd(e, `${this.chainHead(e.expression)}${m.swift}`, m.type);
		const target = r.isStatic ? this.className(lookupClass(r.module, r.name)!) : this.unwrapped(e.expression);
		if (absent && m.kind === 'property') {
			const read = this.fromSwift(`${target}.${m.swift}`, m.type, e);
			const throws = !r.isStatic && this.t.receiverThrows(e.expression);
			return `${throws ? '(try ' : ''}{ () ${throws ? 'throws ' : ''}-> ${this.t.typeOf(e)} in if #available(iOS ${newer}, *) { return ${read} } else { return ${absent} } }()${throws ? ')' : ''}`;
		}
		if (m.kind === 'property') return this.fromSwift(`${target}.${m.swift}`, m.type, e);
		// A no-argument method read as a property in the d.ts (`UIColor.redColor` is a class property there).
		if (m.kind === 'method' && !m.params.length) return this.fromSwift(`${target}.${m.swift}()`, m.returns, e);
		if (m.kind === 'init' && !m.params.length) return this.fromSwift(`${target}()`, m.returns, e);
		// A method tested for (`x.method && x.method(y)`): whether the object has it, as the runtime finds it on the object.
		if (m.kind === 'method' && tested(e)) return `${r.isStatic ? `(${target}.self as AnyObject)` : target}.responds(to: NSSelectorFromString(${JSON.stringify(m.selector)}))`;
		throw this.t.error(e, `${r.name}.${e.name.text} read as a value`, 'native');
	},

	/**
	 * A native receiver read without `?.` that TypeScript types as possibly
	 * null (an app checked without strictNullChecks): JavaScript would throw on
	 * null, so Swift unwraps. The cast makes the unwrap valid whether or not
	 * Swift has the value as optional.
	 */
	unwrapped(this: NativeAPI, x: ts.Expression): string {
		const checked = this.t.presentTypedReceiver(x);
		if (checked) return checked;
		const code = this.t.expr(x);
		const t = this.t.typeOf(x);
		const erased = isUntyped(spelledType(t)) ? this.erasedReceiver(x, code) : null;
		if (erased) return erased;
		// `x?.objectForKey(k)`: the chain continues past a value Swift may hold as optional.
		const p = x.parent;
		if (ts.isPropertyAccessExpression(p) && p.expression === x && p.questionDotToken && !isUntyped(spelledType(t)) && !t.includes('->')) return `(${code} as ${t.replace(/\?$/, '')}?)?`;
		const held = this.t.marks.markOf(code);
		if (held?.op === 'helper' && held.name === 'jsUnwrap') return code;
		if (this.t.givesUndefined(x) && !isUntyped(spelledType(t)) && !t.includes('->')) return this.t.marks.unwrappedCode(`(${code} as ${optionalType(t.replace(/[?!]$/, ''))})`);
		if (!t.endsWith('?') || isUntyped(spelledType(t)) || t.includes('->')) return code;
		return this.t.marks.unwrappedCode(`(${code} as ${t})`);
	},

	/**
	 * A native object Swift holds untyped though TypeScript knows its class (`this.native` of a
	 * `Handler<T extends GestureHandler>`, a field of the generic base typed `T`): the object as that class.
	 */
	erasedReceiver(this: NativeAPI, x: ts.Expression, code: string): string | null {
		const c = this.t.checker;
		const t = c.getNonNullableType(c.getTypeAtLocation(x));
		if (!(t.flags & ts.TypeFlags.TypeParameter)) return null;
		const r = this.receiver(x);
		const cls = r && !r.isStatic ? lookupClass(r.module, r.name) : null;
		if (!cls) return null;
		return `(${RT.jsFlat}(${code}) as! ${cls.kind === 'protocol' ? `any ${this.className(cls)}` : this.className(cls)})`;
	},

	/**
	 * The receiver of `x?.member` up to the member, as Swift continues an
	 * optional chain: `?.` past an optional link, `.` past a member Swift has
	 * as non-optional, and a value outside a chain cast to optional, which is
	 * valid whether Swift has it as optional, implicitly unwrapped or neither
	 * (a kit member TypeScript declares non-null may be optional in Swift).
	 */
	chainHead(this: NativeAPI, x: ts.Expression): string {
		let inner = x;
		while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
		if (ts.isCallExpression(inner) || (ts.isPropertyAccessExpression(inner) && ts.isOptionalChain(inner))) {
			const own = ts.isPropertyAccessExpression(inner) ? this.memberType(inner) : null;
			this.keepOptional.add(inner);
			try {
				const code = this.t.expr(x);
				// A field redeclared with a native type over its base's untyped one (`nativeViewProtected: UIView`).
				const t = this.t.typeOf(x).replace(/[?!]$/, '');
				if (ts.isPropertyAccessExpression(inner) && isUntyped(spelledType(this.t.declaredTypeOf(inner))) && /^[A-Z]\w*$/.test(t) && this.receiver(x)) return `(${code} as? ${t})?.`;
				return `${code}${own !== null && !optional(own) && !(ts.isPropertyAccessExpression(inner) && this.foundationSetLink(inner, own)) ? '.' : '?.'}`;
			} finally {
				this.keepOptional.delete(inner);
			}
		}
		const t = this.t.typeOf(x);
		if (isUntyped(spelledType(t)) || t.endsWith('!')) return `${this.t.expr(x)}?.`;
		return `(${this.t.expr(x)} as ${optionalType(t)})?.`;
	},

	/** `x?.prop` of a native property on a receiver Swift holds as optional (`receiver`): its Swift name, a number as script reads it; null for anything else. */
	chainedProperty(this: NativeAPI, e: ts.PropertyAccessExpression, receiver: string, dot = '?.'): string | null {
		const type = this.memberType(e);
		if (type === null || this.receiver(e.expression)?.isStatic) return null;
		const r = this.receiver(e.expression)!;
		const m = lookupMember(r.module, r.name, e.name.text, false);
		const chained = `${receiver}${dot}${m && m.kind === 'property' ? m.swift : e.name.text}`;
		const b = base(type);
		return NUMBERS.has(b) && b !== 'Double' && b !== 'TimeInterval' && isNamed(spelledType(this.t.typeOf(e)), 'Double', false) ? `(${chained}).map { Double($0) }` : chained;
	},

	/**
	 * Lenient code: a native property or method result Swift has optional where TypeScript declares it present, of a
	 * type lenient code otherwise holds present (an array, a dictionary, a struct, an enum), whose member is read: a
	 * missing one throws JavaScript's TypeError there.
	 */
	optionalRead(this: NativeAPI, e: ts.Expression): boolean {
		if (!this.t.lenient || ts.isOptionalChain(e)) return false;
		const p = ts.walkUpParenthesizedExpressions(e.parent);
		const receiver = (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && ts.skipOuterExpressions(p.expression, ts.OuterExpressionKinds.Parentheses) === e && !p.questionDotToken;
		if (!receiver && !this.t.looseTolerated(e)) return false;
		const swift = ts.isPropertyAccessExpression(e) ? this.memberType(e) : ts.isCallExpression(e) ? this.methodReturns(e) : null;
		return !!swift && optional(swift);
	},

	/** A native call Swift declares to give a value it never lacks (`NSIndexPath.indexPathForRowInSection(…)`, an initializer that cannot fail). */
	presentResult(this: NativeAPI, call: ts.Expression): boolean {
		if (!ts.isCallExpression(call) || ts.isOptionalChain(call)) return false;
		const callee = call.expression;
		if (!ts.isPropertyAccessExpression(callee) || appMember(callee.name, this.t.checker)) return false;
		const r = this.receiver(callee.expression);
		if (!r) return false;
		const m = lookupMember(r.module, r.name, callee.name.text, r.isStatic);
		return !!m && (m.kind === 'method' || m.kind === 'init') && !!m.returns && m.returns !== 'Void' && !optional(m.returns);
	},

	/** The Swift type of a native property or struct field `x.name`, or null for anything else. */
	memberType(this: NativeAPI, e: ts.PropertyAccessExpression): SwiftType | null {
		if (appMember(e.name, this.t.checker)) return null;
		const r = this.receiver(e.expression);
		if (!r) return null;
		const struct = !r.isStatic && lookupStruct(r.module, r.name);
		if (struct) return struct.fields[e.name.text] ?? null;
		const m = lookupMember(r.module, r.name, e.name.text, r.isStatic);
		return m?.kind === 'property' ? m.type : null;
	},

	/** The Swift type a native instance method call `x.m()` returns, or null for anything else. */
	methodReturns(this: NativeAPI, call: ts.CallExpression): SwiftType | null {
		const callee = call.expression;
		if (!ts.isPropertyAccessExpression(callee) || appMember(callee.name, this.t.checker)) return null;
		const r = this.receiver(callee.expression);
		if (!r || r.isStatic) return null;
		const m = lookupMember(r.module, r.name, callee.name.text, false);
		return m?.kind === 'method' ? m.returns : null;
	},

	/** The value an optional chain ending in a native member of Swift type `type` reads, as TypeScript types it. */
	chainEnd(this: NativeAPI, e: ts.PropertyAccessExpression, chained: string, type: SwiftType): string {
		const b = base(type);
		// A Swift collection TypeScript reads as its Foundation class (`Set<NSUserActivity>` as `NSSet`).
		const bridged = bridge(chained, optionalType(type), optionalType(this.t.typeOf(e).replace(/[?!]$/, '')));
		const code = bridged ?? (NUMBERS.has(b) && b !== 'Double' && b !== 'TimeInterval' && isNamed(spelledType(this.t.typeOf(e)), 'Double', false) ? `(${chained}).map { Double($0) }` : chained);
		// A link the chain continues past stays Swift's, apart from a Swift set read as `NSSet`, whose members the chain reads
		// are the class's (`allObjects`); the chain's value is a number as script reads it, still optional.
		if (this.keepOptional.has(e)) return ts.isPropertyAccessExpression(e.parent) && e.parent.expression === e ? (this.foundationSetLink(e, type) ? bridged! : chained) : code;
		const coalesced = ts.isBinaryExpression(e.parent) && e.parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && e.parent.left === e;
		const tsType = this.t.typeOf(e);
		if (coalesced || tsType.endsWith('?') || isUntyped(spelledType(tsType)) || onlyTested(e)) return code;
		if (this.t.lenient) {
			// Lenient code: where the chain stops, a string, number or boolean is what undefined converts to, and an object is
			// undefined, which an object declaration holds.
			if (['String', 'Double', 'Bool'].includes(tsType)) return this.t.undefinedAs(code, tsType);
			if (this.t.lenientRef(tsType) !== tsType) return this.t.marks.implicitOf(code);
			// An enum compared (`traits?.horizontalSizeClass === Compact`): Swift compares the optional, which nil equals no case of.
			if (this.isEnumType(b) && this.enumCompared(e)) return code;
		}
		return this.t.marks.unwrappedCode(`(${code})`);
	},

	/** A native member Swift has as a `Set<T>` that TypeScript reads as Foundation's `NSSet`. */
	foundationSetLink(this: NativeAPI, e: ts.PropertyAccessExpression, type: SwiftType): boolean {
		return /^Set<.+>$/.test(base(type)) && bridge('', optionalType(type), optionalType(this.t.typeOf(e).replace(/[?!]$/, ''))) !== null;
	},

	/** Whether `e` is compared for equality with a case of a native enum (`traits?.horizontalSizeClass === Compact`), not with a number. */
	enumCompared(this: NativeAPI, e: ts.Expression): boolean {
		let x: ts.Node = e;
		while (ts.isParenthesizedExpression(x.parent)) x = x.parent;
		const p = x.parent;
		if (!ts.isBinaryExpression(p) || ![ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind)) return false;
		const other = ts.skipOuterExpressions(p.left === x ? p.right : p.left, ts.OuterExpressionKinds.Parentheses);
		return ts.isPropertyAccessExpression(other) && !!this.enumMember(other);
	},

	/** What `read` translates `e` to, an optional chain's end read as the optional it is. */
	readOptional(this: NativeAPI, e: ts.Node, read: () => string): string {
		this.keepOptional.add(e);
		try {
			return read();
		} finally {
			this.keepOptional.delete(e);
		}
	},

	/**
	 * Foundation's collection methods on what Swift imports as its own
	 * collections (`NSArray` as `[T]`, `NSDictionary` as `[K: V]`).
	 */
	collectionMember(this: NativeAPI, target: ts.Expression, name: string, args: readonly ts.Expression[] | null, read: ts.Expression): string | null {
		const st = this.t.typeOf(target).replace(/\?$/, '');
		const isArray = /^\[[^:]*\]$/.test(st),
			isDict = /^\[.*:.*\]$/.test(st);
		if (!isArray && !isDict) return null;
		const recv = this.unwrapped(target);
		// An element of `NSArray<UIViewReservedRegion>`, which Swift has as `[Any]`: the native class the declaration names.
		const element = isArray ? this.type(this.t.checker.getNonNullableType(this.t.checker.getTypeAtLocation(read))) : null;
		const cls = element && /^[A-Za-z_][\w.]*$/.test(element) && !this.isEnumType(element) && !this.isStructType(element) ? element : null;
		const result = (code: string) => (cls ? this.t.marks.castCode(unboxed(this.t.marks, code), cls, 'as?') : code);
		// `xs?.count`: the chain's count, when there is one.
		const count = recv.endsWith('?') ? `(${recv}.count).map { Double($0) }` : `Double(${recv}.count)`;
		if (isArray) {
			// `xs?.count`: undefined, read as a number, where the array is missing.
			if (args === null && name === 'count') return recv.endsWith('?') ? `(${count} ?? .nan)` : count;
			if (args === null && name === 'firstObject') return result(this.t.marks.castCode(`${recv}.first`, 'Any', 'as'));
			if (args === null && name === 'lastObject') return result(this.t.marks.castCode(`${recv}.last`, 'Any', 'as'));
			if (args && name === 'objectAtIndex') return cls ? `(${recv}[Int(${this.t.expr(args[0])})] as! ${cls})` : this.t.marks.castCode(`${recv}[Int(${this.t.expr(args[0])})]`, 'Any', 'as');
			if (args && !args.length && name === 'mutableCopy') return `NSMutableArray(array: ${recv})`;
			// By Foundation's own lookup: isEqual:, and NSNotFound where the array lacks the object.
			if (args && name === 'indexOfObject' && args.length === 1 && !recv.endsWith('?')) return `Double((${recv} as NSArray).index(of: ${this.t.coerce(args[0], 'Any?')} as Any))`;
		}
		if (isDict) {
			if (args === null && name === 'count') return count;
			// Typed `[Any]`, as an element read from it (`allKeys.objectAtIndex(i) as Any?`) would otherwise make Swift infer the map's result optional.
			if (args === null && name === 'allKeys') return `(${recv}.keys.map { $0 as Any } as [Any])`;
			if (args && !args.length && name === 'mutableCopy') return `NSMutableDictionary(dictionary: ${recv})`;
			// An untyped key (one of `allKeys`) has no Swift key type: Foundation's own lookup by isEqual:, nil where the dictionary lacks it.
			if (args && name === 'objectForKey' && ['Any', 'Any?'].includes(this.t.typeOf(args[0]))) return `(${recv} as NSDictionary).object(forKey: ${this.t.coerce(args[0], 'Any?')} as Any)`;
			if (args && (name === 'objectForKey' || name === 'valueForKey')) return this.t.marks.castCode(`${recv}[${this.t.expr(args[0])}]`, 'Any', 'as');
		}
		return null;
	},

	enumMember(this: NativeAPI, e: ts.PropertyAccessExpression): string | null {
		const sym = this.t.resolve(e.expression);
		if (!sym || !(sym.flags & ts.SymbolFlags.Enum)) return null;
		const native = this.symbolModule(sym);
		if (!native) return null;
		const en = lookupEnum(native.module, native.name);
		const c = en?.cases[e.name.text];
		// An option set's zero member has no Swift case: it is the empty set.
		if (en && !c && en.kind === 'options' && this.t.checker.getConstantValue(e) === 0) return `${en.swift}([])`;
		// A C enum Swift imports as constants of no table (`qos_class_t.QOS_CLASS_DEFAULT`) where a number goes: its value, as the runtime gives it.
		const value = this.t.checker.getConstantValue(e);
		if (!en && typeof value === 'number' && (this.t.checker.getContextualType(e)?.flags ?? 0) & ts.TypeFlags.NumberLike) return `Double(${value})`;
		if (!en || !c) throw this.t.error(e, `${native.name}.${e.name.text} (no Swift counterpart)`, 'native');
		this.typeAvailable(en);
		if (!en.swift) return c.swift;
		return `${en.swift}.${c.swift}`;
	},
};
