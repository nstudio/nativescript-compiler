import Foundation

/// `Cls.prototype` as script reaches it, for classes compiled in the kit generated from
/// core: the accessors and values `Object.defineProperty(Cls.prototype, …)` and
/// `Cls.prototype.x = v` put there, which instances of the class and of the classes
/// extending it read and write, and the class's own accessors. Each class's prototype
/// is one object, chained to its superclass's and, at the root, to `Object.prototype`.
public enum JSPrototypes {
    private static var table: [ObjectIdentifier: JSObject] = [:]
    /// The class of each prototype object, by the object's identity.
    private static var owners: [ObjectIdentifier: AnyClass] = [:]
    /// Accessors a class declares, put on its prototype when the prototype is first made.
    private static var declared: [ObjectIdentifier: [(String, JSPropertyDescriptor)]] = [:]
    private static var builtins: [String: JSObject] = [:]
    /// A class's static members by name, each read when script reads it (`Handler.initWithOwner`).
    private static var statics: [ObjectIdentifier: [String: () -> Any?]] = [:]
    /// Guards `table`, `owners`, `declared`, `builtins` and `statics`; never nested with `holdersLock`.
    private static let tableLock = JSUnfairLock()

    /// The static methods and properties a class declares, for script that holds the class as a value.
    public static func declareStatics(_ cls: AnyClass, _ members: [(String, () -> Any?)]) {
        let id = ObjectIdentifier(cls)
        tableLock.lock()
        for (key, read) in members { statics[id, default: [:]][key] = read }
        tableLock.unlock()
    }

    /// A static member of a class or of a class it extends, as JavaScript's classes inherit statics; nil where none has it.
    static func staticMember(_ cls: AnyClass, _ key: String) -> Any?? {
        var c: AnyClass? = cls
        var reader: (() -> Any?)? = nil
        tableLock.lock()
        while let k = c {
            if let read = statics[ObjectIdentifier(k)]?[key] { reader = read; break }
            c = class_getSuperclass(k)
        }
        tableLock.unlock()
        return reader.map { $0() }
    }

    /// `Object.prototype`, with the methods translated code calls on any object.
    public static let objectPrototype: JSObject = {
        let p = JSObject()
        let key = { (a: [Any?]) -> String in (jsFlat(jsArg(a, 0)) as? JSSymbol)?.key ?? jsToString(jsArg(a, 0)) }
        p["hasOwnProperty"] = { this, a in jsHasOwn(this, key(a)) } as JSMethod
        p["propertyIsEnumerable"] = { this, a in jsHasOwn(this, key(a)) && jsKeysOf(this).contains(key(a)) } as JSMethod
        p["isPrototypeOf"] = { this, a in
            var current = try? jsGetPrototypeOf(jsArg(a, 0))
            while let c = jsFlat(current), !(c is JSNull) {
                if let o = c as? JSObject, let t = jsFlat(this) as? JSObject, o === t { return true }
                current = try? jsGetPrototypeOf(c)
            }
            return false
        } as JSMethod
        p["toString"] = { this, _ in jsObjectToString(this) } as JSMethod
        p["valueOf"] = { this, _ in this } as JSMethod
        for k in ["hasOwnProperty", "propertyIsEnumerable", "isPrototypeOf", "toString", "valueOf"] {
            try? p.defineProperty(k, JSPropertyDescriptor(enumerable: false))
        }
        return p
    }()

    public static func of(_ cls: AnyClass) -> JSObject {
        let id = ObjectIdentifier(cls)
        tableLock.lock()
        if let p = table[id] {
            tableLock.unlock()
            return p
        }
        let p = JSObject()
        // Populate before setting `isClassPrototype` so `defineProperty` never acquires `holdersLock` under `tableLock`.
        for (key, d) in declared[id] ?? [] { try? p.defineProperty(key, d) }
        p.isClassPrototype = true
        table[id] = p
        owners[ObjectIdentifier(p)] = cls
        tableLock.unlock()
        markHasEntries()
        return p
    }

    /// The accessors a class declares (`get text()`, `set text(v)`): its prototype's own properties.
    public static func declare(_ cls: AnyClass, _ key: String, get: ((Any?) throws -> Any?)?, set: ((Any?, Any?) throws -> Void)?) {
        let id = ObjectIdentifier(cls)
        let d = JSPropertyDescriptor(get: get, set: set, enumerable: false, configurable: true)
        tableLock.lock()
        var list = declared[id] ?? []
        if let index = list.firstIndex(where: { jsStringEquals($0.0, key) }) {
            list[index] = (key, d)
        } else {
            list.append((key, d))
        }
        declared[id] = list
        if let p = table[id] {
            p.isClassPrototype = false
            try? p.defineProperty(key, d)
            p.isClassPrototype = true
        }
        tableLock.unlock()
        markEntriesAndInvalidate()
    }

