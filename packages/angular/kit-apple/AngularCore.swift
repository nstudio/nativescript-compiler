import Foundation

// @angular/core as compiled Angular apps call it: dependency injection, the references it injects, bootstrap.

public typealias EffectRef = Effect

/// `inject(PendingTasks)`: tracks pending async tasks (no-op in compiled native apps).
public final class PendingTasks {
    nonisolated deinit {}
    public static let shared = PendingTasks()
    public init() {}
    public func add() -> () -> Void { {} }
    public func run<T>(_ task: () throws -> T) rethrows -> T { try task() }
}

/// `inject(DestroyRef)`: callbacks run when the injecting component's scope ends.
public final class DestroyRef {
    nonisolated deinit {}
    private weak var owner: Owner?
    init(_ owner: Owner?) { self.owner = owner }
    public static func current() -> DestroyRef { DestroyRef(Owner.current) }

    @discardableResult
    public func onDestroy(_ callback: @escaping () -> Void) -> () -> Void {
        var active = true
        owner?.onCleanup { if active { callback() } }
        return { active = false }
    }

    @discardableResult
    public func onDestroy(_ callback: @escaping () throws -> Void) -> () -> Void {
        onDestroy { () -> Void in jsReport(callback) }
    }
}

/// `ElementRef`: a view of a template, as a view query (`@ViewChild('ref', { read: ElementRef })`) gives it.
public final class ElementRef {
    nonisolated deinit {}
    public private(set) var nativeElement: Any?
    public init(_ nativeElement: Any? = nil) { self.nativeElement = nativeElement }

    /// A component's own ElementRef, made with the component: its template's root view, once made.
    public func attach(_ host: Any?) { nativeElement = host }

    private static var hosts: [Any?] = []

    /// Makes a directive of an element: its `inject(ElementRef)` is the element.
    public static func hosting<T>(_ host: Any?, _ make: () throws -> T) rethrows -> T {
        hosts.append(host)
        defer { hosts.removeLast() }
        return try make()
    }

    /// `inject(ElementRef)`: the element whose directive is being made; elsewhere, a ref to no view.
    public static func current() -> ElementRef { ElementRef(hosts.last ?? nil) }
}

/// `SimpleChange`: one input's change, as `ngOnChanges` receives it.
public final class SimpleChange {
    nonisolated deinit {}
    public var previousValue: Any?
    public var currentValue: Any?
    public var firstChange: Bool
    public init(_ previousValue: Any?, _ currentValue: Any?, _ firstChange: Bool) {
        self.previousValue = previousValue
        self.currentValue = currentValue
        self.firstChange = firstChange
    }
    public func isFirstChange() -> Bool { firstChange }
}

public protocol JSInjectableType: AnyObject {
    static var jsSharedInstance: Any? { get throws }
    static func jsConstruct() throws -> Any?
}

public protocol JSTokenKeyed: AnyObject {
    var jsTokenKey: Any.Type? { get }
}

public func forwardRef(_ fn: @escaping () throws -> Any?) -> Any? { fn }

/// Angular's `booleanAttribute` input transform: `false` / `"false"` / `null` / `undefined` → `false`, else `true`.
public func booleanAttribute(_ value: Any?) -> Bool {
    guard let v = jsFlat(value), !jsIsNullish(v) else { return false }
    if let b = v as? Bool { return b }
    return jsToString(v) != "false"
}

/// Angular's `numberAttribute` input transform: parses a finite number or returns `fallbackValue` (`NaN`).
public func numberAttribute(_ value: Any?, _ fallbackValue: Double = .nan) -> Double {
    guard let v = jsFlat(value), !jsIsNullish(v) else { return fallbackValue }
    if let s = v as? String, s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return fallbackValue }
    let n = jsToNumber(v)
    return n.isNaN ? fallbackValue : n
}

public func resolveForwardRef(_ value: Any?) -> Any? {
    guard let flat = jsFlat(value) else { return nil }
    if let fn = flat as? () throws -> Any? { return jsReported { try fn() } ?? nil }
    if let fn = flat as? () -> Any? { return fn() }
    return value
}

public final class SkipSelf {
    nonisolated deinit {}
    public init() {}
}

public final class Host {
    nonisolated deinit {}
    public init() {}
}

public final class Inject {
    nonisolated deinit {}
    public let token: Any?
    public init(_ token: Any?) { self.token = token }
}

public typealias NodeInjector = Injector

