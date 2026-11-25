// Angular as Kotlin: injection, signals, standalone components, services and NgModules.
import type { KotlinTranslatorView as Translator, TranslatorHooks } from '@nstudio/nativescript-compiler/adapter-api';
import { core, ts } from './core-api.ts';
import { ngModuleDef, standaloneImports } from './ng-modules.ts';
import { KIT_TOKENS, angularCall, forwardRefTarget, injectableRole, injectableShared, injected, isInjectableClass, isLinkedSignalPreviousSource, isStatic, model, parameterDecorators } from './semantics.ts';

/** An injection token's name: a framework class by the name it is declared with (`NativeDialog` is `NativeDialogService`). */
function tokenName(t: Translator, e: ts.Expression | ts.EntityName): string {
  const decl = t.resolve(e)?.declarations?.[0];
  if (!decl || !ts.isClassDeclaration(decl) || !decl.name) return e.getText();
  const file = decl.getSourceFile();
  if (file.fileName.startsWith('/__shims__/')) return decl.name.text;
  // A program's class by its Kotlin name, whatever the import calls it (`RouterExtensions as $RouterExtensions`).
  return file.isDeclarationFile ? e.getText() : t.topName(decl, decl.name.text);
}

/** What `inject(token)` gives at `at`; a ViewContainerRef has no instance whose views would attach to the component's. */
function injectedToken(t: Translator, token: string, at: ts.Node, decl?: ts.Declaration): string {
  if (token === 'ViewContainerRef') throw t.error(at, 'an injected ViewContainerRef', 'view-container-ref');
  const code = injected('kotlin', token, at, decl && ts.isClassDeclaration(decl) ? injectableShared(decl, t.pluginFiles, t.checker) : undefined);
  // A `shared` the module's statements initialize is held nullable until they run, which they have by injection.
  const shared = decl && ts.isClassDeclaration(decl) ? decl.members.find((m): m is ts.PropertyDeclaration => ts.isPropertyDeclaration(m) && isStatic(m) && m.name.getText() === 'shared') : undefined;
  return shared && t.heldUntilModuleRuns(shared) && code === `${token}.shared` ? `${code}!!` : code;
}

/** A class only a library's typings declare has no instance in a release build: the library's JavaScript provides it. */
function refuseTypingsOnlyToken(t: Translator, tokenDecl: ts.Declaration | undefined, token: string, at: ts.Node): void {
  if (tokenDecl && ts.isClassDeclaration(tokenDecl) && tokenDecl.getSourceFile().isDeclarationFile && !core.isCoreDeclaration(tokenDecl)) throw t.error(at, `an injected class only a library's typings declare (${token})`, 'library-injectable');
}

function parameterInject(t: Translator, p: ts.ParameterDeclaration): string | undefined {
  const pt = t.typeOf(p.name);
  const { token: given, optional, skipSelf } = parameterDecorators(p);
  if (optional && skipSelf) return core.kotlin.isNullable(pt) || pt === 'Any?' ? 'null' : t.fromAny('null', pt);
  const injectArg = given && forwardRefTarget(given);
  if (injectArg) {
    const target = ts.isExpressionWithTypeArguments(injectArg) ? injectArg.expression : injectArg;
    const token = tokenName(t, target);
    if (token === 'NATIVE_DIALOG_DATA') return t.fromAny('NativeDialogRef.current.data', pt);
    const tokenDecl = t.resolve(target)?.declarations?.[0];
    if (KIT_TOKENS.includes(token) || isInjectableClass(tokenDecl, t.pluginFiles)) return injectedToken(t, token, p, tokenDecl);
    refuseTypingsOnlyToken(t, tokenDecl, token, p);
    const raw = `Injector.inject(${t.coerce(injectArg, 'Any?')}${optional ? ', JSObject("optional" to true)' : ''})`;
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
    if (KIT_TOKENS.includes(token) || isInjectableClass(tokenDecl, t.pluginFiles)) return injectedToken(t, token, p, tokenDecl);
    if (tokenDecl && ts.isClassDeclaration(tokenDecl)) {
      refuseTypingsOnlyToken(t, tokenDecl, token, p);
      const raw = `Injector.inject(${token}::class.java${optional ? ', JSObject("optional" to true)' : ''})`;
      return pt === 'Any?' ? raw : t.fromAny(raw, pt);
    }
  }
  return undefined;
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
  const sourceOpt = !!(sourceProp && (sourceProp.flags & ts.SymbolFlags.Optional)) || (!!sourceDecl && (ts.isPropertySignature(sourceDecl) || ts.isPropertyDeclaration(sourceDecl)) && isLinkedSignalPreviousSource(sourceDecl, c)) || s.endsWith('?');
  const sOpt = s.endsWith('?') ? s : `${s}?`;
  const read = t.typeOf(source).startsWith('Signal<') ? `{ ${t.expr(source)}.value }` : t.symbolName(source) === 'Signal' ? `{ ${t.expr(source)} }` : t.expr(source);
  const made = prevType && /^Object_\w+$/.test(prevType)
    ? sourceOpt
      ? `${prevType}(source = it.first, value = it.second)`
      : t.fromAny('JSObject("source" to it.first, "value" to it.second)', prevType)
    : 'JSObject("source" to it.first, "value" to it.second)';
  return `Signal.linked<${s}, ${type}>(${read}, { s: ${s}, p: Pair<${sOpt}, ${type}>? -> (${t.expr(computation)})(s${prevType ? `, p?.let { ${made} }` : ''}) }${equals})`;
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
  const previous = t.fromAny('JSObject("source" to it.first, "value" to it.second)', prevType);
  const sOpt = s.endsWith('?') ? s : `${s}?`;
  const fallback = reference ? '::jsSame' : `{ a: ${type}, b: ${type} -> a == b }`;
  return `run { val __o: Any? = ${t.coerce(options, 'Any?')}; val __source = jsGetOptional(__o, "source"); val __computation = jsGetOptional(__o, "computation"); `
    + `Signal.linked<${s}, ${type}>({ ${t.fromAny('jsCall(__source)', s)} }, { s: ${s}, p: Pair<${sOpt}, ${type}>? -> ${t.fromAny(`jsCall(__computation, s, p?.let { ${previous} })`, type)} }, jsEqualOption<${type}>(__o, ${fallback})) }`;
}

