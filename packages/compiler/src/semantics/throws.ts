import ts from 'typescript';
import { accessedDeclaration, boxedReplacement, readWrite, intlConstructor, isStringRaw, iterationThrows, uncheckedMatch, unsafeReceiver } from './lang.ts';
import { callableSignal, linkedSignalCall, linkedSignalRuns, mayBeUnset, signalEqual, signalWriteEqual } from './signals.ts';
import { isWriteTarget } from './ast.ts';
import { BUFFER_TYPES } from './globals.ts';
import { conversionThrows, convertsPlainly, convertsUntyped, conversionCall } from './apis/operators.ts';
import { Framework } from '../adapters/hooks.ts';

type Fn = ts.SignatureDeclaration & { body?: ts.Node };

/** Library functions that throw on their own (a TypeError, a SyntaxError, a RangeError). */
const THROWING_BUILTINS = new Set([
	'JSON.parse',
	'JSON.stringify',
	'Array.reduce',
	'Array.reduceRight',
	'Array.with',
	'Number.toExponential',
	'String.repeat',
	'String.padStart',
	'String.padEnd',
	'String.fromCodePoint',
	'String.normalize',
	'String.matchAll',
	'String.replaceAll',
	'Date.toISOString',
	'Object.assign',
	'Object.setPrototypeOf',
	'Object.fromEntries',
	'Object.defineProperty',
	'Object.defineProperties',
	'WeakMap.set',
	'WeakSet.add',
	'Iterator.next',
	'Iterator.return',
	'Iterator.throw',
	'Generator.next',
	'Generator.return',
	'Generator.throw',
	...['Int8', 'Uint8', 'Uint8Clamped', 'Int16', 'Uint16', 'Int32', 'Uint32', 'Float32', 'Float64', 'BigInt64', 'BigUint64'].flatMap((t) => [`${t}Array.set`, `${t}Array.reduce`, `${t}Array.reduceRight`, `${t}Array.from`]),
	...['Int8', 'Uint8', 'Int16', 'Uint16', 'Int32', 'Uint32', 'Float32', 'Float64', 'BigInt64', 'BigUint64'].flatMap((t) => [`DataView.get${t}`, `DataView.set${t}`]),
	'Number.toLocaleString',
	'BigInt.toLocaleString',
	'Function.apply',
	'CallableFunction.apply',
	'Object.defineProperties',
	'Object.getPrototypeOf',
	'Array.toLocaleString',
	'Date.toLocaleString',
	'Date.toLocaleDateString',
	'Date.toLocaleTimeString',
	'DateTimeFormat.format',
	'atob',
	'btoa',
	'Crypto.getRandomValues',
	'TextDecoder.decode',
	'Worker.postMessage',
	'DedicatedWorkerGlobalScope.postMessage',
	'postMessage',
	'close',
]);

/**
 * Which functions throw, worked out across the call graph: a function is
 * Swift `throws` when its body throws, or calls something that does, outside
 * a `try` that catches. Calls through function values (a callback parameter,
 * a stored closure) count as throwing, because function types are `throws`
 * in Swift. Async functions never throw synchronously; their errors reject.
 */
export class Throws {
	private throwing = new Set<ts.Node>();
	/** The program's classes, in source order. */
	private classes: ts.ClassLikeDeclaration[] = [];
	/** The program's own toString, valueOf and [Symbol.toPrimitive] methods, each with the class or object literal declaring it. */
	private conversions: { member: Fn; owner: ts.ClassLikeDeclaration | ts.ObjectLiteralExpression }[] = [];
	/** `throwingConversions`'s answer, and the size of `throwing` it was worked out at: it changes only as `throwing` grows. */
	private conversionCache: { at: number; members: Set<ts.Node>; owners: ts.Type[] } | null = null;
	/**
	 * Class → its subclasses (direct and further), in source order: `subclasses[subclassStart[i] .. subclassStart[i + 1]]`
	 * for the class at `classAt` i. Built on the first query, not in the constructor: `ancestors` asks the checker, and
	 * asking it in another order can change what it prints.
	 */
	private classAt: Map<ts.ClassLikeDeclaration, number> | null = null;
	private subclassStart = new Int32Array(0);
	private subclasses: ts.ClassLikeDeclaration[] = [];
	readonly checker: ts.TypeChecker;
	/** The build's framework: what its API throws. */
	private framework: () => Framework;
	/** Whether a value is untyped in Swift (`Any?`): reading its members goes through `jsGet`, which throws. */
	private untyped: (n: ts.Node) => boolean;

	/** Whether a call throws for what its declaration does not show: a native method Swift imports as `throws`, a method an instance can hold a value in place of. */
	private nativeThrows: (call: ts.CallExpression | ts.NewExpression) => boolean;

	/** A declaration file's method or constructor whose compiled implementation is in the program (library mode). */
	private implementation: (decl: ts.Declaration) => ts.Declaration | null;

	/** A member read by name at run time (library mode: one only a declaration file declares), which throws on undefined. */
	private dynamicMember: (e: ts.PropertyAccessExpression) => boolean;

	/** Whether converting a value to the type its place declares can fail (an untyped value cast to a class), which throws a TypeError. */
	private castThrows: (n: ts.Node) => boolean;

	/** Whether a call runs a native method by its native signature (an override of one in a native subclass): it throws only as `nativeThrows` says. */
	private nativeEntry: (call: ts.CallExpression) => boolean;

	/** Whether the translation evaluates an expression where nothing it throws escapes (a `delete` written with `try?`). */
	private quiet: (n: ts.Node) => boolean;

	/** Whether the kit's Swift a function stands for throws (`ColorMix.argbFromColorMix` for core's): undefined where the function's own body decides. */
	private kitThrows: (fn: ts.Node) => boolean | undefined;

	/** An accessor a backend declares without `throws` (a Swift getter paired with a setter, a Swift setter) and whose reads or writes it does not route to a throwing body: it reports what its body throws. */
	private reported: (accessor: ts.AccessorDeclaration, throws: (fn: ts.Node) => boolean) => boolean;

	/** An expression the translation writes as a runtime helper that cannot throw (`jsConstructor(x)`), its operands aside. */
	private plain: (n: ts.Node) => boolean;

	/** Whether the translation checks a value there that may be missing (`jsUnwrap`, a destructured parameter's), which throws JavaScript's TypeError. */
	private checked: (n: ts.Node) => boolean;

	/** The linked signals `linkedThrows` is deciding, one source reading another. */
	private linkedVisits = new Set<ts.Node>();