    /// The prototype a built-in kind of value has (`Array.prototype`), its own object.
    static func builtin(_ name: String) -> JSObject {
        tableLock.lock()
        if let p = builtins[name] {
            tableLock.unlock()
            return p
        }
        let p = JSObject()
        builtins[name] = p
        tableLock.unlock()
        return p
    }

    /// `Object.getPrototypeOf` of a plain object: a class's prototype leads to its superclass's.
    static func prototypeOf(object o: JSObject) -> Any? {
        if o === objectPrototype { return jsNull }
        tableLock.lock()
        let cls: AnyClass? = owners[ObjectIdentifier(o)]
        tableLock.unlock()
        if let cls, let superclass = class_getSuperclass(cls), !isRoot(superclass) { return of(superclass) }
        return objectPrototype
    }

    /// The class Swift's own root classes extend, which no script class corresponds to.
    private static func isRoot(_ cls: AnyClass) -> Bool { NSStringFromClass(cls) == "_TtCs12_SwiftObject" }

    /// The nearest prototype in a class's chain that has the key.
    static func holder(_ cls: AnyClass, _ key: String) -> JSObject? { holding(cls, key).holder }

    /// `holder`, with the getter where the key is an accessor there.
    static func holding(_ cls: AnyClass, _ key: String) -> JSHolding { lookup(cls, key).holding }

    /// `holding`, with the generation of the prototypes' keys it holds for; nil where no cache may keep it.
    private static func lookup(_ cls: AnyClass, _ key: String) -> (holding: JSHolding, generation: Int?) {
        let id = JSClassKey(cls: ObjectIdentifier(cls), key: JSPropertyKey(key))
        holdersLock.lock()
        if !hasEntries {
            holdersLock.unlock()
            return (JSHolding(holder: nil, getter: nil, setter: nil), nil)
        }
        let known = holders[id], generation = holdersGeneration
        holdersLock.unlock()
        if let known { return (known, generation) }
        var found: JSObject? = nil
        // A reactive prototype tracks each `has`, so a chain holding one is walked on every read.
        var tracked = false
        var c: AnyClass? = cls
        while let k = c {
            let kid = ObjectIdentifier(k)
            tableLock.lock()
            let existing = table[kid]
            let hasDeclared = existing == nil && declared[kid] != nil
            tableLock.unlock()
            if let p = existing ?? (hasDeclared ? of(k) : nil) {
                tracked = tracked || p.jsTracker != nil
                if p.has(key) { found = p; break }
            }
            c = class_getSuperclass(k)
        }
        let holding = JSHolding(holder: found, getter: found?.getter(key), setter: found?.setter(key))
        if !tracked {
            holdersLock.lock()
            if holdersGeneration == generation { holders[id] = holding }
            holdersLock.unlock()
        }
        return (holding, tracked ? nil : generation)
    }

    /// `holding` for a site's key, what the site last found kept while the class and the generation are the same.
    static func holding(_ cls: AnyClass, _ site: JSReadSite) -> JSHolding {
        let id = ObjectIdentifier(cls)
        holdersLock.lock()
        if site.cls == id && site.generation == holdersGeneration {
            let known = site.holding
            holdersLock.unlock()
            return known
        }
        holdersLock.unlock()
        let (holding, generation) = lookup(cls, site.key)
        if let generation {
            holdersLock.lock()
            if holdersGeneration == generation { site.cls = id; site.generation = generation; site.holding = holding }
            holdersLock.unlock()
        }
        return holding
    }

    /// `jsClassSymbolMethod` for a site's key, kept for the class it was last asked of: a class's methods do not change.
    static func method(_ object: JSExpando, _ site: JSReadSite) -> JSMethod? {
        let id = ObjectIdentifier(type(of: object))
        holdersLock.lock()
        if site.methodCls == id {
            let known = site.method
            holdersLock.unlock()
            return known
        }
        holdersLock.unlock()
        let method = jsClassSymbolMethod(object, site.key)
        holdersLock.lock()
        site.methodCls = id
        site.method = method
        holdersLock.unlock()
        return method
    }

