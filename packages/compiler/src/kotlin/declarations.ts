// Declarations as Kotlin: declaration lists, variables and how they are held, and bindings of destructured values.
import ts from 'typescript';
import { awaitSlot, type AwaitSlot } from '../semantics/placement.ts';
import { assignsTo, functionTypeParts, ident, isFunctionType, isNullable, kotlinString, optionalType, refersTo, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { redeclaredVar } from '../semantics/ast.ts';
import { givenBy, onlyNullOrPresent, reassigned } from '../semantics/nullish.ts';
import { classStaticsPattern, isConstant, prototypeAlias } from '../semantics/lang.ts';
import { isStatic } from '../semantics/throws.ts';
import { programBase } from '../semantics/classes.ts';
import { definedField } from '../semantics/shapes.ts';
import { isKit, isNamed, isUntyped, spelledType } from '../semantics/types.ts';

export const declarationsMethods = {
	declarationList(this: Translator, list: ts.VariableDeclarationList, lowered: boolean): string {
		const constant = !!(list.flags & ts.NodeFlags.Const);
		// A `let` or `var` set once, where it is declared, is a constant too.
		const once = (d: ts.VariableDeclaration) =>
			(!lowered || ts.isForStatement(list.parent)) &&
			!!d.initializer &&
			ts.isIdentifier(d.name) &&
			!redeclaredVar(d, this.checker) &&
			(this.checker.getSymbolAtLocation(d.name)?.declarations?.length ?? 0) === 1 &&
			!assignsTo(
				ts.findAncestor(d, (n) => ts.isFunctionLike(n) || ts.isSourceFile(n))!,
				this.checker.getSymbolAtLocation(d.name),
				this.checker,
			);
		return list.declarations.map((d) => this.declaration(d, constant || once(d), lowered)).join('\n');
	},

	/** An `optionalVariable`'s initializer stored as the optional `type`: a read converting undefined gives that undefined. */
	heldStore(this: Translator, d: ts.VariableDeclaration, type: string): string {
		const code = this.stored(d.initializer!, d, type);
		return this.undefinedConverted(code) ?? code;
	},

	declaration(this: Translator, d: ts.VariableDeclaration, constant: boolean, lowered: boolean): string {
		const i = this.indent;
		const extension = this.native?.extensionClass(d);
		if (extension) return extension;
		if (this.patterns.requiredCore(d) || this.native?.isClassAlias(d) || prototypeAlias(this, d)) return '';
		if (ts.isIdentifier(d.name)) {
			// A variable only ever undefined (this platform's half of `__APPLE__ ? x : undefined`) holds nothing: any value.
			let t = this.typeOf(d.name) === 'Unit' ? 'Any?' : this.typeOf(d.name);
			const parts = this.literalFunctionLocal(d) ? functionTypeParts(t) : null;
			if (parts) t = `(${parts.params.map((p) => (this.isObjectType(p) ? optionalType(p) : p)).join(', ')}) -> ${parts.ret}`;
			const name = ident(d.name.text);
			if (this.forwardDeclared.has(d) || this.scopedDeclared.has(d)) return d.initializer ? `${i}${ident(this.topName(d, d.name.text))} = ${this.stored(d.initializer, d, t)}` : '';
			// `var m` again in the same block, or a module's `var` again in a nested block: the same variable, assigned.
			if (redeclaredVar(d, this.checker)) return d.initializer ? `${i}${this.lvalue(d.name)} = ${this.stored(d.initializer, d, t)}` : '';
			if (this.states.nullishHeld(d)) return `${i}${constant && (!lowered || ts.isForStatement(d.parent.parent)) ? 'val' : 'var'} ${name}: ${t} = ${d.initializer ? this.stored(d.initializer, d, t) : 'JSNullish.Undefined'}`;
			const nullInit = !!d.initializer && (d.initializer.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(d.initializer) && d.initializer.text === 'undefined'));
			if ((nullInit || (!d.initializer && !lowered)) && this.pluginFiles.has(d.getSourceFile().fileName) && !t.endsWith('?') && this.isObjectType(t)) {
				// Unset (or `null`) in code checked without strictNullChecks: nullable, unwrapped where it is read.
				const sym = this.checker.getSymbolAtLocation(d.name);
				if (sym) this.nullableDecls.add(sym);
				return `${i}var ${name}: ${optionalType(t)} = null`;
			}
			// Library mode: a string, number or boolean given a value whose nil is null (`libraryNull`): nullable.
			if (this.library && !lowered && ['String', 'Double', 'Boolean'].includes(t) && this.states.libraryNullVariable(d.name)?.only) {
				const sym = this.checker.getSymbolAtLocation(d.name);
				if (sym) this.nullableDecls.add(sym);
				return d.initializer ? `${i}${constant ? 'val' : 'var'} ${name}: ${optionalType(t)} = ${this.stored(d.initializer, d, optionalType(t))}` : `${i}var ${name}: ${optionalType(t)} = null`;
			}
			// Library mode: a string declared unset and set null somewhere (`let uri: string; ... uri = null`): null until set, as Java takes it.
			if (this.library && !d.initializer && !lowered && t === 'String' && this.assignedNull(d)) {
				const sym = this.checker.getSymbolAtLocation(d.name);
				if (sym) this.nullableDecls.add(sym);
				return `${i}var ${name}: String? = null`;
			}
			// Library mode: `a ?? null`, `a || null`: nullable, whatever the type (unchecked for null) says.
			const orNull = !!d.initializer && ts.isBinaryExpression(d.initializer) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(d.initializer.operatorToken.kind) && d.initializer.right.kind === ts.SyntaxKind.NullKeyword;
			if (this.library && orNull && !lowered && !t.endsWith('?') && t !== 'Any' && (this.isObjectType(t) || isFunctionType(t))) {
				const sym = this.checker.getSymbolAtLocation(d.name);
				if (sym) this.nullableDecls.add(sym);
				return `${i}${constant ? 'val' : 'var'} ${name}: ${optionalType(t)} = ${this.stored(d.initializer!, d, optionalType(t))}`;
			}
			// Library mode: `const title = view['title'] as string`, `let result = this._cache[key]`: nullable, as the member may be missing.
			const recordRead = !!d.initializer && ts.isElementAccessExpression(d.initializer) && !d.initializer.questionDotToken && (/^JSRecord<.*>\??$/.test(this.typeOf(d.initializer.expression)) || (this.isAny(d.initializer.expression) && ['String', 'Double', 'Boolean'].includes(t))) && !isNullable(t) && t !== 'Any';
			// So is a function read from an untyped object (`const getItem = (<ItemsSource>src).getItem`), which it may lack.
			let read = d.initializer;
			while (read && (ts.isParenthesizedExpression(read) || ts.isAsExpression(read) || ts.isTypeAssertionExpression(read))) read = read.expression;
			const untypedRead = (x: ts.Expression): boolean => {
				while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isTypeAssertionExpression(x)) x = x.expression;
				if (ts.isPropertyAccessExpression(x)) return this.isAny(x.expression);
				if (ts.isBinaryExpression(x) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(x.operatorToken.kind)) return untypedRead(x.left) || untypedRead(x.right);
				if (ts.isConditionalExpression(x)) return untypedRead(x.whenTrue) || untypedRead(x.whenFalse);
				return false;
			};
			const untypedFunction = !!read && isFunctionType(t) && untypedRead(read);
			if (d.initializer && !lowered && ((this.library && (this.untypedAssertion(d.initializer) || untypedFunction)) || (recordRead && (this.library || this.pluginFiles.has(d.getSourceFile().fileName))))) {
				const sym = this.checker.getSymbolAtLocation(d.name);
				if (sym) this.nullableDecls.add(sym);
				return `${i}${constant ? 'val' : 'var'} ${name}: ${optionalType(t)} = ${this.stored(d.initializer, d, optionalType(t))}`;
			}
			// Library mode: a call's `string | null`, compared with null: nullable.
			const call = read && ts.isCallExpression(read) ? this.checker.getResolvedSignature(read)?.declaration : undefined;
			if (this.library && d.initializer && !lowered && ['String', 'Double', 'Boolean'].includes(t) && this.nullablePrimitiveReturn(call) && this.testedForUndefined(d)) {
				const sym = this.checker.getSymbolAtLocation(d.name);
				if (sym) this.nullableDecls.add(sym);
				return `${i}${constant ? 'val' : 'var'} ${name}: ${optionalType(t)} = ${this.stored(d.initializer, d, optionalType(t))}`;
			}
			// Library mode: a copy of a getter's `string | undefined` the code tests or unsets (`namespace = undefined`): nullable.
			if (this.library && read && ts.isPropertyAccessExpression(read) && !lowered && ['String', 'Double', 'Boolean'].includes(t) && isNullable(this.declaredTypeOf(read) ?? '') && (this.testedForUndefined(d) || this.assignedNull(d))) {
				const sym = this.checker.getSymbolAtLocation(d.name);
				if (sym) this.nullableDecls.add(sym);
				return `${i}${constant ? 'val' : 'var'} ${name}: ${optionalType(t)} = ${this.stored(d.initializer!, d, optionalType(t))}`;
			}
			// Library mode: `a && b`, compared with null: whatever `b`'s type, null where `a` is.
			if (this.library && read && ts.isBinaryExpression(read) && read.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && !lowered && ['String', 'Double', 'Boolean'].includes(t) && this.testedForUndefined(d)) {
				const sym = this.checker.getSymbolAtLocation(d.name);
				if (sym) this.nullableDecls.add(sym);
				return `${i}${constant ? 'val' : 'var'} ${name}: ${optionalType(t)} = ${this.stored(d.initializer!, d, optionalType(t))}`;
			}
			// Library mode: a registered property's string, number or boolean (`const title = this.title`), compared with undefined:
			// undefined while unset, which its accessor reads as the type's zero.
			const registered = read && ts.isPropertyAccessExpression(read) ? this.resolve(read.name)?.valueDeclaration : undefined;
			if (this.library && read && ts.isPropertyAccessExpression(read) && !lowered && ['String', 'Double', 'Boolean'].includes(t) && registered && ts.isPropertyDeclaration(registered) && ts.isClassLike(registered.parent) && (this.properties?.isRegistered(registered.parent, read.name.text) || this.properties?.isRegisteredAnywhere(read.name.text)) && this.testedForUndefined(d)) {
				const sym = this.checker.getSymbolAtLocation(d.name);
				if (sym) this.nullableDecls.add(sym);
				const value = `${RT.jsExpandoGet}(${this.expr(read.expression)}, ${kotlinString(read.name.text)})`;
				return `${i}${constant ? 'val' : 'var'} ${name}: ${optionalType(t)} = ${t === 'String' ? `${RT.jsStringOrNull}(${value})` : `(${value} as? ${t})`}`;
			}
			// A plugin's copy of a value declared nullable (`const side = this.mShowingSide`): nullable as well.
			if (d.initializer && !lowered && this.pluginFiles.has(d.getSourceFile().fileName) && !isNullable(t) && t !== 'Any' && !isUntyped(spelledType(t)) && isNullable(this.declaredTypeOf(d.initializer) ?? '')) {
				const sym = this.checker.getSymbolAtLocation(d.name);
				if (sym) this.nullableDecls.add(sym);
				return `${i}${constant ? 'val' : 'var'} ${name}: ${optionalType(t)} = ${this.stored(d.initializer, d, optionalType(t))}`;
			}
			// A plugin's object variable that code assigns again (`parent = parent.parent` until there is none): nullable as well.
			if (d.initializer && !constant && !lowered && this.pluginFiles.has(d.getSourceFile().fileName) && !t.endsWith('?') && this.isObjectType(t) && !isFunctionType(t)) {
				const sym = this.checker.getSymbolAtLocation(d.name);
				if (sym) this.nullableDecls.add(sym);
				return `${i}var ${name}: ${optionalType(t)} = ${this.stored(d.initializer, d, optionalType(t))}`;
			}
			// A literal first value nothing reads (`let fps = 0` set again before any read) is left out.
			const deadLiteral = !!d.initializer && !constant && isConstant(d.initializer) && !this.pluginFiles.has(d.getSourceFile().fileName);
			const set = (!d.initializer || deadLiteral) && !lowered ? this.assignedBeforeUse(d) : null;
			if (set) return `${i}${set === 'once' ? 'val' : 'var'} ${name}: ${t}`;
			// Lenient code may read it before any assignment (`let found: boolean; … typeof found`): undefined until assigned.
			if (!d.initializer && (this.lenient || this.lenientApp) && !lowered && ['String', 'Double', 'Boolean'].includes(t) && !this.assignedBeforeUse(d, true)) {
				const sym = this.resolve(d.name);
				if (sym) this.undefinedVars.set(sym, optionalType(t));
				return `${i}var ${name}: ${optionalType(t)} = null`;
			}
			if (!d.initializer) return `${i}${lowered || !t.endsWith('?') ? this.deferredDeclaration(name, t) : `var ${name}: ${t} = null`}`;
			// A value whose functions name it (a function calling itself, a listener removing itself): declared first, so they can.
			if (refersTo(d.initializer, this.checker.getSymbolAtLocation(d.name), this.checker)) {
				return `${i}${t.endsWith('?') ? `var ${name}: ${t} = null` : this.deferredDeclaration(name, t)}\n${i}${name} = ${this.stored(d.initializer, d, t)}`;
			}
			const maybe = (!lowered || ts.isAwaitExpression(ts.skipOuterExpressions(d.initializer))) && !t.endsWith('?') ? (this.maybeUndefined(d.initializer) ?? (this.states.optionalElementRead(ts.skipOuterExpressions(d.initializer, ts.OuterExpressionKinds.Parentheses)) ? this.expr(d.initializer) : null) ?? (this.states.optionalVariable(d) ? this.heldStore(d, optionalType(t)) : null)) : !t.endsWith('?') && this.states.optionalVariable(d) ? this.heldStore(d, optionalType(t)) : null;
			this.noteNullVar(d);
			if (maybe) {
				const sym = this.resolve(d.name);
				if (sym) this.undefinedVars.set(sym, optionalType(t));
				// An untyped value (`args[1]` of `...args`) where the declaration names a type: as that type.
				const read = (this.isAny(d.initializer) || this.untypedElement(d.initializer)) && !isUntyped(spelledType(t)) ? (this.checkedPlacement(d.initializer, optionalType(t), maybe, this.storeSlot(d.initializer, optionalType(t), d)) ?? this.fromAny(maybe, optionalType(t))) : this.nullableArrayAs(maybe, this.typeOf(d.initializer), t);
				return `${i}${constant ? 'val' : 'var'} ${name}: ${optionalType(t)} = ${read}`;
			}
			// An untyped value asserted a Java class its uses need only a superclass of: held as that class, unchecked as script's assertion is.
			const wider = !this.library && ts.isIdentifier(d.name) ? this.widerAsserted(d) : null;
			if (wider) {
				const inner = (ts.skipOuterExpressions(d.initializer, ts.OuterExpressionKinds.Parentheses) as ts.AsExpression).expression;
				return `${i}${constant && (!lowered || ts.isForStatement(d.parent.parent)) ? 'val' : 'var'} ${name}: ${wider} = ${RT.jsUnchecked}<${wider}>(${RT.jsJavaArgument}(${this.coerce(inner, 'Any?')}))`;
			}
			// Library mode: a function value's own Kotlin type, its parameters as lenient as its calls pass them.
			if (this.library && constant && !lowered && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) && d.initializer.parameters.some((p) => this.states.mayBeNull(p))) return `${i}val ${name} = ${this.stored(d.initializer, d, t)}`;
			if (parts && !lowered) {
				let literal = d.initializer;
				while (ts.isParenthesizedExpression(literal)) literal = literal.expression;
				return `${i}val ${name}: ${t} = ${this.closure(literal as ts.ArrowFunction | ts.FunctionExpression)}`;
			}
			return `${i}${constant && (!lowered || ts.isForStatement(d.parent.parent)) ? 'val' : 'var'} ${name}: ${t} = ${this.stored(d.initializer, d, t)}`;
		}
		const statics = this.staticBindings(d, !constant);
		if (statics !== null) return statics;
		const tmp = this.fresh('__d');
		return `${i}val ${tmp}${this.destructured(d.name, d.initializer!)}\n${this.bindTo(d.name, tmp, this.untypedPattern(d.name, d.initializer!) ? 'Any?' : '', !constant)}`;
	},

	/**
	 * A pattern destructuring a class's statics (`classStaticsPattern`): each binding the static read it is
	 * (`Build.FINGERPRINT`). Null where the class is no Java or Kotlin class named by its name.
	 */
	staticBindings(this: Translator, d: ts.VariableDeclaration, mutable: boolean | 'assign'): string | null {
		const bindings = classStaticsPattern(d, this.checker);
		if (!bindings) return null;
		const init = ts.skipOuterExpressions(d.initializer!, ts.OuterExpressionKinds.Parentheses);
		const value = this.expr(init);
		const suffix = '::class.java';
		if (!value.endsWith(suffix) || !/^[\w.`]+$/.test(value.slice(0, -suffix.length))) return null;
		const receiver = value.slice(0, -suffix.length);
		const cls = this.resolve(ts.isPropertyAccessExpression(init) ? init.name : init)?.valueDeclaration;
		const i = this.indent;
		return bindings
			.map(({ name, key, member }) => {
				// Kotlin's companion members are not inherited: a base's static is read on the base.
				const owner = member.declarations![0].parent;
				const read = `${ts.isClassDeclaration(owner) && owner !== cls && !owner.getSourceFile().isDeclarationFile ? this.className(owner) : receiver}.${ident(key)}`;
				if (mutable === 'assign') return `${i}${ident(this.topName(name.parent, name.text))} = ${read}`;
				let t = this.typeOf(name);
				if (this.states.optionalBinding(name)) t = this.bindsOptional(name, t);
				// Library mode: an object a destructuring binds may be undefined: nullable, unwrapped where it is read.
				if (this.library && this.isObjectType(t) && !isNullable(t) && !isFunctionType(t)) {
					const sym = this.checker.getSymbolAtLocation(name);
					if (sym) this.nullableDecls.add(sym);
					t = optionalType(t);
				}
				return `${i}${mutable ? 'var' : 'val'} ${ident(name.text)}: ${t} = ${read}`;
			})
			.join('\n');
	},

	/**
	 * Declarations binding `name` (an identifier or a destructuring pattern) to the Kotlin value `value`.
	 * `type` is `Any?` where the value is untyped whatever the pattern's type says.
	 */
	bindTo(this: Translator, name: ts.BindingName, value: string, type: string, mutable: boolean | 'assign'): string {
		const i = this.indent;
		const kw = mutable === 'assign' ? '' : mutable ? 'var ' : 'val ';
		const declare = (n: ts.Identifier, t: string, v: string) => {
			if (mutable === 'assign') return `${i}${ident(this.topName(n.parent, n.text))} = ${v}`;
			if (this.states.optionalBinding(n)) t = this.bindsOptional(n, t);
			// Lenient code: an object a destructuring binds may be undefined (a field left unset): nullable, unwrapped where it is read.
			if (this.library && ((ts.isObjectBindingPattern(name) && this.isObjectType(t)) || (ts.isArrayBindingPattern(name) && ['String', 'Double', 'Boolean'].includes(t))) && !isNullable(t) && !isFunctionType(t)) {
				const sym = this.checker.getSymbolAtLocation(n);
				if (sym) this.nullableDecls.add(sym);
				return `${i}${kw}${ident(n.text)}: ${optionalType(t)} = ${v}`;
			}
			return `${i}${kw}${ident(n.text)}: ${t} = ${v}`;
		};
		if (ts.isIdentifier(name)) return declare(name, this.typeOf(name), isUntyped(spelledType(type)) && !this.isAny(name) ? this.fromAnyCode(value, this.typeOf(name), true) : value);
		const lines: string[] = [];
		const source = this.checker.getTypeAtLocation(name);
		const count = this.checker.isTupleType(source) ? this.checker.getTypeArguments(source as ts.TypeReference).length : 0;
		const held = (type || this.typeOf(name)).replace(/\?$/, '');
		// A short tuple Kotlin holds as an array (one with a rest element, or on a recursive alias's cycle) is read as an array.
		const tuple = count <= 3 && isKit(spelledType(held), 'JSArray') ? 0 : count;
		// A tuple of more than three elements is an untyped array: each element read as the pattern types it.
		const elementType = (k: number) => this.typeOf((name.elements[k] as ts.BindingElement).name);
		const tupleField = (k: number) => (isUntyped(spelledType(type)) ? this.fromAnyCode(`${RT.jsField}(${value}, "${k}")`, elementType(k), true) : tuple === 2 || tuple === 3 ? `${value}.${['first', 'second', 'third'][k]}` : isUntyped(spelledType(elementType(k))) ? `${value}[${k}]` : this.fromAnyCode(`${value}[${k}]`, elementType(k), true));
		name.elements.forEach((el, k) => {
			if (ts.isOmittedExpression(el)) return;
			if (el.dotDotDotToken) {
				if (ts.isObjectBindingPattern(name)) {
					const taken = name.elements
						.filter((x) => x !== el)
						.map((x) => {
							const key = x.propertyName ?? x.name;
							if (!ts.isIdentifier(key) && !ts.isStringLiteral(key)) throw this.error(x, 'a computed key beside an object rest pattern');
							return kotlinString(key.text);
						});
					lines.push(this.bindTo(el.name, `${RT.jsObjectRest}(${value}, listOf(${taken.join(', ')}))`, 'Any?', mutable));
					return;
				}
				// A Pair or Triple's fields from here on, as the array the rest element makes.
				if ((tuple === 2 || tuple === 3) && !isUntyped(spelledType(type))) {
					const restType = this.typeOf(el.name).replace(/\?$/, '');
					const args = this.checker.getTypeArguments(source as ts.TypeReference);
					const field = (j: number) => `${value}.${['first', 'second', 'third'][j]}`;
					// What remains is a tuple again (a Pair) where two fields do, else an array.
					const pairLike = /^(Pair|Triple)</.test(restType);
					const element = restType.replace(/^JSArray<(.*)>$/, '$1');
					const fields = Array.from({ length: tuple - k }, (_, j) => (pairLike ? field(k + j) : this.convert(field(k + j), this.type(args[k + j], el), element)));
					lines.push(this.bindTo(el.name, pairLike ? `${restType}(${fields.join(', ')})` : `${RT.jsArrayOf}<${element}>(${fields.join(', ')})`, '', mutable));
					return;
				}
				const restType = ts.isIdentifier(el.name) ? this.typeOf(el.name) : held;
				lines.push(this.bindTo(el.name, isKit(spelledType(held), 'JSArray') ? this.convert(`${value}.slice(${k}.0)`, held, restType) : `${value}.slice(${k}.0)`, '', mutable));
				return;
			}
			let read: string;
			const t = this.typeOf(el.name);
			const meets = this.states.bindingDefault(el);
			if (ts.isObjectBindingPattern(name)) {
				const key = (el.propertyName ?? el.name).getText();
				const record = /^JSRecord<(.*)>$/.exec(this.typeOf(name).replace(/\?$/, ''));
				const defined = definedField(this.states, () => this.shapeFacts(), name, key);
				read = meets === 'keyed' ? `${RT.jsField}(${value}, ${kotlinString(key)})` : this.isAny(name) || isUntyped(spelledType(type)) ? `${RT.jsGet}(${value}, ${kotlinString(key)})` : defined ? this.fromAnyCode(`${RT.jsGet}(${value}, ${kotlinString(key)})`, this.typeOf(defined.name!), true) : record ? this.undefinedAs(`${value}[${kotlinString(key)}]`, ts.isIdentifier(el.name) ? this.typeOf(el.name) : record[1]) : `${value}.${ident(key)}`;
				// Lenient code: a field Kotlin declares nullable (optional, or left unset) binds as its type reads undefined.
				const field = !this.isAny(name) && !record ? this.checker.getTypeAtLocation(name).getProperty(key) : undefined;
				const fd = field?.valueDeclaration;
				const lenientOptional = this.lenient && field && (this.nullableDecls.has(field) || (fd && (ts.isPropertySignature(fd) || ts.isPropertyDeclaration(fd)) && fd.questionToken));
				// A field the checker calls present that Kotlin holds nullable (one assigned `null!`): read as present, as script does.
				const heldOptional = !this.lenient && fd && (ts.isPropertyDeclaration(fd) || ts.isParameter(fd)) && isNullable(this.declaredTypeOf(fd.name as ts.Identifier) ?? '');
				if (field && !el.initializer && !isNullable(t) && !isUntyped(spelledType(t)) && (lenientOptional || heldOptional)) read = this.undefinedAs(read, t);
				// Library mode: a literal the pattern gives untyped fields (`{ m: r, m: g } = { m: … }`) builds them as `Any?`.
				const literal = ts.isVariableDeclaration(name.parent) && name.parent.initializer && ts.isObjectLiteralExpression(name.parent.initializer) ? name.parent.initializer : undefined;
				const built = literal && this.checker.getContextualType(literal)?.getProperty(key);
				if (this.library && built && !isUntyped(spelledType(t)) && isUntyped(spelledType(this.type(this.checker.getTypeOfSymbolAtLocation(built, literal!), literal)))) read = this.fromAnyCode(read, t, true);
			} else if (tuple && isUntyped(spelledType(type)) && !ts.isIdentifier(el.name) && !this.isAny(el.name)) read = `${RT.jsField}(${value}, "${k}")`;
			else if (tuple) read = (isUntyped(spelledType(type)) && ts.isIdentifier(el.name) && !el.initializer && this.checkedBinding(el, `${RT.jsField}(${value}, "${k}")`, elementType(k))) || tupleField(k);
			else if (isUntyped(spelledType(type))) read = `${RT.jsGet}(${value}, "${k}")`;
			else if (meets === 'element') read = `(if (${k}.0 < ${value}.length) ${value}[${k}] else ${this.coerce(el.initializer!, t)})`;
			else {
				// An array pattern past the array's end binds undefined.
				read = count && held === 'JSArray<Any?>' && !isUntyped(spelledType(t)) ? this.fromAny(`${value}.element(${k}.0)`, optionalType(t)) : `${value}.element(${k}.0)`;
				if (this.matchGroupBinding(el) && ts.isIdentifier(el.name)) {
					const sym = this.resolve(el.name);
					if (sym) this.undefinedVars.set(sym, 'String?');
					lines.push(mutable === 'assign' ? `${i}${ident(this.topName(el, el.name.text))} = ${read}` : `${i}${kw}${ident(el.name.text)}: String? = ${read}`);
					return;
				}
				// A package's untyped element bound typed (`const [head, ...tail] = args` spread as an array later): read as it.
				if (/^JSArray<Any\?>\??$/.test(this.type(this.checker.getTypeAtLocation(name), name)) && !isUntyped(spelledType(t)) && !/^(String|Double|Boolean)$/.test(t) && !isNullable(t) && !el.initializer && ts.isIdentifier(el.name) && !this.library && this.pluginFiles.has(el.getSourceFile().fileName)) {
					lines.push(declare(el.name, t, this.fromAny(read, t)));
					return;
				}
				// Library mode: past the array's end binds undefined, which the binding holds as null.
				if (!el.initializer && !t.endsWith('?') && !(this.library && ['String', 'Double', 'Boolean'].includes(t) && mutable !== 'assign')) {
					// A string, number or boolean is held as null past the end, as JavaScript holds undefined there.
					if (!this.library && mutable !== 'assign' && ts.isIdentifier(el.name) && (this.states.arrayPiece(el) || (['String', 'Double', 'Boolean'].includes(t) && this.truthTested(el.name)) || this.states.storesOptional(el.name))) {
						const sym = this.checker.getSymbolAtLocation(el.name);
						if (sym) this.nullableDecls.add(sym);
						lines.push(`${i}${kw}${ident(el.name.text)}: ${optionalType(t)} = ${read}`);
						return;
					}
					const sym = mutable === 'assign' && ts.isIdentifier(el.name) ? this.resolve(el.name) : undefined;
					if (sym && ts.isIdentifier(el.name) && !count && this.undefinedVars.get(sym) === optionalType(t)) {
						lines.push(`${i}${ident(this.topName(el, el.name.text))} = ${read}`);
						return;
					}
					read = this.undefinedAs(read, t);
				}
			}
			if (el.initializer && meets !== 'never' && meets !== 'element') read = `(${read} ?: ${(meets !== 'keyed' && this.patternDefault(el.initializer, el, t)) || this.coerce(el.initializer, meets === 'keyed' ? 'Any?' : t)})`;
			if (ts.isIdentifier(el.name)) {
				const held = this.states.optionalObjectPiece(el) ? (mutable === 'assign' ? optionalType(t) : this.bindsOptional(el.name, t)) : t;
				lines.push(declare(el.name, held, (this.isAny(name) || (isUntyped(spelledType(type)) && !tuple) || meets === 'keyed') && !isUntyped(spelledType(t)) ? (this.checkedBinding(el, read, held) ?? this.fromAny(read, held)) : read));
			} else {
				const tmp = this.fresh('__d');
				// A typed pattern's part of an untyped value is untyped too.
				const untypedPart = (this.isAny(name) || isUntyped(spelledType(type)) || meets === 'keyed') && !this.isAny(el.name);
				lines.push(`${i}val ${tmp} = ${read}`, this.bindTo(el.name, tmp, untypedPart ? 'Any?' : '', mutable));
			}
		});
		return lines.join('\n');
	},

	/** A groupBy callback's function type: the item and its index, as many as a literal declares (at least the item, as the runtime's overloads take). */
	groupKeySlot(this: Translator, items: ts.Expression, f: ts.Expression, key: string): string {
		const arity = ts.isArrowFunction(f) || ts.isFunctionExpression(f) ? Math.max(1, f.parameters.length) : this.functionArity(f);
		return `(${[this.elementTypeOf(items), 'Double'].slice(0, Math.min(2, arity)).join(', ')}) -> ${key}`;
	},

	/** An app's method whose Kotlin signature is its own: no base, interface or override shares it. */
	ownSignatureMethod(this: Translator, m: ts.Node): m is ts.MethodDeclaration {
		if (!ts.isMethodDeclaration(m) || isStatic(m) || !ts.isClassDeclaration(m.parent) || /^\$[be]\d+$/.test(m.name.getText()) || this.pluginFiles.has(m.getSourceFile().fileName)) return false;
		let known = this.ownSignatures.get(m);
		if (known !== undefined) return known;
		const name = m.name.getText(),
			cls = m.parent;
		const t = this.checker.getTypeAtLocation(cls);
		const inherited = (t.isClassOrInterface() ? this.checker.getBaseTypes(t) : []).some((b) => !!b.getProperty(name)) || (cls.heritageClauses ?? []).some((h) => h.token === ts.SyntaxKind.ImplementsKeyword && h.types.some((x) => !!this.checker.getTypeAtLocation(x).getProperty(name)));
		const overridden = this.sourceFiles.some(
			(sf) =>
				!sf.isDeclarationFile &&
				sf.statements.some(
					(st) =>
						ts.isClassDeclaration(st) &&
						st !== cls &&
						st.members.some((x) => x.name?.getText() === name) &&
						(() => {
							for (let b = programBase(st, this.checker); b; b = programBase(b, this.checker)) if (b === cls) return true;
							return false;
						})(),
				),
		);
		known = !inherited && !overridden;
		this.ownSignatures.set(m, known);
		return known;
	},

	heldAwait(this: Translator, a: ts.AwaitExpression, v: string): [string, string] | undefined {
		// Objects are held as their type says (an unchecked null): only strings, numbers and booleans are nullable.
		const slot = awaitSlot(this.placement, a, v, (t) => ['String', 'Double', 'Boolean'].includes(t));
		if (!slot) return undefined;
		this.awaitSlots.set(a, slot);
		return [slot.target, this.awaitedValue(slot)];
	},
	/** The await's value read from its slot (U → P by kind): a null-only body's nothing reads as null does. */
	awaitedValue(this: Translator, slot: AwaitSlot): string {
		const t = this.typeOf(slot.a);
		if (!slot.isNull) return this.undefinedAs(slot.raw, t);
		return `(${slot.raw} ?: ${t === 'Double' ? '0.0' : t === 'String' ? '"null"' : 'false'})`;
	},
	/** The slot of the await `e` is, where its continuation holds the value nullable. */
	awaited(this: Translator, e: ts.Expression): AwaitSlot | undefined {
		return this.awaitSlots.get(ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses));
	},
	noteNullVar(this: Translator, d: ts.VariableDeclaration): void {
		const init = d.initializer && ts.skipOuterExpressions(d.initializer, ts.OuterExpressionKinds.Parentheses);
		const sym = ts.isIdentifier(d.name) ? this.resolve(d.name) : undefined;
		if (!init || !sym || !this.states.nullResult(init)) return;
		if (!reassigned(d, this.checker) || (!ts.isAwaitExpression(init) && onlyNullOrPresent(d, this.checker, (v) => !ts.isAwaitExpression(v) && this.states.nullResult(v)))) this.states.nullVars.add(sym);
		else if (ts.isAwaitExpression(init)) throw this.error(d, 'a variable holding the null a non-strict async function may give, assigned again');
	},

	/** A variable given a non-strict app's null-only result, by its initializer or a later `=`. */
	givenNullResult(this: Translator, d: ts.VariableDeclaration): boolean {
		return givenBy(d, this.checker, (v) => !ts.isAwaitExpression(v) && this.states.nullResult(v));
	},

	/** A group an array pattern binds from a match (`const [, key, value] = re.exec(s)`): undefined where the group took no part. */
	matchGroupBinding(this: Translator, el: ts.BindingElement): boolean {
		const pattern = el.parent;
		return !this.library && ts.isArrayBindingPattern(pattern) && pattern.elements.indexOf(el) > 0 && !el.initializer && !el.dotDotDotToken && ts.isIdentifier(el.name) && this.typeOf(el.name) === 'String' && isNamed(spelledType(this.typeOf(pattern)), 'JSMatch', false);
	},

	/** A pattern reading from a value held `Any?` (`destructured` keeps it so) whose own type is not untyped. */
	untypedPattern(this: Translator, name: ts.BindingName, init: ts.Expression): boolean {
		return !this.isAny(name) && !ts.isObjectLiteralExpression(init) && this.isAny(init) && !(ts.isArrayBindingPattern(name) && this.jsIteration(init));
	},

	/** The type and value a destructuring pattern reads from: an iterator yields only as many values as an array pattern names. */
	destructured(this: Translator, name: ts.BindingName, init: ts.Expression): string {
		// A match reads its values as an array does.
		const js = ts.isArrayBindingPattern(name) && !/^JSMatch\??$/.test(this.typeOf(init)) ? this.patternIteration(init) : null;
		// A literal builds a shape class of its own, which the pattern's contextual shape need not be.
		if (!js) return ts.isObjectLiteralExpression(init) ? ` = ${this.expr(init)}` : `: ${this.typeOf(init)} = ${this.coerce(init, this.typeOf(init))}`;
		const rest = (name as ts.ArrayBindingPattern).elements.some((el) => ts.isBindingElement(el) && el.dotDotDotToken);
		return ` = JSArray(ArrayList(${js}.${rest ? 'jsCollect()' : `jsTake(${(name as ts.ArrayBindingPattern).elements.length})`}))`;
	},
};
