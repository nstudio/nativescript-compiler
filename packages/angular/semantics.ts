// What Angular's API means to both back ends and their analyses: dependency injection, decorators, signal options.
import type { FrameworkModel, ThrowsModel, ThrowsView } from '@nstudio/nativescript-compiler/adapter-api';
import { core, ts } from './core-api.ts';

export const isStatic = (m: ts.Node): boolean => ts.canHaveModifiers(m) && !!ts.getModifiers(m)?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword);
export const hasModifier = (n: ts.Node, kind: ts.SyntaxKind): boolean => ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === kind);

/** Tokens the kit provides an instance of (`inject(Router)`); any other is the app's service or the injector's. */
export const KIT_TOKENS = ['RouterExtensions', 'ActivatedRoute', 'Page', 'DestroyRef', 'ChangeDetectorRef', 'ElementRef', 'NativeDialogRef', 'NativeDialogService', 'Router', 'HttpClient', 'Injector', 'EnvironmentInjector', 'NgZone', 'ErrorHandler', 'Location', 'ViewContainerRef', 'TemplateRef', 'ApplicationRef', 'PendingTasks', 'Renderer2', 'RendererFactory2'];

/** The code giving a kit token's instance where it is not the token class's own `shared`, per back end. */
export const INJECTION_TOKENS: Record<string, { swift: string; kotlin: string }> = {
  RouterExtensions: { swift: 'Router.shared', kotlin: 'Router.shared' },
  EnvironmentInjector: { swift: 'Injector.shared', kotlin: 'Injector.shared' },
  ErrorHandler: { swift: 'Injector.errorHandler', kotlin: 'Injector.errorHandler' },
  ActivatedRoute: { swift: 'ActivatedRoute.current', kotlin: 'ActivatedRoute.current' },
  Page: { swift: 'Page.injected()', kotlin: 'injectedPage()' },
  DestroyRef: { swift: 'DestroyRef.current()', kotlin: 'DestroyRef.current()' },
  ChangeDetectorRef: { swift: 'ChangeDetectorRef.current()', kotlin: 'ChangeDetectorRef.current()' },
  ElementRef: { swift: 'ElementRef.current()', kotlin: 'ElementRef.current()' },
  TemplateRef: { swift: 'TemplateRef.current()', kotlin: 'TemplateRef.current()' },
  ViewContainerRef: { swift: 'ViewContainerRef.current()', kotlin: 'ViewContainerRef.current()' },
  NativeDialogRef: { swift: 'NativeDialogRef.current', kotlin: 'NativeDialogRef.current' },
  Renderer2: { swift: 'Renderer2.current', kotlin: 'Renderer2.current' },
  RendererFactory2: { swift: 'RendererFactory2.current', kotlin: 'RendererFactory2.current' },
};

/**
 * What `inject(token)` at `at` gives: the kit's instance for a framework token, else the app's service.
 * `ChangeDetectorRef.current()` binds dynamically via `AngularView.construct` frames during component construction.
 */
export function injected(backend: 'swift' | 'kotlin', token: string, _at: ts.Node, shared = 'shared'): string {
  return Object.hasOwn(INJECTION_TOKENS, token) ? INJECTION_TOKENS[token][backend] : `${token}.${shared}`;
}

const CORE_MODULE = /[\\/]@angular[\\/]core[\\/]|^\/__shims__\/_angular_core\.d\.ts$/;

/** Whether `e` calls @angular/core's `name` (`computed`), by the callee's declaration (the package's, or the compiler's shim of it): a program's own function of that name is an ordinary call. */
export function angularCall(e: ts.Node | undefined, name: string, checker: ts.TypeChecker): e is ts.CallExpression {
  if (!e || !ts.isCallExpression(e)) return false;
  const at = ts.isPropertyAccessExpression(e.expression) ? e.expression.name : e.expression;
  let sym = checker.getSymbolAtLocation(at);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  return sym?.name === name && !!sym.declarations?.some((d) => CORE_MODULE.test(d.getSourceFile().fileName));
}

/**
 * How a backend makes an `@Injectable` class. An app's is a service the injector makes, `'based'` when it extends a
 * class (then translated as any class is). A package's is a plain class, as the providers of its tokens are not compiled,
 * unless it names its own injector (`providedIn`): then `'root'`, a plain class the injector also makes, one per class.
 */
