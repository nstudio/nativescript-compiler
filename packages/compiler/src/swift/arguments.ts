// A call's arguments as Swift: the slot each parameter takes, missing and spread arguments, rest and packed arguments.
import ts from 'typescript';
import { functionParts, heldType, isOptional, nullishType, optionalType, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { argumentSlot, place, storeSlot, type ElementStore, type ParamSlot, type StoreSlot } from '../semantics/placement.ts';
import { implementationOf } from '../semantics/ast.ts';
import { isStatic } from '../semantics/throws.ts';
import { isUntyped, spelledType } from '../semantics/types.ts';
import { untypedGeneric } from '../semantics/spelled.ts';
import { baseMethod } from '../semantics/classes.ts';

export const argumentsMethods = {
	/** The slot the parameter `p`, the `k`th, is at call `e` given `a`: Swift's type of it there, and how it takes a missing value. */
	paramSlot(this: Translator, e: ts.CallExpression | ts.NewExpression, p: ts.Symbol, k: number, a: ts.Expression): ParamSlot {
		const decl = p.valueDeclaration;
		const slot = (target: string, facts?: Pick<ParamSlot, 'nullish' | 'asIs'>) => argumentSlot(this.placement, target, decl, { call: e, k, a }, facts);
		// A method or constructor of a generic class Swift has erased: the parameter's type as the method declares it.
		const erased =
			(!!decl && ts.isParameter(decl) && ts.isClassLike(decl.parent.parent) && !!decl.parent.parent.typeParameters?.length && this.erasesGenerics(decl.parent.parent)) ||
			// A method of an app's generic interface, whose protocol erases the interface's type parameters.
			(!!decl && ts.isParameter(decl) && ts.isMethodSignature(decl.parent) && this.erasingProtocol(decl.parent)) ||
			// A program function's type parameter Swift erases (`U extends { root: View }`, any of a plugin's): the parameter as declared, the argument's type erased with it.
			(!!decl && ts.isParameter(decl) && !!decl.type && !decl.getSourceFile().isDeclarationFile && !!(decl.parent as ts.SignatureDeclaration).typeParameters?.some((tp) => (this.erasesTypeParameter(tp) || (!this.library && this.erasesGenerics(decl.parent))) && new RegExp(`\\b${tp.name.text}\\b`).test(decl.type!.getText())));
		// An array of the class or a subclass where the function takes `JSArray<some C>`: the array itself.
		if (decl && ts.isParameter(decl) && this.opaqueArrayParam(decl)) return slot(this.typeOf(a));
		// In code the checker finds unreachable a parameter's type is never: its declared type.
		const at = decl && this.states.nullish().held.has(decl) ? 'Any?' : decl && this.states.nullishHeld(decl) ? nullishType(this.type(this.checker.getTypeOfSymbolAtLocation(p, e), e)) : this.heldElements(decl && ts.isParameter(decl) ? decl : e, this.type(this.checker.getTypeOfSymbolAtLocation(p, e), e));
		// A parameter property's parameter held `JSNullish` while its field is loose: the parameter's form, not the field's.
		if (decl && this.states.nullishHeld(decl)) return slot(at, { nullish: true });
		// A function where the program's parameter is a bare type parameter: the function object, which Swift binds the parameter to (`heldRead`).
		if (decl && ts.isParameter(decl) && decl.type && !decl.getSourceFile().isDeclarationFile && !isUntyped(spelledType(at)) && isUntyped(spelledType(heldType(at))) && (this.isBareTypeParameter(decl.type) || this.heldParameter(decl))) return slot('Any?');
		// A function where the parameter's type is computed from type parameters (`handler: Delegate[K]`, core's too): Swift
		// declares it untyped, so the argument must be a function object script can call, not the instantiation's closure.
		if (decl && ts.isParameter(decl) && decl.type && !isUntyped(spelledType(at)) && isUntyped(spelledType(heldType(at))) && untypedGeneric(this, decl.type)) return slot('Any?');
		// A choice between functions, one giving an empty default, where the program's function infers the result (`f: (x: T) => R`):
		// given at its own type, as a function literal is, which Swift binds the result to.
		const choice = ts.skipOuterExpressions(a, ts.OuterExpressionKinds.Parentheses);
		if (
			!erased &&
			decl &&
			ts.isParameter(decl) &&
			decl.type &&
			ts.isFunctionTypeNode(decl.type) &&
			!decl.getSourceFile().isDeclarationFile &&
			this.isBareTypeParameter(decl.type.type) &&
			ts.isConditionalExpression(choice) &&
			[choice.whenTrue, choice.whenFalse].some((x) => {
				x = ts.skipOuterExpressions(x, ts.OuterExpressionKinds.Parentheses);
				return (ts.isArrowFunction(x) || ts.isFunctionExpression(x)) && this.states.givesEmptyDefault(x);
			})
		)
			return slot(this.typeOf(a));
		// An override emitted with its root's signature: the parameter as Swift has it.
		const method = decl && ts.isParameter(decl) && ts.isMethodDeclaration(decl.parent) && !isStatic(decl.parent) && !decl.getSourceFile().isDeclarationFile ? decl.parent : null;
		const emitted = method && baseMethod(method, this.checker) ? this.emittedSignature(method).params[k]?.type.replace(/!$/, '?') : undefined;
		// An optional parameter of the program's (`cssFileName?: string`, `namespace: string | undefined`) takes undefined as it is.
		const omissible = !emitted && !erased && decl && ts.isParameter(decl) && (!!decl.questionToken || this.declaredUndefined(decl) || this.states.looseDeclaration(decl) || this.familyDefaultsDiffer(decl)) && !decl.getSourceFile().isDeclarationFile && (['String', 'Double', 'Bool'].includes(at) || (this.states.looseDeclaration(decl) && this.looseObjectType(at)));
		// An object parameter the program's code takes optional or implicitly unwrapped: a value Swift holds optional is given as it is (`argument`).
		const asIs = !emitted && !erased && decl && ts.isParameter(decl) && !decl.getSourceFile().isDeclarationFile && (this.states.mayBeNull(decl) || (!!decl.questionToken && !['String', 'Double', 'Bool'].includes(at))) ? { declared: at } : undefined;
		// A parameter its group's form widens takes undefined and null as they are, as every member of the group spells it.
		const widened = !emitted && !erased && !!decl && ts.isParameter(decl) && this.states.widened(decl) && !isOptional(at) && !isUntyped(spelledType(at));
		const to = emitted ?? (omissible || widened || this.filledDefault(decl) ? optionalType(at) : erased ? this.inFile(decl!.getSourceFile().fileName, () => this.paramType(decl as ts.ParameterDeclaration)) : at === 'Never' ? this.type(this.checker.getTypeOfSymbol(p), e) : at);
		return slot(to, { asIs });
	},

	/** The slot of the `k`th parameter, `p`, that call `e` leaves out (`ParamSlot.missing`); null where its own default applies. */
	missingSlot(this: Translator, e: ts.CallExpression | ts.NewExpression, p: ts.Symbol, k: number, missing: 'empty' | 'undefined'): ParamSlot | null {
		const pd = p.valueDeclaration;
		if (missing === 'empty') return argumentSlot(this.placement, this.type(this.checker.getTypeOfSymbolAtLocation(p, e), e), pd, { call: e, k }, { missing });
		if (!pd || !ts.isParameter(pd) || pd.questionToken || pd.initializer || pd.dotDotDotToken) return null;
		return argumentSlot(
			this.placement,
			this.inFile(pd.getSourceFile().fileName, () => this.paramType(pd)),
			pd,
			{ call: e, k },
			{ missing },
		);
	},

	/** The slot of the `k`th parameter, `p`, that an element of a spread tuple takes, Swift typing it `target`: the element is a value read out of the tuple, not an expression to place. */
	spreadSlot(this: Translator, e: ts.CallExpression | ts.NewExpression, p: ts.Symbol, k: number, target: string): ParamSlot {
		return argumentSlot(this.placement, target, p.valueDeclaration, { call: e, k });
	},

	/** A left-out argument in its slot. */
	missingArgument(this: Translator, slot: ParamSlot): string {
		if (slot.missing === 'empty') return slot.target === 'Void' ? '()' : 'nil';
		return this.undefinedValue(slot.target) ?? 'nil';
	},

	/** An argument in a slot taking a missing value as it is (`ParamSlot.asIs`): a result Swift holds optional, read as that optional; null for any other value. */
	argumentRead(this: Translator, a: ts.Expression, slot: ParamSlot): string | null {
		if (!slot.asIs) return null;
		const fn = (slot.decl as ts.ParameterDeclaration).parent as ts.FunctionLikeDeclaration;
		return this.givesUndefined(a) || (this.lenientApp && !!fn.body && this.heldOptionalLocal(a, slot.asIs.declared)) ? this.maybeUndefined(a) || null : null;
	},

	args(this: Translator, e: ts.CallExpression | ts.NewExpression, count?: number): string[] {
		const all = e.arguments ?? ts.factory.createNodeArray();
		const list = count === undefined ? all : all.slice(0, count);
		const sig = this.checker.getResolvedSignature(e);
		// An overload's call is the implementation's in Swift: its parameters take the arguments.
		const impl = sig?.getDeclaration() && implementationOf(sig.getDeclaration());
		const params = impl ? impl.parameters.map((p) => this.checker.getSymbolAtLocation(p.name)!).filter(Boolean) : (sig?.getParameters() ?? []);
		const target = impl ?? sig?.getDeclaration();
		if (target && !ts.isJSDocSignature(target) && this.readsArguments(target)) return [this.packed(all, 'JSArray<Any?>', this.restSlot(e, 'Any?'))];
		const out: string[] = [];
		const restAt = params.findIndex((p) => p.valueDeclaration && ts.isParameter(p.valueDeclaration) && p.valueDeclaration.dotDotDotToken);
		// A function type's rest parameter too (`mainThreadify(fn)` gives `(...args) => void`, or `String.fromCharCode.bind(String)`): Swift's function type takes it as `JSRest`.
		const calleeRest = !this.library && ts.isCallExpression(e) && restAt >= 0 && functionParts(this.typeOf(e.expression).replace(/^\((.*)\)[?!]$/, '$1'))?.rest === restAt;
		const appDeclared = (!!sig?.getDeclaration() && (!sig!.getDeclaration().getSourceFile().isDeclarationFile || (!this.library && ts.isFunctionTypeNode(sig!.getDeclaration())))) || calleeRest;
		let covered = list.length;
		for (let k = 0; k < list.length; k++) {
			const a = list[k];
			if (restAt >= 0 && k >= restAt && appDeclared) {
				// An app function's rest parameter is one array: the arguments packed, spreads included.
				const rest = this.restType(params[restAt]);
				out.push(this.packed(list.slice(k), rest, this.restSlot(e, rest.replace(/^JSArray<(.*)>$/, '$1'), params[restAt].valueDeclaration)));
				break;
			}
			if (ts.isSpreadElement(a)) {
				// The last argument spreading a tuple of fixed length (`fn(...args)` with `args: Parameters<typeof fn>`): its elements, in order.
				const st = this.checker.getTypeAtLocation(a.expression);
				const hasRest = this.checker.isTupleType(st) && ((st as ts.TypeReference).target as ts.TupleType).hasRestElement;
				// A rest parameter of a tuple type is an array in Swift where its reads are typed as a tuple.
				const restParam = ts.isIdentifier(a.expression) && this.resolve(a.expression)?.valueDeclaration;
				if (restParam && ts.isParameter(restParam) && restParam.dotDotDotToken && this.typeOf(a.expression).startsWith('(') && !functionParts(this.typeOf(a.expression))) throw this.error(a, 'a spread argument');
				if (k === list.length - 1 && ts.isIdentifier(a.expression) && restAt >= 0 && appDeclared) {
					const arr = this.coerce(a.expression, 'JSArray<Any?>');
					for (let i = 0; k + i < restAt; i++) {
						const slot = this.spreadSlot(e, params[k + i], k + i, this.type(this.checker.getTypeOfSymbolAtLocation(params[k + i], e), e).replace(/^@escaping /, ''));
						out.push(this.presentFromAny(`${RT.jsArg}(${arr}.storage, ${i})`, slot.target, true));
					}
					out.push(this.presentFromAny(`JSArray<Any?>(Array(${arr}.storage.dropFirst(${restAt - k})))`, this.restType(params[restAt])));
					covered = params.length;
					break;
				}
				const tuple = k === list.length - 1 && ts.isIdentifier(a.expression) && this.checker.isTupleType(st) && !hasRest ? this.checker.getTypeArguments(st as ts.TypeReference) : null;
				if (!tuple || k + tuple.length > params.length || restAt >= 0) throw this.error(a, 'a spread argument');
				const held = this.typeOf(a.expression);
				const code = this.expr(a.expression);
				tuple.forEach((el, i) => {
					const given = this.type(this.checker.getTypeOfSymbolAtLocation(params[k + i], e), e);
					const slot = this.spreadSlot(e, params[k + i], k + i, this.filledDefault(params[k + i].valueDeclaration) ? optionalType(given) : given);
					out.push(held.startsWith('(') && !functionParts(held) ? this.convert(`${code}.${i}`, this.type(el, e), slot.target) : this.presentFromAny(`${RT.jsArg}(${this.coerce(a.expression, 'JSArray<Any?>')}.storage, ${i})`, slot.target, true));
				});
				covered = k + tuple.length;
				break;
			}
			const p = params[Math.min(k, params.length - 1)];
			const decl = p?.valueDeclaration;
			if (!p || (decl && ts.isParameter(decl) && decl.dotDotDotToken)) {
				const pt = decl && ts.isParameter(decl) ? this.typeOf(decl.name).replace(/^JSArray<(.*)>$/, '$1') : 'Any?';
				out.push(place(this.placement, a, this.restSlot(e, pt, decl)(a)));
				continue;
			}
			out.push(place(this.placement, a, this.paramSlot(e, p, k, a)));
		}
		if (restAt >= 0 && appDeclared && out.length <= restAt) out.push(`${this.restType(params[restAt])}()`);
		// A function declaring `this`, called plainly: its `this` is undefined; called as a namespace's member, the namespace.
		const own = sig?.getDeclaration();
		if (own && ts.isFunctionDeclaration(own) && this.takesThis(own) && ts.isCallExpression(e)) {
			if (ts.isIdentifier(e.expression)) out.unshift('nil');
			else if (ts.isPropertyAccessExpression(e.expression) && this.isNamespace(e.expression.expression)) out.unshift(this.coerce(e.expression.expression, 'Any?'));
		}
		// A function value takes every parameter: the ones JavaScript leaves out are undefined.
		const decl = sig?.getDeclaration();
		const held = ts.isCallExpression(e) && this.isClosureValue(e.expression);
		const missing = restAt >= 0 || !decl || ts.isJSDocSignature(decl) ? undefined : (count === undefined || held) && (held || ts.isFunctionTypeNode(decl) || ts.isCallSignatureDeclaration(decl) || ts.isArrowFunction(decl) || ts.isFunctionExpression(decl)) ? 'empty' : (ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl) || ts.isFunctionDeclaration(decl) || ts.isConstructorDeclaration(decl)) && !decl.getSourceFile().isDeclarationFile && !this.readsArguments(decl) ? 'undefined' : undefined;
		for (let k = covered; missing && k < params.length; k++) {
			const slot = this.missingSlot(e, params[k], k, missing);
			if (!slot) break;
			out.push(this.missingArgument(slot));
		}
		return out;
	},

	/** A rest parameter's array type; one typed `any` (`...args: any`) holds an array of anything. */
	restType(this: Translator, p: ts.Symbol): string {
		const d = p.valueDeclaration as ts.ParameterDeclaration;
		// A rest of a type parameter (`bind`'s `(...args: A) => R`): Swift's function type takes it as one untyped array.
		if (d.type && this.isBareTypeParameter(d.type)) return 'JSArray<Any?>';
		const t = this.typeOf(d.name);
		return isUntyped(spelledType(t)) ? 'JSArray<Any?>' : t;
	},

	/** The arguments of a call on an untyped value from its `from`th: each, or with spreads, all as one list. */
	untypedArgs(this: Translator, e: ts.CallExpression | ts.NewExpression, from = 0): string {
		const args = (e.arguments ?? []).slice(from);
		const slot = this.restSlot(e, 'Any?');
		if (args.some(ts.isSpreadElement)) return `, spread: ${this.packed(args, 'JSArray<Any?>', slot)}.storage`;
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
			// A literal spread in place (`f(...[a, b])`) is its elements.
			if (ts.isSpreadElement(x) && ts.isArrayLiteralExpression(x.expression) && !x.expression.elements.some((y) => ts.isSpreadElement(y) || ts.isOmittedExpression(y))) run.push(...x.expression.elements.map(placed));
			else if (ts.isSpreadElement(x)) {
				if (run.length) {
					parts.push(`[${run.join(', ')}]`);
					run = [];
				}
				parts.push(`Array(${this.iterable(x.expression)})`);
			} else run.push(placed(x));
		}
		if (run.length) parts.push(`[${run.join(', ')}]`);
		return `${arrayType}(${parts.join(' + ') || '[]'})`;
	},
};