	constructor(
		checker: ts.TypeChecker,
		files: readonly ts.SourceFile[],
		untyped: (n: ts.Node) => boolean,
		nativeThrows: (call: ts.CallExpression | ts.NewExpression) => boolean = () => false,
		implementation: (decl: ts.Declaration) => ts.Declaration | null = () => null,
		dynamicMember: (e: ts.PropertyAccessExpression) => boolean = () => false,
		baseInitThrows: (cls: ts.ClassLikeDeclaration) => boolean = () => false,
		replaced: (fn: ts.Node) => boolean = () => false,
		castThrows: (n: ts.Node) => boolean = () => false,
		nativeEntry: (call: ts.CallExpression) => boolean = () => false,
		quiet: (n: ts.Node) => boolean = () => false,
		kitThrows: (fn: ts.Node) => boolean | undefined = () => undefined,
		reported: (accessor: ts.AccessorDeclaration, throws: (fn: ts.Node) => boolean) => boolean = () => false,
		plain: (n: ts.Node) => boolean = () => false,
		checked: (n: ts.Node) => boolean = () => false,
		compiled: (st: ts.Statement) => boolean = () => true,
		framework: () => Framework = () => new Framework(),
	) {
		this.framework = framework;
		this.checked = checked;
		this.kitThrows = kitThrows;
		this.reported = reported;
		this.plain = plain;
		this.castThrows = castThrows;
		this.nativeEntry = nativeEntry;
		this.quiet = quiet;
		this.baseInitThrows = baseInitThrows;
		this.implementation = implementation;
		this.dynamicMember = dynamicMember;
		this.checker = checker;
		this.untyped = untyped;
		this.nativeThrows = nativeThrows;
		const fns: Fn[] = [];
		const collect = (n: ts.Node) => {
			if (ts.isFunctionLike(n) && (n as Fn).body) fns.push(n as Fn);
			if (ts.isClassLike(n)) this.classes.push(n);
			// A shim's class is the kit's own, whose conversions are the kit's.
			if ((ts.isClassLike(n) || ts.isObjectLiteralExpression(n)) && !n.getSourceFile().fileName.startsWith('/__shims__/')) {
				for (const m of ts.isClassLike(n) ? n.members : n.properties) {
					const member = conversionMethod(m);
					if (member) this.conversions.push({ member, owner: n });
				}
			}
			ts.forEachChild(n, collect);
		};
		// Typing code that is not compiled registers its object shapes, which then name declarations nothing compiles.
		for (const f of files) for (const st of f.statements) if (compiled(st)) collect(st);
		for (let changed = true; changed;) {
			changed = false;
			for (const fn of fns) {
				if (this.throwing.has(fn) || isAsync(fn) || (fn as ts.FunctionLikeDeclaration).asteriskToken) continue;
				// A member the kit implements instead is a call into its Swift, which throws.
				if (this.kitThrows(fn) === false) continue;
				if (replaced(fn) || this.bodyThrows(fn)) {
					this.throwing.add(fn);
					changed = true;
				}
			}
		}
	}

	/** Whether calling `fn` (a declaration with a body) can throw. */
	fn(fn: ts.Node): boolean {
		const kit = this.kitThrows(fn);
		if (kit !== undefined) return kit;
		if (this.throwing.has(fn)) return true;
		// Swift initializers override as methods do: a class's constructor throws if one in its hierarchy does.
		if (ts.isConstructorDeclaration(fn) && ts.isClassLike(fn.parent)) {
			for (const other of [...this.ancestors(fn.parent), ...this.descendants(fn.parent)]) {
				const c = other.members.find((x) => ts.isConstructorDeclaration(x) && x !== fn);
				if (c && this.throwing.has(c)) return true;
			}
		}
		// Swift overrides share `throws`: a method throws if any method of its name in the hierarchy does.
		if ((ts.isMethodDeclaration(fn) || ts.isAccessor(fn)) && ts.isClassLike(fn.parent) && fn.name) {
			const name = fn.name.getText();
			// An overloaded method's signatures and implementation are one Swift method; a getter is not its setter.
			for (const other of [fn.parent, ...this.ancestors(fn.parent), ...this.descendants(fn.parent)]) {
				if (other.members.some((x) => x !== fn && x.kind === fn.kind && x.name?.getText() === name && this.throwing.has(x))) return true;
			}
			// A write through the base's type may reach a subclass's getter-only override.
			if (ts.isSetAccessorDeclaration(fn) && this.descendants(fn.parent).some((d) => d.members.some((x) => ts.isGetAccessorDeclaration(x) && x.name.getText() === name && getterOnlyOverride(x, this.checker)))) return true;
		}
		return false;
	}

	/**
	 * Whether converting the typed value `n` to a primitive can throw: a toString, valueOf or [Symbol.toPrimitive] of
	 * the program's that may throw or give no primitive (ToPrimitive's TypeError) is its type's own, or that of a class
	 * or object literal whose values its type admits (a subclass, a class implementing its interface).
	 */
	objectConversionThrows(n: ts.Node): boolean {
		const { members, owners } = this.throwingConversions();
		if (!owners.length) return false;
		const c = this.checker;
		const type = c.getTypeAtLocation(n);
		return (type.isUnion() ? type.types : [type]).some((t) => {
			if (convertsPlainly(t) || t.flags & (ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
			const target = t.flags & ts.TypeFlags.TypeParameter ? c.getBaseConstraintOfType(t) : t;
			if (!target) return false;
			if (target.getProperties().some((p) => p.declarations?.some((d) => members.has(d)))) return true;
			return owners.some((o) => c.isTypeAssignableTo(o, target));
		});
	}

	/** The conversion methods that may throw or give no primitive, and the types of the classes and literals declaring or inheriting one. */
	private throwingConversions(): { members: Set<ts.Node>; owners: ts.Type[] } {
		if (this.conversionCache?.at === this.throwing.size) return this.conversionCache;
		const members = new Set<ts.Node>();
		const owners = new Set<ts.Type>();
		const c = this.checker;
		for (const { member, owner } of this.conversions) {
			const sig = c.getSignatureFromDeclaration(member);
			if (!this.fn(member) && sig && convertsPlainly(c.getReturnTypeOfSignature(sig))) continue;
			members.add(ts.isMethodDeclaration(member) ? member : member.parent);
			if (ts.isObjectLiteralExpression(owner)) owners.add(c.getTypeAtLocation(owner));
			else
				for (const cls of [owner, ...this.descendants(owner)]) {
					const sym = cls.name && c.getSymbolAtLocation(cls.name);
					const t = sym ? c.getDeclaredTypeOfSymbol(sym) : c.getTypeAtLocation(cls).getConstructSignatures()[0]?.getReturnType();
					if (t) owners.add(t);
				}
		}
		this.conversionCache = { at: this.throwing.size, members, owners: [...owners] };
		return this.conversionCache;
	}

	/** Whether a signal's `equal` (as `signalEqual` gives it) can throw: what it names unseen, a function as its body does. */
	equalThrows(equal: ts.Expression | true): boolean {
		if (equal === true) return true;
		const e = ts.skipOuterExpressions(equal);
		if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return this.fn(e);
		let sym = ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) ? this.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(e) ? e.name : e) : undefined;
		if (sym && sym.flags & ts.SymbolFlags.Alias) sym = this.checker.getAliasedSymbol(sym);
		const d = accessedDeclaration(sym);
		// A declared function (`Object.is`) is taken not to throw.
		if (d?.getSourceFile().isDeclarationFile && ts.isFunctionLike(d)) return false;
		const fn = d && ts.isVariableDeclaration(d) && d.initializer ? ts.skipOuterExpressions(d.initializer) : d;
		return !(fn && ts.isFunctionLike(fn) && 'body' in fn && fn.body) || this.fn(fn);
	}

