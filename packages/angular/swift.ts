// Angular as Swift: injection, signals, standalone components, services and NgModules.
import type { SwiftTranslatorView as Translator, TranslatorHooks } from '@nstudio/nativescript-compiler/adapter-api';
import { core, ts } from './core-api.ts';
import { ngModuleDef, standaloneImports } from './ng-modules.ts';
import { KIT_TOKENS, angularCall, forwardRefTarget, injectableRole, injectableShared, injected, isInjectableClass, isLinkedSignalPreviousSource, model, parameterDecorators } from './semantics.ts';

/** An injection token's name: a framework class by the name it is declared with (`NativeDialog` is `NativeDialogService`), or a compiled class by its emitted name. */
function tokenName(t: Translator, e: ts.Expression | ts.EntityName): string {
  const decl = t.resolve(e)?.declarations?.[0];
  if (decl && ts.isClassDeclaration(decl) && decl.name) {
    return decl.getSourceFile().isDeclarationFile ? decl.name.text : t.topName(decl, decl.name.text);
  }
  return e.getText();
}

/** What `inject(token)` gives at `at`; a ViewContainerRef has no instance whose views would attach to the component's. */
function injectedToken(t: Translator, token: string, at: ts.Node, decl?: ts.Declaration): string {
  if (token === 'ViewContainerRef') throw t.error(at, 'an injected ViewContainerRef', 'view-container-ref');
  return injected('swift', token, at, decl && ts.isClassDeclaration(decl) ? injectableShared(decl, t.pluginFiles, t.checker) : undefined);
}

/** A class only a library's typings declare has no instance in a release build: the library's JavaScript provides it. */
function refuseTypingsOnlyToken(t: Translator, tokenDecl: ts.Declaration | undefined, token: string, at: ts.Node): void {
  if (tokenDecl && ts.isClassDeclaration(tokenDecl) && tokenDecl.getSourceFile().isDeclarationFile && !core.isCoreDeclaration(tokenDecl)) throw t.error(at, `an injected class only a library's typings declare (${token})`, 'library-injectable');
}

function parameterInject(t: Translator, p: ts.ParameterDeclaration): string | undefined {
  const { swift } = core;
  const pt = t.typeOf(p.name);
  const { token: given, optional, skipSelf } = parameterDecorators(p);
  if (optional && skipSelf) return swift.isOptional(pt) || pt.endsWith('!') || pt === 'Any?' ? 'nil' : t.fromAny('nil', pt);
  const injectArg = given && forwardRefTarget(given);
  if (injectArg) {
    const target = ts.isExpressionWithTypeArguments(injectArg) ? injectArg.expression : injectArg;
    const token = tokenName(t, target);
    if (token === 'NATIVE_DIALOG_DATA') return t.fromAny('NativeDialogRef.current.data', pt);
    const tokenDecl = t.resolve(target)?.declarations?.[0];
    if (KIT_TOKENS.includes(token) || isInjectableClass(tokenDecl, t.pluginFiles)) {
      const throws = token === 'Page' || (token === 'ActivatedRoute' && core.adapterRuntimeFile(tokenDecl?.getSourceFile().fileName) === 'runtime/angular-rx.ts') || (tokenDecl && ts.isClassDeclaration(tokenDecl) && core.adapterRuntimeFile(tokenDecl.getSourceFile().fileName) !== 'runtime/angular-rx.ts' && t.throwsInfo.initThrows(tokenDecl));
      return swift.tryIf(throws, injectedToken(t, token, p, tokenDecl));
    }
    refuseTypingsOnlyToken(t, tokenDecl, token, p);
    const raw = `Injector.inject(${t.coerce(injectArg, 'Any?')}${optional ? ', JSObject([("optional", true)])' : ''})`;
    return pt === 'Any?' ? raw : t.fromAny(raw, pt);
  }
  const ref = p.type && ts.isTypeReferenceNode(p.type)
    ? p.type
    : p.type && ts.isUnionTypeNode(p.type)
      ? p.type.types.find(ts.isTypeReferenceNode)
      : undefined;
  if (ref) {
    const token = tokenName(t, ref.typeName);
    const tokenDecl = t.resolve(ref.typeName)?.declarations?.[0];
    if (KIT_TOKENS.includes(token) || isInjectableClass(tokenDecl, t.pluginFiles)) {
      const throws = token === 'Page' || (token === 'ActivatedRoute' && core.adapterRuntimeFile(tokenDecl?.getSourceFile().fileName) === 'runtime/angular-rx.ts') || (tokenDecl && ts.isClassDeclaration(tokenDecl) && core.adapterRuntimeFile(tokenDecl.getSourceFile().fileName) !== 'runtime/angular-rx.ts' && t.throwsInfo.initThrows(tokenDecl));
      return swift.tryIf(throws, injectedToken(t, token, p, tokenDecl));
    }
    if (tokenDecl && ts.isClassDeclaration(tokenDecl)) {
      refuseTypingsOnlyToken(t, tokenDecl, token, p);
      const raw = `Injector.inject(${token}.self${optional ? ', JSObject([("optional", true)])' : ''})`;
      return pt === 'Any?' ? raw : t.fromAny(raw, pt);
    }
  }
  return undefined;
}

