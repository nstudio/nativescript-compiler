import Foundation
#if canImport(UIKit)
import UIKit
#endif

// Values as translated TypeScript holds them: `any`/`unknown` is `Any?`, an empty
// `Any?` is `undefined`, `jsNull` is `null`, numbers are `Double`, objects are
// classes compared by identity.

/// JavaScript `null`.
public final class JSNull: Sendable, CustomStringConvertible {
    nonisolated deinit {}
    fileprivate init() {}
    public var description: String { "null" }
}

/// The JavaScript `null` value. `undefined` is `nil`.
public let jsNull = JSNull()

/// A JavaScript function value as dynamic code stores and calls it.
public typealias JSFunction = ([Any?]) throws -> Any?

/// An object whose properties dynamic code reaches by name (`o[key]`, JSON, `console.log`):
/// plain objects (`JSObject`) and the classes generated for TypeScript classes and interfaces.
/// A nil `jsClassName` prints as a plain object (`{ a: 1 }`), otherwise as `Name { a: 1 }`.
@MainActor
public protocol JSDynamic: AnyObject {
    subscript(jsKey key: String) -> Any? { get set }
    var jsKeys: [String] { get }
    var jsClassName: String? { get }
}

/// An optional field read untyped: null where the object holds the key as set to null (`jsNulls`), else its value.
@inline(__always)
public func jsNullable(_ value: Any?, _ nulls: Set<String>?, _ key: String) -> Any? {
    if value == nil, let nulls, nulls.contains(key) { return jsNull }
    return value
}

/// A value typed `T | null`, held as an optional, read untyped: nil is null.
@inline(__always)
public func jsNulled(_ value: Any?) -> Any? { value ?? jsNull }

/// An element or map entry of `T | null` values read untyped: a missing one is undefined, a present nil null.
@inline(__always)
public func jsNulledEntry<V>(_ entry: V??) -> Any? {
    guard let value = entry else { return nil }
    return jsNulled(value)
}

/// A class's instance whose keys a write can make out of its fields' declared order (assign mode's fields without an
/// initializer, a field deleted and written again): `jsOrder` is nil while the keys run in `jsFieldKeys`' order.
public protocol JSKeyOrdered: AnyObject {
    var jsOrder: [String]? { get set }
    var jsFieldKeys: [String] { get }
    /// The keys script gave the object (its expando's), which `jsFieldKeys`' order puts after the fields.
    var jsAddedKeys: [String] { get }
}

extension JSKeyOrdered {
    public var jsAddedKeys: [String] { [] }

    /// Whether a key made now needs noting: the fields' order alone no longer places it last.
    public var jsKeysNoted: Bool { jsOrder != nil || !jsAddedKeys.isEmpty }

    /// `key` made just now: last among the keys. `early`: made before its class's level of the constructor started, so
    /// before keys its static place is after.
    public func jsKeyMade(_ key: String, early: Bool = false) {
        let keys = jsOrderedKeys(jsOrder, jsFieldKeys + jsAddedKeys)
        if jsOrder == nil && !early && keys.last == key { return }
        jsOrder = keys.filter { $0 != key } + [key]
    }
}

/// A library class's instance whose fields declared without a value are keys from their first write: a bit each tells
/// which are, and `jsMade` is nil until one is written, then lists every key made since, in the order made (such a field,
/// a later constructor level's keys, a key script adds).
public protocol JSKeysMade: AnyObject {
    var jsMade: [String]? { get set }
}

/// A field declared without a value written for the first time (its `bit` unset): its key is made.
public func jsMadeNote(_ bits: inout UInt64, _ made: inout [String]?, _ bit: UInt64, _ key: String) {
    bits |= bit
    if made == nil {
        var keys: [String] = []
        keys.reserveCapacity(4)
        made = keys
    }
    made?.append(key)
}

/// A key made anew once the record began (a key script adds, maybe again after a delete): last.
public func jsMadeAgain(_ made: inout [String]?, _ key: String) {
    guard made != nil else { return }
    made?.removeAll { $0 == key }
    made?.append(key)
}

/// A constructor level's keys, made as it starts: last, where a base level began the record; a key made already keeps its place.
public func jsMadeLevel(_ made: inout [String]?, _ keys: [String]) {
    guard made != nil else { return }
    for k in keys where !made!.contains(k) { made!.append(k) }
}

/// An object's present keys `keys` (in their static order) with those its record `made` notes last, in the record's order.
public func jsMadeKeys(_ made: [String]?, _ keys: [String]) -> [String] {
    guard let made else { return keys }
    return keys.filter { !made.contains($0) } + made.filter(keys.contains)
}

/// An object's present field keys `keys` in the order `order` notes, any it lacks after.
public func jsOrderedKeys(_ order: [String]?, _ keys: [String]) -> [String] {
    guard let order else { return keys }
    return order.filter(keys.contains) + keys.filter { !order.contains($0) }
}

/// An optional field written untyped: whether it now holds null rather than undefined.
@inline(__always)
public func jsNoteNull(_ nulls: inout Set<String>?, _ key: String, _ value: Any?) {
    if value is JSNull { nulls = (nulls ?? []).union([key]) } else if nulls != nil { nulls!.remove(key) }
}

/// A string, number or boolean field written untyped, whose storage can only hold its zero: whether it now holds null
/// (`jsNulls`) or undefined (`jsUnset`).
@inline(__always)
public func jsNoteNullish(_ nulls: inout Set<String>?, _ unset: inout Set<String>?, _ key: String, _ value: Any?) {
    jsNoteNull(&nulls, key, value)
    if jsIsNullish(value) && !(value is JSNull) { unset = (unset ?? []).union([key]) } else if unset != nil { unset!.remove(key) }
}

/// Such a field read untyped: the null or undefined it notes, else its value.
@inline(__always)
public func jsNotedNullish(_ value: Any?, _ nulls: Set<String>?, _ unset: Set<String>?, _ key: String) -> Any? {
    if let nulls, nulls.contains(key) { return jsNull }
    if let unset, unset.contains(key) { return nil }
    return value
}

/// The keys of `object` among `keys` that hold null, for a typed object read from it.
public func jsNullKeys(_ object: Any?, _ keys: [String]) -> Set<String>? {
    guard let dynamic = jsFlat(object) as? JSDynamic else { return nil }
    let nulls = keys.filter { dynamic[jsKey: $0] is JSNull }
    return nulls.isEmpty ? nil : Set(nulls)
}

/// The keys of `object` among `keys` that it holds as undefined, for a typed object read from it.
public func jsUnsetKeys(_ object: Any?, _ keys: [String]) -> Set<String>? {
    guard let dynamic = jsFlat(object) as? JSDynamic else { return nil }
    let own = dynamic.jsKeys
    let unset = keys.filter { own.contains($0) && dynamic[jsKey: $0] == nil }
    return unset.isEmpty ? nil : Set(unset)
}

/// An object literal's keys that hold null: `known` ones, and those of `values` (untyped values it was given) that are null.
public func jsNullKeysOf(_ known: [String], _ values: [(String, Any?)]) -> Set<String>? {
    let nulls = known + values.filter { $0.1 is JSNull }.map { $0.0 }
    return nulls.isEmpty ? nil : Set(nulls)
}

/// An object literal's optional fields given null or undefined, as its values run: the keys its shape notes (`jsNulls`, `jsUnset`).
public struct JSLiteralKeys {
    public private(set) var nulls: Set<String>?
    public private(set) var unset: Set<String>?

    public init(nulls: Set<String>? = nil, unset: Set<String>? = nil) {
        self.nulls = nulls
        self.unset = unset
    }

    /// An untyped value, before it is converted to the field's type, which holds null and undefined both as nil.
    @discardableResult
    public mutating func untyped(_ key: String, _ value: Any?) -> Any? {
        if value == nil { unset = (unset ?? []).union([key]) } else if value is JSNull { nulls = (nulls ?? []).union([key]) }
        return value
    }

    /// A typed value, whose nil is undefined.
    @discardableResult
    public mutating func typed<V>(_ key: String, _ value: V?) -> V? {
        if value == nil { unset = (unset ?? []).union([key]) }
        return value
    }

    /// A typed value, whose nil is null.
    public mutating func nulled<V>(_ key: String, _ value: V?) -> V? {
        if value == nil { nulls = (nulls ?? []).union([key]) }
        return value
    }
}

/// A class with its own `toString()`, which JavaScript's string conversion calls.
public protocol JSStringConvertible {
    func toString() throws -> String
}

/// A class with its own `valueOf()`, which ToPrimitive calls first unless a string is wanted.
public protocol JSValueOfConvertible: AnyObject {
    func jsValueOf() throws -> Any?
}

// MARK: - Null and undefined told apart

/// A typed slot that may hold undefined, null or a `Wrapped`, where the program tells null from undefined (a
/// `T | null | undefined` whose code compares it with either). Its nil literal is undefined.
public enum JSNullish<Wrapped>: ExpressibleByNilLiteral {
    case undefined
    case null
    case value(Wrapped)

    public init(nilLiteral: ()) { self = .undefined }

    /// A typed value whose nil is undefined.
    public init(_ value: Wrapped?) { self = value.map { .value($0) } ?? .undefined }

    /// A typed value whose nil is null.
    public init(null value: Wrapped?) { self = value.map { .value($0) } ?? .null }

    /// An untyped value: `jsNull` is null and nil undefined; another value not a `Wrapped` throws the TypeError.
    public init(any value: Any?) throws {
        guard let value = jsFlat(value) else { self = .undefined; return }
        self = value is JSNull ? .null : .value(try jsCastPresent(value, Wrapped.self))
    }

    /// Its value, with null and undefined both nil.
    @inline(__always)
    public var optional: Wrapped? {
        if case .value(let v) = self { return v }
        return nil
    }

    /// Its value where a member of it is set: JavaScript's TypeError setting `key` when it is null or undefined.
    @inline(__always)
    public func present(setting key: String) throws -> Wrapped {
        switch self {
        case .value(let v): return v
        case .null: throw JSException(JSTypeError("Cannot set properties of null (setting '\(key)')"))
        case .undefined: throw jsCannotSet(key)
        }
    }

    /// Its value where a typed use needs one: JavaScript's TypeError reading `key` when it is null or undefined.
    @inline(__always)
    public func present(_ key: String) throws -> Wrapped {
        switch self {
        case .value(let v): return v
        case .null: throw jsCannotRead(key, true)
        case .undefined: throw jsCannotRead(key, false)
        }
    }

    /// As script holds it: null is `jsNull`, undefined nil.
    public var jsAny: Any? {
        switch self {
        case .undefined: return nil
        case .null: return jsNull
        case .value(let v): return v
        }
    }
}

/// Strict equality, as `indexOf`, `includes` and a Set's or Map's keys compare: null is only null, undefined only undefined.
extension JSNullish: Equatable where Wrapped: Equatable {}
extension JSNullish: Hashable where Wrapped: Hashable {}

/// A `JSNullish` of any `Wrapped`, as code reading values dynamically (JSON, console, an untyped read) sees it.
public protocol JSNullishValue {
    var jsAny: Any? { get }
    /// An untyped value as this type; nil where a present value isn't a `Wrapped`.
    static func jsNullish(_ value: Any?) -> Self?
}

extension JSNullish: JSNullishValue {
    public static func jsNullish(_ value: Any?) -> JSNullish? {
        guard let value = jsFlat(value) else { return .undefined }
        if value is JSNull { return .null }
        return jsConverted(value, to: Wrapped.self).map { .value($0) }
    }
}

// MARK: - Optionals inside Any

protocol JSOptionalProtocol {
    static var jsNone: Any { get }
}

extension Optional: JSOptionalProtocol {
    static var jsNone: Any { Optional<Wrapped>.none as Any }
}

/// `value` with nested optionals collapsed: a generic `T?` holding nil, boxed in `Any?`, is undefined.
@inline(__always)
public func jsFlat(_ value: Any?) -> Any? {
    guard let value else { return nil }
    switch jsTypeKind(value) {
    case .optional:
        // A cast to `Any?` unwraps one level of any optional without looking up its type's conformance to a protocol.
        if let unwrapped = jsDynamicCast(value, to: Any?.self) { return jsFlat(unwrapped) }
        return value
    case .enum:
        // A `JSNullish<Any>` may hold its value as an optional.
        if let nullish = value as? JSNullishValue { return jsFlat(nullish.jsAny) }
        return value
    default:
        return value
    }
}

/// `value as? T` decided at run time, where `T` (`Any?`) makes the cast one the compiler would call trivial.
@inline(__always)
func jsDynamicCast<T>(_ value: Any, to _: T.Type) -> T? { value as? T }

// MARK: - What a value is, read from its type's metadata

