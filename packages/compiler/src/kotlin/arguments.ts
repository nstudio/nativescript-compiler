// A call's arguments as Kotlin: the slot each parameter takes, spreads, rest and packed arguments, and function values passed.
import ts from 'typescript';
import { branch, functionTypeParts, isCompared, isFunctionType, isNullable, isThisParameter, nullishType, optionalType, scriptPrimitive, splitTopLevel, RT, adaptOf } from './syntax.ts';
import type { CallParams, Translator } from './translator.ts';
import { argumentSlot, place, storeSlot, type ElementStore, type ParamSlot, type StoreSlot } from '../semantics/placement.ts';
import { isLibDeclaration, implementationOf } from '../semantics/ast.ts';
import { keepsIdentity } from '../semantics/conversion.ts';
import { constructorOf } from '../semantics/classes.ts';
import { untypedGeneric } from '../semantics/spelled.ts';
import { isKit, isUntyped, spelledType } from '../semantics/types.ts';

export const argumentsMethods = {
	/** The slot the `k`th parameter of `call` is at call `e`: Kotlin's type of it there; `a` is the argument given there, absent for an element a spread gives. */
	paramSlot(this: Translator, e: ts.CallExpression | ts.NewExpression, call: CallParams, k: number, a?: ts.Expression): ParamSlot {
		const { sig, impl, params, appDeclared } = call;
		const p = params[Math.min(k, params.length - 1)];
		const decl = p?.valueDeclaration;
		const at = { call: e, k, a };
		if (decl && this.states.nullishHeld(decl)) return argumentSlot(this.placement, nullishType(this.type(this.checker.getTypeOfSymbolAtLocation(p, e), e)), decl, at, { nullish: true });
		let pt = decl && this.states.nullish().held.has(decl) ? 'Any?' : this.heldElements(decl && ts.isParameter(decl) ? decl : e, this.type(this.checker.getTypeOfSymbolAtLocation(p, e), e));
		// A generic implementation's parameter is not instantiated by an overload's call: the overload's, as this call instantiates it.
		const implTypes = impl && impl !== sig?.getDeclaration() ? (impl.typeParameters?.map((t) => t.name.text) ?? []) : [];
		const resolved = sig?.getParameters()[k];
		if (resolved && implTypes.some((t) => new RegExp(`\\b${t}\\b`).test(pt))) pt = this.type(this.checker.getTypeOfSymbolAtLocation(resolved, e), e);
		// Library mode: a generic function's parameter is its declaration's Kotlin type, the type parameters erased.
		// So is any parameter whose type reads otherwise here (an alias of a union resolving apart at the call).
		const generic = this.library && appDeclared && decl && ts.isParameter(decl) && (!!(decl.parent as ts.SignatureDeclaration).typeParameters?.length || (ts.isClassLike(decl.parent.parent) && !!decl.parent.parent.typeParameters?.length) || isUntyped(spelledType(pt)));
		// So is a parameter of a package's source called from outside it (`new FormArray(controls)`), its class's type parameters erased.
		const packageParam = !this.library && !!decl && ts.isParameter(decl) && this.pluginFiles.has(decl.getSourceFile().fileName) && !this.pluginFiles.has(e.getSourceFile().fileName);
		// So is a generic parameter of a package's source called from it, which Kotlin declares with the type parameters erased.
		const packageGeneric = !this.library && appDeclared && !!decl && ts.isParameter(decl) && this.pluginFiles.has(decl.getSourceFile().fileName) && !!(decl.parent as ts.SignatureDeclaration).typeParameters?.length;
		if (generic || packageParam || packageGeneric) pt = this.typeOf((decl as ts.ParameterDeclaration).name);
		// A parameter typed from type parameters (`handler: Delegate[K]`, core's too) is untyped in Kotlin, whatever this call instantiates.
		else if (decl && ts.isParameter(decl) && decl.type && !isUntyped(spelledType(pt)) && untypedGeneric(this, decl.type)) pt = 'Any?';
		// Library mode: an override's parameter is the topmost declaration's, which Kotlin's signature has (`appOverride`).
		const root = this.library && decl && ts.isParameter(decl) && ts.isMethodDeclaration(decl.parent) ? this.rootMethod(decl.parent) : null;
		if (root && root !== decl!.parent && root.parameters[k] && !root.parameters[k].dotDotDotToken) pt = this.paramType(root.parameters[k]);
		// A plugin's object parameter is nullable in Kotlin: what is passed needs no unwrap.
		if (decl && ts.isParameter(decl) && appDeclared && ((!!(decl.parent as ts.FunctionLikeDeclaration).body && this.states.mayBeNull(decl)) || this.states.widened(decl))) pt = optionalType(pt);
		// Library mode: a parameter the method declares nullable in Kotlin takes what may be missing as it is.
		else if (this.library && !isNullable(pt) && !isUntyped(spelledType(pt)) && !!a && this.nullableArgument(a)) pt = optionalType(pt);
		// So does a local function's parameter its body tests (`params`).
		else if (this.library && !isNullable(pt) && decl && ts.isParameter(decl) && ts.isVariableDeclaration(decl.parent.parent) && ts.isIdentifier(decl.name) && (this.nullableDecls.has(p) || (isNullable(this.typeOf(decl.name)) && this.truthTested(decl.name)))) pt = optionalType(pt);
		// So does one the compiled function declares nullable (`toString(settings: …[] | null)`), whatever the checker strips.
		else if (this.library && appDeclared && !isNullable(pt) && this.isObjectType(pt) && !['String', 'Double', 'Boolean'].includes(pt) && decl && ts.isParameter(decl) && ts.isIdentifier(decl.name) && !decl.questionToken && !decl.initializer && ts.isFunctionDeclaration(decl.parent) && !decl.getSourceFile().isDeclarationFile && isNullable(this.paramType(decl)) && ts.isCallExpression(e) && (ts.isIdentifier(e.expression) || (ts.isPropertyAccessExpression(e.expression) && !!this.namespaceMember(e.expression)))) pt = optionalType(pt);
		const constantDefault = !!decl && ts.isParameter(decl) && this.constantDefault(decl) && appDeclared && !this.templateParams;
		if (decl && ts.isParameter(decl) && ['String', 'Double', 'Boolean'].includes(pt) && this.states.undefinedParameter(decl)) pt = optionalType(pt);
		if (decl && ts.isParameter(decl) && (decl.questionToken || decl.initializer) && appDeclared && !constantDefault) pt = optionalType(pt);
		return argumentSlot(this.placement, pt, decl, at, { constantDefault, packaged: packageParam });
	},

	/** The slot of the `k`th parameter, `p`, that call `e` leaves out (`ParamSlot.missing`); null where none is given. */
	missingSlot(this: Translator, e: ts.CallExpression | ts.NewExpression, p: ts.Symbol, k: number, missing: 'empty' | 'undefined'): ParamSlot | null {
		const pd = p.valueDeclaration;
		if (missing === 'undefined' && pd && ts.isParameter(pd) && (pd.questionToken || pd.initializer)) return null;
		const pt = this.type(this.checker.getTypeOfSymbolAtLocation(p, e), e);
		// Undefined only where Kotlin's parameter can hold it.
		if (missing === 'undefined' && !isNullable(pt) && !isUntyped(spelledType(pt))) return null;
		return argumentSlot(this.placement, pt, pd, { call: e, k }, { missing });
	},

	/** Kotlin's own cells of an argument, before the shared front; null where it is placed in the slot's type. */
	argumentCell(this: Translator, a: ts.Expression, slot: ParamSlot): string | null {
		const pt = slot.target,
			decl = slot.decl;
		const native = slot.native;
		if (native) return this.native!.toJava(a, pt, native.nullable, native.nonNull, native.signature, native.typeVar);
		if (slot.rest) return null;
		if (slot.nullish) return this.coerce(a, pt);
		// An argument that may be undefined where Kotlin's parameter has the constant default JavaScript would use.
		if (slot.constantDefault && this.typeOf(a) === optionalType(pt)) return `(${this.coerce(a, optionalType(pt))} ?: ${this.coerce((decl as ts.ParameterDeclaration).initializer!, pt)})`;
		// Library mode: a value a library collection holds (`cache.set(key, result)` with a null result), as script stores it.
		if (this.library && decl && isLibDeclaration(decl) && this.isObjectType(pt) && !isNullable(pt) && !['String', 'Double', 'Boolean'].includes(pt) && !isFunctionType(pt) && (isNullable(this.declaredTypeOf(a) ?? this.typeOf(a)) || this.maybeUndefined(a))) return this.unchecked(pt, this.coerce(a, optionalType(pt)));
		// An object or a record of other values where a package's parameter takes a record of any: as script passes it.
		const record = slot.packaged ? /^JSRecord<(.*)>(\??)$/.exec(pt) : null;
		if (record && this.typeOf(a).replace(/\?$/, '') !== pt.replace(/\?$/, '')) return `${record[2] ? RT.jsRecordOrNull : RT.jsRecord}<${record[1]}>(${this.expr(a)})`;
		return (isUntyped(spelledType(pt)) && this.untypedArrow(a)) || null;
	},

	/** A function held in a variable, parameter or field (an overloaded method's implementation bound): a Kotlin function type, which has no defaults. */
	heldFunction(this: Translator, callee: ts.Expression): boolean {
		const name = ts.isPropertyAccessExpression(callee) ? callee.name : ts.isIdentifier(callee) ? callee : null;
		const d = name && this.checker.getSymbolAtLocation(name)?.valueDeclaration;
		return !!d && !d.getSourceFile().isDeclarationFile && (ts.isVariableDeclaration(d) || ts.isParameter(d) || ts.isPropertyDeclaration(d));
	},

	args(this: Translator, e: ts.CallExpression | ts.NewExpression, count?: number): string[] {
		const all = e.arguments ?? ts.factory.createNodeArray();
		const list = count === undefined ? all : all.slice(0, count);
		const sig = this.checker.getResolvedSignature(e);
		// An overload's call is the implementation's in Kotlin: its parameters take the arguments.
		let impl = sig?.getDeclaration() && implementationOf(sig.getDeclaration());
		// Library mode: `new Font(…)` the checker resolves no constructor for (a base's protected one): the compiled class's.
		if (!impl && this.library && ts.isNewExpression(e) && !sig?.getDeclaration() && e.arguments?.length) {
			const made = this.checker.getTypeAtLocation(e.expression).getSymbol()?.valueDeclaration;
			const ctor = made && ts.isClassLike(made) && !made.getSourceFile().isDeclarationFile ? constructorOf(made, this.checker) : undefined;
			if (ctor) impl = ctor;
		}
		const params = impl ? impl.parameters.map((p) => this.checker.getSymbolAtLocation(p.name)!).filter(Boolean) : (sig?.getParameters() ?? []);
		const target = impl ?? sig?.getDeclaration();
		if (target && !ts.isJSDocSignature(target) && this.readsArguments(target)) return [this.packed(all, 'JSArray<Any?>', this.restSlot(e, 'Any?'))];
		const out: string[] = [];
		const restAt = params.findIndex((p) => p.valueDeclaration && ts.isParameter(p.valueDeclaration) && p.valueDeclaration.dotDotDotToken);
		// A function type's rest parameter too (`bind`'s `(...args: A) => R`): Kotlin's function type takes it as one array.
		const appDeclared = (!!sig?.getDeclaration() && !sig!.getDeclaration().getSourceFile().isDeclarationFile) || (!!impl && !impl.getSourceFile().isDeclarationFile) || (!this.library && !!sig?.getDeclaration() && ts.isFunctionTypeNode(sig!.getDeclaration()));
		const call: CallParams = { sig, impl, params, appDeclared };
		const slot = (k: number, a?: ts.Expression) => this.paramSlot(e, call, k, a);
		let covered = list.length;
		for (let k = 0; k < list.length; k++) {
			const a = list[k];
			if (restAt >= 0 && k >= restAt && appDeclared) {
				const calleeParam = ts.isCallExpression(e) ? functionTypeParts(this.typeOf(e.expression).replace(/^\((.*)\)\?$/, '$1'))?.params[restAt] : undefined;
				const rest = calleeParam?.startsWith('JSArray<') && calleeParam.endsWith('>') ? calleeParam : this.restType(params[restAt]);
				out.push(this.packed(list.slice(k), rest, this.restSlot(e, rest.replace(/^JSArray<(.*)>$/, '$1'), params[restAt].valueDeclaration)));
				break;
			}
			if (ts.isSpreadElement(a)) {
				if (restAt >= 0 && k >= restAt && !appDeclared) {
					out.push(`*${this.packed(list.slice(k), 'JSArray<Any?>', this.restSlot(e, 'Any?'))}.storage.toTypedArray()`);
					covered = list.length;
					break;
				}
				const spread = k === list.length - 1 ? this.spreadArgs(a, k, params, restAt, appDeclared, slot) : null;
				if (!spread) throw this.error(a, 'a spread argument');
				out.push(...spread);
				covered = k + spread.length;
				break;
			}
			const p = params[Math.min(k, params.length - 1)];
			const decl = p?.valueDeclaration;
			if (!p || (decl && ts.isParameter(decl) && decl.dotDotDotToken)) {
				const pt = decl && ts.isParameter(decl) ? this.typeOf(decl.name).replace(/^JSArray<(.*)>$/, '$1') : 'Any?';
				out.push(place(this.placement, a, this.restSlot(e, pt, decl)(a)));
				continue;
			}
			out.push(place(this.placement, a, slot(k, a)));
		}
		if (restAt >= 0 && appDeclared && covered <= restAt) out.push(`${this.restType(params[restAt])}()`);
		const decl = sig?.getDeclaration();
		// A function value takes every parameter; a plugin's call (its code unchecked) may leave out one the callee requires.
		const missing = count !== undefined || restAt >= 0 || !decl || ts.isJSDocSignature(decl) ? undefined : ts.isFunctionTypeNode(decl) || ts.isCallSignatureDeclaration(decl) || ts.isArrowFunction(decl) || ts.isFunctionExpression(decl) || (ts.isCallExpression(e) && this.heldFunction(e.expression)) ? 'empty' : !this.library && this.inPluginFile(e) ? 'undefined' : undefined;
		for (let k = covered; missing && k < params.length; k++) {
			const s = this.missingSlot(e, params[k], k, missing);
			if (!s) break;
			const pd = params[k].valueDeclaration;
			out.push(s.missing === 'empty' && s.target === 'Unit' ? 'Unit' : pd && this.states.nullishHeld(pd) ? 'JSNullish.Undefined' : 'null');
		}
		// A required parameter the call's types make `void` (`next()` of a `Subject<void>`), which TypeScript lets it leave out.
		if (!missing && restAt < 0 && list.length === all.length && sig && out.length === list.length) {
			for (let k = list.length; k < params.length; k++) {
				const d = params[k].valueDeclaration;
				const given = sig.getParameters()[k];
				if (!d || !ts.isParameter(d) || d.questionToken || d.initializer || !given || !(this.checker.getTypeOfSymbol(given).flags & ts.TypeFlags.Void)) break;
				out.push(slot(k).target === 'Unit' ? 'Unit' : 'null');
			}
		}
		return out;
	},

	/**
	 * App code: a function literal given to an untyped parameter, taking what untyped callers give it (null, an object
	 * literal) as its parameters' types have it; null when it needs no reading. Only for an argument: a slot Kotlin types
	 * as a function (`worker.onmessage`) needs the literal itself.
	 */
	untypedArrow(this: Translator, e: ts.Expression): string | null {
		let bare = e;
		while (ts.isParenthesizedExpression(bare)) bare = bare.expression;
		// A destructured parameter (`([a, b]) => …`) takes its tuple as script makes it, an array or a pair.
		if (this.library || !ts.isArrowFunction(bare) || bare.parameters.length > 4 || this.readsArguments(bare) || bare.parameters.some((q) => q.dotDotDotToken || isThisParameter(q) || ts.isObjectBindingPattern(q.name))) return null;
		const types = bare.parameters.map((q) => (ts.isIdentifier(q.name) ? this.paramType(q) : this.typeOf(q.name)));
		if (!types.some((t) => !scriptPrimitive(t) || (t.endsWith('?') && !isUntyped(spelledType(t))))) return null;
		const ret = this.returnTypeOf(bare);
		return `run<Any?> { val __f = ${this.closure(bare, `(${types.join(', ')}) -> ${ret}`)}; ${this.scriptArguments(types, ret)} }`;
	},

	/** `__f`, a function of `types`, as one taking script's arguments as it holds them: equal to `__f`. */
	scriptArguments(this: Translator, types: string[], ret: string): string {
		// A string, number or boolean arrives as the type it has, but null as script's.
		const read = (t: string, x: string) => (isUntyped(spelledType(t)) ? x : !scriptPrimitive(t) ? this.fromAny(x, t) : t.endsWith('?') ? `(if (${RT.jsIsNullish}(${x})) null else ${RT.jsUnchecked}<${t}>(${x}))` : this.unchecked(t, x));
		const names = types.map((_, k) => this.marks.pureCode(`__u${k}`));
		const call = `__f(${types.map((t, k) => read(t, names[k])).join(', ')})`;
		return `${adaptOf(types.length)}<${[...types.map(() => 'Any?'), ret].join(', ')}>(__f) { ${names.map((n) => `${n}: Any?`).join(', ')} -> ${call} }`;
	},

	/**
	 * App code: a function value placed untyped, its Kotlin parameters typed: script calls it with what it holds (its
	 * null and undefined included), read as the parameters' types; null when it needs no reading.
	 */
	untypedFunctionValue(this: Translator, e: ts.Expression): string | null {
		// Compared, the function is itself already (an adapter is equal to it); packaged code keeps its own signatures.
		if (this.library || isCompared(e) || this.states.packaged(e)) return null;
		let bare = e;
		while (ts.isParenthesizedExpression(bare)) bare = bare.expression;
		// Each branch placed untyped by itself: Kotlin types the two branches' functions apart.
		if (ts.isConditionalExpression(bare)) {
			if (![bare.whenTrue, bare.whenFalse].some((x) => this.typedFunctionValue(x))) return null;
			return `(if (${this.cond(bare.condition)}) ${branch(this.coerce(bare.whenTrue, 'Any?'))} else ${branch(this.coerce(bare.whenFalse, 'Any?'))})`;
		}
		const rest = this.restFunctionValue(bare);
		if (rest) return rest;
		const value = this.typedFunctionValue(e);
		if (!value) return null;
		const { literal, source, parts } = value;
		if (literal && !keepsIdentity('function', literal)) return `run<Any?> { val __f = ${this.closure(literal, source)}; ${this.scriptArguments(parts.params, parts.ret)} }`;
		const fn = this.expr(e);
		const held = this.declaredTypeOf(bare);
		return `${fn.includes('::') ? `(${fn})` : fn}${source.endsWith('?') || held?.endsWith('?') ? '?' : ''}.let { __f -> ${this.scriptArguments(parts.params, parts.ret)} }`;
	},

	/** A function literal taking a rest parameter, placed untyped: script's arguments from the rest's position on are its array. */
	restFunctionValue(this: Translator, e: ts.Expression): string | null {
		if (!(ts.isArrowFunction(e) || ts.isFunctionExpression(e)) || !e.parameters.some((q) => q.dotDotDotToken)) return null;
		if (this.readsArguments(e) || e.parameters.some((q) => isThisParameter(q) || !ts.isIdentifier(q.name))) return null;
		const args = e.parameters.map((q, k) => (q.dotDotDotToken ? `JSArray(__a.drop(${k}).map { ${this.fromAnyCode('it', this.typeOf(q.name).replace(/^JSArray<(.*)>$/, '$1'), true)} }.toMutableList())` : this.fromAnyCode(this.marks.pureCode(`__a.getOrNull(${k})`), this.paramType(q), true)));
		const arity = e.parameters.findIndex((q) => !!q.questionToken || !!q.initializer || !!q.dotDotDotToken);
		const call = `__f(${args.join(', ')})`;
		return `run<Any?> { val __f = ${this.closure(e, this.typeOf(e))}; ${RT.jsFunction}(${arity}, __f, true) { __a -> ${this.returnTypeOf(e) === 'Unit' ? `${call}; null` : call} } }`;
	},

	/**
	 * A function literal, or a function read by name, whose Kotlin parameters `untypedFunctionValue` reads script's
	 * arguments into. Any other expression (an assertion through `any`, a call's result) holds what script gave it,
	 * which its type need not describe.
	 */
	typedFunctionValue(this: Translator, e: ts.Expression): { literal?: ts.ArrowFunction | ts.FunctionExpression; source: string; parts: { params: string[]; ret: string } } | null {
		let bare = e;
		while (ts.isParenthesizedExpression(bare)) bare = bare.expression;
		const literal = ts.isArrowFunction(bare) || ts.isFunctionExpression(bare) ? bare : undefined;
		if (!literal && !ts.isIdentifier(bare) && !ts.isPropertyAccessExpression(bare)) return null;
		// A built-in's method is the kit's function, whose parameters are not the ones TypeScript's library declares.
		const named = literal ? undefined : this.resolve(ts.isPropertyAccessExpression(bare) ? bare.name : bare)?.declarations;
		if (named?.length && named.every((d) => isLibDeclaration(d))) return null;
		if (literal && (this.readsArguments(literal) || literal.parameters.some((q) => q.dotDotDotToken || isThisParameter(q) || !ts.isIdentifier(q.name)))) return null;
		const sigs = this.checker.getTypeAtLocation(e).getNonNullableType().getCallSignatures();
		if (sigs.length !== 1 || sigs[0].typeParameters?.length || sigs[0].getDeclaration()?.parameters.some((q) => q.dotDotDotToken)) return null;
		const source = this.typeOf(e);
		const parts = this.scriptReadParts(source);
		return parts ? { literal, source, parts } : null;
	},

	/** The parameters and result of a function type `scriptArguments` reads for, or null where script's values need no reading. */
	scriptReadParts(this: Translator, type: string): { params: string[]; ret: string } | null {
		const parts = functionTypeParts(/^\(.*\)\?$/.test(type) ? type.slice(1, -2) : type);
		if (!parts || parts.params.length > 4 || [...parts.params, parts.ret].some((t) => t.includes('JSNullish<') || this.isTypeParameterName(t.replace(/\?$/, '')))) return null;
		return parts.params.some((t) => !scriptPrimitive(t) || (t.endsWith('?') && !isUntyped(spelledType(t)))) ? parts : null;
	},

	/**
	 * App code: a function field's `code` of `type` read by name, as script calls it (`untypedFunctionValue`); `code` itself
	 * where that needs no reading. A rest parameter's function has an array parameter here, which script's arguments are not.
	 */
	scriptFunctionRead(this: Translator, code: string, type: string): string {
		const parts = this.library ? null : this.scriptReadParts(type);
		if (parts?.params.some((t) => isKit(spelledType(t), 'JSArray'))) return code;
		return parts ? `${code}${type.endsWith('?') ? '?' : ''}.let { __f -> ${this.scriptArguments(parts.params, parts.ret)} }` : code;
	},

	restType(this: Translator, p: ts.Symbol): string {
		const d = p.valueDeclaration as ts.ParameterDeclaration;
		const bare = !!d.type && ts.isTypeReferenceNode(d.type) && !d.type.typeArguments && !!(this.checker.getTypeFromTypeNode(d.type).flags & ts.TypeFlags.TypeParameter);
		return bare ? 'JSArray<Any?>' : this.typeOf(d.name);
	},

	/**
	 * The arguments a name spread last gives the parameters from `k` on, each element read in place: a tuple's into fixed
	 * parameters, or (an app function) the leading elements into fixed parameters and the others as the rest parameter's
	 * array; null for any other spread.
	 */
	spreadArgs(this: Translator, a: ts.SpreadElement, k: number, params: ts.Symbol[], restAt: number, appDeclared: boolean, slot: (k: number) => ParamSlot): string[] | null {
		const x = a.expression;
		if (!ts.isIdentifier(x)) return null;
		const st = this.checker.getTypeAtLocation(x);
		// A rest parameter of a tuple type is an array in Kotlin where its reads are typed as a Pair or Triple.
		const d = this.resolve(x)?.valueDeclaration;
		if (d && ts.isParameter(d) && d.dotDotDotToken && /^(Pair|Triple)</.test(this.typeOf(x))) return null;
		const tuple = this.checker.isTupleType(st) ? ((st as ts.TypeReference).target as ts.TupleType) : null;
		const length = tuple && !tuple.hasRestElement ? this.checker.getTypeArguments(st as ts.TypeReference).length : null;
		const present = tuple ? tuple.minLength : 0;
		if (restAt >= 0 ? !appDeclared || k >= restAt : length === null || k + length > params.length) return null;
		const held = this.typeOf(x),
			code = this.expr(x);
		const pair = /^(Pair|Triple)<(.*)>$/.exec(held),
			array = /^JSArray<(.*)>$/.exec(held);
		if (!pair && !array) return null;
		const fields = pair ? splitTopLevel(pair[2]) : [];
		const read = (i: number): { code: string; type: string } | null => (pair ? (i < fields.length ? { code: `${code}.${['first', 'second', 'third'][i]}`, type: fields[i] } : null) : i < present ? { code: `${code}[${i}]`, type: array![1] } : { code: `${code}.element(${i}.0)`, type: optionalType(array![1]) });
		const out: string[] = [];
		for (let i = 0; k + i < (restAt >= 0 ? restAt : k + length!); i++) {
			const s = slot(k + i);
			const el = read(i);
			if (s.nullish) return null;
			if (!el) {
				if (!isNullable(s.target) && !isUntyped(spelledType(s.target))) return null;
				out.push('null');
				continue;
			}
			const decl = params[k + i].valueDeclaration as ts.ParameterDeclaration;
			if (s.constantDefault && isNullable(el.type)) out.push(`(${this.convert(el.code, el.type, optionalType(s.target))} ?: ${this.coerce(decl.initializer!, s.target)})`);
			else if (isNullable(el.type) && !isNullable(s.target) && !isUntyped(spelledType(s.target)) && !isUntyped(spelledType(el.type))) return null;
			else out.push(this.convert(el.code, el.type, s.target));
		}
		if (restAt < 0) return out;
		const rest = this.restType(params[restAt]),
			element = rest.replace(/^JSArray<(.*)>$/, '$1');
		const from = restAt - k;
		if (pair)
			out.push(
				fields.length > from
					? `${RT.jsArrayOf}<${element}>(${fields
							.slice(from)
							.map((t, j) => this.convert(`${code}.${['first', 'second', 'third'][from + j]}`, t, element))
							.join(', ')})`
					: `${rest}()`,
			);
		else out.push(this.convert(`${code}.slice(${from}.0)`, held, rest));
		return out;
	},

	/** The arguments of a call on an untyped value from its `from`th: each, or with spreads, all spread from one list. */
	untypedArgs(this: Translator, e: ts.CallExpression | ts.NewExpression, from = 0): string {
		const args = (e.arguments ?? []).slice(from);
		const slot = this.restSlot(e, 'Any?');
		if (args.some(ts.isSpreadElement)) return `, *${this.packed(args, 'JSArray<Any?>', slot)}.storage.toTypedArray()`;
		return args.map((a) => `, ${place(this.placement, a, slot(a))}`).join('');
	},

	/** An argument of `call` with no declared parameter's cell, as `element`: a built-in's (`Math.max`) or one an untyped callee takes. */
	restArgument(this: Translator, call: ts.CallExpression | ts.NewExpression, a: ts.Expression, element: string): string {
		return place(this.placement, a, this.restSlot(call, element)(a));
	},

	/** The slot of each value `at` stores as a container's element (`elementStoreOf`), held as `element`. */
	elementSlot(this: Translator, at: ElementStore, element: string): (a: ts.Expression) => StoreSlot {
		return (a) => storeSlot(this.placement, element, at, a);
	},

	/** A value `call` stores as an element of its receiver (`push`'s, `add`'s), held as `element`. */
	elementArgument(this: Translator, call: ts.CallExpression, a: ts.Expression, element: string): string {
		return place(this.placement, a, this.elementSlot(call, element)(a));
	},

	/** The slot of each argument `call` gives a rest parameter (`decl`), or an untyped callee: one `element` each, placed with no declared parameter's cell. */
	restSlot(this: Translator, call: ts.CallExpression | ts.NewExpression, element: string, decl?: ts.Declaration): (a: ts.Expression) => ParamSlot {
		return (a) => {
			const k = call.arguments?.indexOf(a) ?? -1;
			return argumentSlot(this.placement, element, decl, { call, k, a: k < 0 ? undefined : a }, { rest: true });
		};
	},

	/** Arguments (spreads included) as one `JSArray` of `arrayType`; `slot` places each element where they are a call's. */
	packed(this: Translator, items: readonly ts.Expression[], arrayType: string, slot?: (a: ts.Expression) => ParamSlot | StoreSlot): string {
		const el = arrayType.replace(/^JSArray<(.*)>$/, '$1');
		const placed = (x: ts.Expression) => (slot ? place(this.placement, x, slot(x)) : this.coerce(x, el));
		const parts: string[] = [];
		let run: string[] = [];
		for (const x of items) {
			if (ts.isSpreadElement(x) && ts.isArrayLiteralExpression(x.expression) && !x.expression.elements.some(ts.isSpreadElement)) run.push(...x.expression.elements.map(placed));
			else if (ts.isSpreadElement(x)) {
				if (run.length) {
					parts.push(`listOf<${el}>(${run.join(', ')})`);
					run = [];
				}
				const list = `(${this.iterable(x.expression)}).toList()`;
				// A tuple's elements are untyped in Kotlin.
				parts.push(/^(Pair|Triple)</.test(this.typeOf(x.expression)) ? `(${list} as List<${el}>)` : list);
			} else run.push(placed(x));
		}
		if (run.length) parts.push(`listOf<${el}>(${run.join(', ')})`);
		return parts.length ? `${arrayType}(${parts.join(' + ')})` : `${arrayType}()`;
	},
};