    /// What `holding` found for a class and key, kept until any class's prototype gains, loses or redefines a key.
    private static var holders: [JSClassKey: JSHolding] = [:]
    private static var holdersGeneration = 0
    private static var hasEntries = false
    private static let holdersLock = JSUnfairLock()

    private static func markHasEntries() {
        holdersLock.lock()
        hasEntries = true
        holdersLock.unlock()
    }

    private static func markEntriesAndInvalidate() {
        holdersLock.lock()
        hasEntries = true
        holders.removeAll()
        holdersGeneration &+= 1
        holdersLock.unlock()
    }

    static func prototypeKeysChanged() {
        holdersLock.lock()
        holders.removeAll()
        holdersGeneration &+= 1
        holdersLock.unlock()
    }

    /// The setter an accessor on a class's prototype chain has for a key; nil where the chain holds no accessor for it.
    public static func setter(_ cls: AnyClass, _ key: String) -> ((Any?, Any?) throws -> Void)? {
        holding(cls, key).setter
    }

    /// What an instance without a value of its own reads for a key: its prototype chain's.
    public static func value(_ cls: AnyClass, _ key: String, _ receiver: Any?) -> Any? {
        let holding = holding(cls, key)
        guard let p = holding.holder else { return nil }
        do {
            if let getter = holding.getter { return try getter(receiver) }
            return try p.get(key, receiver: receiver)
        } catch { jsReportUncaught(jsCaught(error)); return nil }
    }

    /// `value` of a site's key.
    public static func value(_ cls: AnyClass, _ site: JSReadSite, _ receiver: Any?) -> Any? {
        let holding = holding(cls, site)
        guard let p = holding.holder else { return nil }
        do {
            if let getter = holding.getter { return try getter(receiver) }
            return try p.get(site.key, receiver: receiver)
        } catch { jsReportUncaught(jsCaught(error)); return nil }
    }
}

/// A read of one constant key that goes through an instance's prototype chain (a field under a registered property's
/// name): what the chain held for the key the last time, for the class read then. `JSPrototypes`' lock guards it.
public final class JSReadSite {
    let key: String
    fileprivate var cls: ObjectIdentifier?
    fileprivate var generation = 0
    fileprivate var holding = JSHolding(holder: nil, getter: nil, setter: nil)
    fileprivate var methodCls: ObjectIdentifier?
    fileprivate var method: JSMethod?

    public init(_ key: String) { self.key = key }
    nonisolated deinit {}
}

struct JSHolding {
    let holder: JSObject?
    let getter: ((Any?) throws -> Any?)?
    let setter: ((Any?, Any?) throws -> Void)?
}

/// `Object.getPrototypeOf(value)`.
public func jsGetPrototypeOf(_ value: Any?) throws -> Any? {
    guard let v = jsFlat(value), !(v is JSNull) else { throw JSException(JSTypeError("Cannot convert undefined or null to object")) }
    switch v {
    case let o as JSObject: return JSPrototypes.prototypeOf(object: o)
    case is AnyClass: return JSPrototypes.builtin("Function")
    case is JSArrayProtocol: return JSPrototypes.builtin("Array")
    case is String: return JSPrototypes.builtin("String")
    case is Double: return JSPrototypes.builtin("Number")
    case is Bool: return JSPrototypes.builtin("Boolean")
    case is JSMapProtocol: return JSPrototypes.builtin("Map")
    case is JSSetProtocol: return JSPrototypes.builtin("Set")
    case is JSSymbol: return JSPrototypes.builtin("Symbol")
    default:
        if jsIsFunction(v) { return JSPrototypes.builtin("Function") }
        // An object literal's (or interface value's) class: a plain object.
        if v is JSObjectConvertible { return JSPrototypes.objectPrototype }
        if jsIsObject(v) { return JSPrototypes.of(type(of: v as AnyObject)) }
        return JSPrototypes.objectPrototype
    }
}

/// `Object.prototype.hasOwnProperty.call(object, key)`.
public func jsHasOwn(_ object: Any?, _ key: String) -> Bool {
    if let error = jsFlat(object) as? JSError, jsErrorOwns(error, key) { return true }
    switch jsFlat(object) {
    case let o as JSObject: return o.has(key)
    case let f as JSFunctionObject: return f.hasOwn(key)
    case let e as JSExpando: return e.jsExpando?.has(key) == true || e.jsKeys.contains(key)
    case let d as JSDynamic: return d.jsKeys.contains(key)
    case let a as JSArrayProtocol: return key == "length" || jsArrayIndex(key).map { a.jsHasElement(at: Int($0)) } ?? jsSideProperties(a, create: false)?.has(key) == true
    case let s as String: return key == "length" || jsArrayIndex(key).map { Int($0) < s.utf16.count } ?? false
    default: return false
    }
}