/// The kind word that starts every type's metadata (the Swift ABI's `MetadataKind`). Hot paths read it
/// before casting: a cast to a protocol or a bridged type looks up conformances, slowly for each new type.
enum JSTypeKind: UInt {
    case swiftClass = 0
    case `struct` = 0x200
    case `enum` = 0x201
    case optional = 0x202
    case tuple = 0x301
    case function = 0x302
    case metatype = 0x304
    case objCClass = 0x305
    case existentialMetatype = 0x306
    case other = 0xFFFF
}

@inline(__always)
func jsTypeKind(_ value: Any) -> JSTypeKind {
    let word = unsafeBitCast(type(of: value), to: UnsafePointer<UInt>.self).pointee
    // A class's metadata starts with its isa pointer, never a small kind number.
    if word > 0x7FF { return .swiftClass }
    return JSTypeKind(rawValue: word) ?? .other
}

/// A class (or other type) held as a value. Swift casts a class object to a protocol its instances
/// take, so it must be told apart before such a cast calls an instance member on the class itself.
@inline(__always)
func jsIsClassObject(_ value: Any) -> Bool {
    let kind = jsTypeKind(value)
    return kind == .metatype || kind == .existentialMetatype
}

/// An object no cast to a Swift number, string or boolean unwraps: a Swift object, or an
/// Objective-C one that is not an NSNumber, an NSString or a boxed Swift value.
func jsIsOpaqueObject(_ value: Any) -> Bool {
    switch jsTypeKind(value) {
    case .swiftClass: return jsClassShape(of: value)?.opaque ?? false
    case .objCClass: return jsClassShape(value as AnyObject).opaque
    default: return false
    }
}

/// `jsIsOpaqueObject` of an instance of a class, which its class alone decides.
private func jsInstanceIsOpaque(_ value: Any) -> Bool {
    switch jsTypeKind(value) {
    case .swiftClass: if jsAsNSObject(value) == nil { return true }
    case .objCClass: if !(value is NSObject) { return false }
    default: return false
    }
    if value is NSNumber || value is NSString { return false }
    return jsSwiftValueClass.map { object_getClass(value as AnyObject) !== $0 } ?? true
}

private let jsSwiftValueClass: AnyClass? = NSClassFromString("__SwiftValue")

/// `value as? NSObject`, which for an instance of a Swift class first looks for a bridging conformance, slowly for each new class.
func jsAsNSObject(_ value: Any) -> NSObject? {
    guard jsTypeKind(value) == .swiftClass else { return value as? NSObject }
    let object = value as AnyObject
    var cls: AnyClass? = object_getClass(object)
    while let current = cls {
        if current === NSObject.self { return unsafeDowncast(object, to: NSObject.self) }
        cls = class_getSuperclass(current)
    }
    return nil
}

/// Whether an Objective-C object's class takes none of the runtime's protocols `jsGet` tries, once per class.
func jsIsNativeOnly(_ object: NSObject) -> Bool {
    let cls: AnyClass = type(of: object)
    let id = ObjectIdentifier(cls)
    jsNativeOnlyLock.lock()
    defer { jsNativeOnlyLock.unlock() }
    if let known = jsNativeOnlyClasses[id] { return known }
    let only = !(cls is JSDynamic.Type || cls is JSArrayProtocol.Type || cls is JSMapProtocol.Type || cls is JSSetProtocol.Type || cls is JSThenable.Type)
    jsNativeOnlyClasses[id] = only
    return only
}

private var jsNativeOnlyClasses: [ObjectIdentifier: Bool] = [:]
private let jsNativeOnlyLock = NSLock()

/// The casts `jsGet`, `jsHasKey` and the conversions would make on an instance of a class, answered once per
/// class: each cast to a protocol costs a conformance lookup on every read.
struct JSClassShape {
    /// `jsIsOpaqueObject`.
    var opaque = false
    var null = false
    /// A JSDynamic that is no NSObject and no JSMootValue: what script holds as an object.
    var script = false
    var plainObject = false
    var function = false
    var hostObject = false
    /// A JSExpando that is no JSError.
    var expando = false
    var valueOf = false
    var toPrimitive = false
    /// The class as the protocol type, cast once: `jsDynamic(_:as:)` reaches an instance through it without a cast per access.
    var dynamicType: JSDynamic.Type?
    var expandoType: JSExpando.Type?
    /// An expando whose class is `jsSymbolPlain`: a symbol key it reads is its own property or its prototype chain's.
    var symbolPlain = false
    /// An expando whose class is `jsSymbolFieldsPlain`: no declared symbol-keyed fields match `subscript(jsKey:)` or `jsSymbolKeys`.
    var symbolFieldsPlain = false
}

func jsClassShape(_ object: AnyObject) -> JSClassShape {
    let cls: AnyClass = type(of: object)
    if let known = jsKnownShape(ObjectIdentifier(cls)) { return known }
    return jsMakeShape(object, cls)
}

/// The shapes of the classes read last, by their metadata's address: most reads repeat a few classes.
private struct JSRecentShape {
    var id: ObjectIdentifier?
    var shape: JSClassShape
}

private let jsRecentShapes: UnsafeMutablePointer<JSRecentShape> = {
    let recent = UnsafeMutablePointer<JSRecentShape>.allocate(capacity: 32)
    recent.initialize(repeating: JSRecentShape(id: nil, shape: JSClassShape()), count: 32)
    return recent
}()

@inline(__always)
private func jsKnownShape(_ id: ObjectIdentifier) -> JSClassShape? {
    let bits = UInt(bitPattern: id)
    let slot = jsRecentShapes + Int((bits >> 4 ^ bits >> 9) & 31)
    jsShapeLock.lock()
    defer { jsShapeLock.unlock() }
    if slot.pointee.id == id { return slot.pointee.shape }
    guard let known = jsShapes[id] else { return nil }
    slot.pointee = JSRecentShape(id: id, shape: known)
    return known
}

@inline(never)
private func jsMakeShape(_ object: AnyObject, _ cls: AnyClass) -> JSClassShape {
    let id = ObjectIdentifier(cls)
    var shape = JSClassShape()
    shape.opaque = jsInstanceIsOpaque(object)
    shape.null = cls is JSNull.Type
    if jsAsNSObject(object) == nil && !(cls is JSMootValue.Type) && cls is JSDynamic.Type {
        shape.script = true
        shape.plainObject = cls is JSObject.Type
        shape.function = cls is JSFunctionObject.Type
        shape.hostObject = cls is JSHostObject.Type
        shape.expando = cls is JSExpando.Type && !(cls is JSError.Type)
        shape.valueOf = cls is JSValueOfConvertible.Type
        shape.toPrimitive = cls is JSToPrimitive.Type
        shape.dynamicType = cls as? JSDynamic.Type
        if shape.expando, let expando = cls as? JSExpando.Type {
            shape.expandoType = expando
            shape.symbolPlain = expando.jsSymbolPlain
            shape.symbolFieldsPlain = expando.jsSymbolFieldsPlain
        }
    }
    jsShapeLock.lock()
    jsShapes[id] = shape
    jsShapeLock.unlock()
    return shape
}

/// The shape of a value's class where the value is an instance of a Swift class (an NSObject subclass included).
@inline(__always)
func jsClassShape(of value: Any) -> JSClassShape? {
    let cls = type(of: value)
    // A class's metadata starts with its isa pointer, never a small kind number.
    guard unsafeBitCast(cls, to: UnsafePointer<UInt>.self).pointee > 0x7FF else { return nil }
    if let known = jsKnownShape(ObjectIdentifier(cls)) { return known }
    let object = jsClassInstance(value)
    return jsMakeShape(object, type(of: object))
}

/// The instance an `Any` holds where its type is a Swift class (`jsClassShape(of:)` gave a shape), without the
/// bridging `as AnyObject` runs. The container's fourth word is the type it stores: a class's metadata means the first
/// word is the reference; any other (an existential of another protocol the class instance was held as, which can be
/// boxed out of line) is left to the bridging.
@inline(__always)
func jsClassInstance(_ value: Any) -> AnyObject {
    withUnsafePointer(to: value) {
        let container = UnsafeRawPointer($0)
        let stored = container.load(fromByteOffset: 3 * MemoryLayout<UnsafeRawPointer>.size, as: UnsafePointer<UInt>.self)
        return stored.pointee > 0x7FF ? container.load(as: AnyObject.self) : value as AnyObject
    }
}

/// An instance as the protocol type its class's shape holds, without a dynamic cast.
@inline(__always)
func jsDynamic(_ object: AnyObject, as type: JSDynamic.Type) -> JSDynamic {
    func open<T: JSDynamic>(_: T.Type) -> JSDynamic { unsafeDowncast(object, to: T.self) }
    return open(type)
}

@inline(__always)
func jsExpando(_ object: AnyObject, as type: JSExpando.Type) -> JSExpando {
    func open<T: JSExpando>(_: T.Type) -> JSExpando { unsafeDowncast(object, to: T.self) }
    return open(type)
}

private var jsShapes: [ObjectIdentifier: JSClassShape] = [:]
private let jsShapeLock = JSUnfairLock()

/// An `os_unfair_lock` at a fixed address, for a cache read on every property access.
final class JSUnfairLock: @unchecked Sendable {
    nonisolated(unsafe) private let lockPointer: UnsafeMutablePointer<os_unfair_lock>
    nonisolated init() {
        lockPointer = .allocate(capacity: 1)
        lockPointer.initialize(to: os_unfair_lock())
    }
    nonisolated deinit { lockPointer.deallocate() }
    @inline(__always) nonisolated func lock() { os_unfair_lock_lock(lockPointer) }
    @inline(__always) nonisolated func unlock() { os_unfair_lock_unlock(lockPointer) }
}

/// `value` as `T`: undefined becomes nil for an optional `T`, and any value is `()` for `Void`.
public func jsConverted<T>(_ value: Any?, to type: T.Type = T.self) -> T? {
    if T.self == Void.self { return (() as Any) as? T }
    guard let value = jsFlat(value) else {
        return (T.self as? JSOptionalProtocol.Type)?.jsNone as? T ?? (T.self as? JSNullishValue.Type)?.jsNullish(nil) as? T
    }
    if let same = value as? T { return same }
    // An array's view where the array's own type is expected: that array.
    if let view = value as? JSArrayProtocol, let source = view.jsViewSource as? T { return source }
    // An untyped object where a typed one is expected (a generic `T` an interface stands for): read into it.
    if let convertible = T.self as? JSObjectConvertible.Type { return convertible.init(jsObject: value) as? T }
    if let nullish = T.self as? JSNullishValue.Type { return nullish.jsNullish(value) as? T }
    return nil
}

/// A class for an object shape that reads an untyped object (`JSON.parse` output) into itself.
public protocol JSObjectConvertible: AnyObject {
    init(jsObject: Any?)
}

func jsIsUndefined<T>(_ value: T) -> Bool {
    guard T.self is JSOptionalProtocol.Type || T.self == Any.self else { return false }
    return jsFlat(value) == nil
}

func jsIsObject(_ value: Any) -> Bool { type(of: value) is AnyClass }

/// A typed tuple (`[number, number, number]`), an array to script.
func jsIsTuple(_ value: Any) -> Bool { jsTypeKind(value) == .tuple }

/// Whether `value` is a Swift closure (a JavaScript function).
func jsIsFunction(_ value: Any) -> Bool {
    if value is JSFunctionObject { return true }
    guard jsTypeKind(value) == .function else { return false }
    if value is JSFunction { return true }
    let name = String(describing: type(of: value))
    guard name.first == "(" else { return false }
    var depth = 0
    var index = name.startIndex
    while index < name.endIndex {
        let c = name[index]
        if c == "(" || c == "<" || c == "[" { depth += 1 }
        if c == ")" || c == ">" || c == "]" {
            depth -= 1
            if depth == 0 { break }
        }
        index = name.index(after: index)
    }
    guard index < name.endIndex else { return false }
    let rest = name[name.index(after: index)...]
    return rest.hasPrefix(" -> ") || rest.hasPrefix(" throws") || rest.hasPrefix(" async")
}

@inline(__always)
func jsNumeric(_ value: Any) -> Double? {
    switch value {
    case let d as Double: return d
    case let i as Int: return Double(i)
    case let f as Float: return Double(f)
    case let i as Int32: return Double(i)
    case let i as UInt32: return Double(i)
    case let i as Int64: return Double(i)
    default: return jsOtherNumeric(value)
    }
}

