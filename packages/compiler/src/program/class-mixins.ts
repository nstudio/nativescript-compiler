import ts from 'typescript';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { NATIVE_CONTROLLERS, NATIVE_VIEWS } from './core-facts.ts';

/** `@nativescript/core` view classes that `getViewClass(tag)` resolves to a concrete class export. */
const CORE_VIEW_NAMES = new Set([
	...Object.keys(NATIVE_VIEWS),
	...Object.keys(NATIVE_CONTROLLERS),
	'Repeater',
	'StackLayout',
	'GridLayout',
	'FlexboxLayout',
	'WrapLayout',
	'DockLayout',
	'AbsoluteLayout',
	'ContentView',
	'Placeholder',
	'Frame',
]);

interface TextEdit {
	start: number;
	end: number;
	text: string;
}

/**
 * Desugars compile-time class patterns that native backends cannot express dynamically:
 *
 * 1. TypeScript class-factory mixins (`class Sub extends mixin(Base) { … }` where `mixin` returns
 *    `class Mixin extends Base { … }`): specializes `class __mixin_Mixin_Base extends Base { … }`
 *    in the subclass's file and stubs the generic mixin factory body when declared in a module.
 * 2. Local `@CSSType(tag) class Local extends Base { … }` declarations inside a `for (const tag of CONST_LIST)`
 *    loop (including `const Base = getViewClass(tag)` for known `@nativescript/core` view classes):
 *    unrolls the loop and hoists one concrete top-level class per tag.
 *
 * All identifier and constructor rewrites are driven by the TypeScript AST so strings, comments,
 * property keys, and shadowed locals are never altered.
 */
export function desugarClassMixins(text: string, fileName: string): string {
	if (!/\bclass\b/.test(text)) return text;
	const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
	const edits: TextEdit[] = [];
	const keepLines = (start: number, end: number, replacement: string) => {
		const origLines = (text.slice(start, end).match(/\n/g) ?? []).length;
		const newLines = (replacement.match(/\n/g) ?? []).length;
		edits.push({ start, end, text: replacement + (origLines > newLines ? '\n'.repeat(origLines - newLines) : '') });
	};
	const existingImports = collectImportedNames(sf);
	const extraImports: string[] = [];
	const hoistedClasses: string[] = [];
	const usedMixinImports = new Map<ts.ImportSpecifier, number>();

	// 1. Specialize `class Sub extends mixinFn(ActualBase) { ... }`
	for (const st of sf.statements) {
		if (!ts.isClassDeclaration(st)) continue;
		const ext = st.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
		if (!ext || !ts.isCallExpression(ext.expression) || !ts.isIdentifier(ext.expression.expression) || ext.expression.arguments.length !== 1) continue;
		const arg = ext.expression.arguments[0];
		if (!ts.isIdentifier(arg)) continue;
		const mixinName = ext.expression.expression.text;
		const found = findMixinFactory(sf, mixinName, fileName);
		if (!found) continue;
		if (found.specifier) usedMixinImports.set(found.specifier, (usedMixinImports.get(found.specifier) ?? 0) + 1);
		const specialized = `__mixin_${found.className}_${arg.text}`;
		const bodyText = specializeMixinBody(found.cls, found.sourceFile, found.paramName, arg.text);
		for (const imp of found.imports) {
			if (imp.names.every((n) => existingImports.has(n))) continue;
			for (const n of imp.names) existingImports.add(n);
			extraImports.push(imp.text);
		}
		edits.push({ start: st.getStart(sf), end: st.getStart(sf), text: `class ${specialized} extends ${arg.text} ${bodyText}\n` });
		keepLines(ext.expression.getStart(sf), ext.expression.end, specialized);
	}

	// 1b. Stub exported generic mixin factory definitions (`export function f<T extends new (...args: any[]) => ...>(Base: T) { return class X extends Base { ... }; }`)
	for (const st of sf.statements) {
		if (!ts.isFunctionDeclaration(st) || !st.name || !st.body || !st.typeParameters?.length) continue;
		const shape = mixinFactoryShape(st);
		if (!shape) continue;
		const retType = st.type ? '' : `: ${st.parameters[0].type ? st.parameters[0].type.getText(sf) : 'any'}`;
		keepLines(st.body.getStart(sf), st.body.end, `${retType} { return ${shape.paramName}; }`);
	}

	// 2. Unroll `for (const tag of CONST_ARRAY)` containing a local `@CSSType(tag) class ...`
	const constArrays = collectConstStringArrays(sf);
	const coreViewImports = new Set<string>();
	const visitFn = (node: ts.Node): void => {
		if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer) && node.initializer.declarations.length === 1 && ts.isIdentifier(node.initializer.declarations[0].name) && ts.isBlock(node.statement)) {
			const loopVar = node.initializer.declarations[0].name.text;
			const tags = resolveStringArray(node.expression, constArrays);
			if (tags?.length) {
				const localCls = node.statement.statements.find(ts.isClassDeclaration);
				if (localCls && localCls.name) {
					const unrolled = unrollLocalClassLoop(sf, node, loopVar, tags, localCls, coreViewImports, hoistedClasses);
					if (unrolled !== null) {
						keepLines(node.getStart(sf), node.end, unrolled);
						return;
					}
				}
			}
		}
		ts.forEachChild(node, visitFn);
	};
	visitFn(sf);

	if (!edits.length && !hoistedClasses.length) return text;

	for (const [spec, calls] of usedMixinImports) {
		const decl = spec.parent.parent.parent;
		let named = 0;
		const count = (n: ts.Node): void => {
			if (ts.isIdentifier(n) && n.text === spec.name.text) named++;
			ts.forEachChild(n, count);
		};
		count(sf);
		if (spec.parent.elements.length === 1 && !decl.importClause?.name && named === calls + 1) keepLines(decl.getStart(sf), decl.end, '');
	}

	text = applyEdits(text, edits);

	const coreImportLine = coreViewImports.size ? `import { ${[...coreViewImports].map((v) => `${v} as __nsCore_${v}`).join(', ')} } from '@nativescript/core';` : '';
	const prefix = [...extraImports, ...(coreImportLine ? [coreImportLine] : [])].join(' ');
	if (prefix) text = `${prefix} ${text}`;
	if (hoistedClasses.length) text = `${text}\n${hoistedClasses.join('\n')}\n`;
	return text;
}

