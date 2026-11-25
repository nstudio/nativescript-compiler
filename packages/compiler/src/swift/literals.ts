// Literals as Swift: arrays, objects and dynamic objects.
import ts from 'typescript';
import { functionParts, ident, identPath, initOrder, isNullish, isOptional, label, optionalType, splitTopLevel, swiftString, withoutThenables, spell, RT } from './syntax.ts';
import type { ShapeField, Translator } from './translator.ts';
import { assertedOperand, evolvingElementContext, intersectionAliasMembers, literalKey, openSpreadType, spreadOperand } from '../semantics/lang.ts';
import { place } from '../semantics/placement.ts';
import { holdsNil, literalNotes, signatureField, shapePlanOfLiteral, spelledOptional, resultShapeNamed } from '../semantics/shapes.ts';
import { isCoreDeclaration } from '../program/core-facts.ts';
import { thisNodes, withoutDefault } from '../semantics/ast.ts';
import { programSymbolKey } from '../program/stable-names.ts';
import { literalClassOf } from '../semantics/classes.ts';
import { heldOf, isKit, isUntyped, spelledType } from '../semantics/types.ts';

export const literalsMethods = {
	array(this: Translator, e: ts.ArrayLiteralExpression, want?: string): string {
		// `[]` alone is never[]; its element type comes from where it goes.
		// A binding pattern's contextual type is its own (`[any]` for `[a]`), not the value's.
		const patterned = (ts.isVariableDeclaration(e.parent) || ts.isBindingElement(e.parent) || ts.isParameter(e.parent)) && e.parent.initializer === e && ts.isArrayBindingPattern(e.parent.name);
		const context = patterned ? undefined : this.checker.getContextualType(e);
		let t = want ?? this.typeOf(e);
		if (!want && context && !(context.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter))) {
			const full = this.heldElements(e, this.type(context, e));
			const c = full.replace(/\?$/, '');
			// A spread's length is known only when it runs: no tuple.
			if (!isUntyped(spelledType(full)) && (isKit(spelledType(c), 'JSArray') || (c.startsWith('(') && !e.elements.some(ts.isSpreadElement)) || !e.elements.length)) t = c;
			// Where an array or other kinds of value go (`data: Selector[][] | string`): that array.
			const arrays = context.isUnion() ? context.types.filter((u) => this.checker.isArrayType(u)) : [];
			if (isUntyped(spelledType(full)) && arrays.length === 1) t = this.type(arrays[0], e);
		}
		const placedElement = !want && this.states.literalElementType(e);
		if (placedElement) t = this.heldElements(e, `JSArray<${this.type(placedElement, e)}>`);
		if (isUntyped(spelledType(t)) || t === 'JSArray<Never>') t = 'JSArray<Any?>';
		if (t.startsWith('(')) {
			const types = want ? splitTopLevel(t.slice(1, -1)) : [];
			// An optional element left out (`['a']` for `[string, string?]`) is undefined.
			const missing = splitTopLevel(t.slice(1, -1))
				.slice(e.elements.length)
				.map((x) => (isOptional(x) || isUntyped(spelledType(x)) ? 'nil' : null));
			if (missing.some((x) => x === null)) throw this.error(e, `an array literal shorter than its tuple type ${t}`);
			return `(${[...e.elements.map((x, k) => (types[k] ? this.coerce(x, types[k]) : this.expr(x))), ...missing].join(', ')})`;
		}
		const el = t.replace(/^JSArray<(.*)>$/, '$1');
		if (!e.elements.length) return `${t}()`;
		const parts: string[] = [];
		let run: string[] = [];
		for (const x of e.elements) {
			if (ts.isSpreadElement(x)) {
				if (run.length) {
					parts.push(`[${run.join(', ')}]`);
					run = [];
				}
				// The spread's elements as this array's (`[name, ...untyped]` into a `string[]`).
				const from = this.elementTypeOf(x.expression);
				parts.push(from !== el && isUntyped(spelledType(from)) ? `Array(${this.iterable(x.expression)}).map { ${this.fromAny('$0', el)} }` : `Array(${this.iterable(x.expression)})`);
			} else if (ts.isOmittedExpression(x)) throw this.error(x, 'an array hole', 'array-hole');
			else if (!this.lenient && isNullish(ts.skipOuterExpressions(x)) && !isOptional(el) && !isUntyped(spelledType(el)) && !isKit(spelledType(el), 'JSNullish') && this.zero(el) === null) {
				throw this.error(x, `null or undefined in an array of ${el}, whose type leaves both out (declare the element type \`${el} | null\`)`);
			} else if (this.lenientApp && !isOptional(el) && !isUntyped(spelledType(el)) && this.zero(el) === null && this.heldOptionalResult(x)) {
				throw this.error(x, `a value a non-strict function may give as null or undefined, in an array of ${el}`);
			} else run.push(place(this.placement, x, this.elementSlot(e, el)(x)));
		}
		if (run.length) parts.push(`[${run.join(', ')}]`);
		return `${t}(${parts.join(' + ')})`;
	},

	/** A shorthand member's value (`code`, else as read) where `v` is wanted: a function held untyped is boxed, as script calls it by key. */
	shorthandEntry(this: Translator, p: ts.ShorthandPropertyAssignment, v: string, code: string = this.shorthandValue(p)): string {
		if (!isUntyped(spelledType(v))) return code;
		const held = this.checker.getShorthandAssignmentValueSymbol(p);
		const decl = (held && held.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(held) : held)?.valueDeclaration;
		const actual = decl && ts.isFunctionDeclaration(decl) ? this.functionValueType(decl) : this.typeOf(p.name);
		return functionParts(actual.replace(/^\((.*)\)[?!]$/, '$1')) ? this.convert(code, actual, v) : code;
	},

	object(this: Translator, e: ts.ObjectLiteralExpression, want?: string): string {
		// A destructuring pattern's contextual type is the pattern's (`{ m: any }`), not the value's.
		const destructured = (ts.isVariableDeclaration(e.parent) || ts.isParameter(e.parent) || ts.isBindingElement(e.parent)) && e.parent.initializer === e && !ts.isIdentifier(e.parent.name);
		// `{ … } satisfies T` keeps its own type, and so do the literals in it: the satisfied type only checks them.
		let up: ts.Node = e;
		while (ts.isObjectLiteralExpression(up) && ts.isPropertyAssignment(up.parent) && ts.isObjectLiteralExpression(up.parent.parent)) up = up.parent.parent;
		const satisfying = ts.isSatisfiesExpression(up.parent) && up.parent.expression === up;
		const contextual = withoutThenables(destructured || spreadOperand(e) ? undefined : satisfying ? (up === e ? (this.checker.getContextualType(e.parent as ts.SatisfiesExpression) ?? undefined) : undefined) : (evolvingElementContext(e, this.checker, this.holeless) ?? this.checker.getContextualType(e)));
		// `{ … } as unknown as T`: an object script reads and extends untyped.
		if (contextual && contextual.flags & ts.TypeFlags.Unknown) return this.dynamicObject(e);
		// An object held untyped that code fills in by key (`node = {}; node[key] = …`): extensible, as every script object is.
		if (!want && contextual && contextual.flags & ts.TypeFlags.Any) return this.dynamicObject(e);
		const type = contextual && !(contextual.flags & ts.TypeFlags.Any) ? contextual : this.checker.getTypeAtLocation(e);
		const struct = this.native.structLiteral(e, this.checker.getNonNullableType(type));
		if (struct) return struct;
		const literalClass = this.library ? literalClassOf(this, e) : null;
		if (literalClass) return this.classLiteral(e, literalClass);
		const untyped = ts.isVariableDeclaration(e.parent) && e.parent.initializer === e && this.untypedRecord(e.parent);
		const name = want ?? (untyped ? 'JSRecord<Any?>' : this.heldElements(e, this.type(this.checker.getNonNullableType(type), e).replace(/\?$/, '')));
		const held = spelledType(name);
		if (isKit(held, 'JSRecord')) {
			const v = spell(held.args[0]);
			if (e.properties.some(ts.isSpreadAssignment)) {
				const r = this.fresh('__r');
				const steps = e.properties.map((p) => {
					if (ts.isSpreadAssignment(p)) return `${this.tryPrefix(p.expression)}${RT.jsObjectSpread}(${r}.object, ${this.coerce(p.expression, 'Any?')})`;
					if (ts.isPropertyAssignment(p)) return `${r}.object[${ts.isComputedPropertyName(p.name) ? `${this.tryPrefix(p.name.expression)}${this.propertyKey(p.name.expression)}` : swiftString(literalKey(p.name, this.checker) ?? p.name.getText())}] = ${this.marks.tryBefore(this.tryPrefix(p.initializer), this.stored(p.initializer, p, v))}`;
					if (ts.isShorthandPropertyAssignment(p)) return `${r}.object[${swiftString(p.name.text)}] = ${this.shorthandEntry(p, v)}`;
					throw this.error(p, 'this member in a dictionary literal');
				});
				const throws = this.throwsInfo.expr(e) || steps.some((x) => x.includes('try '));
				return `{ () ${throws ? 'throws ' : ''}-> ${name} in let ${r} = ${name}(); ${steps.join('; ')}; return ${r} }()`;
			}
			const entries = e.properties.map((p) => {
				if (ts.isPropertyAssignment(p)) return `(${ts.isComputedPropertyName(p.name) ? this.propertyKey(p.name.expression) : swiftString(literalKey(p.name, this.checker) ?? p.name.getText())}, ${this.stored(p.initializer, p, v)})`;
				if (ts.isShorthandPropertyAssignment(p)) return `(${swiftString(p.name.text)}, ${this.shorthandEntry(p, v)})`;
				throw this.error(p, 'this member in a dictionary literal');
			});
			return entries.length ? `${name}([${entries.join(', ')}])` : `${name}()`;
		}
		// Library mode: an event's literal is core's EventData over it, its other keys read by name.
		if (name === 'EventData' && this.library) return `EventData(jsObject: ${this.dynamicObject(e)})`;
		if (isUntyped(spelledType(name)) || name === 'Any' || name === 'Never' || name === 'EventData' || name === 'JSObject') return this.dynamicObject(e);
		if (/^JS(Iterator|AsyncIterator)</.test(name)) return this.scriptIterator(e, name);
		// A spread of an open type (`{ ...state, x }` with `state: T`) carries keys no shape declares; the shape keeps them as extras.
		if (e.properties.some((p) => ts.isSpreadAssignment(p) && openSpreadType(this.checker.getTypeAtLocation(p.expression)))) return this.fromAnyCode(this.dynamicObject(e), name);
		// So does an untyped spread, with keys holding undefined or null besides, in its order.
		if (!this.lenient && !this.library && !this.pluginFiles.has(e.getSourceFile().fileName) && e.properties.some((p) => ts.isSpreadAssignment(p) && this.isAny(p.expression))) {
			// Members reading `this` would read the untyped object, not the one made of it.
			const own = e.properties.find((p) => ts.isMethodDeclaration(p) || ts.isAccessor(p) || (ts.isPropertyAssignment(p) && ts.isFunctionExpression(p.initializer) && thisNodes(p.initializer).length > 0));
			if (own) throw this.error(own, 'a method beside an untyped spread in a typed object literal');
			return this.fromAnyCode(this.dynamicObject(e), name);
		}
		let decl = this.checker.getNonNullableType(type).getSymbol()?.declarations?.[0];
		// A literal that conforms to an app interface it is not declared as.
		const conforming = this.appInterfaces?.find((i) => i.name === name);
		if (conforming && !(decl && ts.isInterfaceDeclaration(decl) && decl.name.text === name)) decl = conforming.type.getSymbol()?.declarations?.[0];
		const shape = this.shapes.named(name);
		const alias = this.checker.getNonNullableType(type).aliasSymbol?.declarations?.[0];
		const joined = alias && ts.isTypeAliasDeclaration(alias) ? intersectionAliasMembers(alias, this.checker) : null;
		let order: { name: string; type: string }[];
		let target = name;
		// An interface classes implement (the program's, or core's the kit made a protocol of): the protocol's object class.
		if (decl && ts.isInterfaceDeclaration(decl) && (this.protocols.has(name) || (!this.library && isCoreDeclaration(decl) && this.core.has(`${name}Object`)))) {
			target = `${name}Object`;
			const members = this.protocols.has(name) ? this.interfaceMembers(decl) : decl.members;
			order = [...members.filter(ts.isPropertySignature).map((m) => ({ name: (m.name as ts.Identifier).text, type: m.questionToken ? optionalType(this.typeOf(m)) : this.typeOf(m) })), ...members.filter(ts.isMethodSignature).map((m) => signatureField(m.name.getText(), this.typeOf(m)))];
		} else if (shape) order = shape.fields;
		else if (decl && (ts.isInterfaceDeclaration(decl) || ts.isTypeLiteralNode(decl))) order = this.interfaceFields(ts.isInterfaceDeclaration(decl) ? this.interfaceMembers(decl) : decl.members);
		else if (joined) order = this.interfaceFields(joined);
		else throw this.error(e, `an object literal of type ${name}`);
		const given = new Map<string, string>();
		const spreadTemps: string[] = [];
		// An optional field given undefined is a key all the same, as one given null is: the shape notes which (`jsUnset`,
		// `jsNulls`), from the value's type, or as it runs (`JSLiteralKeys`) where only the run tells.
		const notesKeys = !this.lenient && !this.library && !this.pluginFiles.has(e.getSourceFile().fileName) && (target === name || (target === `${name}Object` && this.protocols.has(name) && !isCoreDeclaration(decl!))) && !order.some((f) => (f as ShapeField).accessor || (f as ShapeField).symbol);
		const tracks = !order.some((f) => (f as ShapeField).accessor || (f as ShapeField).symbol);
		const notes = literalNotes(e, this.states, this.shapeFacts(), { fields: order.map((f) => ({ name: f.name, type: f.type, holds: this.shapeHeld(f) })), tracks, notes: notesKeys, wholeLiterals: true });
		const unsetKeys: string[] = [],
			keyNotes: string[] = [];
		let keysVar: string | null = null;
		const noteKey = (p: ts.ObjectLiteralElementLike, key: string, value: ts.Expression, code: () => string): string => {
			const noting = notes.get(p)?.unset;
			if (noting !== 'run' && noting !== 'given') return code();
			const f = order.find((x) => x.name === key)!;
			const split = this.states.nullBranches(value);
			if (split) {
				const k = (keysVar ??= this.fresh('__keys'));
				const want = loose(f.type) ? optionalType(f.type) : f.type;
				return this.ternary(split.cond, want, (x) => (split.nulls.includes(x) ? `${k}.nulled(${swiftString(key)}, ${this.coerce(x, want)})` : this.coerce(x, want)));
			}
			if (noting === 'given') {
				unsetKeys.push(key);
				return code();
			}
			const k = (keysVar ??= this.fresh('__keys'));
			const noted = (how: string, x: string) => {
				const inner = this.marks.afterTry(x);
				return inner !== null ? this.marks.tryCode(`${k}.${how}(${swiftString(key)}, ${inner})`) : `${k}.${how}(${swiftString(key)}, ${x})`;
			};
			const untypedUnder = (x: ts.Expression) => (heldOf(spelledType(f.type)) === 'any' ? null : assertedOperand(x, (y) => this.isAny(y)));
			// A conditional's branches may give null, undefined or an untyped value: each is noted as it runs.
			const leaves = (x: ts.Expression): ts.Expression[] => {
				const b = ts.skipParentheses(x);
				return ts.isConditionalExpression(b) ? [...leaves(b.whenTrue), ...leaves(b.whenFalse)] : [x];
			};
			if (ts.isConditionalExpression(ts.skipParentheses(value)) && leaves(value).some(untypedUnder)) {
				const want = loose(f.type) ? optionalType(f.type) : f.type;
				const branch = (x: ts.Expression): string => {
					const b = ts.skipParentheses(x);
					if (ts.isConditionalExpression(b)) return this.ternary(b, want, branch);
					if (b.kind === ts.SyntaxKind.NullKeyword) return noted('nulled', this.coerce(x, optionalType(want)));
					const op = untypedUnder(x);
					if (!op) return noted('typed', this.coerce(x, optionalType(want)));
					this.subst.set(op, noted('untyped', this.expr(op)));
					try {
						return this.coerce(x, want);
					} finally {
						this.subst.delete(op);
					}
				};
				return branch(value);
			}
			const under = untypedUnder(value);
			const how = under ? 'untyped' : 'typed';
			// The value as the field takes it: `expr` would hold it to its checker type (`?? .nan`), never nil.
			if (ts.isIdentifier(value)) {
				keyNotes.push(`${k}.${how}(${swiftString(key)}, ${how === 'typed' && heldOf(spelledType(f.type)) !== 'any' ? this.coerce(value, optionalType(f.type)) : this.expr(value)})`);
				return code();
			}
			const wrap = (x: string) => noted(how, x);
			if (how === 'typed') return wrap(code());
			// Null and undefined apart before the value is converted to the field's type, which holds both as nil.
			const at = under ?? value;
			this.subst.set(at, wrap(this.expr(at)));
			try {
				const made = code();
				if (!made.includes(`${k}.untyped(`)) throw this.error(value, 'this untyped value for an optional field of an object literal');
				return made;
			} finally {
				this.subst.delete(at);
			}
		};
		// A field the class holds implicitly unwrapped (`shapeHeld`) takes what the literal gives as optional, undefined included.
		const loose = (want: string | undefined) => !!want && target === name && this.shapeHeld({ type: want }) === `${want}!`;
		// Methods that read `this` see the object through a weak reference the literal sets once it exists.
		// A function expression as a member (`onViewLoaded: function () { this.loadedCount++ }`) reads the object as `this` too.
		const thisFunction = (p: ts.ObjectLiteralElementLike): p is ts.PropertyAssignment & { initializer: ts.FunctionExpression } => ts.isPropertyAssignment(p) && ts.isFunctionExpression(p.initializer) && thisNodes(p.initializer).length > 0;
		const self = e.properties.some((p) => (ts.isMethodDeclaration(p) && thisNodes(p).length) || thisFunction(p)) ? this.fresh('__self') : null;
		for (const p of e.properties) {
			if (ts.isPropertyAssignment(p)) {
				const key = literalKey(p.name, this.checker) ?? this.symbolMemberName(p.name) ?? p.name.getText();
				const field = order.find((f) => f.name === key)?.type ?? 'Any?';
				const want = loose(field) ? optionalType(field) : field;
				given.set(key, self && thisFunction(p) ? this.withThis(p.initializer as ts.FunctionExpression, this.marks.unwrappedCode(self), false, () => this.stored(p.initializer, p, want)) : noteKey(p, key, p.initializer, () => this.stored(p.initializer, p, want)));
			} else if (ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) {
				const key = literalKey(p.name, this.checker) ?? p.name.getText();
				const f = order.find((x) => x.name === key) as ShapeField | undefined;
				if (!f?.accessor) throw this.error(p, 'an accessor in an object literal of this type');
				if (ts.isGetAccessorDeclaration(p)) {
					if (f.accessor.throws && f.accessor.set) throw this.error(p, 'a getter that throws beside a setter');
					const body = this.withThis(p, '__this', false, () => this.functionBody(p, f.type, this.indent));
					given.set(`__get_${key}`, `{ (__this: ${target}) ${f.accessor.throws ? 'throws ' : ''}-> ${f.type} in${body.slice(1)}`);
				} else {
					if (this.throwsInfo.fn(p)) throw this.error(p, 'a setter that throws');
					const v = p.parameters[0].name as ts.Identifier;
					const body = this.withThis(p, '__this', false, () => this.functionBody(p, 'Void', this.indent));
					given.set(`__set_${key}`, `{ (__this: ${target}, ${ident(v.text)}: ${f.accessor.value}) -> Void in${body.slice(1)}`);
				}
			} else if (ts.isShorthandPropertyAssignment(p)) {
				noteKey(p, p.name.text, p.name, () => '');
				const held = this.checker.getShorthandAssignmentValueSymbol(p);
				const fn = (held && held.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(held) : held)?.valueDeclaration;
				const want = order.find((f) => f.name === p.name.text)?.type;
				// A variable held optional as it may be undefined, for a field held the same: its nil is the field's undefined.
				const asHeld = !!want && isOptional(want) && !!held && this.undefinedVars.get(held) === want;
				const code = fn && (ts.isClassDeclaration(fn) || ts.isModuleDeclaration(fn)) ? `${identPath(this.topNames().get(fn) ?? p.name.text)}.self` : asHeld ? this.shorthandValue(p) : this.narrowed(p.name, this.shorthandValue(p));
				const actual = fn && ts.isFunctionDeclaration(fn) ? this.functionValueType(fn) : null;
				// A variable Swift holds optional that the checker narrowed (`{ chord }` after `if (!chord) continue`), for a field that is not.
				const variable = fn && (ts.isVariableDeclaration(fn) || ts.isParameter(fn)) && ts.isIdentifier(fn.name) ? this.typeOf(fn.name) : null;
				const unwrap = !!want && !isOptional(want) && !isUntyped(spelledType(want)) && !!variable && isOptional(variable) && !isUntyped(spelledType(variable)) && !isOptional(this.typeOf(p.name));
				// A variable held optional while it may be undefined (`const y = ys[i]`): undefined as the field's type reads it.
				const valueSym = this.checker.getShorthandAssignmentValueSymbol(p);
				const undefinedVar = !!valueSym && this.undefinedVars.has(valueSym) && !!want && !isOptional(want) && !isUntyped(spelledType(want));
				if (loose(want) && !actual) {
					given.set(p.name.text, isUntyped(spelledType(variable)) || this.isAny(p.name) ? (this.checkedPlacement(p.name, optionalType(want!), code, this.storeSlot(p.name, optionalType(want!), p)) ?? this.fromAny(code, optionalType(want!))) : code);
					continue;
				}
				// An untyped variable for a typed field (`{ tint }`, tint untyped): converted as script reads it there.
				if (!actual && want && !isUntyped(spelledType(want)) && (isUntyped(spelledType(variable)) || this.isAny(p.name))) {
					given.set(p.name.text, this.checkedPlacement(p.name, want, code, this.storeSlot(p.name, want, p)) ?? this.fromAny(code, want));
					continue;
				}
				given.set(p.name.text, actual && want && functionParts(want) && actual !== want ? this.convert(code, actual, want) : isUntyped(spelledType(want)) && !this.states.nilIsNull(p.name) ? this.shorthandEntry(p, want!, code) : undefinedVar ? this.undefinedAs(code, want!) : unwrap && !this.marks.isUnwrap(code) ? this.marks.unwrappedCode(code) : isUntyped(spelledType(want)) && this.states.nilIsNull(p.name) ? `${RT.jsNulled}(${code})` : code);
			} else if (ts.isSpreadAssignment(p)) {
				const src = this.expr(p.expression);
				if (this.isAny(p.expression)) {
					const tmp = this.fresh('__spread');
					spreadTemps.push(`let ${tmp}: Any? = ${this.tryPrefix(p.expression)}${src}`);
					for (const f of order) {
						const field = `${RT.jsField}(${tmp}, ${swiftString(f.name)})`;
						// A field the class holds present takes lenient code's value as its zero, or checked where it has none: JavaScript's TypeError where it is missing.
						const strict = this.lenient && this.shapeHeld(f) === f.type && !holdsNil(heldOf(spelledType(f.type)));
						const present = strict && this.spreadChecked(f.type) ? this.presentFromAny(field, f.type, true) : null;
						const read = present?.startsWith('try ') ? `(${present})` : (present ?? (strict ? this.fromAnyOrZero(field, f.type) : this.fromAnyCode(field, f.type, true)));
						const prev = given.get(f.name) ?? (spelledOptional(heldOf(spelledType(f.type))) ? 'nil' : this.zero(f.type));
						// A field no other key gives and no zero fills (`device: GPUDevice`): only the spread can.
						given.set(f.name, prev === null ? read : `(${RT.jsHasKey}(${tmp}, ${swiftString(f.name)}) ? ${read} : ${prev})`);
					}
					continue;
				}
				const spread = this.checker.getTypeAtLocation(p.expression);
				const fields = new Set(
					this.checker
						.getNonNullableType(spread)
						.getProperties()
						.map((x) => programSymbolKey(x, this.checker)?.member ?? x.name),
				);
				const missing = this.loose(p.expression) || this.states.spreadMayBeEmpty(p.expression);
				for (const f of order) {
					if (!fields.has(f.name)) continue;
					const prev = missing ? (given.get(f.name) ?? (holdsNil(heldOf(spelledType(f.type))) || this.lenientRef(f.type) !== f.type ? 'nil' : this.zero(f.type))) : null;
					given.set(f.name, prev ? `(${RT.jsImplicit}(${src})?.${ident(f.name)} ?? ${prev})` : `${src}.${ident(f.name)}`);
				}
			} else if (ts.isMethodDeclaration(p)) {
				const key = literalKey(p.name, this.checker) ?? this.symbolMemberName(p.name) ?? p.name.getText();
				const want = functionParts((order.find((f) => f.name === key)?.type ?? '').replace(/^\((.*)\)[?!]$/, '$1'));
				// An unannotated method returning an object literal makes it against its field's declared result, as TypeScript types the returned literal.
				const sig = !p.type && want && want.result !== 'Void' ? this.checker.getSignatureFromDeclaration(p) : undefined;
				const literalResult = !!sig && !!this.checker.getReturnTypeOfSignature(sig).symbol?.declarations?.some(ts.isObjectLiteralExpression);
				const ret = literalResult ? want!.result : this.returnTypeOf(p);
				const body = self ? this.withThis(p, this.marks.unwrappedCode(self), false, () => this.functionBody(p, ret, this.indent)) : this.functionBody(p, ret, this.indent);
				const fn = `{ (${this.params(p, true)}) ${this.throwsInfo.fn(p) ? 'throws ' : ''}-> ${ret} in${body.slice(1)}`;
				// A method declaring fewer parameters, or giving nothing, where its field's function type takes more or gives a value (`handlerError() {}` for `(error) => any`).
				const params = p.parameters.length
					? splitTopLevel(this.params(p, false)).map((d) =>
							withoutDefault(d.slice(d.indexOf(':') + 1))
								.trim()
								.replace(/^@escaping /, '')
								.replace(/!$/, '?'),
						)
					: [];
				const adapt = want && !p.parameters.some((q) => q.dotDotDotToken) && params.length <= want.params.length && (params.length < want.params.length || (ret === 'Void' && want.result !== 'Void'));
				given.set(key, adapt ? this.convert(fn, `(${params.join(', ')}) throws -> ${ret}`, want!.text) : fn);
			} else throw this.error(p, 'object member');
		}
		// Library mode: a literal of a result interface (`resultShapesOf`) has each key it names, undefined or not.
		if (resultShapeNamed(this, target)) {
			for (const p of e.properties) {
				const key = ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) ? (literalKey(p.name, this.checker) ?? p.name.getText()) : null;
				const f = key !== null ? order.find((x) => x.name === key) : undefined;
				if (key !== null && f && holdsNil(heldOf(spelledType(f.type))) && !unsetKeys.includes(key)) unsetKeys.push(key);
			}
		}
		this.used.add(name);
		const inOrder = shapePlanOfLiteral(e, this.states)
			.keys.map((k) => k.name)
			.filter((k) => order.some((f) => f.name === k));
		const declared = order.map((f) => f.name).filter((n) => inOrder.includes(n));
		// A spread of a typed object copies its keys in the order that object holds them, known when it runs.
		const spreads = e.properties.filter(ts.isSpreadAssignment).filter((p) => !this.isAny(p.expression) && this.pure(p.expression));
		const parts = e.properties.map((p) => (ts.isSpreadAssignment(p) ? this.spreadKeys(p.expression) : `[${p.name ? swiftString(literalKey(p.name, this.checker) ?? p.name.getText()) : ''}]`));
		const reorder = spreads.length ? `, jsOrder: ${RT.jsLiteralKeyOrder}([${parts.join(', ')}], fields: [${order.map((f) => swiftString(f.name)).join(', ')}])` : inOrder.join() !== declared.join() ? `, jsOrder: [${inOrder.map(swiftString).join(', ')}]` : '';
		const args = initOrder(order as ShapeField[])
			.flatMap((f) => {
				const a = (f as ShapeField).accessor;
				if (a) return [...(a.get ? [`__get_${f.name}: ${given.get(`__get_${f.name}`)}`] : []), ...(a.set ? [`__set_${f.name}: ${given.get(`__set_${f.name}`)}`] : [])];
				return given.has(f.name) ? [`${label((f as { member?: string }).member ?? f.name)}: ${given.get(f.name)}`] : [];
			})
			.join(', ');
		// A field the literal sets to null, which the shape holds as nil, is kept as null (JSON, keys, untyped reads).
		const nullKeys = e.properties.filter((p): p is ts.PropertyAssignment | ts.ShorthandPropertyAssignment => !!notes.get(p)?.null).map((p) => literalKey(p.name, this.checker) ?? p.name.getText());
		// An untyped value may be null, which only the run can tell.
		const untypedKeys = e.properties.filter((p): p is ts.PropertyAssignment | ts.ShorthandPropertyAssignment => notes.get(p)?.unset === 'untyped').map((p) => `(${swiftString(literalKey(p.name, this.checker) ?? p.name.getText())}, ${this.expr(ts.isPropertyAssignment(p) ? p.initializer : p.name)})`);
		const holdsNulls = order.some((f) => heldOf(spelledType(f.type)) === 'optional');
		if (keysVar) spreadTemps.unshift(`var ${keysVar} = JSLiteralKeys(${[...(nullKeys.length ? [`nulls: [${nullKeys.map(swiftString).join(', ')}]`] : []), ...(unsetKeys.length ? [`unset: [${unsetKeys.map(swiftString).join(', ')}]`] : [])].join(', ')})`, ...keyNotes);
		const nulled = keysVar ? `${holdsNulls ? `, jsNulls: ${keysVar}.nulls` : ''}, jsUnset: ${keysVar}.unset` : (untypedKeys.length ? `, jsNulls: ${RT.jsNullKeysOf}([${nullKeys.map(swiftString).join(', ')}], [${untypedKeys.join(', ')}])` : nullKeys.length ? `, jsNulls: [${nullKeys.map(swiftString).join(', ')}]` : '') + (unsetKeys.length ? `, jsUnset: [${unsetKeys.map(swiftString).join(', ')}]` : '');
		const made = `${target}(${args}${args && reorder ? reorder : reorder.slice(2)}${args || reorder ? nulled : nulled.slice(2)})`;
		if (!spreadTemps.length && !self) return made;
		const throws = this.throwsInfo.expr(e);
		const made2 = this.marks.tryIf(throws && this.marks.markOf(made)?.op !== 'try', `${made}`);
		if (self) return `{ () ${throws ? 'throws ' : ''}-> ${target} in ${spreadTemps.map((x) => x + '; ').join('')}weak var ${self}: ${target}?; let __made = ${made2}; ${self} = __made; return __made }()`;
		return `{ () ${throws ? 'throws ' : ''}-> ${target} in ${spreadTemps.join('; ')}; return ${made2} }()`;
	},

	/** An object literal typed as an iterator (`{ next() {…}, return() {…} }`): its members are what the kit steps. */
	scriptIterator(this: Translator, e: ts.ObjectLiteralExpression, type: string): string {
		const async = isKit(spelledType(type), 'JSAsyncIterator');
		const element = type.replace(/^JS\w+<(.*)>$/, '$1');
		const member = (key: string) => {
			const p = e.properties.find((x) => x.name && (literalKey(x.name, this.checker) ?? x.name.getText()) === key);
			if (!p) return null;
			if (ts.isMethodDeclaration(p)) {
				const own = p.parameters.filter((q) => !(ts.isIdentifier(q.name) && q.name.text === 'this'));
				return { code: this.closure(p as unknown as ts.FunctionExpression), type: `(${own.map((q) => this.typeOf(q.name)).join(', ')}) throws -> ${this.returnTypeOf(p)}`, params: own.length };
			}
			if (ts.isPropertyAssignment(p) && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) return { code: this.closure(p.initializer), type: `(${p.initializer.parameters.map((q) => this.typeOf(q.name)).join(', ')}) throws -> ${this.closureResult(p.initializer).target}`, params: p.initializer.parameters.length };
			throw this.error(p, 'this member of an iterator object');
		};
		for (const p of e.properties) {
			const key = p.name && (literalKey(p.name, this.checker) ?? p.name.getText());
			if (!key || !['next', 'return', 'throw'].includes(key)) throw this.error(p, 'this member of an iterator object');
		}
		const adapt = (key: string, arg: string) => {
			const m = member(key);
			if (!m) return null;
			const ret = functionParts(m.type)!.result;
			const call = this.marks.tryCode(`(${m.code})(${m.params ? arg : ''})`);
			if (!async) return `{ (${arg}: Any?) throws -> Any? in ${this.convert(call, ret, 'Any?')} }`;
			const inner = ret.replace(/^JSPromise<(.*)>$/, '$1');
			return `{ (${arg}: Any?) throws -> JSPromise<Any?> in ${isUntyped(spelledType(inner)) ? call : `${call}.then { (__v: ${inner}) -> Any? in ${this.convert('__v', inner, 'Any?')} }`} }`;
		};
		const args = [
			`next: ${adapt('next', '__v')}`,
			...['return', 'throw'].flatMap((k) => {
				const a = adapt(k, '__v');
				return a ? [`${k}: ${a}`] : [];
			}),
		];
		return `${async ? 'JSScriptAsyncIterator' : 'JSScriptIterator'}<${element}>(${args.join(', ')})`;
	},

	/** An object literal typed `any`: a plain JavaScript object. */
	dynamicObject(this: Translator, e: ts.ObjectLiteralExpression): string {
		this.dynamicLiterals.add(e);
		try {
			return this.dynamicObjectCode(e);
		} finally {
			this.dynamicLiterals.delete(e);
		}
	},

	dynamicObjectCode(this: Translator, e: ts.ObjectLiteralExpression): string {
		// A function expression reading `this` (`isVisible: function () { return this.get(…) }`) is a method of the object.
		const thisFunction = (p: ts.ObjectLiteralElementLike): p is ts.PropertyAssignment & { initializer: ts.FunctionExpression } => ts.isPropertyAssignment(p) && ts.isFunctionExpression(p.initializer) && !p.initializer.name && thisNodes(p.initializer).length > 0;
		const simple = e.properties.every((p) => (ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name) && !thisFunction(p)) || ts.isShorthandPropertyAssignment(p));
		if (simple) {
			const entries = e.properties.map((p) => {
				if (ts.isPropertyAssignment(p)) return `(${swiftString(literalKey(p.name, this.checker) ?? p.name.getText())}, ${ts.isObjectLiteralExpression(p.initializer) ? this.dynamicObject(p.initializer) : this.stored(p.initializer, p, 'Any?')})`;
				const sh = p as ts.ShorthandPropertyAssignment;
				return `(${swiftString(sh.name.text)}, ${this.coerce(sh.name, 'Any?')} as Any?)`;
			});
			return `JSObject([${entries.join(', ')}])`;
		}
		// Spreads, computed keys and methods: the object built key by key, in the literal's order.
		const o = this.fresh('__o');
		const key = (n: ts.PropertyName) => (ts.isComputedPropertyName(n) ? `${this.tryPrefix(n.expression)}${this.propertyKey(n.expression)}` : swiftString(literalKey(n, this.checker) ?? n.getText()));
		const accessorsDone = new Set<string>();
		const steps = e.properties.flatMap((p) => {
			if (ts.isSpreadAssignment(p)) return [`${this.tryPrefix(p.expression)}${RT.jsObjectSpread}(${o}, ${this.coerce(p.expression, 'Any?')})`];
			if (ts.isShorthandPropertyAssignment(p)) return [`${o}[${swiftString(p.name.text)}] = ${this.coerce(p.name, 'Any?')}`];
			if (thisFunction(p)) return [`${o}[${key(p.name)}] = ${this.untypedMethod(p.initializer as unknown as ts.MethodDeclaration)}`];
			if (ts.isPropertyAssignment(p)) return [`${o}[${key(p.name)}] = ${this.marks.tryBefore(this.tryPrefix(p.initializer), this.stored(p.initializer, p, 'Any?'))}`];
			if (ts.isMethodDeclaration(p)) return [`${o}[${key(p.name)}] = ${this.untypedMethod(p)}`];
			if (ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) {
				// A getter and a setter of one key make one property, where the first of them is.
				const name = p.name.getText();
				if (accessorsDone.has(name)) return [];
				accessorsDone.add(name);
				const pair = e.properties.filter((q): q is ts.AccessorDeclaration => (ts.isGetAccessorDeclaration(q) || ts.isSetAccessorDeclaration(q)) && q.name.getText() === name);
				const g = pair.find(ts.isGetAccessorDeclaration),
					st = pair.find(ts.isSetAccessorDeclaration);
				const get = g ? `get: { (__this: Any?) throws -> Any? in${this.withThis(g, '__this', true, () => this.functionBody(g, 'Any?', this.indent)).slice(1)}` : '';
				const v = st && (st.parameters[0].name as ts.Identifier);
				const set = st && v ? `set: { (__this: Any?, ${ident(v.text)}: Any?) throws -> Void in${this.withThis(st, '__this', true, () => this.functionBody(st, 'Void', this.indent)).slice(1)}` : '';
				// A configurable property of an object being made: defining it cannot fail.
				return [`_ = try? ${o}.defineProperty(${key(p.name)}, JSPropertyDescriptor(${[get, set, 'enumerable: true', 'configurable: true'].filter(Boolean).join(', ')}))`];
			}
			throw this.error(p, 'this member in an untyped object literal');
		});
		// Whether building the object throws (closures it holds throw on their own).
		const throws = this.throwsInfo.expr(e) || steps.some((x) => x.startsWith('try '));
		return `{ () ${throws ? 'throws ' : ''}-> JSObject in let ${o} = JSObject(); ${steps.join('; ')}; return ${o} }()`;
	},
};