/// The number representations native APIs give besides the common ones above. Read by kind first: casting a string
/// to an Objective-C class bridges it, and a protocol cast looks up conformances.
private func jsOtherNumeric(_ value: Any) -> Double? {
    switch jsTypeKind(value) {
    case .struct, .enum:
        switch value {
        case is String, is Bool: return nil
        case let f as CGFloat: return Double(f)
        case let i as UInt: return Double(i)
        case let i as UInt64: return Double(i)
        case let i as Int16: return Double(i)
        case let i as UInt16: return Double(i)
        case let i as Int8: return Double(i)
        case let i as UInt8: return Double(i)
        case let d as Decimal: return NSDecimalNumber(decimal: d).doubleValue
        default:
            // A native enum or option set: script sees its raw number.
            if let raw = value as? any RawRepresentable, let n = raw.rawValue as? any BinaryInteger { return Double(n) }
            return nil
        }
    case .objCClass:
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        return n.doubleValue
    default:
        return nil
    }
}

// MARK: - Strings compared as JavaScript compares them

/// `a === b` for strings: equal code units (Swift's `==` also equates canonically equivalent strings).
@inlinable public func jsStringEquals(_ a: String, _ b: String) -> Bool {
    let x = a.utf8, y = b.utf8
    let count = x.count
    guard count == y.count else { return false }
    if let same = x.withContiguousStorageIfAvailable({ p in y.withContiguousStorageIfAvailable { q in count == 0 || memcmp(p.baseAddress!, q.baseAddress!, count) == 0 } }), let same { return same }
    return x.elementsEqual(y)
}

public func jsStringEquals(_ a: String?, _ b: String?) -> Bool {
    guard let a, let b else { return a == nil && b == nil }
    return jsStringEquals(a, b)
}

/// A `case "literal":` of a string `switch` matches as `===` does.
@inlinable public func ~= (pattern: String, value: String) -> Bool { jsStringEquals(pattern, value) }

/// `a < b` for strings: UTF-16 code unit order.
public func jsStringLess(_ a: String, _ b: String) -> Bool { jsCompareUnits(a, b) < 0 }

/// A property or collection key hashed and compared by code units.
struct JSPropertyKey: Hashable {
    let string: String
    init(_ string: String) { self.string = string }

    static func == (a: JSPropertyKey, b: JSPropertyKey) -> Bool { jsStringEquals(a.string, b.string) }

    /// The bytes folded into one word first (FNV-1a), which the seeded Hasher then mixes once: hashing every
    /// byte through Hasher made each property lookup on a JavaScript object about twice as slow.
    func hash(into hasher: inout Hasher) {
        var folded: UInt64 = 0xcbf2_9ce4_8422_2325
        let utf8 = string.utf8
        let hashed: Void? = utf8.withContiguousStorageIfAvailable { for byte in $0 { folded = (folded ^ UInt64(byte)) &* 0x100_0000_01b3 } }
        if hashed == nil { for byte in utf8 { folded = (folded ^ UInt64(byte)) &* 0x100_0000_01b3 } }
        hasher.combine(folded)
    }
}

/// The array index a property key names (`"0"`…`"4294967294"`), if it names one.
func jsArrayIndex(_ key: String) -> UInt32? {
    let utf8 = key.utf8
    guard let first = utf8.first, utf8.count <= 10, first >= 0x30, first <= 0x39 else { return nil }
    if first == 0x30 { return utf8.count == 1 ? 0 : nil }
    var n: UInt64 = 0
    for c in utf8 {
        guard c >= 0x30 && c <= 0x39 else { return nil }
        n = n * 10 + UInt64(c - 0x30)
    }
    return n < 4_294_967_295 ? UInt32(n) : nil
}

// MARK: - Plain objects

/// A plain JavaScript object. Own keys enumerate in JavaScript order: array-index keys
/// ascending, then the other keys in insertion order.
public final class JSObject: JSDynamic, JSSymbolKeyed, JSAccessorKeyed, JSReactiveConvertible, ExpressibleByDictionaryLiteral, CustomStringConvertible {
    nonisolated deinit {}
    private var storage: [JSPropertyKey: Any?] = [:]
    private var indexKeys: [UInt32] = []
    private var namedKeys: [String] = []
    /// How many of `namedKeys` are symbols' keys: a key of a kind the object holds none of is absent without a lookup.
    private var symbolKeyCount = 0
    /// Properties that are accessors or not plain writable, enumerable, configurable data.
    private var slots: [JSPropertyKey: JSPropertySlot] = [:]
    public private(set) var extensible = true
    public var jsTracker: JSTracker? {
        didSet { if isClassPrototype && (oldValue == nil) != (jsTracker == nil) { JSPrototypes.prototypeKeysChanged() } }
    }
    /// The object `Object.create(proto)` made it from: a key it doesn't have is read there.
    public var jsPrototype: Any?
    /// A class's prototype (`JSPrototypes.of`), whose keys decide what `JSPrototypes.holder` finds.
    var isClassPrototype = false

    public init() {}

    public init(dictionaryLiteral elements: (String, Any?)...) {
        for (key, value) in elements { define(key, value) }
    }

    public init(_ entries: [(String, Any?)]) {
        storage.reserveCapacity(entries.count)
        namedKeys.reserveCapacity(entries.count)
        for (key, value) in entries { define(key, value) }
    }

    /// `values` under `keys`, pairwise, with the storage sized once (JSON.parse's objects): a repeated key keeps
    /// its first position and takes its last value, as CreateDataProperty does.
    init<Keys: Collection<String>, Values: Collection<Any?>>(keys: Keys, values: Values) {
        storage.reserveCapacity(keys.count)
        namedKeys.reserveCapacity(keys.count)
        for (key, value) in zip(keys, values) { define(key, value) }
    }

    public subscript(key: String) -> Any? {
        get {
            if !slots.isEmpty, let getter = slots[JSPropertyKey(key)]?.get {
                do { return try getter(self) } catch { jsReportUncaught(jsCaught(error)); return nil }
            }
            guard let tracker = jsTracker else {
                if let value = storage[JSPropertyKey(key)] { return value }
                guard let proto = jsPrototype, !(proto is JSNull) else { return nil }
                do { return try (proto as? JSObject).map { try $0.get(key, receiver: self) } ?? jsGet(proto, key) } catch { jsReportUncaught(jsCaught(error)); return nil }
            }
            tracker.track()
            return jsReactiveAny(storage[JSPropertyKey(key)] ?? nil)
        }
        set {
            if !slots.isEmpty || !extensible || jsPrototype != nil {
                do { try put(key, newValue) } catch { jsReportUncaught(jsCaught(error)) }
                return
            }
            guard let tracker = jsTracker else { define(key, newValue); return }
            let old = storage[JSPropertyKey(key)]
            define(key, newValue)
            if let old, jsSameValue(old, newValue) { return }
            tracker.trigger()
        }
    }

    /// `has(key) ? get(key, receiver:) : nil` in one lookup, what a getter throws reported: nil where the key is not the object's own.
    func ownValue(_ key: String, receiver: Any?) -> Any?? {
        jsTracker?.track()
        if holdsNone(like: key) { return nil }
        let k = JSPropertyKey(key)
        guard let value = storage[k] else { return nil }
        if !slots.isEmpty, let slot = slots[k], slot.isAccessor {
            do { return .some(try slot.get?(receiver) ?? nil) } catch { jsReportUncaught(jsCaught(error)); return .some(nil) }
        }
        return .some(value)
    }

    /// A prototype's property read for an instance: a getter runs with the instance as `this`.
    func get(_ key: String, receiver: Any?) throws -> Any? {
        let k = JSPropertyKey(key)
        if !slots.isEmpty, let slot = slots[k] {
            if let getter = slot.get { return try getter(receiver) }
            if slot.isAccessor { return nil }
        }
        if let value = storage[k] { return value }
        return try (jsPrototype as? JSObject)?.get(key, receiver: receiver) ?? nil
    }

    /// The object of the prototype chain that has `key`, the object itself excluded.
    private func inheritedHolder(_ key: JSPropertyKey) -> JSObject? {
        var p = jsPrototype as? JSObject
        while let holder = p {
            if holder.storage[key] != nil { return holder }
            p = holder.jsPrototype as? JSObject
        }
        return nil
    }

    /// A prototype's setter for a key, nil when the key holds a value; an accessor without one throws as strict code does.
    func setter(_ key: String) -> ((Any?, Any?) throws -> Void)? {
        guard !slots.isEmpty, let slot = slots[JSPropertyKey(key)], slot.isAccessor else { return nil }
        return slot.set ?? { _, _ in throw JSException(JSTypeError("Cannot set property \(key) of #<Object> which has only a getter")) }
    }

    /// `object[key]`, running a getter.
    public func get(_ key: String) throws -> Any? {
        if !slots.isEmpty, let getter = slots[JSPropertyKey(key)]?.get { return try getter(self) }
        return self[key]
    }

    /// Updates an already-present own property in one lookup (running its setter or checking writability); returns false if absent.
    func setIfPresent(_ key: String, _ value: Any?, receiver: Any?) throws -> Bool {
        if holdsNone(like: key) { return false }
        let k = JSPropertyKey(key)
        guard let idx = storage.index(forKey: k) else { return false }
        if !slots.isEmpty, let slot = slots[k] {
            if slot.isAccessor {
                guard let setter = slot.set else { throw JSException(JSTypeError("Cannot set property \(key) of #<Object> which has only a getter")) }
                try setter(receiver, value)
                return true
            }
            if !slot.writable { throw JSException(JSTypeError("Cannot assign to read only property '\(key)' of object '#<Object>'")) }
        }
        if let tracker = jsTracker {
            let old = storage.values[idx]
            storage.values[idx] = value
            if !jsSameValue(old, value) { tracker.trigger() }
        } else {
            storage.values[idx] = value
        }
        return true
    }

    /// Inserts a new plain own property when the caller already verified it is absent and the backing store is extensible.
    func defineNewOwn(_ key: String, _ value: Any?) {
        define(key, JSPropertyKey(key), value)
        jsTracker?.trigger()
    }

    /// `object[key] = value` in strict code: a read-only property, a getter without a setter
    /// or a new key on an object that is not extensible throws a TypeError.
    public func put(_ key: String, _ value: Any?) throws {
        let k = JSPropertyKey(key)
        if slots.isEmpty && extensible && jsPrototype == nil && jsTracker == nil {
            define(key, k, value)
            return
        }
        if !slots.isEmpty, let slot = slots[k] {
            if slot.isAccessor {
                guard let setter = slot.set else { throw JSException(JSTypeError("Cannot set property \(key) of #<Object> which has only a getter")) }
                return try setter(self, value)
            }
            if !slot.writable { throw JSException(JSTypeError("Cannot assign to read only property '\(key)' of object '#<Object>'")) }
        } else if storage[k] == nil {
            // OrdinarySet: an inherited accessor runs with this object as `this`; an inherited read-only value refuses.
            if jsPrototype != nil, let inherited = inheritedHolder(k)?.slots[k] {
                if inherited.isAccessor {
                    guard let setter = inherited.set else { throw JSException(JSTypeError("Cannot set property \(key) of #<Object> which has only a getter")) }
                    return try setter(self, value)
                }
                if !inherited.writable { throw JSException(JSTypeError("Cannot assign to read only property '\(key)' of object '#<Object>'")) }
            }
            if !extensible { throw JSException(JSTypeError("Cannot add property \(key), object is not extensible")) }
        }
        guard let tracker = jsTracker else { define(key, k, value); return }
        let old = storage[k]
        define(key, k, value)
        if let old, jsSameValue(old, value) { return }
        tracker.trigger()
    }

    /// `Object.defineProperty(object, key, descriptor)`; attributes the descriptor leaves out are false for a new property.
    public func defineProperty(_ key: String, _ d: JSPropertyDescriptor) throws {
        let k = JSPropertyKey(key)
        let exists = storage[k] != nil
        var slot = slots[k] ?? JSPropertySlot(enumerable: exists, writable: exists, configurable: exists)
        if !exists && !extensible { throw JSException(JSTypeError("Cannot define property \(key), object is not extensible")) }
        if exists && !slot.configurable {
            let changes = d.get != nil || d.set != nil || d.configurable == true || (d.enumerable.map { $0 != slot.enumerable } ?? false)
                || (!slot.writable && (d.writable == true || (d.value.map { !jsSameValue($0, storage[k] ?? nil) } ?? false)))
            if changes { throw JSException(JSTypeError("Cannot redefine property: \(key)")) }
        }
        if d.get != nil || d.set != nil {
            slot.get = d.get
            slot.set = d.set
            slot.isAccessor = true
            slot.writable = false
        } else if d.value != nil || d.writable != nil {
            if slot.isAccessor { slot.get = nil; slot.set = nil; slot.isAccessor = false }
        }
        if let v = d.enumerable { slot.enumerable = v }
        if let v = d.writable { slot.writable = v }
        if let v = d.configurable { slot.configurable = v }
        define(key, slot.isAccessor ? nil as Any? : (d.value ?? (storage[k] ?? nil)))
        slots[k] = slot.isPlain ? nil : slot
        if isClassPrototype { JSPrototypes.prototypeKeysChanged() }
        jsTracker?.trigger()
    }

