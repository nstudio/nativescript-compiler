// Declarations as Swift: declaration lists, variables and how they are held, and bindings of destructured values.
import ts from 'typescript';
import { functionsReferTo, ident, identPath, isNullish, isOptional, optionalType, refersTo, swiftString, throwingGetter, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { prototypeAlias } from '../semantics/lang.ts';
import { onlyNullOrPresent } from '../semantics/nullish.ts';
import { redeclaredVar } from '../semantics/ast.ts';
import { definedField, untypedResultField } from '../semantics/shapes.ts';
import { isKit, isNamed, isUntyped, spelledType } from '../semantics/types.ts';

export const declarationsMethods = {
	declarationList(this: Translator, list: ts.VariableDeclarationList, lowered: boolean): string {
		const constant = !!(list.flags & ts.NodeFlags.Const);
		return list.declarations.map((d) => this.declaration(d, constant, lowered)).join('\n');
	},

	/** One declaration; in lowered async code a later continuation may assign it, so it starts initialized. */
	declaration(this: Translator, d: ts.VariableDeclaration, constant: boolean, lowered: boolean): string {
		const i = this.indent;
		if (this.patterns.requiredCore(d) || prototypeAlias(this, d)) return '';
		if (ts.isIdentifier(d.name)) {
			const t = this.typeOf(d.name);
			const name = ident(d.name.text);
			if (this.forwardDeclared.has(d)) return d.initializer ? `${i}${this.topNames().has(d) ? identPath(this.topNames().get(d)!) : name} = ${this.marks.tryBefore(this.tryPrefix(d.initializer), this.stored(d.initializer, d, t))}` : '';
			// `var m` again in the same block, or a module's `var` again in a nested block: the same variable, assigned.
			if (redeclaredVar(d, this.checker)) return d.initializer ? `${i}${this.lvalue(d.name)} = ${this.marks.tryBefore(this.tryPrefix(d.initializer), this.stored(d.initializer, d, t))}` : '';
			if (this.states.nullishHeld(d)) return `${i}${!lowered && constant ? 'let' : 'var'} ${name}: ${t} = ${d.initializer ? `${this.marks.tryBefore(this.tryPrefix(d.initializer), this.stored(d.initializer, d, t))}` : 'nil'}`;
			// Lenient code may read it before any assignment (`let result: string; if (!result) …`): undefined until assigned.
			if (!d.initializer && (this.lenient || this.lenientApp) && !lowered && !t.endsWith('?') && !isUntyped(spelledType(t)) && this.zero(t) !== null) {
				const sym = this.resolve(d.name);
				if (sym) this.undefinedVars.set(sym, optionalType(t));
				return `${i}var ${name}: ${optionalType(t)} = nil`;
			}
			// Swift cannot always see that every path assigns a value TypeScript left undeclared (a switch without a default).
			if (!d.initializer) return `${i}var ${name}: ${lowered || t.endsWith('?') || this.zero(t) === null ? this.deferred(t) : t}`;
			if ((ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) && refersTo(d.initializer, this.checker.getSymbolAtLocation(d.name), this.checker)) {
				return `${i}var ${name}: ${this.deferred(t)}\n${i}${name} = ${this.stored(d.initializer, d, t)}`;
			}
			// A non-strict app's object variable starting as null (`let ctrl: SegmentedBar = null`): unset until assigned.
			if (this.lenientApp && !lowered && isNullish(d.initializer) && /^[A-Z][\w.]*(<.*>)?$/.test(t) && (this.zero(t) === null || /^JS(Array|Map|Set)</.test(t))) return `${i}var ${name}: ${t}! = nil`;
			// An object whose functions read the variable itself (`const sub = { done: () => off(sub) }`): declared, then assigned.
			if ((ts.isObjectLiteralExpression(d.initializer) || ts.isNewExpression(d.initializer) || ts.isCallExpression(d.initializer)) && !lowered && functionsReferTo(d.initializer, this.checker.getSymbolAtLocation(d.name), this.checker)) {
				return `${i}var ${name}: ${this.deferred(t)}\n${i}${name} = ${this.marks.tryBefore(this.tryPrefix(d.initializer), this.stored(d.initializer, d, t))}`;
			}
			const holes = this.holeyArray(d, t);
			if (holes) return `${i}let ${name}: ${holes.type} = ${this.tryPrefix(d.initializer)}${holes.type}(Array(repeating: nil, count: ${this.arrayLength(holes.length)}))`;
			// Lenient code: a string, number or boolean read from an optional member (`entry.backstackVisible`) may be undefined, which the code may test for.
			const member = this.lenient && !lowered && ['Bool', 'Double', 'String'].includes(t) ? this.optionalMember(d.initializer) : null;
			if (member && this.isAny(member.expression)) {
				const sym = this.resolve(d.name);
				if (sym) this.undefinedVars.set(sym, optionalType(t));
				return `${i}${constant || !this.needsVar(d.name, t) ? 'let' : 'var'} ${name}: ${optionalType(t)} = (try ${RT.jsGet}(${this.expr(member.expression)}, ${swiftString(member.name.text)}) as? ${t})`;
			}
			// Lenient code: a string, number or boolean declared null until assigned (`let prominentIdentifier: string = null`)
			// holds undefined, read as undefined reads where its type is wanted and as the optional by `??` and `??=`.
			if (this.lenient && !constant && isNullish(d.initializer) && (t === 'String' || t === 'Double' || t === 'Bool')) {
				const sym = this.resolve(d.name);
				if (sym) this.undefinedVars.set(sym, optionalType(t));
				return `${i}var ${name}: ${optionalType(t)} = nil`;
			}
			const undefinedHeld = !lowered || ts.isAwaitExpression(ts.skipOuterExpressions(d.initializer)) || this.states.optionalVariable(d) ? this.heldUndefined(d) : null;
			const maybe = undefinedHeld ? (this.maybeUndefined(d.initializer) ?? (this.states.optionalElementRead(ts.skipOuterExpressions(d.initializer, ts.OuterExpressionKinds.Parentheses)) ? this.expr(d.initializer) : null) ?? (this.states.optionalVariable(d) ? this.heldStore(d, undefinedHeld) : null)) : null;
			if (undefinedHeld && maybe) {
				const sym = this.resolve(d.name),
					held = undefinedHeld;
				let read: ts.Expression = d.initializer;
				while (ts.isParenthesizedExpression(read)) read = read.expression;
				if (sym) this.undefinedVars.set(sym, held);
				if (sym && this.lenientApp && (this.states.nullResult(read) || this.states.emptyDefault(read) === 'null')) {
					if (!this.needsVar(d.name, held) || (!ts.isAwaitExpression(read) && onlyNullOrPresent(d, this.checker, (v) => !ts.isAwaitExpression(v) && this.states.nullResult(v)))) this.states.nullVars.add(sym);
					else if (ts.isAwaitExpression(read)) throw this.error(d, 'a variable holding the null a non-strict async function may give, assigned again');
				}
				// An untyped value declared a type (`const s: string = untyped[0]`): converted, undefined staying undefined.
				const value = this.isAny(d.initializer) && !isUntyped(spelledType(held)) ? (this.checkedPlacement(d.initializer, held, maybe, this.storeSlot(d.initializer, held, d)) ?? this.fromAny(maybe, held)) : this.optionalArrayAs(maybe, this.typeOf(d.initializer), held);
				return `${i}${(lowered ? !constant : this.needsVar(d.name, held)) ? 'var' : 'let'} ${name}: ${held} = ${this.marks.tryBefore(this.tryPrefix(d.initializer), value)}`;
			}
			// A native struct is a value in Swift: a constant one's fields can still be assigned in JavaScript.
			const binding = lowered ? (constant && !this.native.isStructType(t) ? 'let' : 'var') : this.needsVar(d.name, t) ? 'var' : 'let';
			const savedPresent = this.presentSlot;
			this.presentSlot = this.madePresent(d);
			let value: string;
			try {
				value = this.keptOptional(this.stored(d.initializer, d, t), this.lenientRef(t));
			} finally {
				this.presentSlot = savedPresent;
			}
			// Lenient code: a native dictionary or array that may be nil (`titleTextAttributesForState` before any are set) is held as given, undefined until tested.
			if (this.lenient && t.startsWith('[') && this.lenientRef(t) === t && this.marks.isUnwrap(value)) return `${i}${binding} ${name}: ${t}? = ${this.tryPrefix(d.initializer)}${this.marks.unwrapInner(value)!}`;
			if (!lowered && !this.isRead(d.name) && ts.findAncestor(d, ts.isFunctionLike)) return this.pure(d.initializer) ? '' : `${i}_ = ${this.marks.tryBefore(this.tryPrefix(d.initializer), value)}`;
			if (this.madePresent(d)) {
				// A construction lenient code reads as maybe missing (`jsImplicit(Impl())`): the object made.
				const c = this.marks.markOf(value);
				const object = c?.op === 'implicit' && !c.cell && !c.chained ? c.of.code : null;
				return `${i}${binding} ${name}: ${t} = ${this.tryPrefix(d.initializer)}${object ?? value}`;
			}
			const held = this.lenient && t.startsWith('[') && this.marks.rootImplicit(value) ? `${t}?` : this.lenientRef(t);
			return `${i}${binding} ${name}: ${held} = ${this.marks.tryBefore(this.tryPrefix(d.initializer), value)}`;
		}
		const tmp = this.fresh('__d');
		return `${i}let ${tmp}${this.destructured(d.name, d.initializer!)}\n${this.bindTo(d.name, tmp, this.patternIterated(d.name, d.initializer!) ? this.iteratedHeld(d.name, d.initializer!) : this.typeOf(d.initializer!), !constant)}`;
	},
	/**
	 * The variables a file assigns after declaring them, and those whose members it assigns (`size.width = w`); with
	 * `live`, only in the branches the translation keeps (deciding which reads this, without it).
	 */
	writtenIn(this: Translator, sf: ts.SourceFile, live = true): { vars: Set<ts.Symbol>; members: Set<ts.Symbol> } {
		const cache = live ? this.writes : this.allWrites;
		let w = cache.get(sf);
		if (w) return w;
		const found = (w = { vars: new Set<ts.Symbol>(), members: new Set<ts.Symbol>() });
		const add = (to: Set<ts.Symbol>, id: ts.Node, shorthand = false) => {
			const sym = shorthand ? this.checker.getShorthandAssignmentValueSymbol(id) : this.checker.getSymbolAtLocation(id);
			if (sym) to.add(sym);
		};
		const mark = (target: ts.Expression): void => {
			while (ts.isParenthesizedExpression(target) || ts.isNonNullExpression(target) || ts.isAsExpression(target) || ts.isTypeAssertionExpression(target)) target = target.expression;
			if (ts.isIdentifier(target)) add(found.vars, target);
			else if (ts.isArrayLiteralExpression(target)) target.elements.forEach((el) => mark(ts.isSpreadElement(el) ? el.expression : el));
			else if (ts.isObjectLiteralExpression(target)) {
				for (const p of target.properties) {
					if (ts.isShorthandPropertyAssignment(p)) add(found.vars, p, true);
					else if (ts.isPropertyAssignment(p)) mark(p.initializer);
					else if (ts.isSpreadAssignment(p)) mark(p.expression);
				}
			} else if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) mark(target.left);
			else if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
				let root: ts.Expression = target.expression;
				while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root) || ts.isParenthesizedExpression(root) || ts.isNonNullExpression(root)) root = root.expression;
				if (ts.isIdentifier(root)) add(found.members, root);
			}
		};
		const visit = (n: ts.Node): void => {
			// A branch the translation drops (`typeof name !== 'string'` of a string) writes nothing.
			if (live && (ts.isIfStatement(n) || ts.isConditionalExpression(n))) {
				const cond = ts.isIfStatement(n) ? n.expression : n.condition;
				const fixed = this.reach?.constant(cond) ?? this.staticTypeof(cond);
				if (fixed !== undefined) {
					const live = ts.isIfStatement(n) ? (fixed ? n.thenStatement : n.elseStatement) : fixed ? n.whenTrue : n.whenFalse;
					if (live) visit(live);
					return;
				}
			}
			if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) mark(n.left);
			else if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) mark(n.operand);
			else if ((ts.isForInStatement(n) || ts.isForOfStatement(n)) && !ts.isVariableDeclarationList(n.initializer)) mark(n.initializer);
			else if (ts.isDeleteExpression(n)) mark(n.expression);
			ts.forEachChild(n, visit);
		};
		visit(sf);
		cache.set(sf, found);
		return found;
	},
	/** Whether a file names a variable anywhere besides its declaration. */
	isRead(this: Translator, name: ts.Identifier): boolean {
		const sf = name.getSourceFile();
		let found = this.reads.get(sf);
		if (!found) {
			const named = (found = new Set<ts.Symbol>());
			const visit = (n: ts.Node): void => {
				if (ts.isIdentifier(n)) {
					const p = n.parent;
					const declares = (ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p) || ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p)) && p.name === n;
					const sym = ts.isShorthandPropertyAssignment(p) && p.name === n ? this.checker.getShorthandAssignmentValueSymbol(p) : declares ? undefined : this.checker.getSymbolAtLocation(n);
					if (sym) named.add(sym);
				}
				ts.forEachChild(n, visit);
			};
			visit(sf);
			this.reads.set(sf, found);
		}
		const sym = this.checker.getSymbolAtLocation(name);
		return !sym || found.has(sym);
	},

	/** Whether a variable of type `t` must be a Swift `var`: it is assigned again, or it is a native struct whose fields are assigned. */
	needsVar(this: Translator, name: ts.Identifier, t: string): boolean {
		const sym = this.checker.getSymbolAtLocation(name);
		// `var x` declared twice is assigned by the second.
		if (!sym || (sym.declarations?.length ?? 0) > 1) return true;
		const w = this.writtenIn(name.getSourceFile());
		return w.vars.has(sym) || (w.members.has(sym) && this.native.isStructType(t.replace(/[?!]$/, '')));
	},
	/**
	 * The optional type Swift holds a variable in whose initializer may give undefined though TypeScript types it present
	 * (`const digits = m[2]`), else null. Decided from the declaration alone each time it is asked: `declaration` and
	 * `variables` declare by it, and the throws analysis asks before either has run.
	 */
	heldUndefined(this: Translator, d: ts.VariableDeclaration): string | null {
		if (!ts.isIdentifier(d.name) || !d.initializer || this.askingHeld.has(d) || prototypeAlias(this, d) || redeclaredVar(d, this.checker) || this.forwardDeclared.has(d) || this.patterns.requiredCore(d) || this.states.nullishHeld(d)) return null;
		const t = this.typeOf(d.name);
		if (t.endsWith('?') || isKit(spelledType(t), 'JSNullish')) return null;
		if (this.states.optionalVariable(d)) return optionalType(t);
		const init = d.initializer;
		if ((ts.isObjectLiteralExpression(init) || ts.isNewExpression(init) || ts.isCallExpression(init)) && functionsReferTo(init, this.checker.getSymbolAtLocation(d.name), this.checker)) return null;
		const file = this.currentFile;
		this.askingHeld.add(d);
		this.currentFile = d.getSourceFile().fileName;
		try {
			if (!this.mayGiveUndefined(init) && !this.states.optionalElementRead(ts.skipOuterExpressions(init, ts.OuterExpressionKinds.Parentheses))) return null;
		} finally {
			this.askingHeld.delete(d);
			this.currentFile = file;
		}
		// A value of an untyped record (`const value = bag[key]`) is whatever script put there.
		const read = ts.skipOuterExpressions(init, ts.OuterExpressionKinds.Parentheses);
		return (ts.isElementAccessExpression(read) || ts.isPropertyAccessExpression(read)) && isNamed(spelledType(this.typeOf(read.expression)), 'JSRecord<Any?>') ? 'Any?' : optionalType(t);
	},

	/** An `optionalVariable`'s initializer stored as the optional `type`: a read converting undefined gives that undefined. */
	heldStore(this: Translator, d: ts.VariableDeclaration, type: string): string {
		const code = this.stored(d.initializer!, d, type);
		return this.undefinedConverted(code) ?? code;
	},

	/** Whether a pattern steps its value's iterator (`patternIteration`). */
	patternIterated(this: Translator, name: ts.BindingName, init: ts.Expression): boolean {
		// A match reads its values as an array does.
		return ts.isArrayBindingPattern(name) && !/^JSMatch[?!]?$/.test(this.typeOf(init)) && !!this.patternIteration(init);
	},

	/** The type an iterated pattern binds from (`destructured`): `jsTake` gives `JSArray<Any?>`; `jsCollect` gives `JSArray<E>` of the iterator's element type. */
	iteratedHeld(this: Translator, name: ts.BindingName, init: ts.Expression): string {
		const rest = (name as ts.ArrayBindingPattern).elements.some((el) => ts.isBindingElement(el) && el.dotDotDotToken);
		return rest ? `JSArray<${this.isAny(init) ? 'Any?' : this.elementTypeOf(init)}>` : 'JSArray<Any?>';
	},

	/** The type and value a destructuring pattern reads from: an iterator yields only as many values as an array pattern names. */
	destructured(this: Translator, name: ts.BindingName, init: ts.Expression): string {
		const js = this.patternIterated(name, init) ? this.patternIteration(init) : null;
		if (!js) {
			const value = this.coerce(init, this.typeOf(init));
			// What the kit holds optional though the declarations say present (`getActualSize()`): JavaScript's TypeError destructuring undefined.
			if (ts.isObjectBindingPattern(name) && this.marks.isUnwrap(value) && !this.lenient && this.core.kitNil(init)) return `: ${this.typeOf(init)} = try ${this.required(init, this.marks.unwrapInner(value)!)}`;
			return `: ${this.typeOf(init)} = ${this.marks.tryBefore(this.tryPrefix(init), value)}`;
		}
		const rest = (name as ts.ArrayBindingPattern).elements.some((el) => ts.isBindingElement(el) && el.dotDotDotToken);
		return ` = try ${rest ? `JSArray(${js}.jsCollect())` : `${js}.jsTake(${(name as ts.ArrayBindingPattern).elements.length})`}`;
	},

	/** The Swift type of what a pattern's element reads (an array's element, a tuple's, an object's member), present. */
	partType(this: Translator, name: ts.BindingPattern, el: ts.BindingElement, k: number, source: ts.Type, type: string): string | null {
		if (ts.isObjectBindingPattern(name)) {
			const prop = source.getProperty((el.propertyName ?? el.name).getText());
			if (untypedResultField(this, prop)) return 'Any?';
			return prop ? this.type(this.checker.getNonNullableType(this.checker.getTypeOfSymbolAtLocation(prop, el)), el) : null;
		}
		if (this.checker.isTupleType(source)) {
			const part = this.checker.getTypeArguments(source as ts.TypeReference)[k];
			return part ? this.type(this.checker.getNonNullableType(part), el) : null;
		}
		return /^JSArray<(.*)>\??$/.exec(type || this.typeOf(name))?.[1] ?? null;
	},

	/** Declarations binding `name` (an identifier or a destructuring pattern) to the Swift value `value`. */
	bindTo(this: Translator, name: ts.BindingName, value: string, _type: string, mutable: boolean | 'assign'): string {
		const i = this.indent;
		const keyword = (n: ts.Identifier, t: string) => (mutable === 'assign' ? '' : mutable && this.needsVar(n, t) ? 'var ' : 'let ');
		// Lenient code holds a destructured object as it holds any other: implicitly unwrapped, undefined where the source lacks it.
		// A name nothing reads is no variable: its value is still read, as script reads it.
		const declare = (n: ts.Identifier, t: string, v: string) => {
			if (mutable !== 'assign' && this.states.optionalBinding(n)) t = this.bindsOptional(n, t);
			return mutable === 'assign' ? `${i}${ident(this.topName(n.parent, n.text))} = ${v}` : !this.isRead(n) ? `${i}_ = ${v}` : `${i}${keyword(n, t)}${ident(n.text)}: ${this.lenientRef(t)} = ${v}`;
		};
		if (ts.isIdentifier(name)) return declare(name, this.typeOf(name), value);
		const lines: string[] = [];
		const source = this.checker.getTypeAtLocation(name);
		const arrayValue = isKit(spelledType((_type || this.typeOf(name)).replace(/\?$/, '')), 'JSArray');
		const matchValue = ts.isArrayBindingPattern(name) && /^JSMatch[?!]?$/.test(_type || this.typeOf(name));
		name.elements.forEach((el, k) => {
			if (ts.isOmittedExpression(el)) return;
			if (el.dotDotDotToken) {
				if (ts.isObjectBindingPattern(name)) {
					const named = name.elements.filter((x) => x !== el).map((x) => swiftString((x.propertyName ?? x.name).getText()));
					// The rest's type has no name of its own: a shape of its fields.
					const restType = this.shape(this.checker.getTypeAtLocation(el.name), el);
					const rest = this.fromAny(`${RT.jsObjectRest}(${value}, [${named.join(', ')}])`, restType);
					lines.push(ts.isIdentifier(el.name) ? `${this.indent}${keyword(el.name, restType)}${ident(mutable === 'assign' ? this.topName(el, el.name.text) : el.name.text)}${mutable === 'assign' ? '' : `: ${restType}`} = ${rest}` : this.bindTo(el.name, rest, '', mutable));
					return;
				}
				const tuple = this.checker.isTupleType(source) && !arrayValue ? this.checker.getTypeArguments(source as ts.TypeReference).length : 0;
				const array = (_type || this.typeOf(name)).replace(/[?!]$/, ''),
					restType = ts.isIdentifier(el.name) ? this.typeOf(el.name) : array;
				const sliced = arrayValue && restType !== array && isKit(spelledType(restType), 'JSArray') ? this.fromAny(`${value}.slice(${k})`, restType) : `${value}.slice(${k})`;
				const rest = tuple ? `(${Array.from({ length: Math.max(0, tuple - k) }, (_, n) => `${value}.${k + n}`).join(', ')})` : sliced;
				lines.push(this.bindTo(el.name, rest, '', mutable));
				return;
			}
			let read: string;
			const meets = this.states.bindingDefault(el);
			if (ts.isObjectBindingPattern(name)) {
				const key = (el.propertyName ?? el.name).getText();
				const record = /^JSRecord<(.*)>$/.exec(this.typeOf(name).replace(/\?$/, ''));
				const defined = definedField(this.states, () => this.shapeFacts(), name, key);
				read = meets === 'keyed' ? `${RT.jsField}(${value}, ${swiftString(key)})` : this.isAny(name) || isUntyped(spelledType(_type)) ? this.marks.ownTried(`${RT.jsGet}(${value}, ${swiftString(key)})`) : defined ? this.fromAnyCode(`${value}[jsKey: ${swiftString(key)}]`, this.typeOf(defined.name!), true) : record ? this.undefinedAs(`${value}[${swiftString(key)}]`, ts.isIdentifier(el.name) ? this.typeOf(el.name) : record[1]) : this.marks.tryIf(this.getterThrows(source, key), `${value}.${this.throwingGetterRead(source, key) ?? ident(key)}`);
			} else if (isUntyped(spelledType(_type))) read = this.marks.ownTried(`${RT.jsGet}(${value}, "${k}")`);
			else if (matchValue) read = this.undefinedAs(this.marks.orNil(this.marks.elementOf(value, k, '.values')), ts.isIdentifier(el.name) ? this.typeOf(el.name) : 'Any?');
			else if (this.checker.isTupleType(source) && !arrayValue) read = `${value}.${k}`;
			// Past the end is undefined.
			else if (this.isAny(name)) read = this.marks.ownTried(`${RT.jsGet}(${value}, "${k}")`);
			else if (arrayValue && /^JSArray<Any\?>[?!]?$/.test(_type) && ts.isIdentifier(el.name)) read = this.marks.orNil(this.marks.elementOf(value, k));
			else read = arrayValue && ts.isIdentifier(el.name) && meets !== 'element' && (!el.initializer || /[?!]$/.test(this.typeOf(el.name))) ? this.undefinedAs(this.marks.elementOf(value, k), this.typeOf(el.name)) : arrayValue && el.initializer ? (meets !== 'element' && isOptional(this.partType(name, el, k, source, _type) ?? '') ? this.marks.orNil(this.marks.elementOf(value, k)) : this.marks.elementOf(value, k)) : `${value}[${k}]`;
			if (el.initializer && meets !== 'never') read = this.marks.leading(`(${read} ?? ${this.coerce(el.initializer, meets === 'keyed' ? 'Any?' : ts.isIdentifier(el.name) ? this.typeOf(el.name) : (this.partType(name, el, k, source, _type) ?? this.typeOf(el.name)))})`, read);
			if (ts.isIdentifier(el.name)) {
				const t = this.typeOf(el.name);
				if (matchValue && !el.initializer && /^(Double|String|Bool)$/.test(t)) {
					const group = this.marks.orNil(this.marks.elementOf(value, k, '.values'));
					lines.push(mutable === 'assign' ? `${i}${ident(this.topName(el, el.name.text))} = ${group}` : `${i}${keyword(el.name, t)}${ident(el.name.text)}: ${this.bindsOptional(el.name, t)} = ${group}`);
					return;
				}
				// An array's element past its end is undefined, which a number, string or boolean cannot hold: `if (second)` tests it.
				const anyElements = /^JSArray<Any\?>[?!]?$/.test(_type);
				if (arrayValue && !anyElements && !el.initializer && mutable !== 'assign' && /^(Double|String|Bool)$/.test(t) && !ts.isObjectBindingPattern(name) && !this.checker.isTupleType(source)) {
					lines.push(`${i}${keyword(el.name, t)}${ident(el.name.text)}: ${this.bindsOptional(el.name, t)} = ${value}.element(${k})`);
					return;
				}
				const sym = mutable === 'assign' ? this.resolve(el.name) : undefined;
				if (arrayValue && !anyElements && !el.initializer && sym && /^(Double|String|Bool)\?$/.test(this.undefinedVars.get(sym) ?? '') && !ts.isObjectBindingPattern(name) && !this.checker.isTupleType(source)) {
					lines.push(`${i}${ident(this.topName(el, el.name.text))} = ${value}.element(${k})`);
					return;
				}
				const untyped = (this.isAny(name) || isUntyped(spelledType(_type)) || /^JSArray<Any\?>[?!]?$/.test(_type) || meets === 'keyed') && !isUntyped(spelledType(t));
				const held = (anyElements && !el.initializer && /^(Double|String|Bool)$/.test(t) && this.states.arrayPiece(el)) || this.states.optionalObjectPiece(el) ? (mutable === 'assign' ? optionalType(t) : this.bindsOptional(el.name, t)) : t;
				lines.push(declare(el.name, held, untyped ? (this.checkedBinding(el, read, this.lenientRef(held)) ?? this.fromAny(read, held)) : read));
			} else {
				const tmp = this.fresh('__d');
				// A typed pattern's part of an untyped value is untyped too.
				const untypedPart = (this.isAny(name) || isUntyped(spelledType(_type)) || meets === 'keyed') && !this.isAny(el.name);
				// Typed: an implicitly unwrapped field read into an untyped constant is an optional.
				const part = el.initializer || untypedPart ? null : this.partType(name, el, k, source, _type);
				lines.push(`${i}let ${tmp}${part && !isUntyped(spelledType(part)) ? `: ${part}` : ''} = ${read}`, this.bindTo(el.name, tmp, untypedPart ? 'Any?' : '', mutable));
			}
		});
		return lines.join('\n');
	},

	/** Whether reading a member of a type runs a getter that throws. */
	/** A member's getter with a throwing body (`throwingBodyOf`), called. */
	throwingGetterRead(this: Translator, type: ts.Type, key: string): string | null {
		const decls = this.checker.getNonNullableType(type).getProperty(key)?.declarations ?? [];
		return decls.some((d) => ts.isGetAccessorDeclaration(d) && this.throwingBodyOf(d)) ? `${throwingGetter(key)}()` : null;
	},

	getterThrows(this: Translator, type: ts.Type, key: string): boolean {
		const decls = this.checker.getNonNullableType(type).getProperty(key)?.declarations ?? [];
		return decls.some((d) => ts.isGetAccessorDeclaration(d) && !!d.body && this.throwsInfo.fn(d));
	},
};
