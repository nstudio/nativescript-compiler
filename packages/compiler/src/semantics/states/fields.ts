// Which empty states a class's fields may hold: those set to null, and those widened to undefined.
import ts from 'typescript';
import type { ValueStates } from './value-states.ts';
import { fieldLike, mentionsTypeParameter, onlyNull } from './predicates.ts';
import { isStatic } from '../throws.ts';
import { isTemplateMethod, slotOf } from '../trust.ts';
import { literalKey, nullSetFields } from '../lang.ts';
import { programBase } from '../classes.ts';
import { isPrimitive, isUntyped } from '../types.ts';

export const fieldsMethods = {
	/**
	 * A non-strict app's fields its code sets to null (`colors: string[] = null`, `this.indices = h.length ? h : null`): the
	 * native empty value is undefined, so the class notes which hold null (`jsNulls`), and they are written by name, which notes it.
	 * The class plan's null states read it (shapes.ts `KeyState.nulls`); backends read the plan.
	 */
	nullFields(this: ValueStates, cls: ts.ClassLikeDeclaration): Set<string> {
		let set = this.nullFieldSets.get(cls);
		if (set) return set;
		this.nullFieldSets.set(cls, (set = new Set()));
		if (this.backend.keyedClass(cls)) for (const m of this.unheldNullFields(cls)) set.add(m.name.getText());
		return set;
	},

	/**
	 * The fields a class's code sets to a null its type leaves out (lang.ts `nullSetFields`), and those any other code of
	 * the program writes null or undefined to by member (`p.item = null`), which JS lets into any field.
	 */
	nullSetFields(this: ValueStates, cls: ts.ClassLikeDeclaration): ts.PropertyDeclaration[] {
		const own = nullSetFields(cls),
			written = this.nullWritten();
		const nullable = (t: ts.TypeNode) => t.kind === ts.SyntaxKind.AnyKeyword || t.kind === ts.SyntaxKind.UnknownKeyword || (ts.isUnionTypeNode(t) && t.types.some((x) => x.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isLiteralTypeNode(x) && x.literal.kind === ts.SyntaxKind.NullKeyword)));
		// An optional field (`title?: T`) admits undefined: only a null written to it holds both.
		return [...own, ...cls.members.filter((m): m is ts.PropertyDeclaration => ts.isPropertyDeclaration(m) && !own.includes(m) && written.has(m) && !isStatic(m) && ts.isIdentifier(m.name) && !!m.type && !nullable(m.type) && (!m.questionToken || this.nullLiteralWrites.has(m)))];
	},

	/**
	 * The program's class fields and accessors written by member access a null or undefined literal (on something other
	 * than `this`), or a parameter or variable held as `JSNullish<T>`. Asked once the parameters' holding is decided.
	 */
	nullWritten(this: ValueStates): Set<ts.Declaration> {
		if (this.nullWrites) return this.nullWrites;
		if (!this.nullishSlotSet && !this.nullishBuilding) {
			this.nullish();
			if (this.nullWrites) return this.nullWrites;
		}
		const b = this.backend,
			out = (this.nullWrites = new Set<ts.Declaration>());
		const literal = (e: ts.Expression) => ((e = ts.skipOuterExpressions(e)), e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined'));
		const held = (e: ts.Expression) => {
			e = ts.skipOuterExpressions(e);
			const d = ts.isIdentifier(e) ? this.checker.getSymbolAtLocation(e)?.valueDeclaration : undefined;
			return !!d && (ts.isParameter(d) || ts.isVariableDeclaration(d)) && this.nullishHeldSet.has(d);
		};
		// Through an untyped receiver the class isn't known: every class member of that name may be the one written.
		const byName = new Set<string>(),
			nullByName = new Set<string>();
		const undefinedLiteral = (e: ts.Expression) => ((e = ts.skipOuterExpressions(e)), ts.isIdentifier(e) && e.text === 'undefined');
		const member = (d: ts.Declaration) => ts.isClassLike(d.parent) && this.appCode(d) && !d.getSourceFile().isDeclarationFile && (ts.isPropertyDeclaration(d) || ts.isGetAccessorDeclaration(d) || ts.isSetAccessorDeclaration(d));
		const visit =
			(given: (e: ts.Expression, receiver: ts.Expression) => boolean) =>
			(n: ts.Node): void => {
				const left = ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken ? ts.skipOuterExpressions(n.left) : undefined;
				const access = left && (ts.isPropertyAccessExpression(left) || (ts.isElementAccessExpression(left) && ts.isStringLiteralLike(left.argumentExpression))) ? left : undefined;
				if (access && given((n as ts.BinaryExpression).right, access.expression)) {
					const name = ts.isPropertyAccessExpression(access) ? access.name : access.argumentExpression;
					const sym = this.checker.getSymbolAtLocation(name) ?? this.checker.getTypeAtLocation(access.expression).getProperty((name as ts.StringLiteralLike | ts.MemberName).text);
					const own = (sym?.declarations ?? []).filter(member),
						isNull = !undefinedLiteral((n as ts.BinaryExpression).right);
					for (const d of own) {
						out.add(d);
						if (isNull) this.nullLiteralWrites.add(d);
					}
					if (!own.length && this.checker.getTypeAtLocation(access.expression).flags & ts.TypeFlags.Any) {
						byName.add((name as ts.StringLiteralLike | ts.MemberName).text);
						if (isNull) nullByName.add((name as ts.StringLiteralLike | ts.MemberName).text);
					}
				}
				ts.forEachChild(n, visit(given));
			};
		const files = b.sourceFiles.filter((f) => !f.isDeclarationFile && this.appCode(f));
		for (const f of files) visit((e, r) => r.kind !== ts.SyntaxKind.ThisKeyword && literal(e))(f);
		if (byName.size) {
			const classes = (n: ts.Node): void => {
				if (ts.isClassLike(n))
					for (const m of n.members)
						if (m.name && ts.isIdentifier(m.name) && byName.has(m.name.text) && member(m)) {
							out.add(m);
							if (nullByName.has(m.name.text)) this.nullLiteralWrites.add(m);
						}
				ts.forEachChild(n, classes);
			};
			for (const f of files) classes(f);
		}
		// An accessor pair given null or undefined holds both: its setter's parameter and its getter's result, as a field would.
		for (const d of [...out]) {
			if (!ts.isSetAccessorDeclaration(d) && !ts.isGetAccessorDeclaration(d)) continue;
			const siblings: readonly ts.Node[] = ts.isObjectLiteralExpression(d.parent) ? d.parent.properties : d.parent.members;
			const pair = siblings.filter((m): m is ts.AccessorDeclaration => (ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) && m.name.getText() === d.name.getText() && isStatic(m) === isStatic(d));
			const slots = pair.flatMap((m): ts.Declaration[] => (ts.isGetAccessorDeclaration(m) ? [m] : m.parameters.slice(0, 1)));
			if (slots.flatMap((x) => [x, ...this.forms().groupOf(x)]).every((x) => this.appCode(x) && !x.getSourceFile().isDeclarationFile)) for (const x of slots) this.nullishHeldSet.add(x);
		}
		for (const f of files) visit((e) => held(e))(f);
		return out;
	},

	/** The fields `nullFields` notes on a class with key members (`ValueStates.keyedClass`); a class without holds them as `JSNullish<T>`. */
	unheldNullFields(this: ValueStates, cls: ts.ClassLikeDeclaration): Set<ts.PropertyDeclaration | ts.ParameterDeclaration> {
		const b = this.backend,
			set = new Set<ts.PropertyDeclaration | ts.ParameterDeclaration>();
		// A field set to a null its type leaves out is non-strict code, whatever the app's configuration says.
		if (b.lenient || b.library || cls.getSourceFile().isDeclarationFile || this.plugin(cls)) return set;
		for (const m of this.nullSetFields(cls)) if (!isUntyped(b.typeOf(m.name)) && !this.nullishHeld(m)) set.add(m);
		for (const m of cls.members) if (ts.isPropertyDeclaration(m) && this.nullish().fields.has(m) && !isUntyped(b.typeOf(m.name)) && !this.nullishHeld(m)) set.add(m);
		const ctor = cls.members.find(ts.isConstructorDeclaration);
		const properties = ctor?.parameters.filter((p) => ts.isParameterPropertyDeclaration(p, ctor)) ?? [];
		for (const m of [...cls.members, ...properties]) if ((ts.isPropertyDeclaration(m) ? this.widenedField(m) && !this.nullishHeld(m) : ts.isParameter(m) && (this.widenedField(m) || this.nullishHeld(m))) && this.forms().formOfSlot(m).null && !isUntyped(b.typeOf(m.name!))) set.add(m as ts.PropertyDeclaration | ts.ParameterDeclaration);
		return set;
	},

	/**
	 * The fields of `nullFields` the backend stores as a string, number or boolean, whose storage can only hold its zero:
	 * the class notes which hold undefined as well (`jsUnset`).
	 */
	zeroNullFields(this: ValueStates, cls: ts.ClassLikeDeclaration): Set<string> {
		const b = this.backend;
		const ctor = cls.members.find(ts.isConstructorDeclaration);
		const properties = ctor?.parameters.filter((p) => ts.isParameterPropertyDeclaration(p, ctor)) ?? [];
		const nulls = this.nullFields(cls);
		return new Set([...cls.members, ...properties].filter((m): m is ts.PropertyDeclaration | ts.ParameterPropertyDeclaration => (ts.isPropertyDeclaration(m) || ts.isParameter(m)) && nulls.has(m.name.getText()) && isPrimitive(b.typeOf(m.name))).map((m) => m.name.getText()));
	},

	/** The class declares its objects' `jsUnset`: it has `zeroNullFields` and no program base does (one per object). */
	declaresUnset(this: ValueStates, cls: ts.ClassLikeDeclaration): boolean {
		if (!this.zeroNullFields(cls).size) return false;
		for (let base = programBase(cls, this.backend.checker); base; base = programBase(base, this.backend.checker)) if (this.zeroNullFields(base).size) return false;
		return true;
	},

	/**
	 * Strict code's fields typed `T | null` that start with a value (an initializer, a constructor parameter's): an empty
	 * value in them is null. So in library code is a `lenientNullField` once its key is made.
	 */
	nullFieldsTyped(this: ValueStates, cls: ts.ClassLikeDeclaration): Set<string> {
		const set = new Set<string>();
		const b = this.backend;
		if (b.library) for (const m of cls.members) if (ts.isPropertyDeclaration(m) && ts.isIdentifier(m.name) && !isStatic(m) && this.lenientNullField(m)) set.add(m.name.text);
		if (b.lenient || b.library || cls.getSourceFile().isDeclarationFile || this.plugin(cls)) return set;
		const ctor = cls.members.find(ts.isConstructorDeclaration);
		const given = [...cls.members.filter((m): m is ts.PropertyDeclaration => ts.isPropertyDeclaration(m) && !!m.initializer && !isStatic(m)), ...(ctor?.parameters.filter((p) => ts.isParameterPropertyDeclaration(p, ctor)) ?? [])];
		for (const m of given) if (ts.isIdentifier(m.name) && onlyNull(this.checker.getTypeAtLocation(m.name))) set.add(m.name.text);
		return set;
	},

	/**
	 * An app's field (a class's, an interface's or type literal's, a parameter property) whose group's form holds null or
	 * undefined its declared type leaves out: a widened call's result, an element past the end, a field never assigned.
	 * Every member of the group answers alike, so overrides, the interface member a class implements and the literals given
	 * for it are spelled as one.
	 */
	widenedField(this: ValueStates, d: ts.Declaration): boolean {
		const b = this.backend;
		if (b.library || b.lenient || !fieldLike(d)) return false;
		let found = this.widenedFieldSet.get(d);
		if (found !== undefined) return found;
		const forms = this.forms(),
			group = forms.groupOf(d);
		const overBaseAccessor = (m: ts.Declaration): boolean => {
			if (!ts.isPropertyDeclaration(m) && !ts.isParameter(m)) return false;
			const cls = ts.isPropertyDeclaration(m) ? m.parent : m.parent.parent;
			if (!ts.isClassLike(cls)) return false;
			const name = m.name.getText();
			for (let base = programBase(cls, this.checker); base; base = programBase(base, this.checker)) {
				if (base.members.some((x) => ts.isAccessor(x) && !isStatic(x) && x.name?.getText() === name)) return true;
			}
			return false;
		};
		found = !forms.fixedSlot(d) && !group.some(overBaseAccessor) && group.every((m) => m === d || !fieldLike(m) || (!m.getSourceFile().isDeclarationFile && this.appCode(m)));
		if (found) {
			const declared = forms.declaredForm(d),
				form = forms.formOfSlot(d);
			// Every member's type, as the answer is the group's: an `any` base field holds its narrower override untyped.
			const plain =
				!form.foreign &&
				group.every((m) => {
					if (m !== d && !fieldLike(m)) return true;
					const t = this.checker.getTypeAtLocation(m);
					return !forms.declaredForm(m).foreign && !(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) && !mentionsTypeParameter(this.checker, t);
				});
			// A class field narrower than an optional member it implements (`title = 'x'` for `title?: string`): script may
			// write undefined through the interface, and the class's own reads then read it.
			const optional = group.some((m) => ts.isPropertySignature(m) && ts.isInterfaceDeclaration(m.parent) && fieldLike(m) && !!m.questionToken);
			const narrower = optional && group.some((m) => !ts.isPropertySignature(m) && fieldLike(m) && !forms.declaredForm(m).undefined);
			const primitiveType = (t: ts.Type): boolean => {
				const parts = t.isUnion() ? t.types : [t];
				return parts.length > 0 && parts.every((p) => !(p.flags & ts.TypeFlags.EnumLike)) && (parts.every((p) => !!(p.flags & ts.TypeFlags.StringLike)) || parts.every((p) => !!(p.flags & ts.TypeFlags.NumberLike)) || parts.every((p) => !!(p.flags & ts.TypeFlags.BooleanLike)));
			};
			const escaped = form.untyped && form.undefined && !declared.undefined && group.some((m) => ts.isPropertyDeclaration(m) || ts.isParameter(m)) && group.every((m) => !fieldLike(m) || primitiveType(this.checker.getTypeAtLocation(m)));
			found = plain && (narrower || escaped || (form.absent && ((form.null && !declared.null) || (form.undefined && !declared.undefined))));
		}
		for (const m of group) if (fieldLike(m)) this.widenedFieldSet.set(m, found);
		this.widenedFieldSet.set(d, found);
		return found;
	},

	/**
	 * The app field a value is placed in: a literal's property, an assignment, an initializer, a parameter property's
	 * argument. A value its form doesn't hold missing that turns out missing there (a callback's result Form doesn't
	 * follow) is JavaScript's TypeError naming the field, never a value made up for it.
	 */
	placedField(this: ValueStates, e: ts.Expression): { decl: ts.Declaration; name: string } | null {
		const b = this.backend;
		if (b.library || b.lenient || !e.parent || !this.appCode(e)) return null;
		let x: ts.Node = e;
		while (ts.isParenthesizedExpression(x.parent)) x = x.parent;
		// A literal's own property where nothing types the literal (`map`'s callback result, an untyped variable's): the
		// field of the shape it makes.
		const d = slotOf(e, this.checker) ?? (ts.isPropertyAssignment(x.parent) && x.parent.initializer === x ? x.parent : null);
		if (!d || d.getSourceFile().isDeclarationFile || this.packaged(d)) return null;
		if (fieldLike(d) || (ts.isPropertyAssignment(d) && ts.isIdentifier(d.name))) return { decl: d, name: (d as ts.NamedDeclaration).name!.getText() };
		// A template's binding method gives the template glue the type it declares: named by the member it reads.
		const read = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
		if (isTemplateMethod(d)) return { decl: d, name: ts.isPropertyAccessExpression(read) ? read.name.text : 'value' };
		return null;
	},

	/** A declared member the framework model says may hold undefined at run time though its type leaves it out. */
	unsetMember(this: ValueStates, d: ts.Declaration | undefined): boolean {
		return !!d && (ts.isPropertySignature(d) || ts.isPropertyDeclaration(d)) && !!this.backend.framework.hooks.unsetMembers?.(d, this.checker);
	},

	/** An anonymous object shape's primitive field (or a framework `unsetMembers` field) whose form admits undefined or an unchecked foreign value. */
	shapeFieldOptional(this: ValueStates, prop: ts.Symbol): boolean {
		const decls = prop.valueDeclaration ? [prop.valueDeclaration, ...(prop.declarations ?? [])] : (prop.declarations ?? []);
		if (decls.some((x) => this.unsetMember(x))) return true;
		const d = decls.find((x) => !x.getSourceFile().isDeclarationFile && (ts.isPropertyAssignment(x) || ts.isShorthandPropertyAssignment(x) || (ts.isPropertySignature(x) && ts.isTypeLiteralNode(x.parent) && !ts.isTypeAliasDeclaration(x.parent.parent))));
		if (!d) return false;
		const literal = ts.isPropertyAssignment(d) || ts.isShorthandPropertyAssignment(d);
		const forms = this.forms();
		if (forms.fixedSlot(d)) return false;
		const form = forms.formOfSlot(d);
		if (this.backend.library || !this.backend.trust.strictFile(d.getSourceFile())) {
			return literal && forms.groupOf(d).some((m) => ts.isPropertyAssignment(m) && ((x) => (ts.isIdentifier(x) && x.text === 'undefined') || ts.isVoidExpression(x))(ts.skipOuterExpressions(m.initializer)));
		}
		if (!this.appCode(d) || this.nullish().held.has(d) || this.nullishHeld(d)) return false;
		return (form.undefined && (form.given || form.absent || form.missing)) || (form.foreign && !form.typeObserved);
	},

	/** A binding of an object pattern reading an optional shape field or an untyped initializer. */
	optionalObjectPiece(this: ValueStates, d: ts.Declaration): boolean {
		if (this.backend.library || this.backend.lenient || !ts.isBindingElement(d) || !ts.isIdentifier(d.name) || d.initializer || d.dotDotDotToken || !ts.isObjectBindingPattern(d.parent)) return false;
		if (!this.appCode(d) || this.nullish().held.has(d) || this.nullishHeld(d)) return false;
		const key = literalKey(d.propertyName ?? d.name, this.checker);
		const prop = key !== null ? this.checker.getNonNullableType(this.checker.getTypeAtLocation(d.parent)).getProperty(key) : undefined;
		const propDecl = prop?.valueDeclaration ?? prop?.declarations?.[0];
		if (prop && this.unsetMember(propDecl)) return true;
		if (!this.primitive(this.backend.typeOf(d.name))) return false;
		if (prop && this.shapeFieldOptional(prop)) return true;
		let holder: ts.Node = d.parent.parent;
		while (ts.isBindingElement(holder)) holder = holder.parent.parent;
		return ts.isVariableDeclaration(holder) && !!holder.initializer && this.untypedValue(holder.initializer);
	},

	/** Every app field `widenedField` answers. */
	widenedFields(this: ValueStates): readonly ts.Declaration[] {
		const b = this.backend,
			out: ts.Declaration[] = [];
		if (b.library || b.lenient) return out;
		const visit = (n: ts.Node): void => {
			if (fieldLike(n as ts.Declaration) && this.widenedField(n as ts.Declaration)) out.push(n as ts.Declaration);
			ts.forEachChild(n, visit);
		};
		for (const f of b.sourceFiles) if (!f.isDeclarationFile && this.appCode(f)) visit(f);
		return out;
	},
};

export type FieldsMethods = typeof fieldsMethods;