    /// The getter of an own accessor property.
    func getter(_ key: String) -> ((Any?) throws -> Any?)? { slots.isEmpty ? nil : slots[JSPropertyKey(key)]?.get }

    /// `Object.getOwnPropertyDescriptor(object, key)`.
    public func descriptor(_ key: String) -> JSObject? {
        let k = JSPropertyKey(key)
        guard storage[k] != nil else { return nil }
        let slot = slots[k] ?? JSPropertySlot()
        if slot.isAccessor {
            return JSObject([("get", slot.get.map { g in { (_: [Any?]) throws -> Any? in try g(self) } as JSFunction } as Any?), ("set", slot.set.map { s in { (a: [Any?]) throws -> Any? in try s(self, jsArg(a, 0)); return nil } as JSFunction } as Any?),
                             ("enumerable", slot.enumerable), ("configurable", slot.configurable)])
        }
        return JSObject([("value", storage[k] ?? nil), ("writable", slot.writable), ("enumerable", slot.enumerable), ("configurable", slot.configurable)])
    }

    /// `Object.freeze`, `Object.seal`, `Object.preventExtensions`.
    public func restrict(sealed: Bool, frozen: Bool) {
        extensible = false
        guard sealed || frozen else { return }
        for key in indexKeys.map({ String($0) }) + namedKeys {
            var slot = slots[JSPropertyKey(key)] ?? JSPropertySlot()
            slot.configurable = false
            if frozen && !slot.isAccessor { slot.writable = false }
            slots[JSPropertyKey(key)] = slot
        }
    }

    public var isSealed: Bool { !extensible && storage.keys.allSatisfy { !(slots[$0] ?? JSPropertySlot()).configurable } }
    public var isFrozen: Bool { !extensible && storage.keys.allSatisfy { let s = slots[$0] ?? JSPropertySlot(); return !s.configurable && (s.isAccessor || !s.writable) } }

    public func jsAccessorKind(_ key: String) -> String? {
        guard let slot = slots[JSPropertyKey(key)], slot.isAccessor else { return nil }
        return slot.get != nil && slot.set != nil ? "Getter/Setter" : slot.get != nil ? "Getter" : "Setter"
    }

    /// `Object.getOwnPropertyNames(object)`: string keys, enumerable or not.
    public var ownPropertyNames: [String] {
        indexKeys.map { String($0) } + namedKeys.filter { !jsIsSymbolKey($0) }
    }

    private func define(_ key: String, _ value: Any?) {
        define(key, JSPropertyKey(key), value)
    }

    private func define(_ key: String, _ k: JSPropertyKey, _ value: Any?) {
        if storage.updateValue(value, forKey: k) == nil {
            if isClassPrototype { JSPrototypes.prototypeKeysChanged() }
            if let index = jsArrayIndex(key) {
                var low = 0, high = indexKeys.count
                while low < high {
                    let mid = (low + high) / 2
                    if indexKeys[mid] < index { low = mid + 1 } else { high = mid }
                }
                indexKeys.insert(index, at: low)
            } else {
                namedKeys.append(key)
                if jsIsSymbolKey(key) { symbolKeyCount += 1 }
            }
        }
    }

    /// `key in object` for own keys.
    public func has(_ key: String) -> Bool {
        jsTracker?.track()
        return !holdsNone(like: key) && storage[JSPropertyKey(key)] != nil
    }

    @inline(__always)
    private func holdsNone(like key: String) -> Bool {
        jsIsSymbolKey(key) ? symbolKeyCount == 0 : indexKeys.isEmpty && namedKeys.count == symbolKeyCount
    }

    /// `delete object[key]`.
    @discardableResult
    public func delete(_ key: String) -> Bool {
        if let slot = slots[JSPropertyKey(key)], !slot.configurable { return false }
        slots[JSPropertyKey(key)] = nil
        guard storage.removeValue(forKey: JSPropertyKey(key)) != nil else { return true }
        if isClassPrototype { JSPrototypes.prototypeKeysChanged() }
        if let index = jsArrayIndex(key) {
            indexKeys.removeAll { $0 == index }
        } else if let position = namedKeys.firstIndex(where: { jsStringEquals($0, key) }) {
            namedKeys.remove(at: position)
            if jsIsSymbolKey(key) { symbolKeyCount -= 1 }
        }
        jsTracker?.trigger()
        return true
    }

    /// `Object.keys(object)` as a Swift array.
    public var keys: [String] {
        jsTracker?.track()
        let all = indexKeys.map { String($0) } + namedKeys.filter { !jsIsSymbolKey($0) }
        return slots.isEmpty ? all : all.filter { slots[JSPropertyKey($0)]?.enumerable ?? true }
    }

    public var jsSymbolKeys: [String] {
        jsTracker?.track()
        return namedKeys.filter(jsIsSymbolKey)
    }

    public subscript(jsKey key: String) -> Any? {
        get { self[key] }
        set { self[key] = newValue }
    }

    public var jsKeys: [String] { keys }
    public var jsClassName: String? = nil

    public func jsMakeReactive() {
        if jsTracker == nil { jsTracker = JSTracker() }
    }

    public var description: String { jsInspect(self) }
}

/// ToPrimitive of an untyped object: its `[Symbol.toPrimitive]` method, else OrdinaryToPrimitive over its own `valueOf` and
/// `toString` (a literal's methods).
extension JSObject: JSToPrimitive {
    public func jsToPrimitive(_ hint: String) throws -> Any? {
        if let exotic = jsFlat(self[JSSymbol.toPrimitive.key]), !(exotic is JSNull) {
            guard jsIsFunction(exotic) else { throw JSException(JSTypeError("\(jsInspect(exotic)) is not a function")) }
            let result = jsFlat(try jsInvoke(exotic, self, [hint]))
            if result == nil || !jsIsObject(result!) || result is JSNull || result is JSSymbol || result is JSBigInt { return result }
            throw JSException(JSTypeError("Cannot convert object to primitive value"))
        }
        for name in hint == "string" ? ["toString", "valueOf"] : ["valueOf", "toString"] {
            guard let method = self[name], jsIsFunction(method) else {
                // Object.prototype's toString gives a primitive; its valueOf gives the object, so the next method runs.
                if name == "toString" { return jsStringTag(self).map { "[object \($0)]" } ?? "[object Object]" }
                continue
            }
            let result = jsFlat(try jsInvoke(method, self, []))
            if result == nil || !jsIsObject(result!) || result is JSNull || result is JSSymbol || result is JSBigInt { return result }
        }
        throw JSException(JSTypeError("Cannot convert object to primitive value"))
    }
}

// MARK: - Property access

/// `object[key]` / `object.key` on a dynamic value. Reading from undefined or null throws a TypeError.
/// `o?.key`, or a member read further along an optional chain, of an untyped value: undefined once the chain reaches undefined or null.
public func jsGetIfPresent(_ object: Any?, _ key: String) throws -> Any? {
    jsIsNullish(object) ? nil : try jsGet(object, key)
}

/// `Object.create(proto)`: an object whose missing keys read from `proto` (nil: none).
public func jsObjectCreate(_ proto: Any?) -> JSObject {
    let object = JSObject()
    object.jsPrototype = jsFlat(proto)
    return object
}

public func jsGet(_ object: Any?, _ key: String) throws -> Any? {
    let object = jsFlat(object)
    let shape = object.flatMap { jsClassShape(of: $0) }
    if let value = object, let shape, shape.script {
        let instance = jsClassInstance(value)
        if shape.plainObject { return try unsafeDowncast(instance, to: JSObject.self).get(key) }
        if shape.symbolFieldsPlain, jsIsSymbolKey(key) {
            let expando = jsExpando(instance, as: shape.expandoType!)
            return shape.symbolPlain ? jsExpandoSymbolGet(expando, key) : jsExpandoGet(expando, key)
        }
        return jsDynamic(instance, as: shape.dynamicType!)[jsKey: key]
    }
    if let value = object, shape == nil, jsTypeKind(value) == .struct {
        if let string = value as? String {
            if key == "length" { return Double(string.utf16.count) }
            if key == "constructor" { return jsStringConstructor }
            if let index = jsArrayIndex(key) {
                let units = JSStringUnits(string)
                return Int(index) < units.count ? jsString(unit: units[Int(index)]) : nil
            }
            return jsStringMethod(string, key)
        }
        if let number = value as? Double { return key == "constructor" ? jsNumberConstructor : jsNumberMethod(number, key) }
        if let bool = value as? Bool { return key == "constructor" ? jsBooleanConstructor : jsBooleanMethod(bool, key) }
        if let big = value as? JSBigInt { return jsBigIntMethod(big, key) }
    }
    if let value = object, shape?.opaque ?? (jsTypeKind(value) == .objCClass && jsClassShape(value as AnyObject).opaque) {
        if let native = jsAsNSObject(value) {
            if jsIsNativeOnly(native) { return jsNativeGet(native, key) }
        } else {
            if let moot = value as? JSMootValue, moot.undeclared { throw moot.unavailable() }
            if let plain = value as? JSObject { return try plain.get(key) }
            if let dynamic = value as? JSDynamic { return dynamic[jsKey: key] }
        }
    }
    // A class itself (`cls.prototype`), before any cast a class object could wrongly pass as an instance.
    if shape == nil, let cls = object as? AnyClass { return key == "prototype" ? JSPrototypes.of(cls) : JSPrototypes.staticMember(cls, key) ?? (key == "name" ? jsClassValueName(cls) : nil) }
    switch object {
    case nil:
        throw JSException(JSTypeError("Cannot read properties of undefined (reading '\(key)')"))
    case is JSNull:
        throw JSException(JSTypeError("Cannot read properties of null (reading '\(key)')"))
    case let plain as JSObject:
        return try plain.get(key)
    case let dynamic as JSDynamic:
        return dynamic[jsKey: key]
    case let array as JSArrayProtocol:
        if key == "length" { return Double(array.jsLength) }
        if let index = jsArrayIndex(key) { return Int(index) < array.jsLength ? array.jsElement(at: Int(index)) : nil }
        if let side = jsSideProperties(array, create: false), side.has(key) { return try side.get(key, receiver: array) }
        return jsArrayMethod(array, key) ?? jsArrayGenericMethod(key)
    case let string as String:
        if key == "length" { return Double(string.utf16.count) }
        if key == "constructor" { return jsStringConstructor }
        if let index = jsArrayIndex(key) {
            let units = JSStringUnits(string)
            return Int(index) < units.count ? jsString(unit: units[Int(index)]) : nil
        }
        return jsStringMethod(string, key)
    case let match as JSMatch:
        if key == "length" { return match.length }
        if key == "index" { return match.isExecResult ? match.index : nil }
        if key == "input" { return match.isExecResult ? match.input : nil }
        if key == "groups" { return match.isExecResult ? match.groups : nil }
        if key == "indices" { return match.indices }
        if let index = jsArrayIndex(key) { return match.values.element(Double(index)) ?? nil }
        return nil
    case let map as JSMapProtocol:
        return key == "size" ? Double(map.jsSize) : jsMapMethod(map, key)
    case let set as JSSetProtocol:
        return key == "size" ? Double(set.jsSize) : jsSetMethod(set, key)
    // A typed tuple (`[CssProperty, unknown]`) read untyped is the array script made it as.
    case let value? where jsIsTuple(value):
        let elements = Mirror(reflecting: value).children.map { $0.value }
        if key == "length" { return Double(elements.count) }
        if let index = jsArrayIndex(key) { return Int(index) < elements.count ? jsFlat(elements[Int(index)]) : nil }
        return nil
    case let thenable as JSThenable:
        return jsPromiseMember(thenable, key)
    case let big as JSBigInt:
        return jsBigIntMethod(big, key)
    case let bool as Bool:
        return key == "constructor" ? jsBooleanConstructor : jsBooleanMethod(bool, key)
    case let number as Double:
        return key == "constructor" ? jsNumberConstructor : jsNumberMethod(number, key)
    case is JSFunction, is JSMethod:
        return jsFunctionMethod(key)
    // A Swift struct casts to NSObject too (boxed): a geometry struct is read by its fields first. An NSValue,
    // which Swift bridges to the struct it holds, is the native object (`toValue.CGRectValue`).
    case let value? where !(type(of: value) is AnyClass) && jsIsStruct(value):
        return jsStructMember(value, key)
    case let native as NSObject:
        return jsNativeGet(native, key)
    default:
        return nil
    }
}

