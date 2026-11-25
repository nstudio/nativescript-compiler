// The observers: where the program tells null from undefined, which decides whether a slot keeps them apart.
import ts from 'typescript';
import { CONVERTING, F, LOGICAL_ASSIGNMENT, M, N, O, STORES, STORE_OWNERS, U, declarationFile, definitelyAssigned, elementType, hasStatic, isGeneric, isRecord, isTemplateDefault, shapes, typeNodeStates, untyped, valueParameters, type Part, type Slot } from './flow.ts';
import type { Forms } from './forms.ts';
import { LIB_FILE, isTemplateMethod, slotOf } from '../trust.ts';
import { alwaysEnds, literalKey } from '../lang.ts';
import { fieldReadEarly, parameterPropertiesReadEarly } from '../class-plan.ts';
import { isWriteTarget } from '../ast.ts';
import { patternSource } from '../placement.ts';

export const observersMethods = {
	/** A value something tells null from undefined in. */
	observe(this: Forms, e: ts.Expression): void {
		const x = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
		this.observedValues.add(x);
		this.flow(x);
	},

	/** A value whose type something tests. */
	observeType(this: Forms, e: ts.Expression): void {
		const x = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
		this.typeObservedValues.add(x);
		this.flow(x);
	},

	/** A value script holds untyped, which reads it as it likes and may write into what it holds. */
	observeUntyped(this: Forms, e: ts.Expression): void {
		this.observe(e);
		const x = ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses);
		this.placedUntyped.add(x);
		this.heldUntyped.add(x);
	},

	/**
	 * A read of a member the receiver's declared type doesn't have (`(v as any).extra`, a lenient `v['extra']`), which tests
	 * what the value really is.
	 */
	observeUndeclaredMember(this: Forms, n: ts.PropertyAccessExpression | ts.ElementAccessExpression): void {
		if (ts.isPropertyAccessExpression(n) && ts.isPrivateIdentifier(n.name)) return;
		const untyped = ts.TypeFlags.Any | ts.TypeFlags.Unknown;
		let x = ts.skipOuterExpressions(n.expression, ts.OuterExpressionKinds.Parentheses);
		if ((ts.isAsExpression(x) || ts.isTypeAssertionExpression(x)) && this.checker.getTypeAtLocation(x).flags & untyped) x = ts.skipOuterExpressions(x.expression, ts.OuterExpressionKinds.Parentheses);
		const t = this.checker.getNonNullableType(this.checker.getTypeAtLocation(x));
		if (t.flags & (untyped | ts.TypeFlags.TypeParameter) || isGeneric(t)) return;
		const apparent = this.checker.getApparentType(t);
		const key = ts.isPropertyAccessExpression(n) ? n.name.text : ts.isStringLiteralLike(n.argumentExpression) || ts.isNumericLiteral(n.argumentExpression) ? n.argumentExpression.text : null;
		const indexed = (k: ts.Type) => this.checker.getIndexInfosOfType(apparent).some((i) => this.checker.isTypeAssignableTo(k, i.keyType));
		if (key === null) {
			const k = this.checker.getTypeAtLocation((n as ts.ElementAccessExpression).argumentExpression);
			if (!(k.flags & ts.TypeFlags.StringLike) || indexed(k)) return;
			// A key of literal types (`scope[SLOT]` of a `const SLOT = '__slot__'`) names the members it may be.
			const names = k.isUnion() ? k.types : [k];
			if (names.every((l) => l.isStringLiteral() && this.checker.getPropertyOfType(apparent, l.value))) return;
		} else if (this.checker.getPropertyOfType(apparent, key) || indexed(/^\d+$/.test(key) ? this.checker.getNumberType() : this.checker.getStringType())) return;
		this.observeType(x);
	},

	/** Whether an expression may give null or undefined: whether comparing with it tells them apart. */
	mayBeEmpty(this: Forms, e: ts.Expression): boolean {
		const f = this.flow(e);
		return !!(f.states & (U | N)) || f.from.length > 0;
	},

	/** The readers at `n` that tell null from undefined. */
	placeObservers(this: Forms, n: ts.Node): void {
		const K = ts.SyntaxKind;
		if (ts.isBinaryExpression(n)) {
			const op = n.operatorToken.kind;
			if (op === K.EqualsEqualsEqualsToken || op === K.ExclamationEqualsEqualsToken) {
				if (this.mayBeEmpty(n.right)) this.observe(n.left);
				if (this.mayBeEmpty(n.left)) this.observe(n.right);
			} else if (CONVERTING.has(op)) {
				this.observe(n.left);
				this.observe(n.right);
			} else if (op === K.InKeyword) {
				this.observe(n.left);
				this.observeType(n.right);
			} else if (op === K.InstanceOfKeyword) this.observeType(n.left);
		} else if (ts.isCallExpression(n) && n.arguments.length && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'isArray' && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === 'Array') this.observeType(n.arguments[0]);
		else if (ts.isPrefixUnaryExpression(n)) {
			if (n.operator !== K.ExclamationToken) this.observe(n.operand);
		} else if (ts.isPostfixUnaryExpression(n)) this.observe(n.operand);
		else if (ts.isTypeOfExpression(n)) {
			this.observe(n.expression);
			this.observeType(n.expression);
		} else if (ts.isTemplateSpan(n) || ts.isComputedPropertyName(n)) this.observe(n.expression);
		else if (ts.isElementAccessExpression(n)) {
			this.observe(n.argumentExpression);
			this.observeUndeclaredMember(n);
		} else if (ts.isPropertyAccessExpression(n)) this.observeUndeclaredMember(n);
		else if (ts.isSwitchStatement(n)) {
			for (const clause of n.caseBlock.clauses) {
				if (!ts.isCaseClause(clause)) continue;
				if (this.mayBeEmpty(clause.expression)) this.observe(n.expression);
				if (this.mayBeEmpty(n.expression)) this.observe(clause.expression);
			}
		} else if (ts.isParameter(n) && n.initializer && !isTemplateDefault(n)) this.observedSlots.push(this.slotFor(n));
	},

	/**
	 * Whether a declaration file's reader may tell null from undefined in what it is given, or in a function's result it
	 * reads. A platform binding gets one nil for both unless it takes any value; a built-in typed for objects only takes
	 * both as no object; the stores the flow follows (`push`, `set`, …) hold the value where its readers are seen. The
	 * library's own declarations are implemented elsewhere in it, and read by its callers: unseen.
	 */
	unseenReader(this: Forms, d: ts.Declaration): boolean {
		if (this.ownDeclaration(d)) return true;
		let node = (d as { type?: ts.TypeNode }).type;
		let type = this.declaredType(d);
		if (ts.isParameter(d) && d.dotDotDotToken) {
			node = node && ts.isArrayTypeNode(node) ? node.elementType : undefined;
			type = type && elementType(this.checker, type, 'element');
		}
		if (!node || typeNodeStates(node) & F) return true;
		if (this.native(d)) return false;
		if (ts.isParameter(d) && LIB_FILE.test(d.getSourceFile().fileName) && ts.isInterfaceDeclaration(d.parent.parent) && STORE_OWNERS.has(d.parent.parent.name.text)) {
			const name = (d.parent as ts.SignatureDeclaration).name,
				from = name && ts.isIdentifier(name) ? STORES.get(name.text) : undefined;
			if (from !== undefined && d.parent.parameters.indexOf(d) >= from) return false;
		}
		if (typeNodeStates(node) & N || !type) return true;
		const t = this.checker.getNonNullableType(type);
		return (t.isUnion() ? t.types : [t]).some((x) => !(x.flags & ts.TypeFlags.Object));
	},

	/** Arguments given to a declaration file's function, or to a callee of no known declaration. */
	observeArguments(this: Forms, call: ts.CallExpression | ts.NewExpression, sig: ts.SignatureDeclaration | undefined, args: ts.NodeArray<ts.Expression>): void {
		if (!sig) {
			for (const a of args) this.observeUntyped(ts.isSpreadElement(a) ? a.expression : a);
			return;
		}
		const callee = ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.expression) && LIB_FILE.test(sig.getSourceFile().fileName) ? call.expression.expression.text : '';
		const params = valueParameters(sig);
		args.forEach((a, k) => {
			const q = params[Math.min(k, params.length - 1)];
			if (!q || (k >= params.length && !q.dotDotDotToken)) return;
			const value = ts.isSpreadElement(a) ? a.expression : a;
			if (callee === 'JSON' || callee === 'console') this.printed.push([value, callee === 'JSON']);
			if (this.unseenReader(q)) this.observe(value);
		});
	},

	/** What printing a value reads: its fields and elements, a class instance's only for JSON (console prints its name). */
	observePrinted(this: Forms, e: ts.Expression, classes: boolean, slots: Set<Slot>, types: Set<ts.Type>): void {
		const c = this.checker;
		const slot = (s: Slot, depth: number) => {
			const r = this.find(s);
			if (slots.has(r) || depth > 4) return;
			slots.add(r);
			r.observed = true;
			for (const x of r.children.values()) slot(x, depth + 1);
			if (r.type) type(r.type, depth);
		};
		const type = (t: ts.Type, depth: number) => {
			const x = c.getNonNullableType(t);
			for (const m of x.isUnion() ? x.types : [x]) {
				if (types.has(m) || !(m.flags & ts.TypeFlags.Object) || m.getCallSignatures().length || (!classes && m.isClass())) continue;
				types.add(m);
				if (c.isArrayType(m) || c.isTupleType(m)) {
					const el = elementType(c, m, 'element');
					if (el) type(el, depth + 1);
					continue;
				}
				for (const p of c.getPropertiesOfType(m)) {
					const d = p.valueDeclaration;
					if (d && (ts.isPropertyDeclaration(d) || ts.isPropertySignature(d) || ts.isPropertyAssignment(d) || ts.isShorthandPropertyAssignment(d)) && !declarationFile(d)) slot(this.slotFor(d), depth + 1);
				}
			}
		};
		for (const [s, keep] of this.flow(e).from) if (keep & N) slot(s, 0);
		type(c.getTypeAtLocation(e), 0);
	},

	/**
	 * Observation runs backwards along placements: a value whose null may reach an observed slot is observed. One pass
	 * over the edges, reversed, from the observed roots.
	 */
	propagateObserved(this: Forms): void {
		for (const s of this.observedSlots) this.find(s).observed = true;
		// A Set keeps a null member apart from an undefined one.
		for (const s of this.made) {
			const name = s.type && this.checker.getNonNullableType(s.type).getSymbol()?.name;
			const c = (name === 'Set' || name === 'ReadonlySet') && this.find(s).children.get('element');
			if (c) this.find(c).observed = true;
		}
		for (const e of this.observedValues) for (const [s, keep] of this.flow(e).from) if (keep & N) this.find(s).observed = true;
		const slots = new Set<Slot>(),
			types = new Set<ts.Type>();
		for (const [e, classes] of this.printed) this.observePrinted(e, classes, slots, types);
		const into = new Map<Slot, Slot[]>();
		for (const [from, to, keep] of this.edges) {
			if (!(keep & N)) continue;
			const x = this.find(from),
				y = this.find(to);
			if (x === y) continue;
			const list = into.get(y);
			if (list) list.push(x);
			else into.set(y, [x]);
		}
		for (const [from, to] of this.copies) {
			const x = this.find(from),
				y = this.find(to);
			if (x === y) continue;
			const list = into.get(x);
			if (list) list.push(y);
			else into.set(x, [y]);
		}
		for (let work = [...new Set(this.made.map((s) => this.find(s)).filter((r) => r.observed))]; work.length;) {
			const y = work.pop()!;
			for (const x of into.get(y) ?? [])
				if (!x.observed) {
					x.observed = true;
					work.push(x);
				}
		}
	},

	/** Type observation runs backwards along the placements foreign values take, as null observation does along null's. */
	propagateTypeObserved(this: Forms): void {
		for (const e of this.typeObservedValues) for (const [s, keep] of this.flow(e).from) if (keep & F) this.find(s).typeObserved = true;
		const into = new Map<Slot, Slot[]>();
		for (const [from, to, keep] of this.edges) {
			if (!(keep & F)) continue;
			const x = this.find(from),
				y = this.find(to);
			if (x === y) continue;
			const list = into.get(y);
			if (list) list.push(x);
			else into.set(y, [x]);
		}
		for (let work = [...new Set(this.made.map((s) => this.find(s)).filter((r) => r.typeObserved))]; work.length;) {
			const y = work.pop()!;
			for (const x of into.get(y) ?? [])
				if (!x.typeObserved) {
					x.typeObserved = true;
					work.push(x);
				}
		}
	},

	visit(this: Forms, n: ts.Node): void {
		const c = this.checker;
		if (ts.isExpression(n) && !ts.isParenthesizedExpression(n)) this.placeExpression(n);
		this.placeObservers(n);
		if ((ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) && isWriteTarget(n)) {
			const d = this.declarationOf(ts.isIdentifier(n) ? n : n.name);
			if (d) this.written.add(d);
		}
		if (ts.isParameter(n) && n.questionToken && !n.initializer) this.seed(this.slotFor(n), U | M);
		if (ts.isVariableDeclaration(n) && !n.initializer && ts.isIdentifier(n.name) && ts.isVariableDeclarationList(n.parent)) {
			const loop = n.parent.parent;
			if (ts.isForOfStatement(loop) && loop.initializer === n.parent) this.placeElements(loop.expression, this.slotFor(n), loop.awaitModifier ? 'result' : null);
			else if (!ts.isForInStatement(loop) && !(ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Ambient)) {
				this.seed(this.slotFor(n), U);
				this.unwritten.push(n);
			}
		}
		if (ts.isVariableDeclaration(n) && n.parent && ts.isCatchClause(n.parent)) this.seed(this.slotFor(n), F | U | N);
		if (ts.isBindingElement(n) && ts.isIdentifier(n.name)) this.placeBinding(n);
		if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && (ts.isArrayLiteralExpression(n.left) || ts.isObjectLiteralExpression(n.left))) this.placeAssignedParts(n.left, n.right, false);
		if (ts.isForOfStatement(n) && !ts.isVariableDeclarationList(n.initializer)) this.placeAssignedParts(n.initializer, n.expression, true);
		if (ts.isPropertyDeclaration(n) && !n.initializer && ts.isClassLike(n.parent) && !(ts.getCombinedModifierFlags(n) & (ts.ModifierFlags.Ambient | ts.ModifierFlags.Abstract))) {
			if (n.questionToken || hasStatic(n) || !definitelyAssigned(n.parent).has(n)) {
				this.seed(this.slotFor(n), U | (n.questionToken ? O : 0) | (!hasStatic(n) && fieldReadEarly(n, n.parent, c) ? this.absent(n) : 0));
				this.unwritten.push(n);
			}
		}
		if (ts.isConstructorDeclaration(n) && n.body && ts.isClassLike(n.parent)) for (const p of parameterPropertiesReadEarly(n.parent, this.assignFields, c)) this.seed(this.slotFor(p), U | this.absent(p));
		if (ts.isPropertySignature(n) && n.questionToken) this.seed(this.slotFor(n), U | O);
		if (ts.isReturnStatement(n) && !n.expression) {
			const fn = ts.findAncestor(n.parent, ts.isFunctionLike);
			const r = fn && this.resultOf(fn as ts.SignatureDeclaration);
			if (r) this.seed(r, U | this.absent(n));
		}
		if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isGetAccessorDeclaration(n)) && n.body && ts.isBlock(n.body) && !alwaysEnds(n.body)) {
			const r = this.resultOf(n);
			if (r) this.seed(r, U | this.absent(n));
		}
		if (ts.isClassLike(n)) this.unionClass(n);
		if (isTemplateMethod(n)) this.placeTemplateMethod(n as ts.MethodDeclaration);
		if (ts.isMethodDeclaration(n) && ts.isObjectLiteralExpression(n.parent) && n.body) {
			const ctx = c.getContextualType(n.parent),
				key = literalKey(n.name, c);
			const prop = ctx && !untyped(ctx) && key !== null ? c.getNonNullableType(ctx).getProperty(key) : undefined;
			this.placeFunction(n, ctx && untyped(ctx) ? ctx : prop && c.getTypeOfSymbolAtLocation(prop, n));
		}
		if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) {
			const decls = this.checker.getSymbolAtLocation(n.name)?.declarations?.filter((d): d is ts.SignatureDeclaration => ts.isFunctionLike(d)) ?? [];
			if (decls.length > 1 && decls[0] !== n) this.unionSignature(n, decls[0]);
		}
		if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) this.unionFunctionValue(n as ts.Expression);
		if (ts.isCallExpression(n) || ts.isNewExpression(n)) this.placeCall(n);
		if (ts.isCallExpression(n)) this.placeCallByName(n);
		if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isElementAccessExpression(n.left)) {
			const recv = n.left.expression;
			const part: Part = c.isArrayType(c.getNonNullableType(c.getTypeAtLocation(recv))) ? 'element' : 'value';
			for (const [s] of this.flow(recv).from) this.place(n.right, this.child(s, part));
		}
		// `record.key = v`: a record's value by a key the program spells.
		if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left) && isRecord(c.getNonNullableType(c.getTypeAtLocation(n.left.expression)))) {
			for (const [s] of this.flow(n.left.expression).from) this.place(n.right, this.child(s, 'value'));
		}
		if (ts.isConditionalExpression(n)) this.shareBranchLiterals(n, c.getTypeAtLocation(n));
		if (ts.isArrowFunction(n) && ts.isExpression(n.body)) {
			const sig = c.getSignatureFromDeclaration(n);
			if (sig) this.shareBranchLiterals(n.body, sig.getReturnType());
		}
		if (ts.isReturnStatement(n) && n.expression) {
			const fn = ts.findAncestor(n.parent, ts.isFunctionLike);
			const sig = fn && !ts.isConstructorDeclaration(fn) && !ts.isSetAccessorDeclaration(fn) ? c.getSignatureFromDeclaration(fn as ts.SignatureDeclaration) : undefined;
			if (sig) this.shareBranchLiterals(n.expression, sig.getReturnType());
		}
		if ((ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) && (this.flow(n.expression).states & F || untyped(c.getTypeAtLocation(n.expression))) && shapes(c, c.getTypeAtLocation(n)).length) {
			this.seed(this.slotFor(n), F);
		}
		ts.forEachChild(n, (x) => this.visit(x));
	},

	/** Shares matching properties across object-literal branches of a conditional or return, and with the resulting anonymous shape. */
	shareBranchLiterals(this: Forms, e: ts.Expression, t: ts.Type): void {
		const literals: ts.ObjectLiteralExpression[] = [];
		const collect = (expr: ts.Expression): void => {
			const x = ts.skipOuterExpressions(expr);
			if (ts.isConditionalExpression(x)) {
				collect(x.whenTrue);
				collect(x.whenFalse);
			} else if (ts.isObjectLiteralExpression(x)) literals.push(x);
		};
		collect(e);
		if (!literals.length) return;
		const firstByKey = new Map<string, ts.PropertyAssignment | ts.ShorthandPropertyAssignment>();
		for (const lit of literals) {
			for (const p of lit.properties) {
				if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) continue;
				const key = literalKey(p.name, this.checker);
				if (key === null) continue;
				const first = firstByKey.get(key);
				if (first) this.share(this.slotFor(p), this.slotFor(first));
				else firstByKey.set(key, p);
			}
		}
		const whole = this.checker.getNonNullableType(t);
		for (const target of whole.isUnion() ? whole.types : [whole]) {
			if (target.isClassOrInterface()) continue;
			for (const [key, first] of firstByKey) {
				const prop = target.getProperty(key);
				for (const d of prop?.declarations ?? (prop?.valueDeclaration ? [prop.valueDeclaration] : [])) {
					if (d && d !== first && !declarationFile(d)) this.share(this.slotFor(first), this.slotFor(d));
				}
			}
		}
	},

	/** A value placed where a slot takes it: `slotOf`'s slots, returns, literal fields and elements. */
	placeExpression(this: Forms, e: ts.Expression): void {
		let x: ts.Node = e;
		while (ts.isParenthesizedExpression(x.parent)) x = x.parent;
		const p = x.parent;
		if (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === x)) {
			const fn = ts.isArrowFunction(p) ? p : ts.findAncestor(p, ts.isFunctionLike);
			const r = fn && !ts.isConstructorDeclaration(fn) && !ts.isSetAccessorDeclaration(fn) ? this.resultOf(fn as ts.SignatureDeclaration) : null;
			if (r) this.place(e, r);
			if (r && (e.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(e) || (ts.isIdentifier(e) && e.text === 'undefined'))) this.seed(r, this.absent(e));
			return;
		}
		if (ts.isArrayLiteralExpression(p)) {
			if (patternSource(e)) return;
			this.place(e, this.child(this.slotFor(p), 'element'));
			if (this.untypedContext(p)) this.observeUntyped(e);
			return;
		}
		if (ts.isSpreadElement(p) && ts.isArrayLiteralExpression(p.parent)) {
			if (patternSource(e)) return;
			this.placeElements(e, this.child(this.slotFor(p.parent), 'element'), null, true);
			return;
		}
		if (ts.isOmittedExpression(e) && ts.isArrayLiteralExpression(p)) return;
		if ((ts.isPropertyAssignment(p) && p.initializer === x) || (ts.isShorthandPropertyAssignment(p) && p.name === x)) {
			if (patternSource(e)) return;
			const own = this.slotFor(p);
			this.place(e, own);
			if (this.untypedContext(p.parent)) this.observeUntyped(e);
			const key = literalKey(p.name, this.checker);
			const declared = key !== null ? this.checker.getContextualType(p.parent)?.getProperty(key) : undefined;
			const d = declared?.valueDeclaration ?? declared?.declarations?.[0];
			const destructuringTarget = (n: ts.Declaration): boolean => (ts.isPropertyAssignment(n) && !!patternSource(n.initializer)) || (ts.isShorthandPropertyAssignment(n) && !!patternSource(n.name));
			if (d && d !== p && !destructuringTarget(d)) this.share(own, this.slotFor(d));
			if (d && declarationFile(d) && this.unseenReader(d)) this.observe(e);
			return;
		}
		if (ts.isBinaryExpression(p) && p.right === x && LOGICAL_ASSIGNMENT.has(p.operatorToken.kind)) {
			const d = this.declarationOf(ts.isPropertyAccessExpression(p.left) ? p.left.name : p.left);
			if (d) this.place(e, this.slotFor(d));
			return;
		}
		if (ts.isBinaryExpression(p) && p.right === x && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && (ts.isPropertyAccessExpression(p.left) || ts.isElementAccessExpression(p.left)) && untyped(this.checker.getTypeAtLocation(p.left.expression))) this.observeUntyped(e);
		const d = slotOf(e, this.checker);
		if (!d || ts.isFunctionLike(d)) return;
		if ((ts.isParameter(d) || ts.isVariableDeclaration(d) || ts.isPropertyDeclaration(d)) && d.initializer === x) {
			if (ts.isIdentifier(d.name) && !isTemplateDefault(d)) this.place(e, this.slotFor(d));
			return;
		}
		this.place(e, this.slotFor(d));
	},

	/**
	 * A template's own method (`$b…`, `$e…`): the template's glue, which this compiler writes, is its only caller. A
	 * loop's item is an element of the list its default reads (`item = this.$b2()[0]`); an untyped `$event` is an
	 * output's payload, anything; the rest (indexes, a view event's data, pipes, references) are always given. A
	 * property binding passes null and undefined on apart.
	 */
	placeTemplateMethod(this: Forms, m: ts.MethodDeclaration): void {
		if (m.name.getText().startsWith('$b')) this.observedSlots.push(this.slotFor(m));
		for (const p of m.parameters) {
			const init = p.initializer && ts.skipOuterExpressions(p.initializer);
			if (init && ts.isElementAccessExpression(init)) this.placeElements(init.expression, this.slotFor(p), null);
			else if (!init && (!p.type || typeNodeStates(p.type) & F)) this.seed(this.slotFor(p), U | N | F);
		}
	},
};

export type ObserversMethods = typeof observersMethods;
