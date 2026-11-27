// Literals as Kotlin: arrays, objects and class expressions, structural copies and dynamic objects.
import ts from 'typescript';
import { cast, destructuringSource, ident, isNullable, jsObjectCode, kotlinString, optionalType, splitTopLevel, spell, RT } from './syntax.ts';
import type { ShapeField, Translator } from './translator.ts';
import { assertedOperand, evolvingElementContext, intersectionAliasMembers, isTypeParameterType, literalKey, openSpreadType, spreadOperand, unquoted, wellKnownMember } from '../semantics/lang.ts';
import { holdsNil, literalNotes, signatureField, shapePlanOfLiteral, spelledOptional, spreadElementNeedsMap, resultShapeNamed } from '../semantics/shapes.ts';
import { structural, type Structural, type StructuralFacts } from '../semantics/conversion.ts';
import { heldOf, isKit, isUntyped, parseNativeType, spelledType } from '../semantics/types.ts';
import { boxStep, unboxStep, type TypeStep } from '../semantics/type-step.ts';
import { place } from '../semantics/placement.ts';
import { hasModifier, isLibDeclaration, thisNodes, tupleSpreadTypes } from '../semantics/ast.ts';
import { isCoreDeclaration } from '../program/core-facts.ts';
import { isStatic } from '../semantics/throws.ts';
import { programSymbolKey } from '../program/stable-names.ts';
import { classOfType, literalClassOf } from '../semantics/classes.ts';