func jsIsStruct(_ value: Any) -> Bool {
    #if canImport(UIKit)
    return value is CGPoint || value is CGSize || value is CGRect || value is UIEdgeInsets
    #else
    return false
    #endif
}

/// A member of a geometry struct held untyped (`view.sizeThatFits(…)` read as `{ width, height }`), as the runtime gives its fields.
func jsStructMember(_ value: Any?, _ key: String) -> Any? {
    #if canImport(UIKit)
    switch value {
    case let p as CGPoint: return key == "x" ? Double(p.x) : key == "y" ? Double(p.y) : nil
    case let z as CGSize: return key == "width" ? Double(z.width) : key == "height" ? Double(z.height) : nil
    case let r as CGRect: return key == "origin" ? r.origin : key == "size" ? r.size : nil
    case let i as UIEdgeInsets:
        switch key { case "top": return Double(i.top); case "left": return Double(i.left); case "bottom": return Double(i.bottom); case "right": return Double(i.right); default: return nil }
    default: return nil
    }
    #else
    return nil
    #endif
}

/// Undefined or null given where a function needs a value of its type (`addWeakEventListener(source, name, undefined, target)`):
/// the TypeError of the first use of it.
@inline(__always)
public func jsRequired<T>(_ value: T?, _ name: String) throws -> T {
    guard let value else { throw jsUndefinedValue(name) }
    return value
}

@inline(never)
public func jsUndefinedValue(_ name: String) -> JSException { JSException(JSTypeError("\(name) is undefined")) }

/// Lenient code: a value undefined where Swift needs the object (an array's element, a native method's argument).
@inline(__always)
public func jsObjectRequired<T>(_ value: T?) throws -> T {
    guard let value else { throw jsNoObject() }
    return value
}

/// Lenient code: a destructuring pattern's source, `key` its first property, nil for an array pattern: V8's TypeError where it is missing.
@inline(__always)
public func jsDestructured<T>(_ value: T?, _ key: String?) throws -> T {
    guard let value else { throw jsNotDestructurable(key) }
    return value
}

@inline(never)
public func jsNotDestructurable(_ key: String?) -> JSException {
    JSException(JSTypeError(key.map { "Cannot destructure property '\($0)' of 'undefined' as it is undefined." } ?? "undefined is not iterable (cannot read property Symbol(Symbol.iterator))"))
}

/// Lenient code: what `for…of` or a spread iterates, undefined where its type says a collection.
@inline(__always)
public func jsIterated<T>(_ value: T?, _ message: String) throws -> T {
    guard let value else { throw jsNotIterable(message) }
    return value
}

@inline(never)
public func jsNotIterable(_ message: String) -> JSException { JSException(JSTypeError(message)) }

@inline(never)
public func jsNoObject() -> JSException { JSException(JSTypeError("Cannot convert undefined or null to object")) }

/// Lenient code: a function value that may be missing, called as `name(…)`: V8's TypeError where it is.
@inline(__always)
public func jsCallable<F>(_ function: F?, _ name: String) throws -> F {
    guard let function else { throw jsNotCallable(name) }
    return function
}

@inline(never)
public func jsNotCallable(_ name: String) -> JSException { JSException(JSTypeError("\(name) is not a function")) }

/// A function value that may be missing, about to be called: undefined is not a function.
public func jsCallee<F>(_ function: F?) throws -> F {
    guard let function else { throw JSException(JSTypeError("undefined is not a function")) }
    return function
}

/// `object[key] op= value` on a dynamic value: the member read once, then written with what
/// `update` makes of it. The new value.
@discardableResult
public func jsUpdate(_ object: Any?, _ key: String, _ update: (Any?) throws -> Any?) throws -> Any? {
    let value = try update(jsGet(object, key))
    try jsSet(object, key, value)
    return value
}

/// `object[key]++` and `object[key]--` on a dynamic value: the old value, as a number.
@discardableResult
public func jsPostUpdate(_ object: Any?, _ key: String, _ step: Double) throws -> Double {
    let old = jsToNumber(try jsGet(object, key))
    try jsSet(object, key, old + step)
    return old
}

/// `object[key] = value` on a dynamic value. Writing to undefined or null throws a TypeError;
/// writes to other primitives are ignored.
public func jsSet(_ object: Any?, _ key: String, _ value: Any?) throws {
    let object = jsFlat(object)
    if let valueObj = object, let shape = jsClassShape(of: valueObj), shape.script {
        let instance = jsClassInstance(valueObj)
        if shape.plainObject {
            try unsafeDowncast(instance, to: JSObject.self).put(key, value)
            return
        }
        if shape.function && (key == "name" || key == "length") {
            throw JSException(JSTypeError("Cannot assign to read only property '\(key)' of function '\(jsToString(valueObj))'"))
        }
        if shape.expando {
            let expando = jsExpando(instance, as: shape.expandoType!)
            if let own = expando.jsExpando, try own.setIfPresent(key, value, receiver: expando) {
                return
            }
            if shape.symbolFieldsPlain && jsIsSymbolKey(key) {
                if let setter = JSPrototypes.setter(type(of: expando), key) {
                    try setter(expando, value)
                    return
                }
                if jsRestriction(expando) > 0 {
                    throw JSException(JSTypeError("Cannot add property \(key), object is not extensible"))
                }
                if expando.jsExpando == nil { expando.jsExpando = JSObject() }
                expando.jsExpando!.defineNewOwn(key, value)
                return
            }
        }
        let dynamic = jsDynamic(instance, as: shape.dynamicType!)
        let level = jsRestriction(dynamic)
        if level > 0 {
            let exists = dynamic.jsKeys.contains(key)
            if !exists { throw JSException(JSTypeError("Cannot add property \(key), object is not extensible")) }
            if level == 3 { throw JSException(JSTypeError("Cannot assign to read only property '\(key)' of object '#<Object>'")) }
        }
        jsRefusedWrite = nil
        dynamic[jsKey: key] = value
        if let refused = jsRefusedWrite {
            jsRefusedWrite = nil
            throw refused
        }
        return
    }
    switch object {
    case nil:
        throw JSException(JSTypeError("Cannot set properties of undefined (setting '\(key)')"))
    case is JSNull:
        throw JSException(JSTypeError("Cannot set properties of null (setting '\(key)')"))
    case let function? where (key == "name" || key == "length") && jsIsFunction(function):
        throw JSException(JSTypeError("Cannot assign to read only property '\(key)' of function '\(jsToString(function))'"))
    case let plain as JSObject:
        try plain.put(key, value)
    // A property the object was given (`Object.defineProperty(obj, key, …)`): its setter, or its value where writable, throwing as strict code does.
    case let expando as JSExpando where expando.jsExpando?.has(key) == true:
        let own = expando.jsExpando!
        if let setter = own.setter(key) { try setter(expando, value) } else { try own.put(key, value) }
    case let dynamic as JSDynamic:
        let level = jsRestriction(dynamic)
        if level > 0 {
            let exists = dynamic.jsKeys.contains(key)
            if !exists { throw JSException(JSTypeError("Cannot add property \(key), object is not extensible")) }
            if level == 3 { throw JSException(JSTypeError("Cannot assign to read only property '\(key)' of object '#<Object>'")) }
        }
        jsRefusedWrite = nil
        dynamic[jsKey: key] = value
        if let refused = jsRefusedWrite {
            jsRefusedWrite = nil
            throw refused
        }
    // `promise.cancel = fn` on the promise an animation returns: what its `cancel()` does.
    case let cancelable as JSCancelable where key == "cancel":
        cancelable.canceler = { jsReport { _ = try jsCall(value) } }
    case let native as NSObject:
        jsNativeSet(native, key, value)
    case let array as JSArrayProtocol:
        if key == "length" {
            let length = jsToNumber(value)
            guard length >= 0, length <= 4_294_967_295, length == length.rounded(.towardZero) else {
                throw JSException(JSRangeError("Invalid array length"))
            }
            try array.jsSetLength(Int(length))
        } else if let index = jsArrayIndex(key) {
            try array.jsSetElement(value, at: Int(index))
        } else if let side = jsSideProperties(array, create: true) {
            if let setter = side.setter(key) { try setter(array, value) } else { try side.put(key, value) }
        }
    default:
        break
    }
}

/// Calls a function stored in a dynamic value. Anything else throws a TypeError.
@discardableResult
public func jsCall(_ function: Any?, _ arguments: Any?...) throws -> Any? {
    try jsCall(function, spread: arguments)
}

/// `f(...args)` on an untyped value.
@discardableResult
public func jsCall(_ function: Any?, spread arguments: [Any?]) throws -> Any? {
    if let f = jsFlat(function) as? JSFunctionObject { return try f.call(nil, arguments) }
    if let f = jsFlat(function) as? JSFunction { return try f(arguments) }
    if let method = jsFlat(function) as? JSMethod { return try method(nil, arguments) }
    if let moot = jsFlat(function) as? JSMootValue { throw moot.unavailable() }
    throw JSException(JSTypeError("\(jsInspect(function)) is not a function"))
}

/// `Object.keys(value)`.
public func jsObjectKeys(_ value: Any?) -> JSArray<String> {
    switch jsFlat(value) {
    case let dynamic as JSDynamic: return JSArray(dynamic.jsKeys)
    case let array as JSArrayProtocol: return JSArray(jsKeysOf(array))
    case let string as String: return JSArray((0..<string.utf16.count).map { String($0) })
    default: return JSArray()
    }
}

/// `Object.values(value)`.
public func jsObjectValues(_ value: Any?) -> JSArray<Any?> {
    switch jsFlat(value) {
    case let dynamic as JSDynamic: return JSArray(dynamic.jsKeys.map { dynamic[jsKey: $0] })
    case let array as JSArrayProtocol: return JSArray(jsKeysOf(array).map { jsField(array, $0) })
    default: return JSArray()
    }
}

/// `Object.entries(value)`, each entry a `(key, value)` tuple.
public func jsObjectEntries(_ value: Any?) -> JSArray<(String, Any?)> {
    switch jsFlat(value) {
    case let dynamic as JSDynamic: return JSArray(dynamic.jsKeys.map { ($0, dynamic[jsKey: $0]) })
    case let array as JSArrayProtocol: return JSArray(jsKeysOf(array).map { ($0, jsField(array, $0)) })
    default: return JSArray()
    }
}

/// `Object.assign(target, ...sources)`.
@discardableResult
public func jsObjectAssign<T: JSDynamic>(_ target: T, _ sources: Any?...) throws -> T {
    for source in sources {
        switch jsFlat(source) {
        case let dynamic as JSDynamic:
            for key in dynamic.jsKeys { try jsSet(target, key, dynamic[jsKey: key]) }
        case let indexed? where indexed is JSArrayProtocol || indexed is String:
            for key in jsKeysOf(indexed) { try jsSet(target, key, jsField(indexed, key)) }
        default:
            break
        }
    }
    return target
}

// MARK: - Operators

/// `typeof value`.
public func jsTypeof(_ value: Any?) -> String {
    guard let v = jsFlat(value) else { return "undefined" }
    let t = type(of: v)
    if t == String.self { return "string" }
    if t == Bool.self { return "boolean" }
    if t == Double.self, !(v as! Double).isNaN { return "number" }
    if let d = v as? Double, d.isNaN, let entry = jsForeignEntry(d) { return jsTypeof(entry.value) }
    if v is JSFunctionObject { return "function" }
    if jsIsOpaqueObject(v) { return v is JSSymbol ? "symbol" : (v as? JSMootValue)?.undeclared == true ? "undefined" : "object" }
    if let boolean = jsNativeBoolean(v) { _ = boolean; return "boolean" }
    // Any other NSNumber (an NSDecimalNumber among them) is a number, though one of 0 or 1 casts to Bool.
    if jsTypeKind(v) == .objCClass, v is NSNumber { return "number" }
    switch v {
    case is String: return "string"
    case is Bool: return "boolean"
    case is JSNull: return "object"
    case is JSSymbol: return "symbol"
    case is JSBigInt: return "bigint"
    default:
        if jsNumeric(v) != nil { return "number" }
        return jsIsFunction(v) || jsIsClassObject(v) ? "function" : "object"
    }
}

/// A `void` value as script holds it: undefined. Boxing `()` itself would give a value that isn't nil.
@inline(__always) public func jsUndefined(_: Void) -> Any? { nil }

/// A `void` variable, held `Void!`: without this overload it would take the `Any?` one and box `()`.
@inline(__always) public func jsUndefined(_: Void?) -> Any? { nil }

/// What a function TypeScript types `void` returned through a dynamic call: kept, as JavaScript keeps it (a promise core checks for).
@inline(__always) public func jsUndefined(_ value: Any?) -> Any? { value }

/// `value === undefined || value === null`.