/// `inject(Injector)`; supports hierarchical child injectors (`Injector.create`) as well as root providers.
public final class Injector {
    nonisolated deinit {}
    public static let shared = Injector()
    public static var root: Injector { current ?? shared }
    /// Kept by each effect and template scope as it is made, and current again while they run.
    static var current: Injector? {
        get { EffectOrder.ambient as? Injector }
        set { EffectOrder.ambient = newValue }
    }

    private let parent: Injector?
    /// A component's injector (`enter`): what its providers make belongs to the component, and goes when it does.
    private var owner: Owner?
    private var entered: Injector?
    private var instanceValues: [ObjectIdentifier: Any?] = [:]
    private var instanceFactories: [ObjectIdentifier: () throws -> Any?] = [:]
    private var instanceMultiFactories: [ObjectIdentifier: [() throws -> Any?]] = [:]
    /// `StandaloneService`, provided per environment injector: each standalone component's own injector there, or nil
    /// when its imports give no providers.
    private var standaloneInjectors: [ObjectIdentifier: Injector?] = [:]
    /// A root view's injector made under component injectors (`enter`): those are asked first, up to the environment
    /// injector they sit in, then the standalone injector (`parent`), as Angular asks element injectors first.
    private var viewNodes: Injector?
    private var viewEnvironment: Injector?
    private static let notFound = NSObject()

    public init(_ providers: Any? = nil, _ parent: Injector? = nil) {
        self.parent = parent
        if providers != nil {
            registerInstance(providers)
        }
    }

    public static func create(_ options: Any?, _ parent: Injector? = nil) -> Injector {
        guard let flat = jsFlat(options) else { return Injector(nil, parent) }
        if flat is JSArrayProtocol {
            return Injector(flat, parent).initialized()
        }
        let providers = (try? jsGet(flat, "providers")) ?? flat
        let resolvedParent = (jsFlat((try? jsGet(flat, "parent")) ?? nil) as? Injector) ?? parent
        return Injector(providers, resolvedParent).initialized()
    }

    /// `@Component({ providers })`: the component's own injector over the one it is made in, current from the
    /// component's first field to the end of its constructor (`leave()`), and in its view (`EffectOrder.view`).
    public static func enter(_ providers: Any?) -> Injector {
        let node = Injector(providers, current)
        node.owner = Owner()
        node.entered = current
        current = node
        return node
    }

    public func provideSelf(_ instance: Any?) {
        guard let flat = jsFlat(instance) else { return }
        let obj = flat as AnyObject
        instanceValues[ObjectIdentifier(type(of: obj))] = obj
    }

    public func leave() { Injector.current = entered }

    /// `createRootViewInjector`: a standalone component created as a root view (bootstrap, route, dialog) is made and
    /// rendered in its standalone injector, made from its imports the first time it is created over this environment
    /// injector, which then runs the initializers that construct its modules.
    public static func standalone<T>(_ type: Any.Type, _ imports: Any?, _ make: () throws -> T) rethrows -> T {
        let active = current ?? shared
        var environment = active
        while environment.owner != nil { environment = environment.parent ?? shared }
        let key = ObjectIdentifier(type)
        let injector: Injector?
        if let cached = environment.standaloneInjectors[key] {
            injector = cached
        } else {
            var out: [Any?] = []
            var dedup = Set<ObjectIdentifier>()
            ngDeepForEach(imports) { _ = walkNgModule($0, &out, &dedup) }
            injector = out.isEmpty ? nil : Injector(JSArray<Any?>(out), environment).initialized()
            environment.standaloneInjectors[key] = injector
        }
        guard let injector else { return try make() }
        if active === environment { return try runInContext(injector, make) }
        let view = Injector(nil, injector)
        view.viewNodes = active
        view.viewEnvironment = environment
        return try runInContext(view, make)
    }

    private func owned<T>(_ body: () -> T) -> T {
        guard let owner else { return body() }
        return untrack { owner.run(body) }
    }

    public func get(_ token: Any?, _ notFoundValue: Any? = nil, _ options: Any? = nil) -> Any? {
        get(token, notFoundValue, options, root: true)
    }

