import Foundation

/// The dependency a deeply reactive collection reports (a `$ref`'s value): reads
/// subscribe the running `Effect`, mutations re-run the effects that read it.
public final class JSTracker {
    nonisolated deinit {}
    private let version = Signal<Int>(0)

    public init() {}

    public func track() { _ = version.value }

    public func trigger() { version.update { $0 &+ 1 } }
}

/// A class deep reactivity reaches into: `JSArray`, `JSObject`, `JSMap`, `JSSet` and
/// generated classes, which install trackers on themselves.
public protocol JSReactiveConvertible: AnyObject {
    func jsMakeReactive()
}

/// Makes a collection or generated class track reads and writes and returns it; other values
/// pass through. What is read from a reactive collection is made reactive as it is read, as
/// lazy deep proxies do, so `list.value.items[0].tags.push(x)` triggers.
@discardableResult
public func jsReactive<T>(_ value: T) -> T {
    if let convertible = value as? JSReactiveConvertible { convertible.jsMakeReactive() }
    return value
}

func jsReactiveAny(_ value: Any?) -> Any? {
    if let convertible = value as? JSReactiveConvertible { convertible.jsMakeReactive() }
    return value
}