/// `Object.prototype.propertyIsEnumerable.call(object, key)`: an own property that `Object.keys` lists.
public func jsPropertyIsEnumerable(_ object: Any?, _ key: String) -> Bool {
    guard jsHasOwn(object, key) else { return false }
    switch jsFlat(object) {
    case let a as JSArrayProtocol: return key != "length" && (jsArrayIndex(key).map { a.jsHasElement(at: Int($0)) } ?? jsSideProperties(a, create: false)?.keys.contains(key) == true)
    case is String: return key != "length"
    default: return (jsOwnPropertyDescriptor(object, key) as? JSObject)?["enumerable"] as? Bool ?? true
    }
}

/// `@decorator field` in a class: each decorator, the last first, is called with the class's prototype, the key and undefined.
public func jsDecorateField(_ cls: AnyClass, _ key: String, _ decorators: [Any?]) throws {
    for d in decorators.reversed() { _ = try jsCall(d, JSPrototypes.of(cls), key, nil) }
}

/// `@decorator class Cls {}`: each decorator, the last first, is called with what the ones before it gave.
public func jsDecorate(_ cls: AnyClass, _ decorators: [Any?]) throws {
    var target: Any? = cls
    for d in decorators.reversed() {
        let result = try jsCall(d, target)
        if jsIsTruthy(result) { target = result }
    }
    guard let decorated = jsFlat(target) as? AnyClass, ObjectIdentifier(decorated) == ObjectIdentifier(cls) else {
        throw JSException(JSTypeError("A class decorator that replaces the class is not supported in a compiled app"))
    }
}

/// An instance of a class generated from core: the properties script gives it beyond the
/// fields it declares (`this[key] = v`, symbol-keyed ones included), its methods named by
/// symbols (`[prop.setNative](value)`), and what its class's prototype defines.
public protocol JSExpando: JSDynamic, JSSymbolKeyed, JSDeletable {
    var jsExpando: JSObject? { get set }
    /// The method a class declares under the symbol whose key this is; the method takes its receiver as `this`.
    func jsSymbolMethod(_ key: String) -> JSMethod?
    /// Whether the class and its superclasses declare no member a symbol may name: none of their fields, methods or
    /// accessors answers a symbol key, which only the instance's own properties and its prototype chain hold.
    static var jsSymbolPlain: Bool { get }
    /// Whether the class and its superclasses declare no symbol-keyed fields: symbol keys never match `subscript(jsKey:)` or own declared `jsSymbolKeys`.
    static var jsSymbolFieldsPlain: Bool { get }
}

extension JSExpando {
    public static var jsSymbolPlain: Bool { false }
    public static var jsSymbolFieldsPlain: Bool { jsSymbolPlain }
}

/// A key a class does not declare as a field: a symbol-named method, the instance's own property, or its prototype's.
public func jsExpandoGet(_ object: JSExpando, _ key: String) -> Any? {
    if jsIsSymbolKey(key), let method = jsClassSymbolMethod(object, key) { return method }
    if let own = object.jsExpando, let value = own.ownValue(key, receiver: object) { return value }
    let inherited = JSPrototypes.value(type(of: object), key, object)
    // A method named by a computed key that holds a string (`[observableKey]()`).
    if inherited == nil, !jsIsSymbolKey(key), let method = jsClassSymbolMethod(object, key) { return method }
    return inherited
}

/// `jsExpandoGet` of a site's key, a name the class declares as a field.
public func jsExpandoGet(_ object: JSExpando, _ site: JSReadSite) -> Any? {
    if let own = object.jsExpando, let value = own.ownValue(site.key, receiver: object) { return value }
    let inherited = JSPrototypes.value(type(of: object), site, object)
    if inherited == nil, let method = JSPrototypes.method(object, site) { return method }
    return inherited
}

/// `jsExpandoGet` of a symbol's key where the class is `jsSymbolPlain`.
func jsExpandoSymbolGet(_ object: JSExpando, _ key: String) -> Any? {
    if let own = object.jsExpando, let value = own.ownValue(key, receiver: object) { return value }
    return JSPrototypes.value(type(of: object), key, object)
}