interface NeededImport {
	names: string[];
	text: string;
}

interface MixinFactoryShape {
	className: string;
	paramName: string;
	cls: ts.ClassExpression;
}

interface MixinFactoryInfo extends MixinFactoryShape {
	sourceFile: ts.SourceFile;
	imports: NeededImport[];
	specifier?: ts.ImportSpecifier;
}

function findMixinFactory(sf: ts.SourceFile, name: string, fileName: string): MixinFactoryInfo | null {
	for (const st of sf.statements) {
		if (ts.isFunctionDeclaration(st) && st.name?.text === name) {
			const shape = mixinFactoryShape(st);
			return shape ? { ...shape, sourceFile: sf, imports: [] } : null;
		}
		if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.moduleSpecifier.text.startsWith('.') || st.importClause?.isTypeOnly) continue;
		const bindings = st.importClause?.namedBindings;
		const spec = bindings && ts.isNamedImports(bindings) ? bindings.elements.find((e) => e.name.text === name && !e.isTypeOnly) : undefined;
		if (!spec) continue;
		const base = resolve(dirname(fileName), st.moduleSpecifier.text);
		const file = [base + '.ts', base + '/index.ts'].find((f) => existsSync(f));
		if (!file) return null;
		const raw = readFileSync(file, 'utf8');
		const other = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true);
		const exported = (spec.propertyName ?? spec.name).text;
		const decl = other.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === exported && !!s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
		const shape = decl ? mixinFactoryShape(decl) : null;
		if (!shape) return null;
		const imports = collectNeededImports(other, shape.cls, file, fileName);
		return { ...shape, sourceFile: other, imports, specifier: spec };
	}
	return null;
}

function mixinFactoryShape(fn: ts.FunctionDeclaration): MixinFactoryShape | null {
	if (!fn.body || fn.parameters.length !== 1 || !ts.isIdentifier(fn.parameters[0].name)) return null;
	if (fn.body.statements.length !== 1) return null;
	const ret = fn.body.statements[0];
	if (!ts.isReturnStatement(ret) || !ret.expression) return null;
	let expr: ts.Expression = ret.expression;
	while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
	if (!ts.isClassExpression(expr)) return null;
	const paramName = fn.parameters[0].name.text;
	const ext = expr.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
	if (!ext || !ts.isIdentifier(ext.expression) || ext.expression.text !== paramName) return null;
	return { className: expr.name?.text ?? fn.name?.text ?? 'Mixin', paramName, cls: expr };
}