/** `inject(token)` and `injector.get(token)`: a kit token's instance or the app's service, else what the injector gives. */
function injection(t: Translator, call: ts.CallExpression, given: ts.Expression, made: (raw: string) => string): string {
  const rawArg0 = forwardRefTarget(given);
  const target = ts.isExpressionWithTypeArguments(rawArg0) ? rawArg0.expression : rawArg0;
  const token = tokenName(t, target);
  if (token === 'NATIVE_DIALOG_DATA') return t.fromAny('NativeDialogRef.current.data', t.typeOf(call));
  const tokenDecl = t.resolve(target)?.declarations?.[0];
  if (KIT_TOKENS.includes(token) || isInjectableClass(tokenDecl, t.pluginFiles)) return injectedToken(t, token, call, tokenDecl);
  refuseTypingsOnlyToken(t, tokenDecl, token, call);
  const raw = made(t.coerce(rawArg0, 'Any?'));
  const type = t.typeOf(call);
  return type === 'Any?' ? raw : t.fromAny(raw, type);
}

/** `linkedSignal({ source, computation })`: `computation`'s `previous` is the runtime's pair made the parameter's object. */
function linkedSignal(t: Translator, options: ts.ObjectLiteralExpression, type: string, equals: string): string {
  const prop = (n: string) => {
    const p = options.properties.find((q) => q.name && ts.isIdentifier(q.name) && q.name.text === n);
    if (!p) return undefined;
    if (ts.isPropertyAssignment(p)) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p)) return p.name;
    throw t.error(p, `a \`${n}\` of linkedSignal's options other than a property`);
  };
  const source = prop('source'), computation = prop('computation');
  if (!source || !computation) throw t.error(options, 'linkedSignal options without both `source` and `computation`');
  const c = t.checker;
  const sig = c.getResolvedSignature(options.parent as ts.CallExpression)!;
  const opts = c.getTypeOfSymbol(sig.parameters[0]);
  const s = t.type(c.getTypeOfSymbol(c.getPropertyOfType(opts, 'source')!).getCallSignatures()[0].getReturnType(), options);
  const compSig = c.getTypeOfSymbol(c.getPropertyOfType(opts, 'computation')!).getCallSignatures()[0];
  const compActual = c.getTypeAtLocation(computation).getCallSignatures()[0];
  const takesPrevious = (compActual?.parameters.length ?? 2) > 1;
  const prevParam = takesPrevious ? (compActual?.parameters[1] ?? compSig.parameters[1]) : undefined;
  const prevObj = prevParam ? c.getNonNullableType(c.getTypeOfSymbol(prevParam)) : undefined;
  const prevType = prevObj ? t.type(prevObj, options) : undefined;
  const sourceProp = prevObj?.getProperty('source');
  const sourceDecl = sourceProp?.valueDeclaration ?? sourceProp?.declarations?.[0];
  const sourceOpt = !!(sourceProp && (sourceProp.flags & ts.SymbolFlags.Optional)) || (!!sourceDecl && (ts.isPropertySignature(sourceDecl) || ts.isPropertyDeclaration(sourceDecl)) && isLinkedSignalPreviousSource(sourceDecl, c)) || core.swift.isOptional(s);
  const pSource = core.swift.isOptional(s) ? '(p.source ?? nil)' : 'p.source';
  const read = t.symbolName(source) === 'WritableSignal' || t.symbolName(source) === 'Signal' ? `{ () throws -> ${s} in ${t.signalRead(source)} }` : t.expr(source);
  const made = prevType && /^Object_\w+$/.test(prevType)
    ? sourceOpt
      ? `${prevType}(source: ${pSource}, value: p.value)`
      : t.fromAnyCode(`JSObject([("source", ${pSource}), ("value", p.value)])`, prevType)
    : `JSObject([("source", ${pSource}), ("value", p.value)])`;
  return `Signal<${type}>(source: ${read}, computation: { (s: ${s}, previous: (source: ${s}?, value: ${type})?) throws -> ${type} in try (${t.expr(computation)})(s${prevType ? `, previous.map { p in ${made} }` : ''}) }${equals})`;
}