	/** Whether a `set`/`update` call writes a signal whose `equal` can throw: that write reaches its caller. */
	signalWriteThrows(call: ts.CallExpression): boolean {
		const equal = signalWriteEqual(call, this.checker, this.framework().hooks.signalOptions);
		return equal !== undefined && this.equalThrows(equal);
	}

	/**
	 * Whether reading or updating the linked signal `e` names (`linkedSignalCall`) can throw: each rethrows what its
	 * computation, its source or its `equal` threw.
	 */
	linkedThrows(e: ts.Expression): boolean {
		const call = linkedSignalCall(e, this.checker, this.framework());
		if (!call || this.linkedVisits.has(call)) return false;
		this.linkedVisits.add(call);
		try {
			const equal = signalEqual(call, this.checker, this.framework().hooks.signalOptions);
			return (equal !== undefined && this.equalThrows(equal)) || linkedSignalRuns(call).some((r) => this.runValueThrows(r));
		} finally {
			this.linkedVisits.delete(call);
		}
	}

	/** Whether calling the function `r` gives (a linked signal's computation or source) can throw; one unseen is taken to. */
	private runValueThrows(r: ts.Node): boolean {
		const x = ts.isExpression(r) ? ts.skipOuterExpressions(r) : r;
		if (ts.isFunctionLike(x) && !ts.isAccessor(x) && (x as Fn).body) return !isAsync(x) && this.fn(x);
		if (!ts.isIdentifier(x) && !ts.isPropertyAccessExpression(x)) return true;
		const t = this.checker.getTypeAtLocation(x);
		const name = (t.aliasSymbol ?? t.getSymbol())?.getName();
		// A signal given as the source (`source: page`) is read.
		if (name !== undefined && callableSignal(this.framework().signalKind(name))) return this.signalReadThrows(x);
		let sym = this.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(x) ? x.name : x);
		if (sym && sym.flags & ts.SymbolFlags.Alias) sym = this.checker.getAliasedSymbol(sym);
		const d = sym?.valueDeclaration;
		if (d && (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) && d.body) return !isAsync(d) && this.fn(d);
		return !(d?.getSourceFile().isDeclarationFile && ts.isFunctionLike(d));
	}

	/** Whether reading the signal `e` (`e()`) can throw: one that may be unset, a linked one, or a memo whose function may. */
	private signalReadThrows(e: ts.Expression): boolean {
		if (mayBeUnset(e, this.checker, this.framework()) || this.linkedThrows(e)) return true;
		let sym = this.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(e) ? e.name : e);
		if (sym && sym.flags & ts.SymbolFlags.Alias) sym = this.checker.getAliasedSymbol(sym);
		const holder = sym?.valueDeclaration;
		const init = holder && (ts.isPropertyDeclaration(holder) || ts.isVariableDeclaration(holder)) ? holder.initializer : undefined;
		return this.framework().memoCall(init, this.checker) && !!init.arguments[0] && ts.isFunctionLike(init.arguments[0]) && this.fn(init.arguments[0]);
	}

	/** Whether evaluating `e` (not the functions it creates) can throw. */
	expr(e: ts.Node): boolean {
		let found = false;
		const visit = (n: ts.Node) => {
			if (found || ts.isFunctionLike(n) || ts.isClassLike(n) || this.quiet(n)) return;
			if (this.nodeThrows(n)) {
				found = true;
				return;
			}
			ts.forEachChild(n, visit);
		};
		visit(e);
		return found;
	}

	/** Whether running `nodes` can throw out of them: a `throw`, or what throws outside a `try` that catches and the functions they create. */
	statements(nodes: readonly ts.Node[]): boolean {
		return nodes.some((n) => this.runThrows(n, null));
	}

	/** Whether `n`'s own operation throws, its operands aside (an assignment's conversion, a member read on an untyped value). */
	own(n: ts.Node): boolean {
		return this.nodeThrows(n);
	}

	private bodyThrows(fn: Fn): boolean {
		let found = !!fn.body && this.runThrows(fn.body, fn);
		for (const p of fn.parameters) {
			if (p.initializer && this.runThrows(p.initializer, fn)) found = true;
			// Destructuring an untyped argument reads its members, which throws on undefined and null.
			if ((ts.isObjectBindingPattern(p.name) || ts.isArrayBindingPattern(p.name)) && (this.untyped(p.name) || this.checked(p))) found = true;
		}
		if (ts.isConstructorDeclaration(fn)) {
			for (const m of fn.parent.members) if (ts.isPropertyDeclaration(m) && m.initializer && !isStatic(m) && this.runThrows(m.initializer, fn)) found = true;
			if (ts.isClassDeclaration(fn.parent) && this.framework().hooks.throwsModel?.injectsConstructor?.(fn.parent)) {
				for (const p of fn.parameters) if (this.injects(p)) found = true;
			}
		}
		return found;
	}

	/** Whether running `root` throws out of it; `fn` is the function whose body it is, the one function-like node it enters. */
	private runThrows(root: ts.Node, fn: ts.Node | null): boolean {
		let found = false;
		const visit = (n: ts.Node) => {
			if (found || (n !== fn && (ts.isFunctionLike(n) || ts.isClassLike(n))) || this.quiet(n)) return;
			if (ts.isTryStatement(n) && n.catchClause) {
				// What the try block throws is caught; the catch and finally blocks can still throw.
				visit(n.catchClause.block);
				if (n.finallyBlock) visit(n.finallyBlock);
				return;
			}
			if (ts.isThrowStatement(n) || this.nodeThrows(n)) {
				found = true;
				return;
			}
			ts.forEachChild(n, visit);
		};
		visit(root);
		return found;
	}

	/** The function of the module's memo (`computed(fn)`) an identifier names, as a value. */
	private moduleComputedFn(id: ts.Identifier): ts.SignatureDeclaration | undefined {
		let s = this.checker.getSymbolAtLocation(id);
		if (s && s.flags & ts.SymbolFlags.Alias) s = this.checker.getAliasedSymbol(s);
		const d = s?.valueDeclaration;
		const init = d && ts.isVariableDeclaration(d) && d.name !== id && ts.isSourceFile(d.parent.parent.parent) ? d.initializer : undefined;
		return this.framework().memoCall(init, this.checker) && init.arguments[0] && ts.isFunctionLike(init.arguments[0]) ? init.arguments[0] : undefined;
	}

	private nodeThrows(n: ts.Node): boolean {
		const c = this.checker;
		if (this.checked(n)) return true;
		if (
			convertsUntyped(
				n,
				(x) => conversionThrows(c, x, this.untyped, (y) => this.objectConversionThrows(y)),
				(e) => conversionCall(e, c),
			)
		)
			return true;
		if (this.plain(n)) return false;
		if (this.castThrows(n)) return true;
		// A module's memo (`computed(fn)`) read as a value (`readonly color = ink`) runs fn, as its Swift getter does.
		if (ts.isIdentifier(n) && !(ts.isCallExpression(n.parent) && n.parent.expression === n) && !ts.isImportSpecifier(n.parent) && !ts.isExportSpecifier(n.parent) && !ts.isImportClause(n.parent)) {
			const fn = this.moduleComputedFn(n);
			if (fn) return this.fn(fn);
		}
		// So is a class's computed field read as a value (`this.total`, `alias = ink`): its Swift getter runs it.
		if (ts.isPropertyAccessExpression(n) && !(ts.isCallExpression(n.parent) && n.parent.expression === n) && !(ts.isBinaryExpression(n.parent) && n.parent.left === n && n.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)) {
			const d = c.getSymbolAtLocation(n.name)?.valueDeclaration;
			const init = d && ts.isPropertyDeclaration(d) && ts.isClassLike(d.parent) && !(ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Static) ? d.initializer : undefined;
			const fn = this.framework().memoCall(init, this.checker) && init.arguments[0] && ts.isFunctionLike(init.arguments[0]) ? init.arguments[0] : init && ts.isIdentifier(init) ? this.moduleComputedFn(init) : undefined;
			if (fn) return this.fn(fn);
		}
		// `array.length = n` of an n that may be no valid length is a RangeError.
		if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && isArrayLengthWrite(n.left, n.right, c)) return true;
		// A compound or update assignment to an array's element at a key that may be no index writes it as script does, by key.
		if ((ts.isBinaryExpression(n) || ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && readWrite(n, c)) {
			const t = readWrite(n, c)!.target;
			if (ts.isElementAccessExpression(t) && c.isArrayLikeType(c.getNonNullableType(c.getTypeAtLocation(t.expression))) && !(c.getTypeAtLocation(t.argumentExpression).flags & ts.TypeFlags.NumberLike)) return true;
		}
		// BigInt division, remainder and exponent throw a RangeError (a zero divisor, a negative exponent).
		if (ts.isBinaryExpression(n) && [ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken, ts.SyntaxKind.AsteriskAsteriskToken, ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken, ts.SyntaxKind.AsteriskAsteriskEqualsToken].includes(n.operatorToken.kind) && c.getTypeAtLocation(n.left).flags & ts.TypeFlags.BigIntLike) return true;
		// Iterating a generator or a script's iterator runs its code.
		if ((ts.isSpreadElement(n) || ts.isForOfStatement(n)) && (iterationThrows(c.getTypeAtLocation(n.expression), c) || this.untyped(n.expression))) return true;
		if (ts.isVariableDeclaration(n) && ts.isArrayBindingPattern(n.name) && n.initializer && iterationThrows(c.getTypeAtLocation(n.initializer), c)) return true;
		// A native collection (`indexPathsForVisibleRows`) is iterated as the runtime gives it, running no script.
		const scriptIterable = (a: ts.Expression) => iterationThrows(c.getTypeAtLocation(a), c) && !(c.getTypeAtLocation(a).getSymbol()?.declarations ?? []).some((d) => isNativeDeclaration(d.getSourceFile()));
		if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && n.arguments?.some(scriptIterable)) {
			// A library function iterates what it is given; native code is given the collection itself.
			const file = c.getResolvedSignature(n)?.getDeclaration()?.getSourceFile();
			if (file?.isDeclarationFile && !isNativeDeclaration(file)) return true;
		}
		if (ts.isCallExpression(n) && ts.isElementAccessExpression(n.expression) && iterationThrows(c.getTypeAtLocation(n.expression.expression), c)) return true;
		// A library function iterating an untyped value (`Array.from(x)`, `new Set(x)`) iterates it through the runtime, which throws for what is no iterable.
		if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && n.arguments?.some((a, i) => iterableParameter(c, n, i) && this.untyped(a))) return true;
		// The array overloads of `new Map(x)` and `new Set(x)` resolve for an untyped x, which the runtime still iterates.
		if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && ['Map', 'Set'].includes(n.expression.text) && n.arguments?.[0] && this.untyped(n.arguments[0]) && (c.getSymbolAtLocation(n.expression)?.declarations ?? []).some((d) => isLibFile(d.getSourceFile()))) return true;
		if (ts.isVariableDeclaration(n) && (ts.isObjectBindingPattern(n.name) || ts.isArrayBindingPattern(n.name)) && n.initializer && this.untyped(n.initializer)) return true;
		// Destructuring runs the getters of the members it reads.
		if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer) {
			const t = c.getNonNullableType(c.getTypeAtLocation(n.initializer));
			if (n.name.elements.some((el) => !el.dotDotDotToken && (t.getProperty((el.propertyName ?? el.name).getText())?.declarations ?? []).some((d) => ts.isGetAccessorDeclaration(d) && !!d.body && !this.reported(d, (f) => this.fn(f)) && this.fn(d)))) return true;
		}
		// `new Array(x)` of an untyped x: a length that is no valid one is a RangeError.
		if ((ts.isNewExpression(n) || ts.isCallExpression(n)) && ts.isIdentifier(n.expression) && n.expression.text === 'Array' && n.arguments?.length === 1 && !isArrayLengthLiteral(n.arguments[0]) && (this.untyped(n.arguments[0]) || numberLike(c.getTypeAtLocation(n.arguments[0])))) return true;
		if (ts.isCallExpression(n) || ts.isNewExpression(n)) return this.callThrows(n);
		if (ts.isTaggedTemplateExpression(n)) return !isStringRaw(n.tag, c) && this.tagThrows(n);
		if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
			if (ts.isCallExpression(n.parent) && n.parent.expression === n && objectPrototypeMethod(n, c)) return false;
			// Reading a member of an untyped value throws on undefined and null.
			if (this.untyped(n.expression)) return true;
			if (ts.isPropertyAccessExpression(n) && this.dynamicMember(n)) return true;
			if (ts.isPropertyAccessExpression(n) && !n.questionDotToken && unsafeReceiver(n.expression, c)) return true;
			if (ts.isElementAccessExpression(n) && !n.questionDotToken && unsafeReceiver(n.expression, c)) return true;
			if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && !n.questionDotToken && uncheckedMatch(n.expression, c)) return true;
			if (ts.isPropertyAccessExpression(n) && !n.questionDotToken && c.getTypeAtLocation(n.expression).flags & ts.TypeFlags.Never) return true;
			const sym = c.getSymbolAtLocation(ts.isPropertyAccessExpression(n) ? n.name : n.argumentExpression);
			const runs = (a: ts.Declaration | undefined) => !!a && ts.isAccessor(a) && !!a.body && !this.reported(a, (f) => this.fn(f)) && this.fn(a);
			// A write runs the setter; a compound, logical or update assignment runs the getter first.
			if (isWriteTarget(n)) {
				const set = accessedDeclaration(sym, true);
				if (set && ts.isSetAccessorDeclaration(set) && runs(set)) return true;
				const get = readWrite(n.parent as ts.Expression, c) ? accessedDeclaration(sym) : undefined;
				return !!get && ts.isGetAccessorDeclaration(get) && runs(get);
			}
			const decl = accessedDeclaration(sym);
			if (decl && ts.isGetAccessorDeclaration(decl) && runs(decl)) return true;
		}
		return false;
	}

	private callThrows(call: ts.CallExpression | ts.NewExpression): boolean {
		const c = this.checker;
		if (this.nativeThrows(call)) return true;
		if (ts.isCallExpression(call) && this.signalWriteThrows(call)) return true;
		const resolved = c.getResolvedSignature(call)?.getDeclaration();
		// Native code runs a Swift closure it is given without `throws`: a native method throws only as its Swift import does.
		if (ts.isCallExpression(call) && ((resolved && isNativeDeclaration(resolved.getSourceFile())) || this.nativeEntry(call))) return false;
		// A promise's executor runs inside its constructor, which rejects with what it throws.
		if (ts.isNewExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === 'Promise' && resolved && isLibFile(resolved.getSourceFile())) return false;
		// Object's own methods called on another value are the runtime's, which don't throw, however untyped the constant holding one.
		if (ts.isCallExpression(call) && objectPrototypeMethod(call.expression, c)) return false;
		if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && this.dynamicMember(call.expression)) return true;
		if (c.getTypeAtLocation(call.expression).flags & ts.TypeFlags.Any || (ts.isPropertyAccessExpression(call.expression) && this.untyped(call.expression.expression))) return true;
		// A class held untyped (not the library's or a framework's, which are made directly) is constructed by name (`jsConstruct`), which throws for what is no constructor.
		if (ts.isNewExpression(call) && this.untyped(call.expression) && !(c.getSymbolAtLocation(call.expression)?.declarations ?? []).some((d) => isLibFile(d.getSourceFile()) || isNativeDeclaration(d.getSourceFile()))) return true;
		if (call.expression.kind === ts.SyntaxKind.SuperKeyword) {
			const cls = ts.findAncestor(call, ts.isClassLike);
			const base = cls && this.ancestors(cls)[1];
			return base ? this.initThrows(base) : !!cls && this.baseInitThrows(cls);
		}
		// A call through a variable, parameter, property or getter holding a function: Swift function types throw.
		const callee = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
		let held = c.getSymbolAtLocation(callee);
		if (held && held.flags & ts.SymbolFlags.Alias) held = c.getAliasedSymbol(held);
		const holder = held?.valueDeclaration;
		// Reading or updating a signal its parent may not have set yet (a required input) throws the framework's error.
		if (ts.isCallExpression(call) && !call.arguments.length && mayBeUnset(call.expression, c, this.framework())) return true;
		if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'update' && mayBeUnset(call.expression.expression, c, this.framework())) return true;
		// So does reading or updating a linked signal whose computation threw.
		if (ts.isCallExpression(call) && !call.arguments.length && this.linkedThrows(call.expression)) return true;
		if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'update' && this.linkedThrows(call.expression.expression)) return true;
		// Reading a memo (`computed(fn)`) runs fn.
		const init = holder && (ts.isPropertyDeclaration(holder) || ts.isVariableDeclaration(holder)) ? holder.initializer : undefined;
		if (this.framework().memoCall(init, this.checker) && init.arguments[0] && ts.isFunctionLike(init.arguments[0])) return this.fn(init.arguments[0]);
		const signature = c.getResolvedSignature(call)?.getDeclaration();
		// A library function held (`export const parse = parseFloat`, `const { isArray } = Array`): Swift holds it as a function value, which throws.
		if (ts.isCallExpression(call) && holder && !holder.getSourceFile().isDeclarationFile && ((init && (ts.isIdentifier(init) || ts.isPropertyAccessExpression(init)) && (['parseInt', 'parseFloat'].includes(init.getText()) || !!signature?.getSourceFile().isDeclarationFile)) || (ts.isBindingElement(holder) && !!signature?.getSourceFile().isDeclarationFile))) return true;
		if ((ts.isCallExpression(call) || ts.isNewExpression(call)) && holder && !holder.getSourceFile().isDeclarationFile && !signature?.getSourceFile().isDeclarationFile && (ts.isVariableDeclaration(holder) || ts.isBindingElement(holder) || ts.isParameter(holder) || ts.isPropertyDeclaration(holder) || ts.isPropertySignature(holder) || ts.isPropertyAssignment(holder) || ts.isGetAccessorDeclaration(holder) || ts.isShorthandPropertyAssignment(holder))) return true;
		// A local holding a library function (`const dip = Utils.layout.toDeviceIndependentPixels`), or one a call made (`view.dispose.bind(view)`): a Swift function value, which throws.
		if (ts.isCallExpression(call) && holder && ts.isVariableDeclaration(holder) && !holder.getSourceFile().isDeclarationFile && holder.initializer && (ts.isPropertyAccessExpression(skipParens(holder.initializer)) || ts.isCallExpression(skipParens(holder.initializer)))) return true;
		const decl = c.getResolvedSignature(call)?.getDeclaration();
		const args = call.arguments ?? ts.factory.createNodeArray();
		// A callback the callee runs: a closure literal throws if its body does; any other function value is assumed to.
		const callbackThrows = () =>
			args.some((a, k) => {
				// Only a parameter of a function type is called: `set.delete(f)` takes a function as a value.
				const param = decl && !ts.isJSDocSignature(decl) ? decl.parameters[Math.min(k, decl.parameters.length - 1)] : undefined;
				if (param?.type && !takesFunction(param.type, c)) return false;
				const arg = skipParens(a);
				if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) return !isAsync(arg) && this.fn(arg);
				// A function declaration an array method is given by name (`list.sort(compare)`) is passed as it is, throwing as its body does.
				let named = ts.isIdentifier(arg) ? c.getSymbolAtLocation(arg) : undefined;
				if (named && named.flags & ts.SymbolFlags.Alias) named = c.getAliasedSymbol(named);
				// A library function passed by name (`parts.map(parseFloat)`) throws only where the library's does.
				if (named?.declarations?.length && named.declarations.every((d) => isLibFile(d.getSourceFile()))) return THROWING_BUILTINS.has(named.name);
				const fnDecl = named?.valueDeclaration;
				if (fnDecl && ts.isFunctionDeclaration(fnDecl) && fnDecl.body && !isAsync(fnDecl) && !fnDecl.asteriskToken && decl && builtinName(decl)?.startsWith('Array.')) return this.fn(fnDecl);
				// A function value that may be undefined is passed as Swift holds it, optional, to a `rethrows` overload taking one; a
				// variable narrowed to undefined is still held as its declared type.
				const held = named?.valueDeclaration && ts.isVariableDeclaration(named.valueDeclaration) ? c.getTypeOfSymbol(named) : c.getTypeAtLocation(arg);
				return c.getNonNullableType(held).getCallSignatures().length > 0 || (!!param?.type && takesFunction(param.type, c) && this.untyped(arg));
			});
		if (ts.isIdentifier(call.expression) && call.expression.text === 'RegExp') return true;
		// A buffer or a view of an invalid length is a RangeError.
		if (ts.isNewExpression(call) && ts.isIdentifier(call.expression) && BUFFER_TYPES.has(call.expression.text) && c.getSymbolAtLocation(call.expression)?.declarations?.every((d) => d.getSourceFile().isDeclarationFile)) return true;
		// `new Worker(...)` and `new URL(...)` throw when the script is absent/already running or the URL is invalid.
		if (ts.isNewExpression(call) && ts.isIdentifier(call.expression) && (call.expression.text === 'Worker' || call.expression.text === 'URL') && c.getSymbolAtLocation(call.expression)?.declarations?.every((d) => d.getSourceFile().isDeclarationFile)) return true;
		// A weak reference to an untyped value refuses a primitive.
		if (ts.isNewExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === 'WeakRef' && args[0] && this.untyped(args[0])) return true;
		// Intl's constructors reject options out of range; BigInt() a value with no integer.
		if (intlConstructor(call.expression, c)) return true;
		if (ts.isIdentifier(call.expression) && call.expression.text === 'BigInt' && c.getSymbolAtLocation(call.expression)?.declarations?.every((d) => d.getSourceFile().isDeclarationFile)) return true;
		// A weak collection made from entries rejects a primitive key.
		if (ts.isNewExpression(call) && args.length && ts.isIdentifier(call.expression) && ['WeakMap', 'WeakSet'].includes(call.expression.text)) return true;
		// A program class constructed by the constructor it inherits from a declared one (`class TestClass extends ViewBase`): its own initializer.
		if (ts.isNewExpression(call) && decl && ts.isConstructorDeclaration(decl) && decl.getSourceFile().isDeclarationFile && this.implicitConstructorThrows(call)) return true;
		if (!decl || ts.isJSDocSignature(decl)) {
			if (ts.isNewExpression(call)) return this.implicitConstructorThrows(call);
			return true;
		}
		const file = decl.getSourceFile();
		const injected = file.fileName.startsWith('/__shims__/') ? this.framework().hooks.throwsModel?.injectCall?.(decl, args, this) : undefined;
		if (injected !== undefined) return injected;
		// An overload signature: the implementation runs.
		if (!file.isDeclarationFile && !(decl as Fn).body && (ts.isConstructorDeclaration(decl) || ts.isMethodDeclaration(decl) || ts.isFunctionDeclaration(decl))) {
			const impl = ts.isConstructorDeclaration(decl) ? decl.parent.members.find((m) => ts.isConstructorDeclaration(m) && !!m.body) : ((ts.isMethodDeclaration(decl) ? (decl.parent as ts.ClassLikeDeclaration).members : (decl.parent as ts.SourceFile).statements) as ts.NodeArray<ts.Node>).find((m) => (ts.isMethodDeclaration(m) || ts.isFunctionDeclaration(m)) && !!m.body && m.name?.getText() === decl.name?.getText());
			if (impl) return this.fn(impl);
		}
		// A value the program holds, of a function type a declaration file names (`callback: ControlStateChangeListenerCallback`): a Swift function type, which throws.
		if (file.isDeclarationFile && ts.isFunctionTypeNode(decl) && holder && !holder.getSourceFile().isDeclarationFile && !/[\\/]lib\.[\w.]*\.d\.ts$/.test(file.fileName)) return true;
		// A shim that runs the callback it is given at once rethrows, as its Swift counterpart is declared.
		if (file.fileName.startsWith('/__shims__/') && this.runsCallbackNow(decl)) return callbackThrows();
		const compiled = file.isDeclarationFile ? this.implementation(decl) : null;
		if (compiled) return (compiled as Fn).body ? this.fn(compiled) : false;
		if (file.isDeclarationFile) {
			const owner = builtinName(decl);
			// `s.match(x)` makes a RegExp of anything else, which can be a SyntaxError.
			if (owner === 'String.match' || owner === 'String.search') return !args[0] || c.getTypeAtLocation(args[0]).getSymbol()?.name !== 'RegExp';
			// The kit calls a replacement known only when it runs by script.
			if (owner === 'String.replace' && ts.isCallExpression(call) && boxedReplacement('replace', call, c)) return true;
			// `f.call(…)` and `f.apply(…)` run f, whose Swift function type throws.
			if (owner && /^(Callable|Newable)?Function\.(call|apply)$/.test(owner)) return true;
			// Digits or a radix out of range is a RangeError: only a literal in range is known not to throw.
			if (owner === 'Number.toFixed') return !!args[0] && digitsLiteral(args[0], 0, 100, 0) === null;
			if (owner === 'Number.toPrecision') return !!args[0] && digitsLiteral(args[0], 1, 100, null) === null;
			if (owner === 'Number.toString') return !!args[0] && digitsLiteral(args[0], 2, 36, null) === null;
			if (owner && THROWING_BUILTINS.has(owner)) return /\.reduce(Right)?$/.test(owner) ? args.length < 2 || callbackThrows() : true;
			// A timer runs its callback later, reporting what it throws.
			if (owner && TIMERS.has(owner)) return false;
			// `Promise.withResolvers()`'s functions are values the program holds, of Swift function types, which throw.
			if (ts.isFunctionTypeNode(decl) && ts.isPropertySignature(decl.parent) && ts.isInterfaceDeclaration(decl.parent.parent) && decl.parent.parent.name.text === 'PromiseWithResolvers') return true;
			// The library runs callbacks synchronously (map, forEach, sort, find): it rethrows. A promise's callbacks reject instead.
			if (/[\\/]lib\.[\w.]*\.d\.ts$/.test(file.fileName) && !/^Promise/.test(owner ?? '')) return callbackThrows();
			return false;
		}
		// A function value (an arrow stored in a variable or an object) has a Swift function type, which throws.
		if ((ts.isArrowFunction(decl) || ts.isFunctionExpression(decl)) && skipParens(call.expression) !== decl) return true;
		if (ts.isMethodDeclaration(decl) && ts.isObjectLiteralExpression(decl.parent)) return true;
		// A class's method reached as a value (`handlers[0](x)`) is a Swift function value, which throws.
		const reached = skipParens(call.expression);
		if (ts.isMethodDeclaration(decl) && ts.isClassLike(decl.parent) && !ts.isPropertyAccessExpression(reached) && !(ts.isElementAccessExpression(reached) && ts.isStringLiteralLike(reached.argumentExpression)) && reached.kind !== ts.SyntaxKind.SuperKeyword) return true;
		if ((decl as Fn).body) return this.fn(decl);
		// An abstract method throws as an override of it does.
		if (ts.isMethodDeclaration(decl) && ts.isClassLike(decl.parent) && ts.getModifiers(decl)?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword)) return this.fn(decl);
		// A signature without a body (an interface method, a function-typed member) is a function type.
		return !ts.isConstructorDeclaration(decl) && !ts.isClassLike(decl);
	}

	/** Whether injecting a constructor parameter (the framework's service) can throw. */
	injects(p: ts.ParameterDeclaration): boolean {
		return !!this.framework().hooks.throwsModel?.injects?.(p, this);
	}

	/** Whether a shim's function or method runs its callback at once, so that it throws what the callback throws. */
	private runsCallbackNow(decl: ts.Declaration): boolean {
		const name = (decl as ts.NamedDeclaration).name?.getText();
		if (ts.isFunctionDeclaration(decl)) return !!name && this.framework().rethrowing(name);
		const owner = decl.parent;
		if (!(ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl)) || !(ts.isClassDeclaration(owner) || ts.isInterfaceDeclaration(owner)) || !owner.name) return false;
		return this.framework().rethrowing(name!, owner.name.text);
	}

	/** A tag is called as a function: through a function value it throws, else as its declaration does. */
	private tagThrows(e: ts.TaggedTemplateExpression): boolean {
		if (this.checker.getTypeAtLocation(e.tag).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
		const decl = this.checker.getResolvedSignature(e)?.getDeclaration();
		if (!decl || ts.isJSDocSignature(decl) || decl.getSourceFile().isDeclarationFile) return !!decl && !decl.getSourceFile().isDeclarationFile;
		if ((decl as Fn).body && !ts.isArrowFunction(decl) && !ts.isFunctionExpression(decl)) return this.fn(decl);
		return true;
	}

	private implicitConstructorThrows(call: ts.NewExpression): boolean {
		const decl = this.checker.getTypeAtLocation(call.expression).getSymbol()?.valueDeclaration;
		if (!decl || !ts.isClassLike(decl) || decl.getSourceFile().isDeclarationFile) return false;
		return this.initThrows(decl);
	}

	/** Whether the initializer a program class's native or kit base gives it without arguments throws (`super()` of a core view). */
	private baseInitThrows: (cls: ts.ClassLikeDeclaration) => boolean;

	/** Whether making an instance of a class throws: its own constructor's or its base's, or (Swift initializers sharing `throws`) one a subclass declares. */
	initThrows(decl: ts.ClassLikeDeclaration): boolean {
		const chain = this.ancestors(decl);
		for (const cls of chain) {
			if (cls.members.some((m) => ts.isPropertyDeclaration(m) && !!m.initializer && !isStatic(m) && this.expr(m.initializer))) return true;
			const ctor = cls.members.find(ts.isConstructorDeclaration);
			if (ctor) return this.fn(ctor);
		}
		if (this.baseInitThrows(chain.at(-1)!)) return true;
		// An inherited initializer throws if any constructor of the hierarchy it comes from does.
		const root = this.ancestors(decl).at(-1)!;
		return [root, ...this.descendants(root)].some((d) => {
			const ctor = d.members.find(ts.isConstructorDeclaration);
			return !!ctor && this.throwing.has(ctor);
		});
	}

	/** The class and the app classes it extends, nearest first. */
	private ancestors(cls: ts.ClassLikeDeclaration): ts.ClassLikeDeclaration[] {
		const out: ts.ClassLikeDeclaration[] = [];
		for (let c: ts.ClassLikeDeclaration | undefined = cls; c;) {
			out.push(c);
			const base: ts.ExpressionWithTypeArguments | undefined = c.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
			const decl: ts.Declaration | undefined = base && this.checker.getTypeAtLocation(base.expression).getSymbol()?.valueDeclaration;
			c = decl && ts.isClassLike(decl) && !decl.getSourceFile().isDeclarationFile ? decl : undefined;
		}
		return out;
	}

	/** The program's classes that extend `cls`, directly or further, in source order. */
	private descendants(cls: ts.ClassLikeDeclaration): ts.ClassLikeDeclaration[] {
		if (!this.classAt) this.indexSubclasses();
		const i = this.classAt!.get(cls);
		return i === undefined ? [] : this.subclasses.slice(this.subclassStart[i], this.subclassStart[i + 1]);
	}

	private indexSubclasses(): void {
		const at = new Map<ts.ClassLikeDeclaration, number>();
		const chains = this.classes.map((c) => this.ancestors(c));
		for (const chain of chains) for (const a of chain) if (!at.has(a)) at.set(a, at.size);
		const start = new Int32Array(at.size + 1);
		for (const chain of chains) for (let k = 1; k < chain.length; k++) start[at.get(chain[k])! + 1]++;
		for (let i = 0; i < at.size; i++) start[i + 1] += start[i];
		const next = start.slice(0, at.size);
		const out = new Array<ts.ClassLikeDeclaration>(start[at.size]);
		chains.forEach((chain, j) => {
			for (let k = 1; k < chain.length; k++) out[next[at.get(chain[k])!]++] = this.classes[j];
		});
		this.classAt = at;
		this.subclassStart = start;
		this.subclasses = out;
	}
}

