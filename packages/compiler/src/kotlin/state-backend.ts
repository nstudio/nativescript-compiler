// What Kotlin answers the shared front's value states with (stateBackend), and its held reads.
import ts from 'typescript';
import { spell, isFunctionType, isNullable, optionalType } from './syntax.ts';
import type { Translator } from './translator.ts';
import type { StateBackend } from '../semantics/states/value-states.ts';
import { accessedDeclaration } from '../semantics/lang.ts';
import { isWriteTarget } from '../semantics/ast.ts';
import { heldAs } from '../semantics/conversion.ts';
import { isNamed, spelledType } from '../semantics/types.ts';
import { keyedClass } from '../semantics/shapes.ts';
import { heldTypes } from '../semantics/spelled.ts';

export const stateBackendMethods = {
	stateBackend(this: Translator): StateBackend {
		const t = this;
		return {
			name: 'kotlin',
			get checker() {
				return t.checker;
			},
			get sourceFiles() {
				return t.sourceFiles;
			},
			get pluginFiles() {
				return t.pluginFiles;
			},
			get pluginRoots() {
				return t.pluginRoots;
			},
			get xmlMemberKeys() {
				return t.xmlMemberKeys;
			},
			get trust() {
				return t.trust;
			},
			get lenient() {
				return t.lenient;
			},
			get lenientApp() {
				return t.lenientApp;
			},
			get assignFields() {
				return t.assignFields;
			},
			get library() {
				return t.library;
			},
			get native() {
				return t.native;
			},
			get framework() {
				return t.framework;
			},
			ledger: this.ledger,
			parameterChecks: { truthTested: (name) => this.truthTested(name), unsetElement: (d) => this.unset.element(d) },
			...heldTypes(this),
			resolve: (n) => this.resolve(n),
			error: (n, what) => this.error(n, what),
			optional: (t) => isNullable(spell(t)),
			functionType: (t) => isFunctionType(spell(t)),
			shapes: this.shapes,
			ownSignature: (fn) => this.ownSignatureMethod(fn),
			looseObjectType: (t) => ((type) => !isNullable(type) && !isFunctionType(type) && !['Any', 'Unit', 'Nothing'].includes(type) && this.isObjectType(type))(spell(t)),
			resultHoldsNull: (d) => this.isObjectType(this.returnTypeOf(d)) && !['String', 'Double', 'Boolean'].includes(this.returnTypeOf(d)),
			augmentedMember: (e) => this.augmentedMember(e),
			nullableParameter: (t) => ((type) => !type.endsWith('?') && !['Double', 'Boolean', 'Unit', 'Nothing'].includes(type) && !isFunctionType(type) && (type === 'String' || this.isObjectType(type)))(spell(t)),
			nulledEntry: (read, code) => this.nulledEntry(read, code),
			optionalShapeField: (e) => this.optionalShapeField(e),
			heldType: (x) => {
				const t = this.heldSpelling(x);
				return heldAs(t, isNullable(t));
			},
			kitNil: (x) => !this.library && !!this.core?.kitNil?.(x),
			declaredOptional: (x) => {
				const sym = this.resolve(x);
				return !!sym && (!!this.undefinedVars.get(sym)?.endsWith('?') || !!this.declaredTypeOf(x)?.endsWith('?'));
			},

			keyedClass: (c) => keyedClass(c, this.states, this.shapeFacts()),
		};
	},

	/**
	 * The carrier the code `expr` emits for a name or member read holds: the checker's type where the read converts
	 * (a narrowed read, an erased member or type-parameter field, a global's or a dynamic object's field), else what it is declared as.
	 */
	readHeld(this: Translator, x: ts.Expression): ReturnType<typeof heldAs> {
		const e = ts.skipOuterExpressions(x, ts.OuterExpressionKinds.Parentheses);
		if (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e)) return this.states.heldType(x);
		if (this.narrowedHeld(e) || this.narrowing(e) || (ts.isPropertyAccessExpression(e) && this.convertingMember(e, false))) {
			const t = this.typeOf(e);
			return heldAs(t, isNullable(t));
		}
		return this.states.heldType(x);
	},

	/**
	 * The arm of `property` that reads `e` as the checker's type, or null where it reads the member as declared: a field of an
	 * erased type parameter or erased generic class (`erased`, skipped while `property` reads the field itself), a name of
	 * the global object (`global`), a dynamic object's field (`dynamic`). `readHeld` reports what `property` emits from this alone.
	 */
	convertingMember(this: Translator, e: ts.PropertyAccessExpression, rawErased: boolean): 'erased' | 'global' | 'dynamic' | null {
		if (this.library) return null;
		const write = isWriteTarget(e);
		if (!rawErased) {
			const decl = accessedDeclaration(this.checker.getSymbolAtLocation(e.name), write);
			const param = decl && (ts.isPropertySignature(decl) || ts.isPropertyDeclaration(decl)) && decl.type && ts.isTypeReferenceNode(decl.type) ? this.checker.getSymbolAtLocation(decl.type.typeName)?.declarations?.[0] : undefined;
			const erasedParam = !!param && ts.isTypeParameterDeclaration(param) && this.erasesTypeParameter(param);
			const erasedMember = (!param || ts.isTypeParameterDeclaration(param)) && !erasedParam && !write ? this.erasedMemberType(decl) : null;
			if (erasedParam || (erasedMember && erasedMember !== this.typeOf(e))) return 'erased';
		}
		if (this.isGlobalObject(e.expression)) return 'global';
		const dynamic = isNamed(spelledType(this.typeOf(e.expression)), 'JSObject', false) && !e.questionDotToken && !!this.resolve(e.name)?.declarations?.every((d) => d.getSourceFile().isDeclarationFile || ts.isEnumMember(d));
		return dynamic ? 'dynamic' : null;
	},

	/** The type Kotlin holds what `x` reads as (`ValueStates.heldType`). */
	heldSpelling(this: Translator, x: ts.Expression): string {
		const sym = ts.isIdentifier(x) ? this.resolve(x) : undefined;
		const local = sym && this.undefinedVars.get(sym);
		if (local?.endsWith('?')) return local;
		const t = this.declaredTypeOf(x) ?? this.typeOf(x);
		return ts.isCallExpression(x) && this.unwrapsResult(x) ? optionalType(t) : t;
	},
};
