import type { CoreApi, TypeScript } from '@nstudio/nativescript-compiler/adapter-api';

/** The compiler's own functions and state, from the compiler that loaded the adapter: set by its entry before any front end runs. */
export let core: CoreApi;

/** The compiler's TypeScript (`core.ts`), set with `core`: the adapter reads and makes the compiler's syntax trees with it, never with a TypeScript of its own. */
export let ts: CoreApi['ts'];
/** TypeScript's types as the adapter names them (`ts.Node`): each one it names is listed here. */
export declare namespace ts {
  export type ArrayBindingPattern = TypeScript.ArrayBindingPattern;
  export type ArrowFunction = TypeScript.ArrowFunction;
  export type BindingElement = TypeScript.BindingElement;
  export type Block = TypeScript.Block;
  export type CallExpression = TypeScript.CallExpression;
  export type ConditionalExpression = TypeScript.ConditionalExpression;
  export type Declaration = TypeScript.Declaration;
  export type Expression = TypeScript.Expression;
  export type FunctionDeclaration = TypeScript.FunctionDeclaration;
  export type FunctionExpression = TypeScript.FunctionExpression;
  export type Identifier = TypeScript.Identifier;
  export type InterfaceDeclaration = TypeScript.InterfaceDeclaration;
  export type JsxAttribute = TypeScript.JsxAttribute;
  export type JsxChild = TypeScript.JsxChild;
  export type JsxElement = TypeScript.JsxElement;
  export type JsxSelfClosingElement = TypeScript.JsxSelfClosingElement;
  export type Node = TypeScript.Node;
  export type NodeArray<T extends TypeScript.Node> = TypeScript.NodeArray<T>;
  export type ObjectLiteralExpression = TypeScript.ObjectLiteralExpression;
  export type PropertySignature = TypeScript.PropertySignature;
  export type SourceFile = TypeScript.SourceFile;
  export type Statement = TypeScript.Statement;
  export type StringLiteral = TypeScript.StringLiteral;
  export type TypeElement = TypeScript.TypeElement;
  export type TypeNode = TypeScript.TypeNode;
  export type VariableDeclaration = TypeScript.VariableDeclaration;
  export type VariableStatement = TypeScript.VariableStatement;
}

export function useCore(api: CoreApi): void {
  core = api;
  ts = api.ts;
}