    /// Without `root`, only what this injector and its ancestors provide: the root's answer for a service is the
    /// service's `shared`, which itself asks the active injector first.
    private func get(_ token: Any?, _ notFoundValue: Any?, _ options: Any?, root: Bool, until: Injector? = nil) -> Any? {
        let unwrapped = resolveForwardRef(token)
        let skipSelf = ((try? jsGet(options, "skipSelf")) as? Bool) == true
        let selfOnly = ((try? jsGet(options, "self")) as? Bool) == true
        if !skipSelf, let key = Injector.tokenKey(unwrapped) {
            if let entry = instanceValues[key] { return entry }
            if let multis = instanceMultiFactories[key], !multis.isEmpty {
                let values = multis.map { fn in owned { Injector.runInContext(self) { jsReported { try fn() } ?? nil } } }
                let arr = JSArray<Any?>(values)
                instanceValues[key] = arr
                return arr
            }
            if let factory = instanceFactories[key] {
                let val = owned { Injector.runInContext(self) { jsReported { try factory() } ?? nil } }
                instanceValues[key] = val
                return val
            }
        }
        if selfOnly { return notFoundValue }
        if let nodes = viewNodes {
            let found = nodes.get(unwrapped, Injector.notFound, nil, root: false, until: viewEnvironment)
            if (found as? NSObject) !== Injector.notFound { return found }
        }
        if let parent {
            if parent === until { return notFoundValue }
            return parent.get(unwrapped, notFoundValue, nil, root: root, until: until)
        }
        if skipSelf || !root { return notFoundValue }
        return Injector.resolveRoot(unwrapped, notFoundValue: notFoundValue)
    }

    public static func runInContext<T>(_ injector: Any?, _ fn: () throws -> T) rethrows -> T {
        let prev = current
        current = (jsFlat(injector) as? Injector) ?? shared
        defer { current = prev }
        return try fn()
    }

    /// A root service, made as the root injector makes it: whatever component first injects it, its effects
    /// and its `DestroyRef` belong to the application, what its constructor reads subscribes no binding, and what
    /// it injects comes from the root, not from the providers of the component that injected it.
    public static func root<T>(_ make: () throws -> T) rethrows -> T {
        let active = current
        current = nil
        defer { current = active }
        return try untrack { try Owner(parent: nil).run(make) }
    }

    private static var made: [ObjectIdentifier: AnyObject] = [:]
    private static var making: Set<ObjectIdentifier> = []

    /// A root service whose constructor can throw, kept once one is made: an inject() throws what the constructor
    /// throws, and the next inject() makes it again. A service whose construction injects itself is Angular's
    /// circular-dependency error.
    public static func root<T: AnyObject>(_ type: T.Type, _ make: () throws -> T) throws -> T {
        let key = ObjectIdentifier(type)
        if let active = current, active !== shared {
            if let over = active.get(type, nil, nil, root: false) as? T { return over }
        }
        if let over = tokenValues[key] as? T { return over }
        if let factory = tokenFactories[key], let over = try factory() as? T {
            tokenValues[key] = over
            return over
        }
        if let service = made[key] as? T { return service }
        guard making.insert(key).inserted else { throw JSException(JSError("NG0200: Circular dependency in DI detected for \(type)")) }
        defer { making.remove(key) }
        let service = try root(make)
        made[key] = service
        return service
    }

    /// A root service whose constructor cannot throw, so neither can the inject() that makes it: a provider's factory
    /// that throws for it, or its construction injecting itself, stops the app with that error.
    public static func root<T: AnyObject>(_ type: T.Type, making make: () -> T) -> T {
        do { return try root(type, { () throws -> T in make() }) } catch { fatalError(jsErrorOf(jsCaught(error)).message) }
    }

    private static var tokenValues: [ObjectIdentifier: Any?] = [:]
    private static var tokenFactories: [ObjectIdentifier: () throws -> Any?] = [:]
    private static var multiFactories: [ObjectIdentifier: [() throws -> Any?]] = [:]

    private static func tokenKey(_ token: Any?) -> ObjectIdentifier? {
        guard let token = jsFlat(resolveForwardRef(token)) else { return nil }
        if let keyed = token as? JSTokenKeyed, let t = keyed.jsTokenKey { return ObjectIdentifier(t) }
        if let type = token as? Any.Type { return ObjectIdentifier(type) }
        return ObjectIdentifier(token as AnyObject)
    }

    /// `inject(ErrorHandler)`: the one provided, else Angular's own.
    public static var errorHandler: ErrorHandler { inject(ErrorHandler.self) as? ErrorHandler ?? ErrorHandler.standard }

    /// The `ErrorHandler` the app provides, which hears what no script code caught, as Angular's zone hands it over.
    static func providedErrorHandler() -> ErrorHandler? {
        guard let key = tokenKey(ErrorHandler.self), tokenValues[key] != nil || tokenFactories[key] != nil else { return nil }
        return resolveRoot(ErrorHandler.self) as? ErrorHandler
    }

    public static func reset() {
        made.removeAll()
        making.removeAll()
        tokenValues.removeAll()
        tokenFactories.removeAll()
        multiFactories.removeAll()
        current = nil
    }