/**
 * Extracts `{ ... }` from a mixin `ClassExpression`, replacing references to `paramName` with `baseName`
 * and simplifying a forwarding `constructor(...args: any[]) { super(...args); ... }` to `constructor() { super(); ... }`.
 */
function specializeMixinBody(cls: ts.ClassExpression, sf: ts.SourceFile, paramName: string, baseName: string): string {
	const full = sf.text;
	const openBrace = full.indexOf('{', cls.getStart(sf));
	if (openBrace < 0) return '{}';
	const bodyText = full.slice(openBrace, cls.end);
	const edits: TextEdit[] = [];

	// Simplify `constructor(...args: any[]) { super(...args); ... }` for concrete subclasses whose base takes 0 args.
	for (const m of cls.members) {
		if (!ts.isConstructorDeclaration(m) || !m.body || m.parameters.length !== 1) continue;
		const p = m.parameters[0];
		if (!p.dotDotDotToken || !ts.isIdentifier(p.name)) continue;
		const restName = p.name.text;
		const first = m.body.statements[0];
		if (!first || !ts.isExpressionStatement(first) || !ts.isCallExpression(first.expression) || first.expression.expression.kind !== ts.SyntaxKind.SuperKeyword) continue;
		const superArgs = first.expression.arguments;
		if (superArgs.length !== 1 || !ts.isSpreadElement(superArgs[0]) || !ts.isIdentifier(superArgs[0].expression) || superArgs[0].expression.text !== restName) continue;
		edits.push({ start: p.getStart(sf) - openBrace, end: p.end - openBrace, text: '' });
		edits.push({ start: superArgs[0].getStart(sf) - openBrace, end: superArgs[0].end - openBrace, text: '' });
	}

	const replacements = new Map([[paramName, baseName]]);
	for (const m of cls.members) collectIdentifierEdits(m, sf, openBrace, replacements, new Set(), edits);
	return applyEdits(bodyText, edits);
}

function collectNeededImports(other: ts.SourceFile, cls: ts.ClassExpression, otherFile: string, targetFile: string): NeededImport[] {
	const referenced = new Set<string>();
	const walk = (n: ts.Node): void => {
		if (ts.isIdentifier(n) && !isMemberNamePosition(n)) referenced.add(n.text);
		ts.forEachChild(n, walk);
	};
	for (const m of cls.members) walk(m);
	const out: NeededImport[] = [];
	for (const st of other.statements) {
		if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.importClause) continue;
		const mod = st.moduleSpecifier.text;
		const resolvedMod = mod.startsWith('.') ? resolve(dirname(otherFile), mod) : mod;
		const specText = mod.startsWith('.') ? relativeSpecifier(dirname(targetFile), resolvedMod) : mod;
		const bindings = st.importClause.namedBindings;
		if (bindings && ts.isNamedImports(bindings)) {
			const needed = bindings.elements.filter((el) => referenced.has(el.name.text));
			if (needed.length) {
				const typePrefix = st.importClause.isTypeOnly ? 'type ' : '';
				out.push({
					names: needed.map((el) => el.name.text),
					text: `import ${typePrefix}{ ${needed.map((el) => el.getText(other)).join(', ')} } from ${JSON.stringify(specText)};`,
				});
			}
		}
	}
	return out;
}

function relativeSpecifier(fromDir: string, absTarget: string): string {
	const rel = relative(fromDir, absTarget).replace(/\\/g, '/');
	return rel.startsWith('.') ? rel : `./${rel}`;
}

function collectImportedNames(sf: ts.SourceFile): Set<string> {
	const existing = new Set<string>();
	for (const st of sf.statements) {
		if (!ts.isImportDeclaration(st)) continue;
		if (st.importClause?.name) existing.add(st.importClause.name.text);
		const b = st.importClause?.namedBindings;
		if (b && ts.isNamedImports(b)) for (const el of b.elements) existing.add(el.name.text);
	}
	return existing;
}

function collectConstStringArrays(sf: ts.SourceFile): Map<string, string[]> {
	const map = new Map<string, string[]>();
	for (const st of sf.statements) {
		if (!ts.isVariableStatement(st) || !(st.declarationList.flags & ts.NodeFlags.Const)) continue;
		for (const d of st.declarationList.declarations) {
			if (!ts.isIdentifier(d.name) || !d.initializer) continue;
			const items = resolveStringArray(d.initializer, map);
			if (items) map.set(d.name.text, items);
		}
	}
	return map;
}