/** Whether a `linkedSignal(…)` call resolves to the overload taking `{ source, computation }` rather than a function. */
function linkedOptionsOverload(t: Translator, e: ts.CallExpression): boolean {
  const first = t.checker.getResolvedSignature(e)?.parameters[0];
  return !!first && t.checker.getTypeOfSymbol(first).getCallSignatures().length === 0;
}

/**
 * `linkedSignal(options)` with options other than a literal: `source`, `computation` and `equal` read by name once, as
 * the signal is made, as Angular reads them. `previous` is made the type the options' own `computation` declares, which
 * is what the function held there takes.
 */
function linkedSignalOptions(t: Translator, options: ts.Expression, type: string, reference: boolean): string {
  const c = t.checker;
  const sig = c.getResolvedSignature(options.parent as ts.CallExpression)!;
  const opts = c.getTypeOfSymbol(sig.parameters[0]);
  const s = t.type(c.getTypeOfSymbol(c.getPropertyOfType(opts, 'source')!).getCallSignatures()[0].getReturnType(), options);
  const held = c.getPropertyOfType(c.getNonNullableType(c.getTypeAtLocation(options)), 'computation');
  const prevParam = held && c.getNonNullableType(c.getTypeOfSymbol(held)).getCallSignatures()[0]?.parameters[1];
  const prevType = prevParam ? t.type(c.getNonNullableType(c.getTypeOfSymbol(prevParam)), options) : 'Any?';
  const pSource = core.swift.isOptional(s) ? '(p.source ?? nil)' : 'p.source';
  const previous = t.fromAnyCode(`JSObject([("source", ${pSource}), ("value", p.value)])`, prevType);
  const fallback = reference ? 'jsSame(a, b)' : core.swift.isFunctionType(type) ? 'false' : 'a == b';
  const equal = `jsEqualOption(__o, default: { (a: ${type}, b: ${type}) -> Bool in ${fallback} })`;
  return `{ (__o: Any?) -> Signal<${type}> in let __source = (try? jsGet(__o, "source")) ?? nil; let __computation = (try? jsGet(__o, "computation")) ?? nil; `
    + `return Signal<${type}>(source: { () throws -> ${s} in let v = try jsCall(__source); return ${t.fromAnyCode('v', s)} }, `
    + `computation: { (s: ${s}, previous: (source: ${s}?, value: ${type})?) throws -> ${type} in let p: Any? = previous.map { p in ${previous} }; let v = try jsCall(__computation, s, p); return ${t.fromAnyCode('v', type)} }, `
    + `equals: ${c.getNonNullableType(c.getTypeAtLocation(options)).getProperty('equal') ? equal : `jsReportingEquals(${equal})`}) }(${t.coerce(options, 'Any?')})`;
}

