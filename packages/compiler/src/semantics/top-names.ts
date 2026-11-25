// Module-level names both backends share: Swift's app module and Kotlin's app package are each one namespace, so the
// program's declarations of one name in several modules take their modules' names apart.
import ts from 'typescript';
import { intersectionAliasMembers } from './lang.ts';
import { hasModifier } from './ast.ts';

/**
 * App mode: a module-level object type the backends declare as a type of its name (an interface, or an alias of a type
 * literal or of an intersection of object types), unless it merges with a class, which is that class.
 */
export function namedObjectType(st: ts.Statement, checker: ts.TypeChecker): st is ts.InterfaceDeclaration | ts.TypeAliasDeclaration {
	if (hasModifier(st, ts.SyntaxKind.DeclareKeyword)) return false;
	const shape = ts.isInterfaceDeclaration(st) || (ts.isTypeAliasDeclaration(st) && (ts.isTypeLiteralNode(st.type) || !!intersectionAliasMembers(st, checker)));
	return shape && !((checker.getSymbolAtLocation(st.name)?.flags ?? 0) & ts.SymbolFlags.Class);
}

/**
 * Of several module-level declarations of one name, the one that keeps it: a class over an object type (the class is the
 * public API), else the first of the app's own modules, else the first.
 */
export function keptDeclaration<T extends { decl: ts.Node; file: ts.SourceFile }>(list: readonly T[], pluginFiles: ReadonlySet<string>, classFirst: boolean): T {
	const cls = classFirst || list.some((x) => ts.isInterfaceDeclaration(x.decl) || ts.isTypeAliasDeclaration(x.decl)) ? list.find((x) => ts.isClassDeclaration(x.decl)) : undefined;
	return cls ?? list.find((x) => !pluginFiles.has(x.file.fileName)) ?? list[0];
}

/** What a renamed module-level declaration names together in its module: every overload of a function, every `var` of one variable. */
export function declarationsNamedWith(decl: ts.Node, file: ts.SourceFile, name: string, checker: ts.TypeChecker): readonly ts.Node[] {
	if (ts.isFunctionDeclaration(decl)) return file.statements.filter((st) => ts.isFunctionDeclaration(st) && st.name?.text === name);
	if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) return checker.getSymbolAtLocation(decl.name)?.declarations?.filter((d) => d.getSourceFile() === file) ?? [decl];
	return [decl];
}

/** A declaration's name with its module's: the shortest end of the module's path no name in `taken` has (`label__index`, else `label__two_index`). */
export function moduleSuffixedName(name: string, fileName: string, taken: Set<string>): string {
	const segs = fileName
		.replace(/\.[^./\\]+$/, '')
		.split(/[\\/]/)
		.filter(Boolean);
	for (let k = 1; k <= segs.length; k++) {
		const candidate = `${name}__${segs.slice(-k).join('_').replace(/\W/g, '_')}`;
		if (!taken.has(candidate)) {
			taken.add(candidate);
			return candidate;
		}
	}
	let n = 2;
	while (taken.has(`${name}__${n}`)) n++;
	taken.add(`${name}__${n}`);
	return `${name}__${n}`;
}

/**
 * The native name of the program's one class named `name`: a component or registered element, which templates, the
 * entry, navigation and modals name by its TypeScript name. It is the class declaration's module-level name, so it
 * takes the rename the declaration takes.
 */
export function programClassName(t: { readonly sourceFiles: readonly ts.SourceFile[]; topName(decl: ts.Node, name: string): string }, name: string): string {
	const classes = t.sourceFiles.flatMap((sf) => (sf.isDeclarationFile ? [] : sf.statements.filter((st) => ts.isClassDeclaration(st) && st.name?.text === name)));
	return classes.length === 1 ? t.topName(classes[0], name) : name;
}
