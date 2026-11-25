// Statements as Swift: declarations, bindings, loops, switch, try, assignments and returns.
import ts from 'typescript';
import { atLossSite, HELD_LOSS } from '../semantics/losses.ts';
import { assignsTo, balanced, heldType, ident, isOptional, swiftString, withoutAvailableBlocks, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { place, resultSlot, returnCell, storeSlot, type ResultSlot, type ReturnCell, type Store, type StoreSlot } from '../semantics/placement.ts';
import { deadZoneBinding, leadingNeverRead } from '../semantics/lang.ts';
import { isAsync, isStatic } from '../semantics/throws.ts';
import { readEarly } from '../semantics/classes.ts';
import { isUntyped, spelledType } from '../semantics/types.ts';

export const statementsMethods = {
	/**
	 * Swift initializes a subclass's fields before its base's initializer runs; JavaScript after the base constructor
	 * returns. A base field initializer or constructor calling a method the subclass overrides to read its own fields
	 * sees their initial values in Swift where JavaScript sees undefined: a warning names each such override, but for a
	 * field held unset until then (`readEarly`).
	 */
	warnConstructionOrder(this: Translator, cls: ts.ClassLikeDeclaration, appBase: ts.ClassLikeDeclaration): void {
		const own = new Set<string>();
		for (const m of cls.members) if (ts.isPropertyDeclaration(m) && !isStatic(m) && m.name && !ts.isComputedPropertyName(m.name) && !readEarly(m, this)) own.add(m.name.getText());
		for (const m of cls.members) if (ts.isConstructorDeclaration(m)) for (const p of m.parameters) if (ts.isParameterPropertyDeclaration(p, m) && ts.isIdentifier(p.name)) own.add(p.name.text);
		if (!own.size) return;
		const overrides = new Map<string, ts.MethodDeclaration>();
		for (const m of cls.members) if (ts.isMethodDeclaration(m) && m.body && !isStatic(m) && !ts.isComputedPropertyName(m.name)) overrides.set(m.name.getText(), m);
		// `this.<name>` in `n`, not inside a nested function, which construction need not call.
		const thisReads = (n: ts.Node, out: ts.PropertyAccessExpression[] = []): ts.PropertyAccessExpression[] => {
			if (ts.isPropertyAccessExpression(n) && n.expression.kind === ts.SyntaxKind.ThisKeyword) out.push(n);
			if (!ts.isFunctionLike(n) || ts.isConstructorDeclaration(n))
				ts.forEachChild(n, (c) => {
					if (!ts.isFunctionLike(c) || ts.isConstructorDeclaration(c)) thisReads(c, out);
				});
			return out;
		};
		for (let b: ts.ClassLikeDeclaration | undefined = appBase; b;) {
			const construction = b.members.filter((m) => (ts.isPropertyDeclaration(m) && !isStatic(m) && m.initializer) || (ts.isConstructorDeclaration(m) && m.body));
			for (const site of construction.flatMap((m) => thisReads(m))) {
				const called = ts.isCallExpression(site.parent) && site.parent.expression === site ? overrides.get(site.name.text) : undefined;
				const read = called && thisReads(called.body!).find((r) => own.has(r.name.text));
				if (!read || this.constructionWarned.has(called!)) continue;
				this.constructionWarned.add(called!);
				const at = (n: ts.Node) => {
					const sf = n.getSourceFile();
					return `${sf.fileName}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
				};
				console.warn(`warning: ${at(called!)}: ${cls.name?.text ?? 'a class'}.${site.name.text}() reads this.${read.name.text} while ${b.name?.text ?? 'its base'} is constructed (${at(site)}): JavaScript reads undefined there, the release build its initial value`);
			}
			const h: ts.ExpressionWithTypeArguments | undefined = b.heritageClauses?.find((x) => x.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
			const d: ts.Declaration | undefined = h && this.checker.getTypeAtLocation(h.expression).getSymbol()?.valueDeclaration;
			b = d && ts.isClassLike(d) && !d.getSourceFile().isDeclarationFile ? d : undefined;
		}
	},

	/** A list of statements at the current indent, function declarations hoisted as JavaScript hoists them. */
	statements(this: Translator, list: ts.Statement[]): string[] {
		const fns = list.filter(ts.isFunctionDeclaration);
		const scoped = this.scopedVars(list);
		const forward = [...scoped, ...this.forwardDeclarations(list)];
		// What follows a read of a null receiver never runs.
		const throwsAt = list.findIndex((s) => !ts.isFunctionDeclaration(s) && leadingNeverRead(s, this.checker));
		const rest = list.filter((s, k) => !ts.isFunctionDeclaration(s) && (throwsAt < 0 || k < throwsAt));
		const out = [...forward, ...this.localDeclarationsOf(fns), ...fns.map((s) => this.stmt(s)).filter(Boolean)];
		for (const s of rest) {
			const code = this.stmt(s);
			if (code) out.push(code);
			// Statements after one Swift sees never complete (a return, a try that cannot fail and returns) are dead.
			if (this.endUnreachable(s)) return out;
		}
		if (throwsAt >= 0) {
			const read = leadingNeverRead(list[throwsAt], this.checker)!;
			out.push(`${this.indent}throw JSException(JSTypeError(${swiftString(`Cannot read properties of undefined (reading '${read.name.text}')`)}))`);
		}
		return out;
	},

	/**
	 * A function's `var`s declared in an inner block (a loop's head, a branch) and read or declared again outside it:
	 * declared once at the top of the function body, as JavaScript hoists them, and assigned where they are declared.
	 */
	scopedVars(this: Translator, list: ts.Statement[]): string[] {
		const body = list[0]?.parent;
		if (!body || !ts.isBlock(body) || !ts.isFunctionLike(body.parent)) return [];
		const scope = (n: ts.Node) => ts.findAncestor(n.parent, (a) => ts.isBlock(a) || ts.isIterationStatement(a, false) || ts.isCaseBlock(a) || ts.isCatchClause(a) || ts.isFunctionLike(a))!;
		const decls = new Map<ts.Symbol, ts.VariableDeclaration[]>();
		const collect = (n: ts.Node): void => {
			if (ts.isVariableDeclarationList(n) && !(n.flags & ts.NodeFlags.BlockScoped) && !ts.isForInStatement(n.parent) && !ts.isForOfStatement(n.parent)) {
				for (const d of n.declarations) {
					const sym = ts.isIdentifier(d.name) ? this.checker.getSymbolAtLocation(d.name) : undefined;
					if (sym && !this.forwardDeclared.has(d)) decls.set(sym, [...(decls.get(sym) ?? []), d]);
				}
			}
			if (!ts.isFunctionLike(n) && !ts.isClassLike(n)) ts.forEachChild(n, collect);
		};
		list.forEach(collect);
		const refs = new Map<ts.Symbol, ts.Identifier[]>();
		const collectRefs = (n: ts.Node): void => {
			const sym = ts.isIdentifier(n) ? this.checker.getSymbolAtLocation(n) : undefined;
			if (sym && decls.has(sym)) refs.set(sym, [...(refs.get(sym) ?? []), n as ts.Identifier]);
			ts.forEachChild(n, collectRefs);
		};
		if (decls.size) list.forEach(collectRefs);
		const out: string[] = [];
		for (const [sym, ds] of decls) {
			// Declared in a for-in or for-of head too, which Swift's loop declares for itself.
			if (sym.declarations?.some((d) => ts.isVariableDeclaration(d) && (ts.isForInStatement(d.parent.parent) || ts.isForOfStatement(d.parent.parent)))) continue;
			const inner = ds.filter((d) => scope(d) !== body);
			const escapes = inner.some((d) => (refs.get(sym) ?? []).some((r) => !ts.findAncestor(r, (a) => a === scope(d))));
			if (!escapes || !ts.isIdentifier(ds[0].name)) continue;
			for (const d of ds) this.forwardDeclared.add(d);
			out.push(`${this.indent}var ${ident(ds[0].name.text)}: ${this.deferred(this.typeOf(ds[0].name))}`);
		}
		return out;
	},

	/**
	 * The variables of a list that a function declared before them reads, declared up front (see `forwardDeclared`); and,
	 * as JavaScript hoists a `var` to its function, one read before its declaration or declared in a nested block and read outside it.
	 */
	forwardDeclarations(this: Translator, list: ts.Statement[]): string[] {
		const forward: string[] = [];
		const isVar = (l: ts.VariableDeclarationList) => !(l.flags & ts.NodeFlags.BlockScoped);
		list.forEach((st, k) => {
			const own = ts.isVariableStatement(st) ? st.declarationList.declarations.map((d) => ({ d, nested: false })) : [];
			// `var` declarations in the statement's blocks (`if (…) { var observer = … }`), not in its functions or classes.
			const nested: ts.VariableDeclaration[] = [];
			const collect = (n: ts.Node) => {
				if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
				if (ts.isVariableDeclarationList(n) && isVar(n)) nested.push(...n.declarations);
				ts.forEachChild(n, collect);
			};
			if (!ts.isVariableStatement(st) && !ts.isFunctionDeclaration(st) && !ts.isClassDeclaration(st)) ts.forEachChild(st, collect);
			for (const { d, nested: inner } of [...own, ...nested.map((d) => ({ d, nested: true }))]) {
				if (!ts.isIdentifier(d.name) || (!d.initializer && !inner) || this.forwardDeclared.has(d)) continue;
				if (inner && (!d.initializer || !ts.isVariableDeclarationList(d.parent) || ts.isForInStatement(d.parent.parent) || ts.isForOfStatement(d.parent.parent))) continue;
				const sym = this.checker.getSymbolAtLocation(d.name);
				// A `var` declared again (`var total = n; var total = total * 2`) is declared where it first is.
				const hoisted = isVar(d.parent as ts.VariableDeclarationList) && (sym?.declarations?.length ?? 0) < 2;
				if (inner && !hoisted) continue;
				let early = false;
				const visit = (n: ts.Node, inFn: boolean) => {
					if (early) return;
					if ((inFn || hoisted) && ts.isIdentifier(n) && n !== d.name && this.checker.getSymbolAtLocation(n) === sym) {
						early = true;
						return;
					}
					ts.forEachChild(n, (c) => visit(c, inFn || ts.isFunctionLike(c)));
				};
				list.forEach((other, j) => {
					if (j < k || (inner && j > k) || ts.isFunctionDeclaration(other)) visit(other, ts.isFunctionLike(other));
				});
				if (!early) continue;
				this.forwardDeclared.add(d);
				const t = this.typeOf(d.name);
				forward.push(`${this.indent}var ${ident(d.name.text)}: ${deadZoneBinding(d) ? this.setBeforeRead(t) : this.deferred(t)}`);
			}
		});
		return forward;
	},

	block(this: Translator, b: ts.Statement, base?: string): string {
		if (base === undefined) base = this.indent;
		const saved = this.indent;
		this.indent = base + '    ';
		try {
			const body = this.statements(ts.isBlock(b) ? [...b.statements] : [b]);
			return `{\n${body.join('\n')}\n${base}}`;
		} finally {
			this.indent = saved;
		}
	},

	stmt(this: Translator, s: ts.Statement): string {
		try {
			return HELD_LOSS ? atLossSite('swift', this, s, () => this.stmtChecked(s)) : this.stmtChecked(s);
		} catch (e) {
			const located = this.located(e, s);
			if (!this.errors) throw located;
			this.errors.push((located as Error).message ?? String(located));
			return '';
		}
	},

	stmtChecked(this: Translator, s: ts.Statement): string {
		// A statement using an API newer than what is checked runs only on an OS that has it, so the code's own checks before it
		// (`respondsToSelector`, early returns) still decide. A declaration's names are read after it: its enclosing statement is gated instead.
		const gates = this.availability.length > 0 && !this.asyncCtx && !ts.isVariableStatement(s) && !ts.isFunctionDeclaration(s) && !ts.isClassDeclaration(s);
		// A declaration is not gated (its names are read after it), but only what its code names passes on to the statement enclosing it.
		const declares = this.availability.length > 0 && !this.asyncCtx && ts.isVariableStatement(s);
		const types = new Map<string, number>();
		if (gates || declares) {
			this.availability.push(0);
			this.statementTypes.set(this.availability.length, types);
		}
		let code: string;
		let needs = 0;
		try {
			code = this.statementCode(s);
		} finally {
			if (gates || declares) {
				this.statementTypes.delete(this.availability.length);
				needs = this.availability.pop()!;
			}
		}
		const ungated = types.size ? withoutAvailableBlocks(code) : code;
		for (const [name, version] of types) if (version > needs && new RegExp(`(?<!\\w)${name.replace(/[.$]/g, '\\$&')}\\b`).test(ungated)) needs = version;
		if (declares) {
			if (needs) this.requireAvailability(needs);
			needs = 0;
		}
		// A return inside a try whose finally throws: recorded, and the finally runs before it is made.
		const pending = this.pendingReturn;
		if (pending && ts.isReturnStatement(s) && !this.asyncCtx) {
			const lines = code.split('\n');
			const m = /^(\s*)return(?: (.*))?$/.exec(lines.at(-1)!);
			if (!m) throw this.error(s, 'a return in a try whose finally block throws', 'finally-jump');
			lines[lines.length - 1] = `${m[1]}${m[2] !== undefined && pending.value ? `${pending.value} = ${m[2]}; ` : ''}${pending.flag ? `${pending.flag} = true; ` : ''}break ${pending.label}`;
			code = lines.join('\n');
		}
		if (needs && code) {
			const fn = ts.findAncestor(s.parent, ts.isFunctionLike);
			const throws = !!fn && this.throwsInfo.fn(fn) && !isAsync(fn) && !(fn as ts.FunctionLikeDeclaration).asteriskToken;
			code = this.availableOnly(needs, code, this.indent, fn ? this.unavailable(needs, this.returnType, throws) : `${RT.jsReportUncaught}(${RT.jsUnavailable}(${needs}).value)`);
		}
		return code && this.lines ? this.lines.mark(s) + code : code;
	},

	statementCode(this: Translator, s: ts.Statement): string {
		const i = this.indent;
		const a = this.asyncCtx;
		if (ts.isExpressionStatement(s)) {
			// A native subclass's `super.dealloc()`: its deinit (see NativeAPI.classDecl), after which Swift runs the base's.
			if (this.inNativeClassBody && ts.isCallExpression(s.expression) && !s.expression.arguments.length && ts.isPropertyAccessExpression(s.expression.expression) && s.expression.expression.expression.kind === ts.SyntaxKind.SuperKeyword && s.expression.expression.name.text === 'dealloc') return '';
			const logical = this.voidLogical(s.expression);
			if (logical) return i + logical;
			// An awaited value already settled (`await p;`, its continuation given the value) has nothing left to do.
			if (ts.isAwaitExpression(s.expression) && this.subst.has(s.expression)) return '';
			// A discarded value needs no stand-in for undefined (`_ = (xs.pop() ?? nil)`).
			const code = this.exprStatement(s.expression)
				.replace(/^_ = \((.*) \?\? (?:nil|\.nan)\)$/s, (all, value: string) => (balanced(value) ? this.marks.assignedCode('_', value) : all))
				// Nor a call's result Swift holds optional (`_applyGlassEffect(…)` giving undefined): unread, it is not unwrapped.
				.replace(/^_ = (.*\))!$/s, (all, value: string) => (ts.isCallExpression(ts.skipOuterExpressions(s.expression)) && balanced(value) ? this.marks.assignedCode('_', value) : all));
			// `s = String(s)` of a string: the same value, which Swift refuses to assign to itself.
			const self = /^([\w.]+) = (.+)$/.exec(code);
			if (self && self[1] === self[2]) return '';
			const assigned = this.marks.triedStatement(this.tryPrefix(s.expression), code);
			const note = this.keyNotes?.get(s);
			return i + (code.startsWith('{') ? `do { ${assigned} }` : assigned) + (note ? `\n${i}${note}` : '');
		}
		if (ts.isReturnStatement(s)) {
			const slot = this.resultSlot(s);
			return this.returned(returnCell(this.returns, s.expression, slot), slot);
		}
		if (ts.isIfStatement(s)) {
			// A condition the parameters' constant values decide: only the branch that runs.
			const fixed = this.reach?.constant(s.expression) ?? this.staticTypeof(s.expression);
			if (fixed !== undefined) {
				const live = fixed ? s.thenStatement : s.elseStatement;
				// An `else if`'s live branch stays a block: the `if` before it takes it as its `else`.
				const elseBranch = ts.isIfStatement(s.parent) && s.parent.elseStatement === s;
				return live ? (elseBranch ? `${i}do ${this.block(live)}` : this.scope(live)) : '';
			}
			const gated = this.availabilityIf(s);
			if (gated !== null) return gated;
			let out = `${i}if ${this.tryPrefix(s.expression)}${this.cond(s.expression)} ${this.block(s.thenStatement)}`;
			if (s.elseStatement && ts.isIfStatement(s.elseStatement)) {
				// An `else if` decided now is its live branch's block, or nothing.
				const rest = this.statementCode(s.elseStatement).trimStart();
				out += rest.startsWith('if ') ? ` else ${rest}` : rest.startsWith('do {') ? ` else ${rest.slice(3)}` : '';
			} else if (s.elseStatement) out += ` else ${this.block(s.elseStatement)}`;
			return out;
		}
		if (ts.isVariableStatement(s)) {
			const note = this.keyNotes?.get(s);
			return this.declarationList(s.declarationList, false) + (note ? `\n${i}${note}` : '');
		}
		if (ts.isFunctionDeclaration(s)) {
			if (!s.name || !s.body) return '';
			// Swift leaves a function declared inside a closure nonisolated, whatever the closure's isolation; an async
			// function's or a generator's body is closures too.
			const outer = ts.findAncestor(s.parent, ts.isFunctionLike);
			const inClosure = outer && (ts.isArrowFunction(outer) || ts.isFunctionExpression(outer) || isAsync(outer) || ('asteriskToken' in outer && !!outer.asteriskToken));
			const isolation = inClosure ? '@MainActor ' : '';
			return i + isolation + this.func(s, ident(s.name.text));
		}
		if (ts.isForOfStatement(s)) {
			if (s.awaitModifier) throw this.error(s, 'for await');
			const list = s.initializer;
			if (!ts.isVariableDeclarationList(list)) return this.forOfAssigning(s, list);
			const decl = list.declarations[0];
			const mutable = !(list.flags & ts.NodeFlags.Const);
			// Declared before the body is translated: its reads take the binding as it holds it.
			for (const n of ts.isIdentifier(decl.name) ? [decl.name] : decl.name.elements.flatMap((el) => (ts.isBindingElement(el) && ts.isIdentifier(el.name) ? [el.name] : []))) {
				if (this.states.optionalBinding(n)) this.bindsOptional(n, this.typeOf(n));
			}
			if (this.forOfSteps(s.expression)) return this.steppedLoop(s);
			const iterable = this.iterable(s.expression);
			// A sequence that starts with a closure would read as the loop's body: parenthesized.
			const seq = (this.tryPrefix(s.expression) || (this.isAny(s.expression) ? 'try ' : '')) + (/^\{/.test(iterable) ? `(${iterable})` : iterable);
			return this.loopBody(() => {
				const label = this.takeLabel();
				// A collection holding functions as function objects (`heldType`) gives each as any value, converted to the binding's type.
				const held = ts.isIdentifier(decl.name) && isUntyped(spelledType(this.elementTypeOf(s.expression))) && !this.isAny(decl.name) && isUntyped(spelledType(heldType(this.typeOf(decl.name))));
				// Lenient code: a binding the body assigns holds what a declaration of its type holds (`lenientRef`).
				const widened = ts.isIdentifier(decl.name) && this.lenient && mutable && this.lenientRef(this.typeOf(decl.name)) !== this.typeOf(decl.name) && assignsTo(s.statement, this.checker.getSymbolAtLocation(decl.name), this.checker);
				if (ts.isIdentifier(decl.name) && !held && !widened) return `${i}${label}for ${mutable ? 'var ' : ''}${ident(decl.name.text)} in ${seq} ${this.block(s.statement)}`;
				const item = this.fresh('__item');
				if (ts.isIdentifier(decl.name)) {
					const t = widened ? this.lenientRef(this.typeOf(decl.name)) : this.typeOf(decl.name);
					if (widened && !held) return `${i}${label}for ${item} in ${seq} {\n${i}    var ${ident(decl.name.text)}: ${t} = ${item}\n${this.block(s.statement).slice(2)}`;
					const bind = `${i}    ${mutable ? 'var' : 'let'} ${ident(decl.name.text)}: ${t} = ${isOptional(t) ? this.convert(item, 'Any?', t) : this.presentFromAny(item, t)}`;
					return `${i}${label}for ${item} in ${seq} {\n${bind}\n${this.block(s.statement).slice(2)}`;
				}
				const bind = this.nested(() => this.bindTo(decl.name, item, this.isAny(s.expression) ? 'Any?' : '', mutable));
				const body = this.block(s.statement);
				return `${i}${label}for ${item} in ${seq} {\n${bind}\n${body.slice(2)}`;
			});
		}
		if (ts.isForInStatement(s)) {
			const list = s.initializer as ts.VariableDeclarationList;
			const name = ident((list.declarations[0].name as ts.Identifier).text);
			const mutable = assignsTo(s.statement, this.checker.getSymbolAtLocation(list.declarations[0].name), this.checker) ? 'var ' : '';
			return this.loopBody(() => `${i}${this.takeLabel()}for ${mutable}${name} in ${this.tryPrefix(s.expression)}${RT.jsKeysOf}(${this.expr(s.expression)}) ${this.block(s.statement)}`);
		}
		if (ts.isForStatement(s)) return this.forStatement(s);
		if (ts.isWhileStatement(s)) return this.loopBody(() => `${i}${this.takeLabel()}while ${this.tryPrefix(s.expression)}${this.cond(s.expression)} ${this.block(s.statement)}`);
		if (ts.isDoStatement(s)) return this.loopBody(() => `${i}${this.takeLabel()}repeat ${this.block(s.statement)} while ${this.tryPrefix(s.expression)}${this.cond(s.expression)}`);
		if (ts.isBreakStatement(s) || ts.isContinueStatement(s)) {
			const isBreak = ts.isBreakStatement(s);
			if (s.label) return i + this.labeledJump(s);
			if (a && (isBreak ? a.brk && !this.plainBreak : a.cont && !this.plainContinue)) return `${i}${isBreak ? a.brk : a.cont}\n${i}return`;
			const target = isBreak ? this.breakTargets.at(-1) : null;
			return i + (isBreak ? (target ? `break ${target}` : 'break') : 'continue');
		}
		if (ts.isBlock(s)) return this.scope(s);
		if (ts.isEmptyStatement(s)) return '';
		if (ts.isSwitchStatement(s)) return this.switchStatement(s);
		if (ts.isThrowStatement(s)) return `${i}throw ${this.tryPrefix(s.expression)}JSException(value: ${this.coerce(s.expression, 'Any?')})`;
		if (ts.isTryStatement(s)) return this.tryStatement(s);
		if (ts.isLabeledStatement(s)) {
			if (this.asyncCtx) throw this.error(s, 'a labeled statement in an async function');
			// A labeled block, `if` or `switch` is a labeled `do` that `break label` leaves.
			if (!ts.isIterationStatement(s.statement, false)) return `${i}${ident(s.label.text)}: do {\n${this.nested(() => this.stmt(s.statement))}\n${i}}`;
			this.label = ident(s.label.text);
			return this.stmt(s.statement);
		}
		if (ts.isClassDeclaration(s) || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) {
			if (ts.isClassDeclaration(s)) {
				// A native class (`@NativeClass class Impl extends NSObject`) that uses nothing of the function around it is the module's.
				if (!this.capturesLocals(s)) {
					const saved = this.indent;
					this.indent = '';
					let native: string | null;
					try {
						native = this.native.classDecl(s);
					} finally {
						this.indent = saved;
					}
					if (native) {
						this.hoisted.push(native);
						// Its statics are declared where the class is defined, for script that holds it as a value.
						return this.library && this.heldAsValue(s) ? this.classDefinition(s) : '';
					}
					// A class of the program's that uses nothing of the function around it: the module's, as Swift declares classes.
					if (s.name) {
						const saved2 = this.indent;
						const prevInits = this.staticInits;
						this.indent = '';
						this.staticInits = [];
						let inits: string[];
						try {
							this.hoisted.push(this.classDecl(s));
						} finally {
							inits = this.staticInits;
							this.staticInits = prevInits;
							this.indent = saved2;
						}
						const parts: string[] = [];
						if ((this.library || this.appMembersByName) && s.members.some((m) => ts.isAccessor(m) && !isStatic(m))) {
							const acc = this.prototypeAccessors(s);
							if (acc) parts.push(acc);
						}
						for (const line of inits) parts.push(line.replace(/^ {4}/gm, this.indent));
						if ((this.library || this.appMembersByName) && (ts.getDecorators(s)?.length || this.heldAsValue(s))) {
							const def = this.classDefinition(s);
							if (def) parts.push(def);
						} else if (!this.library && !this.appMembersByName && this.states.byNameStatics(s)) {
							const stat = this.staticsDeclaration(s);
							if (stat) parts.push(stat);
						}
						return parts.join('\n');
					}
				}
				throw this.error(s, 'a class declared inside a function');
			}
			return '';
		}
		throw this.error(s, 'statement');
	},

	/** `try ` when evaluating `e` can throw. */
	tryPrefix(this: Translator, e: ts.Node): string {
		return this.throwsInfo.expr(e) ? 'try ' : '';
	},

	/** An expression where Swift needs a value of `target`. */
	coerce(this: Translator, e: ts.Expression, target: string | ResultSlot): string {
		return place(this.placement, e, target);
	},

	/** `e` stored by `at` (a declaration, an object literal's field, an assignment's target) where Swift holds `target`; `checks` as `storeSlot` has it. */
	stored(this: Translator, e: ts.Expression, at: Store, target: string, checks = true): string {
		return place(this.placement, e, this.storeSlot(e, target, at, checks));
	},

	storeSlot(this: Translator, e: ts.Expression, target: string, at: Store, checks = true): StoreSlot {
		return storeSlot(this.placement, target, at, e, checks);
	},

	/** The result slot of the function being translated, where `at` (a `return`, an expression body) gives its value. */
	resultSlot(this: Translator, at: ts.Node): ResultSlot {
		return resultSlot(this.asyncCtx ? this.asyncCtx.result : this.returnType, ts.findAncestor(at.parent, ts.isFunctionLike), !!this.asyncCtx);
	},

	/** A `return` statement's cell, as Swift writes it. */
	returned(this: Translator, cell: ReturnCell, slot: ResultSlot): string {
		const i = this.indent,
			a = this.asyncCtx;
		switch (cell.step) {
			case 'empty':
				return a ? `${i}${a.ret(null, false)}\n${i}return` : `${i}return${cell.code ? ` ${cell.code}` : ''}`;
			case 'drop':
				return `${i}${this.marks.triedStatement(this.tryPrefix(cell.e), this.marks.assignedCode('_', this.expr(cell.e)))}\n${i}return`;
			case 'never':
				return `${i}${this.marks.tryBefore(this.tryPrefix(cell.e), this.expr(cell.e))}`;
			case 'voidCall':
				return `${i}${this.tryPrefix(cell.e)}${this.exprStatement(cell.e)}\n${i}return ${cell.empty}`;
		}
		const e = cell.e;
		if (cell.code !== undefined) return `${i}return ${cell.code}`;
		if (a) {
			if (a.generator === 'async') return `${i}${this.lowering.returnIn(a, e)}\n${i}return`;
			return `${i}${a.ret(...this.loweredReturn(e, slot))}\n${i}return`;
		}
		return `${i}return ${this.marks.tryBefore(this.tryPrefix(e), place(this.placement, e, slot))}`;
	},
};