function globalCall(t: Translator, name: string, e: ts.CallExpression, decl: ts.Declaration | undefined, lib: boolean): string | undefined {
  const arg = (k: number) => e.arguments[k];
  const { swift } = core;
  if (name === 'linkedSignal' && lib) {
    const type = t.typeOf(e).replace(/^Signal<(.*)>$/, '$1');
    const reference = !['Double', 'String', 'Bool'].includes(type.replace(/\?$/, '')) && !swift.isFunctionType(type);
    const options = arg(0) && ts.isObjectLiteralExpression(ts.skipOuterExpressions(arg(0))) ? ts.skipOuterExpressions(arg(0)) as ts.ObjectLiteralExpression : undefined;
    const fallback = reference ? ', equals: { jsSame($0, $1) }' : '';
    if (!options && linkedOptionsOverload(t, e)) return linkedSignalOptions(t, arg(0), type, reference);
    if (!options) return `Signal<${type}>(linked: ${t.expr(arg(0))}${t.equalsArg(arg(1), type) ?? fallback})`;
    return linkedSignal(t, options, type, t.equalsArg(options, type) ?? (reference ? fallback : ', equals: { $0 == $1 }'));
  }
  if (name === 'computed' && angularCall(e, 'computed', t.checker) && t.typeOf(e).startsWith('Signal<')) {
    const fn = arg(0);
    const rt = t.typeOf(e).replace(/^Signal<(.*)>$/, '$1');
    if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) return `Signal<${rt}>(${t.memo(fn, rt, !core.isAsync(fn) && t.throwsInfo.fn(fn))})`;
    const equals = t.equalsArg(arg(1), rt, true);
    return `Signal<${rt}>(Memo<${rt}>(${t.expr(fn)}${equals ?? ''}))`;
  }
  if (name === 'untracked' && lib) return `untrack(${t.expr(arg(0))})`;
  if (name === 'runInInjectionContext' && lib) {
    const fn = arg(1);
    if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
      const type = t.typeOf(e);
      const throws = t.throwsInfo.fn(fn);
      return `Injector.runInContext(${t.restArgument(e, arg(0), 'Any?')}) { ()${throws ? ' throws' : ''} -> ${type} in${t.functionBody(fn, type, t.indent).slice(1)}`;
    }
    return `Injector.runInContext(${t.restArgument(e, arg(0), 'Any?')}, ${t.expr(arg(1))})`;
  }
  if ((name === 'forwardRef' || name === 'resolveForwardRef') && lib) {
    const fn = arg(0);
    if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && !ts.isBlock(fn.body)) return t.expr(fn.body);
    return `resolveForwardRef(${arg(0) ? t.restArgument(e, arg(0), 'Any?') : 'nil'})`;
  }
  if (name === 'isDevMode' && lib) return 'false';
  const shimmed = decl && ts.isFunctionDeclaration(decl) && decl.getSourceFile().fileName.startsWith('/__shims__/') ? decl.name?.text : undefined;
  if (shimmed === 'enableProdMode') return '()';
  if (shimmed === 'isAngularHmrRestoringRoute') return 'false';
  if (name === 'output' && lib) return `${t.typeOf(e)}()`;
  if (name === 'inject' && lib) return injection(t, e, arg(0), (token) => `Injector.inject(${token}${arg(1) ? `, ${t.restArgument(e, arg(1), 'Any?')}` : ''})`);
  if (name === 'effect' && lib) return `Effect.deferred(${t.callback(arg(0))})`;
  if (name === 'toSignal' && lib) {
    const options = arg(1) && ts.isObjectLiteralExpression(arg(1)) ? arg(1) as ts.ObjectLiteralExpression : undefined;
    const initial = options?.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === 'initialValue');
    const inner = t.typeOf(e).replace(/^Signal<(.*)>$/, '$1');
    return `toSignal(${t.expr(arg(0))}${initial ? `, initialValue: ${t.coerce(initial.initializer, inner)}` : ''})`;
  }
  if (name === 'firstValueFrom' && lib) return `rxFirstValueFrom(${t.expr(arg(0))})`;
  if (name === 'registerElement' && (lib || core.adapterRuntimeFile(decl?.getSourceFile().fileName) === 'runtime/angular-rx.ts')) {
    return e.arguments.length >= 3 && arg(2)
      ? `kitRegisterViewMeta(${t.str(arg(0))}, ${t.coerce(arg(1), 'Any?')}, ${t.coerce(arg(2), 'Any?')})`
      : '()';
  }
  return undefined;
}