function resolveStringArray(expr: ts.Expression, known: Map<string, string[]>): string[] | null {
	const x = ts.skipOuterExpressions(expr);
	if (ts.isIdentifier(x)) return known.get(x.text) ?? null;
	if (!ts.isArrayLiteralExpression(x)) return null;
	const out: string[] = [];
	for (const el of x.elements) {
		if (ts.isStringLiteralLike(el)) out.push(el.text);
		else if (ts.isSpreadElement(el)) {
			const nested = resolveStringArray(el.expression, known);
			if (!nested) return null;
			out.push(...nested);
		} else return null;
	}
	return out;
}

function isGetViewClassCall(stmt: ts.VariableStatement, baseIdent: string, loopVar: string): boolean {
	const decl = stmt.declarationList.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === baseIdent);
	if (!decl?.initializer) return false;
	const init = ts.skipOuterExpressions(decl.initializer);
	return ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'getViewClass' && init.arguments.length === 1 && ts.isIdentifier(init.arguments[0]) && init.arguments[0].text === loopVar;
}

function unrollLocalClassLoop(
	sf: ts.SourceFile,
	loop: ts.ForOfStatement,
	loopVar: string,
	tags: string[],
	localCls: ts.ClassDeclaration,
	coreViewImports: Set<string>,
	hoistedClasses: string[],
): string | null {
	const block = loop.statement as ts.Block;
	const clsName = localCls.name!.text;
	const ext = localCls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
	if (!ext || !ts.isIdentifier(ext.expression)) return null;
	const baseIdent = ext.expression.text;
	const baseVarStmt = block.statements.find(
		(s): s is ts.VariableStatement =>
			ts.isVariableStatement(s) &&
			s.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === baseIdent),
	);
	const isCoreViewLookup = !!baseVarStmt && isGetViewClassCall(baseVarStmt, baseIdent, loopVar) && tags.every((t) => CORE_VIEW_NAMES.has(t));
	if (baseVarStmt && !isCoreViewLookup) return null;

	// Collect any other local `const x = ...` before `localCls` that `localCls`'s body references (e.g. `const items = itemsDescriptor(Base.prototype)`).
	const localVars: { name: string; initializer: ts.Expression }[] = [];
	for (const s of block.statements) {
		if (s === localCls) break;
		if (s === baseVarStmt) continue;
		if (!ts.isVariableStatement(s) || s.declarationList.declarations.length !== 1) return null;
		const d = s.declarationList.declarations[0];
		if (!ts.isIdentifier(d.name) || !d.initializer) return null;
		localVars.push({ name: d.name.text, initializer: d.initializer });
	}

	const afterCls = block.statements.slice(block.statements.indexOf(localCls) + 1);
	const bodyStmts: string[] = [];
	for (const tag of tags) {
		const safeTag = tag.replace(/[^A-Za-z0-9_]/g, '_');
		const hoistedName = `__local_${clsName}_${safeTag}`;
		const baseName = isCoreViewLookup ? `__nsCore_${tag}` : baseIdent;
		if (isCoreViewLookup) coreViewImports.add(tag);

		const initMap = new Map<string, string>([
			[loopVar, JSON.stringify(tag)],
			...(isCoreViewLookup ? [[baseIdent, baseName] as const] : []),
		]);
		const varRenames = new Map<string, string>();
		for (const lv of localVars) {
			const modVar = `__local_${lv.name}_${safeTag}`;
			varRenames.set(lv.name, modVar);
			hoistedClasses.push(`let ${modVar}: any;`);
			bodyStmts.push(`${modVar} = ${rewriteNode(lv.initializer, sf, initMap)};`);
		}

		const clsMap = new Map<string, string>([
			[loopVar, JSON.stringify(tag)],
			...(isCoreViewLookup ? [[baseIdent, baseName] as const] : []),
			...varRenames,
		]);
		hoistedClasses.push(rewriteNode(localCls, sf, clsMap, { renameClass: [clsName, hoistedName], ignoreAccessors: isCoreViewLookup }));

		const afterMap = new Map<string, string>([
			[clsName, hoistedName],
			[loopVar, JSON.stringify(tag)],
			...(isCoreViewLookup ? [[baseIdent, baseName] as const] : []),
			...varRenames,
		]);
		for (const s of afterCls) bodyStmts.push(rewriteNode(s, sf, afterMap));
	}
	return `{ ${bodyStmts.join(' ')} }`;
}