    public static func provide(_ token: Any?, useValue: Any? = nil, useFactory: (() throws -> Any?)? = nil) {
        guard let key = tokenKey(token) else { return }
        if let useFactory {
            tokenFactories[key] = useFactory
            tokenValues.removeValue(forKey: key)
        } else {
            tokenValues[key] = useValue
            tokenFactories.removeValue(forKey: key)
        }
    }

    private static func parseProvider(_ dyn: JSDynamic, into target: Injector?) {
        let token = resolveForwardRef(dyn[jsKey: "provide"])
        guard let key = tokenKey(token) else { return }
        let isMulti = (jsFlat(dyn[jsKey: "multi"]) as? Bool) == true
        let hasValue = (dyn as? JSObject)?.has("useValue") == true || jsHasKey(dyn, "useValue")
        let val = dyn[jsKey: "useValue"]
        let factory = jsFlat(dyn[jsKey: "useFactory"])
        let existing = jsFlat(dyn[jsKey: "useExisting"])
        let useClass = jsFlat(resolveForwardRef(dyn[jsKey: "useClass"]))
        let deps = (jsFlat(dyn[jsKey: "deps"]) as? JSArrayProtocol)?.jsAnyElements ?? []
        let make: () throws -> Any? = {
            if hasValue { return val }
            if let factory {
                let resolved: [Any?] = deps.map { dep in
                    if let arr = jsFlat(dep) as? JSArrayProtocol {
                        let elems = arr.jsAnyElements
                        for el in elems {
                            if jsFlat(el) is SkipSelf { return nil }
                        }
                        if let last = elems.last {
                            if let target { return target.get(last) }
                            return Injector.inject(last)
                        }
                    }
                    if let target { return target.get(dep) }
                    return Injector.inject(dep)
                }
                if deps.isEmpty, let zero = factory as? () throws -> Any? { return try zero() }
                if deps.isEmpty, let zero = factory as? () -> Any? { return zero() }
                return try jsCall(factory, spread: resolved)
            }
            if let existing {
                if let target { return target.get(existing) }
                return Injector.inject(existing)
            }
            if let injectable = useClass as? JSInjectableType.Type {
                return try injectable.jsConstruct()
            }
            if let ctor = useClass as? JSConstructibleType.Type { return try ctor.jsConstruct([]) }
            if let fn = useClass { return try jsCall(fn, spread: []) }
            if let injectable = jsFlat(token) as? JSInjectableType.Type {
                return try injectable.jsConstruct()
            }
            return nil
        }
        if let target {
            if isMulti {
                target.instanceMultiFactories[key, default: []].append(make)
                target.instanceValues.removeValue(forKey: key)
            } else {
                target.instanceFactories[key] = make
                target.instanceValues.removeValue(forKey: key)
            }
        } else {
            if isMulti {
                multiFactories[key, default: []].append(make)
                tokenValues.removeValue(forKey: key)
            } else {
                tokenFactories[key] = make
                tokenValues.removeValue(forKey: key)
            }
        }
    }

    private func registerInstance(_ providers: Any?) {
        var initializers: [() throws -> Any?] = []
        func walk(_ item: Any?) {
            guard let flat = jsFlat(item) else { return }
            if let arr = flat as? JSArrayProtocol {
                for el in arr.jsAnyElements { walk(el) }
                return
            }
            if let fn = flat as? () throws -> Any? {
                initializers.append(fn)
                return
            }
            if let fn = flat as? () -> Void {
                initializers.append({ fn(); return nil })
                return
            }
            // A class: its own instance, as `{ provide: X, useClass: X }`.
            if let injectable = flat as? JSInjectableType.Type, let key = Injector.tokenKey(flat) {
                instanceFactories[key] = { try injectable.jsConstruct() }
                instanceMultiFactories.removeValue(forKey: key)
                instanceValues.removeValue(forKey: key)
                return
            }
            if let ctor = flat as? JSConstructibleType.Type, let key = Injector.tokenKey(flat) {
                instanceFactories[key] = { try ctor.jsConstruct([]) }
                instanceMultiFactories.removeValue(forKey: key)
                instanceValues.removeValue(forKey: key)
                return
            }
            if let dyn = flat as? JSDynamic {
                if jsHasKey(dyn, "providers") || (dyn as? JSObject)?.has("providers") == true {
                    walk(dyn[jsKey: "providers"])
                }
                if jsHasKey(dyn, "provide") || (dyn as? JSObject)?.has("provide") == true {
                    Injector.parseProvider(dyn, into: self)
                }
            }
        }
        walk(providers)
        pendingInitializers = initializers
    }

    /// An environment injector's `ENVIRONMENT_INITIALIZER`s, run once it is made, in provider order, in its context.
    private var pendingInitializers: [() throws -> Any?] = []