function methodCall(t: Translator, owner: string, method: string, e: ts.CallExpression): string | undefined {
  const target = (e.expression as ts.PropertyAccessExpression).expression;
  if ((owner === 'OutputEmitterRef' || owner === 'EventEmitter') && (method === 'emit' || method === 'next')) {
    const value = /^(?:OutputEmitterRef|EventEmitter|Emitter)<(.*)>[?!]?$/.exec(t.typeOf(target))?.[1];
    const a = e.arguments[0];
    return `${t.expr(target)}.emit(${a ? (value && value !== 'Void' && value !== 'Unit' ? t.coerce(a, value) : t.expr(a)) : ''})`;
  }
  if (owner === 'Injector' && method === 'get' && e.arguments[0]) {
    const rawArg0 = forwardRefTarget(e.arguments[0]);
    const tokTarget = ts.isExpressionWithTypeArguments(rawArg0) ? rawArg0.expression : rawArg0;
    const token = tokenName(t, tokTarget);
    if (token === 'ViewContainerRef') throw t.error(e, 'an injected ViewContainerRef', 'view-container-ref');
    const tokenDecl = t.resolve(tokTarget)?.declarations?.[0];
    if ((KIT_TOKENS.includes(token) || isInjectableClass(tokenDecl, t.pluginFiles)) && e.arguments.length === 1 && t.throwsInfo.expr(e)) return injectedToken(t, token, e, tokenDecl);
    const raw = `${t.expr(target)}.get(${t.coerce(rawArg0, 'Any?')}${e.arguments[1] ? `, ${t.coerce(e.arguments[1], 'Any?')}` : ''}${e.arguments[2] ? `, ${t.coerce(e.arguments[2], 'Any?')}` : ''})`;
    const type = t.typeOf(e);
    return type === 'Any?' ? raw : t.fromAny(raw, type);
  }
  // `http.get<T>(url, options)` / `http.post<T>(url, body, options)`: the parsed body read as T.
  if (owner === 'HttpClient' && ['get', 'delete', 'head', 'options', 'post', 'put', 'patch', 'request'].includes(method) && t.typeOf(e).startsWith('RxObservable<')) {
    const value = /^RxObservable<(.*)>$/.exec(t.typeOf(e))?.[1] ?? 'Any?';
    const call = method === 'request'
      ? `${t.expr(target)}.request(${t.str(e.arguments[0])}, ${e.arguments[1] ? t.str(e.arguments[1]) : '""'}${e.arguments[2] ? `, ${t.coerce(e.arguments[2], 'Any?')}` : ''})`
      : ['post', 'put', 'patch'].includes(method)
        ? `${t.expr(target)}.${method}(${t.str(e.arguments[0])}${e.arguments[1] ? `, ${t.coerce(e.arguments[1], 'Any?')}` : ', nil'}${e.arguments[2] ? `, ${t.coerce(e.arguments[2], 'Any?')}` : ''})`
        : `${t.expr(target)}.${method}(${t.str(e.arguments[0])}${e.arguments[1] ? `, ${t.coerce(e.arguments[1], 'Any?')}` : ''})`;
    return value === 'Any?' ? call : `${call}.mapValues { (__v: Any?) -> ${value} in ${t.fromAny('__v', value)} }`;
  }
  return undefined;
}

/** A source base class the injector also makes, whose `shared` this class's overrides: each class has its own root instance. */
function injectableBase(t: Translator, cls: ts.ClassLikeDeclaration): boolean {
  for (let b = t.sourceBase(cls); b; b = t.sourceBase(b)) if (ts.isClassDeclaration(b) && ['based', 'root'].includes(injectableRole(b, t.pluginFiles) ?? '')) return true;
  return false;
}

/**
 * What makes a class the injector makes as a root service: an extension of it, or class members when a base class's
 * are overridden (an extension cannot override) or when its subclasses may override them.
 */
