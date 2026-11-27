// A class declaration's accessors as Kotlin: each get/set pair as one property, its setter, and its entry by name.
import ts from 'typescript';
import { ident, isNullable, kotlinString, optionalType, setterMethod, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import type { ClassParts } from './class-declaration.ts';
import type { AccessorPair } from '../semantics/class-plan.ts';
import { forwardedSetter } from '../semantics/lang.ts';
import { hasModifier } from '../semantics/ast.ts';
import { getterOnlyOverride, isStatic } from '../semantics/throws.ts';
import { programBase } from '../semantics/classes.ts';
import { isKit, spelledType } from '../semantics/types.ts';

export const classAccessorsMethods = {
	accessorMembersCode(this: Translator, k: ClassParts): void {
		const accessors = this.accessorPairs(k.cls);
		if (accessors.has('jsToStringTag')) k.supertypes.push('JSToStringTag');
		// A getter over a base class's field holds the field's Kotlin type: optional where the field is, unwrapped where it is read.
		for (const a of accessors.values()) {
			const f = this.fieldUnderGetter(a);
			if (!f || !ts.isPropertyDeclaration(f) || f.parent === k.cls) continue;
			const gsym = this.checker.getSymbolAtLocation(a.get!.name);
			if (gsym && isNullable(this.declaredTypeOf(f.name as ts.Expression) ?? '') && !isNullable(this.typeOf(f.name))) this.nullableDecls.add(gsym);
		}
		for (const [n, a] of accessors) this.accessorMemberCode(k, n, a);
	},

	/** App mode: the base class's field an instance getter redeclares. */
	fieldUnderGetter(this: Translator, a: { get?: ts.GetAccessorDeclaration }): ts.PropertyDeclaration | ts.AccessorDeclaration | ts.ParameterDeclaration | null {
		return !this.library && a.get && !isStatic(a.get) ? this.redeclaredField(a.get as unknown as ts.PropertyDeclaration) : null;
	},

	accessorMemberCode(this: Translator, k: ClassParts, n: string, a: AccessorPair): void {
		const { cls, byName, lines, statics } = k;
		let t = a.get ? this.returnTypeOf(a.get) : optionalType(this.typeOf(a.set!.parameters[0].name));
		// Library mode: an accessor over a base's optional field (`accessibilityServiceEnabled?: boolean`) keeps the field's type.
		const root = this.library && a.get ? this.redeclaredField(a.get as unknown as ts.PropertyDeclaration) : null;
		const rootSym = root && this.checker.getSymbolAtLocation(root.name);
		if (root && ts.isPropertyDeclaration(root) && optionalType(this.typeOf(root.name)) === optionalType(t) && (root.questionToken || (rootSym && this.nullableDecls.has(rootSym)))) t = optionalType(t);
		// `get x(): Narrower { return super.x; }`, a type script asserts and the value need not have (an EditText as a StyleableTextView): the base's.
		const only = a.get?.body?.statements.length === 1 ? a.get.body.statements[0] : undefined;
		const passes = !!only && ts.isReturnStatement(only) && !!only.expression && ts.isPropertyAccessExpression(only.expression) && only.expression.expression.kind === ts.SyntaxKind.SuperKeyword && only.expression.name.text === n;
		if (passes && !a.set && this.native && 'sharedClassType' in this.native) {
			// A subclass redeclaring the member as another Java class (`nativeTextViewProtected: EditText`): the class both extend.
			const redeclared = this.sourceFiles
				.flatMap((f) => (f.isDeclarationFile ? [] : f.statements.filter(ts.isClassDeclaration)))
				.filter((c) => {
					for (let b = programBase(c, this.checker); b; b = programBase(b, this.checker)) if (b === cls) return true;
					return false;
				})
				.flatMap((c) => c.members.filter((m): m is ts.PropertyDeclaration => ts.isPropertyDeclaration(m) && m.name.getText() === n && !!m.type));
			if (redeclared.length) {
				const shared = (this.native as unknown as { sharedClassType(parts: ts.Type[]): string | null }).sharedClassType([this.checker.getSignatureFromDeclaration(a.get!)!.getReturnType(), ...redeclared.map((m) => this.checker.getTypeAtLocation(m.name))]);
				if (shared) {
					t = optionalType(shared);
					this.widenedAccessors.set(a.get!, t);
				}
			}
		}
		// App mode: a getter over a base class's field (`get _childrenCount()` for `_childrenCount: number`): the field's Kotlin
		// property, overridden; a write with no setter here changes nothing, as the getter-only accessor on the prototype takes none.
		const baseField = this.fieldUnderGetter(a);
		if (baseField && ts.isPropertyDeclaration(baseField) && baseField.parent !== cls) {
			const ft = this.declaredTypeOf(baseField.name as ts.Expression) ?? this.typeOf(baseField.name);
			const body = this.functionBody(a.get!, ft, '        ');
			const setter = a.set ? `        set(${ident((a.set.parameters[0].name as ts.Identifier).text)}) ${this.functionBody(a.set, 'Unit', '        ')}` : '        set(@Suppress("UNUSED_PARAMETER") value) {}';
			lines.push(`    override var ${ident(n)}: ${ft}`, `        get() ${body}`, setter);
			return;
		}
		const target = a.get && isStatic(a.get) ? statics : lines;
		const pad = a.get && isStatic(a.get) ? '        ' : '    ';
		const parts: string[] = [];
		// `abstract get name(): T`: each subclass's.
		if (a.get && !a.get.body && hasModifier(a.get, ts.SyntaxKind.AbstractKeyword)) {
			target.push(`${pad}${k.overridden.has(n) ? 'override ' : ''}abstract ${a.set ? 'var' : 'val'} ${ident(n)}: ${t}`);
			return;
		}
		if (a.get) parts.push(`${pad}    get() ${this.functionBody(a.get, t, pad + '    ')}`);
		else parts.push(`${pad}    get() = null`);
		const takes = a.get && a.set ? this.setterTakes(a.set, t) : null;
		if (a.set) this.accessorSetterCode(k, n, a.set, { t, takes, hasGet: !!a.get, target, pad }, parts);
		const getterOnly = !!a.get && !a.set && getterOnlyOverride(a.get, this.checker);
		const refused = `throw ${RT.jsGetterOnlyWrite}(${kotlinString(cls.name?.text ?? '')}, ${kotlinString(n)})`;
		if (getterOnly) parts.push(`${pad}    set(@Suppress("UNUSED_PARAMETER") value) { ${refused} }`);
		let mod = a.get && isStatic(a.get) ? '' : n === 'jsToStringTag' ? 'override ' : this.memberMods(k, n);
		// An open property whose JVM getter a method of the class names: final where no subclass redeclares it, so it can be renamed.
		if (mod === 'open ' && !this.library && ts.isClassDeclaration(cls) && cls.name && this.accessorJvmNames(cls, n, !!a.set, '') && ![...this.sourceClasses().entries()].some(([sub, d]) => d !== cls && this.extendsClass(sub, this.className(cls as ts.ClassDeclaration)) && d.members.some((m) => m.name?.getText() === n))) mod = '';
		target.push(`${pad}${this.accessorJvmNames(cls, n, !!a.set || getterOnly, mod)}${mod}${a.set || getterOnly ? 'var' : 'val'} ${ident(n)}: ${t}`, ...parts);
		// Library mode: read and set by name as well (`node.cssType` of an untyped node), as the prototype's accessor is.
		const own = (a.get ?? a.set)!;
		if ((this.library || byName || k.droppedProtocolMembers.has(n) || this.membersByName(cls) || this.states.downcastClass(cls) || this.states.byNameClass(cls)) && !isStatic(own) && !ts.isPrivateIdentifier(own.name) && !this.symbolMember(own.name) && (k.droppedProtocolMembers.has(n) || this.memberByName(cls, n) || this.states.byNameMember(cls, n))) {
			// A write by name gives the setter what script gave (`style="color: red"` and `color="red"` from the Builder); one
			// passing it to another object's member (`this.style.color = value`) passes it on by name, as that member converts it.
			const forwarded = a.set && !takes ? forwardedSetter(a.set) : null;
			const forward = forwarded && forwarded.expression.kind !== ts.SyntaxKind.ThisKeyword ? forwarded : null;
			const held = a.set && isKit(spelledType(t), 'JSNullish') ? `this.${ident(n)} = ${this.nullishOfAny('value', t.slice('JSNullish<'.length, -1))}` : undefined;
			const set = getterOnly ? refused : takes ? `this.${setterMethod(n)}(${this.fromAnyCode('value', takes, true)})` : forward ? `${RT.jsSet}(${this.expr(forward.expression)}, ${kotlinString(forward.name.text)}, value)` : held;
			k.dynAccessors.push({ name: n, type: t, readable: !!a.get, settable: !!set || (!!a.set && optionalType(this.typeOf(a.set.parameters[0].name)) === optionalType(t)), set });
		}
	},

	/** An accessor pair's setter: its part of the property, added to `parts`, and the setter methods it writes through. */
	accessorSetterCode(this: Translator, k: ClassParts, n: string, set: ts.SetAccessorDeclaration, pair: { t: string; takes: string | null; hasGet: boolean; target: string[]; pad: string }, parts: string[]): void {
		const { cls } = k;
		const { t, takes, hasGet, target, pad } = pair;
		if (takes) {
			const p = set.parameters[0].name;
			let body = this.functionBody(set, 'Unit', pad);
			// A destructured parameter is bound from `__p0`, which the body's prelude takes apart.
			if (!ts.isIdentifier(p)) body = body.replace('{\n', `{\n${pad}    val __p0: ${this.typeOf(p)} = ${this.fromAnyCode('__v', this.typeOf(p), true)}\n`);
			target.push(`${pad}${this.setterTakesMods(cls, n, k.memberOpen)}fun ${setterMethod(n)}(${ts.isIdentifier(p) ? ident(p.text) : '__v'}: ${takes}) ${body}`);
			parts.push(`${pad}    set(__value) { ${setterMethod(n)}(__value) }`);
			return;
		}
		const p = set.parameters[0].name;
		const name = ts.isIdentifier(p) ? ident(p.text) : '__p0';
		const body = this.functionBody(set, 'Unit', pad + '    ');
		// The setter's parameter is the declared one: a body assigning it declares a variable of its own.
		parts.push(hasGet ? `${pad}    set(${name}) ${body}` : `${pad}    set(__value) {\n${pad}        val ${name} = ${['String', 'Double', 'Boolean'].includes(t.replace(/\?$/, '')) ? this.checkedCast('__value', t.replace(/\?$/, ''), n) : this.asserted('__value')}${body.slice(1)}`);
		// A base's setter method is what writes through its type and by name call: here, this class's setter.
		if (!isStatic(set) && this.baseSetterMethod(cls, n)) target.push(`${pad}override fun ${setterMethod(n)}(value: Any?) { this.${ident(n)} = ${t === 'Boolean' ? `${RT.jsTruthy}(value)` : t === 'Double' ? `${RT.jsToNumber}(value)` : this.fromAnyCode('value', t, true)} }`);
	},
};
