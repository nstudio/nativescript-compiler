// Parameters given undefined or null: script callers, defaults that take or pass an empty value, and the parameters a form decides.
import ts from 'typescript';
import { isPrimitive } from '../types.ts';
import { scriptCalledFunction } from '../trust.ts';
import { nullableTypeNode } from '../lang.ts';
import type { ParameterChecks, ValueStates } from './value-states.ts';

export const parametersMethods = {
	/** See `scriptCalledFunction` (lang.ts). */
	scriptCalled(this: ValueStates, sig: ts.Node): boolean {
		if (this.backend.library) return false;
		return (this.scriptCalledFunctions ??= scriptCalledFunction(this.backend.trust))(sig);
	},

	/** A string, number or boolean parameter of a function script calls (`scriptCalled`) or `givenUndefined`: it takes undefined as well. */
	scriptCalledParameter(this: ValueStates, p: ts.ParameterDeclaration): boolean {
		const b = this.backend;
		if (p.dotDotDotToken || !ts.isIdentifier(p.name) || !(this.scriptCalled(p.parent) || this.givenUndefined(p))) return false;
		return b.shapes.question(() => this.primitive(b.type(this.checker.getTypeAtLocation(p.name), p)));
	},

	/** A parameter of a function script calls, or one the program gives undefined: it takes undefined as well. */
	undefinedParameter(this: ValueStates, p: ts.ParameterDeclaration): boolean {
		return this.givenUndefined(p) || this.scriptCalledParameter(p);
	},

	/**
	 * An app's parameter the program may give undefined though its declared type has none: its form's undefined is a
	 * value left out (`Form.missing`: fewer arguments, a read past an array's end, a hole, an optional parameter), one
	 * the program's code gives or reads missing (`Form.given`, `Form.absent`), or in a non-strict app one its types leave
	 * room for (`Form.untyped`: an optional field's, an untyped caller's), unless a fixed point shares its form. A typed
	 * entry point's (a template's `$event`, a platform's or library's callback) is not: a foreign value is checked where it
	 * enters. In a
	 * non-strict app also a parameter of a function type (`f: (i: number, last: boolean) => string`) that a call through
	 * its name gives undefined (`f(i, end ? true : undefined)`), or a literal's parameter given for one.
	 */
	givenUndefined(this: ValueStates, p: ts.ParameterDeclaration): boolean {
		const b = this.backend;
		// A library's and a plugin's parameters are entry points: their forms change the kit's surface, decided with it.
		if (b.lenient || b.library || p.getSourceFile().isDeclarationFile || this.plugin(p)) return false;
		let found = this.undefinedGiven.get(p);
		if (found !== undefined) return found;
		const forms = this.forms(),
			form = forms.formOfSlot(p);
		// A non-strict app's code passes an optional field's undefined, or an untyped caller's, where a declared type has none.
		const lenientGiven = b.lenientApp && !b.trust.strictFile(p.getSourceFile()) && this.appCode(p) && form.untyped;
		// A callback's parameter given a container's optional elements takes them as they are, whatever else reaches it.
		this.undefinedGiven.set(p, (found = !p.dotDotDotToken && !forms.declaredForm(p).undefined && (form.missing || (form.undefined && !forms.fixedSlot(p) && (((form.given || form.absent) && !form.foreign) || lenientGiven || forms.elementSources(p).some((c) => this.optionalElements(c)))))));
		if (found || !b.lenientApp) return found;
		const fn = p.parent,
			k = fn.parameters.indexOf(p);
		if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
			const slot = this.checker.getContextualType(fn)?.getNonNullableType().getCallSignatures()[0]?.getDeclaration();
			const q = slot && !ts.isJSDocSignature(slot) && ts.isFunctionTypeNode(slot) ? slot.parameters[k] : undefined;
			found = !!q && this.givenUndefined(q);
		} else if (ts.isFunctionTypeNode(fn) && (ts.isParameter(fn.parent) || ts.isVariableDeclaration(fn.parent)) && fn.parent.type === fn && ts.isIdentifier(fn.parent.name)) {
			const d = fn.parent,
				sym = this.checker.getSymbolAtLocation(d.name as ts.Identifier);
			const undef = (e: ts.Expression): boolean => {
				e = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
				return (ts.isIdentifier(e) && e.text === 'undefined') || ts.isVoidExpression(e) || (ts.isConditionalExpression(e) && (undef(e.whenTrue) || undef(e.whenFalse)));
			};
			const visit = (x: ts.Node): boolean => (ts.isCallExpression(x) && ts.isIdentifier(x.expression) && this.checker.getSymbolAtLocation(x.expression) === sym && !!x.arguments[k] && undef(x.arguments[k])) || !!ts.forEachChild(x, visit);
			const scope = ts.isParameter(d) ? d.parent : ts.findAncestor(d.parent, (x) => ts.isFunctionLike(x) || ts.isSourceFile(x));
			found = !!sym && !!scope && visit(scope);
		}
		this.undefinedGiven.set(p, found);
		return found;
	},

	/**
	 * An app's defaulted parameter the program may give undefined (`Forms.defaultGivenUndefined`): its default is applied
	 * in the body, where undefined takes it too, not by the native signature, which only an omitted argument reaches.
	 */
	defaultTakesUndefined(this: ValueStates, p: ts.ParameterDeclaration): boolean {
		const b = this.backend;
		if (b.lenient || b.library || !p.initializer || p.getSourceFile().isDeclarationFile || this.plugin(p)) return false;
		let found = this.defaultsGiven.get(p);
		if (found === undefined) this.defaultsGiven.set(p, (found = !this.forms().fixedSlot(p) && this.forms().defaultGivenUndefined(p)));
		return found;
	},

	/**
	 * A parameter whose native type takes an empty value its declared type leaves out. An app's parameter takes what its
	 * group's form holds (`formDecides`), whether or not its code is checked with strictNullChecks. A plugin's is an
	 * entry point, its code checked without them: callers pass null and undefined for an object parameter (core's
	 * `valueChanged(target, oldValue, newValue)` starts from undefined; ui-drawer applies a closing drawer's data with
	 * no side).
	 */
	mayBeNull(this: ValueStates, p: ts.ParameterDeclaration): boolean {
		const b = this.backend,
			checked = this.parameterChecks();
		if (p.dotDotDotToken || (!ts.isIdentifier(p.name) && !this.formDecides(p))) return false;
		if (this.defaultPassesNull(p)) return true;
		const t = b.typeOf(p.name);
		if (this.formDecides(p)) {
			// Swift reads a non-strict app's optional parameter unwrapped where its body tests it, as nothing narrows it there.
			const optional = !checked && b.lenientApp && !!p.questionToken && b.nullableParameter(t);
			return optional || this.widened(p) || (!!checked && (this.looseDeclaration(p) || (this.primitive(t) && this.undefinedParameter(p))));
		}
		if (this.writtenNullable(p)) return true;
		if (!checked) return (this.plugin(p) || b.lenientApp) && b.nullableParameter(t);
		if (this.looseDeclaration(p)) return true;
		if (this.primitive(t) && this.undefinedParameter(p)) return true;
		// A plugin's string parameter its function tests (`if (state)`), in a non-strict app: one callers may leave out.
		if (b.lenientApp && !b.library && !p.getSourceFile().isDeclarationFile && isPrimitive(t) && t.kind === 'string' && ts.isFunctionDeclaration(p.parent) && ts.isIdentifier(p.name) && checked.truthTested(p.name)) return true;
		return this.plugin(p) && b.nullableParameter(t);
	},

	/**
	 * An entry point's parameter (a library's, a plugin's) that it or a member of its group writes as taking undefined or
	 * null (`done: ((handled: boolean) => void) | undefined`), in code checked without strictNullChecks: its checker type
	 * leaves them out, but its callers pass them, and no program's calls decide its form.
	 */
	writtenNullable(this: ValueStates, p: ts.ParameterDeclaration): boolean {
		const b = this.backend;
		if (p.questionToken || p.initializer || p.getSourceFile().isDeclarationFile || !ts.isIdentifier(p.name)) return false;
		const t = b.typeOf(p.name);
		if (b.optional(t) || !(b.nullableParameter(t) || b.functionType(t))) return false;
		return this.forms()
			.groupOf(p)
			.some((q) => ts.isParameter(q) && !q.getSourceFile().isDeclarationFile && nullableTypeNode(q.type));
	},

	/**
	 * A destructured parameter undefined or null may reach, as its native type holds them: its binding is V8's TypeError
	 * for them (`Cannot destructure property …`), which the function's `throws` and its callers' `try` must know of.
	 */
	destructuresEmpty(this: ValueStates, p: ts.ParameterDeclaration): boolean {
		const b = this.backend;
		return !ts.isIdentifier(p.name) && !p.initializer && ((b.lenient && b.optional(b.typeOf(p.name))) || this.mayBeNull(p));
	},

	/**
	 * A defaulted parameter null may reach: JavaScript applies a default for undefined only, so null arrives. Where its
	 * whole group is strict app code the program's calls decide (`defaultGivenNull`), and it is held `JSNullish<T>`;
	 * elsewhere a member of its group declaring null does (a package's `recycleAsyncId(…, delay: number = 0)` overriding
	 * `delay: number | null = 0`), and its native type takes null.
	 */
	defaultPassesNull(this: ValueStates, p: ts.ParameterDeclaration): boolean {
		if (!p.initializer || p.dotDotDotToken || !ts.isIdentifier(p.name)) return false;
		let found = this.nullPastDefault.get(p);
		if (found === undefined) {
			const forms = this.forms();
			const declared = !forms.declaredForm(p).null && forms.groupOf(p).some((q) => q !== p && ts.isParameter(q) && forms.declaredForm(q).null);
			this.nullPastDefault.set(p, (found = declared || this.defaultGivenNull(p)));
		}
		return found;
	},

	/** A defaulted parameter of strict app code, with every member of its group, that a call gives null. */
	defaultGivenNull(this: ValueStates, p: ts.ParameterDeclaration): boolean {
		const b = this.backend;
		if (b.lenient || b.library || !p.initializer || p.dotDotDotToken || !ts.isIdentifier(p.name)) return false;
		if (ts.skipOuterExpressions(p.initializer).kind === ts.SyntaxKind.NullKeyword) return false;
		let found = this.nullGiven.get(p);
		if (found === undefined) {
			const forms = this.forms();
			const own = (q: ts.Declaration) => ts.isParameter(q) && !q.getSourceFile().isDeclarationFile && this.appCode(q) && b.trust.strictFile(q.getSourceFile()) && ts.isIdentifier(q.name) && !q.dotDotDotToken;
			this.nullGiven.set(p, (found = !forms.fixedSlot(p) && forms.groupOf(p).every(own) && forms.groupOf(p).some((q) => forms.defaultsGivenNull().has(q as ts.ParameterDeclaration))));
		}
		return found;
	},

	/**
	 * Whether an app's parameter is held as its group's form says (`widened`) rather than by its declared type: not where
	 * that form is decided elsewhere (`ownForm`). A destructured one (`({ note }) => …`) is held as the parameter it stands for.
	 */
	formDecides(this: ValueStates, p: ts.ParameterDeclaration): boolean {
		if (p.dotDotDotToken || !this.appParameter(p)) return false;
		let found = this.decidedParams.get(p);
		if (found === undefined) this.decidedParams.set(p, (found = this.ownForm(p)));
		return found;
	},

	/**
	 * An app's parameter that holds what its form holds beyond its declared type: its callers' values, or what any caller
	 * may give where the program can't see them all. The form is its group's (the function type it is given for,
	 * the member it implements or overrides), so every place that spells a member of the group asks this. Swift holds a
	 * string, number or boolean given undefined by its own rules (`looseSlots`, `scriptCalledParameter`).
	 */
	/** The backend's `parameterChecks` where its ledger has `checkedParameters`. */
	parameterChecks(this: ValueStates): ParameterChecks | undefined {
		return this.backend.ledger.checkedParameters ? this.backend.parameterChecks : undefined;
	},
};

export type ParametersMethods = typeof parametersMethods;