function injectableStatics(t: Translator, cls: ts.ClassDeclaration, code: string, form: 'extension' | 'class' | 'override'): string[] {
  const name = ts.isModuleBlock(cls.parent) ? cls.name!.text : t.topName(cls, cls.name!.text);
  const ctor = cls.members.find((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m) && !!m.body);
  const args = (ctor?.parameters ?? []).map((p) => t.constructorParameter(p));
  const throwsInit = /^\s*(?:override )?(?:convenience )?init\(.*\) throws/m.test(code) || (ctor?.parameters ?? []).some((p) => t.throwsInfo.injects(p));
  const make = core.swift.tryIf(throwsInit, `${name}(${args.join(', ')})`);
  const mods = form === 'extension' ? 'static' : form === 'class' ? 'class' : 'override class';
  const shared = injectableShared(cls, t.pluginFiles, t.checker);
  const members = [
    throwsInit ? `    ${mods} var ${shared}: ${name} { get throws { try Injector.root(${name}.self) { ${make} } } }` : `    ${mods} var ${shared}: ${name} { Injector.root(${name}.self, making: { ${make} }) }`,
    `    ${mods} var jsSharedInstance: Any? { get throws { ${throwsInit ? 'try ' : ''}${shared} } }`,
    `    ${mods} func jsConstruct() throws -> Any? { ${make} }`,
  ];
  return form === 'extension' ? [`extension ${name}: JSInjectableType {`, ...members, '}'] : members;
}

/**
 * What the injector reads of an NgModule: its metadata, evaluated once as the decorator is, and how it is made, its
 * constructor's parameters injected.
 */
function ngModuleStatics(t: Translator, cls: ts.ClassDeclaration, name: string, def: NonNullable<ReturnType<typeof ngModuleDef>>, code: string): string[] {
  const ctor = cls.members.find((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m) && !!m.body);
  const args = (ctor?.parameters ?? []).map((p) => t.constructorParameter(p));
  const throwsInit = /^\s*(?:override )?(?:convenience )?init\(.*\) throws/m.test(code) || (ctor?.parameters ?? []).some((p) => t.throwsInfo.injects(p));
  return [
    `    static let jsNgImports: Any? = JSArray<Any?>([${def.imports.map((e) => t.coerce(e, 'Any?')).join(', ')}])`,
    `    static let jsNgProviders: Any? = ${def.providers ? t.coerce(def.providers, 'Any?') : 'nil'}`,
    `    static func jsNgConstruct() throws -> Any? { ${core.swift.tryIf(throwsInit, `${name}(${args.join(', ')})`)} }`,
  ];
}

