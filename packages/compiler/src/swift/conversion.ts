// Conversions between Swift representations: object classes, casts, boxing, key plans.
import ts from 'typescript';
import { escapingFunction, escapingParam, functionParts, ident, isOptional, optionalType, scriptLength, splitTopLevel, swiftString, unwrapFunction, RT, type FunctionParts } from './syntax.ts';
import type { Translator } from './translator.ts';
import { keyedClass, notedField } from '../semantics/shapes.ts';
import { plan, structural, type Value } from '../semantics/conversion.ts';
import { isNamed, isUntyped, parseNativeType, spelledType } from '../semantics/types.ts';
import { accessedDeclaration } from '../semantics/lang.ts';
import { hasModifier } from '../semantics/ast.ts';
import { isCoreDeclaration } from '../program/core-facts.ts';
import { isStatic } from '../semantics/throws.ts';
import { typedCollection } from './native/bridging.ts';
import { rethrowUnlessRefused } from '../semantics/refusals.ts';
import { observers } from '../semantics/observers.ts';

export const conversionMethods = {
	/**
	 * `obj.field = untyped` (app code) on an object of the program's or core's classes: written by name
	 * (`jsSet`), as JavaScript's write is, so a core property's setter converts what it takes (a color's
	 * string) and a typed field refuses a value of another type with a TypeError.
	 */
	untypedWrite(this: Translator, left: ts.Expression, right: ts.Expression): boolean {
		if (this.lenient || this.library || !ts.isPropertyAccessExpression(left) || left.questionDotToken) return false;
		if (notedField(this.states, left)) return true;
		if (this.checkedPlacementEntry(right)) return false;
		try {
			if (!this.isAny(right) || this.isAny(left) || this.isAny(left.expression)) return false;
		} catch (e) {
			rethrowUnlessRefused(e);
			return false;
		}
		const decl = accessedDeclaration(this.resolve(left.name), true);
		if (!decl || !(ts.isPropertyDeclaration(decl) || ts.isPropertySignature(decl) || ts.isSetAccessorDeclaration(decl) || ts.isGetAccessorDeclaration(decl))) return false;
		if (!ts.isClassLike(decl.parent) || isStatic(decl) || left.expression.kind === ts.SyntaxKind.SuperKeyword) return false;
		if (decl.getSourceFile().isDeclarationFile) return isCoreDeclaration(decl);
		// A component's class has no members by name: its fields are written typed.
		if (ts.isClassDeclaration(decl.parent) && this.isComponentClass(decl.parent)) return false;
		// Nor has a service's or a native subclass's: its fields are. An accessor typed without the null a non-strict app
		// gives it can't be written typed.
		return !ts.isPropertyDeclaration(decl) || keyedClass(decl.parent, this.states, this.shapeFacts());
	},

	isComponentClass(this: Translator, cls: ts.ClassDeclaration): boolean {
		return this.framework.componentClass(cls) || (!!cls.name && this.components.has(cls.name.text));
	},

	/** Lenient code: a setter without a getter given undefined runs with it, as the type's zero for a primitive. */
	setterOnlyValue(this: Translator, p: ts.Identifier, optional: string): string {
		const base = optional.replace(/\?$/, '');
		const zero = ['String', 'Double', 'Bool'].includes(base) ? this.zero(base) : null;
		return zero !== null ? `let ${ident(p.text)}: ${base} = newValue ?? ${zero}` : this.lenientRef(base) !== base ? `let ${ident(p.text)}: ${this.lenientRef(base)} = newValue` : `let ${ident(p.text)} = newValue!`;
	},

	/** A class the program declares that `new T()` makes, not a native subclass: whether making one throws; null for any other type. */
	plainClass(this: Translator, type: string): { throws: boolean } | null {
		if (!/^[A-Z]\w*$/.test(type)) return null;
		const cls = this.classNamed(type);
		// A class of data alone: no base, so making one has no effects.
		if (!cls || !ts.isClassDeclaration(cls) || cls.typeParameters?.length || hasModifier(cls, ts.SyntaxKind.AbstractKeyword) || cls.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword)) return null;
		for (let c: ts.ClassLikeDeclaration | undefined = cls; c; c = this.sourceBase(c)) {
			const ctor = c.members.find((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m) && !!m.body);
			if (ctor) {
				if (ctor.parameters.some((p) => !p.questionToken && !p.initializer)) return null;
				break;
			}
		}
		return { throws: this.initThrows(type) || this.throwsInfo.initThrows(cls) };
	},

	/** A typed function value as an untyped JavaScript function, callable through `jsCall`, its `name` and `length` script's to read. */
	boxFunction(this: Translator, code: string, type: string, restAt = -1, name = '', length?: number, trailing?: { ref: string; from: number }, nullable?: boolean): string {
		if (nullable === undefined) nullable = this.lenient;
		// Already a script function (a built-in placed untyped, which counts its arguments).
		if (/^jsFunction\("\w+", \d+\) \{ a in [^{}]*\}$/.test(code)) return code;
		let fn = functionParts(isOptional(type) ? type.replace(/\?$/, '').replace(/^\((.*)\)$/, '$1') : type)!;
		if (restAt < 0) restAt = fn.rest;
		// Lenient code: the function's own declaration may give undefined for an object.
		if (this.lenientRef(fn.result) !== fn.result) fn = functionParts(`(${fn.params.join(', ')}) throws -> ${optionalType(fn.result)}`)!;
		// Inside the `try` of the call: an argument of a type the parameter cannot hold is a TypeError.
		const args = fn.params.map((p, k) => (k === restAt ? `${p}(__a.dropFirst(${k}).map { ${this.fromAnyCode('$0', p.replace(/^JSArray<(.*)>$/, '$1'), true)} })` : this.throwingConverts(() => this.presentFromAny(`${RT.jsArg}(__a, ${k})`, p.replace(/^@escaping /, ''), true, true))));
		const result = (call: string) => (fn.result === 'Void' ? `${call}; return nil` : `return ${this.convert(call, fn.result, 'Any?')}`);
		// Called with fewer arguments, a function whose last parameters have defaults is called by name, which gives them.
		const fewer = trailing
			? Array.from({ length: fn.params.length - trailing.from }, (_, k) => trailing.from + k)
					.map((n) => `if __a.count <= ${n} { ${result(this.marks.tryCode(`${trailing.ref}(${args.slice(0, n).join(', ')})`))} }; `)
					.join('')
			: '';
		const body = fewer + result(this.marks.tryCode(`__f(${args.join(', ')})`));
		const arity = length ?? (restAt >= 0 ? restAt : fn.params.length);
		const cell = this.functionCell(fn.text);
		// One conversion per function type, written once on its cell; a call with defaults filled by name stays inline.
		// A function value that may be undefined (lenient code's, an optional) stays undefined.
		if (cell && !trailing) return `${cell}.${this.cellStatic(cell, 'script', `${RT.jsBoxedFunction}(Self(f: __f)) { ${RT.jsFunction}(name, length) { (__a: [Any?]) throws -> Any? in ${body} } }`)}${nullable ? 'OrNil' : ''}(${swiftString(name)}, ${arity}, ${code})`;
		const make = `${RT.jsFunction}(${swiftString(name)}, ${arity}) { (__a: [Any?]) throws -> Any? in ${body} }`;
		const box = `{ (__f: @escaping ${fn.text}) -> JSFunctionObject in ${cell ? `${RT.jsBoxedFunction}(${cell}(f: __f)) { ${make} }` : make} }`;
		// `if let`, not `Optional.map`: a closure passed through a generic is a new thunk, another function to `===`.
		return nullable ? `{ (__g: (${fn.text})?) -> JSFunctionObject? in if let __g { return ${box}(__g) } else { return nil } }(${code})` : `${box}(${code})`;
	},

	/** A function the program declares, held untyped: a function object of its name and `length`. */
	boxDeclared(this: Translator, ref: string, decl: ts.FunctionDeclaration): string {
		const t = this.boxedGeneric(decl, escapingFunction(functionParts(this.functionValueType(decl))!));
		const from = decl.parameters.findIndex((p) => p.initializer);
		const byName = from >= 0 && !decl.typeParameters?.length && decl.parameters.slice(from).every((p) => p.initializer && !p.dotDotDotToken) && splitTopLevel(this.params(decl, false)).every((p) => p.trim().startsWith('_ '));
		// Called by name with fewer arguments: the function itself, not its value (`declaredValue`).
		const rawNamed = /^FunctionCell_\w+\.(?:declared\w*\("[^"]*"|local\w*\(\w+), (.*)\)$/s.exec(ref)?.[1] ?? ref;
		const named = /^\{ (?:try )?([\w.`]+)\([^)]*\) \}$/.exec(rawNamed)?.[1] ?? rawNamed;
		const restAt = this.readsArguments(decl) ? 0 : decl.parameters.findIndex((p) => p.dotDotDotToken);
		return this.boxFunction(ref, t, restAt, decl.name?.text ?? '', scriptLength(decl), byName ? { ref: named, from } : undefined, false);
	},

	/** An untyped function value called as the typed function `fn`. */
	unboxFunction(this: Translator, code: string, fn: FunctionParts, orNil = false): string {
		const params = fn.params.map((p, k) => `__p${k}: ${p}`);
		const arg = (p: string, k: number) => this.convert(`__p${k}`, p.replace(/^@escaping /, ''), 'Any?');
		const call = fn.rest >= 0 ? this.marks.tryCode(`${RT.jsCall}(__f, spread: [${fn.params.slice(0, fn.rest).map(arg).join(', ')}] + __p${fn.rest}.storage.map { $0 as Any? })`) : this.marks.tryCode(`${RT.jsCall}(__f${fn.params.map((p, k) => `, ${arg(p, k)}`).join('')})`);
		const body = fn.result === 'Void' ? `_ = ${call}` : `return ${this.presentFromAny(call, fn.result, true, true)}`;
		const cell = this.functionCell(fn.text);
		const made = `{ (${params.join(', ')}) throws -> ${fn.result} in ${cell ? this.keeping('__i', body, fn.result) : body} }`;
		// A closure of exactly this type passes through as it is.
		if (!cell) return `{ (__f: Any?) -> ${fn.text} in (${RT.jsFlat}(__f) as? ${fn.text}) ?? ${made} }(${code})`;
		const name = this.cellStatic(cell, 'fromScript', `if let __t = ${RT.jsFlat}(__f) as? ${fn.text} { return __t }; let __i = JSFunctionAlias(of: __f); return ${RT.jsIdentified}(Self(f: ${made}), __i).f`);
		return orNil ? this.marks.implicitOf(code, cell, `${name}OrNil`) : `${cell}.${name}(${code})`;
	},

	/** The function declaration `e` reads as a value (not called, not a receiver), when the read is one value (see `declaredValue`). */
	declaredFunctionRead(this: Translator, e: ts.Identifier): ts.FunctionDeclaration | null {
		if (this.namedCall) return null;
		const p = e.parent;
		if ((ts.isCallExpression(p) || ts.isNewExpression(p) || ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === e) return null;
		if (ts.isTypeOfExpression(p) || (ts.isTaggedTemplateExpression(p) && p.tag === e) || ts.isDecorator(p)) return null;
		const decl = this.resolve(e)?.declarations?.find((d): d is ts.FunctionDeclaration => ts.isFunctionDeclaration(d) && !!d.body);
		if (!decl?.name || decl.getSourceFile().isDeclarationFile || decl.typeParameters?.length || decl.asteriskToken || this.takesThis(decl)) return null;
		// Given to the language's or a platform's API (`list.map(f)`, which rethrows what `f` may throw), which never compares it: as it is.
		if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.includes(e)) {
			const callee = this.checker.getResolvedSignature(p)?.getDeclaration();
			if (callee && callee.getSourceFile().isDeclarationFile && !isCoreDeclaration(callee)) return null;
		}
		return decl;
	},

	/** The locals `statements` declares before `fns`, for those read as values: one function per run of their scope, as JavaScript's. */
	localDeclarationsOf(this: Translator, fns: ts.FunctionDeclaration[]): string[] {
		return fns.flatMap((fn) => {
			if (!fn.name || !fn.body || ts.isSourceFile(fn.parent) || ts.isModuleBlock(fn.parent)) return [];
			let read = false;
			const visit = (n: ts.Node): void => {
				if (read) return;
				if (ts.isIdentifier(n) && n.text === fn.name!.text && n !== fn.name && this.declaredFunctionRead(n) === fn) {
					read = true;
					return;
				}
				ts.forEachChild(n, visit);
			};
			visit(fn.parent);
			if (!read || !this.functionCell(escapingFunction(functionParts(this.functionValueType(fn))!))) return [];
			const name = ident(`__${fn.name.text}Declaration`);
			this.localDeclarations.set(fn, name);
			return [`${this.indent}let ${name} = JSFunctionDeclaration()`];
		});
	},

	/**
	 * A function declaration read as a value: the same function at every read. Swift makes a new closure at each
	 * read of a function, so a module's function is its first closure, kept by name, and a nested one stands for the
	 * declaration's local of the current run of its scope.
	 */
	declaredValue(this: Translator, ref: string, decl: ts.FunctionDeclaration): string {
		const type = escapingFunction(functionParts(this.functionValueType(decl))!);
		const cell = this.functionCell(type);
		if (!cell) return ref;
		const local = this.localDeclarations.get(decl);
		if (local) {
			const fn = functionParts(type)!;
			const params = fn.params.map((p, k) => `__p${k}: ${escapingParam(p)}`);
			const call = this.marks.tryCode(`__h(${fn.params.map((_, k) => `__p${k}`).join(', ')})`);
			const closure = `{ (${params.join(', ')}) throws -> ${fn.result} in ${this.keeping('__i', fn.result === 'Void' ? call : `return ${call}`, fn.result)} }`;
			return `${cell}.${this.cellStatic(cell, 'local', `let __i = JSFunctionAlias(declaration: __d); return ${RT.jsIdentified}(Self(f: ${closure}), __i).f`)}(${local}, ${ref})`;
		}
		if (!ts.isSourceFile(decl.parent) && !ts.isModuleBlock(decl.parent)) return ref;
		// Named by its Swift path, which is the program's one function of that name.
		const id = (this.appModule && ref.startsWith(`${this.appModule}.`) ? ref.slice(this.appModule.length + 1) : ref).replace(/`/g, '');
		if (!this.functionDepth) this.isolatedInit = true;
		// Wrap top-level `func` in a forwarding closure so Swift 6 `@MainActor @Sendable` function values convert cleanly to non-isolated closure types.
		const fn = functionParts(type)!;
		const fwdArgs = fn.params.map((_, k) => `$${k}`).join(', ');
		const fwd = `{ ${this.throwsInfo.fn(decl) ? 'try ' : ''}${ref}(${fwdArgs}) }`;
		return `${cell}.${this.cellStatic(cell, 'declared', `${RT.jsDeclaredFunction}(id, Self(f: __h)).f`)}(${swiftString(id)}, ${fwd})`;
	},

	/** A closure body that keeps `alias` alive with the closure: what makes the closure's key the alias's. */
	keeping(this: Translator, alias: string, body: string, result: string): string {
		return result === 'Void' ? this.marks.tryCode(`withExtendedLifetime(${alias}) { () throws -> Void in ${body} }`) : `return try withExtendedLifetime(${alias}) { () throws -> ${result} in ${body} }`;
	},

	/**
	 * `code`, a function of type `from`, adapted to `to` (`params` and `body` of the closure made, calling it as `__h`):
	 * the closure stands for `code`, to `===`. `orNil`: `code` may be missing, and the adapted function is then too.
	 */
	adapter(this: Translator, code: string, from: string, to: FunctionParts, params: string[], body: string, orNil: boolean): string {
		const gc = this.functionCell(to.text);
		// The adapter is a static of `to`'s cell, which can't name a type parameter `to` doesn't.
		const hc = this.typeParameters(from).every((g) => this.typeParameters(to.text).includes(g)) ? this.functionCell(from) : null;
		if (!hc || !gc) {
			const wrap = `{ (__h: @escaping ${from}) -> ${to.text} in { (${params.join(', ')}) throws -> ${to.result} in ${body} } }`;
			// `if let`, not `Optional.map`: a closure passed through a generic is a new thunk, another function to `===`.
			return orNil ? `{ (__g: (${from})?) -> (${to.text})? in if let __g { return ${wrap}(__g) } else { return nil } }(${code})` : `${wrap}(${code})`;
		}
		const closure = `{ (${params.join(', ')}) throws -> ${to.result} in ${this.keeping('__i', body, to.result)} }`;
		const name = this.cellStatic(gc, 'adapting', `let __i = JSFunctionAlias(cell: ${hc}(f: __h)); return ${RT.jsIdentified}(Self(f: ${closure}), __i).f`, from, orNil);
		return `${gc}.${name}${orNil ? 'OrNil' : ''}(${code})`;
	},

	/** Swift code of type `from` where Swift needs `to`: functions are adapted parameter by parameter. */
	convert(this: Translator, input: string | Value, from: string, to: string): string {
		const value = this.marks.valued(input),
			code = value.code;
		if (from === to) return code;
		const widened = /^JSArray<(String|Double|Bool)>$/.exec(from);
		if (widened && to === `JSArray<${widened[1]}?>`) return `${to}(${code}.storage.map { $0 })`;
		if (isNamed(spelledType(from), 'JSMatch') && to === 'JSArray<String?>') return `${code}${/[?!]$/.test(from) ? '!' : ''}.values`;
		const rxFrom = /^Rx(?:Observable|Subject|BehaviorSubject|ReplaySubject)<(.+)>[?!]?$/.exec(from)?.[1],
			rxTo = /^RxObservable<(.+)>[?!]?$/.exec(to)?.[1];
		if (rxFrom && rxTo && rxFrom !== rxTo) return `${code}.mapValues { (__v: ${rxFrom}) -> ${rxTo} in ${this.convert('__v', rxFrom, rxTo)} }`;
		const sigFrom = /^Signal<(.+)>[?!]?$/.exec(from)?.[1],
			sigTo = /^Signal<(.+)>[?!]?$/.exec(to)?.[1];
		if (sigFrom && sigTo && sigFrom !== sigTo) {
			const read = this.convert('__s.value', sigFrom, sigTo);
			return `{ (__s: Signal<${sigFrom}>) -> Signal<${sigTo}> in Signal<${sigTo}>(computing: { ${plan(this.typeSlot(sigFrom), this.typeSlot(sigTo), this.lenient ? 'lenient' : 'checked').throws && this.marks.markOf(read)?.op !== 'try' ? `try ${read}` : read} }) }(${code})`;
		}
		// A promise of a value where a promise of any value is wanted (`unzip(): Promise<any>` returning a `Promise<string>`): the same settlement.
		const settles = /^JSPromise<(.+)>([?!]?)$/.exec(from);
		if (settles && !isUntyped(spelledType(settles[1])) && /^JSPromise<Any\?>[?!]?$/.test(to)) {
			const widened = `.then { (__v: ${settles[1]}) -> Any? in ${this.convert('__v', settles[1], 'Any?')} }`;
			return settles[2] ? this.marks.unwrappedIf(`(${code}).map { $0${widened} }`, !to.endsWith('?')) : `(${code})${widened}`;
		}
		// A match where an array of strings is wanted (`return s.match(/x/g)` declared `string[]`).
		if (isNamed(spelledType(from), 'JSMatch') && /^JSArray<String>[?!]?$/.test(to)) {
			const read = /[?!]$/.test(from) ? `(${code})?.jsStrings` : `(${code}).jsStrings`;
			return /[?!]$/.test(to) || !/[?!]$/.test(from) ? read : this.marks.implicitOf(read);
		}
		// A tuple (`['a', 'b'] as const`) where an array or untyped value is wanted: an array of its elements.
		const tuple = /^\((.*)\)$/.exec(from)?.[1];
		const element = /^JSArray<(.*)>[?!]?$/.exec(to)?.[1] ?? (this.pluginFiles.size > 0 && isUntyped(spelledType(to)) ? 'Any?' : undefined);
		if (tuple && element && !functionParts(from)) {
			const items = splitTopLevel(tuple);
			if (items.length > 1) return `{ (__t: ${from}) -> JSArray<${element}> in JSArray<${element}>([${items.map((it, k) => this.convert(`__t.${k}`, it, element)).join(', ')}]) }(${code})`;
		}
		// One interface's object where another, structurally the same, is wanted (`DuoFold` for `StageFold`): an object of that one with its keys.
		const fromShape = from.replace(/[?!]$/, ''),
			toShape = to.replace(/[?!]$/, '');
		// An object of a known shape where a dictionary is wanted: a dictionary of its entries.
		if (this.isObjectShape(fromShape) && /^JSRecord<.+>$/.test(toShape)) return this.fromAny(code, to);
		const fromClass = fromShape !== toShape && this.isObjectShape(toShape) ? this.classNamed(fromShape) : undefined;
		if (fromShape !== toShape && this.isObjectShape(toShape) && (this.isObjectShape(fromShape) || (!!fromClass && this.states.viewedClass(fromClass)))) {
			return isOptional(from) || from.endsWith('!') ? this.marks.unwrappedIf(`(${code}).map { ${this.viewOf(toShape, '$0')} }`, !(isOptional(to) || to.endsWith('!'))) : this.viewOf(toShape, code);
		}
		if (isUntyped(spelledType(to))) {
			const box = this.boxStep(from);
			if (box.composite === 'void') return from === 'Void' ? `${RT.jsUndefined}(${code})` : code;
			if (box.composite === 'enum') return this.untypedEnum(code, from);
			if (box.composite !== 'function') return code;
			// Lenient code holds a function implicitly unwrapped (`_itemTemplateSelector` before it is set): nil as an optional one is.
			const opt = isOptional(from) || /^\(.*\)!$/.test(from);
			const fn = functionParts(opt ? from.replace(/^\((.*)\)[?!]$/, '$1') : from);
			if (fn && (opt || this.lenient)) {
				// As `boxFunction` takes it: lenient code's function may give undefined for an object.
				const held = this.lenientRef(fn.result) !== fn.result ? `(${fn.params.join(', ')}) throws -> ${optionalType(fn.result)}` : fn.text;
				// The cell's `scriptOrNil` takes the optional itself.
				if (this.functionCell(held)) return this.boxFunction(code, held, fn.rest, '', undefined, undefined, true);
				// `if let`, not `Optional.map`: a closure passed through a generic is a new thunk, another function to `===`.
				return `{ (__g: (${held})?) -> Any? in if let __g { return ${this.boxFunction('__g', held, fn.rest)} } else { return nil } }(${code})`;
			}
			if (fn) return this.boxFunction(code, fn.text);
			return code;
		}
		if (isUntyped(spelledType(from))) return this.fromAny(code, to);
		// An event's data read as the object type a handler declares (`({ window }: { window: NativeWindow })`).
		if (from === 'EventData' && (this.interfaces.has(to.replace(/\?$/, '')) || !!this.shapes.named(to.replace(/\?$/, '')))) return this.fromAny(code, to);
		const f = functionParts(unwrapFunction(from, false));
		const g = functionParts(unwrapFunction(to, false));
		if (f && g && f.text === g.text && (isOptional(to) || to.endsWith('!')) && !isOptional(from) && !from.endsWith('!')) return code;
		if (f && g && (f.params.length <= g.params.length || (this.pluginFiles.size > 0 && f.params.slice(g.params.length).every((p) => isOptional(p.replace(/^@escaping /, '')) || isUntyped(spelledType(p.replace(/^@escaping /, ''))) || /^JSArray<Any\?>$/.test(p.replace(/^@escaping /, '')))))) {
			const params = g.params.map((p, k) => `__q${k}: ${escapingParam(p)}`);
			// A function taking the arguments as a rest (`(...args) => void`) where one of fixed parameters is wanted: those from the rest's start, as its array.
			const element = f.rest >= 0 && g.rest < 0 ? /^JSArray<(.*)>$/.exec(f.params[f.rest])?.[1] : undefined;
			// Each argument goes where the function's own parameter takes it, inside the call's `try`.
			const saved = [this.optionalSlot, this.underTry];
			this.optionalSlot = false;
			this.underTry = true;
			let args: string[];
			try {
				args = f.params.map((p, k) =>
					element !== undefined && k === f.rest
						? `JSArray<${element}>([${g.params
								.slice(k)
								.map((q, j) => this.convert(`__q${k + j}`, q.replace(/^@escaping /, ''), element))
								.join(', ')}])`
						: k >= g.params.length
							? /^JSArray<Any\?>$/.test(p.replace(/^@escaping /, ''))
								? 'JSArray<Any?>()'
								: 'nil'
							: this.convert(`__q${k}`, g.params[k].replace(/^@escaping /, ''), p.replace(/^@escaping /, '')),
				);
			} finally {
				[this.optionalSlot, this.underTry] = saved;
			}
			const called = this.marks.tried(`__h(${args.join(', ')})`),
				call = called.code;
			const outer = [this.optionalSlot, this.underTry];
			this.optionalSlot = false;
			this.underTry = true;
			let body: string;
			try {
				body = g.result === 'Void' ? `_ = ${call}` : f.result === 'Void' && isOptional(g.result) ? `${call}; return nil` : `return ${this.convert(called, f.result, g.result)}`;
			} finally {
				[this.optionalSlot, this.underTry] = outer;
			}
			// Lenient code's function held implicitly (`FunctionCell_X.implicit(callback)`) may be missing whatever its type says.
			const held = this.marks.implicitInner(code);
			const adapt = (orNil: boolean) => this.adapter(held ?? code, escapingFunction(f), g, params, body, orNil || held !== null);
			if (held === null && (this.isPresentFunction(code) || (!isOptional(from) && (!this.lenient || (!from.endsWith('!') && !isOptional(to) && !this.optionalSlot))))) return adapt(false);
			// A missing function passed where one must be is a TypeError when called, as JavaScript's.
			const mapped = adapt(true);
			if (isOptional(to) || to.endsWith('!') || (this.lenient && this.optionalSlot)) return mapped;
			// Lenient code's missing function given where one must be, under a `try`: V8's TypeError.
			return this.lenient && this.underTry ? `${RT.jsCallable}(${mapped}, "callback")` : this.marks.unwrappedCode(mapped);
		}
		// One promise where a promise of another type is wanted (`Promise.all(untyped)` returned as `Promise<void[]>`): its value converted.
		const pf = /^JSPromise<(.*)>[?!]?$/.exec(from)?.[1],
			pt = /^JSPromise<(.*)>[?!]?$/.exec(to)?.[1];
		if (pf && pt && pf !== pt) {
			observers.keep?.('swift', 'promise', from, to, this.currentFile, !!this.library);
			// An untyped promise is read as the same promise, its reactions in the ticks they would have in JavaScript.
			if (isUntyped(spelledType(pf)) && !this.lenient && !isOptional(from)) return `${RT.jsPromiseOf}(${code}) { ${pt === 'Void' ? '_ in ()' : this.presentFromAny('$0', pt)} }`;
			const value = pt === 'Void' ? '' : `return ${isUntyped(spelledType(pf)) ? this.presentFromAny('__v', pt) : this.convert('__v', pf, pt)}`;
			// Lenient code's promise (or a plugin's, held optional) may be missing: then nothing is chained.
			return `${this.lenient || isOptional(from) ? `(${code} as JSPromise<${pf}>?)?` : code}.then({ (__v: ${pf}) throws -> ${pt} in ${value} })`;
		}
		// An untyped array where an array of a type is wanted: its elements converted, in a new array.
		if (from === 'JSArray<Any?>' && /^JSArray<.+>$/.test(to)) return this.arrayOf(code, to.slice(8, -1));
		// An array of one object type where an array of another is wanted: a new array of its elements, each converted.
		const arrayFrom = /^JSArray<(.+)>[?!]?$/.exec(from)?.[1],
			arrayTo = /^JSArray<(.+)>[?!]?$/.exec(to)?.[1];
		const st = !this.library && arrayFrom && arrayTo ? structural(parseNativeType(from), parseNativeType(to), this.structuralFacts()) : null;
		const viewOptional = isOptional(from) || from.endsWith('!');
		const view = st?.step === 'view' ? this.arrayView(code, from, to, viewOptional) : null;
		if (view) return viewOptional ? this.marks.unwrappedIf(view, !(isOptional(to) || to.endsWith('!'))) : view;
		if (st?.step === 'elements' && st.element.step !== 'upcast') {
			observers.keep?.('swift', 'elements', from, to, this.currentFile, !!this.library);
			const each = (x: string) => `JSArray<${arrayTo}>(${x}.storage.map { (__e: ${arrayFrom}) -> ${arrayTo} in ${this.convert('__e', arrayFrom!, arrayTo!)} })`;
			return isOptional(from) || from.endsWith('!') ? this.marks.unwrappedIf(`(${code}).map { ${each('$0')} }`, !(isOptional(to) || to.endsWith('!'))) : each(`(${code})`);
		}
		// An array of an app class's objects where an array of what it implements or extends is wanted: a new array of them as that.
		const fe = /^JSArray<(\w+)>[?!]?$/.exec(from)?.[1],
			te = /^JSArray<(\w+)>[?!]?$/.exec(to)?.[1];
		if (!this.library && fe && te && fe !== te && this.classNamed(fe) && (this.protocols.has(te) || this.classNamed(te)) && this.sourceExtends(fe, te)) {
			observers.keep?.('swift', 'upcast', from, to, this.currentFile, !!this.library);
			return isOptional(from) || from.endsWith('!') ? this.marks.unwrappedIf(`(${code}).map { JSArray<${te}>($0.storage.map { $0 as ${te} }) }`, !(isOptional(to) || to.endsWith('!'))) : `JSArray<${te}>(${code}.storage.map { $0 as ${te} })`;
		}
		// A typed array where an untyped one is wanted (an erased generic's `T[]`): the one array.
		if (!this.library && /^JSArray<.+>[?!]?$/.test(from) && /^JSArray<Any\?>[?!]?$/.test(to) && !isNamed(spelledType(from), 'JSArray<Any?>')) {
			observers.keep?.('swift', 'widen', from, to, this.currentFile, !!this.library);
			const optional = isOptional(from) || from.endsWith('!');
			const shared = this.untypedArray(code, from, to, optional);
			if (shared) return optional ? this.marks.unwrappedIf(shared, !(isOptional(to) || to.endsWith('!'))) : shared;
			return optional ? this.marks.unwrappedIf(`(${code}).map { JSArray<Any?>($0.storage.map { $0 as Any? }) }`, !(isOptional(to) || to.endsWith('!'))) : `JSArray<Any?>(${code}.storage.map { $0 as Any? })`;
		}
		if (/^JSRecord<.+>[?!]?$/.test(from) && /^JSRecord<Any\?>[?!]?$/.test(to) && !isNamed(spelledType(from), 'JSRecord<Any?>')) {
			observers.keep?.('swift', 'record-widen', from, to, this.currentFile, !!this.library);
			return isOptional(from) || from.endsWith('!') ? this.marks.unwrappedIf(`(${code}).map { JSRecord<Any?>(object: $0.object) }`, !(isOptional(to) || to.endsWith('!'))) : `JSRecord<Any?>(object: (${code}).object)`;
		}
		if (to === optionalType(from)) return code;
		if (from === optionalType(to)) {
			// Inside a call's `try` (an adapter's arguments and result): V8's TypeError where it is missing.
			if (this.lenient && this.underTry && this.nullableRef(to) !== to) return value.mark?.op === 'try' ? this.marks.tryCode(this.marks.helper('jsObjectRequired', value.mark.of.code)) : this.marks.helper('jsObjectRequired', code);
			return this.marks.unwrappedCode(code);
		}
		// A Foundation array of objects where Swift has its element type (`[Any]` returned as `[UIViewController]`).
		const elementsTo = /^\[([\w.]+)\][?!]?$/.exec(to)?.[1];
		if (/^\[Any\][?!]?$/.test(from) && elementsTo && elementsTo !== 'Any') return isOptional(to) ? `(${code} as? [${elementsTo}])` : typedCollection(code, `[${elementsTo}]`)!;
		// Lenient code: one class where another is declared (a base class's value where a subclass is wanted): the value as it, undefined where it is not.
		const fb = from.replace(/[?!]$/, ''),
			tb = to.replace(/[?!]$/, '');
		if (fb !== tb && /^[A-Z]\w*$/.test(fb) && /^[A-Z]\w*$/.test(tb) && this.lenientRef(fb) !== fb && this.lenientRef(tb) !== tb && !['JSObject', 'EventData'].includes(fb)) {
			// A subclass's object where its base is wanted: an upcast, which cannot fail.
			return this.isSubclassOf(fb, tb) || this.core.extendsKit(fb, tb) ? this.marks.castCode(code, tb, 'as', true) : this.marks.castCode(code, tb, 'as?', true);
		}
		// A kit class's object, maybe missing, where a subclass is declared (`eachChildView` passing a `ViewCommon?` to a `(child: View) => …`).
		if (!this.library && /[?!]$/.test(from) && !/[?!]$/.test(to) && this.core.extendsKit(tb, fb)) return this.marks.castCode(code, tb, 'as!');
		if (!this.library && /[?!]$/.test(from) && isOptional(to) && fb !== tb && this.core.extendsKit(tb, fb)) return this.marks.castCode(code, tb, 'as?');
		return code;
	},
};