    private func initialized() -> Injector {
        let initializers = pendingInitializers
        pendingInitializers = []
        for initFn in initializers { _ = Injector.runInContext(self) { jsReported { try initFn() } } }
        return self
    }

    public static func register(_ providers: Any?) {
        var initializers: [() throws -> Any?] = []
        func walk(_ item: Any?) {
            guard let flat = jsFlat(item) else { return }
            if let arr = flat as? JSArrayProtocol {
                for el in arr.jsAnyElements { walk(el) }
                return
            }
            if let fn = flat as? () throws -> Any? {
                initializers.append(fn)
                return
            }
            if let fn = flat as? () -> Void {
                initializers.append({ fn(); return nil })
                return
            }
            if let dyn = flat as? JSDynamic {
                if jsHasKey(dyn, "providers") || (dyn as? JSObject)?.has("providers") == true {
                    walk(dyn[jsKey: "providers"])
                }
                if jsHasKey(dyn, "provide") || (dyn as? JSObject)?.has("provide") == true {
                    parseProvider(dyn, into: nil)
                }
            }
        }
        walk(providers)
        for initFn in initializers {
            _ = jsReported { try initFn() }
        }
    }

    public static func inject(_ token: Any?, _ options: Any? = nil, notFoundValue: Any? = nil) -> Any? {
        let unwrapped = resolveForwardRef(token)
        if let active = current, active !== shared {
            return active.get(unwrapped, notFoundValue, options)
        }
        if ((try? jsGet(options, "skipSelf")) as? Bool) == true {
            return notFoundValue
        }
        return resolveRoot(unwrapped, notFoundValue: notFoundValue)
    }

    internal static func resolveRoot(_ unwrapped: Any?, notFoundValue: Any? = nil) -> Any? {
        guard let key = tokenKey(unwrapped) else { return notFoundValue }
        if let entry = tokenValues[key] { return entry }
        if let multis = multiFactories[key], !multis.isEmpty {
            let values = multis.map { fn in jsReported { try fn() } ?? nil }
            let arr = JSArray<Any?>(values)
            tokenValues[key] = arr
            return arr
        }
        if let factory = tokenFactories[key] {
            let val = jsReported { try factory() } ?? nil
            tokenValues[key] = val
            return val
        }
        if let tok = jsFlat(unwrapped) as? InjectionToken, let factory = tok.factory {
            let val = jsReported { try factory() } ?? nil
            tokenValues[key] = val
            return val
        }
        let flat = jsFlat(unwrapped)
        if let injectable = flat as? JSInjectableType.Type {
            return jsReported { try injectable.jsSharedInstance } ?? nil
        }
        if flat is ErrorHandler.Type { return ErrorHandler.standard }
        if flat is Injector.Type { return current ?? Injector.shared }
        if flat is NgZone.Type { return NgZone.shared }
        if flat is DestroyRef.Type { return DestroyRef.current() }
        if flat is ElementRef.Type { return ElementRef.current() }
        if flat is ApplicationRef.Type { return ApplicationRef.shared }
        if flat is PendingTasks.Type { return PendingTasks.shared }
        if flat is Location.Type { return Location.shared }
        if flat is ViewContainerRef.Type { return ViewContainerRef() }
        return notFoundValue
    }
}

/// `new InjectionToken<T>(desc, options)`: an Angular DI token, optionally carrying a root factory.
public final class InjectionToken {
    nonisolated deinit {}
    public let desc: String
    public let factory: (() throws -> Any?)?
    public init(_ desc: String = "", _ options: Any? = nil) {
        self.desc = desc
        if let fn = jsFlat(try? jsGet(options, "factory")) {
            if let zero = fn as? () throws -> Any? {
                self.factory = zero
            } else if let zero = fn as? () -> Any? {
                self.factory = zero
            } else {
                self.factory = { try jsCall(fn, spread: []) }
            }
        } else {
            self.factory = nil
        }
    }
    public func toString() -> String { "InjectionToken \(desc)" }
}

/// `open`: an app's class may extend it (`class AppErrorHandler extends ErrorHandler`), provided as `{ provide: ErrorHandler, useClass }`.
/// A script object, as an app's subclass is: it keeps what script adds to it.
open class ErrorHandler: JSDynamic {
    nonisolated deinit {}
    /// Not `shared`: an app's injectable subclass declares its own.
    public static let standard = ErrorHandler()
    private var added: JSObject?
    public init() {}
    open func handleError(_ error: Any?) { jsError("ERROR", error) }
    open subscript(jsKey key: String) -> Any? {
        get { added?[key] }
        set {
            if added == nil { added = JSObject() }
            added?[key] = newValue
        }
    }
    open var jsKeys: [String] { added?.keys ?? [] }
    open var jsClassName: String? { "ErrorHandler" }
}