export const swiftHooks: TranslatorHooks<Translator> = {
  ...model,
  typeMap: {
    OutputEmitterRef: 'Emitter<$0>',
    EventEmitter: 'Emitter<$0>',
    LetSlot: { type: 'LetSlot<$0>', shim: true },
    RouterExtensions: { type: 'Router', shim: true },
    EnvironmentInjector: { type: 'Injector', shim: true },
    ...Object.fromEntries(['RxObservable', 'RxSubject', 'RxBehaviorSubject', 'RxReplaySubject'].map((n) => [n, { type: `${n}<$0>`, shim: true }])),
    ...Object.fromEntries(['NativeDialogRef', 'NativeDialogService', 'DestroyRef', 'Injector', 'InjectionToken', 'ErrorHandler', 'NgZone', 'HttpClient', 'ChangeDetectorRef', 'PurePipeCache', 'NodeInjector', 'ElementRef', 'SimpleChange',
      'TeardownHandle', 'NavigationEnd', 'NavigationStart', 'NavigationCancel', 'NavigationError', 'RoutesRecognized', 'ResolveStart', 'ResolveEnd',
      'KitHttpClient', 'KitActivatedRoute', 'KitRouter', 'KitNativeDialogRef', 'KitNativeDialogService',
      'HttpParams', 'HttpHeaders', 'HttpResponse', 'HttpErrorResponse', 'HttpRequest', 'HttpContext', 'HttpContextToken',
      'ParamMap', 'UrlSegment', 'UrlTree', 'DefaultUrlSerializer', 'ActivatedRouteSnapshot',
      'ViewContainerRef', 'TemplateRef', 'ComponentRef', 'EmbeddedViewRef', 'ApplicationRef', 'Location'].map((n) => [n, { type: n, shim: true, metatype: true }])),
  },
  globalCall,
  methodCall,
  newCall: (t, name, e) => (name === 'Inject' && e.arguments?.[0] && t.resolve(e.expression)?.declarations?.[0]?.getSourceFile().fileName.startsWith('/__shims__/') ? `(${t.coerce(e.arguments[0], 'Any?')} as Any?)` : undefined),
  constructorParameter: parameterInject,
  componentField(t, m) {
    const callee = m.initializer ? t.calleeName(m.initializer) : '';
    if (callee !== 'input' && callee !== 'input.required' && callee !== 'model' && callee !== 'model.required') return undefined;
    // An Angular input is a prop: a signal the parent writes.
    const type = t.typeOf(m.name).replace(/^Signal<(.*)>$/, '$1');
    const given = (m.initializer as ts.CallExpression).arguments[0];
    return { prop: { type, default: given ? (type.startsWith('JSNullish<') ? t.stored(given, given, type) : t.expr(given)) : callee === 'input' || callee === 'model' ? 'nil' : undefined } };
  },
  /** A standalone component's imports as its root-view injector reads them, evaluated once as the decorator is. */
  componentStatics(t, cls) {
    const ngImports = standaloneImports(cls, t.checker, t.compiles);
    return ngImports ? [`    static let jsNgImports: Any? = JSArray<Any?>([${ngImports.map((e) => t.coerce(e, 'Any?')).join(', ')}])`] : [];
  },
  componentAsValue: (t, cls, type) => `ComponentFactory { ${t.rootView(cls, type, `try AngularView.construct { ${t.throwsInfo.initThrows(cls) ? 'try ' : ''}${type}() }.${t.components.get(cls.name!.text)!.members.render}()`)} }`,
  /** A component created as a root view (bootstrap, route, dialog): made and rendered in its standalone injector. */
  wrapRootView: (t, cls, type, make) => (standaloneImports(cls, t.checker, t.compiles) ? `try Injector.standalone(${type}.self, ${type}.jsNgImports) { ${make} }` : make),
  serviceClass(t, cls, name) {
    const members = t.componentMembers(cls, [], true);
    // A constructor that throws throws from the inject() that made it, and the next inject() makes the service again.
    const throwsInit = members.some((m) => /^\s*(?:convenience )?init\(.*\) throws/m.test(m));
    const shared = throwsInit
      ? [
          `    static var shared: ${name} { get throws { try Injector.root(${name}.self) { try ${name}() } } }`,
          `    static var jsSharedInstance: Any? { get throws { try shared } }`,
          `    static func jsConstruct() throws -> Any? { try ${name}() }`,
        ]
      : [
          `    static var shared: ${name} { Injector.root(${name}.self, making: { ${name}() }) }`,
          `    static var jsSharedInstance: Any? { shared }`,
          `    static func jsConstruct() throws -> Any? { ${name}() }`,
        ];
    return [`final class ${name}: JSInjectableType {`, core.swift.NONISOLATED_DEINIT, ...shared, '', ...members, '}'].join('\n');
  },
  // An app's @Injectable class extending another class: translated as any class is, and made by the injector as a service is.
  afterClass: (t, cls, code) => (injectableRole(cls, t.pluginFiles) === 'based' && !injectableBase(t, cls) ? injectableStatics(t, cls, code, 'extension').join('\n') : undefined),
  classExtras(t, cls, name, code) {
    const supertypes: string[] = [];
    const members: string[] = [];
    const role = injectableRole(cls, t.pluginFiles);
    if (role === 'root' || (role === 'based' && injectableBase(t, cls))) {
      const overrides = injectableBase(t, cls);
      if (!overrides) supertypes.push('JSInjectableType');
      members.push(...injectableStatics(t, cls, code, overrides ? 'override' : 'class'));
    }
    const ngModule = ngModuleDef(cls, t.checker, t.compiles);
    if (ngModule) {
      supertypes.push('JSNgModuleType');
      members.push(...ngModuleStatics(t, cls, name, ngModule, [code, ...members].join('\n')));
    }
    return { supertypes, members };
  },
};
