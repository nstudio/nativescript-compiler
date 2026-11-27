import Foundation

/// A JavaScript symbol: equal only to itself. As a property key it is `key`,
/// a string no JavaScript code spells, which `Object.keys`, `for…in` and JSON skip.
public final class JSSymbol: Hashable, CustomStringConvertible {
    nonisolated deinit {}
    public let jsDescription: String?
    public let key: String

    public init(_ description: String?) {
        jsDescription = description
        JSSymbol.lock.lock()
        JSSymbol.count += 1
        let k = "\u{0}@@\(JSSymbol.count)"
        key = k
        JSSymbol.byKey[k] = self
        JSSymbol.lock.unlock()
    }

    private nonisolated static let lock = NSLock()
    private static var count = 0
    private static var byKey: [String: JSSymbol] = [:]
    private static var registry: [String: JSSymbol] = [:]

    /// `Symbol.for(key)`: one symbol per key, program-wide.
    public static func `for`(_ key: String) -> JSSymbol {
        lock.lock()
        if let s = registry[key] {
            lock.unlock()
            return s
        }
        lock.unlock()
        let s = JSSymbol(key)
        lock.lock()
        if let existing = registry[key] {
            lock.unlock()
            return existing
        }
        registry[key] = s
        lock.unlock()
        return s
    }

    /// `Symbol.keyFor(symbol)`: the key of a registered symbol.
    public static func keyFor(_ symbol: JSSymbol) -> String? {
        guard let d = symbol.jsDescription else { return nil }
        lock.lock()
        let match = registry[d] === symbol
        lock.unlock()
        return match ? d : nil
    }

    public static let iterator = JSSymbol("Symbol.iterator")
    public static let asyncIterator = JSSymbol("Symbol.asyncIterator")
    public static let toPrimitive = JSSymbol("Symbol.toPrimitive")
    public static let toStringTag = JSSymbol("Symbol.toStringTag")
    public static let hasInstance = JSSymbol("Symbol.hasInstance")
    public static let dispose = JSSymbol("Symbol.dispose")
    public static let asyncDispose = JSSymbol("Symbol.asyncDispose")

    /// The symbol a property key stands for.
    public static func of(key: String) -> JSSymbol? {
        guard key.utf8.first == 0 else { return nil }
        lock.lock()
        let found = byKey[key]
        lock.unlock()
        return found
    }

    public func toString() -> String { "Symbol(\(jsDescription ?? ""))" }
    public func valueOf() -> JSSymbol { self }
    public var description: String { toString() }

    public static func == (a: JSSymbol, b: JSSymbol) -> Bool { a === b }
    public func hash(into hasher: inout Hasher) { hasher.combine(ObjectIdentifier(self)) }
}

/// `Symbol(description)`.
public func jsSymbol(_ description: String?) -> JSSymbol { JSSymbol(description) }

/// ToPropertyKey of a value held untyped: a symbol's own key, anything else as a string.
public func jsPropertyKey(_ value: Any?) -> String {
    if let symbol = jsFlat(value) as? JSSymbol { return symbol.key }
    return jsToString(value)
}

/// Whether a property key is a symbol's.
@inline(__always)
public func jsIsSymbolKey(_ key: String) -> Bool { key.utf8.first == 0 }

/// An object with symbol-keyed properties, which print after its other keys.
public protocol JSSymbolKeyed: AnyObject {
    var jsSymbolKeys: [String] { get }
}

/// `[Symbol.toPrimitive](hint)` on a class.
public protocol JSToPrimitive: AnyObject {
    func jsToPrimitive(_ hint: String) throws -> Any?
}

/// `get [Symbol.toStringTag]()` on a class.
public protocol JSToStringTag: AnyObject {
    var jsToStringTag: String { get }
}

/// `Object.getOwnPropertySymbols(value)`.
public func jsOwnPropertySymbols(_ value: Any?) -> JSArray<JSSymbol> {
    guard let keyed = jsFlat(value) as? JSSymbolKeyed else { return JSArray() }
    return JSArray(keyed.jsSymbolKeys.compactMap(JSSymbol.of(key:)))
}

/// `Object.prototype.toString.call(value)`.
public func jsObjectToString(_ value: Any?) -> String {
    switch jsFlat(value) {
    case nil: return "[object Undefined]"
    case is JSNull: return "[object Null]"
    case let tagged as JSToStringTag: return "[object \(tagged.jsToStringTag)]"
    case is JSArrayProtocol: return "[object Array]"
    case is String: return "[object String]"
    case is Bool: return "[object Boolean]"
    case is JSError: return "[object Error]"
    case is JSDate: return "[object Date]"
    case is JSRegExp: return "[object RegExp]"
    case is JSMapProtocol: return "[object Map]"
    case is JSSetProtocol: return "[object Set]"
    case is JSThenable: return "[object Promise]"
    case is JSSymbol: return "[object Symbol]"
    case let v?:
        if jsNumeric(v) != nil { return "[object Number]" }
        if jsIsFunction(v) { return "[object Function]" }
        return jsStringTag(v).map { "[object \($0)]" } ?? "[object Object]"
    }
}

/// An object's `[Symbol.toStringTag]` held as a property (an untyped literal's): Object.prototype.toString names it so.
func jsStringTag(_ value: Any) -> String? {
    (value as? JSDynamic)?[jsKey: JSSymbol.toStringTag.key] as? String
}

/// ToPrimitive(value, hint) for an object with `[Symbol.toPrimitive]` or its own `valueOf`; nil for anything else.
func jsUserPrimitive(_ value: Any, _ hint: String) -> Any?? {
    do { return try jsUserPrimitiveThrowing(value, hint) } catch {
        jsReportUncaught(jsCaught(error))
        return .some(nil)
    }
}

/// `jsUserPrimitive` where what the value's own conversion throws is thrown.
func jsUserPrimitiveThrowing(_ value: Any, _ hint: String) throws -> Any?? {
    if let shape = jsClassShape(of: value), shape.script {
        if shape.plainObject && !shape.valueOf { return .some(try unsafeDowncast(value as AnyObject, to: JSObject.self).jsToPrimitive(hint)) }
        if !shape.valueOf && !shape.toPrimitive { return nil }
    }
    if hint != "string", let convertible = value as? JSValueOfConvertible {
        let primitive = jsFlat(try convertible.jsValueOf())
        // valueOf giving an object: OrdinaryToPrimitive goes on to toString.
        switch primitive {
        case nil, is String, is Double, is Bool, is JSNull, is JSSymbol, is JSBigInt: return .some(primitive)
        default: if let n = jsNumeric(primitive!) { return .some(n) }
        }
    }
    guard let convertible = value as? JSToPrimitive else { return nil }
    return .some(try convertible.jsToPrimitive(hint))
}