/// Providers are registered once, by the injector they are given to (`bootstrapApplication`'s), as Angular's are.
public func makeEnvironmentProviders(_ providers: Any?) -> Any? {
    return providers
}

public func provideEnvironmentInitializer(_ fn: @escaping () throws -> Any?) -> Any? {
    return fn
}

public func provideAppInitializer(_ fn: @escaping () throws -> Any?) -> Any? {
    return fn
}

/// An `@NgModule` class: its metadata, evaluated once, and its construction with its constructor's parameters injected.
public protocol JSNgModuleType: AnyObject {
    static var jsNgImports: Any? { get }
    static var jsNgProviders: Any? { get }
    static func jsNgConstruct() throws -> Any?
}

/// Angular's `walkProviderTree`: each module once, its imports first (a `ModuleWithProviders`' providers after all of
/// them), then the module itself, the initializer that makes it when the injector is made, and its own providers.
/// Returns whether `container` is a `ModuleWithProviders`.
private func walkNgModule(_ container: Any?, _ out: inout [Any?], _ dedup: inout Set<ObjectIdentifier>) -> Bool {
    guard let flat = jsFlat(resolveForwardRef(container)) else { return false }
    let def: JSNgModuleType.Type
    if let type = flat as? JSNgModuleType.Type { def = type }
    else if let type = jsFlat(try? jsGet(flat, "ngModule")) as? JSNgModuleType.Type { def = type }
    else { return false }
    let key = ObjectIdentifier(def)
    if dedup.insert(key).inserted {
        var withProviders: [Any?] = []
        ngDeepForEach(def.jsNgImports) { if walkNgModule($0, &out, &dedup) { withProviders.append($0) } }
        for m in withProviders { ngDeepForEach(try? jsGet(m, "providers")) { out.append($0) } }
        out.append(JSObject([("provide", def), ("useFactory", { () throws -> Any? in try def.jsNgConstruct() })]))
        out.append({ () throws -> Any? in Injector.inject(def) })
        ngDeepForEach(def.jsNgProviders) { out.append($0) }
    }
    return !(flat is JSNgModuleType.Type) && jsHasKey(flat, "providers")
}

private func ngDeepForEach(_ value: Any?, _ body: (Any?) -> Void) {
    guard let flat = jsFlat(value) else { return }
    if let arr = flat as? JSArrayProtocol { for el in arr.jsAnyElements { ngDeepForEach(el, body) } } else { body(flat) }
}

/// What is not a compiled NgModule (the kit's own modules) is given to the injector as it is.
public func importProvidersFrom(_ modules: Any?...) -> Any? {
    var out: [Any?] = []
    var dedup = Set<ObjectIdentifier>()
    var withProviders: [Any?] = []
    ngDeepForEach(JSArray<Any?>(modules)) { source in
        if walkNgModule(source, &out, &dedup) { withProviders.append(source) }
        else if !(source is JSNgModuleType.Type) && (try? jsGet(source, "ngModule")).flatMap({ jsFlat($0) as? JSNgModuleType.Type }) == nil { out.append(source) }
    }
    for m in withProviders { ngDeepForEach(try? jsGet(m, "providers")) { out.append($0) } }
    return JSArray<Any?>(out)
}

public let PLATFORM_ID = InjectionToken("PLATFORM_ID", JSObject([("factory", { () -> Any? in "browser" })]))
public let APP_INITIALIZER = InjectionToken("APP_INITIALIZER")
public let ENVIRONMENT_INITIALIZER = InjectionToken("ENVIRONMENT_INITIALIZER")

public func isPlatformBrowser(_ platformId: Any?) -> Bool {
    jsToString(platformId) == "browser"
}

public func isPlatformServer(_ platformId: Any?) -> Bool {
    jsToString(platformId) == "server"
}

/// `NgZone` without zone.js: both run their function at once.
public final class NgZone {
    nonisolated deinit {}
    public static let shared = NgZone()
    public let onStable = Emitter<Any?>()
    public let onMicrotaskEmpty = Emitter<Any?>()
    public let onUnstable = Emitter<Any?>()
    public let onError = Emitter<Any?>()
    public let isStable = true
    public init() {}
    public static func isInAngularZone() -> Bool { true }
    public func run<T>(_ fn: () throws -> T) rethrows -> T { try fn() }
    public func runOutsideAngular<T>(_ fn: () throws -> T) rethrows -> T { try fn() }
    public func runGuarded<T>(_ fn: () throws -> T) rethrows -> T { try fn() }
    public func runTask<T>(_ fn: () throws -> T) rethrows -> T { try fn() }
}

