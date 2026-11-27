import Foundation

/// An object used as a dictionary (`Record<string, V>`, `{ [key: string]: V }`):
/// JavaScript's key order (integer-like keys ascending, then insertion order)
/// and reference semantics, which a Swift Dictionary has neither of.
public final class JSRecord<Value>: JSDynamic, JSReactiveConvertible, ExpressibleByDictionaryLiteral {
    nonisolated deinit {}
    public let object: JSObject
    internal var backing: JSDynamic?

    public init(object: JSObject = JSObject()) {
        self.object = object
        self.backing = nil
    }

    public init(dictionaryLiteral elements: (String, Value)...) {
        self.object = JSObject()
        self.backing = nil
        for (key, value) in elements { object[key] = value }
    }

    public init(_ entries: [(String, Value)]) {
        self.object = JSObject()
        self.backing = nil
        for (key, value) in entries { object[key] = value }
    }

    public init(_ dictionary: [String: Value]) {
        self.object = JSObject()
        self.backing = nil
        for key in dictionary.keys.sorted() { object[key] = dictionary[key] }
    }

    public subscript(key: String) -> Value? {
        get {
            if object.has(key) { return object[key] as? Value }
            return backing?[jsKey: key] as? Value
        }
        set {
            if let newValue {
                object[key] = newValue
                backing?[jsKey: key] = newValue
            } else {
                _ = object.delete(key)
                backing?[jsKey: key] = nil
            }
        }
    }

    /// The entry of a record whose values may be undefined: nil for a missing key and a stored undefined alike.
    public subscript<Wrapped>(entry key: String) -> Wrapped? where Value == Wrapped? {
        if object.has(key) { return (object[key] as? Value) ?? nil }
        return (backing?[jsKey: key] as? Value) ?? nil
    }

    @discardableResult public func delete(_ key: String) -> Bool { object.delete(key) }
    public func has(_ key: String) -> Bool { object.has(key) }

    public var keys: JSArray<String> { JSArray(object.jsKeys) }
    public var values: JSArray<Value> { JSArray(object.jsKeys.compactMap { object[$0] as? Value }) }
    public var entries: JSArray<(String, Value)> { JSArray(object.jsKeys.compactMap { k in (object[k] as? Value).map { (k, $0) } }) }

    public var jsKeys: [String] { object.jsKeys }
    public var jsClassName: String? { nil }
    public subscript(jsKey key: String) -> Any? {
        get { object.has(key) ? object[jsKey: key] : backing?[jsKey: key] }
        set {
            object[jsKey: key] = newValue
            backing?[jsKey: key] = newValue
        }
    }

    public var jsTracker: JSTracker? {
        get { object.jsTracker }
        set { object.jsTracker = newValue }
    }

    public func jsMakeReactive() { object.jsMakeReactive() }
}
