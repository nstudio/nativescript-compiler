// Parameters as Swift: their types, defaults and the prelude a function body starts with.
import ts from 'typescript';
import { assignsTo, ident, isFunctionType, isOptional, nullishType, optionalType, swiftString, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { boundNames, hasModifier } from '../semantics/ast.ts';
import { isConstant } from '../semantics/lang.ts';
import { isUntyped, spelledType } from '../semantics/types.ts';

export const parametersMethods = {
	/** A parameter's Swift type as `params` declares it (an unwrapped optional written as optional, as a function type has it). */
	paramType(this: Translator, p: ts.ParameterDeclaration): string {
		const t = this.typeOf(p.name);
		if (this.states.nullishHeld(p)) return nullishType(t);
		if (p.questionToken || (p.initializer && !this.templateParams)) return this.constantDefault(p) && !this.states.defaultPassesNull(p) ? t : optionalType(t);
		return this.states.mayBeNull(p) ? optionalType(t) : t;
	},

	/**
	 * Strict code's parameter its group's form widens (`widened`): spelled optional, as the function type, protocol
	 * requirement or base method it shares a form with spells it (an implicitly unwrapped one witnesses no `T?`), and
	 * rebound implicitly unwrapped in the body (`paramPrelude`), which reads it as other such parameters are read.
	 */
	optionalWidened(this: Translator, p: ts.ParameterDeclaration): boolean {
		// A template method's loop item, whose default only types it, shares no signature: held implicitly unwrapped.
		if (p.initializer && this.templateParams) return false;
		return !this.lenient && !p.questionToken && ts.isIdentifier(p.name) && this.states.widened(p) && !this.states.nullishHeld(p) && !isOptional(this.typeOf(p.name)) && !this.isAny(p.name);
	},

	params(this: Translator, fn: ts.SignatureDeclaration, closure: boolean): string {
		const receiver = this.implicitThis(fn) ? [`${closure ? '' : '_ '}${ident('this')}: Any?`] : [];
		if (this.readsArguments(fn)) {
			const explicitThis = !closure ? fn.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === 'this' && p.type?.kind !== ts.SyntaxKind.VoidKeyword) : undefined;
			const selfParam = receiver.length ? receiver : explicitThis ? [`_ ${ident('this')}: ${this.typeOf(explicitThis.name)}`] : [];
			return [...selfParam, `${closure ? '' : '_ '}__arguments: JSArray<Any?>`].join(', ');
		}
		// `this: void` only says the function reads no `this`: no parameter.
		return [
			...receiver,
			...fn.parameters
				.filter((p) => !(ts.isIdentifier(p.name) && p.name.text === 'this' && (closure || p.type?.kind === ts.SyntaxKind.VoidKeyword)))
				.map((p, k) => {
					const name = ts.isIdentifier(p.name) ? ident(p.name.text) : `__p${k}`;
					if (p.dotDotDotToken) return `${closure ? '' : '_ '}${name}: ${this.typeOf(p.name)}`;
					let t = this.typeOf(p.name);
					// An object element's parameter stays as `mayBeNull` spells it (implicitly unwrapped, which takes the optional).
					if (closure && ts.isIdentifier(p.name) && !p.questionToken && ['Double', 'String', 'Bool'].includes(t) && this.states.optionalBinding(p.name)) return `${name}: ${this.bindsOptional(p.name, t)}`;
					if (this.states.nullishHeld(p)) return closure ? `${name}: ${nullishType(t)}` : `_ ${name}: ${nullishType(t)}${p.questionToken || p.initializer ? ' = nil' : ''}`;
					// `accessory: UITabAccessory | null`, checked without strictNullChecks: null still passes; the body reads it unwrapped.
					if (!closure && this.optionalWidened(p)) t = optionalType(t);
					else if (this.states.mayBeNull(p)) t = this.lenient ? optionalType(t) : `${t}!`;
					let given = '';
					if (p.questionToken || (p.initializer && !this.templateParams)) {
						if (!closure && this.constantDefault(p)) given = ` = ${this.storedInit(p.initializer!, t, false, p)}`;
						else {
							t = optionalType(t);
							if (!closure) given = ' = nil';
						}
					}
					if (isFunctionType(t)) t = '@escaping ' + t;
					if (!closure && this.opaqueArrayParam(p)) t = t.replace(/^JSArray<\w+>/, `JSArray<some ${this.opaqueArrayParam(p)}>`);
					return closure ? `${name}: ${t}` : `_ ${name}: ${t}${given}`;
				}),
		].join(', ');
	},

	/**
	 * The class of a module function's `C[]` parameter (`C` a program class) when the body only reads the array's
	 * elements and the function is only ever called: Swift takes it as `JSArray<some C>`, so an array of a subclass
	 * is passed as itself, not a copy (Swift's generic classes are invariant). Reads that give back an array of the
	 * element type or take an element (`filter`, `indexOf`) are left out: they would name the opaque type.
	 */
	opaqueArrayParam(this: Translator, p: ts.ParameterDeclaration): string | null {
		let found = this.opaqueArrays.get(p);
		if (found !== undefined) return found;
		found = null;
		const fn = p.parent;
		const el = p.type && ts.isArrayTypeNode(p.type) ? p.type.elementType : null;
		const cls = el && ts.isTypeReferenceNode(el) && !el.typeArguments ? this.checker.getTypeFromTypeNode(el).getSymbol()?.declarations?.find(ts.isClassDeclaration) : undefined;
		const name = /^JSArray<(\w+)>$/.exec(this.typeOf(p.name))?.[1];
		if (!this.library && ts.isFunctionDeclaration(fn) && fn.body && fn.name && !fn.typeParameters?.length && !hasModifier(fn, ts.SyntaxKind.ExportKeyword) && !hasModifier(fn, ts.SyntaxKind.DefaultKeyword) && ts.isIdentifier(p.name) && !p.questionToken && !p.initializer && !p.dotDotDotToken && cls && !cls.getSourceFile().isDeclarationFile && name && this.classNamed(name) === cls && !this.states.nullishHeld(p) && !this.states.widened(p)) {
			const param = this.checker.getSymbolAtLocation(p.name),
				self = this.checker.getSymbolAtLocation(fn.name);
			const reads = new Set(['length', 'forEach', 'map', 'some', 'every', 'find', 'findIndex']);
			let ok = true;
			const K = ts.SyntaxKind;
			const written = (n: ts.Node): boolean => (ts.isBinaryExpression(n.parent) && n.parent.left === n && n.parent.operatorToken.kind >= K.FirstAssignment && n.parent.operatorToken.kind <= K.LastAssignment) || ((ts.isPrefixUnaryExpression(n.parent) || ts.isPostfixUnaryExpression(n.parent)) && (n.parent.operator === K.PlusPlusToken || n.parent.operator === K.MinusMinusToken)) || ts.isDeleteExpression(n.parent);
			const read = (id: ts.Identifier): boolean => {
				const at = id.parent;
				if (ts.isForOfStatement(at) && at.expression === id) return true;
				if (ts.isBinaryExpression(at) && [K.EqualsEqualsEqualsToken, K.ExclamationEqualsEqualsToken].includes(at.operatorToken.kind)) return true;
				if (ts.isElementAccessExpression(at) && at.expression === id) return !written(at);
				if (!ts.isPropertyAccessExpression(at) || at.expression !== id || !reads.has(at.name.text)) return false;
				return at.name.text === 'length' ? !written(at) : ts.isCallExpression(at.parent) && at.parent.expression === at;
			};
			const visit = (n: ts.Node): void => {
				if (!ok) return;
				if (ts.isIdentifier(n) && n !== p.name && n !== fn.name) {
					const sym = this.checker.getSymbolAtLocation(n);
					if (sym === param && !read(n)) ok = false;
					// Swift infers the opaque element from each argument: an array of the class or a subclass, never nil.
					if (sym === self && !(ts.isCallExpression(n.parent) && n.parent.expression === n && this.subclassArray(n.parent.arguments[fn.parameters.indexOf(p)], name))) ok = false;
				}
				ts.forEachChild(n, visit);
			};
			visit(fn.getSourceFile());
			if (ok) found = name;
		}
		this.opaqueArrays.set(p, found);
		return found;
	},
	subclassArray(this: Translator, a: ts.Expression | undefined, cls: string): boolean {
		const given = a && !ts.isSpreadElement(a) ? /^JSArray<(\w+)>$/.exec(this.typeOf(a))?.[1] : undefined;
		return !!given && (given === cls || this.isSubclassOf(given, cls));
	},

	/**
	 * A parameter Swift gives its default value itself: a constant, unless the method it overrides takes the parameter as optional.
	 * An untyped one is given its default in the body, where an explicit undefined (nil) takes it too and null does not.
	 */
	constantDefault(this: Translator, p: ts.ParameterDeclaration): boolean {
		return !!p.initializer && isConstant(p.initializer) && !this.optionalDefaults.has(p) && !this.familyDefaultsDiffer(p) && !this.isAny(p.name) && !this.states.defaultTakesUndefined(p);
	},

	/** An app parameter whose default its body applies (`paramPrelude`): an argument is given as the optional it may be. */
	filledDefault(this: Translator, d: ts.Declaration | undefined): boolean {
		return !this.library && !!d && ts.isParameter(d) && !!d.initializer && !d.dotDotDotToken && !this.templateParams && !d.getSourceFile().isDeclarationFile && !this.constantDefault(d);
	},

	/** Statements a function body starts with: rest arrays, computed defaults, destructured parameters. */
	paramPrelude(this: Translator, fn: ts.SignatureDeclaration): string[] {
		const i = this.indent;
		const lines: string[] = [];
		// A default's or a destructuring's lines name the parameter's source line, as either can throw.
		const marked = new Set<ts.ParameterDeclaration>();
		const push = (p: ts.ParameterDeclaration, line: string) => {
			const mark = line && (p.initializer || !ts.isIdentifier(p.name)) && !marked.has(p) ? (this.lines?.markLine(p) ?? '') : '';
			if (mark) marked.add(p);
			lines.push(mark + line);
		};
		if (this.readsArguments(fn)) {
			// The parameters read from the arguments the call passed, undefined where it passed none.
			fn.parameters
				.filter((p) => !(ts.isIdentifier(p.name) && p.name.text === 'this'))
				.forEach((p, k) => {
					if (!ts.isIdentifier(p.name)) throw this.error(p, 'a destructured parameter of a function reading `arguments`');
					const name = ident(p.name.text);
					const assigned = 'body' in fn && !!fn.body && this.needsVar(p.name, this.typeOf(p.name));
					const arg = `${RT.jsArg}(__arguments.storage, ${k})`;
					const pt = this.typeOf(p.name);
					let value: string;
					if (p.dotDotDotToken) value = `JSArray(__arguments.storage.dropFirst(${k}).map { ${this.fromAnyCode('$0', pt.replace(/^JSArray<(.*)>$/, '$1'), true)} })`;
					else if (p.initializer) value = `(${RT.jsFlat}(${arg}) == nil ? ${this.stored(p.initializer, p, pt)} : ${this.fromAnyCode(arg, pt, true)})`;
					else value = this.fromAnyCode(arg, p.questionToken ? optionalType(pt) : pt, true);
					push(p, `${i}${assigned ? 'var' : 'let'} ${name}: ${p.questionToken && !p.initializer ? optionalType(pt) : pt} = ${value}`);
				});
			return lines;
		}
		fn.parameters.forEach((p, k) => {
			const name = ts.isIdentifier(p.name) ? ident(p.name.text) : `__p${k}`;
			// A parameter the body assigns is a variable of its own (Swift parameters are constants).
			const assigned = ts.isIdentifier(p.name) && 'body' in fn && !!fn.body && this.needsVar(p.name, this.typeOf(p.name));
			const pt = this.typeOf(p.name);
			const untyped = !!p.initializer && (this.isAny(p.initializer) || ((ts.isElementAccessExpression(p.initializer) || ts.isPropertyAccessExpression(p.initializer)) && this.isAny(p.initializer.expression)));
			if (p.initializer && !this.templateParams && this.states.nullishHeld(p)) {
				// Only undefined takes the default: null stays.
				const nt = nullishType(pt);
				push(p, `${i}${assigned ? 'var' : 'let'} ${name}: ${nt} = ${name}.jsAny == nil ? ${nt}(${this.tryPrefix(p.initializer)}${this.stored(p.initializer, p, nt.slice('JSNullish<'.length, -1))}) : ${name}`);
			} else if (p.initializer && !this.templateParams && untyped && !isUntyped(spelledType(pt)) && !pt.endsWith('?') && ts.isIdentifier(p.name)) {
				// A default read from an untyped value (`mode = this.modes[side]`) may be undefined: the parameter is optional where Swift reads it.
				const sym = this.checker.getSymbolAtLocation(p.name);
				if (sym) this.undefinedVars.set(sym, optionalType(pt));
				const read = this.isAny(p.initializer) ? this.expr(p.initializer) : ts.isElementAccessExpression(p.initializer) ? `${RT.jsGet}(${this.expr(p.initializer.expression)}, ${this.propertyKey(p.initializer.argumentExpression)})` : `${RT.jsGet}(${this.expr((p.initializer as ts.PropertyAccessExpression).expression)}, ${swiftString((p.initializer as ts.PropertyAccessExpression).name.text)})`;
				push(p, `${i}${assigned ? 'var' : 'let'} ${name}: ${optionalType(pt)} = ${this.tryPrefix(p.initializer)}${name} ?? ${this.fromAny(read, optionalType(pt))}`);
			} else if (p.initializer && !this.templateParams && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || !this.constantDefault(p))) {
				push(p, `${i}${assigned ? 'var' : 'let'} ${name}: ${this.typeOf(p.name)} = ${this.tryPrefix(p.initializer)}${name} ?? ${this.stored(p.initializer, p, this.typeOf(p.name))}`);
			} else if (!p.initializer && this.optionalWidened(p) && !ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) push(p, `${i}${assigned ? 'var' : 'let'} ${name}: ${pt}! = ${name}`);
			else if (assigned) push(p, this.states.mayBeNull(p) ? `${i}var ${name}: ${this.lenient ? optionalType(pt) : `${pt}!`} = ${name}` : `${i}var ${name} = ${name}`);
			if (this.states.destructuresEmpty(p)) {
				const first = ts.isObjectBindingPattern(p.name) ? p.name.elements[0] : undefined;
				const key = first && !first.dotDotDotToken ? (first.propertyName ?? first.name) : undefined;
				const keyText = key && (ts.isIdentifier(key) || ts.isStringLiteral(key)) ? swiftString(key.text) : null;
				push(p, `${i}let ${name} = try ${ts.isArrayBindingPattern(p.name) || keyText ? `${RT.jsDestructured}(${name}, ${keyText ?? 'nil'})` : `${RT.jsObjectRequired}(${name})`}`);
			}
			// A destructured parameter the body assigns binds variables.
			if (!ts.isIdentifier(p.name)) push(p, this.bindTo(p.name, name, '', 'body' in fn && !!fn.body && boundNames(p.name).some((b) => assignsTo(fn.body!, this.checker.getSymbolAtLocation(b), this.checker))));
		});
		return lines;
	},
};