/// A subclass's keys: its base's (which end with the expando's), then its own fields', then the expando's.
public func jsKeysBeforeExpando(_ inherited: [String], _ own: [String], _ expando: JSObject?) -> [String] {
    guard let added = expando?.jsKeys, !added.isEmpty else { return inherited + own }
    return inherited.dropLast(added.count) + own + added
}

public func jsExpandoSet(_ object: JSExpando, _ key: String, _ value: Any?) {
    do {
        if let own = object.jsExpando, try own.setIfPresent(key, value, receiver: object) {
            return
        }
        if let setter = JSPrototypes.setter(type(of: object), key) { return try setter(object, value) }
    } catch { jsReportUncaught(jsCaught(error)); return }
    if object.jsExpando == nil { object.jsExpando = JSObject() }
    object.jsExpando!.defineNewOwn(key, value)
    // Without a noted order the new key is last already: the expando's keys follow the fields'.
    if !jsIsSymbolKey(key) {
        if let ordered = object as? JSKeyOrdered, ordered.jsOrder != nil { ordered.jsKeyMade(key) }
        if let made = object as? JSKeysMade, made.jsMade != nil { jsMadeAgain(&made.jsMade, key) }
    }
}

/// A class's method for a symbol key, looked up once per class: `jsSymbolMethod` compares the key with
/// every symbol its class and superclasses declare a method under, and core asks for one with each
/// property it sets. The methods take their receiver as `this`, so a class's are the same for every instance.
func jsClassSymbolMethod(_ object: JSExpando, _ key: String) -> JSMethod? {
    let id = JSClassKey(cls: ObjectIdentifier(type(of: object)), key: JSPropertyKey(key))
    jsSymbolMethodsLock.lock()
    let known = jsSymbolMethods[id]
    jsSymbolMethodsLock.unlock()
    if let known { return known }
    let method = object.jsSymbolMethod(key)
    jsSymbolMethodsLock.lock()
    jsSymbolMethods[id] = .some(method)
    jsSymbolMethodsLock.unlock()
    return method
}

struct JSClassKey: Hashable {
    let cls: ObjectIdentifier
    let key: JSPropertyKey
    init(cls: ObjectIdentifier, key: String) {
        self.cls = cls
        self.key = JSPropertyKey(key)
    }
    init(cls: ObjectIdentifier, key: JSPropertyKey) {
        self.cls = cls
        self.key = key
    }
}

private var jsSymbolMethods: [JSClassKey: JSMethod?] = [:]
private let jsSymbolMethodsLock = JSUnfairLock()

/// `key in object` for what the object does not declare as a field.
public func jsExpandoHas(_ object: JSExpando, _ key: String) -> Bool { jsExpandoHas(object, key, symbolPlain: false) }

/// `jsExpandoHas`; `symbolPlain`: the class declares no symbol member; `symbolFieldsPlain`: no declared symbol fields.
func jsExpandoHas(_ object: JSExpando, _ key: String, symbolPlain: Bool, symbolFieldsPlain: Bool = false) -> Bool {
    if object.jsExpando?.has(key) == true { return true }
    if !symbolPlain, jsIsSymbolKey(key) {
        if (!symbolFieldsPlain && object.jsSymbolKeys.contains(key)) || jsClassSymbolMethod(object, key) != nil { return true }
    }
    return JSPrototypes.holder(type(of: object), key) != nil
}

/// A property an object was given at run time (`Object.defineProperty(this, key, …)`), which hides its class's member of that name.
public func jsOwnProperty(_ object: Any?, _ key: String) -> Any?? {
    guard let own = (jsFlat(object) as? JSExpando)?.jsExpando, own.has(key) else { return nil }
    return .some(try? own.get(key, receiver: object))
}

/// A function value called as a method of `this`; `optional` is `?.()`, which an undefined or null function skips.
@discardableResult
public func jsCallValue(_ function: Any?, this: Any?, optional: Bool, _ arguments: [Any?]) throws -> Any? {
    if optional && jsIsNullish(function) { return nil }
    if let method = jsFlat(function) as? JSMethod { return try method(this, arguments) }
    return try jsCall(function, spread: arguments)
}

/// A method found on a prototype (`super[key]`), called with `this`; a TypeError where there is none.
@discardableResult
public func jsCallFound(_ method: JSMethod?, _ this: Any?, _ arguments: [Any?]) throws -> Any? {
    guard let method else { throw JSException(JSTypeError("method is not a function")) }
    return try method(this, arguments)
}