function globalCall(t: Translator, name: string, e: ts.CallExpression, decl: ts.Declaration | undefined, lib: boolean): string | undefined {
  const arg = (k: number) => e.arguments[k];
  if (name === 'linkedSignal' && lib) {
    const type = t.typeOf(e).replace(/^Signal<(.*)>$/, '$1');
    const reference = !['Double', 'String', 'Boolean'].includes(type.replace(/\?$/, '')) && !core.kotlin.isFunctionType(type);
    const fallback = reference ? ', ::jsSame' : '';
    const options = arg(0) && ts.isObjectLiteralExpression(ts.skipOuterExpressions(arg(0))) ? ts.skipOuterExpressions(arg(0)) as ts.ObjectLiteralExpression : undefined;
    if (!options && linkedOptionsOverload(t, e)) return linkedSignalOptions(t, arg(0), type, reference);
    if (!options) return `Signal.linked<${type}>(${t.expr(arg(0))}${t.equalsArg(arg(1), type) ?? fallback})`;
    return linkedSignal(t, options, type, t.equalsArg(options, type) ?? fallback);
  }
  if (name === 'computed' && angularCall(e, 'computed', t.checker) && t.typeOf(e).startsWith('Signal<')) {
    const fn = arg(0), rt = t.typeOf(e).replace(/^Signal<(.*)>$/, '$1');
    if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) return `Signal.computed(${t.memo(fn, rt, t.indent)})`;
    return `Signal.computed(Memo<${rt}>(${t.coerce(fn, `() -> ${rt}`)}${t.equalsArg(arg(1), rt) ?? ''}))`;
  }
  if (name === 'untracked' && lib) return `untrack(${t.expr(arg(0))})`;
  if (name === 'runInInjectionContext' && lib) {
    const fn = arg(1);
    if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
      const type = t.typeOf(e);
      return `Injector.runInContext(${t.restArgument(e, arg(0), 'Any?')}, ${t.closure(fn, `() -> ${type}`)})`;
    }
    const raw = `Injector.runInContext(${t.restArgument(e, arg(0), 'Any?')}) { jsCall(${t.restArgument(e, arg(1), 'Any?')}) }`;
    const type = t.typeOf(e);
    return type === 'Any?' || type === 'Unit' ? raw : t.fromAny(raw, type);
  }
  if ((name === 'forwardRef' || name === 'resolveForwardRef') && lib) {
    const fn = arg(0);
    if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && !ts.isBlock(fn.body)) return t.expr(fn.body);
    return `resolveForwardRef(${arg(0) ? t.restArgument(e, arg(0), 'Any?') : 'null'})`;
  }
  if (name === 'isDevMode' && lib) return 'false';
  const shimmed = decl && ts.isFunctionDeclaration(decl) && decl.getSourceFile().fileName.startsWith('/__shims__/') ? decl.name?.text : undefined;
  if (shimmed === 'enableProdMode') return 'Unit';
  if (shimmed === 'isAngularHmrRestoringRoute') return 'false';
  if (name === 'effect' && lib && arg(0)) return `Effect.deferred(${t.callback(arg(0))})`;
  if (name === 'output' && lib) return `${t.typeOf(e)}()`;
  if (name === 'inject' && lib) {
    const rawArg0 = forwardRefTarget(arg(0));
    const target = ts.isExpressionWithTypeArguments(rawArg0) ? rawArg0.expression : rawArg0;
    const token = tokenName(t, target);
    if (token === 'NATIVE_DIALOG_DATA') return t.fromAny('NativeDialogRef.current.data', t.typeOf(e));
    const tokenDecl = t.resolve(target)?.declarations?.[0];
    if (KIT_TOKENS.includes(token) || isInjectableClass(tokenDecl, t.pluginFiles)) return injectedToken(t, token, e, tokenDecl);
    refuseTypingsOnlyToken(t, tokenDecl, token, e);
    const raw = `Injector.inject(${t.coerce(rawArg0, 'Any?')}${arg(1) ? `, ${t.restArgument(e, arg(1), 'Any?')}` : ''})`;
    const type = t.typeOf(e);
    return type === 'Any?' ? raw : t.fromAny(raw, type);
  }
  if (name === 'firstValueFrom' && lib) return `rxFirstValueFrom(${t.expr(arg(0))})`;
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
    if (tokenName(t, ts.isExpressionWithTypeArguments(rawArg0) ? rawArg0.expression : rawArg0) === 'ViewContainerRef') throw t.error(e, 'an injected ViewContainerRef', 'view-container-ref');
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
        ? `${t.expr(target)}.${method}(${t.str(e.arguments[0])}${e.arguments[1] ? `, ${t.coerce(e.arguments[1], 'Any?')}` : ', null'}${e.arguments[2] ? `, ${t.coerce(e.arguments[2], 'Any?')}` : ''})`
        : `${t.expr(target)}.${method}(${t.str(e.arguments[0])}${e.arguments[1] ? `, ${t.coerce(e.arguments[1], 'Any?')}` : ''})`;
    return value === 'Any?' ? call : `${call}.mapValues { __v: Any? -> ${t.fromAny('__v', value)} }`;
  }
  return undefined;
}

