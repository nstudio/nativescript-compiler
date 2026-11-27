// Components and closures as Swift: a component's or service's members, closure typing, memos and signal options.
import ts from 'typescript';
import type { PropValue } from './render.ts';
import { resultSlot } from '../semantics/placement.ts';
import type { ResultSlot } from '../semantics/placement.ts';
import { capturesThis, escapingParam, ident, isFunctionType, isMethodValue, isOptional, metatype, nullishType, optionalType, swiftString, withoutThenables, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { equalOption, isReadonlySignalProperty } from '../semantics/signals.ts';
import { isTemplateMethod } from '../semantics/trust.ts';
import { extendsHeritage, hasModifier, nonSuperStatements } from '../semantics/ast.ts';
import { nullableTypeNode, resultsAreUndefinedElements } from '../semantics/lang.ts';
import { implementedOptionalMembers } from '../semantics/shapes.ts';
import { isAsync, isStatic } from '../semantics/throws.ts';
import { isKit, isUntyped, spelledType } from '../semantics/types.ts';

export const componentMethods = {
	slotOf(this: Translator, fn: ts.ArrowFunction | ts.FunctionExpression): ts.Signature | undefined {
		const context = this.checker.getContextualType(fn);
		return context ? this.checker.getNonNullableType(context).getCallSignatures()[0] : undefined;
	},

	/** A closure literal's result slot in Swift: nothing where its slot returns void, else its own type. */
	closureResult(this: Translator, fn: ts.ArrowFunction | ts.FunctionExpression): ResultSlot {
		return resultSlot(this.closureReturn(fn), fn);
	},

	/** `closureResult`'s spelling. */
	closureReturn(this: Translator, fn: ts.ArrowFunction | ts.FunctionExpression): string {
		const slot = this.slotOf(fn);
		const voidSlot = !!slot && !!(slot.getReturnType().flags & ts.TypeFlags.Void) && !isAsync(fn);
		const own = this.returnTypeOf(fn);
		const slotType = slot && !voidSlot && !(slot.getReturnType().flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) ? this.type(slot.getReturnType(), fn) : null;
		// An async callback's promise of a literal is the promise its slot declares (`Promise<IteratorResult<T>>`).
		if (isAsync(fn)) return slotType && slotType !== own && /^JSPromise<Object_/.test(own) && isKit(spelledType(slotType), 'JSPromise') ? slotType : own;
		// A callback returning nothing where its slot takes any value or an optional (`TFunction | void`, `Subscription | void`) returns undefined.
		if (own === 'Void' && slotType && (isUntyped(spelledType(slotType)) || (isOptional(slotType) && !isKit(spelledType(slotType), 'JSPromise'))) && !voidSlot) return slotType;
		// Swift converts a `-> Void` closure into an `-> Any?` slot by boxing `()`, which is no JS value.
		if (own === 'Void' && slot && !voidSlot && slot.getReturnType().flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) && isUntyped(spelledType(this.type(slot.getReturnType(), fn)))) return 'Any?';
		// So does a callback returning nothing whose results are the elements of the array its call gives
		// (`map(() => undefined)`), since an array of undefined is held as an array of any value.
		if (own === 'Void' && slot && !isAsync(fn) && resultsAreUndefinedElements(fn, slot, this.checker)) return 'Any?';
		// A closure giving an untyped value where its slot says a type: the slot's type, its value read as that. Strict code's
		// promise handlers keep their own: `promiseMethod` spells their chain from it.
		if (!voidSlot && slotType && isUntyped(spelledType(own)) && slotType !== 'Void' && (this.lenient || withoutThenables(slot!.getReturnType()) === slot!.getReturnType())) return slotType;
		// A non-strict app's closure giving a value that may be missing (a native `string | null`) where its slot says the value: the slot's.
		const sd = slot?.getDeclaration();
		if (!voidSlot && slotType && this.lenientApp && !this.lenient && own === optionalType(slotType) && !(sd && !ts.isJSDocSignature(sd) && this.states.widenedResult(sd)) && !this.states.givesEmptyDefault(fn)) return slotType;
		// A closure returning a function where its slot takes any value (`TeardownLogic`, `any`) boxes the function.
		if (!voidSlot && isFunctionType(own) && slot && isUntyped(spelledType(this.type(slot.getReturnType(), fn)))) return 'Any?';
		// A closure returning a function where its slot takes another function type (fewer parameters): the slot's.
		if (!voidSlot && slotType && slotType !== own && isFunctionType(own) && isFunctionType(slotType)) return slotType;
		// A promise handler's slot (`TResult | PromiseLike<TResult>`) names no shape: the closure gives its own.
		const thenable = !!slot && withoutThenables(slot.getReturnType()) !== slot.getReturnType();
		if (voidSlot) return 'Void';
		// A class's object an object type reads by name (`ValueStates.viewedClass`), where the slot wants a shape: the slot's, a view of it.
		const viewed = !!slotType && slotType !== own && !thenable && this.isObjectShape(slotType.replace(/[?!]$/, '')) && !!this.classNamed(own) && this.states.viewedClass(this.classNamed(own)!);
		return (slotType && slotType !== own && /^Object_/.test(own) && !thenable) || viewed ? slotType! : own;
	},

	/** A closure literal's Swift function type, as `closure` writes it. */
	closureType(this: Translator, fn: ts.ArrowFunction | ts.FunctionExpression): string {
		const params = fn.parameters.filter((p) => !(ts.isIdentifier(p.name) && p.name.text === 'this'));
		const own = params.map((p) => escapingParam(p.questionToken || this.states.mayBeNull(p) || nullableTypeNode(p.type) ? optionalType(this.typeOf(p.name)) : this.typeOf(p.name)));
		if (this.takesRestArray(fn)) return `(JSArray<Any?>) throws -> ${this.closureResult(fn).target}`;
		return `(${[...own, ...(this.library && ts.isFunctionExpression(fn) && (isMethodValue(fn) || this.readsArguments(fn)) ? [] : this.unusedParameters(fn))].join(', ')}) throws -> ${this.closureResult(fn).target}`;
	},

	/** A callback for an API that does not take throwing closures (a timer): what it throws is reported. */
	callback(this: Translator, e: ts.Expression): string {
		if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
			const code = this.closure(e);
			// An async callback's promise is dropped; its rejection is the promise's.
			if (isAsync(e)) return `{ _ = (${code})() }`;
			return this.throwsInfo.fn(e) ? `{ ${RT.jsReport}(${code}) }` : code;
		}
		// A Promise executor's resolve passed as the callback (`setTimeout(resolve, ms)`) resolves with undefined.
		const resolvers = ts.isIdentifier(e) ? this.resolvers.get(this.resolve(e)!) : undefined;
		if (resolvers) return resolvers.type === 'Void' ? `{ ${resolvers.name}.resolve() }` : `{ ${resolvers.name}.resolve(${this.zero(resolvers.type) ?? 'nil'}) }`;
		// A function value is called with nothing, as the timer calls it: each parameter undefined.
		const sig = this.checker.getTypeAtLocation(e).getCallSignatures()[0];
		const pads = (sig?.getParameters() ?? []).map((p) => (this.type(this.checker.getTypeOfSymbolAtLocation(p, e), e) === 'Void' ? '()' : 'nil'));
		return `{ ${RT.jsReport} { try ${this.expr(e)}(${pads.join(', ')}) } }`;
	},

	// ---- Classes -------------------------------------------------------------------------------

	/** The value a component's or service's constructor parameter is given: the framework's (an injected service), else its default. */
	constructorParameter(this: Translator, p: ts.ParameterDeclaration): string {
		const given = this.framework.hooks.constructorParameter?.(this, p);
		if (given !== undefined) return given;
		const pt = this.typeOf(p.name);
		if (p.initializer) return `${this.marks.tryBefore(this.tryPrefix(p.initializer), this.stored(p.initializer, p, pt))}`;
		return isOptional(pt) || pt.endsWith('!') || isUntyped(spelledType(pt)) ? 'nil' : this.fromAny('nil', pt);
	},

	/** The class's members; the caller adds `render()`. Returns the Swift lines inside the class. */
	componentMembers(this: Translator, cls: ts.ClassDeclaration, props: string[], plainFields?: boolean): string[] {
		if (plainFields === undefined) plainFields = this.plainFields;
		this.props = new Set(props);
		this.computed = new Set(cls.members.filter((m) => ts.isPropertyDeclaration(m) && !!this.framework.memoized(m, this.checker)).map((m) => (m.name as ts.Identifier).text));
		this.signalFields = new Set(cls.members.filter((m) => ts.isPropertyDeclaration(m) && m.initializer && this.framework.heldSignal(this.calleeName(m.initializer))).map((m) => (m.name as ts.Identifier).text));
		const lines: string[] = [];
		const inits: string[] = [];
		const propParams: string[] = [];
		let late = false;
		this.indent = '    ';
		const ctor = cls.members.find((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m) && !!m.body);
		const ctorInjectVals: string[] = [];
		let convenienceZeroArg = false,
			fieldThrows = false;
		if (ctor?.parameters.length && !props.length) {
			const vals = ctor.parameters.map((p) => this.constructorParameter(p));
			const anyThrows = ctor.parameters.some((p) => this.throwsInfo.injects(p));
			convenienceZeroArg = anyThrows;
			ctor.parameters.forEach((p, idx) => {
				const pName = (p.name as ts.Identifier).text;
				const pt = this.typeOf(p.name);
				const paramType = isFunctionType(pt) ? `@escaping ${pt}` : pt;
				const val = vals[idx];
				ctorInjectVals.push(val);
				propParams.push(`_ ${ident(pName)}: ${paramType}${anyThrows ? '' : ` = ${val}`}`);
				const isParamProp = (ts.getModifiers(p) ?? []).some((mod) => mod.kind === ts.SyntaxKind.PrivateKeyword || mod.kind === ts.SyntaxKind.ProtectedKeyword || mod.kind === ts.SyntaxKind.PublicKeyword || mod.kind === ts.SyntaxKind.ReadonlyKeyword);
				if (isParamProp) {
					const reassigned = !hasModifier(p, ts.SyntaxKind.ReadonlyKeyword) && this.isAssigned(cls, pName);
					lines.push(`    ${reassigned ? 'var' : 'let'} ${ident(pName)}: ${pt}`);
					inits.push(`        self.${ident(pName)} = ${ident(pName)}`);
				}
			});
		}
		const seenAccessors = new Set<string>();
		for (const m of cls.members) {
			if (ts.isPropertyDeclaration(m) && isStatic(m)) {
				// A static field of a component or service (`static readonly PILL_HEIGHT = 44`): the class's.
				const name = (m.name as ts.Identifier).text;
				const t = this.typeOf(m.name);
				lines.push(m.initializer ? `    static ${hasModifier(m, ts.SyntaxKind.ReadonlyKeyword) ? 'let' : 'var'} ${ident(name)}: ${t} = ${this.storedInit(m.initializer, t, false, m)}` : `    static var ${ident(name)}: ${this.deferred(t)}`);
				continue;
			}
			if (ts.isPropertyDeclaration(m)) {
				const name = (m.name as ts.Identifier).text;
				if (this.states.nullishHeld(m)) {
					const held = nullishType(this.typeOf(m.name));
					lines.push(`    var ${ident(name)}: ${held} = nil`);
					if (m.initializer) {
						this.indent = '        ';
						if (this.throwsInfo.expr(m.initializer)) fieldThrows = true;
						inits.push(`        self.${ident(name)} = ${this.marks.tryBefore(this.tryPrefix(m.initializer), this.stored(m.initializer, m, held))}`);
						this.indent = '    ';
					}
					continue;
				}
				const callee = m.initializer ? this.calleeName(m.initializer) : '';
				const field = this.framework.hooks.componentField?.(this, m, name);
				if (field && 'prop' in field) {
					// A prop the framework's call declares: a signal the parent writes.
					const { type: t, default: given } = field.prop;
					lines.push(`    let ${ident(name)}: Signal<${t}>`);
					const unset = this.framework.unsetError(m, given);
					if (unset !== undefined) {
						inits.push(`        self.${ident(name)} = ${this.newSignal(t, `unset: ${swiftString(unset)}`, 'identity')}`);
						continue;
					}
					propParams.push(`${ident(name)}: ${t}${given === undefined ? '' : ` = ${given}`}`);
					inits.push(`        self.${ident(name)} = ${this.newSignal(t, ident(name), 'identity')}`);
					continue;
				}
				if (field && 'lines' in field) {
					lines.push(...field.lines);
					continue;
				}
				// `signal.asReadonly()`: a field reading the signal it wraps.
				if (/\.asReadonly$/.test(callee) && ts.isPropertyAccessExpression((m.initializer as ts.CallExpression).expression)) {
					const source = ((m.initializer as ts.CallExpression).expression as ts.PropertyAccessExpression).expression;
					lines.push(`    var ${ident(name)}: ${this.typeOf(m.name).replace(/^Signal<(.*)>$/, '$1')} { ${this.expr(source)}.value }`);
					continue;
				}
				if (this.framework.memoized(m, this.checker)) {
					lines.push(...this.memoField(m, name));
					continue;
				}
				const held = this.moduleComputedField(m);
				if (held) {
					lines.push(held);
					continue;
				}
				const raw = this.typeOf(m.name);
				const t = this.signalFields.has(name) && !raw.startsWith('Signal<') ? `Signal<${raw}>` : raw;
				if (name === '$passed') {
					// The props the parent gave, for a spread that passes on only those.
					lines.push(`    let _passed: Set<String>`);
					propParams.push(`_passed: Set<String> = []`);
					inits.push(`        self._passed = _passed`);
					continue;
				}
				// A field without an initializer is a field like any other where the framework declares props otherwise.
				if (!m.initializer && plainFields && !this.props.has(name)) {
					lines.push(`    var ${ident(name)}: ${this.deferred(t)}`);
					continue;
				}
				if (!m.initializer) {
					lines.push(`    let ${ident(name)}: Signal<${t}>`);
					// A callback prop is kept in its signal, so it outlives the initializer; a prop the parent may leave out is undefined.
					propParams.push(`${ident(name)}: ${isFunctionType(t) ? '@escaping ' : ''}${t}${m.questionToken && t.endsWith('?') ? ' = nil' : ''}`);
					inits.push(`        self.${ident(name)} = ${this.newSignal(t, ident(name), 'identity')}`);
					continue;
				}
				// A field the class assigns after construction (a script's `let`) is a Swift `var`.
				const reassigned = !hasModifier(m, ts.SyntaxKind.ReadonlyKeyword) && this.isAssigned(cls, name);
				// Swift lets a closure capture self, or a method run, only once every stored property has a
				// value: from the first initializer that needs `this` so, fields start nil.
				late ||= capturesThis(m.initializer);
				if (late) lines.push(`    var ${ident(name)}: ${isFunctionType(t) ? `(${t})!` : t.endsWith('?') ? t : `${t}!`}`);
				else lines.push(`    ${reassigned ? 'var' : 'let'} ${ident(name)}: ${t}`);
				this.indent = '        ';
				if (this.throwsInfo.expr(m.initializer)) fieldThrows = true;
				inits.push(`        self.${ident(name)} = ${this.marks.tryBefore(this.tryPrefix(m.initializer), this.stored(m.initializer, m, t))}`);
				this.indent = '    ';
				continue;
			}
			if (ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) {
				const aName = (m.name as ts.Identifier).text;
				const key = `${isStatic(m) ? 'static:' : ''}${aName}`;
				if (seenAccessors.has(key)) continue;
				seenAccessors.add(key);
				const get = cls.members.find((x): x is ts.GetAccessorDeclaration => ts.isGetAccessorDeclaration(x) && x.name.getText() === aName && isStatic(x) === isStatic(m));
				const set = cls.members.find((x): x is ts.SetAccessorDeclaration => ts.isSetAccessorDeclaration(x) && x.name.getText() === aName && isStatic(x) === isStatic(m));
				const sMod = isStatic(m) ? 'static ' : '';
				if (get && !set) {
					const t = this.returnTypeOf(get);
					const throws = this.throwsInfo.fn(get);
					const body = this.functionBody(get, t, '        ');
					lines.push(throws ? `    ${sMod}var ${ident(aName)}: ${t} {\n        get throws ${body}\n    }` : `    ${sMod}var ${ident(aName)}: ${t} ${this.functionBody(get, t, '    ')}`);
				} else if (set) {
					const t = get ? this.returnTypeOf(get) : this.typeOf(set.parameters[0].name);
					const fallback = isOptional(t) || t.endsWith('!') || isUntyped(spelledType(t)) ? 'nil' : (this.zero(t) ?? `${RT.jsNativeZero}(${metatype(t)})`);
					const getPart = get ? (this.throwsInfo.fn(get) ? `        get { ${RT.jsReported} { () throws -> ${t} in${this.functionBody(get, t, '        ').slice(1)} ?? ${fallback} }` : `        get ${this.functionBody(get, t, '        ')}`) : `        get { ${fallback} }`;
					const p = set.parameters[0].name as ts.Identifier;
					const body = this.functionBody(set, 'Void', '        ');
					const own = this.typeOf(p);
					const bound = !this.isRead(p) ? '' : get && own !== t && own.replace(/[?!]$/, '') !== t.replace(/[?!]$/, '') ? `            let ${ident(p.text)}: ${own} = ${this.convert('newValue', t.replace(/!$/, '?'), own)}\n` : `            let ${ident(p.text)} = newValue\n`;
					const setPart = this.throwsInfo.fn(set) ? `        set {\n${bound}            ${RT.jsReport} ${body.trimStart()}\n        }` : `        set {\n${bound}            do ${body.trimStart()}\n        }`;
					lines.push(`    ${sMod}var ${ident(aName)}: ${t} {`, getPart, setPart, '    }');
				}
				continue;
			}
			if (ts.isMethodDeclaration(m)) {
				// An overload's signature: Swift's one method is the implementation's.
				if (!m.body) continue;
				this.templateParams = isTemplateMethod(m);
				try {
					lines.push('    ' + this.func(m, ident((m.name as ts.Identifier).text), isStatic(m) ? 'static ' : ''));
				} finally {
					this.templateParams = false;
				}
				continue;
			}
		}
		for (const m of implementedOptionalMembers(cls, this.checker)) {
			const t = optionalType(this.typeOf(m));
			this.declare(m.name.text, { kind: 'var', type: t });
			lines.push(`    var ${ident(m.name.text)}: ${t}`);
		}
		// If the component keeps a real superclass (e.g. `@Component extends @Directive`), chain `super.init()` before constructor body.
		const baseCls = this.sourceBase(cls);
		const baseThrows = !!baseCls && this.throwsInfo.initThrows(baseCls);
		if (baseCls) {
			inits.push(`        ${baseThrows ? 'try ' : ''}super.init()`);
		}
		// The constructor's body runs once every field is set; what it throws is reported, as a failed creation is.
		const bodyStmts = nonSuperStatements(ctor);
		if (bodyStmts.length) {
			this.indent = '            ';
			const body = this.statements([...bodyStmts]);
			inits.push(`        ${this.throwsInfo.statements(bodyStmts) ? RT.jsReport : 'do'} {\n${body.join('\n')}\n        }`);
		}
		this.indent = '';
		const throws = convenienceZeroArg || fieldThrows || baseThrows ? ' throws' : '';
		if (throws && cls.name) this.throwingInits.add(cls.name.text);
		const overrideInit = !!baseCls && !propParams.length ? 'override ' : '';
		lines.push(`    ${overrideInit}init(${propParams.join(', ')})${throws} {`, ...inits, '    }');
		if (convenienceZeroArg) {
			lines.push(`    convenience init() throws {\n        try self.init(${ctorInjectVals.join(', ')})\n    }`);
		}
		return lines;
	},

	/** The Swift superclass clause (`: Base<...>`) for a component that keeps a real superclass, else empty. */
	componentSuperclass(this: Translator, cls: ts.ClassDeclaration): string {
		const heritage = extendsHeritage(cls);
		const appBase = this.sourceBase(cls);
		if (!heritage || !appBase) return '';
		return `: ${this.className(appBase)}${this.typeArguments(heritage, appBase)}`;
	},

	/** Static members a component class adds for the framework. */
	componentStatics(this: Translator, cls: ts.ClassDeclaration): string[] {
		return this.framework.hooks.componentStatics?.(this, cls) ?? [];
	},

	/** What a component's method returning an array (a loop's items) holds, as Swift spells it. */
	memberElementType(this: Translator, cls: ts.ClassDeclaration, name: string): string | null {
		const m = cls.members.find((x): x is ts.MethodDeclaration => ts.isMethodDeclaration(x) && ts.isIdentifier(x.name) && x.name.text === name);
		if (!m) return null;
		const t = this.returnTypeOf(m);
		return isUntyped(spelledType(t)) ? t : (/^JSArray<(.*)>\??$/.exec(t)?.[1] ?? null);
	},

	/** A child component's input held as `JSNullish<T>`: a binding's value (its method's result, or a static attribute's text) converted to it. */
	propValue(this: Translator, cls: ts.ClassDeclaration, child: ts.ClassDeclaration | undefined, prop: string, method: string | null): PropValue | null {
		const field = child?.members.find((m): m is ts.PropertyDeclaration => ts.isPropertyDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === prop);
		const to = field && /^Signal<(JSNullish<.*>)>$/.exec(this.typeOf(field.name))?.[1];
		if (!to) return null;
		const m = method === null ? undefined : cls.members.find((x): x is ts.MethodDeclaration => ts.isMethodDeclaration(x) && ts.isIdentifier(x.name) && x.name.text === method);
		const from = method === null ? 'String' : m ? this.returnTypeOf(m) : 'Any?';
		if (from === to) return null;
		if (isUntyped(spelledType(from))) return { convert: (v) => `try ${to}(any: ${v})`, throws: true };
		return { convert: (v) => `${to}(${v})`, throws: false };
	},

	/** Whether a component's method or getter throws, so its caller in `render()` reports what it throws. */
	memberThrows(this: Translator, cls: ts.ClassDeclaration, name: string): boolean {
		for (let cur: ts.ClassLikeDeclaration | undefined = cls; cur; cur = this.sourceBase(cur)) {
			const m = cur.members.find((x) => x.name && ts.isIdentifier(x.name) && x.name.text === name);
			if (m) return !isAsync(m) && this.throwsInfo.fn(m);
		}
		return false;
	},

	/** The memo call (`computed(fn)`) a module-level variable an identifier names is initialized with. */
	moduleComputed(this: Translator, id: ts.Identifier): ts.CallExpression | undefined {
		const d = this.resolve(id)?.valueDeclaration;
		if (!d || !ts.isVariableDeclaration(d) || !d.initializer || !this.framework.memoCall(d.initializer, this.checker)) return undefined;
		const fn = d.initializer.arguments[0];
		return ts.isSourceFile(d.parent.parent.parent) && fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ? d.initializer : undefined;
	},

	/** A field holding a module's memo (`readonly color = ink`) is that memo: its value whenever read. */
	moduleComputedField(this: Translator, m: ts.PropertyDeclaration): string | undefined {
		const held = m.initializer && ts.isIdentifier(m.initializer) ? this.moduleComputed(m.initializer) : undefined;
		if (!held) return undefined;
		const read = this.expr(m.initializer!),
			name = ident((m.name as ts.Identifier).text);
		const t = this.computedType(held);
		return this.throwsInfo.fn(held.arguments[0] as ts.ArrowFunction) ? `    var ${name}: ${t} {\n        get throws { try ${read} }\n    }` : `    var ${name}: ${t} { ${read} }`;
	},

	/** Whether a `Signal<T>` node is lowered as a Swift computed property (`var x: T`) rather than a `Signal<T>` instance. */
	isSwiftComputedProperty(this: Translator, n: ts.Node): boolean {
		if (ts.isIdentifier(n) && this.moduleComputed(n)) return true;
		const decl = ts.isIdentifier(n) || ts.isPropertyAccessExpression(n) ? this.resolve(n)?.valueDeclaration : n;
		if (!decl) return false;
		if (ts.isVariableDeclaration(decl) && ts.isSourceFile(decl.parent.parent.parent) && this.framework.memoCall(decl.initializer, this.checker)) {
			const fn = decl.initializer.arguments[0];
			return !!fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn));
		}
		if (ts.isPropertyDeclaration(decl) && ts.isClassDeclaration(decl.parent) && !this.pluginFiles.has(decl.getSourceFile().fileName) && decl.initializer) {
			const callee = this.calleeName(decl.initializer);
			if (isReadonlySignalProperty(decl, this.checker, this.framework, callee) || (ts.isIdentifier(decl.initializer) && !!this.moduleComputed(decl.initializer))) return true;
		}
		return false;
	},

	/** A memo of `fn` (`computed(fn)`) as a `Memo<rt>`: a recomputed result Object.is the kept one keeps it. */
	memo(this: Translator, fn: ts.ArrowFunction | ts.FunctionExpression, rt: string, throws: boolean, ofInstance = false): string {
		const body = this.functionBody(fn, rt, '');
		// The instance holds its memo: the memo's function must not hold the instance.
		const closure = `{ ${ofInstance ? '[unowned self] ' : ''}() ${throws ? 'throws ' : ''}-> ${rt} in${body.slice(1)}`;
		const value = ['Double', 'String', 'Bool'].includes(rt.replace(/\?$/, ''));
		const equals = ts.isCallExpression(fn.parent) && fn.parent.arguments[0] === fn ? this.equalsArg(fn.parent.arguments[1], rt, true) : undefined;
		return `Memo<${rt}>(${closure}${equals ?? (value ? '' : isFunctionType(rt) ? '' : `, equals: { ${RT.jsSame}($0, $1) }`)})`;
	},

	/**
	 * `, equals: …` for the `equal` a signal's options give (read from them by name when they are not a literal),
	 * or undefined when a literal gives none. A memo (`throwing`) keeps what `equal` throws as its value; a signal's writes
	 * throw it only where `equal` may throw (`Throws.signalWriteThrows`), so elsewhere a throw is reported and the values
	 * taken as unequal.
	 */
	equalsArg(this: Translator, options: ts.Expression | undefined, t: string, throwing = false): string | undefined {
		const { equal, opaque } = equalOption(options);
		if (!equal && !opaque) return undefined;
		const base = t.replace(/\?$/, '');
		const fallback = ['Double', 'String', 'Bool'].includes(base) ? 'a == b' : isFunctionType(t) ? 'false' : `${RT.jsSame}(a, b)`;
		const fn = opaque ? `${RT.jsEqualOption}(${this.coerce(opaque, 'Any?')}, default: { (a: ${t}, b: ${t}) -> Bool in ${fallback} })` : `(${this.expr(equal!)})`;
		const thrower = opaque ? fn : `{ (a: ${t}, b: ${t}) throws -> Bool in try ${fn}(a, b) }`;
		const mayThrow = equal ? this.throwsInfo.equalThrows(equal) : !!this.checker.getNonNullableType(this.checker.getTypeAtLocation(opaque!)).getProperty('equal');
		return `, equals: ${throwing || mayThrow ? thrower : `${RT.jsReportingEquals}(${thrower})`}`;
	},
};