/** A class's or object literal's own toString, valueOf or [Symbol.toPrimitive] method (or a field holding a function), which ToPrimitive runs. */
function conversionMethod(m: ts.Node): Fn | undefined {
	const name = (m as ts.NamedDeclaration).name;
	if (!name || isStatic(m)) return undefined;
	const named = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text === 'toString' || name.text === 'valueOf' : ts.isComputedPropertyName(name) && ts.isPropertyAccessExpression(name.expression) && ts.isIdentifier(name.expression.expression) && name.expression.expression.text === 'Symbol' && name.expression.name.text === 'toPrimitive';
	if (!named) return undefined;
	if (ts.isMethodDeclaration(m)) return m.body ? m : undefined;
	const init = (ts.isPropertyDeclaration(m) || ts.isPropertyAssignment(m)) && m.initializer ? ts.skipOuterExpressions(m.initializer) : undefined;
	return init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : undefined;
}

export function isAsync(fn: ts.Node): boolean {
	return ts.canHaveModifiers(fn) && !!ts.getModifiers(fn)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
}

export function isStatic(m: ts.Node): boolean {
	return ts.canHaveModifiers(m) && !!ts.getModifiers(m)?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword);
}

/**
 * A getter its class declares without a setter over a program base's accessor that has one: the instance's property is
 * this class's, whose setter is undefined, so writing it is a TypeError (class code is strict).
 */