public func jsIsNullish(_ value: Any?) -> Bool {
    let v = jsFlat(value)
    return v == nil || v is JSNull
}

/// JavaScript truthiness: false for undefined, null, false, 0, -0, NaN and "".
public func jsIsTruthy(_ value: Any?) -> Bool {
    let value = jsFlat(value)
    if let v = value {
        let t = type(of: v)
        if t == Bool.self { return v as! Bool }
        if t == Double.self { let d = v as! Double; return d != 0 && !d.isNaN }
        if t == String.self { return !(v as! String).isEmpty }
        let kind = jsTypeKind(v)
        if let shape = kind == .swiftClass ? jsClassShape(of: v) : kind == .objCClass ? jsClassShape(v as AnyObject) : nil, shape.opaque {
            return !shape.null
        }
    }
    switch value {
    case nil: return false
    case let b as Bool: return b
    case let d as Double: return d != 0 && !d.isNaN
    case let s as String: return !s.isEmpty
    case is JSNull: return false
    case let b as JSBigInt: return !b.isZero
    case let v?:
        if let n = jsNumeric(v) { return n != 0 && !n.isNaN }
        return true
    }
}

/// `a === b` of two numbers lenient code holds, where NaN stands for undefined: two undefined ones are equal.
@inlinable public func jsLenientNumberEquals(_ a: Double, _ b: Double) -> Bool { a == b || (a.isNaN && b.isNaN) }

/// `a === b`: numbers by value (NaN unequal to itself, -0 equal to +0), strings by code units,
/// objects by identity. Closures cannot be compared in Swift and are never equal.
public func jsStrictEquals(_ a: Any?, _ b: Any?) -> Bool {
    let a = jsFlat(a), b = jsFlat(b)
    if let x = a, let y = b {
        let tx = type(of: x)
        if tx == type(of: y) {
            if tx == String.self { return jsStringEquals(x as! String, y as! String) }
            if tx == Double.self { return (x as! Double) == (y as! Double) }
        }
    }
    if let p = a, let q = b, jsIsOpaqueObject(p) || jsIsOpaqueObject(q) {
        guard let x = jsIdentity(p), let y = jsIdentity(q) else { return false }
        return jsIsObject(x) && jsIsObject(y) && (x as AnyObject) === (y as AnyObject)
    }
    switch (a, b) {
    case (nil, nil): return true
    case (nil, _), (_, nil): return false
    case let (x as Any.Type, y as Any.Type): return x == y
    case let (x as Double, y as Double): return x == y
    case let (x as String, y as String): return jsStringEquals(x, y)
    case let (x as Bool, y as Bool): return x == y
    case let (x as JSBigInt, y as JSBigInt): return x == y
    case let (p?, q?):
        if let m = jsNumeric(p), let n = jsNumeric(q) { return m == n }
        guard let x = jsIdentity(p), let y = jsIdentity(q), jsIsObject(x), jsIsObject(y) else { return false }
        return (x as AnyObject) === (y as AnyObject)
    }
}

/// SameValueZero (`includes`, `Map` and `Set` keys): `===` except NaN equals NaN.
public func jsSameValueZero(_ a: Any?, _ b: Any?) -> Bool {
    if let x = jsFlat(a).flatMap(jsNumeric), let y = jsFlat(b).flatMap(jsNumeric), x.isNaN && y.isNaN { return true }
    return jsStrictEquals(a, b)
}

/// SameValue (`Object.is`): `===` except NaN equals NaN and -0 differs from +0.
public func jsSameValue(_ a: Any?, _ b: Any?) -> Bool {
    if let x = jsFlat(a).flatMap(jsNumeric), let y = jsFlat(b).flatMap(jsNumeric) {
        if x.isNaN && y.isNaN { return true }
        return x == y && x.sign == y.sign
    }
    return jsStrictEquals(a, b)
}

/// `jsSameValue` of two values of one static type: a string, number or boolean compared as itself, not boxed.
@inlinable public func jsSameValue<T>(typed a: T, _ b: T) -> Bool {
    if T.self == String.self { return jsStringEquals(a as! String, b as! String) }
    if T.self == Double.self {
        let x = a as! Double, y = b as! Double
        return x.isNaN ? y.isNaN : x == y && x.sign == y.sign
    }
    if T.self == Bool.self { return a as! Bool == b as! Bool }
    return jsSameValue(a, b)
}

/// `a == b`: null equals undefined; numbers, strings and booleans compare after conversion;
/// an object against a primitive compares through its string form.
public func jsLooseEquals(_ a: Any?, _ b: Any?) -> Bool {
    let a = jsFlat(a), b = jsFlat(b)
    // Strings and numbers told apart by their type's identity, before casts that would try bridging them.
    if let x = a, let y = b {
        let tx = type(of: x), ty = type(of: y)
        if ty == String.self {
            if tx == String.self { return jsStringEquals(x as! String, y as! String) }
            if tx == Double.self { return (x as! Double) == jsNumberFromString(y as! String) }
        } else if ty == Double.self {
            if tx == Double.self { return (x as! Double) == (y as! Double) }
            if tx == String.self { return jsNumberFromString(x as! String) == (y as! Double) }
        }
        // A script object against a string or number: its primitive, compared again.
        if ty == String.self || ty == Double.self, jsClassShape(of: x)?.script == true { return jsLooseEquals(jsToPrimitive(x), y) }
        if tx == String.self || tx == Double.self, jsClassShape(of: y)?.script == true { return jsLooseEquals(x, jsToPrimitive(y)) }
    }
    let aNullish = a == nil || a is JSNull
    let bNullish = b == nil || b is JSNull
    if aNullish || bNullish { return aNullish && bNullish }
    guard let x = a, let y = b else { return false }
    // ToPrimitive leaves a primitive as it is, and a symbol equals no primitive but itself.
    if x is JSSymbol || y is JSSymbol { return jsStrictEquals(jsToPrimitive(x), jsToPrimitive(y)) }
    if jsIsOpaqueObject(x) && jsIsOpaqueObject(y) { return jsStrictEquals(x, y) }
    if let big = x as? JSBigInt { return jsBigIntLooseEquals(big, y) }
    if let big = y as? JSBigInt { return jsBigIntLooseEquals(big, x) }
    if let m = jsNumeric(x), let n = jsNumeric(y) { return m == n }
    if let s = x as? String, let t = y as? String { return jsStringEquals(s, t) }
    if let p = x as? Bool, let q = y as? Bool { return p == q }
    if x is Bool { return jsLooseEquals(jsToNumber(x), y) }
    if y is Bool { return jsLooseEquals(x, jsToNumber(y)) }
    if let n = jsNumeric(x), let t = y as? String { return n == jsNumberFromString(t) }
    if let s = x as? String, let n = jsNumeric(y) { return jsNumberFromString(s) == n }
    let xPrimitive = x is String || jsNumeric(x) != nil
    let yPrimitive = y is String || jsNumeric(y) != nil
    if jsIsObject(x) && yPrimitive { return jsLooseEquals(jsToPrimitive(x), y) }
    if xPrimitive && jsIsObject(y) { return jsLooseEquals(x, jsToPrimitive(y)) }
    return jsStrictEquals(x, y)
}

/// OrdinaryToPrimitive over an object literal's own `valueOf` and `toString`, in the order the hint asks; nil stands for
/// Object.prototype's (a `valueOf` giving the object itself, a `toString` giving "[object Object]").
public func jsOrdinaryToPrimitive(_ hint: String, valueOf: (() throws -> Any?)?, toString: (() throws -> Any?)?) throws -> Any? {
    let inherited: () throws -> Any? = { "[object Object]" }
    for method in hint == "string" ? [toString ?? inherited, valueOf] : [valueOf, toString ?? inherited] {
        guard let method else { continue }
        let result = jsFlat(try method())
        if result == nil || !jsIsObject(result!) || result is JSNull || result is JSSymbol || result is JSBigInt { return result }
    }
    throw JSException(JSTypeError("Cannot convert object to primitive value"))
}

/// ToPrimitive with the default hint: objects become their string form.
func jsToPrimitive(_ value: Any?) -> Any? {
    guard let v = jsFlat(value) else { return nil }
    if jsClassShape(of: v)?.script == true {
        if let user = jsUserPrimitive(v, "default") { return user }
        return jsToString(v)
    }
    switch v {
    case is String, is Bool, is JSNull, is JSSymbol, is JSBigInt: return v
    default:
        if let n = jsNumeric(v) { return n }
        if let user = jsUserPrimitive(v, "default") { return user }
        return jsToString(v)
    }
}

/// `a < b` of values typed only at run time: two strings compare by code units, anything else as
/// numbers. Nil when either is NaN, where every comparison is false: `a <= b` is `jsGreaterThan(a, b) == false`.
public func jsLessThan(_ a: Any?, _ b: Any?) -> Bool? {
    func primitive(_ value: Any?) -> Any? {
        guard let v = jsFlat(value) else { return nil }
        switch v {
        case is String, is Bool, is JSNull, is JSSymbol, is JSBigInt: return v
        case let date as JSDate: return date.time
        default:
            if let n = jsNumeric(v) { return n }
            if let user = jsUserPrimitive(v, "number") { return user }
            return jsToString(v)
        }
    }
    let x = primitive(a), y = primitive(b)
    if let x = x as? String, let y = y as? String { return jsCompare(x, y) < 0 }
    let m = jsToNumber(x), n = jsToNumber(y)
    return m.isNaN || n.isNaN ? nil : m < n
}

/// `a > b` of values typed only at run time, as `jsLessThan`.
public func jsGreaterThan(_ a: Any?, _ b: Any?) -> Bool? { jsLessThan(b, a) }

/// A value code checked without strictNullChecks declares a boolean, as its uses read it: by truthiness.
public func jsLenientBool(_ value: Any?) -> Bool {
    if let b = value as? Bool { return b }
    return jsTruthy(value)
}

/// A value code checked without strictNullChecks declares a number, converted as JavaScript converts it where
/// it is used: undefined is NaN (an unset style's `font-size: ${fontSize}px` is no size), null is 0.
public func jsLenientNumber(_ value: Any?) -> Double {
    if let d = value as? Double { return d }
    return jsToNumber(value)
}

/// A value code checked without strictNullChecks declares a string: undefined and null are "", anything else converts.
public func jsLenientString(_ value: Any?) -> String {
    if let s = value as? String { return s }
    return jsIsNullish(value) ? "" : jsToString(value)
}

/// `jsLenientBool`, `jsLenientNumber` and `jsLenientString` where the declared type is optional: undefined and null stay nil.
public func jsLenientBoolOrNil(_ value: Any?) -> Bool? { jsIsNullish(value) ? nil : jsLenientBool(value) }
public func jsLenientNumberOrNil(_ value: Any?) -> Double? { jsIsNullish(value) ? nil : jsLenientNumber(value) }
public func jsLenientStringOrNil(_ value: Any?) -> String? { jsIsNullish(value) ? nil : jsLenientString(value) }

/// An untyped value asserted to a string, number or boolean: a value `jsTypeof` calls that type passes, in
/// whatever representation it has (an NSString, an `Int8`, a CFBoolean), an empty state reads as
/// `jsLenientString`/`jsLenientNumber`/`jsLenientBool` read it, and any other value is JavaScript's TypeError there
/// rather than a converted one. Only a Swift struct takes the plain cast: an NSNumber casts to `Bool` and `Double` alike.
public func jsCheckedString(_ value: Any?) throws -> String {
    let v = jsFlat(value)
    if let v, jsTypeKind(v) == .struct, let s = v as? String { return s }
    if jsIsNullish(v) { return "" }
    if jsTypeof(v) == "string" { return jsToString(v) }
    throw jsCastFailure(v, "string")
}
public func jsCheckedNumber(_ value: Any?) throws -> Double {
    let v = jsFlat(value)
    if let v, jsTypeKind(v) == .struct, let d = v as? Double { return d }
    if jsIsNullish(v) || jsTypeof(v) == "number" { return jsToNumber(v) }
    throw jsCastFailure(v, "number")
}
public func jsCheckedBool(_ value: Any?) throws -> Bool {
    let v = jsFlat(value)
    if let v, jsTypeKind(v) == .struct, let b = v as? Bool { return b }
    if jsIsNullish(v) { return false }
    if jsTypeof(v) == "boolean" { return jsIsTruthy(v) }
    throw jsCastFailure(v, "boolean")
}
public func jsCheckedStringOrNil(_ value: Any?) throws -> String? { jsIsNullish(value) ? nil : try jsCheckedString(value) }
public func jsCheckedNumberOrNil(_ value: Any?) throws -> Double? { jsIsNullish(value) ? nil : try jsCheckedNumber(value) }
public func jsCheckedBoolOrNil(_ value: Any?) throws -> Bool? { jsIsNullish(value) ? nil : try jsCheckedBool(value) }
/// As `jsCheckedNumberOrNil` and `jsLenientNumberOrNil` for a built-in's optional number parameter: nil only where the
/// value is undefined, since null converts (to 0).
public func jsCheckedNumberOrUndefined(_ value: Any?) throws -> Double? { jsFlat(value) == nil ? nil : try jsCheckedNumber(value) }
public func jsLenientNumberOrUndefined(_ value: Any?) -> Double? { jsFlat(value) == nil ? nil : jsLenientNumber(value) }