/** Returns true when `id` is a property/member name declaration or access (`obj.id`, `{ id: v }`, `get id()`), not a variable reference. */
function isMemberNamePosition(id: ts.Identifier): boolean {
	const p = id.parent;
	if (ts.isPropertyAccessExpression(p) && p.name === id) return true;
	if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p) || ts.isMethodSignature(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) && p.name === id) return true;
	if (ts.isQualifiedName(p) && p.right === id) return true;
	if (ts.isLabeledStatement(p) && p.label === id) return true;
	return false;
}

/** Collects AST-accurate identifier replacement edits inside `node`, respecting shadowing and member names. */
function collectIdentifierEdits(
	node: ts.Node,
	sf: ts.SourceFile,
	baseOffset: number,
	replacements: ReadonlyMap<string, string>,
	shadowed: ReadonlySet<string>,
	edits: TextEdit[],
	opts?: { renameClass?: [string, string] },
): void {
	if (ts.isClassDeclaration(node) && node.name && opts?.renameClass && node.name.text === opts.renameClass[0]) {
		edits.push({ start: node.name.getStart(sf) - baseOffset, end: node.name.end - baseOffset, text: opts.renameClass[1] });
	}
	if (ts.isFunctionLike(node)) {
		const nextShadow = new Set(shadowed);
		for (const param of node.parameters) collectBindingNames(param.name, nextShadow);
		if ('body' in node && node.body && ts.isBlock(node.body)) {
			for (const st of node.body.statements) {
				if (ts.isVariableStatement(st)) {
					for (const d of st.declarationList.declarations) collectBindingNames(d.name, nextShadow);
				} else if (ts.isFunctionDeclaration(st) && st.name) nextShadow.add(st.name.text);
			}
		}
		ts.forEachChild(node, (child) => {
			if (child === node.name) return;
			if (node.parameters.includes(child as ts.ParameterDeclaration)) {
				const param = child as ts.ParameterDeclaration;
				if (param.type) collectIdentifierEdits(param.type, sf, baseOffset, replacements, shadowed, edits);
				if (param.initializer) collectIdentifierEdits(param.initializer, sf, baseOffset, replacements, shadowed, edits);
				return;
			}
			collectIdentifierEdits(child, sf, baseOffset, replacements, nextShadow, edits);
		});
		return;
	}
	if (ts.isShorthandPropertyAssignment(node)) {
		const rep = !shadowed.has(node.name.text) ? replacements.get(node.name.text) : undefined;
		if (rep !== undefined) {
			edits.push({ start: node.name.getStart(sf) - baseOffset, end: node.name.end - baseOffset, text: `${node.name.text}: ${rep}` });
		}
		return;
	}
	if (ts.isIdentifier(node)) {
		if (isMemberNamePosition(node)) return;
		if (ts.isClassDeclaration(node.parent) && node.parent.name === node) return;
		if (ts.isVariableDeclaration(node.parent) && node.parent.name === node) return;
		if (shadowed.has(node.text)) return;
		const rep = replacements.get(node.text);
		if (rep !== undefined) {
			edits.push({ start: node.getStart(sf) - baseOffset, end: node.end - baseOffset, text: rep });
		}
		return;
	}
	ts.forEachChild(node, (child) => collectIdentifierEdits(child, sf, baseOffset, replacements, shadowed, edits));
}

function collectBindingNames(name: ts.BindingName, out: Set<string>): void {
	if (ts.isIdentifier(name)) out.add(name.text);
	else for (const el of name.elements) if (!ts.isOmittedExpression(el)) collectBindingNames(el.name, out);
}

function rewriteNode(node: ts.Node, sf: ts.SourceFile, replacements: ReadonlyMap<string, string>, opts?: { renameClass?: [string, string]; ignoreAccessors?: boolean }): string {
	const baseOffset = node.getStart(sf);
	const edits: TextEdit[] = [];
	if (opts?.ignoreAccessors && ts.isClassDeclaration(node)) {
		for (const m of node.members) {
			if (ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) {
				const at = m.getStart(sf) - baseOffset;
				edits.push({ start: at, end: at, text: '// @ts-ignore\n' });
			}
		}
	}
	collectIdentifierEdits(node, sf, baseOffset, replacements, new Set(), edits, opts);
	return applyEdits(sf.text.slice(baseOffset, node.end), edits);
}

function applyEdits(source: string, edits: TextEdit[]): string {
	if (!edits.length) return source;
	const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
	let out = source;
	for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
	return out;
}
