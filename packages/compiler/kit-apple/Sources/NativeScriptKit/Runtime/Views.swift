/// A native object that is another in every JavaScript sense: `===`, Map and Set keys, WeakMap keys see that one.
@MainActor
public protocol JSStandIn: AnyObject {
    /// The object this one is, or nil where it is itself.
    var jsStandingFor: AnyObject? { get }
}

/// An object of one shape's class standing for an object of another class (`T.jsView`): it keeps no fields of its
/// own and reads and writes its root's keys, so it is the root in every JavaScript sense.
@MainActor
public protocol JSViewing: JSDynamic, JSStandIn {
    var jsViewRoot: JSDynamic? { get }
}

extension JSViewing {
    public var jsStandingFor: AnyObject? { jsViewRoot }
}

private final class JSViewEntry {
    nonisolated deinit {}
    weak var root: AnyObject?
    var views: [ObjectIdentifier: JSWeakView] = [:]
    init(_ root: AnyObject) { self.root = root }
}

private final class JSWeakView {
    nonisolated deinit {}
    weak var view: AnyObject?
    init(_ view: AnyObject) { self.view = view }
}

private var jsViewEntries: [ObjectIdentifier: JSViewEntry] = [:]
private var jsViewPruneAt = 64
private let jsViewLock = JSUnfairLock()

/// The object `value` is in JavaScript: what a stand-in stands for, else `value` itself.
@inline(__always)
public func jsIdentity(_ value: Any?) -> Any? {
    guard let v = value as? JSStandIn, let root = v.jsStandingFor else { return value }
    return root
}

/// The object a view of `value` reads: `value`'s own root when it is a view, a `JSPrimitiveRoot` when it is no object,
/// nil when it is an object with no keys of its own to read.
public func jsViewRootOf(_ value: Any?) -> JSDynamic? {
    let flat = jsFlat(value)
    guard let d = flat as? JSDynamic else {
        switch flat {
        case nil, is JSNull, is Bool, is Double, is String, is JSSymbol, is JSBigInt: return JSPrimitiveRoot(flat)
        default: return nil
        }
    }
    return (d as? JSViewing)?.jsViewRoot ?? d
}

/// A value that is no object, held as an object type (`x as any as Shape`): what a view of it reads is the value's
/// own, and an iteration step given it throws as for the value.
public final class JSPrimitiveRoot: JSDynamic {
    nonisolated deinit {}
    public let value: Any?
    private var written: [String: Any?] = [:]
    private var writtenKeys: [String] = []

    init(_ value: Any?) { self.value = value }

    public subscript(jsKey key: String) -> Any? {
        get { if let w = written[key] { return w }; return jsField(value, key) }
        set {
            if written[key] == nil { writtenKeys.append(key) }
            written[key] = .some(newValue)
        }
    }
    public var jsKeys: [String] { writtenKeys }
    public var jsClassName: String? { nil }
}

/// The one view of `root` as `T` while it is alive, made by `make` when there is none.
public func jsViewOf<T: JSViewing>(_ root: JSDynamic, _ type: T.Type, _ make: (JSDynamic) -> T) -> T {
    jsStandInOf(root, type) { make(root) }
}

/// The one stand-in of `root` as `T` while both are alive, made by `make` when there is none.
func jsStandInOf<T: AnyObject>(_ root: AnyObject, _ type: T.Type, _ make: () -> T) -> T {
    let id = ObjectIdentifier(root)
    let typeId = ObjectIdentifier(type)
    jsViewLock.lock()
    let entry: JSViewEntry
    if let e = jsViewEntries[id], e.root === root {
        entry = e
    } else {
        if jsViewEntries.count >= jsViewPruneAt {
            jsViewEntries = jsViewEntries.filter { $0.value.root != nil }
            jsViewPruneAt = max(64, jsViewEntries.count * 2)
        }
        entry = JSViewEntry(root)
        jsViewEntries[id] = entry
    }
    if let v = entry.views[typeId]?.view as? T {
        jsViewLock.unlock()
        return v
    }
    jsViewLock.unlock()
    let v = make()
    jsViewLock.lock()
    entry.views[typeId] = JSWeakView(v)
    jsViewLock.unlock()
    return v
}
