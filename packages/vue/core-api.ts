import type { CoreApi, TypeScript } from '@nstudio/nativescript-compiler/adapter-api';

/** The compiler's own functions and state, from the compiler that loaded the adapter: set by its entry before any front end runs. */
export let core: CoreApi;

/** The compiler's TypeScript (`core.ts`), set with `core`: the adapter reads and makes the compiler's syntax trees with it, never with a TypeScript of its own. */
export let ts: CoreApi['ts'];
/** TypeScript's types as the adapter names them (`ts.Node`): each one it names is listed here. */
export declare namespace ts {
  export type CallExpression = TypeScript.CallExpression;
  export type Declaration = TypeScript.Declaration;
  export type Expression = TypeScript.Expression;
  export type FunctionDeclaration = TypeScript.FunctionDeclaration;
  export type Identifier = TypeScript.Identifier;
  export type ImportDeclaration = TypeScript.ImportDeclaration;
  export type MethodDeclaration = TypeScript.MethodDeclaration;
  export type Node = TypeScript.Node;
  export type ObjectLiteralElementLike = TypeScript.ObjectLiteralElementLike;
  export type ObjectLiteralExpression = TypeScript.ObjectLiteralExpression;
  export type PropertyAccessExpression = TypeScript.PropertyAccessExpression;
  export type PropertyAssignment = TypeScript.PropertyAssignment;
  export type Statement = TypeScript.Statement;
  export type StringLiteral = TypeScript.StringLiteral;
}

export function useCore(api: CoreApi): void {
  core = api;
  ts = api.ts;
}
