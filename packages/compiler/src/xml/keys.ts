// The keys script reads an XML app's objects by, when every XML site is built at build time (no Builder parse, no
// expression evaluator): core reads by name only what the XML names (binding paths, the closures' names, attributes)
// and what app code spells. App code that reads an untyped value by a key it doesn't spell, or a `bindingContext` it
// doesn't assert to a type, leaves the keys open (null), and every member stays readable by name.
import ts from 'typescript';
import type { ElementPlan, XmlPlan } from './plan.ts';
import type { ParseExpression } from './bindings.ts';

type Node = any;

/** The names the plan's XML reads or sets by name, or null where an expression reads by a computed key. */
export function planKeys(plan: XmlPlan, parse: ParseExpression, binds: readonly { expression?: string; sourceProperty?: string }[] = []): Set<string> | null {
	const keys = new Set<string>();
	let open = false;
	const segments = (path: string) => {
		for (const s of path.split(/[.\[\]'"\s]+/)) if (s) keys.add(s);
	};
	const expression = (text: string) => {
		let ast: Node;
		try {
			ast = parse(text);
		} catch {
			return;
		}
		const visit = (n: Node): void => {
			if (!n || typeof n !== 'object' || open) return;
			if (Array.isArray(n)) {
				n.forEach(visit);
				return;
			}
			if (n.type === 'Identifier') keys.add(n.name);
			if (n.type === 'MemberExpression') {
				if (!n.computed) keys.add(n.property.name);
				else if (n.property.type === 'Literal') keys.add(String(n.property.value));
				else open = true;
			}
			for (const [k, v] of Object.entries(n)) if (k !== 'type' && v && typeof v === 'object') visit(v);
		};
		visit(ast);
	};
	const element = (e: ElementPlan | null | undefined): void => {
		if (!e) return;
		for (const a of e.attributes) {
			segments(a.target);
			if (a.binding) {
				segments(a.binding.sourceProperty);
				if (a.binding.expression !== undefined) expression(a.binding.expression);
			}
		}
		e.children.forEach(element);
		for (const p of e.properties) {
			keys.add(p.name);
			element(p.root);
			p.templates?.forEach((t) => element(t.root));
			p.children?.forEach(element);
		}
	};
	for (const page of [...plan.pages, ...plan.texts.map((t) => t.page)]) element(page.root);
	for (const b of binds) {
		if (b.sourceProperty !== undefined) segments(b.sourceProperty);
		if (b.expression !== undefined) expression(b.expression);
	}
	return open ? null : keys;
}

/**
 * The keys app code reads or sets objects by where the program can't see which object: members of untyped values,
 * `in` tests, and core Observable's `get`/`set`/`setProperty` keys. Null where one is not a literal, or where a
 * `bindingContext` is read without an assertion to a type. `generated`: the files built from the XML, whose reads
 * `planKeys` lists.
 */
export function scriptKeys(files: readonly ts.SourceFile[], checker: ts.TypeChecker, generated: ReadonlySet<string>): Set<string> | null {
	const keys = new Set<string>();
	let open = false;
	const untyped = (e: ts.Expression) => !!(checker.getNonNullableType(checker.getTypeAtLocation(e)).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
	const literal = (e: ts.Expression | undefined) => {
		const x = e && ts.skipOuterExpressions(e);
		return x && (ts.isStringLiteralLike(x) || ts.isNumericLiteral(x)) ? x.text : null;
	};
	const asserted = (n: ts.Node) => {
		let p = n.parent;
		while (ts.isParenthesizedExpression(p)) p = p.parent;
		return (ts.isAsExpression(p) || ts.isTypeAssertionExpression(p)) && !(checker.getTypeAtLocation(p).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
	};
	const written = (n: ts.Node) => ts.isBinaryExpression(n.parent) && n.parent.left === n && n.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
	const observableMethod = (call: ts.CallExpression) => {
		const d = checker.getResolvedSignature(call)?.getDeclaration();
		const owner = d && !ts.isJSDocSignature(d) ? d.parent : undefined;
		return !!owner && (ts.isClassLike(owner) || ts.isInterfaceDeclaration(owner)) && owner.name?.text === 'Observable';
	};
	const visit = (n: ts.Node): void => {
		if (open) return;
		if (ts.isPropertyAccessExpression(n)) {
			if (untyped(n.expression)) keys.add(n.name.text);
			if (n.name.text === 'bindingContext' && !written(n) && !asserted(n)) open = true;
		} else if (ts.isElementAccessExpression(n) && untyped(n.expression)) {
			const k = literal(n.argumentExpression);
			if (k === null) open = true;
			else keys.add(k);
		} else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InKeyword) {
			const k = literal(n.left);
			if (k !== null) keys.add(k);
			else if (untyped(n.right)) open = true;
		} else if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer && untyped(n.initializer)) {
			for (const b of n.name.elements) {
				const k = b.propertyName ? (ts.isIdentifier(b.propertyName) || ts.isStringLiteralLike(b.propertyName) ? b.propertyName.text : null) : ts.isIdentifier(b.name) ? b.name.text : null;
				if (k === null) open = true;
				else keys.add(k);
			}
		} else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ['get', 'set', 'setProperty'].includes(n.expression.name.text) && observableMethod(n)) {
			const k = literal(n.arguments[0]);
			if (k === null) open = true;
			else keys.add(k);
		}
		ts.forEachChild(n, visit);
	};
	for (const f of files) if (!f.isDeclarationFile && !generated.has(f.fileName)) visit(f);
	return open ? null : keys;
}