export const literalsMethods = {
	array(this: Translator, e: ts.ArrayLiteralExpression): string {
		// A destructuring pattern's implied type (`const [a, b] = [0, 1]`) types nothing: the literal's own does.
		const destructured = (ts.isVariableDeclaration(e.parent) && e.parent.initializer === e && ts.isArrayBindingPattern(e.parent.name)) || destructuringSource(e);
		const context = destructured ? undefined : this.checker.getContextualType(e);
		let t = this.typeOf(e);
		// A spread's length is known only when it runs: no tuple.
		if (context && !(context.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) && !(this.checker.isTupleType(context) && e.elements.some(ts.isSpreadElement))) {
			const c = this.heldElements(e, this.type(context, e)).replace(/\?$/, '');
			if (isKit(spelledType(c), 'JSArray') || c.startsWith('Pair<') || c.startsWith('Triple<') || !e.elements.length) t = c;
			// Where an array or other kinds of value go (`data: string[][] | string`): that array.
			const arrays = context.isUnion() ? context.types.filter((u) => this.checker.isArrayType(u) || this.checker.isTupleType(u)) : [];
			if (c === 'Any' && arrays.length === 1) t = this.type(arrays[0], e);
			// Where arrays of different elements go (`string[] | number[]`): an untyped array.
			else if (!/^(JSArray|Pair|Triple)</.test(t) && arrays.length > 1 && context.isUnion() && arrays.length === context.types.length) t = 'JSArray<Any?>';
		}
		const placedElement = this.states.literalElementType(e);
		if (placedElement) t = this.heldElements(e, `JSArray<${this.type(placedElement, e)}>`);
		// Held untyped, its object literals are script objects (`set('items', [{ subItems: [1] }])`): an untyped array.
		if (isUntyped(spelledType(t)) || (context && context.flags & ts.TypeFlags.Any && (this.inPluginFile(e) || (!this.library && e.elements.some(ts.isObjectLiteralExpression))))) t = 'JSArray<Any?>';
		// `[]` where a match array goes (`text.match(re) || []`): an empty match.
		if (t === 'JSMatch' && !e.elements.length) return 'JSMatch.empty()';
		if (t.startsWith('Pair<') || t.startsWith('Triple<')) {
			const types = splitTopLevel(t.replace(/^(Pair|Triple)<(.*)>$/, '$2'));
			if (e.elements.some(ts.isSpreadElement)) {
				const binds: string[] = [];
				const items: string[] = [];
				for (const x of e.elements) {
					if (ts.isSpreadElement(x)) {
						const tArgs = tupleSpreadTypes(x, this.checker);
						if (tArgs) {
							const spreadCode = this.expr(x.expression);
							const ref = ts.isIdentifier(x.expression) ? spreadCode : this.fresh('__tup');
							if (ref !== spreadCode) binds.push(`val ${ref} = ${spreadCode}`);
							const spreadType = this.typeOf(x.expression);
							const pairOrTriple = spreadType.startsWith('Pair<') || spreadType.startsWith('Triple<');
							for (let k = 0; k < tArgs.length; k++) {
								const elem = pairOrTriple ? `${ref}.${['first', 'second', 'third'][k]}` : `${ref}[${k}]`;
								const from = this.type(tArgs[k], x);
								const targetType = types[items.length];
								items.push(targetType && targetType !== from ? this.convert(elem, from, targetType) : elem);
							}
							continue;
						}
						throw this.error(x, `a non-tuple spread in ${t}`);
					}
					const to = types[items.length];
					items.push(to ? this.coerce(x, to) : this.expr(x));
				}
				const missing = types
					.slice(items.length)
					.filter(isNullable)
					.map(() => 'null');
				const made = `${t.replace(/<.*/, '')}(${[...items, ...missing].join(', ')})`;
				return binds.length ? `run { ${binds.join('; ')}; ${made} }` : made;
			}
			// A literal shorter than its tuple type leaves an optional element out: undefined there.
			const missing = types
				.slice(e.elements.length)
				.filter(isNullable)
				.map(() => 'null');
			return `${t.replace(/<.*/, '')}(${[...e.elements.map((x, k) => this.coerce(x, types[k])), ...missing].join(', ')})`;
		}
		const el = t.replace(/^JSArray<(.*)>$/, '$1');
		if (!e.elements.length) return t === 'JSArray<Double>' ? this.construction('JSArray.doubles()', t) : /^JSArray</.test(t) ? this.construction(`${t}()`, t) : `${t}()`;
		// An array of objects holds a Kotlin null, which reads as undefined.
		const nulled = !isNullable(el) && e.elements.find((x) => !ts.isSpreadElement(x) && this.states.nullResult(ts.skipOuterExpressions(x, ts.OuterExpressionKinds.Parentheses)));
		if (nulled) throw this.error(nulled, `the null a non-strict function may give, in an array of ${el}`);
		if (!e.elements.some(ts.isSpreadElement)) {
			if (e.elements.some(ts.isOmittedExpression)) throw this.error(e, 'an array hole', 'array-hole');
			const slot = this.elementSlot(e, el);
			const ctor = el === 'Double' ? 'JSArray.doublesOf' : `${RT.jsArrayOf}<${el}>`;
			return this.marks.marked(`${ctor}(${e.elements.map((x) => place(this.placement, x, slot(x))).join(', ')})`, { op: 'array', element: el });
		}
		const parts: string[] = [];
		let run: string[] = [];
		for (const x of e.elements) {
			if (ts.isSpreadElement(x)) {
				if (run.length) {
					parts.push(`listOf<${el}>(${run.join(', ')})`);
					run = [];
				}
				const items = `(${this.iterable(x.expression)}).toList()`;
				parts.push(spreadElementNeedsMap(this.elementTypeOf(x.expression), el, (n) => this.isShapeType(n), !!this.library) ? `${items}.map { ${this.fromAny('it', el)} }` : items);
			} else if (ts.isOmittedExpression(x)) throw this.error(x, 'an array hole', 'array-hole');
			else run.push(place(this.placement, x, this.elementSlot(e, el)(x)));
		}
		if (run.length) parts.push(`listOf<${el}>(${run.join(', ')})`);
		return `${t}(${parts.join(' + ')})`;
	},

	/** An object literal, made as its contextual type, else its own; as `madeAs` where its placement decides that. */
	object(this: Translator, e: ts.ObjectLiteralExpression, madeAs?: ts.Type): string {
		// `{ … } satisfies T` is of the literal's own type, and so are the literals in it: T only checks them.
		let outer: ts.Node = e;
		while (ts.isPropertyAssignment(outer.parent) && ts.isObjectLiteralExpression(outer.parent.parent)) outer = outer.parent.parent;
		let contextual = madeAs ?? (ts.isSatisfiesExpression(outer.parent) || destructuringSource(e) || spreadOperand(e) ? undefined : (evolvingElementContext(e, this.checker) ?? this.checker.getContextualType(e)));
		// An async function's result (`T | PromiseLike<T>` where it returns): the T a literal can be.
		if (contextual?.isUnion()) {
			const plain = contextual.types.filter((t) => !t.getProperty('then'));
			if (plain.length === 1 && plain.length < contextual.types.length) contextual = plain[0];
		}
		// An object held untyped is extensible, as every script object is.
		if (contextual && contextual.flags & ts.TypeFlags.Any) return this.dynamicObject(e);
		// `{ … } as unknown as T`: an object script reads and extends untyped.
		if (contextual && contextual.flags & ts.TypeFlags.Unknown) return this.dynamicObject(e);
		const type = contextual ?? this.checker.getTypeAtLocation(e);
		const struct = this.native?.structLiteral(e, this.checker.getNonNullableType(type));
		if (struct) return struct;
		const name = this.heldElements(e, this.type(this.checker.getNonNullableType(type), e).replace(/\?$/, ''));
		const held = spelledType(name);
		if (isKit(held, 'JSRecord')) {
			const v = spell(held.args[0]);
			if (e.properties.some(ts.isSpreadAssignment)) {
				const r = this.fresh('__r');
				const steps = e.properties.map((p) => {
					if (ts.isSpreadAssignment(p)) return `${RT.jsObjectSpread}(${r}.obj, ${this.coerce(p.expression, 'Any?')})`;
					if (ts.isPropertyAssignment(p)) return `${r}.obj[${ts.isComputedPropertyName(p.name) ? this.propertyKey(p.name.expression) : kotlinString(literalKey(p.name, this.checker) ?? p.name.getText())}] = ${this.stored(p.initializer, p, v)}`;
					if (ts.isShorthandPropertyAssignment(p)) return `${r}.obj[${kotlinString(p.name.text)}] = ${this.shorthandValue(p.name)}`;
					if (ts.isMethodDeclaration(p)) return `${r}.obj[${ts.isComputedPropertyName(p.name) ? this.propertyKey(p.name.expression) : kotlinString(literalKey(p.name, this.checker) ?? p.name.getText())}] = ${this.untypedMethod(p)}`;
					throw this.error(p, 'this member in a dictionary literal');
				});
				return `run { val ${r} = ${name}(); ${steps.join('; ')}; ${r} }`;
			}
			const entries = e.properties.map((p) => {
				if (ts.isPropertyAssignment(p)) return `Pair(${ts.isComputedPropertyName(p.name) ? this.propertyKey(p.name.expression) : kotlinString(literalKey(p.name, this.checker) ?? p.name.getText())}, ${this.stored(p.initializer, p, v)})`;
				if (ts.isShorthandPropertyAssignment(p)) return `Pair(${kotlinString(p.name.text)}, ${this.shorthandValue(p.name)})`;
				if (ts.isMethodDeclaration(p)) return `Pair(${ts.isComputedPropertyName(p.name) ? this.propertyKey(p.name.expression) : kotlinString(literalKey(p.name, this.checker) ?? p.name.getText())}, ${this.untypedMethod(p)})`;
				throw this.error(p, 'this member in a dictionary literal');
			});
			return this.construction(entries.length ? `${name}(listOf(${entries.join(', ')}))` : `${name}()`, name);
		}
		// Library mode: core's own EventData, holding what the literal adds beyond its fields.
		if (name === 'EventData' && this.library) return `EventData.fromJS(${this.dynamicObject(e)})`;
		if (isUntyped(spelledType(name)) || name === 'Any' || name === 'Nothing' || name === 'JSObject' || name === 'EventData') return this.dynamicObject(e);
		if (isTypeParameterType(type, this.checker)) return this.fromAnyCode(this.dynamicObject(e), name);
		// The generated kit: an object of an interface core declares (`TraceErrorHandler`), which core holds untyped and calls by name.
		if (this.generatedKit && this.core?.has(`${name}Object`) && isCoreDeclaration(this.checker.getNonNullableType(type).getSymbol()?.declarations?.[0])) return this.dynamicObject(e);
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
		let order: { name: string; type: string; member?: string }[];
		let target = name;
		if (this.protocols.has(name) && decl && ts.isInterfaceDeclaration(decl)) {
			target = `${name}Object`;
			const members = this.withInherited(decl, decl.members);
			order = [...members.filter(ts.isPropertySignature).map((m) => ({ name: (m.name as ts.Identifier).text, type: m.questionToken ? optionalType(this.typeOf(m)) : this.typeOf(m) })), ...members.filter(ts.isMethodSignature).map((m) => signatureField(m.name.getText(), this.typeOf(m)))];
		} else if (shape) order = shape.fields;
		else if (decl && (ts.isInterfaceDeclaration(decl) || ts.isTypeLiteralNode(decl))) {
			const all = this.withInherited(decl, decl.members);
			order = this.interfaceFields(all);
		} else if (joined) {
			order = joined.map((m) => this.interfaceField(m));
		} else if (classOfType(type, this.checker) ?? literalClassOf(this, e)) {
			const cls = (classOfType(type, this.checker) ?? literalClassOf(this, e))!;
			if (this.library || this.inPluginFile(e) || hasModifier(cls, ts.SyntaxKind.AbstractKeyword)) return this.classLiteral(e, cls, name);
			throw this.error(e, `an object literal of type ${name}`);
		} else if (decl && ts.isModuleDeclaration(decl)) {
			return this.dynamicObject(e);
		} else throw this.error(e, `an object literal of type ${name}`);
		const given = new Map<string, string>();
		// Methods that read `this` see the object through a variable the literal sets once it exists.
		// A function expression as a member (`onViewLoaded: function () { this.loadedCount++ }`) reads the object as `this` too.
		const thisFunction = (p: ts.ObjectLiteralElementLike): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isFunctionExpression(p.initializer) && thisNodes(p.initializer).length > 0;
		const self = e.properties.some((p) => (ts.isMethodDeclaration(p) && thisNodes(p).length) || thisFunction(p)) ? this.fresh('__self') : null;
		const spreadTemps: string[] = [];
		// A field the literal sets to null, which the shape holds as Kotlin's null, is noted as null (JSON, keys, untyped reads).
		const protocolObject = target === `${name}Object` && !this.library;
		const nullFields = (shape?.fields ?? (decl && (ts.isInterfaceDeclaration(decl) || ts.isTypeLiteralNode(decl)) && (!this.protocols.has(name) || protocolObject) ? order : null)) as ShapeField[] | null;
		const tracksNulls = !!nullFields && (target === name || protocolObject) && !nullFields.some((f) => f.symbol || f.accessor);
		// An optional field given undefined is a key all the same, as one given null is: the shape notes which (`jsUnset`,
		// `jsNulls`), from the value's type, or as it runs (`JSLiteralKeys`) where only the run tells.
		const notesKeys = tracksNulls && !this.lenient && !this.library && !this.pluginFiles.has(e.getSourceFile().fileName);
		const notes = literalNotes(e, this.states, this.shapeFacts(), { fields: (nullFields ?? []).map((f) => ({ name: f.name, type: f.type, holds: f.type })), tracks: tracksNulls && !this.library, notes: notesKeys, wholeLiterals: false });
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
				const branch = (x: ts.Expression) => (split.nulls.includes(x) ? `${k}.nulled(${kotlinString(key)}, ${this.coerce(x, f.type)})` : this.coerce(x, f.type));
				return `(if (${this.cond(split.cond.condition)}) ${branch(split.cond.whenTrue)} else ${branch(split.cond.whenFalse)})`;
			}
			if (noting === 'given') {
				unsetKeys.push(key);
				return code();
			}
			const k = (keysVar ??= this.fresh('__keys'));
			const untypedUnder = (x: ts.Expression) => (heldOf(spelledType(f.type)) === 'any' ? null : assertedOperand(x, (y) => this.isAny(y)));
			// A conditional's branches may give null, undefined or an untyped value: each is noted as it runs.
			const leaves = (x: ts.Expression): ts.Expression[] => {
				const b = ts.skipParentheses(x);
				return ts.isConditionalExpression(b) ? [...leaves(b.whenTrue), ...leaves(b.whenFalse)] : [x];
			};
			if (ts.isConditionalExpression(ts.skipParentheses(value)) && leaves(value).some(untypedUnder)) {
				const branch = (x: ts.Expression): string => {
					const b = ts.skipParentheses(x);
					if (ts.isConditionalExpression(b)) return `(if (${this.cond(b.condition)}) ${branch(b.whenTrue)} else ${branch(b.whenFalse)})`;
					if (b.kind === ts.SyntaxKind.NullKeyword) return `${k}.nulled(${kotlinString(key)}, ${this.coerce(x, f.type)})`;
					const op = untypedUnder(x);
					if (!op) return `${k}.typed(${kotlinString(key)}, ${this.coerce(x, f.type)})`;
					this.subst.set(op, `${k}.untyped(${kotlinString(key)}, ${this.expr(op)})`);
					try {
						return this.coerce(x, f.type);
					} finally {
						this.subst.delete(op);
					}
				};
				return branch(value);
			}
			const under = untypedUnder(value);
			const how = under ? 'untyped' : 'typed';
			// The value as the field takes it: `expr` would hold it to its narrowed type (`?: jsObjectRequired()`), never nil.
			if (ts.isIdentifier(value)) {
				keyNotes.push(`${k}.${how}(${kotlinString(key)}, ${how === 'typed' && heldOf(spelledType(f.type)) !== 'any' ? this.coerce(value, f.type) : this.expr(value)})`);
				return code();
			}
			if (how === 'typed') return `${k}.typed(${kotlinString(key)}, ${code()})`;
			// Null and undefined apart before the value is converted to the field's type, which holds both as null.
			const at = under ?? value;
			this.subst.set(at, `${k}.untyped(${kotlinString(key)}, ${this.expr(at)})`);
			try {
				const made = code();
				if (!made.includes(`${k}.untyped(`)) throw this.error(value, 'this untyped value for an optional field of an object literal');
				return made;
			} finally {
				this.subst.delete(at);
			}
		};
		for (const p of e.properties) {
			if (ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) {
				const key = literalKey(p.name, this.checker) ?? p.name.getText();
				const f = order.find((x) => x.name === key) as ShapeField | undefined;
				if (!f?.accessor) throw this.error(p, 'an accessor in an object literal of this type');
				const ak = unquoted(ident(key));
				if (ts.isGetAccessorDeclaration(p)) {
					const body = this.withThis(p, '__this', false, () => this.functionBody(p, f.type, this.indent));
					given.set(`__get_${ak}`, `fun(__this: ${target}): ${f.type} ${body}`);
				} else {
					const v = p.parameters[0].name as ts.Identifier;
					const body = this.withThis(p, '__this', false, () => this.functionBody(p, 'Unit', this.indent));
					given.set(`__set_${ak}`, `fun(__this: ${target}, ${ident(v.text)}: ${f.accessor.value}) ${body}`);
				}
				continue;
			}
			if (ts.isMethodDeclaration(p) && self && thisNodes(p).length) {
				const key = literalKey(p.name, this.checker) ?? this.symbolMemberName(p.name) ?? p.name.getText();
				const want = order.find((f) => f.name === key)?.type;
				given.set(
					key,
					this.withThis(p, self, false, () => this.closure(p, want)),
				);
				continue;
			}
			if (ts.isPropertyAssignment(p)) {
				const key = literalKey(p.name, this.checker) ?? this.symbolMemberName(p.name) ?? p.name.getText();
				const want = order.find((f) => f.name === key)?.type ?? 'Any?';
				given.set(key, self && thisFunction(p) ? this.withThis(p.initializer, self, false, () => this.stored(p.initializer, p, want)) : noteKey(p, key, p.initializer, () => this.stored(p.initializer, p, want)));
			} else if (ts.isShorthandPropertyAssignment(p)) {
				noteKey(p, p.name.text, p.name, () => '');
				const ft = order.find((f) => f.name === p.name.text)?.type ?? 'Any?';
				// A class (`{ MyComponent }`, a module's exports): its Java class, as a class held as a value is.
				const classDecl = this.checker.getShorthandAssignmentValueSymbol(p)?.valueDeclaration;
				if (!this.library && classDecl && ts.isClassDeclaration(classDecl) && !classDecl.getSourceFile().isDeclarationFile) {
					given.set(p.name.text, `${this.className(classDecl)}::class.java`);
					continue;
				}
				const fn = isUntyped(spelledType(ft)) ? this.untypedShorthandFunction(p.name) : null;
				if (fn) {
					given.set(p.name.text, fn);
					continue;
				}
				given.set(p.name.text, isUntyped(spelledType(ft)) ? (this.library || isLibDeclaration(this.checker.getShorthandAssignmentValueSymbol(p)?.declarations?.[0]) ? this.expr(p.name) : this.states.nilIsNull(p.name) ? `${RT.jsNulled}(${this.narrowed(p.name, ident(p.name.text))})` : this.narrowed(p.name, ident(p.name.text))) : this.coerce(p.name, ft));
			} else if (ts.isSpreadAssignment(p)) {
				const src = this.expr(p.expression);
				if (this.isAny(p.expression)) {
					// An untyped source (a `Partial<…>` patch): each field it has replaces the one before.
					const tmp = this.fresh('__spread');
					spreadTemps.push(`val ${tmp}: Any? = ${src}`);
					for (const f of order) {
						const prev = given.get(f.name) ?? (spelledOptional(heldOf(spelledType(f.type))) ? 'null' : (this.zero(f.type) ?? 'null'));
						given.set(f.name, `(if (${RT.jsHasKey}(${tmp}, ${kotlinString(f.name)})) ${this.fromAnyCode(`${RT.jsField}(${tmp}, ${kotlinString(f.name)})`, f.type, true)} else ${prev})`);
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
				const missing = this.states.spreadMayBeEmpty(p.expression);
				for (const f of order) {
					if (!fields.has(f.name)) continue;
					const prev = missing ? (given.get(f.name) ?? 'null') : null;
					given.set(f.name, prev === null || (prev === 'null' && !f.type.endsWith('?')) ? `${src}.${ident(f.name)}` : prev === 'null' ? `(${src})?.${ident(f.name)}` : `((${src})?.${ident(f.name)} ?: ${prev})`);
				}
			} else if (ts.isMethodDeclaration(p)) {
				const key = literalKey(p.name, this.checker) ?? this.symbolMemberName(p.name) ?? p.name.getText();
				const want = order.find((f) => f.name === key)?.type;
				given.set(key, this.closure(p, want));
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
		const parts = e.properties.map((p) => (ts.isSpreadAssignment(p) ? `((${this.expr(p.expression)}) as? JSDynamic)?.jsKeys ?: listOf()` : `listOf(${p.name ? kotlinString(literalKey(p.name, this.checker) ?? p.name.getText()) : ''})`));
		const reorder = spreads.length ? `jsOrder = ${RT.jsLiteralKeyOrder}(listOf(${parts.join(', ')}), listOf(${order.map((f) => kotlinString(f.name)).join(', ')}))` : inOrder.join() !== declared.join() ? `jsOrder = listOf(${inOrder.map(kotlinString).join(', ')})` : '';
		const args = order.flatMap((f) => {
			const a = (f as ShapeField).accessor;
			const ak = unquoted(ident(f.name));
			if (a) return [...(a.get ? [`__get_${ak} = ${given.get(`__get_${ak}`)}`] : []), ...(a.set ? [`__set_${ak} = ${given.get(`__set_${ak}`)}`] : [])];
			return given.has(f.name) ? [`${ident(f.member ?? f.name)} = ${given.get(f.name)}`] : [];
		});
		const nullKeys = e.properties.filter((p): p is ts.PropertyAssignment | ts.ShorthandPropertyAssignment => !!notes.get(p)?.null).map((p) => literalKey(p.name, this.checker) ?? p.name.getText());
		// An untyped value may be null, which only the run can tell.
		const untypedKeys = e.properties.filter((p): p is ts.PropertyAssignment | ts.ShorthandPropertyAssignment => notes.get(p)?.unset === 'untyped').map((p) => `${kotlinString(literalKey(p.name, this.checker) ?? p.name.getText())} to ${this.expr(ts.isPropertyAssignment(p) ? p.initializer : p.name)}`);
		const keySet = (keys: string[]) => `mutableSetOf(${keys.map(kotlinString).join(', ')})`;
		if (keysVar) spreadTemps.unshift(`val ${keysVar} = JSLiteralKeys(${[...(nullKeys.length ? [`nulls = ${keySet(nullKeys)}`] : []), ...(unsetKeys.length ? [`unset = ${keySet(unsetKeys)}`] : [])].join(', ')})`, ...keyNotes);
		const noted = keysVar ? `.also { it.jsNulls = ${keysVar}.nulls; it.jsUnset = ${keysVar}.unset }` : untypedKeys.length ? `.also { it.jsNulls = ${RT.jsNullKeysOf}(listOf(${nullKeys.map(kotlinString).join(', ')}), ${untypedKeys.join(', ')})${unsetKeys.length ? `; it.jsUnset = ${keySet(unsetKeys)}` : ''} }` : nullKeys.length || unsetKeys.length ? `.also { ${[...(nullKeys.length ? [`it.jsNulls = ${keySet(nullKeys)}`] : []), ...(unsetKeys.length ? [`it.jsUnset = ${keySet(unsetKeys)}`] : [])].join('; ')} }` : '';
		const made = `${target}(${[...args, reorder].filter(Boolean).join(', ')})${noted}`;
		const built = self ? `run { lateinit var ${self}: ${target}; val __made = ${made}; ${self} = __made; __made }` : made;
		return this.construction(spreadTemps.length ? `run { ${spreadTemps.join('; ')}; ${built} }` : built, target);
	},

	/**
	 * Library mode: an object literal typed as one of the program's classes: an instance of an anonymous subclass, its
	 * functions overriding the class's methods (the literal's run, as in JavaScript, never the class's) and its values set.
	 */
	classLiteral(this: Translator, e: ts.ObjectLiteralExpression, cls: ts.ClassDeclaration, name: string): string {
		const lines: string[] = [];
		const inits: string[] = [];
		// A literal no type of the class's is at (one held as the class) has fields of its own types, which the class's fields take.
		const own = this.checker.getTypeAtLocation(e);
		const fields = classOfType(this.checker.getContextualType(e) ?? own, this.checker) ? own : this.checker.getDeclaredTypeOfSymbol(this.checker.getSymbolAtLocation(cls.name!)!);
		const method = (n: string) => cls.members.find((m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m) && (!!m.body || hasModifier(m, ts.SyntaxKind.AbstractKeyword)) && m.name.getText() === n) ?? this.inheritedMethod(cls, n);
		for (const p of e.properties) {
			if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p) && !ts.isMethodDeclaration(p)) throw this.error(p, `this member of an object literal of type ${name}`);
			const key = p.name.getText();
			const m = method(key);
			if (m) {
				const root = this.rootMethod(m);
				const params = root.parameters.map((x) => this.paramType(x));
				const ret = this.returnTypeOf(root);
				const names = this.signatureNames(ts.isMethodDeclaration(p) ? p : ts.isPropertyAssignment(p) ? p.initializer : p.name, this.paramNames(root), (k) => `__p${k}`);
				// `properties: null`: no function, which calling throws, as JavaScript's TypeError.
				const none = ts.isPropertyAssignment(p) && (p.initializer.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(p.initializer) && p.initializer.text === 'undefined'));
				if (none) {
					lines.push(`override fun ${ident(key)}(${params.map((t, k) => `${names[k]}: ${t}`).join(', ')})${ret === 'Unit' ? '' : `: ${ret}`} = throw JSException(JSTypeError(${kotlinString(`${key} is not a function`)}))`);
					continue;
				}
				const value = ts.isMethodDeclaration(p) ? this.closure(p, `(${params.join(', ')}) -> ${ret}`) : this.coerce(ts.isPropertyAssignment(p) ? p.initializer : p.name, `(${params.join(', ')}) -> ${ret}`);
				lines.push(`override fun ${ident(key)}(${params.map((t, k) => `${names[k]}: ${t}`).join(', ')})${ret === 'Unit' ? '' : `: ${ret}`} = (${value})(${names.join(', ')})`);
				continue;
			}
			const field = this.fieldIn(fields, key);
			const t = field ? this.typeOf(field.name) : 'Any?';
			inits.push(`this.${ident(key)} = ${this.coerce(ts.isPropertyAssignment(p) ? p.initializer : (p as ts.ShorthandPropertyAssignment).name, t)}`);
		}
		// Kotlin runs a class's field initializers with any of its constructors; a literal has none of them: the fields it doesn't give hold no value.
		const given = new Set(e.properties.map((p) => p.name?.getText()));
		const made = this.literalMade(cls);
		const resets = cls.members.flatMap((m) => {
			const z = ts.isPropertyDeclaration(m) && !isStatic(m) && m.initializer && !given.has(m.name.getText()) && (!made || this.pure(m.initializer)) ? this.zero(this.typeOf(m.name)) : null;
			return z ? [`this.${ident(m.name!.getText())} = ${z}`] : [];
		});
		if (resets.length || inits.length) lines.push(`init { ${[...resets, ...inits].join('; ')} }`);
		return `object : ${this.className(cls)}(${made ? 'Unit' : ''}) { ${lines.join('; ')} }`;
	},

	/** The step of a value of `from` held untyped: what its box is, which `coerceTyped`'s `'Any?'` path spells. */
	boxStep(this: Translator, from: string): TypeStep {
		return boxStep(from, this.library ? 'library' : this.lenient ? 'lenient' : 'checked');
	},

	/** The step of an untyped value read as `to`: which composite `fromAny` reads it into. */
	unboxStep(this: Translator, to: string): TypeStep {
		return unboxStep(to, this.library ? 'library' : this.lenient ? 'lenient' : 'checked');
	},

	/** `code`, an array of `source` that may be null, held as an array of `target`: its elements converted (`elementwise`), or the one array (erased). */
	nullableArrayAs(this: Translator, code: string, source: string, target: string): string {
		const [from, to] = [optionalType(source), optionalType(target)];
		if (from === to || !/^JSArray</.test(from) || !/^JSArray</.test(to)) return code;
		return this.elementwise(from, to)?.(code) ?? cast(code, to);
	},

	elementwise(this: Translator, source: string, target: string): ((code: string) => string) | null {
		const facts: StructuralFacts = { shape: (n) => this.isShapeType(n), extends: (a, b) => this.extendsClass(a, b) };
		const st = structural(parseNativeType(source), parseNativeType(target), facts);
		if (st?.step !== 'elements') return null;
		const element = (s: Structural, from: string, to: string): ((x: string) => string) | null => {
			const f = from.replace(/\?$/, ''),
				t = to.replace(/\?$/, ''),
				nullable = isNullable(from);
			if (s.step === 'copy') {
				const reader = this.protocols.has(t) ? `${t}Object` : t;
				return (x) => (nullable ? `${x}?.let { ${reader}.fromJS(it) }` : `${reader}.fromJS(${x})`);
			}
			if (s.step !== 'elements' || (s.container !== 'array' && s.container !== 'promise')) return null;
			const ef = /^JS(?:Array|Promise)<(.+)>$/.exec(f)?.[1],
				et = /^JS(?:Array|Promise)<(.+)>$/.exec(t)?.[1];
			const each = ef && et ? element(s.element, ef, et) : null;
			if (!each) return null;
			if (s.container === 'promise') return (x) => `${x}${nullable ? '?' : ''}.then { __v: ${ef} -> ${each('__v')} }`;
			return (x) => `${x}${nullable ? '?' : ''}.let { __a -> JSArray<${et}>(__a.storage.map { __e -> ${each('__e')} }) }`;
		};
		return element(st, source, target);
	},

	/** An interface's or object shape's Kotlin class. */
	isShapeType(this: Translator, name: string): boolean {
		return this.facts.hasInterface(this, this.interfaces, (d, s) => this.topName(d, s), name) || !!this.shapes.named(name) || (!this.library && !!this.core?.viewable?.(name));
	},

	/**
	 * A value of one of the app's object types where another goes (`DuoFold` passed as a `StageFold`): TypeScript's
	 * types are structural, Kotlin's classes are not, so the slot gets an object of its class with the value's fields.
	 */
	structuralCopy(this: Translator, e: ts.Expression, source: string, target: string): string | null {
		if (this.library) return null;
		const from = source.replace(/\?$/, ''),
			to = target.replace(/\?$/, '');
		if (from === to || !this.isShapeType(from) || !this.isShapeType(to)) return null;
		const contextual = this.checker.getContextualType(e);
		const props = contextual ? this.checker.getNonNullableType(contextual).getProperties() : [];
		// A literal is made as its contextual type already; a copy would lose the keys it notes.
		if (props.length && ts.isObjectLiteralExpression(ts.skipOuterExpressions(e)) && this.shapes.question(() => this.type(this.checker.getNonNullableType(contextual!)).replace(/\?$/, '') === to)) return this.expr(e);
		const code = this.expr(e);
		if (this.constructs(code, to)) return code;
		const reader = this.protocols.has(to) ? `${to}Object` : to;
		const view = this.viewOf(reader, '__s');
		if (!props.length || view === `${reader}.jsView(__s)`) return `(${code})${holdsNil(heldOf(spelledType(source))) ? '?' : ''}.let { __s -> ${view} }`;
		const fields = props
			.map((p) => programSymbolKey(p, this.checker)?.member ?? wellKnownMember(p.name) ?? p.name)
			.map((n) => `${ident(n)} = __s.${ident(n)}`)
			.join(', ');
		const notesNulls = (n: string) => {
			const s = this.shapes.named(n);
			return !!s && !s.fields.some((f) => f.symbol || f.accessor) && s.fields.some((f) => holdsNil(heldOf(spelledType(f.type))));
		};
		const nulls = notesNulls(from) && notesNulls(to) ? '.also { it.jsNulls = __s.jsNulls?.toMutableSet() }' : '';
		return `(${code})${holdsNil(heldOf(spelledType(source))) ? '?' : ''}.let { __s -> ${to}(${fields})${nulls} }`;
	},

	dynamicObject(this: Translator, e: ts.ObjectLiteralExpression): string {
		const simple = e.properties.every((p) => (ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name)) || ts.isShorthandPropertyAssignment(p));
		if (simple) {
			const entries = e.properties.map((p) => {
				// A function expression reading `this` is a method of the object, given it as its receiver.
				const method = ts.isPropertyAssignment(p) && ts.isFunctionExpression(p.initializer) && !p.initializer.name && thisNodes(p.initializer).length > 0;
				if (ts.isPropertyAssignment(p)) return [kotlinString(literalKey(p.name, this.checker) ?? p.name.getText()), method ? this.untypedMethod(p.initializer as unknown as ts.MethodDeclaration) : ts.isObjectLiteralExpression(p.initializer) ? this.dynamicObject(p.initializer) : this.stored(p.initializer, p, 'Any?')] as [string, string];
				const sh = p as ts.ShorthandPropertyAssignment;
				return [kotlinString(sh.name.text), this.untypedShorthandFunction(sh.name) ?? this.coerce(sh.name, 'Any?')] as [string, string];
			});
			return jsObjectCode(entries);
		}
		// Spreads, computed keys and methods: the object built key by key, in the literal's order.
		const o = this.fresh('__o');
		const key = (n: ts.PropertyName) => (ts.isComputedPropertyName(n) ? this.propertyKey(n.expression) : kotlinString(literalKey(n, this.checker) ?? n.getText()));
		const accessorsDone = new Set<string>();
		const steps = e.properties.flatMap((p) => {
			if (ts.isSpreadAssignment(p)) return [`${RT.jsObjectSpread}(${o}, ${this.coerce(p.expression, 'Any?')})`];
			if (ts.isShorthandPropertyAssignment(p)) return [`${o}[${kotlinString(p.name.text)}] = ${this.coerce(p.name, 'Any?')}`];
			if (ts.isPropertyAssignment(p)) return [`${o}[${key(p.name)}] = ${this.stored(p.initializer, p, 'Any?')}`];
			if (ts.isMethodDeclaration(p)) return [`${o}[${key(p.name)}] = ${this.untypedMethod(p)}`];
			if (ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) {
				// A getter and a setter of one key make one property, where the first of them is.
				const name = p.name.getText();
				if (accessorsDone.has(name)) return [];
				accessorsDone.add(name);
				const pair = e.properties.filter((q): q is ts.AccessorDeclaration => (ts.isGetAccessorDeclaration(q) || ts.isSetAccessorDeclaration(q)) && q.name.getText() === name);
				const g = pair.find(ts.isGetAccessorDeclaration),
					st = pair.find(ts.isSetAccessorDeclaration);
				const get = g ? `get = fun(__this: Any?): Any? ${this.withThis(g, '__this', true, () => this.functionBody(g, 'Any?', this.indent))}` : '';
				const v = st && (st.parameters[0].name as ts.Identifier);
				const set = st && v ? `set = fun(__this: Any?, ${ident(v.text)}: Any?) ${this.withThis(st, '__this', true, () => this.functionBody(st, 'Unit', this.indent))}` : '';
				return [`${o}.defineProperty(${key(p.name)}, JSPropertyDescriptor(${[get, set, 'enumerable = true', 'configurable = true'].filter(Boolean).join(', ')}))`];
			}
			throw this.error(p, 'this member in an untyped object literal');
		});
		return `run { val ${o} = JSObject(); ${steps.join('; ')}; ${o} }`;
	},

	/** An object literal typed as an iterator (`{ next() {…}, return() {…} }`): its members are what the kit steps. */
	scriptIterator(this: Translator, e: ts.ObjectLiteralExpression, type: string): string {
		const async = isKit(spelledType(type), 'JSAsyncIterator');
		const element = type.replace(/^JS\w+<(.*)>$/, '$1');
		const slot = async ? '(Any?) -> JSPromise<Any?>' : '(Any?) -> Any?';
		const member = (key: string) => {
			const p = e.properties.find((x) => x.name && (literalKey(x.name, this.checker) ?? x.name.getText()) === key);
			if (!p) return null;
			if (ts.isMethodDeclaration(p)) return this.closure(p, slot);
			if (ts.isPropertyAssignment(p) && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) return this.closure(p.initializer, slot);
			throw this.error(p, 'this member of an iterator object');
		};
		for (const p of e.properties) {
			const key = p.name && (literalKey(p.name, this.checker) ?? p.name.getText());
			if (!key || !['next', 'return', 'throw'].includes(key)) throw this.error(p, 'this member of an iterator object');
		}
		const args = ['next', 'return', 'throw'].flatMap((k) => {
			const m = member(k);
			return m ? [`${k === 'next' ? 'nextResult' : k === 'return' ? 'returnResult' : 'throwResult'} = ${m}`] : [];
		});
		return `${async ? 'JSScriptAsyncIterator' : 'JSScriptIterator'}<${element}>(${args.join(', ')})`;
	},

	/**
	 * A `signal<T>(null)` whose `T` must be typed `T?` to hold the null. An object type holds it unchecked
	 * (`jsUncheckedNull`), as a non-strict app's other object slots do, so its reads stay `T`.
	 */
	holdingNull(this: Translator, t: string, n: ts.Node): boolean {
		return /^Signal<(String|Double|Boolean)>$/.test(t) && this.madeHoldingNull(n);
	},

	/** Whether `n` is, names or declares a `signal(null)` or `signal(undefined)`: code checked without strictNullChecks, whose type leaves the null out. */
	madeHoldingNull(this: Translator, n: ts.Node): boolean {
		const declaration = (ts.isVariableDeclaration(n.parent) || ts.isPropertyDeclaration(n.parent)) && n.parent.name === n ? n.parent : ts.isIdentifier(n) || ts.isPropertyAccessExpression(n) ? this.resolve(ts.isPropertyAccessExpression(n) ? n.name : n)?.valueDeclaration : undefined;
		const made = ts.isCallExpression(n) ? n : declaration && (ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration)) ? declaration.initializer : undefined;
		if (!made || !ts.isCallExpression(made) || this.calleeName(made) !== 'signal' || !this.resolve(made.expression)?.declarations?.[0]?.getSourceFile().isDeclarationFile) return false;
		const value = made.arguments[0];
		return !!value && (value.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(value) && value.text === 'undefined'));
	},
};