export function injectableRole(cls: ts.ClassDeclaration, pluginFiles: ReadonlySet<string>): 'service' | 'based' | 'root' | undefined {
  const decorator = (ts.getDecorators(cls) ?? []).find((d) => d.expression.getText().startsWith('Injectable'));
  if (!decorator) return undefined;
  if (pluginFiles.has(cls.getSourceFile().fileName)) {
    const options = ts.isCallExpression(decorator.expression) ? decorator.expression.arguments[0] : undefined;
    const providedIn = options && ts.isObjectLiteralExpression(options)
      ? options.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === 'providedIn')?.initializer
      : undefined;
    return providedIn && ts.isStringLiteral(providedIn) && ['root', 'platform', 'any'].includes(providedIn.text) ? 'root' : undefined;
  }
  return cls.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword) ? 'based' : 'service';
}

/**
 * The static a backend reads an `@Injectable` class's root instance from. A package's class, and its subclasses, keep
 * `shared` as a name of their own (a static `shared` of the package's is its member): theirs is the kit's `jsShared`.
 */
export function injectableShared(cls: ts.ClassDeclaration, pluginFiles: ReadonlySet<string>, checker: ts.TypeChecker): 'shared' | 'jsShared' {
  for (let c: ts.Declaration | undefined = cls; c && ts.isClassDeclaration(c) && !c.getSourceFile().isDeclarationFile; ) {
    if (injectableRole(c, pluginFiles) === 'root') return 'jsShared';
    const h = c.heritageClauses?.find((x) => x.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
    c = h && checker.getTypeAtLocation(h.expression).getSymbol()?.valueDeclaration;
  }
  return 'shared';
}

/** Whether a declaration is a class the injector makes: the app's `@Injectable`, a package's that names its injector, the runtime's services. */
export function isInjectableClass(decl: ts.Declaration | undefined, pluginFiles: ReadonlySet<string>): boolean {
  if (!decl || !ts.isClassDeclaration(decl) || decl.getSourceFile().isDeclarationFile) return false;
  const fn = decl.getSourceFile().fileName;
  if (core.adapterRuntimeFile(fn) === 'runtime/angular-rx.ts' || core.adapterRuntimeFile(fn) === 'runtime/angular.ts') return true;
  // @angular/forms' and @angular/cdk's services: root instances via static `shared`.
  if (core.adapterRuntimeFile(fn) === 'runtime/angular-forms.ts' || core.adapterRuntimeFile(fn) === 'runtime/angular-cdk.ts') return decl.members.some((m) => (ts.isPropertyDeclaration(m) || ts.isGetAccessorDeclaration(m)) && isStatic(m) && m.name.getText() === 'shared');
  if (pluginFiles.has(fn)) return injectableRole(decl, pluginFiles) === 'root';
  return (ts.getDecorators(decl) ?? []).some((d) => /^Injectable\b/.test(d.expression.getText()));
}

/** A constructor parameter's injection as its decorators say: the `@Inject(token)` token, whether it may be absent, whether it skips its own injector. */
export function parameterDecorators(p: ts.ParameterDeclaration): { token?: ts.Expression; optional: boolean; skipSelf: boolean } {
  let token: ts.Expression | undefined;
  let optional = !!(p.questionToken || p.initializer);
  let skipSelf = false;
  for (const d of ts.getDecorators(p) ?? []) {
    const e = d.expression;
    const which = ts.isCallExpression(e) ? e.expression.getText() : e.getText();
    if (which === 'Inject' && ts.isCallExpression(e) && e.arguments[0]) token = e.arguments[0];
    else if (which === 'Optional') optional = true;
    else if (which === 'SkipSelf') skipSelf = true;
  }
  return { token, optional, skipSelf };
}

/** `forwardRef(() => X)` is `X`. */
export function forwardRefTarget(e: ts.Expression): ts.Expression {
  return ts.isCallExpression(e) && e.expression.getText() === 'forwardRef' && e.arguments[0] && (ts.isArrowFunction(e.arguments[0]) || ts.isFunctionExpression(e.arguments[0])) && !ts.isBlock(e.arguments[0].body) ? e.arguments[0].body : e;
}

/** The services `injectThrows` is working out, so that services injecting each other end. */
const injecting = new Set<ts.Node>();

/**
 * Angular's `inject(token)` makes a root service the first time, throwing what its constructor throws; core's Page
 * is the kit's `Page.injected()`, which can make one.
 */
function injectThrows(token: ts.Node, t: ThrowsView): boolean {
  if (ts.isCallExpression(token)) token = forwardRefTarget(token);
  let s = t.checker.getSymbolAtLocation(token);
  if (s && s.flags & ts.SymbolFlags.Alias) s = t.checker.getAliasedSymbol(s);
  const decl = s?.valueDeclaration;
  if (!decl || !ts.isClassLike(decl)) return false;
  if (/[\\/]@nativescript[\\/]core[\\/]/.test(decl.getSourceFile().fileName)) return decl.name?.text === 'Page';
  if (core.adapterRuntimeFile(decl.getSourceFile().fileName) === 'runtime/angular-rx.ts') return decl.name?.text === 'ActivatedRoute';
  if (decl.getSourceFile().isDeclarationFile || /[\\/]node_modules[\\/]/.test(decl.getSourceFile().fileName) || injecting.has(decl)) return false;
  if (ts.isClassDeclaration(decl) && core.adapterRuntimeFile(decl.getSourceFile().fileName) !== 'runtime/angular.ts' && !ts.getDecorators(decl)?.some((d) => /^Injectable\b/.test(d.expression.getText()))) return false;
  injecting.add(decl);
  try { return t.initThrows(decl); } finally { injecting.delete(decl); }
}

const throwsModel: ThrowsModel = {
  rethrowing: ['untracked', 'runInInjectionContext', 'PurePipeCache.*', 'NgZone.run', 'NgZone.runOutsideAngular', 'NgZone.runGuarded', 'NgZone.runTask'],
  injectsConstructor: (cls) => ts.isClassDeclaration(cls) && !!ts.getDecorators(cls)?.some((d) => /^Injectable\b/.test(d.expression.getText())),
  injects(p, t) {
    const { token, optional, skipSelf } = parameterDecorators(p);
    if (optional && skipSelf) return false;
    if (token) return injectThrows(token, t);
    const ref = p.type && ts.isTypeReferenceNode(p.type)
      ? p.type
      : p.type && ts.isUnionTypeNode(p.type)
        ? p.type.types.find(ts.isTypeReferenceNode)
        : undefined;
    return ref ? injectThrows(ref.typeName, t) : false;
  },
  injectCall(decl, args, t) {
    if (!args[0] || !((ts.isFunctionDeclaration(decl) && decl.name?.text === 'inject') || (ts.isMethodDeclaration(decl) && decl.name.getText() === 'get' && ts.isClassDeclaration(decl.parent) && decl.parent.name?.text === 'Injector'))) return undefined;
    return injectThrows(args[0], t);
  },
};

/** Angular's class decorators, as @angular/core (or the compiler's shim of it) declares them. */
const CLASS_DECORATORS = new Set(['Component', 'Directive', 'Pipe', 'Injectable', 'NgModule']);
const METHOD_DECORATORS = new Set(['HostListener']);
const LIFECYCLE_HOOKS = new Set(['ngOnChanges', 'ngOnInit', 'ngDoCheck', 'ngAfterContentInit', 'ngAfterContentChecked', 'ngAfterViewInit', 'ngAfterViewChecked', 'ngOnDestroy']);

function angularDecorator(d: ts.Decorator, names: ReadonlySet<string>, checker: ts.TypeChecker): boolean {
  const e = ts.isCallExpression(d.expression) ? d.expression.expression : d.expression;
  let sym = checker.getSymbolAtLocation(e);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  return !!sym && names.has(sym.name) && !!sym.declarations?.some((x) => /^\/__shims__\/_angular_core\.d\.ts$|[\\/]@angular[\\/]core[\\/]/.test(x.getSourceFile().fileName));
}

/**
 * The `equal` options of a signal `signal(v, options)` or `linkedSignal(…)` makes: the call's second argument, or
 * `linkedSignal`'s first where it is given `{ source, computation }`.
 */
function signalOptions(call: ts.Expression | undefined, checker: ts.TypeChecker): { options: ts.Expression | undefined } | undefined {
  if (angularCall(call, 'signal', checker)) return { options: call.arguments[1] };
  if (angularCall(call, 'linkedSignal', checker)) {
    const first = call.arguments[0];
    return { options: first && checker.getTypeAtLocation(first).getCallSignatures().length === 0 ? first : call.arguments[1] };
  }
  return undefined;
}

/** What reading a required input, or reading or updating a required model, throws before its parent's binding first sets it. */
const NG0950 = 'NG0950: Input is required but no value is available yet. Find more at https://v22.angular.dev/errors/NG0950';
const NG0952 = 'NG0952: Model is required but no value is available yet.';

/** What both back ends and their analyses read of Angular's API. */
export const model: FrameworkModel = {
  plainFields: true,
  wrapsRootViews: true,
  signalTypes: { InputSignal: 'input', InputSignalWithTransform: 'input', ModelSignal: 'model', Signal: 'computed' },
  // `input()` outside a component (a directive's): a signal the template sets.
  signalConstructors: { signal: { equality: 'identity', options: 1 }, model: 'identity', input: { equality: 'identity', typed: true }, linkedSignal: { equality: 'identity', linked: true } },
  memos: { computed: '@angular/core' },
  heldSignals: ['toSignal'],
  pure: ['signal', 'computed'],
  classDecorators: ['NgModule', 'Injectable'],
  componentDecorator: 'Component',
  componentValueType: 'ComponentFactory',
  prefixedModules: { rxjs: 'Rx' },
  untypedInterfaces: ['@angular#forms'],
  untypedPackageInterfaces: ['@angular/'],
  throwsModel,
  unsetError(field) {
    const init = field.initializer;
    if (!init || !ts.isCallExpression(init) || !/^(input|model)\.required$/.test(init.expression.getText())) return undefined;
    if (!ts.isClassDeclaration(field.parent) || !ts.getDecorators(field.parent)?.some((d) => /^Component\b/.test(d.expression.getText()))) return undefined;
    return init.expression.getText() === 'model.required' ? NG0952 : NG0950;
  },
  signalOptions,
  classRole: injectableRole,
  addedStatics: (cls, pluginFiles, checker) => (injectableRole(cls, pluginFiles) ? [injectableShared(cls, pluginFiles, checker), 'jsSharedInstance', 'jsConstruct'] : []),
  frameworkCalled(cls, name, checker) {
    if (!ts.getDecorators(cls)!.every((d) => angularDecorator(d, CLASS_DECORATORS, checker))) return 'a method of a decorated class';
    if (LIFECYCLE_HOOKS.has(name)) return 'an Angular lifecycle hook';
    // The template glue this compiler writes calls its own methods (`$b3`, `$e4`) with whatever they declare.
    if (name.startsWith('$') && !/^\$[be]\d+$/.test(name)) return "a template's binding";
    return undefined;
  },
  calledByFramework(cls, m, checker) {
    if (ts.getDecorators(m)?.some((d) => angularDecorator(d, METHOD_DECORATORS, checker))) return true;
    if (!ts.getDecorators(cls)?.some((d) => angularDecorator(d, CLASS_DECORATORS, checker))) return false;
    return LIFECYCLE_HOOKS.has(m.name.getText()) || !(ts.isPrivateIdentifier(m.name) || ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Private);
  },
  unsetMembers: isLinkedSignalPreviousSource,
  erasesGenericClass(cls) {
    if (!cls.typeParameters?.length) return false;
    if (ts.getDecorators(cls)?.some((d) => /^(Component|Directive|Injectable|Pipe)\b/.test(d.expression.getText()))) return true;
    const sf = cls.getSourceFile();
    return sf.text.slice(cls.pos, cls.getStart(sf)).includes('@ng-declarable');
  },
};

/** Whether `d` is `previous.source` of Angular's `linkedSignal({ source, computation })` (shim, package typings, or inline callback annotation). */
export function isLinkedSignalPreviousSource(d: ts.Declaration, checker: ts.TypeChecker): boolean {
  if (!ts.isPropertySignature(d) || !ts.isIdentifier(d.name) || d.name.text !== 'source' || !ts.isTypeLiteralNode(d.parent)) return false;
  let t: ts.Node = d.parent;
  while (t.parent && (ts.isParenthesizedTypeNode(t.parent) || ts.isUnionTypeNode(t.parent))) t = t.parent;
  const param = t.parent;
  if (!param || !ts.isParameter(param) || !ts.isFunctionLike(param.parent)) return false;
  const fn = param.parent;
  if (fn.parameters[1] !== param) return false;
  if (CORE_MODULE.test(d.getSourceFile().fileName)) {
    const compProp = fn.parent;
    if (!compProp || !ts.isPropertySignature(compProp) || !ts.isIdentifier(compProp.name) || compProp.name.text !== 'computation') return false;
    if (ts.isInterfaceDeclaration(compProp.parent) && /LinkedSignalOptions$/.test(compProp.parent.name.text)) return true;
    const optsParam = ts.isTypeLiteralNode(compProp.parent) ? compProp.parent.parent : undefined;
    const linkedFn = optsParam && ts.isParameter(optsParam) ? optsParam.parent : undefined;
    return !!linkedFn && ts.isFunctionDeclaration(linkedFn) && linkedFn.name?.text === 'linkedSignal';
  }
  let fnExpr: ts.Node = fn;
  while (fnExpr.parent && (ts.isParenthesizedExpression(fnExpr.parent) || ts.isParenthesizedTypeNode(fnExpr.parent) || ts.isAsExpression(fnExpr.parent) || ts.isTypeAssertionExpression(fnExpr.parent) || ts.isSatisfiesExpression(fnExpr.parent) || ts.isConditionalExpression(fnExpr.parent))) fnExpr = fnExpr.parent;
  const prop = fnExpr.parent;
  if (!prop || !ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name) || prop.name.text !== 'computation' || !ts.isObjectLiteralExpression(prop.parent)) return false;
  let opts: ts.Node = prop.parent;
  while (opts.parent && ts.isParenthesizedExpression(opts.parent)) opts = opts.parent;
  return angularCall(opts.parent, 'linkedSignal', checker) && opts.parent.arguments[0] === opts;
}