export function getterOnlyOverride(get: ts.GetAccessorDeclaration, checker: ts.TypeChecker): boolean {
	const cls = get.parent;
	if (!ts.isClassLike(cls) || !get.body || isStatic(get)) return false;
	const name = get.name.getText();
	if (cls.members.some((m) => ts.isSetAccessorDeclaration(m) && m.name.getText() === name)) return false;
	for (let b = sourceBase(cls, checker); b; b = sourceBase(b, checker)) {
		const own = b.members.filter((m) => !isStatic(m) && m.name?.getText() === name);
		if (own.some((m) => ts.isSetAccessorDeclaration(m) && !!m.body)) return true;
		if (own.some((m) => !ts.isGetAccessorDeclaration(m))) return false;
	}
	return false;
}

function sourceBase(cls: ts.ClassLikeDeclaration, checker: ts.TypeChecker): ts.ClassLikeDeclaration | undefined {
	const h = cls.heritageClauses?.find((x) => x.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
	const d = h && checker.getTypeAtLocation(h.expression).getSymbol()?.valueDeclaration;
	return d && ts.isClassLike(d) && !d.getSourceFile().isDeclarationFile ? d : undefined;
}

/** A digits or radix argument that is an integer literal in `min…max` (`toFixed(2)`), which cannot throw; `absent` where there is none. */
export function digitsLiteral(e: ts.Expression | undefined, min: number, max: number, absent: number | null): number | null {
	if (!e) return absent;
	if (!ts.isNumericLiteral(e)) return null;
	const n = Number(e.text);
	return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/** `array.length = n` where n is not a literal valid length. */
export function isArrayLengthWrite(left: ts.Expression, right: ts.Expression, c: ts.TypeChecker): left is ts.PropertyAccessExpression {
	if (!ts.isPropertyAccessExpression(left) || left.name.text !== 'length' || isArrayLengthLiteral(right)) return false;
	const t = c.getNonNullableType(c.getTypeAtLocation(left.expression));
	return c.isArrayType(t);
}

/** A number, or a union of numbers (`2 | 3` from `cond ? 2 : 3`). */
function numberLike(t: ts.Type): boolean {
	return t.isUnion() ? t.types.every(numberLike) : !!(t.flags & ts.TypeFlags.NumberLike);
}

/** A literal that is a valid array length (`new Array(3)`), which cannot throw. */
export function isArrayLengthLiteral(e: ts.Expression): boolean {
	if (!ts.isNumericLiteral(e)) return false;
	const n = Number(e.text);
	return Number.isInteger(n) && n >= 0 && n <= 4294967295;
}

/** The library's functions that run a callback later, never inside the call. */
const TIMERS = new Set(['setTimeout', 'setInterval', 'queueMicrotask', 'requestAnimationFrame', 'setImmediate']);

const isLibFile = (f: ts.SourceFile) => /[\\/]lib\.[\w.]*\.d\.ts$/.test(f.fileName);

/** An Objective-C framework's declarations (`objc!UIKit.d.ts`). */
export const isNativeDeclaration = (f: ts.SourceFile) => /[\\/]objc![^\\/]*\.d\.ts$/.test(f.fileName);

/** Whether a parameter's declared type can be a function the library calls. */
function takesFunction(t: ts.TypeNode, c: ts.TypeChecker): boolean {
	if (ts.isParenthesizedTypeNode(t)) return takesFunction(t.type, c);
	if (ts.isUnionTypeNode(t)) return t.types.some((u) => takesFunction(u, c));
	// A value of the collection's element type (`set.delete(value: T)`) is stored or compared, never called.
	if (ts.isTypeReferenceNode(t) && (c.getSymbolAtLocation(t.typeName)?.flags ?? 0) & ts.SymbolFlags.TypeParameter) return false;
	if (ts.isFunctionTypeNode(t) || ts.isConstructorTypeNode(t) || ts.isTypeLiteralNode(t)) return true;
	// A named type may be a function's (`CallableFunction`, a type parameter for one): not a primitive, array or keyword.
	return ts.isTypeReferenceNode(t) && !/^(ReadonlyArray|Array|Promise|PromiseLike|Map|Set|RegExp|Date|ArrayLike|Iterable)$/.test(t.typeName.getText());
}

function skipParens(e: ts.Expression): ts.Expression {
	while (ts.isParenthesizedExpression(e)) e = e.expression;
	return e;
}

/** `Array.reduce` for the lib's `reduce` in `interface Array<T>`. */
function builtinName(decl: ts.Declaration): string | null {
	const owner = decl.parent;
	const name = (decl as ts.NamedDeclaration).name?.getText();
	if (!name) return null;
	if (ts.isInterfaceDeclaration(owner)) return `${owner.name.text.replace(/^ReadonlyArray$/, 'Array').replace(/Constructor$/, '')}.${name}`;
	return name;
}

/**
 * Whether `callee` is `<m>.call` or `<m>.apply` for `Object.prototype.hasOwnProperty`, `propertyIsEnumerable` or
 * `toString`, directly or through a constant holding it (`const HAS_OWN = Object.prototype.hasOwnProperty`).
 */
function objectPrototypeMethod(callee: ts.Expression, c: ts.TypeChecker): boolean {
	if (!ts.isPropertyAccessExpression(callee) || !['call', 'apply'].includes(callee.name.text)) return false;
	let target: ts.Expression = callee.expression;
	for (let hops = 0; ts.isIdentifier(target) && hops < 4; hops++) {
		const d = c.getSymbolAtLocation(target)?.valueDeclaration;
		if (!d || !ts.isVariableDeclaration(d) || !d.initializer || !(d.parent.flags & ts.NodeFlags.Const)) return false;
		target = d.initializer;
	}
	return ts.isPropertyAccessExpression(target) && ['hasOwnProperty', 'propertyIsEnumerable', 'toString'].includes(target.name.text) && ts.isPropertyAccessExpression(target.expression) && target.expression.name.text === 'prototype' && ts.isIdentifier(target.expression.expression) && target.expression.expression.text === 'Object';
}

/** Whether the library parameter a call's argument `i` goes to takes an iterable (`Iterable<T> | ArrayLike<T>`). */
function iterableParameter(c: ts.TypeChecker, call: ts.CallExpression | ts.NewExpression, i: number): boolean {
	const sig = c.getResolvedSignature(call);
	const decl = sig?.getDeclaration();
	if (!sig || !decl || ts.isJSDocSignature(decl) || !decl.getSourceFile().isDeclarationFile || isNativeDeclaration(decl.getSourceFile())) return false;
	const p = sig.getParameters()[Math.min(i, sig.getParameters().length - 1)];
	if (!p) return false;
	const t = c.getTypeOfSymbolAtLocation(p, call);
	return (t.isUnion() ? t.types : [t]).some((u) => ['Iterable', 'ArrayLike', 'IterableIterator'].includes((u.aliasSymbol ?? u.getSymbol())?.getName() ?? ''));
}
