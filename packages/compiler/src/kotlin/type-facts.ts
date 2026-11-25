// Facts of Kotlin types: declared types and shapes, truth and undefined tests, and assignment before use.
import ts from 'typescript';
import { VALUE_TYPES, assignsTo, declOf, isFunctionType, isNullable, nullishType, optionalType, refersTo } from './syntax.ts';
import type { ShapeField, Translator } from './translator.ts';
import { accessedDeclaration, evolvingArrayType, wellKnownMember, methodValues } from '../semantics/lang.ts';
import { isLibDeclaration, isWriteTarget } from '../semantics/ast.ts';
import { isKit, isNamed, isUntyped, spelledType } from '../semantics/types.ts';
import { isStatic } from '../semantics/throws.ts';
import { shapePlanOfLiteral } from '../semantics/shapes.ts';
import { memberName, programSymbolKey } from '../program/stable-names.ts';

export const typeFactsMethods = {
	plainDeclaredTypeOf(this: Translator, e: ts.Expression): string | null {
		if (this.holdsFunctionObject(e) || this.states.heldNullish(e)) return 'Any?';
		// A shorthand property (`{ positions }`) names the variable it reads.
		let sym = ts.isIdentifier(e) && ts.isShorthandPropertyAssignment(e.parent) && e.parent.name === e ? this.checker.getShorthandAssignmentValueSymbol(e.parent) : this.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(e) ? e.name : e);
		// An imported variable is the module's.
		if (sym && sym.flags & ts.SymbolFlags.Alias) sym = this.checker.getAliasedSymbol(sym);
		// A member of a mapped type (`Partial<T>`): optional where `T` declares it required.
		if (sym && !sym.valueDeclaration && sym.flags & ts.SymbolFlags.Optional && sym.declarations?.length) {
			return optionalType(this.type(this.checker.getNonNullableType(this.checker.getTypeOfSymbol(sym)), sym.declarations[0]));
		}
		// A member's type is its getter's, for a write as well.
		const decl = accessedDeclaration(sym);
		if (!sym || !decl) return null;
		// A write into an erased generic member (`points: P[]`) gives it what it holds; reads convert at `property`.
		const erased = isWriteTarget(e) ? this.erasedMemberType(decl) : null;
		if (erased) return erased;
		if (methodValues(this, decl) && (this.thisValues().symbols.has(declOf(sym)) || sym.declarations?.some((d) => this.thisValues().symbols.has(d)))) return 'Any?';
		const maybe = this.undefinedVars.get(sym) ?? (this.states.arrayPiece(decl) || this.states.optionalObjectPiece(decl) || this.states.optionalVariable(decl) ? optionalType(this.typeOf((decl as ts.BindingElement | ts.VariableDeclaration).name)) : null);
		if (maybe) return maybe;
		if (ts.isIdentifier(e) && this.unsetGroups(e) && !isNamed(spelledType(this.typeOf(decl)), 'JSMatch', false)) return this.isLenientDecl(decl) ? this.lenientRef('JSArray<String?>') : 'JSArray<String?>';
		if (!(ts.isVariableDeclaration(decl) || ts.isParameter(decl) || ts.isPropertyDeclaration(decl) || ts.isPropertySignature(decl) || ts.isBindingElement(decl) || ts.isGetAccessorDeclaration(decl) || ts.isPropertyAssignment(decl) || ts.isShorthandPropertyAssignment(decl))) return null;
		if (ts.isParameter(decl) && this.typeTested(decl)) return 'Any?';
		if (this.library && this.untypedJavaFields().has(decl)) return 'Any?';
		const evolved = ts.isVariableDeclaration(decl) ? evolvingArrayType(decl, this.checker) : null;
		let t = this.type(evolved ?? this.checker.getTypeOfSymbolAtLocation(sym, decl), decl);
		if (this.isLenientDecl(decl) || ts.isGetAccessorDeclaration(decl)) t = this.lenientRef(t);
		// Library mode: a getter declared `string | undefined` is read as it returns, missing or not.
		if (this.library && ts.isGetAccessorDeclaration(decl) && this.nullablePrimitiveReturn(decl)) t = optionalType(t);
		// Library mode: a member core's declarations describe (`Frame.currentPage` of `index.d.ts`) is its compiled class's, lenient as all of core.
		else if (this.library && decl.getSourceFile().isDeclarationFile && (ts.isPropertyDeclaration(decl) || ts.isPropertySignature(decl) || ts.isGetAccessorDeclaration(decl)) && !isLibDeclaration(decl) && !this.native?.isNativeDeclaration(decl)) t = this.lenientRef(t);
		// Lenient code: an optional member's type does not say it may be missing.
		if (this.lenient && (ts.isPropertySignature(decl) || ts.isPropertyDeclaration(decl)) && decl.questionToken) t = optionalType(t);
		// A parameter with a default is nullable in its signature only; the body sees it filled in.
		if (ts.isParameter(decl) && decl.questionToken) t = optionalType(t);
		if ((this.nullableDecls.has(sym) || this.states.looseDeclaration(decl) || this.states.lenientNullField(decl) || (ts.isPropertyAccessExpression(e) && (['String', 'Double', 'Boolean'].includes(t) || this.states.unsetMember(decl)) && this.states.shapeFieldOptional(sym))) && !isUntyped(spelledType(t))) t = optionalType(t);
		if (this.holdingNull(t, e)) t = t.replace(/>$/, '?>');
		if (this.overUntypedField(decl)) return 'Any?';
		return this.heldSignal(e) ?? t;
	},

	/** Library mode: an argument to a parameter the program's method declares nullable in Kotlin (lenient, `bundle: Bundle?`), which takes it unwrapped or not. */
	nullableArgument(this: Translator, e: ts.Expression): boolean {
		if (!this.library || !ts.isCallExpression(e.parent) || !e.parent.arguments.includes(e)) return false;
		const callee = e.parent.expression;
		if (ts.isPropertyAccessExpression(callee) && this.namespaceMember(callee)) return false;
		const d = this.checker.getResolvedSignature(e.parent)?.getDeclaration();
		if (!d || ts.isJSDocSignature(d) || !(ts.isMethodDeclaration(d) || ts.isFunctionDeclaration(d)) || !d.body || d.getSourceFile().isDeclarationFile) return false;
		// Called as itself, not through a field or object holding it (`ad.showSoftInput`, of another signature).
		const named = this.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(callee) ? callee.name : callee);
		if (!named?.declarations?.includes(d)) return false;
		const root = ts.isMethodDeclaration(d) ? this.rootMethod(d) : d;
		const p = root.parameters[e.parent.arguments.indexOf(e)];
		return !!p && !p.dotDotDotToken && this.paramType(p).endsWith('?') && !isFunctionType(this.paramType(p).replace(/^\((.*)\)\?$/, '$1'));
	},

	/** Whether a read of `e` only tests or passes on its value, so a nullable declaration needs no unwrap there. */
	nullTolerant(this: Translator, e: ts.Expression): boolean {
		let n: ts.Node = e;
		while (ts.isParenthesizedExpression(n.parent)) n = n.parent;
		if (this.nullOk.has(n) || this.nullOk.has(e) || this.states.observedAsIs(e)) return true;
		const p = n.parent;
		const K = ts.SyntaxKind;
		// A branch of a conditional, or `a ?? b`'s `b`, where the whole goes where missing is taken; or a result a function gives as nullable.
		if (ts.isConditionalExpression(p) && (p.whenTrue === n || p.whenFalse === n)) return this.nullTolerant(p);
		if (ts.isBinaryExpression(p) && p.operatorToken.kind === K.QuestionQuestionToken && p.right === n) return this.nullTolerant(p);
		if (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === n)) {
			const fn = ts.isArrowFunction(p) ? p : ts.findAncestor(p, ts.isFunctionLike);
			if (fn && (ts.isMethodDeclaration(fn) || ts.isFunctionDeclaration(fn) || ts.isGetAccessorDeclaration(fn))) {
				const rt = this.returnTypeOf(fn);
				if (isNullable(rt) || isUntyped(spelledType(rt))) return true;
			}
		}
		// `for (k in x)` of nothing runs no iteration.
		if (ts.isForInStatement(p) && p.expression === n) return true;
		return ts.isBinaryExpression(p) && (p.operatorToken.kind === K.AmpersandAmpersandToken || p.operatorToken.kind === K.BarBarToken);
	},

	shape(this: Translator, t: ts.Type, where?: ts.Node): string {
		// Library mode: a constructor takes at most 255 JVM argument slots (a number takes two): a literal of many fields is a record.
		if (this.library && t.getProperties().length > 96 && (t.getSymbol()?.flags ?? 0) & ts.SymbolFlags.ObjectLiteral) return 'JSRecord<Any?>';
		const held = this.heldAs(t, where);
		if (held) return held;
		const conforming = this.conformingInterface(t);
		if (conforming) {
			this.used.add(conforming);
			return conforming;
		}
		// A plugin's (`bytes` narrowed by `Array.isArray` to a typed array that is also an array): read untyped.
		this.shaping.add(t);
		try {
			const ordered = where && ts.isObjectLiteralExpression(where) ? shapePlanOfLiteral(where, this.states).keys.map((k) => k.name) : [];
			const rank = (n: string) => (ordered.includes(n) ? ordered.indexOf(n) : ordered.length);
			const props = [...t.getProperties()].sort((a, b) => rank(a.name) - rank(b.name));
			const literal = t.getSymbol()?.declarations?.[0];
			const fields = props.map((p): ShapeField => {
				const ptype = this.checker.getTypeOfSymbolAtLocation(p, where ?? p.valueDeclaration!);
				let pt = this.type(ptype, where);
				if (p.valueDeclaration && (ts.isPropertySignature(p.valueDeclaration) || ts.isPropertyAssignment(p.valueDeclaration) || ts.isShorthandPropertyAssignment(p.valueDeclaration))) pt = this.heldElements(p.valueDeclaration, pt);
				// A class as a value (`{ MyComponent }`, a module's exports): its Java class, untyped.
				if (pt === 'Unit' || (!this.library && pt !== 'ComponentFactory' && ptype.getConstructSignatures().length && (ptype.getSymbol()?.flags ?? 0) & ts.SymbolFlags.Class)) pt = 'Any?';
				// A package's overloads of different arity (`getSelectors()`, `getSelectors(selectState)`): one Kotlin function type
				// would drop the others' arguments, so the field holds the function untyped.
				const calls = ptype.getCallSignatures();
				if (
					!this.library &&
					calls.length > 1 &&
					new Set(calls.map((c) => c.parameters.length)).size > 1 &&
					calls.every((c) => {
						const d = c.getDeclaration();
						return !!d && this.pluginFiles.has(d.getSourceFile().fileName);
					})
				)
					pt = 'Any?';
				const symbolic = wellKnownMember(p.name);
				if (symbolic) return { name: symbolic, type: pt, symbol: true };
				const keyed = programSymbolKey(p, this.checker);
				if (keyed) return { name: keyed.member, type: p.flags & ts.SymbolFlags.Optional ? optionalType(pt) : pt, symbol: true, key: this.symbolKey(this.expr(keyed.key)) };
				// Accessors of the literal itself; a spread copies an accessor's value into a plain property.
				const getter = p.declarations?.find((d) => ts.isGetAccessorDeclaration(d) && d.parent === literal);
				const setter = p.declarations?.find((d) => ts.isSetAccessorDeclaration(d) && d.parent === literal);
				if (getter || setter) return { name: memberName(p, this.checker), type: getter ? pt : optionalType(pt), accessor: { get: !!getter, set: !!setter, value: pt } };
				// Library mode: a Java object a literal holds may be missing (unchecked for null, `savedInstanceState` on a fresh start).
				const own = !this.library && !!p.valueDeclaration && !p.valueDeclaration.getSourceFile().isDeclarationFile && !this.states.packaged(p.valueDeclaration);
				return { name: memberName(p, this.checker), type: p.flags & ts.SymbolFlags.Optional || ((['String', 'Double', 'Boolean'].includes(pt) || this.states.unsetMember(p.valueDeclaration ?? p.declarations?.[0])) && this.states.shapeFieldOptional(p)) || (this.library && /^[a-z]\w*[._][\w.]*[A-Z]\w*$/.test(pt)) ? optionalType(pt) : pt, ...(own ? { own } : {}) };
			});
			const key = fields
				.map((f) => `${f.name}:${f.type}${f.accessor ? `:${f.accessor.get ? 'get' : ''}${f.accessor.set ? 'set' : ''}` : ''}`)
				.sort()
				.join(',');
			let base = 'Object_' + (fields.map((f) => f.name.replace(/\W/g, '')).join('_') || 'empty');
			// A class file's name has to fit the file system's limit.
			if (base.length > 80) base = `${base.slice(0, 64)}_${fields.length}`;
			return this.shapes.require(key, base, (name) => {
				if (fields.some((f) => f.symbol || f.key)) this.unviewable.add(name);
				return { name, fields };
			}).name;
		} finally {
			this.shaping.delete(t);
		}
	},

	isBool(this: Translator, n: ts.Node) {
		if (this.typeOf(n) !== 'Boolean') return false;
		// `a?.flag`: undefined where the chain stops.
		if (n.flags & ts.NodeFlags.OptionalChain && !ts.isNonNullExpression(n)) return false;
		const x = ts.isExpression(n) ? ts.skipOuterExpressions(n, ts.OuterExpressionKinds.Parentheses) : n;
		return !((ts.isIdentifier(x) || ts.isPropertyAccessExpression(x)) && this.declaredTypeOf(x) === 'Boolean?') && !this.optionalBooleanCall(x);
	},

	/** A call of a function declared `boolean` that gives `Boolean?` (its result read from an untyped value). */
	optionalBooleanCall(this: Translator, n: ts.Node): boolean {
		const x = ts.isExpression(n) ? ts.skipOuterExpressions(n, ts.OuterExpressionKinds.Parentheses) : n;
		if (!ts.isCallExpression(x)) return false;
		const d = this.checker.getResolvedSignature(x)?.getDeclaration();
		return !!d && !ts.isJSDocSignature(d) && !d.getSourceFile().isDeclarationFile && this.returnTypeOf(d) === 'Boolean?';
	},
	isObjectRef(this: Translator, n: ts.Node) {
		const t = this.typeOf(n).replace(/\?$/, '');
		return this.isObjectType(t);
	},
	isObjectType(this: Translator, t: string): boolean {
		t = t.replace(/\?$/, '');
		return !VALUE_TYPES.has(t) && !isFunctionType(t) && !t.startsWith('(') && !this.isTypeParameterName(t) && !this.native?.isValueType(t);
	},

	zero(this: Translator, t: string): string | null {
		if (isNullable(t) || isUntyped(spelledType(t))) return 'null';
		if (isKit(spelledType(t), 'JSNullish')) return 'JSNullish.Undefined';
		if (t === 'Double') return '0.0';
		if (t === 'String') return '""';
		if (t === 'Boolean') return 'false';
		if (/^JS(Array|Map|Set|Record)</.test(t)) return `${t}()`;
		return null;
	},

	/** Classes of uninitialized fields alone, which no code constructs, extends or tests: the declared type of plain objects. */
	plainObjectClasses(this: Translator): Set<ts.Node> {
		if (this.plainObjectClassSet) return this.plainObjectClassSet;
		const candidates = new Set<ts.Node>();
		const used = new Set<ts.Node>();
		for (const sf of this.sourceFiles) {
			if (sf.isDeclarationFile) continue;
			const visit = (n: ts.Node): void => {
				if (ts.isClassDeclaration(n) && n.name && !n.heritageClauses && n.members.length && n.members.every((m) => ts.isPropertyDeclaration(m) && !m.initializer && !isStatic(m)) && !ts.getDecorators(n)?.length) candidates.add(n);
				const target = ts.isNewExpression(n) ? n.expression : ts.isHeritageClause(n) ? n.types[0]?.expression : ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword ? n.right : undefined;
				const d = target ? this.resolve(target as ts.Identifier)?.valueDeclaration : undefined;
				if (d) used.add(d);
				ts.forEachChild(n, visit);
			};
			visit(sf);
		}
		for (const u of used) candidates.delete(u);
		return (this.plainObjectClassSet = candidates);
	},

	/** Whether code sets the variable to null or undefined itself. */
	assignedNull(this: Translator, d: ts.VariableDeclaration): boolean {
		const sym = this.checker.getSymbolAtLocation(d.name);
		const visit = (n: ts.Node): boolean => (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && this.checker.getSymbolAtLocation(n.left) === sym && (n.right.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(n.right) && n.right.text === 'undefined'))) || !!ts.forEachChild(n, visit);
		return !!sym && visit(d.parent.parent.parent);
	},

	/** Whether code compares the variable with undefined or null (`density === undefined`), or tests its `typeof`. */
	testedForUndefined(this: Translator, d: ts.VariableDeclaration): boolean {
		const sym = this.checker.getSymbolAtLocation(d.name);
		const nullish = (x: ts.Expression) => x.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(x) && x.text === 'undefined');
		const refers = (x: ts.Expression) => ts.isIdentifier(x) && this.checker.getSymbolAtLocation(x) === sym;
		const typeofOf = (x: ts.Expression, other: ts.Expression) => ts.isTypeOfExpression(x) && refers(x.expression) && ts.isStringLiteralLike(other);
		const visit = (n: ts.Node): boolean => (ts.isBinaryExpression(n) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(n.operatorToken.kind) && ((refers(n.left) && nullish(n.right)) || (refers(n.right) && nullish(n.left)) || typeofOf(n.left, n.right) || typeofOf(n.right, n.left))) || !!ts.forEachChild(n, visit);
		return !!sym && visit(d.getSourceFile());
	},

	/** Whether a binding is read as a condition or compared with null or undefined anywhere in its scope. */
	truthTested(this: Translator, name: ts.Identifier): boolean {
		const sym = this.checker.getSymbolAtLocation(name);
		if (!sym) return false;
		const refers = (x: ts.Node | undefined): boolean => {
			while (x && ts.isParenthesizedExpression(x)) x = x.expression;
			return !!x && ts.isIdentifier(x) && this.checker.getSymbolAtLocation(x) === sym;
		};
		const scope = ts.findAncestor(name, (n) => ts.isFunctionLike(n) || ts.isSourceFile(n)) ?? name.getSourceFile();
		return this.testedIn(scope, refers);
	},

	/** Whether a class's code tests a field of its own for being there (`if (!this.field)`, `this.field?.x`). */
	memberTruthTested(this: Translator, cls: ts.ClassLikeDeclaration, name: string): boolean {
		const refers = (x: ts.Node | undefined): boolean => {
			while (x && ts.isParenthesizedExpression(x)) x = x.expression;
			return !!x && ts.isPropertyAccessExpression(x) && x.expression.kind === ts.SyntaxKind.ThisKeyword && x.name.text === name;
		};
		let chained = false;
		const visit = (n: ts.Node): void => {
			if (chained) return;
			if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isCallExpression(n)) && n.questionDotToken && refers(n.expression)) chained = true;
			else ts.forEachChild(n, visit);
		};
		visit(cls);
		return chained || this.testedIn(cls, refers);
	},

	testedIn(this: Translator, scope: ts.Node, refers: (x: ts.Node | undefined) => boolean): boolean {
		const nullish = (x: ts.Expression) => x.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(x) && x.text === 'undefined');
		const logical = [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken];
		const equality = [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken];
		const visit = (n: ts.Node): boolean => (ts.isConditionalExpression(n) && refers(n.condition)) || ((ts.isIfStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n)) && refers(n.expression)) || (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken && refers(n.operand)) || (ts.isBinaryExpression(n) && logical.includes(n.operatorToken.kind) && refers(n.left)) || (ts.isBinaryExpression(n) && equality.includes(n.operatorToken.kind) && ((refers(n.left) && nullish(n.right)) || (refers(n.right) && nullish(n.left)))) || !!ts.forEachChild(n, visit);
		return visit(scope);
	},

	/**
	 * Whether a variable declared without a value is set on every path before anything reads it (a closure naming it
	 * counts as a read), as Kotlin requires of a variable declared without one, and whether only once (a `val`).
	 * Conservative: loops, switches and try statements naming it count as reads.
	 * `destructured`: a destructuring assignment's plain target (`[a, b] = …`) counts as set.
	 */
	assignedBeforeUse(this: Translator, d: ts.VariableDeclaration, destructured = false): 'once' | 'more' | null {
		const sym = ts.isIdentifier(d.name) ? this.checker.getSymbolAtLocation(d.name) : undefined;
		const statement = d.parent.parent;
		if (!sym || !ts.isVariableStatement(statement) || !ts.isBlock(statement.parent)) return null;
		const names = (n: ts.Node) => refersTo(n, sym, this.checker);
		const own = statement.declarationList.declarations;
		if (own.slice(own.indexOf(d) + 1).some(names)) return null;
		// Whether each path sets it before reading it, and sets it only once then.
		type Flow = { kind: 'assigned' | 'read' | 'none'; once?: boolean };
		const flow = (s: ts.Statement): Flow => {
			if (ts.isExpressionStatement(s)) {
				let e = s.expression;
				while (ts.isParenthesizedExpression(e)) e = e.expression;
				if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(e.left) && this.checker.getSymbolAtLocation(e.left) === sym) return { kind: names(e.right) ? 'read' : 'assigned', once: true };
				if (destructured && ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken && !names(e.right)) {
					const targets = ts.isArrayLiteralExpression(e.left) ? e.left.elements : ts.isObjectLiteralExpression(e.left) ? e.left.properties.map((p) => (ts.isShorthandPropertyAssignment(p) && !p.objectAssignmentInitializer ? p.name : ts.isPropertyAssignment(p) ? p.initializer : p)) : [];
					if (targets.some((x) => ts.isIdentifier(x) && this.checker.getSymbolAtLocation(x) === sym)) return { kind: 'assigned', once: false };
				}
				return { kind: names(s) ? 'read' : 'none' };
			}
			if (ts.isBlock(s)) return sequence(s.statements);
			if (ts.isIfStatement(s)) {
				if (names(s.expression)) return { kind: 'read' };
				const branch = (b: ts.Statement | undefined): Flow => (!b ? { kind: 'none' } : this.exits(b) && !names(b) ? { kind: 'assigned', once: true } : flow(b));
				const a = branch(s.thenStatement),
					b = branch(s.elseStatement);
				if (a.kind === 'read' || b.kind === 'read') return { kind: 'read' };
				return a.kind === 'assigned' && b.kind === 'assigned' ? { kind: 'assigned', once: a.once && b.once } : { kind: 'none' };
			}
			if (ts.isDoStatement(s)) {
				const body = flow(s.statement);
				return body.kind === 'assigned' ? { kind: 'assigned', once: false } : { kind: body.kind === 'read' || names(s.expression) ? 'read' : 'none' };
			}
			// A loop setting it before reading it in each pass: read nowhere else, it is set where it is read.
			if (ts.isWhileStatement(s) || ts.isForStatement(s) || ts.isForOfStatement(s) || ts.isForInStatement(s)) {
				const head = ts.isWhileStatement(s) ? [s.expression] : ts.isForStatement(s) ? [s.initializer, s.condition, s.incrementor] : [s.initializer, s.expression];
				if (head.some((x) => x && names(x))) return { kind: 'read' };
				return { kind: flow(s.statement).kind === 'read' ? 'read' : 'none' };
			}
			if (ts.isTryStatement(s)) {
				if (s.finallyBlock && names(s.finallyBlock)) return { kind: 'read' };
				const body = flow(s.tryBlock),
					caught = s.catchClause ? (this.exits(s.catchClause.block) && !names(s.catchClause.block) ? { kind: 'assigned' as const } : flow(s.catchClause.block)) : { kind: 'none' as const };
				if (body.kind === 'read' || caught.kind === 'read') return { kind: 'read' };
				return { kind: body.kind === 'assigned' && (!s.catchClause || caught.kind === 'assigned') ? 'assigned' : 'none', once: false };
			}
			return { kind: names(s) ? 'read' : 'none' };
		};
		const sequence = (list: readonly ts.Statement[]): Flow => {
			for (let k = 0; k < list.length; k++) {
				const f = flow(list[k]);
				if (f.kind === 'assigned') return { kind: 'assigned', once: f.once && !list.some((x, j) => j !== k && assignsTo(x, sym, this.checker)) };
				if (f.kind === 'read') return f;
				if (this.exits(list[k])) return { kind: 'assigned', once: !list.slice(0, k + 1).some((x) => assignsTo(x, sym, this.checker)) };
			}
			return { kind: 'none' };
		};
		const rest = statement.parent.statements;
		const f = sequence(rest.slice(rest.indexOf(statement) + 1));
		return f.kind === 'read' ? null : f.kind === 'assigned' && f.once ? 'once' : 'more';
	},
	/** A one-letter Kotlin type that is not one of the program's classes, interfaces or enums. */
	isTypeParameterName(this: Translator, t: string): boolean {
		if (!/^[A-Z]$/.test(t)) return false;
		if (!this.letterTypes) {
			this.letterTypes = new Set();
			const visit = (n: ts.Node): void => {
				if ((ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isEnumDeclaration(n)) && n.name && n.name.text.length === 1) this.letterTypes!.add(this.topName(n, n.name.text));
				ts.forEachChild(n, visit);
			};
			for (const sf of this.sourceFiles) if (!sf.isDeclarationFile) visit(sf);
		}
		return !this.letterTypes.has(t);
	},

	/** A field held as `JSNullish<T>` (`ValueStates.nullishHeld`): its type and first value; null for any other field. */
	nullishStorage(this: Translator, m: ts.PropertyDeclaration): { type: string; init: string } | null {
		if (!this.states.nullishHeld(m)) return null;
		const type = nullishType(this.typeOf(m.name));
		return { type, init: m.initializer ? this.stored(m.initializer, m, type) : 'JSNullish.Undefined' };
	},
	/** `var name: type` holding a value assigned later. */
	deferredDeclaration(this: Translator, name: string, t: string): string {
		const z = this.zero(t);
		if (z) return `var ${name}: ${t} = ${z}`;
		if (t === 'Unit') return `var ${name}: Unit = Unit`;
		if (this.isTypeParameterName(t) || t === 'Nothing') return `var ${name}: ${optionalType(t)} = null`;
		return `lateinit var ${name}: ${t}`;
	},
};