/// Core's own code (the kit) given an untyped value where it declares a string, number or boolean: a value of the type
/// passes, another primitive converts as `String()`, `Number()` and `Boolean()` do (`Number()` of a symbol is its
/// TypeError), undefined, null and an empty marker (`jsEmptyMarker`) read as `jsLenientString`, `jsLenientNumber` and
/// `jsLenientBool` read them, and any other value is JavaScript's TypeError there.
public func jsConvertedString(_ value: Any?) throws -> String {
    if let s = value as? String { return s }
    let v = try jsCorePrimitive(value, "string")
    return jsIsNullish(v) ? "" : jsToString(v)
}
public func jsConvertedNumber(_ value: Any?) throws -> Double {
    if let d = value as? Double { return d }
    let v = try jsCorePrimitive(value, "number")
    if v is JSSymbol { throw JSException(JSTypeError("Cannot convert a Symbol value to a number")) }
    return jsToNumber(v)
}
public func jsConvertedBool(_ value: Any?) throws -> Bool {
    if let b = value as? Bool { return b }
    return jsIsTruthy(try jsCorePrimitive(value, "boolean"))
}
public func jsConvertedStringOrNil(_ value: Any?) throws -> String? { jsIsNullish(value) || jsIsEmptyMarker(value) ? nil : try jsConvertedString(value) }
public func jsConvertedNumberOrNil(_ value: Any?) throws -> Double? { jsIsNullish(value) || jsIsEmptyMarker(value) ? nil : try jsConvertedNumber(value) }
public func jsConvertedBoolOrNil(_ value: Any?) throws -> Bool? { jsIsNullish(value) || jsIsEmptyMarker(value) ? nil : try jsConvertedBool(value) }

/// The value `jsConverted*` converts: an empty marker as undefined, a primitive as it is, anything else a TypeError.
@inline(never)
private func jsCorePrimitive(_ value: Any?, _ type: String) throws -> Any? {
    guard let v = jsFlat(value), !(v is JSNull) else { return jsFlat(value) }
    if jsIsEmptyMarker(v) { return nil }
    switch jsTypeof(v) {
    case "string", "number", "boolean", "bigint", "symbol": return v
    case "undefined": return nil
    default: throw jsNotA(v, type)
    }
}

enum JSEmptyMarkers {
    static var all: [AnyObject] = []
}

/// A value core makes only to be told apart by identity (`unsetValue`), which its checked converts read as an empty value.
public func jsEmptyMarker<T>(_ value: T) -> T {
    if let v = jsFlat(value), Swift.type(of: v) is AnyClass { JSEmptyMarkers.all.append(v as AnyObject) }
    return value
}

func jsIsEmptyMarker(_ value: Any?) -> Bool {
    guard !JSEmptyMarkers.all.isEmpty, let v = jsFlat(value), Swift.type(of: v) is AnyClass else { return false }
    let object = v as AnyObject
    return JSEmptyMarkers.all.contains { $0 === object }
}

/// An untyped value asserted to an array of strings, numbers or booleans: an array's elements each checked by
/// `element`, an empty state read as `jsArrayFrom` reads it, and any other value JavaScript's TypeError there.
public func jsCheckedArray<T>(_ value: Any?, _ element: (Any?) throws -> T) throws -> JSArray<T> {
    let v = jsFlat(value)
    if jsIsNullish(v) || v is JSArrayProtocol { return try jsArrayFrom(v, element) }
    throw JSException(JSTypeError("\(jsTypeof(v)) is not an array"))
}

/// A value's string where one must be given: undefined and null are "".
public func jsStringOrEmpty(_ value: Any?) -> String { jsIsNullish(value) ? "" : jsToString(value) }

/// An untyped value converted by `convert`, where the type it is read as is optional: undefined and null stay nil.
public func jsUnlessNullish<T>(_ value: Any?, _ convert: (Any?) throws -> T) rethrows -> T? {
    jsIsNullish(value) ? nil : try convert(value)
}

/// A `+` operand beside a string: ToString(ToPrimitive(value, default)).
public func jsToStringDefault(_ value: Any?) -> String { jsToString(jsToPrimitive(value)) }

/// `Number(value)` / unary `+`.
public func jsToNumber(_ value: Any?) -> Double {
    switch jsFlat(value) {
    case nil: return .nan
    case let d as Double: return d
    case let s as String: return jsNumberFromString(s)
    case let b as Bool: return b ? 1 : 0
    case is JSNull: return 0
    case let big as JSBigInt: return big.toDouble()
    case let v?:
        if let n = jsNumeric(v) { return n }
        if jsIsFunction(v) || v is JSSymbol { return .nan }
        if let user = jsUserPrimitive(v, "number") { return jsToNumber(user) }
        return jsNumberFromString(jsToString(v))
    }
}

enum JSJoinGuard {
    static var active: [ObjectIdentifier] {
        get { JSRealm.current().joining }
        set { JSRealm.current().joining = newValue }
    }
}

/// `String(value)`: arrays join with ",", plain objects are "[object Object]", errors "Name: message".
public func jsToString(_ value: Any?) -> String {
    let value = jsFlat(value)
    if let object = value, jsIsOpaqueObject(object) { return jsObjectToString(object) }
    switch value {
    case nil: return "undefined"
    case let s as String: return s
    // A CFBoolean also casts to Double.
    case let d as Double: return jsNativeBoolean(value!).map { $0 ? "true" : "false" } ?? jsNumberToString(d)
    case let b as Bool: return b ? "true" : "false"
    case let v?: return jsObjectToString(v)
    }
}

/// `String(value)` of what is not undefined, a string, a number or a boolean.
private func jsObjectToString(_ value: Any) -> String {
    if jsIsClassObject(value), let cls = value as? Any.Type { return jsClassString(cls) }
    switch value {
    case is JSNull: return "null"
    case let v as JSToPrimitive: return jsToString(jsUserPrimitive(v, "string") ?? nil)
    case let v as JSStringConvertible:
        // What the conversion throws is reported, as for a `[Symbol.toPrimitive]` method.
        do { return try v.toString() } catch { jsReportUncaught(jsCaught(error)); return "undefined" }
    case let symbol as JSSymbol: return symbol.toString()
    case let big as JSBigInt: return big.toString()
    case let tagged as JSToStringTag: return "[object \(tagged.jsToStringTag)]"
    case let error as JSError: return error.jsErrorString
    case let array as JSArrayProtocol: return array.jsJoin(",")
    case is JSMapProtocol: return "[object Map]"
    case is JSSetProtocol: return "[object Set]"
    case is JSThenable: return "[object Promise]"
    case let v:
        if let n = jsNumeric(v) { return jsNumberToString(n) }
        // An entry pair (`[key, value]`) Swift holds as a tuple is the array script made it as.
        if jsIsTuple(v) {
            return Mirror(reflecting: v).children.map { (child) -> String in
                let element = jsFlat(child.value)
                return element == nil || element is JSNull ? "" : jsToString(element)
            }.joined(separator: ",")
        }
        if jsIsFunction(v) { return "function () { [native code] }" }
        if jsIsObject(v) { return jsStringTag(v).map { "[object \($0)]" } ?? "[object Object]" }
        return String(describing: v)
    }
}

/// `a + b`: string concatenation when either side is (or converts to) a string, else numeric addition.
public func jsAdd(_ a: Any?, _ b: Any?) -> Any? {
    let x = jsToPrimitive(a), y = jsToPrimitive(b)
    if x is String || y is String { return jsToString(x) + jsToString(y) }
    return jsToNumber(x) + jsToNumber(y)
}

// MARK: - Conversions of operands held untyped
// What an operator converts where the compiler holds an operand untyped. Unlike the conversions above, which report what
// a value's own conversion throws, these throw it, and they throw JavaScript's TypeErrors (a BigInt beside a number, a
// Symbol as a number or string); a site that calls one is `try`.

/// ToPrimitive (`jsToPrimitive`) where what the value's own conversion throws is thrown.
func jsToPrimitiveThrowing(_ value: Any?, _ hint: String) throws -> Any? {
    guard let v = jsFlat(value) else { return nil }
    switch v {
    case is String, is Bool, is JSNull, is JSSymbol, is JSBigInt: return v
    default:
        if let n = jsNumeric(v) { return n }
        if let user = try jsUserPrimitiveThrowing(v, hint) { return user }
        return try jsToStringThrowing(v)
    }
}

/// ToNumeric: a BigInt as it is, anything else its number (`jsToNumber`).
private func jsNumericOf(_ value: Any?) throws -> Any {
    let v = jsFlat(value)
    switch v {
    case let big as JSBigInt: return big
    case is JSSymbol: throw JSException(JSTypeError("Cannot convert a Symbol value to a number"))
    case nil, is String, is Double, is Bool, is JSNull: return jsToNumber(v)
    case let object?:
        if jsNumeric(object) != nil || jsIsFunction(object) { return jsToNumber(object) }
        if let user = try jsUserPrimitiveThrowing(object, "number") { return try jsNumericOf(user) }
        if !(object is JSDate), let convertible = object as? JSStringConvertible { return try jsNumericOf(convertible.toString()) }
        return jsToNumber(object)
    }
}

private func jsMixedBigInt() -> JSException { JSException(JSTypeError("Cannot mix BigInt and other types, use explicit conversions")) }

/// `a + b`: as `jsAdd`; two BigInts add as BigInts, and a BigInt beside a number is a TypeError.
public func jsAddThrowing(_ a: Any?, _ b: Any?) throws -> Any? {
    let x = try jsToPrimitiveThrowing(a, "default"), y = try jsToPrimitiveThrowing(b, "default")
    if x is String || y is String { return try jsToStringThrowing(x) + jsToStringThrowing(y) }
    let m = try jsNumericOf(x), n = try jsNumericOf(y)
    switch (m, n) {
    case let (p as JSBigInt, q as JSBigInt): return p + q
    case (is JSBigInt, _), (_, is JSBigInt): throw jsMixedBigInt()
    default: return jsToNumber(m) + jsToNumber(n)
    }
}

/// `op` on two operands' numbers: two BigInts give `op` of their numbers, and a BigInt beside a number is a TypeError.
private func jsNumericThrowing(_ a: Any?, _ b: Any?, _ op: (Double, Double) -> Double) throws -> Double {
    let m = try jsNumericOf(a), n = try jsNumericOf(b)
    switch (m, n) {
    case let (p as JSBigInt, q as JSBigInt): return op(p.toDouble(), q.toDouble())
    case (is JSBigInt, _), (_, is JSBigInt): throw jsMixedBigInt()
    default: return op(jsToNumber(m), jsToNumber(n))
    }
}

/// The numeric and bitwise operators where an operand is held untyped.
public func jsSubtractThrowing(_ a: Any?, _ b: Any?) throws -> Double { try jsNumericThrowing(a, b, -) }
public func jsMultiplyThrowing(_ a: Any?, _ b: Any?) throws -> Double { try jsNumericThrowing(a, b, *) }
public func jsDivideThrowing(_ a: Any?, _ b: Any?) throws -> Double { try jsNumericThrowing(a, b, /) }
public func jsRemainderThrowing(_ a: Any?, _ b: Any?) throws -> Double { try jsNumericThrowing(a, b, jsMod) }
public func jsExponentThrowing(_ a: Any?, _ b: Any?) throws -> Double { try jsNumericThrowing(a, b, jsPow) }
public func jsBitAndThrowing(_ a: Any?, _ b: Any?) throws -> Double { try jsNumericThrowing(a, b, jsBitAnd) }
public func jsBitOrThrowing(_ a: Any?, _ b: Any?) throws -> Double { try jsNumericThrowing(a, b, jsBitOr) }
public func jsBitXorThrowing(_ a: Any?, _ b: Any?) throws -> Double { try jsNumericThrowing(a, b, jsBitXor) }
public func jsShiftLeftThrowing(_ a: Any?, _ b: Any?) throws -> Double { try jsNumericThrowing(a, b, jsShiftLeft) }
public func jsShiftRightThrowing(_ a: Any?, _ b: Any?) throws -> Double { try jsNumericThrowing(a, b, jsShiftRight) }
public func jsShiftRightUnsignedThrowing(_ a: Any?, _ b: Any?) throws -> Double { try jsNumericThrowing(a, b, jsShiftRightUnsigned) }