public final class TemplateRef {
    nonisolated deinit {}
    public let elementRef: ElementRef
    public var _render: ((Any, Any?) throws -> Void)?
    public var _detached: ((Any?, Any?) -> EmbeddedViewRef)?
    private static var stack: [TemplateRef] = []
    public init(_ elementRef: ElementRef = ElementRef()) {
        self.elementRef = elementRef
    }
    public func createEmbeddedView(_ context: Any? = nil, _ injector: Any? = nil) -> EmbeddedViewRef {
        if let detached = _detached { return detached(context, injector) }
        return EmbeddedViewRef(context)
    }
    public static func current() -> TemplateRef { stack.last ?? TemplateRef() }
    public static func with<T>(_ ref: TemplateRef, _ body: () throws -> T) rethrows -> T {
        stack.append(ref)
        defer { stack.removeLast() }
        return try body()
    }
}

public final class EmbeddedViewRef {
    nonisolated deinit {}
    public var context: Any?
    public var rootNodes: JSArray<Any?> = JSArray()
    public private(set) var destroyed = false
    private var onDestroyFn: (() -> Void)?
    public init(_ context: Any? = nil, onDestroy: (() -> Void)? = nil) {
        self.context = context
        self.onDestroyFn = onDestroy
    }
    public func destroy() {
        if destroyed { return }
        destroyed = true
        onDestroyFn?()
        onDestroyFn = nil
    }
    public func detectChanges() {}
    public func markForCheck() {}
}

public final class ComponentRef {
    nonisolated deinit {}
    public var instance: Any?
    public let location: ElementRef
    public let injector: Injector
    public let hostView: EmbeddedViewRef
    public init(_ instance: Any? = nil, _ location: ElementRef = ElementRef(), _ injector: Injector = Injector.shared) {
        self.instance = instance
        self.location = location
        self.injector = injector
        self.hostView = EmbeddedViewRef(instance)
    }
    public func setInput(_ name: String, _ value: Any?) {
        if let inst = instance {
            try? jsSet(inst, name, value)
        }
    }
    public func destroy() {
        hostView.destroy()
    }
}

public final class ViewContainerRef {
    nonisolated deinit {}
    public let element = ElementRef()
    public let injector: Injector
    private var views: [EmbeddedViewRef] = []
    public var _mount: ((TemplateRef, Any?) -> EmbeddedViewRef)?
    public var _clear: (() -> Void)?
    private static var stack: [ViewContainerRef] = []
    public init(injector: Injector? = nil) {
        self.injector = injector ?? Injector.current ?? Injector.shared
    }
    public var length: Double { Double(views.count) }
    public func clear() {
        for v in views { v.destroy() }
        views.removeAll()
        _clear?()
    }
    @discardableResult
    public func createEmbeddedView(_ templateRef: Any?, _ context: Any? = nil, _ options: Any? = nil) -> EmbeddedViewRef {
        let view: EmbeddedViewRef
        if let tpl = jsFlat(templateRef) as? TemplateRef, let mount = _mount {
            view = mount(tpl, context)
        } else if let tpl = jsFlat(templateRef) as? TemplateRef {
            view = tpl.createEmbeddedView(context)
        } else {
            view = EmbeddedViewRef(context)
        }
        views.append(view)
        return view
    }
    @discardableResult
    public func createComponent(_ componentType: Any?, _ options: Any? = nil) -> ComponentRef {
        let inst: Any? = {
            if let injectable = jsFlat(componentType) as? JSInjectableType.Type {
                return jsReported { try injectable.jsConstruct() } ?? nil
            }
            if let fn = jsFlat(componentType) {
                return jsReported { try jsCall(fn, spread: []) } ?? nil
            }
            return nil
        }()
        let ref = ComponentRef(inst)
        views.append(ref.hostView)
        return ref
    }
    public func remove(_ index: Double? = nil) {
        if views.isEmpty { return }
        let idx = index.map { Int($0) } ?? (views.count - 1)
        if idx >= 0 && idx < views.count {
            views[idx].destroy()
            views.remove(at: idx)
        }
    }
    public static func current() -> ViewContainerRef { stack.last ?? ViewContainerRef() }
    public static func with<T>(_ ref: ViewContainerRef, _ body: () throws -> T) rethrows -> T {
        stack.append(ref)
        defer { stack.removeLast() }
        return try body()
    }
}