export const kotlinHooks: TranslatorHooks<Translator> = {
  ...model,
  typeMap: {
    OutputEmitterRef: 'Emitter<$0>',
    EventEmitter: 'Emitter<$0>',
    LetSlot: { type: 'LetSlot<$0>', shim: true },
    RouterExtensions: 'Router',
    EnvironmentInjector: { type: 'Injector', shim: true },
    // kit-android's NativeDialogService takes its config as script gives it.
    NativeDialogConfig: { type: 'Any?', shim: true },
    ...Object.fromEntries(['NativeDialogRef', 'NativeDialogService', 'DestroyRef', 'Injector', 'InjectionToken', 'ErrorHandler', 'NgZone', 'HttpClient', 'ChangeDetectorRef', 'PurePipeCache', 'NodeInjector', 'ElementRef', 'SimpleChange',
      'TeardownHandle', 'NavigationEnd', 'NavigationStart', 'NavigationCancel', 'NavigationError', 'RoutesRecognized', 'ResolveStart', 'ResolveEnd',
      'HttpParams', 'HttpHeaders', 'HttpResponse', 'HttpErrorResponse', 'HttpRequest', 'HttpContext', 'HttpContextToken',
      'ParamMap', 'UrlSegment', 'UrlTree', 'DefaultUrlSerializer', 'ActivatedRouteSnapshot',
      'ViewContainerRef', 'TemplateRef', 'ComponentRef', 'EmbeddedViewRef', 'ApplicationRef', 'Location'].map((n) => [n, { type: n, shim: true }])),
  },
  globalCall,
  methodCall,
  // `deps: [new Inject(TOKEN)]` names the token itself.
  newCall: (t, name, e) => (name === 'Inject' && e.arguments?.[0] && t.resolve(ts.skipParentheses(e.expression))?.declarations?.[0]?.getSourceFile().fileName.startsWith('/__shims__/') ? t.coerce(e.arguments[0], 'Any?') : undefined),
  constructorParameter: parameterInject,
  componentField(t, m, name) {
    const callee = m.initializer ? t.calleeName(m.initializer) : '';
    if (callee === 'input' || callee === 'input.required' || callee === 'model' || callee === 'model.required') {
      const type = t.typeOf(m.name).replace(/^Signal<(.*)>$/, '$1');
      const given = (m.initializer as ts.CallExpression).arguments[0];
      return { prop: { type, default: given ? (type.startsWith('JSNullish<') ? t.stored(given, given, type) : t.coerce(given, type)) : callee === 'input' || callee === 'model' ? (type.startsWith('JSNullish<') ? 'JSNullish.Undefined' : 'null') : undefined } };
    }
    if (callee !== 'toSignal') return undefined;
    // A signal of the source's latest value, read as a computed is: by its name.
    const ident = core.kotlin.ident;
    const [source, options] = (m.initializer as ts.CallExpression).arguments;
    const type = t.typeOf(m.name);
    const initial = options && ts.isObjectLiteralExpression(options) ? options.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === 'initialValue') : undefined;
    // rxjs compiled from source: the program's `toSignal`, a signal of any value, its value read as the field types it.
    const program = t.resolve((m.initializer as ts.CallExpression).expression)?.declarations?.some((d) => !d.getSourceFile().isDeclarationFile);
    if (program) return { lines: [`    private val __${name}: Signal<Any?> = ${t.fromAny(t.expr(m.initializer!), 'Signal<Any?>')}`, `    val ${ident(name)}: ${type}`, `        get() = ${t.fromAny(`__${name}.value`, type)}`] };
    if (!initial) throw t.error(m, 'toSignal without an initialValue');
    return { lines: [`    private val __${name}: Signal<${type}> = toSignal(${t.expr(source)}, ${t.coerce(initial.initializer, type)})`, `    val ${ident(name)}: ${type}`, `        get() = __${name}.value`] };
  },
  componentStatics(t, cls) {
    const ngImports = standaloneImports(cls, t.checker, t.compiles);
    return ngImports ? [`        val jsNgImports: Any? by lazy { jsArrayOf<Any?>(${ngImports.map((e) => t.coerce(e, 'Any?')).join(', ')}) }`] : [];
  },
  componentAsValue: (t, cls, type) => `ComponentFactory { ${t.rootView(cls, type, `AngularView.construct { ${type}() }.${t.components.get(cls.name!.text)!.members.render}()`)} }`,
  /** A component created as a root view (bootstrap, route, dialog): made and rendered in its standalone injector. */
  wrapRootView: (t, cls, type, make) => (standaloneImports(cls, t.checker, t.compiles) ? `Injector.standalone(${type}::class.java, ${type}.jsNgImports) { ${make} }` : make),
  serviceClass(t, cls, name) {
    const { params, lines, statics } = t.componentMembers(cls, [], true);
    return [`class ${name}(${params.join(', ')}) {`, ...lines, '', '    companion object {', `        val shared: ${name} get() = AppInjector.service(${name}::class.java) { ${name}() }`, ...statics, '    }', '}'].join('\n');
  },
  classExtras(t, cls, name) {
    const ident = core.kotlin.ident;
    const members: string[] = [];
    const role = injectableRole(cls, t.pluginFiles);
    if (role === 'based' || role === 'root') {
      const ctor = cls.members.find((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m) && !!m.body);
      const made = `${ident(name)}(${(ctor?.parameters ?? []).map((p) => t.constructorParameter(p)).join(', ')})`;
      members.push(`        val ${injectableShared(cls, t.pluginFiles, t.checker)}: ${ident(name)} get() = AppInjector.service(${ident(name)}::class.java) { ${made} }`);
      // The kit makes a class of a no-argument constructor itself; one whose constructor injects needs this.
      if (ctor?.parameters.length) members.push(`        fun jsConstruct(): Any? = ${made}`);
    }
    // What the injector reads of an NgModule: its metadata, evaluated once as the decorator is, and how it is made.
    const ngModule = ngModuleDef(cls, t.checker, t.compiles);
    if (ngModule) {
      const ctor = cls.members.find((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m) && !!m.body);
      members.push(
        `        override val jsNgImports: Any? by lazy { jsArrayOf<Any?>(${ngModule.imports.map((e) => t.coerce(e, 'Any?')).join(', ')}) }`,
        `        override val jsNgProviders: Any? by lazy { ${ngModule.providers ? t.coerce(ngModule.providers, 'Any?') : 'null'} }`,
        `        override fun jsNgConstruct(): Any? = ${ident(name)}(${(ctor?.parameters ?? []).map((p) => t.constructorParameter(p)).join(', ')})`,
      );
    }
    return { members, companionSupertype: ngModule ? 'JSNgModuleDef' : undefined };
  },
};