/// `op` where its value is held untyped: two BigInts give `big` of them, and a BigInt beside a number is a TypeError.
private func jsNumericUntypedThrowing(_ a: Any?, _ b: Any?, _ op: (Double, Double) -> Double, _ big: (JSBigInt, JSBigInt) throws -> JSBigInt) throws -> Any? {
    let m = try jsNumericOf(a), n = try jsNumericOf(b)
    switch (m, n) {
    case let (p as JSBigInt, q as JSBigInt): return try big(p, q)
    case (is JSBigInt, _), (_, is JSBigInt): throw jsMixedBigInt()
    default: return op(jsToNumber(m), jsToNumber(n))
    }
}

/// The numeric and bitwise operators where both operands are held untyped or BigInts and the value is held untyped.
public func jsSubtractUntypedThrowing(_ a: Any?, _ b: Any?) throws -> Any? { try jsNumericUntypedThrowing(a, b, -, { $0 - $1 }) }
public func jsMultiplyUntypedThrowing(_ a: Any?, _ b: Any?) throws -> Any? { try jsNumericUntypedThrowing(a, b, *, { $0 * $1 }) }
public func jsDivideUntypedThrowing(_ a: Any?, _ b: Any?) throws -> Any? { try jsNumericUntypedThrowing(a, b, /, JSBigInt.divide) }
public func jsRemainderUntypedThrowing(_ a: Any?, _ b: Any?) throws -> Any? { try jsNumericUntypedThrowing(a, b, jsMod, JSBigInt.remainder) }
public func jsExponentUntypedThrowing(_ a: Any?, _ b: Any?) throws -> Any? { try jsNumericUntypedThrowing(a, b, jsPow, JSBigInt.power) }
public func jsBitAndUntypedThrowing(_ a: Any?, _ b: Any?) throws -> Any? { try jsNumericUntypedThrowing(a, b, jsBitAnd, { $0 & $1 }) }
public func jsBitOrUntypedThrowing(_ a: Any?, _ b: Any?) throws -> Any? { try jsNumericUntypedThrowing(a, b, jsBitOr, { $0 | $1 }) }
public func jsBitXorUntypedThrowing(_ a: Any?, _ b: Any?) throws -> Any? { try jsNumericUntypedThrowing(a, b, jsBitXor, { $0 ^ $1 }) }
public func jsShiftLeftUntypedThrowing(_ a: Any?, _ b: Any?) throws -> Any? { try jsNumericUntypedThrowing(a, b, jsShiftLeft, JSBigInt.shiftLeft) }
public func jsShiftRightUntypedThrowing(_ a: Any?, _ b: Any?) throws -> Any? { try jsNumericUntypedThrowing(a, b, jsShiftRight, JSBigInt.shiftRight) }
public func jsShiftRightUnsignedUntypedThrowing(_ a: Any?, _ b: Any?) throws -> Any? {
    try jsNumericUntypedThrowing(a, b, jsShiftRightUnsigned, { _, _ in throw JSException(JSTypeError("BigInts have no unsigned right shift, use >> instead")) })
}

/// Unary `+`: ToNumber, a TypeError for a BigInt.
public func jsToNumberThrowing(_ value: Any?) throws -> Double {
    let n = try jsNumericOf(value)
    if n is JSBigInt { throw JSException(JSTypeError("Cannot convert a BigInt value to a number")) }
    return jsToNumber(n)
}

/// `n += value` for a number `n`: ToNumeric of value, a BigInt beside the number a TypeError.
public func jsNumberAddendThrowing(_ value: Any?) throws -> Double {
    let n = try jsNumericOf(value)
    if n is JSBigInt { throw jsMixedBigInt() }
    return jsToNumber(n)
}

/// A number method's argument held untyped: undefined stays absent, anything else converts by `jsToNumberThrowing`.
public func jsToNumberOrUndefinedThrowing(_ value: Any?) throws -> Double? { jsFlat(value) == nil ? nil : try jsToNumberThrowing(value) }

/// Unary `-` and `~`: ToNumeric, a BigInt as its number.
public func jsToNumericThrowing(_ value: Any?) throws -> Double {
    let n = try jsNumericOf(value)
    return (n as? JSBigInt)?.toDouble() ?? jsToNumber(n)
}

/// A `+` operand beside a string: ToString(ToPrimitive(value, default)).
public func jsToStringDefaultThrowing(_ value: Any?) throws -> String {
    try jsToStringThrowing(jsToPrimitiveThrowing(value, "default"))
}

/// A template literal's substitution: ToString, a TypeError for a Symbol.
public func jsToStringThrowing(_ value: Any?) throws -> String {
    switch jsFlat(value) {
    case is JSSymbol: throw JSException(JSTypeError("Cannot convert a Symbol value to a string"))
    case let v as JSToPrimitive: return try jsToStringThrowing(jsUserPrimitiveThrowing(v, "string") ?? nil)
    case let v as JSStringConvertible: return try v.toString()
    default: return jsToString(value)
    }
}

/// `String(value)`: a Symbol its description, anything else ToString (`jsToStringThrowing`).
public func jsStringThrowing(_ value: Any?) throws -> String {
    if let symbol = jsFlat(value) as? JSSymbol { return symbol.toString() }
    return try jsToStringThrowing(value)
}

/// IsLessThan(a, b): ToPrimitive (number) of `a` then `b` where `leftFirst`, else `b` then `a`; two strings by code units,
/// anything else as numbers (a Symbol a TypeError). Nil where either is NaN, as `jsLessThan`.
private func jsLessThanThrowing(_ a: Any?, _ b: Any?, leftFirst: Bool) throws -> Bool? {
    func primitive(_ value: Any?) throws -> Any? {
        if let date = jsFlat(value) as? JSDate { return date.time }
        return try jsToPrimitiveThrowing(value, "number")
    }
    let x: Any?, y: Any?
    if leftFirst { x = try primitive(a); y = try primitive(b) } else { y = try primitive(b); x = try primitive(a) }
    if let x = x as? String, let y = y as? String { return jsCompare(x, y) < 0 }
    if x is JSSymbol || y is JSSymbol { throw JSException(JSTypeError("Cannot convert a Symbol value to a number")) }
    let m = jsToNumber(x), n = jsToNumber(y)
    return m.isNaN || n.isNaN ? nil : m < n
}

/// The relational operators where an operand's conversion may throw.
public func jsLessThrowing(_ a: Any?, _ b: Any?) throws -> Bool { try jsLessThanThrowing(a, b, leftFirst: true) == true }
public func jsGreaterThrowing(_ a: Any?, _ b: Any?) throws -> Bool { try jsLessThanThrowing(b, a, leftFirst: false) == true }
public func jsLessOrEqualThrowing(_ a: Any?, _ b: Any?) throws -> Bool { try jsLessThanThrowing(b, a, leftFirst: false) == false }
public func jsGreaterOrEqualThrowing(_ a: Any?, _ b: Any?) throws -> Bool { try jsLessThanThrowing(a, b, leftFirst: true) == false }

extension JSArrayProtocol {
    func jsJoin(_ separator: String) -> String {
        let id = ObjectIdentifier(self)
        if JSJoinGuard.active.contains(id) { return "" }
        JSJoinGuard.active.append(id)
        defer { JSJoinGuard.active.removeLast() }
        var out = ""
        for (i, element) in jsAnyElements.enumerated() {
            if i > 0 { out += separator }
            if element == nil || element is JSNull { continue }
            out += jsToString(element)
        }
        return out
    }
}

/// `f?.(args)` on an untyped value: undefined when `f` is undefined or null.
@discardableResult
public func jsCallOptional(_ function: Any?, _ arguments: Any?...) throws -> Any? {
    try jsCallOptional(function, spread: arguments)
}

@discardableResult
public func jsCallOptional(_ function: Any?, spread arguments: [Any?]) throws -> Any? {
    if jsIsNullish(function) { return nil }
    return try jsCall(function, spread: arguments)
}

public let jsStringConstructor = jsBuiltinFunction("String", 1, { a in a.isEmpty ? "" : jsToString(a[0]) }, [])
public let jsNumberConstructor = jsBuiltinFunction("Number", 1, { a in a.isEmpty ? 0.0 : jsToNumber(a[0]) }, [])
public let jsBooleanConstructor = jsBuiltinFunction("Boolean", 1, { a in jsTruthy(jsArg(a, 0)) }, [])

public let jsDateBuiltin = JSObject([
    ("now", jsFunction("now", 0) { _ in JSDate.now() }),
])

/// `Array` held as a value: callable without `new` (`Array(3)`), as script's is.
public let jsArrayBuiltin = jsBuiltinFunction("Array", 1, { a in try jsArrayConstruct(a) }, [
    ("isArray", jsFunction("isArray", 1) { a in JSArray<Any?>.isArray(jsArg(a, 0)) }),
])

private func jsBuiltinFunction(_ name: String, _ length: Int, _ body: @escaping ([Any?]) throws -> Any?, _ members: [(String, Any?)]) -> JSFunctionObject {
    let function = JSFunctionObject(name, length) { _, a in try body(a) }
    for (key, value) in members { function[jsKey: key] = value }
    return function
}

/// `globalThis` read as an object: per-realm (a worker's own global on a worker thread, the app's on main).
public var jsGlobalThis: JSObject { JSRealm.current().global }

/// `Object` held as a value (`(<any>Object).entries(o)`): its functions over objects, called as script calls them.
public let jsObjectBuiltin = jsBuiltinFunction("Object", 1, { a in jsIsNullish(jsArg(a, 0)) ? JSObject() : jsArg(a, 0) }, [
    ("keys", jsFunction("keys", 1) { a in jsObjectKeys(jsArg(a, 0)) }),
    ("values", jsFunction("values", 1) { a in jsObjectValues(jsArg(a, 0)) }),
    ("entries", jsFunction("entries", 1) { a in JSArray<Any?>(jsObjectEntries(jsArg(a, 0)).storage.map { JSArray<Any?>([$0.0, $0.1]) as Any? }) }),
    ("assign", jsFunction("assign", 2) { a in try jsObjectAssign(jsArg(a, 0), spread: Array(a.dropFirst())) }),
    ("getPrototypeOf", jsFunction("getPrototypeOf", 1) { a in try jsGetPrototypeOf(jsArg(a, 0)) }),
    ("prototype", JSPrototypes.objectPrototype),
])

/// Lenient code: a value that may be undefined where its type says an object. It stays optional; a member read
/// of it goes through `jsUnwrap`, JavaScript's TypeError where it is missing.
@inline(__always)
public func jsImplicit<T>(_ value: T?) -> T? { value }

/// `value instanceof Name` for a class the kit knows only by that name (`FormData`, which the runtime's globals
/// take from core): an object of a kit class of the name, or of a subclass of one. A class whose name another
/// of core's took is named `Name__file`.
public func jsInstanceOfNamed(_ value: Any?, _ name: String) -> Bool {
    guard let object = jsIdentity(jsFlat(value)), Mirror(reflecting: object).displayStyle == .class else { return false }
    var cls: AnyClass? = type(of: object as AnyObject)
    while let c = cls {
        if String(describing: c).components(separatedBy: "__")[0] == name { return true }
        cls = class_getSuperclass(c)
    }
    return false
}

/// `value.constructor.name`: the name of the class that made the value.
public func jsConstructorName(_ value: Any?) -> String {
    let v = jsFlat(value)
    // An error's class, not its `name` (which a subclass leaves as its base's unless it sets it).
    if let error = v as? JSError { return jsClassValueName(type(of: error)) }
    if let dynamic = v as? JSDynamic, let name = dynamic.jsClassName { return name }
    switch v {
    case is String: return "String"
    case is Double: return "Number"
    case is Bool: return "Boolean"
    case nil: return ""
    default:
        let name = String(describing: type(of: v!))
        return name.split(separator: "__").first.map(String.init) ?? name
    }
}


/// An object of another type where code checked as core is passes it for a class
/// (`rule.declarations` as `KeyframeDeclaration[]`): the value itself where it is
/// one, else a new instance holding the value's own members, as script reads them
/// from the value itself (a member undefined on a new instance is still the value's).
public func jsShaped<T: AnyObject>(_ value: Any?, _ make: () throws -> T) -> T? {
    guard let v = jsFlat(value), !(v is JSNull) else { return nil }
    if let same = v as? T { return same }
    guard let made = try? make(), let keyed = made as? JSDynamic else { return nil }
    for key in jsKeysOf(v) { keyed[jsKey: key] = (try? jsGet(v, key)) ?? nil }
    return made
}