public final class ApplicationRef {
    nonisolated deinit {}
    public static let shared = ApplicationRef()
    public let isStable = Emitter<Bool>()
    public init() {}
    public func tick() {}
    public func attachView(_ view: Any?) {}
    public func detachView(_ view: Any?) {}
    public func destroy() {}
}

open class Renderer2 {
    nonisolated deinit {}
    public static let shared = Renderer2()
    public static var current: Renderer2 { Injector.inject(Renderer2.self, JSObject([("optional", true)])) as? Renderer2 ?? shared }
    public var data: JSObject = JSObject()
    public init() {}
    open func destroy() {}
    open func createElement(_ name: String, _ namespace: String? = nil) -> Any? { JSObject([("tagName", name)]) }
    open func createComment(_ value: String) -> Any? { JSObject([("comment", value)]) }
    open func createText(_ value: String) -> Any? { JSObject([("text", value)]) }
    open func appendChild(_ parent: Any?, _ newChild: Any?) {}
    open func insertBefore(_ parent: Any?, _ newChild: Any?, _ refChild: Any?, _ isMove: Bool? = nil) {}
    open func removeChild(_ parent: Any?, _ oldChild: Any?, _ isHostElement: Bool? = nil) {}
    open func selectRootElement(_ selectorOrNode: Any?, _ preserveContent: Bool? = nil) -> Any? { selectorOrNode }
    open func parentNode(_ node: Any?) -> Any? { (try? jsGet(node, "parent")) ?? nil }
    open func nextSibling(_ node: Any?) -> Any? { nil }
    open func setAttribute(_ el: Any?, _ name: String, _ value: String, _ namespace: String? = nil) { _ = try? jsSet(el, name, value) }
    open func removeAttribute(_ el: Any?, _ name: String, _ namespace: String? = nil) { _ = try? jsSet(el, name, nil) }
    open func addClass(_ el: Any?, _ name: String) {}
    open func removeClass(_ el: Any?, _ name: String) {}
    open func setStyle(_ el: Any?, _ style: String, _ value: Any?, _ flags: Any? = nil) {}
    open func removeStyle(_ el: Any?, _ style: String, _ flags: Any? = nil) {}
    open func setProperty(_ el: Any?, _ name: String, _ value: Any?) { _ = try? jsSet(el, name, value) }
    open func setValue(_ node: Any?, _ value: String) { _ = try? jsSet(node, "text", value) }
    open func listen(_ target: Any?, _ eventName: String, _ callback: @escaping (Any?) throws -> Any?) -> () -> Void { {} }
}

open class RendererFactory2 {
    nonisolated deinit {}
    public static let shared = RendererFactory2()
    public static var current: RendererFactory2 { Injector.inject(RendererFactory2.self, JSObject([("optional", true)])) as? RendererFactory2 ?? shared }
    public init() {}
    open func createRenderer(_ hostElement: Any?, _ type: Any? = nil) -> Renderer2 { Renderer2.current }
}

public final class Location {
    nonisolated deinit {}
    public static let shared = Location()
    private var currentPath = "/"
    public init() {}
    public func path(_ includeHash: Bool = false) -> String { currentPath }
    public func go(_ path: String, _ query: String = "", _ state: Any? = nil) {
        currentPath = query.isEmpty ? path : "\(path)?\(query)"
    }
    public func replaceState(_ path: String, _ query: String = "", _ state: Any? = nil) {
        go(path, query, state)
    }
    public func back() {}
    public func forward() {}
    public static func joinWithSlash(_ start: String, _ end: String) -> String {
        if start.isEmpty { return end }
        if end.isEmpty { return start }
        let s = start.hasSuffix("/") ? String(start.dropLast()) : start
        let e = end.hasPrefix("/") ? String(end.dropFirst()) : end
        return "\(s)/\(e)"
    }
    public static func stripTrailingSlash(_ url: String) -> String {
        url.count > 1 && url.hasSuffix("/") ? String(url.dropLast()) : url
    }
}

public func bootstrapApplication(_ rootComponent: Any?, _ options: Any? = nil) -> JSPromise<Any?> {
    if let providers = try? jsGet(options, "providers"), !jsIsNullish(providers) {
        Injector.register(providers)
    }
    return JSPromise<Any?>.resolve(ApplicationRef.shared)
}

public func runNativeScriptAngularApp(_ options: Any? = nil) {
    if let fn = jsFlat((try? jsGet(options, "appModuleBootstrap")) ?? nil) {
        if let zero = fn as? () throws -> Any? {
            jsReport { _ = try zero() }
        } else if let zero = fn as? () -> Void {
            zero()
        } else {
            jsReport { _ = try jsCall(fn, spread: []) }
        }
    }
}

