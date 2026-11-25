import type { CoreApi, TypeScript } from '@nstudio/nativescript-compiler/adapter-api';

/** The compiler's own functions and state, from the compiler that loaded the adapter: set by its entry before any front end runs. */
export let core: CoreApi;

/** The compiler's TypeScript (`core.ts`), set with `core`: the adapter reads and makes the compiler's syntax trees with it, never with a TypeScript of its own. */
export let ts: CoreApi['ts'];
/** TypeScript's types as the adapter names them (`ts.Node`): each one it names is listed here. */
export declare namespace ts {
  export type ArrayLiteralExpression = TypeScript.ArrayLiteralExpression;
  export type CallExpression = TypeScript.CallExpression;
  export type ClassDeclaration = TypeScript.ClassDeclaration;
  export type ClassElement = TypeScript.ClassElement;
  export type ClassLikeDeclaration = TypeScript.ClassLikeDeclaration;
  export type ConstructorDeclaration = TypeScript.ConstructorDeclaration;
  export type Declaration = TypeScript.Declaration;
  export type Decorator = TypeScript.Decorator;
  export type EntityName = TypeScript.EntityName;
  export type ExportSpecifier = TypeScript.ExportSpecifier;
  export type Expression = TypeScript.Expression;
  export type ExpressionWithTypeArguments = TypeScript.ExpressionWithTypeArguments;
  export type HasModifiers = TypeScript.HasModifiers;
  export type Identifier = TypeScript.Identifier;
  export type ImportSpecifier = TypeScript.ImportSpecifier;
  export type MethodDeclaration = TypeScript.MethodDeclaration;
  export type Node = TypeScript.Node;
  export type NodeArray<T extends TypeScript.Node> = TypeScript.NodeArray<T>;
  export type ObjectLiteralExpression = TypeScript.ObjectLiteralExpression;
  export type ParameterDeclaration = TypeScript.ParameterDeclaration;
  export type PropertyAccessExpression = TypeScript.PropertyAccessExpression;
  export type PropertyAssignment = TypeScript.PropertyAssignment;
  export type PropertyDeclaration = TypeScript.PropertyDeclaration;
  export type SetAccessorDeclaration = TypeScript.SetAccessorDeclaration;
  export type SourceFile = TypeScript.SourceFile;
  export type Statement = TypeScript.Statement;
  export type StringLiteral = TypeScript.StringLiteral;
  export type SyntaxKind = TypeScript.SyntaxKind;
  export type TypeChecker = TypeScript.TypeChecker;
}

export function useCore(api: CoreApi): void {
  core = api;
  ts = api.ts;
}
