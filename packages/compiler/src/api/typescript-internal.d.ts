// TypeScript's internal API the compiler calls: exported at runtime but absent from typescript.d.ts. Each is internal,
// and stable across the TypeScript version package.json pins; re-check them when that pin moves.
import type ts from 'typescript';

declare module 'typescript' {
	/** Internal: strips the outer expressions `kinds` names (parentheses, assertions, `satisfies`, `!`, partially emitted). */
	function skipOuterExpressions(node: ts.Expression, kinds?: ts.OuterExpressionKinds): ts.Expression;
	function skipOuterExpressions(node: ts.Node, kinds?: ts.OuterExpressionKinds): ts.Node;
	/** Internal: strips parentheses. */
	function skipParentheses(node: ts.Expression, excludeJSDocTypeAssertions?: boolean): ts.Expression;
	function skipParentheses(node: ts.Node, excludeJSDocTypeAssertions?: boolean): ts.Node;
	/** Internal: the outermost parenthesized expression around `node`, else `node`. */
	function walkUpParenthesizedExpressions(node: ts.Node): ts.Node;
	/** Internal: the nearest function, method, class static block, module or source file whose `this` `node` reads. */
	function getThisContainer(node: ts.Node, includeArrowFunctions: false, includeClassComputedPropertyName: false): ThisContainer;
	/** Internal: the nearest enclosing function-like declaration. */
	function getContainingFunction(node: ts.Node): ts.SignatureDeclaration | undefined;
	/** Internal: a type's object flags (0 for a type that isn't an object type). */
	function getObjectFlags(type: ts.Type): ts.ObjectFlags;
	/** Internal. */
	function isBindingPattern(node: ts.Node | undefined): node is ts.BindingPattern;
	/** Internal. */
	function isForInOrOfStatement(node: ts.Node): node is ts.ForInOrOfStatement;

	/** Internal members of public enums. */
	enum NodeFlags {
		Ambient = 33554432,
	}
	enum TypeFlags {
		Primitive = 402784252,
	}

	/** Internal: what `getThisContainer` returns. */
	type ThisContainer = ts.FunctionDeclaration | ts.FunctionExpression | ts.ModuleDeclaration | ts.ClassStaticBlockDeclaration | ts.PropertyDeclaration | ts.PropertySignature | ts.MethodDeclaration | ts.MethodSignature | ts.ConstructorDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration | ts.CallSignatureDeclaration | ts.ConstructSignatureDeclaration | ts.IndexSignatureDeclaration | ts.EnumDeclaration | ts.SourceFile;
}
