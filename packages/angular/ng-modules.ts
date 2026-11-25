// What the back ends read of an Angular app's NgModules and standalone components' imports. Kept apart from the front
// end so that a back end importing it does not load @angular/compiler.
import { ts } from './core-api.ts';

/** The class's decorator of that name, called (`@Component({...})`). */
export function decorator(node: ts.ClassDeclaration, name: string): ts.CallExpression | undefined {
  for (const d of ts.getDecorators(node) ?? []) {
    if (ts.isCallExpression(d.expression) && ts.isIdentifier(d.expression.expression) && d.expression.expression.text === name) return d.expression;
  }
  return undefined;
}

/** A class of the program's sources that carries `@NgModule`. */
function isNgModuleSource(decl: ts.Declaration | undefined): decl is ts.ClassDeclaration {
  return !!decl && ts.isClassDeclaration(decl) && !decl.getSourceFile().isDeclarationFile && !!decorator(decl, 'NgModule');
}

/** Whether the build compiles a class of the program's sources (a plugin's only where it is reached). */
export type Compiles = (decl: ts.ClassDeclaration) => boolean;

const metaField = (o: ts.Expression | undefined, name: string) => (o && ts.isObjectLiteralExpression(o) ? o.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === name)?.initializer : undefined);

/**
 * Of an `imports` list, in order, the NgModules the program compiles, the `ModuleWithProviders` calls of their statics
 * (not in a component, where Angular drops their providers), and in place of a standalone component the modules its own
 * `imports` list. The rest (the kit's own modules) has no constructor or providers of its own in a compiled build.
 */
function ngImports(list: ts.Expression | undefined, checker: ts.TypeChecker, compiles: Compiles, inComponent: boolean, seen: Set<ts.ClassDeclaration>): ts.Expression[] {
  const declOf = (e: ts.Expression) => {
    const s = checker.getSymbolAtLocation(e);
    return (s && s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s)?.declarations?.[0];
  };
  const compiledNgModule = (decl: ts.Declaration | undefined) => isNgModuleSource(decl) && compiles(decl);
  const kept = (list: ts.Expression | undefined, inComponent: boolean): ts.Expression[] => {
    if (!list || !ts.isArrayLiteralExpression(list)) return [];
    return list.elements.flatMap((e): ts.Expression[] => {
      if (ts.isArrayLiteralExpression(e)) return kept(e, inComponent);
      const decl = declOf(e);
      if (compiledNgModule(decl)) return [e];
      if (decl && ts.isClassDeclaration(decl) && !decl.getSourceFile().isDeclarationFile && !seen.has(decl)) {
        const component = decorator(decl, 'Component')?.arguments[0];
        if (component) {
          seen.add(decl);
          return kept(metaField(component, 'imports'), true);
        }
      }
      if (!inComponent && ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && compiledNgModule(declOf(e.expression.expression))) return [e];
      return [];
    });
  };
  return kept(list, inComponent);
}

/** An `@NgModule` class's metadata as Angular's injector walks it (`walkProviderTree`): its `imports` and `providers`. */
export function ngModuleDef(cls: ts.ClassDeclaration, checker: ts.TypeChecker, compiles: Compiles): { imports: ts.Expression[]; providers?: ts.Expression } | undefined {
  const meta = decorator(cls, 'NgModule')?.arguments[0];
  if (!meta) return undefined;
  return { imports: ngImports(metaField(meta, 'imports'), checker, compiles, false, new Set()), providers: metaField(meta, 'providers') };
}

/**
 * A standalone component's imports that make it its own environment injector when it is created as a root view
 * (`StandaloneService`); undefined when none of them has a provider in a compiled build.
 */
export function standaloneImports(cls: ts.ClassDeclaration, checker: ts.TypeChecker, compiles: Compiles): ts.Expression[] | undefined {
  const meta = decorator(cls, 'Component')?.arguments[0];
  const imports = meta && ngImports(metaField(meta, 'imports'), checker, compiles, true, new Set([cls]));
  return imports?.length ? imports : undefined;
}
