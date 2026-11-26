import Foundation

/// Any `JSArray`, whatever its element type, for code that inspects values dynamically.
public protocol JSArrayProtocol: AnyObject {
    var jsLength: Int { get }
    /// The elements boxed as JavaScript values (nested optionals collapsed).
    var jsAnyElements: [Any?] { get }
    func jsElement(at index: Int) -> Any?
    /// Whether `index` is a slot holding a value, not past the end or empty (`new Array(n)`).
    func jsHasElement(at index: Int) -> Bool
    /// `array[index] = value`; throws a TypeError when `value` is not an `Element`.
    func jsSetElement(_ value: Any?, at index: Int) throws
    /// `delete array[index]`: turns the slot into a hole without changing `length`.
    func jsDeleteElement(at index: Int)
    func jsSetLength(_ length: Int) throws
    /// Replaces every element; throws a TypeError, changing nothing, when one is not an `Element`.
    func jsSetElements(_ values: [Any?]) throws
    /// The array as `JSArray<Any?>`: itself, or the view `jsUntypedArray` makes of a typed one.
    var jsUntyped: JSArray<Any?> { get }
    /// The array as `JSArray<U>` (`jsArrayView`): itself, or the one view of it as that type.
    func jsView<U>(as type: U.Type) -> JSArray<U>
    /// The typed array a view stands for, nil where the array is not a view.
    var jsViewSource: JSArrayProtocol? { get }
}

/// An empty slot of a `JSArray<Double>`: a signaling NaN, which arithmetic never produces (it gives a quiet NaN).
@inlinable public var jsHoleNumber: Double { Double(bitPattern: 0x7FF4_0000_0000_4E53) }
/// An empty slot of a `JSArray<String>`: noncharacters no text carries.
public let jsHoleString = String(String.UnicodeScalarView([Unicode.Scalar(0xFDD0)!, "\u{0}", Unicode.Scalar(0xFDD1)!]))

/// Whether `s` is `jsHoleString`; its UTF-8 length first, which a native string knows without comparing text.
@inlinable public func jsIsHoleString(_ s: String) -> Bool { s.utf8.count == 7 && s == jsHoleString }

/// A function type's rest parameter (`(...args) => void`): an array to Swift, marked so that a script
/// function called as that type takes the array's elements as its arguments.
public typealias JSRest<Element> = JSArray<Element>

/// A JavaScript array: reference semantics, JavaScript method names, `Double` indexes and lengths.
///
/// Limits: a subscript read past the end traps (JavaScript gives `undefined`, which a non-optional
/// `Element` cannot hold; `at(_:)` returns nil instead), and growing the array past its end with
/// `length` or an index needs an optional `Element`, a number or a string to hold the empty slots.
open class JSArray<Element>: JSArrayProtocol, JSStandIn, JSReactiveConvertible, Sequence, ExpressibleByArrayLiteral, CustomStringConvertible {
    nonisolated deinit {}
    @usableFromInline final var held: [Element]
    /// The array a view made by `jsUntypedArray` or `jsArrayView` is: its elements are that array's, read and written
    /// through it, and it holds none of its own.
    @usableFromInline final var standingFor: JSArrayProtocol?
    /// Indices that are holes in non-Double/non-String arrays (`new Array(n)`, `delete a[i]`, extended `length`); nil for dense arrays.
    @usableFromInline final var jsHoles: Set<Int>?
    public final var jsTracker: JSTracker?

    public init() { held = [] }
    public init(_ elements: [Element]) { held = elements }
    public required init(arrayLiteral elements: Element...) { held = elements }

    /// Whether an array of this element type can be a view: an untyped one (`Any?`), or one of class references (an
    /// array of arrays, of a base class). The size tests are constants where the element type is known, so arrays of
    /// numbers, strings, booleans and structs never read `standingFor` (a test of the metatype itself is a runtime call
    /// for `Any?`).
    @inlinable @inline(__always) static var viewable: Bool {
        MemoryLayout<Element>.size == MemoryLayout<Any?>.size || (MemoryLayout<Element>.size == MemoryLayout<AnyObject>.size && MemoryLayout<Element?>.size == MemoryLayout<Element>.size)
    }

    /// The array this one is a view of, if it is one. A view holds no elements, so an array holding any is none without
    /// reading `standingFor`: the test folds into the length the element reads load anyway.
    @inlinable @inline(__always) final var shared: JSArrayProtocol? { JSArray.viewable && held.isEmpty ? standingFor : nil }

    /// A view's element as its own type: the untyped value itself, or for a view of another element type, its
    /// typed array's element seen as this one (`jsViewElement`).
    @inlinable @inline(__always) static func viewed(_ value: Any?) -> Element {
        if MemoryLayout<Element>.size == MemoryLayout<Any?>.size { return unsafeBitCast(value, to: Element.self) }
        return jsViewElement(value)
    }

    /// A view's elements, its typed array's seen as this array's element type.
    @inlinable @inline(never) static func viewedElements(_ source: JSArrayProtocol) -> [Element] {
        source.jsAnyElements.map(JSArray.viewed)
    }

    /// An element as the untyped value a view's typed array is given.
    @inlinable @inline(__always) static func boxed(_ element: Element) -> Any? {
        if MemoryLayout<Element>.size == MemoryLayout<Any?>.size { return unsafeBitCast(element, to: Any?.self) }
        return element as Any?
    }

    /// The elements. A view's are its typed array's: read whole, and written back whole after a change through them.
    @inlinable public final var storage: [Element] {
        @inline(__always) get {
            if let source = shared { return JSArray.viewedElements(source) }
            return held
        }
        @inline(__always) _modify {
            if let source = shared {
                var elements = JSArray.viewedElements(source)
                defer { jsStore(elements.map(JSArray.boxed), into: source) }
                yield &elements
            } else {
                yield &held
            }
        }
    }

    /// `storage.count`, which a view reads from its typed array without reading the elements.
    @inlinable @inline(__always) final var heldCount: Int {
        let n = held.count
        if JSArray.viewable && n == 0 { return viewCount() }
        return n
    }

    /// `heldCount` of an array holding no elements: a view's length is its typed array's.
    @inlinable @inline(never) final func viewCount() -> Int { standingFor?.jsLength ?? 0 }

    @inlinable @inline(__always) final func track() { jsTracker?.track() }
    @inlinable @inline(__always) final func trigger() { jsTracker?.trigger() }

    @inlinable @inline(__always) final func read(_ index: Int) -> Element {
        if let source = shared { return JSArray.viewed(source.jsElement(at: index)) }
        if jsTracker != nil { return jsReactive(held[index]) }
        return held[index]
    }

    public final var jsStandingFor: AnyObject? { shared }

    /// What an empty slot holds: undefined in an array of optionals; in an array of numbers or strings,
    /// a sentinel that reads undefined where the read may be (`element(_:)`, join, untyped reads).
    @usableFromInline static var hole: Element? {
        if Element.self == Double.self { return unsafeBitCast(jsHoleNumber, to: Element.self) }
        if Element.self == String.self { return unsafeBitCast(jsHoleString, to: Element.self) }
        return (Element.self as? JSOptionalProtocol.Type).map { $0.jsNone as! Element }
    }

    /// `JSArray<Double>` and `JSArray<String>` only: whether `e` is an empty slot's sentinel.
    @inlinable static func isHole(_ e: Element) -> Bool {
        if JSArray.holdsNumbers { return unsafeBitCast(e, to: Double.self).bitPattern == jsHoleNumber.bitPattern }
        if JSArray.holdsStrings { return jsIsHoleString(unsafeBitCast(e, to: String.self)) }
        return false
    }

    /// Whether `Element` is `Double`. The size and `_isPOD` tests fold where the element type is known, so the element
    /// reads of an array of class references never compare metatypes (for a class, a call to its metadata accessor).
    @inlinable @inline(__always) static var holdsNumbers: Bool {
        MemoryLayout<Element>.size == MemoryLayout<Double>.size && _isPOD(Element.self) && Element.self == Double.self
    }

    /// Whether `Element` is `String`, decided as `holdsNumbers` is.
    @inlinable @inline(__always) static var holdsStrings: Bool {
        MemoryLayout<Element>.size == MemoryLayout<String>.size && !_isPOD(Element.self) && Element.self == String.self
    }

    /// `new Array(n)`: n empty slots, where the element type has a way to hold them.
    public static func holes(_ n: Double) -> JSArray<Element> {
        let array = JSArray<Element>()
        array.length = n
        return array
    }

    @usableFromInline final func outOfRange(_ index: Int) -> Never {
        fatalError("JSArray<\(Element.self)> index \(index) out of range (length \(heldCount))")
    }

    // MARK: Elements

    @inlinable public final var count: Int {
        track()
        return heldCount
    }

    @inlinable public final var isEmpty: Bool { count == 0 }

    /// The elements as a Swift array, read through the tracker.
    public final var elements: [Element] {
        track()
        if jsTracker != nil { return storage.map { jsReactive($0) } }
        return storage
    }

    /// `array.length`. Setting it shorter truncates.
    @inlinable public final var length: Double {
        get {
            track()
            return Double(heldCount)
        }
        set {
            // JavaScript throws here; a Swift setter cannot, so the error is reported and the length kept.
            guard newValue >= 0, newValue <= 4_294_967_295, newValue == newValue.rounded(.towardZero) else {
                return jsReportUncaught(JSRangeError("Invalid array length"))
            }
            setLength(Int(newValue))
        }
    }

    @usableFromInline final func setLength(_ n: Int) {
        if let source = shared {
            do { try source.jsSetLength(n) } catch { jsReportUncaught(jsCaught(error)) }
            return
        }
        if n < storage.count {
            storage.removeLast(storage.count - n)
            if jsHoles != nil {
                jsHoles = jsHoles?.filter { $0 < n }
                if jsHoles?.isEmpty == true { jsHoles = nil }
            }
            trigger()
        } else if n > storage.count {
            guard let hole = JSArray.hole else {
                fatalError("JSArray<\(Element.self)>: length \(n) beyond \(storage.count) needs an optional Element for the empty slots")
            }
            let start = storage.count
            storage.append(contentsOf: repeatElement(hole, count: n - start))
            if !JSArray.holdsNumbers && !JSArray.holdsStrings {
                var holes = jsHoles ?? Set<Int>()
                for idx in start..<n { holes.insert(idx) }
                jsHoles = holes
            }
            trigger()
        }
    }

    /// `a[i]` as JavaScript reads it: nil (undefined) unless `i` is an integer index in range of a slot that is not empty,
    /// or a key set outside the indexes (`a[-1] = v`).
    /// Inlinable: every typed element read goes through it, which the app's module then specializes.
    @inlinable public final func element(_ i: Double) -> Element? {
        jsTracker?.track()
        // An array that can be a view reads an index below `held.count` as its own (a view holds no elements), with
        // the view and out-of-range paths out of line. Other element types are never views and keep one inline path:
        // splitting theirs out changes what the -Osize outliner does to the loops around them.
        if JSArray.viewable {
            if let k = Int(exactly: i), k >= 0, k < held.count { return jsTracker == nil ? held[k] : jsReactive(held[k]) }
            return elementOther(i)
        }
        guard let k = Int(exactly: i), k >= 0, k < held.count else { return index(i) == nil ? nonIndexed(i) : nil }
        let e = jsTracker == nil ? held[k] : jsReactive(held[k])
        return JSArray.isHole(e) ? nil : e
    }

    /// `element(i)` past the elements this array holds: a view's element, a key outside the indexes, or undefined.
    @inlinable @inline(never) final func elementOther(_ i: Double) -> Element? {
        guard let k = Int(exactly: i), k >= 0, k < heldCount else { return index(i) == nil ? nonIndexed(i) : nil }
        return read(k)
    }

    // Inlinable, as the typed reads and writes below: the app's module specializes them for its element types.
    @inlinable public final subscript(i: Int) -> Element {
        get {
            if JSArray.viewable {
                if i >= 0 && i < held.count {
                    track()
                    return jsTracker == nil ? held[i] : jsReactive(held[i])
                }
                return readOther(i)
            }
            guard i >= 0 && i < held.count else {
                if i >= 4_294_967_295, let value = nonIndexed(Double(i)) { return value }
                outOfRange(i)
            }
            track()
            return read(i)
        }
        set {
            if JSArray.viewable {
                if i >= 0 && i < held.count {
                    held[i] = newValue
                    if jsHoles != nil {
                        jsHoles?.remove(i)
                        if jsHoles?.isEmpty == true { jsHoles = nil }
                    }
                    trigger()
                    return
                }
                return writeOther(i, newValue)
            }
            if i >= 0 && i < held.count {
                held[i] = newValue
                if jsHoles != nil {
                    jsHoles?.remove(i)
                    if jsHoles?.isEmpty == true { jsHoles = nil }
                }
            } else if i == held.count {
                held.append(newValue)
            } else if i >= 4_294_967_295 {
                return setNonIndexed(Double(i), newValue)
            } else if i > held.count, let hole = JSArray.hole {
                let start = held.count
                held.append(contentsOf: repeatElement(hole, count: i - start))
                if !JSArray.holdsNumbers && !JSArray.holdsStrings {
                    var holes = jsHoles ?? Set<Int>()
                    for idx in start..<i { holes.insert(idx) }
                    jsHoles = holes
                }
                held.append(newValue)
            } else {
                outOfRange(i)
            }
            trigger()
        }
    }

    /// `self[i]` past the elements this array holds: a view's element, a key outside the indexes, or out of range.
    @inlinable @inline(never) final func readOther(_ i: Int) -> Element {
        guard i >= 0 && i < heldCount else {
            if i >= 4_294_967_295, let value = nonIndexed(Double(i)) { return value }
            outOfRange(i)
        }
        track()
        return read(i)
    }

    /// `self[i] = newValue` past the elements this array holds: through a view, growing the array, or a key outside
    /// the indexes.
    @inlinable @inline(never) final func writeOther(_ i: Int, _ newValue: Element) {
        if let source = shared {
            do { try source.jsSetElement(JSArray.boxed(newValue), at: i) } catch { jsReportUncaught(jsCaught(error)) }
            return
        }
        if i >= 0 && i < held.count {
            held[i] = newValue
            if jsHoles != nil {
                jsHoles?.remove(i)
                if jsHoles?.isEmpty == true { jsHoles = nil }
            }
        } else if i == held.count {
            held.append(newValue)
        } else if i >= 4_294_967_295 {
            return setNonIndexed(Double(i), newValue)
        } else if i > held.count, let hole = JSArray.hole {
            let start = held.count
            held.append(contentsOf: repeatElement(hole, count: i - start))
            if !JSArray.holdsNumbers && !JSArray.holdsStrings {
                var holes = jsHoles ?? Set<Int>()
                for idx in start..<i { holes.insert(idx) }
                jsHoles = holes
            }
            held.append(newValue)
        } else {
            outOfRange(i)
        }
        trigger()
    }

    @inlinable public final subscript(i: Double) -> Element {
        get {
            guard let k = index(i) else {
                if let value = nonIndexed(i) ?? JSArray.hole { return value }
                fatalError("JSArray<\(Element.self)> has no element \(jsNumberToString(i))")
            }
            return self[k]
        }
        set {
            guard let k = index(i) else { return setNonIndexed(i, newValue) }
            self[k] = newValue
        }
    }

    /// A key that is no array index (`a[-1]`, `a[1.5]`) is an own property like a named one, kept with those.
    @usableFromInline final func nonIndexed(_ i: Double) -> Element? {
        guard let side = jsSideProperties(self, create: false) else { return nil }
        let key = jsNumberToString(i)
        guard side.has(key) else { return nil }
        return (try? side.get(key, receiver: self)).flatMap { $0 as? Element }
    }

    @usableFromInline final func setNonIndexed(_ i: Double, _ value: Element) {
        let side = jsSideProperties(self, create: true)!
        let key = jsNumberToString(i)
        do { if let setter = side.setter(key) { try setter(self, value) } else { try side.put(key, value) } } catch { jsReportUncaught(jsCaught(error)) }
    }

    @inlinable final func index(_ d: Double) -> Int? {
        guard d >= 0, d < 4_294_967_295, d == d.rounded(.towardZero) else { return nil }
        return Int(d)
    }

    /// `array.at(i)`: negative indexes count from the end; out of range is nil.
    public final func at(_ i: Double) -> Element? {
        track()
        let relative = jsToIntegerOrInfinity(i)
        let k = relative >= 0 ? relative : Double(heldCount) + relative
        guard k >= 0 && k < Double(heldCount) else { return nil }
        let e = read(Int(k))
        return JSArray.isHole(e) ? nil : e
    }

    // MARK: Iteration

    /// An index-based iterator that re-reads the length each step, so elements pushed during
    /// `for…of` are visited, as JavaScript's array iterator does.
    public struct Iterator: IteratorProtocol {
        let array: JSArray<Element>
        var index = 0

        public mutating func next() -> Element? {
            array.track()
            if index < array.held.count {
                defer { index += 1 }
                return array.jsTracker == nil ? array.held[index] : jsReactive(array.held[index])
            }
            guard index < array.heldCount else { return nil }
            defer { index += 1 }
            return array.read(index)
        }
    }

    public final func makeIterator() -> Iterator { Iterator(array: self) }

    /// Visits the indexes below the length at the start; indexes the callback removed are skipped.
    @inlinable @inline(__always)
    final func each(_ body: (Element, Int) throws -> Bool) rethrows {
        track()
        if held.isEmpty, shared != nil { return try eachViewed(body) }
        let length = held.count
        var k = 0
        while k < length {
            if k < held.count, try !body(jsTracker == nil ? held[k] : jsReactive(held[k]), k) { return }
            k += 1
        }
    }

    /// `each` over a view's elements.
    @inlinable @inline(never) final func eachViewed(_ body: (Element, Int) throws -> Bool) rethrows {
        let length = heldCount
        var k = 0
        while k < length {
            if k < heldCount, try !body(read(k), k) { return }
            k += 1
        }
    }

    @inline(__always)
    private func eachReversed(_ body: (Element, Int) throws -> Bool) rethrows {
        track()
        var k = heldCount - 1
        while k >= 0 {
            if k < heldCount, try !body(read(k), k) { return }
            k -= 1
        }
    }

    /// `array.keys()`.
    public final func keys() -> JSIterator<Double> {
        var i = 0
        return JSIterator { [self] in
            self.track()
            guard i < self.heldCount else { return nil }
            defer { i += 1 }
            return Double(i)
        }
    }

    /// `array.values()`.
    public final func values() -> JSIterator<Element> {
        var i = 0
        return JSIterator { [self] in
            self.track()
            guard i < self.heldCount else { return nil }
            defer { i += 1 }
            return self.read(i)
        }
    }

    /// `array.entries()`, each entry an `(index, value)` tuple.
    public final func entries() -> JSIterator<(Double, Element)> {
        var i = 0
        return JSIterator { [self] in
            self.track()
            guard i < self.heldCount else { return nil }
            defer { i += 1 }
            return (Double(i), self.read(i))
        }
    }

    // MARK: Mutators

    @inlinable @discardableResult
    public final func push(_ items: Element...) -> Double {
        if let source = shared {
            do { for item in items { try source.jsSetElement(JSArray.boxed(item), at: source.jsLength) } } catch { jsReportUncaught(jsCaught(error)) }
            return Double(source.jsLength)
        }
        storage.append(contentsOf: items)
        trigger()
        return Double(storage.count)
    }

    @inlinable public final func pop() -> Element? {
        if let source = shared {
            let n = source.jsLength
            guard n > 0 else { return nil }
            let value = read(n - 1)
            setLength(n - 1)
            return value
        }
        guard !storage.isEmpty else { return nil }
        let value = storage.removeLast()
        trigger()
        return jsTracker != nil ? jsReactive(value) : value
    }

    public final func shift() -> Element? {
        guard !storage.isEmpty else { return nil }
        let value = storage.removeFirst()
        trigger()
        return jsTracker != nil ? jsReactive(value) : value
    }

    @discardableResult
    public final func unshift(_ items: Element...) -> Double {
        storage.insert(contentsOf: items, at: 0)
        trigger()
        return Double(storage.count)
    }

    /// `array.splice(start, deleteCount, ...items)`. A nil `deleteCount` is an absent one (delete to
    /// the end); JavaScript's explicit `undefined` (delete nothing) must be passed as 0.
    @discardableResult
    public final func splice(_ start: Double, _ deleteCount: Double? = nil, _ items: Element...) -> JSArray<Element> {
        splice(start, deleteCount, contentsOf: items)
    }

    /// `array.splice(start, deleteCount, ...items)` with the items spread from one array.
    @discardableResult
    public final func splice(_ start: Double, _ deleteCount: Double?, contentsOf items: [Element]) -> JSArray<Element> {
        let length = storage.count
        let s = jsRelativeIndex(start, length)
        let count: Int
        if let deleteCount {
            count = Int(Swift.min(Swift.max(jsToIntegerOrInfinity(deleteCount), 0), Double(length - s)))
        } else {
            count = length - s
        }
        let removed = Array(storage[s..<s + count])
        storage.replaceSubrange(s..<s + count, with: items)
        if count > 0 || !items.isEmpty { trigger() }
        return JSArray(removed)
    }

    /// `array.reverse()`: in place, returns the array.
    @discardableResult
    public final func reverse() -> JSArray<Element> {
        storage.reverse()
        trigger()
        return self
    }

    /// `array.sort()`: in place and stable, by the string form of each element in UTF-16 code
    /// unit order, undefined elements last.
    @discardableResult
    public final func sort() -> JSArray<Element> {
        var keyed: [(String, Element)] = []
        var undefined: [Element] = []
        for element in storage {
            if jsIsUndefined(element) { undefined.append(element) } else { keyed.append((jsSortKey(element), element)) }
        }
        jsMergeSort(&keyed) { jsStringLess($0.0, $1.0) }
        storage = keyed.map { $0.1 } + undefined
        trigger()
        return self
    }

    private func jsSortKey(_ element: Element) -> String {
        if let s = element as? String { return s }
        return jsToString(element)
    }

    /// `array.sort(compare)`: in place and stable; undefined elements go last without being compared,
    /// and a NaN comparison result counts as 0. The array is unchanged when `compare` throws.
    @inlinable @discardableResult
    public final func sort(_ compare: (Element, Element) throws -> Double) rethrows -> JSArray<Element> {
        var defined: [Element]
        var undefined: [Element] = []
        if JSArray.canHoldUndefined {
            defined = []
            for element in storage {
                if JSArray.isUndefined(element) { undefined.append(element) } else { defined.append(element) }
            }
        } else {
            defined = storage
        }
        try jsMergeSort(&defined) { try compare($0, $1) < 0 }
        storage = undefined.isEmpty ? defined : defined + undefined
        trigger()
        return self
    }

    /// `array.sort(compare)` with a comparator that may be undefined: undefined sorts as `sort()`.
    @inlinable @discardableResult
    public final func sort(_ compare: ((Element, Element) throws -> Double)?) rethrows -> JSArray<Element> {
        guard compare != nil else { return sort() }
        return try sort { try compare!($0, $1) }
    }

    /// Whether an element can be undefined: an optional, or `Any`.
    @usableFromInline static var canHoldUndefined: Bool { Element.self is JSOptionalProtocol.Type || Element.self == Any.self }

    @usableFromInline static func isUndefined(_ element: Element) -> Bool { jsIsUndefined(element) }

    /// `array.fill(value, start, end)`: in place, returns the array.
    @discardableResult
    public final func fill(_ value: Element, _ start: Double = 0, _ end: Double? = nil) -> JSArray<Element> {
        let length = heldCount
        let s = jsRelativeIndex(start, length)
        let e = end.map { jsRelativeIndex($0, length) } ?? length
        if s < e {
            storage.replaceSubrange(s..<e, with: repeatElement(value, count: e - s))
            trigger()
        }
        return self
    }

    // MARK: Copies

    /// `array.slice(start, end)`.
    @inlinable public final func slice(_ start: Double = 0, _ end: Double? = nil) -> JSArray<Element> {
        track()
        let length = storage.count
        let s = jsRelativeIndex(start, length)
        let e = end.map { jsRelativeIndex($0, length) } ?? length
        guard s < e else { return JSArray() }
        return JSArray(jsTracker == nil ? Array(storage[s..<e]) : (s..<e).map(read))
    }

    /// `array.concat(other, ...)` with array arguments, spread one level.
    public final func concat(_ first: JSArray<Element>, _ rest: JSArray<Element>...) -> JSArray<Element> {
        track()
        var out = storage
        for array in [first] + rest {
            array.track()
            out += array.storage
        }
        return JSArray(out)
    }

    /// `array.concat(item, ...)` with element arguments. In a `JSArray<Any?>` an argument that is
    /// itself an array is spread, as in JavaScript; mixing typed arrays and elements in one call
    /// takes two calls (`a.concat(b).concat(x)`).
    public final func concat(_ items: Element...) -> JSArray<Element> {
        concat(spread: items)
    }

    /// `array.concat(...items)`.
    public final func concat(spread items: [Element]) -> JSArray<Element> {
        track()
        var out = storage
        for item in items {
            if Element.self == Any?.self, let nested = jsFlat(item) as? JSArrayProtocol {
                out += nested.jsAnyElements.map { $0 as! Element }
            } else {
                out.append(item)
            }
        }
        return JSArray(out)
    }

    /// `array.toReversed()`.
    public final func toReversed() -> JSArray<Element> {
        track()
        return JSArray(storage.reversed())
    }

    /// `array.toSorted()`.
    public final func toSorted() -> JSArray<Element> { JSArray(elements).sort() }

    /// `array.toSorted(compare)`.
    public final func toSorted(_ compare: (Element, Element) throws -> Double) rethrows -> JSArray<Element> {
        try JSArray(elements).sort(compare)
    }

    /// `array.toSorted(compare)` with a comparator that may be undefined.
    public final func toSorted(_ compare: ((Element, Element) throws -> Double)?) rethrows -> JSArray<Element> {
        try JSArray(elements).sort(compare)
    }

    // MARK: Search

    static func strictEquals(_ a: Element, _ b: Element) -> Bool {
        if Element.self == Double.self { return (a as! Double) == (b as! Double) }
        if Element.self == String.self { return jsStringEquals(a as! String, b as! String) }
        if Element.self == Bool.self { return (a as! Bool) == (b as! Bool) }
        return jsStrictEquals(a, b)
    }

    static func sameValueZero(_ a: Element, _ b: Element) -> Bool {
        if Element.self == Double.self {
            let x = a as! Double, y = b as! Double
            return x == y || (x.isNaN && y.isNaN)
        }
        if Element.self == String.self { return jsStringEquals(a as! String, b as! String) }
        return jsSameValueZero(a, b)
    }

    /// `array.indexOf(value, fromIndex)` with `===` (NaN is never found; objects by identity).
    public final func indexOf(_ value: Element, _ fromIndex: Double = 0) -> Double {
        track()
        let elements = storage
        let length = elements.count
        var k = jsRelativeIndex(fromIndex, length)
        while k < length {
            if JSArray.strictEquals(elements[k], value) { return Double(k) }
            k += 1
        }
        return -1
    }

    /// `array.lastIndexOf(value, fromIndex)` with `===`.
    public final func lastIndexOf(_ value: Element, _ fromIndex: Double? = nil) -> Double {
        track()
        let elements = storage
        let length = elements.count
        guard length > 0 else { return -1 }
        let n = fromIndex.map(jsToIntegerOrInfinity) ?? Double(length - 1)
        if n == -.infinity { return -1 }
        var k = n >= 0 ? Int(Swift.min(n, Double(length - 1))) : jsClampedInt(Double(length) + n)
        while k >= 0 {
            if JSArray.strictEquals(elements[k], value) { return Double(k) }
            k -= 1
        }
        return -1
    }

    /// `array.includes(value, fromIndex)` with SameValueZero (NaN is found).
    public final func includes(_ value: Element, _ fromIndex: Double = 0) -> Bool {
        track()
        let elements = storage
        let length = elements.count
        var k = jsRelativeIndex(fromIndex, length)
        while k < length {
            if JSArray.sameValueZero(elements[k], value) { return true }
            k += 1
        }
        return false
    }

    @inlinable public final func find(_ predicate: (Element) throws -> Bool) rethrows -> Element? {
        var found: Element?
        try each { v, _ in
            if try predicate(v) { found = v; return false }
            return true
        }
        return found
    }

    public final func find(_ predicate: (Element, Double) throws -> Bool) rethrows -> Element? {
        var found: Element?
        try each { v, i in
            if try predicate(v, Double(i)) { found = v; return false }
            return true
        }
        return found
    }

    public final func find(_ predicate: (Element, Double, JSArray<Element>) throws -> Bool) rethrows -> Element? {
        try find { v, i in try predicate(v, i, self) }
    }

    @inlinable public final func findIndex(_ predicate: (Element) throws -> Bool) rethrows -> Double {
        var found = -1
        try each { v, i in
            if try predicate(v) { found = i; return false }
            return true
        }
        return Double(found)
    }

    public final func findIndex(_ predicate: (Element, Double) throws -> Bool) rethrows -> Double {
        var found = -1
        try each { v, i in
            if try predicate(v, Double(i)) { found = i; return false }
            return true
        }
        return Double(found)
    }

    public final func findIndex(_ predicate: (Element, Double, JSArray<Element>) throws -> Bool) rethrows -> Double {
        try findIndex { v, i in try predicate(v, i, self) }
    }

    public final func findLast(_ predicate: (Element) throws -> Bool) rethrows -> Element? {
        var found: Element?
        try eachReversed { v, _ in
            if try predicate(v) { found = v; return false }
            return true
        }
        return found
    }

    public final func findLast(_ predicate: (Element, Double) throws -> Bool) rethrows -> Element? {
        var found: Element?
        try eachReversed { v, i in
            if try predicate(v, Double(i)) { found = v; return false }
            return true
        }
        return found
    }

    public final func findLast(_ predicate: (Element, Double, JSArray<Element>) throws -> Bool) rethrows -> Element? {
        try findLast { v, i in try predicate(v, i, self) }
    }

    public final func findLastIndex(_ predicate: (Element) throws -> Bool) rethrows -> Double {
        var found = -1
        try eachReversed { v, i in
            if try predicate(v) { found = i; return false }
            return true
        }
        return Double(found)
    }

    public final func findLastIndex(_ predicate: (Element, Double) throws -> Bool) rethrows -> Double {
        var found = -1
        try eachReversed { v, i in
            if try predicate(v, Double(i)) { found = i; return false }
            return true
        }
        return Double(found)
    }

    public final func findLastIndex(_ predicate: (Element, Double, JSArray<Element>) throws -> Bool) rethrows -> Double {
        try findLastIndex { v, i in try predicate(v, i, self) }
    }

    @inlinable public final func some(_ predicate: (Element) throws -> Bool) rethrows -> Bool {
        var result = false
        try each { v, _ in
            if try predicate(v) { result = true; return false }
            return true
        }
        return result
    }

    public final func some(_ predicate: (Element, Double) throws -> Bool) rethrows -> Bool {
        var result = false
        try each { v, i in
            if try predicate(v, Double(i)) { result = true; return false }
            return true
        }
        return result
    }

    public final func some(_ predicate: (Element, Double, JSArray<Element>) throws -> Bool) rethrows -> Bool {
        try some { v, i in try predicate(v, i, self) }
    }

    @inlinable public final func every(_ predicate: (Element) throws -> Bool) rethrows -> Bool {
        var result = true
        try each { v, _ in
            if try !predicate(v) { result = false; return false }
            return true
        }
        return result
    }

    public final func every(_ predicate: (Element, Double) throws -> Bool) rethrows -> Bool {
        var result = true
        try each { v, i in
            if try !predicate(v, Double(i)) { result = false; return false }
            return true
        }
        return result
    }

    public final func every(_ predicate: (Element, Double, JSArray<Element>) throws -> Bool) rethrows -> Bool {
        try every { v, i in try predicate(v, i, self) }
    }

    // MARK: Transforms

    @inlinable public final func forEach(_ body: (Element) throws -> Void) rethrows {
        try each { v, _ in
            try body(v)
            return true
        }
    }

    @inlinable public final func forEach(_ body: (Element, Double) throws -> Void) rethrows {
        try each { v, i in
            try body(v, Double(i))
            return true
        }
    }

    @inlinable public final func forEach(_ body: (Element, Double, JSArray<Element>) throws -> Void) rethrows {
        try each { v, i in
            try body(v, Double(i), self)
            return true
        }
    }

    @inlinable public final func map<U>(_ transform: (Element) throws -> U) rethrows -> JSArray<U> {
        var out: [U] = []
        out.reserveCapacity(heldCount)
        try each { v, _ in
            out.append(try transform(v))
            return true
        }
        return JSArray<U>(out)
    }

    @inlinable public final func map<U>(_ transform: (Element, Double) throws -> U) rethrows -> JSArray<U> {
        var out: [U] = []
        out.reserveCapacity(heldCount)
        try each { v, i in
            out.append(try transform(v, Double(i)))
            return true
        }
        return JSArray<U>(out)
    }

    @inlinable public final func map<U>(_ transform: (Element, Double, JSArray<Element>) throws -> U) rethrows -> JSArray<U> {
        var out: [U] = []
        out.reserveCapacity(heldCount)
        try each { v, i in
            out.append(try transform(v, Double(i), self))
            return true
        }
        return JSArray<U>(out)
    }

    @inlinable public final func filter(_ predicate: (Element) throws -> Bool) rethrows -> JSArray<Element> {
        var out: [Element] = []
        try each { v, _ in
            if try predicate(v) { out.append(v) }
            return true
        }
        return JSArray(out)
    }

    @inlinable public final func filter(_ predicate: (Element, Double) throws -> Bool) rethrows -> JSArray<Element> {
        var out: [Element] = []
        try each { v, i in
            if try predicate(v, Double(i)) { out.append(v) }
            return true
        }
        return JSArray(out)
    }

    @inlinable public final func filter(_ predicate: (Element, Double, JSArray<Element>) throws -> Bool) rethrows -> JSArray<Element> {
        var out: [Element] = []
        try each { v, i in
            if try predicate(v, Double(i), self) { out.append(v) }
            return true
        }
        return JSArray(out)
    }

    public final func flatMap<U>(_ transform: (Element) throws -> JSArray<U>) rethrows -> JSArray<U> {
        var out: [U] = []
        try each { v, _ in
            out += try transform(v).elements
            return true
        }
        return JSArray<U>(out)
    }

    public final func flatMap<U>(_ transform: (Element, Double) throws -> JSArray<U>) rethrows -> JSArray<U> {
        var out: [U] = []
        try each { v, i in
            out += try transform(v, Double(i)).elements
            return true
        }
        return JSArray<U>(out)
    }

    public final func flatMap<U>(_ transform: (Element, Double, JSArray<Element>) throws -> JSArray<U>) rethrows -> JSArray<U> {
        try flatMap { v, i in try transform(v, i, self) }
    }

    /// `array.reduce(f, initial)`.
    @inlinable public final func reduce<U>(_ next: (U, Element) throws -> U, _ initial: U) rethrows -> U {
        var accumulator = initial
        try each { v, _ in
            accumulator = try next(accumulator, v)
            return true
        }
        return accumulator
    }

    @inlinable public final func reduce<U>(_ next: (U, Element, Double) throws -> U, _ initial: U) rethrows -> U {
        var accumulator = initial
        try each { v, i in
            accumulator = try next(accumulator, v, Double(i))
            return true
        }
        return accumulator
    }

    @inlinable public final func reduce<U>(_ next: (U, Element, Double, JSArray<Element>) throws -> U, _ initial: U) rethrows -> U {
        try reduce({ a, v, i in try next(a, v, i, self) }, initial)
    }

    /// `array.reduce(f)`: the first element is the initial value; an empty array throws a TypeError.
    public final func reduce(_ next: (Element, Element) throws -> Element) throws -> Element {
        try reduce { a, v, _ in try next(a, v) }
    }

    public final func reduce(_ next: (Element, Element, Double) throws -> Element) throws -> Element {
        track()
        let length = heldCount
        guard length > 0 else { throw JSException(JSTypeError("Reduce of empty array with no initial value")) }
        var accumulator = read(0)
        var k = 1
        while k < length {
            if k < heldCount { accumulator = try next(accumulator, read(k), Double(k)) }
            k += 1
        }
        return accumulator
    }

    public final func reduce(_ next: (Element, Element, Double, JSArray<Element>) throws -> Element) throws -> Element {
        try reduce { a, v, i in try next(a, v, i, self) }
    }

    public final func reduceRight<U>(_ next: (U, Element) throws -> U, _ initial: U) rethrows -> U {
        var accumulator = initial
        try eachReversed { v, _ in
            accumulator = try next(accumulator, v)
            return true
        }
        return accumulator
    }

    public final func reduceRight<U>(_ next: (U, Element, Double) throws -> U, _ initial: U) rethrows -> U {
        var accumulator = initial
        try eachReversed { v, i in
            accumulator = try next(accumulator, v, Double(i))
            return true
        }
        return accumulator
    }

    public final func reduceRight<U>(_ next: (U, Element, Double, JSArray<Element>) throws -> U, _ initial: U) rethrows -> U {
        try reduceRight({ a, v, i in try next(a, v, i, self) }, initial)
    }

    public final func reduceRight(_ next: (Element, Element) throws -> Element) throws -> Element {
        try reduceRight { a, v, _ in try next(a, v) }
    }

    public final func reduceRight(_ next: (Element, Element, Double) throws -> Element) throws -> Element {
        track()
        guard heldCount > 0 else { throw JSException(JSTypeError("Reduce of empty array with no initial value")) }
        var k = heldCount - 1
        var accumulator = read(k)
        k -= 1
        while k >= 0 {
            if k < heldCount { accumulator = try next(accumulator, read(k), Double(k)) }
            k -= 1
        }
        return accumulator
    }

    public final func reduceRight(_ next: (Element, Element, Double, JSArray<Element>) throws -> Element) throws -> Element {
        try reduceRight { a, v, i in try next(a, v, i, self) }
    }

    // MARK: Strings

    /// `array.join(separator)`: elements in their string form, undefined and null as "".
    public final func join(_ separator: String? = ",") -> String {
        track()
        let separator = separator ?? ","
        if Element.self == String.self { return (storage as! [String]).map { jsIsHoleString($0) ? "" : $0 }.joined(separator: separator) }
        if Element.self == Double.self {
            return (storage as! [Double]).map {
                if $0.isNaN, let entry = jsForeignEntry($0) { return entry.value == nil || entry.value is JSNull ? "" : jsToString(entry.value) }
                return $0.bitPattern == jsHoleNumber.bitPattern ? "" : jsNumberToString($0)
            }.joined(separator: separator)
        }
        return jsJoin(separator)
    }

    public final func toString() -> String { join() }

    public final var description: String { jsInspect(self) }

    // MARK: Statics

    /// `Array.from(iterable)`.
    public static func from<S: Sequence>(_ items: S) -> JSArray<Element> where S.Element == Element {
        JSArray(Array(items))
    }

    /// `Array.from(iterable, (value, index) => …)`.
    public static func from<S: Sequence>(_ items: S, _ transform: (S.Element, Double) throws -> Element) rethrows -> JSArray<Element> {
        var out: [Element] = []
        for (i, item) in items.enumerated() { out.append(try transform(item, Double(i))) }
        return JSArray(out)
    }

    /// `Array.from({ length }, (_, index) => …)`.
    public static func from(length: Double, _ transform: (Double) throws -> Element) rethrows -> JSArray<Element> {
        let n = jsClampedInt(Swift.max(0, jsToIntegerOrInfinity(length)))
        var out: [Element] = []
        out.reserveCapacity(n)
        for i in 0..<n { out.append(try transform(Double(i))) }
        return JSArray(out)
    }

    /// `Array.of(...items)`.
    public static func of(_ items: Element...) -> JSArray<Element> { JSArray(items) }

    /// `Array.isArray(value)`.
    public static func isArray(_ value: Any?) -> Bool {
        // JSArrayProtocol is class-bound: a value of any other kind is no array, without a conformance lookup for its type.
        guard let v = jsFlat(value), [.swiftClass, .objCClass].contains(jsTypeKind(v)) else { return false }
        return v is JSArrayProtocol
    }

    // MARK: JSArrayProtocol, JSReactiveConvertible

    public final var jsLength: Int { count }

    public final var jsAnyElements: [Any?] {
        if let source = shared { return source.jsAnyElements }
        track()
        return storage.indices.map { JSArray.isHole(storage[$0]) ? nil : JSArray.untyped(read($0)) }
    }

    public final func jsElement(at index: Int) -> Any? {
        if let source = shared { return source.jsElement(at: index) }
        track()
        return index >= 0 && index < storage.count && !JSArray.isHole(storage[index]) && jsHoles?.contains(index) != true ? JSArray.untyped(read(index)) : nil
    }

    public final func jsHasElement(at index: Int) -> Bool {
        if let source = shared { return source.jsHasElement(at: index) }
        track()
        return index >= 0 && index < storage.count && !JSArray.isHole(storage[index]) && jsHoles?.contains(index) != true
    }

    public final func jsDeleteElement(at index: Int) {
        if let source = shared {
            source.jsDeleteElement(at: index)
            return
        }
        guard index >= 0, index < held.count, let hole = JSArray.hole else { return }
        held[index] = hole
        if !JSArray.holdsNumbers && !JSArray.holdsStrings {
            var holes = jsHoles ?? Set<Int>()
            holes.insert(index)
            jsHoles = holes
        }
        trigger()
    }

    public final func jsSetElement(_ value: Any?, at index: Int) throws {
        if let source = shared { return try source.jsSetElement(value, at: index) }
        guard let element: Element = jsConverted(value) ?? JSArray.holding(value) else {
            throw JSException(JSTypeError("Cannot store \(jsTypeof(value)) in an array of \(Element.self)"))
        }
        if index > heldCount && JSArray.hole == nil {
            throw JSException(JSRangeError("Index \(index) is past the end of an array of \(Element.self) (length \(heldCount))"))
        }
        self[index] = element
    }

    /// `array.length = n`: a RangeError where n is no valid length.
    public final func jsSetLength(checked length: Double) throws {
        guard length >= 0, length <= 4_294_967_295, length == length.rounded(.towardZero) else { throw JSException(JSRangeError("Invalid array length")) }
        try jsSetLength(Int(length))
    }

    public final func jsSetLength(_ length: Int) throws {
        if let source = shared { return try source.jsSetLength(length) }
        if length > storage.count && JSArray.hole == nil {
            throw JSException(JSRangeError("Cannot grow an array of \(Element.self) from \(storage.count) to \(length)"))
        }
        setLength(length)
    }

    /// Replaces every element; undefined, which `jsAnyElements` reads an empty slot as, is an empty slot where the
    /// element type has one.
    public final func jsSetElements(_ values: [Any?]) throws {
        if let source = shared { return try source.jsSetElements(values) }
        var elements: [Element] = []
        elements.reserveCapacity(values.count)
        for value in values {
            guard let element: Element = jsConverted(value) ?? (value == nil ? JSArray.hole : nil) ?? JSArray.holding(value) else {
                throw JSException(JSTypeError("Cannot store \(jsTypeof(value)) in an array of \(Element.self)"))
            }
            elements.append(element)
        }
        storage = elements
        trigger()
    }

    public final var jsUntyped: JSArray<Any?> { jsUntypedArray(self) }

    public final func jsView<U>(as type: U.Type) -> JSArray<U> { jsArrayView(self, as: type) }

    public final var jsViewSource: JSArrayProtocol? { shared }

    /// An element as an untyped value: a number slot holding another value (`jsForeignNumber`) reads that value.
    @inlinable @inline(__always) static func untyped(_ e: Element) -> Any? {
        if Element.self == Double.self {
            let d = unsafeBitCast(e, to: Double.self)
            if d.isNaN, let entry = jsForeignEntry(d) { return entry.value }
            return d
        } else if Element.self == Double?.self, let d = unsafeBitCast(e, to: Double?.self), d.isNaN, let entry = jsForeignEntry(d) {
            return entry.value
        }
        return jsFlat(e)
    }

    /// A value no conversion makes an `Element`, as this array holds it where JavaScript would store it: an untyped
    /// array whose elements this array's element type can hold, made that typed array (`jsAdoptArray`), or, in an
    /// array of numbers, any value (`jsForeignNumber`). Nil where the array cannot hold it.
    @usableFromInline static func holding(_ value: Any?) -> Element? {
        if Element.self == Double.self { return unsafeBitCast(jsForeignNumber(value), to: Element.self) }
        if Element.self == Double?.self { return unsafeBitCast(Double?.some(jsForeignNumber(value)), to: Element.self) }
        if let typed = Element.self as? JSArrayAdopting.Type, let plain = jsFlat(value) as? JSArrayAdoptable { return typed.jsAdopt(plain) as? Element }
        return nil
    }

    public final func jsMakeReactive() {
        if let source = shared as? JSReactiveConvertible { return source.jsMakeReactive() }
        if jsTracker == nil { jsTracker = JSTracker() }
    }
}

/// `values` written back into the typed array an untyped view stands for, after a change made through the view; a value
/// that array cannot hold is a TypeError, reported, the array left as it was.
@usableFromInline func jsStore(_ values: [Any?], into source: JSArrayProtocol) {
    do { try source.jsSetElements(values) } catch { jsReportUncaught(jsCaught(error)) }
}

/// A typed array where an untyped one is wanted (`const loose: any[] = nums`): the one array, as `JSArray<Any?>`. Its
/// view is made once while the array lives, so the untyped aliases are one object too.
public func jsUntypedArray<E>(_ array: JSArray<E>) -> JSArray<Any?> {
    if E.self == Any?.self { return unsafeDowncast(array, to: JSArray<Any?>.self) }
    if let source = array.shared { return source.jsUntyped }
    return jsStandInOf(array, JSArray<Any?>.self) {
        let view = JSArray<Any?>()
        view.standingFor = array
        return view
    }
}

/// An array where an array of another element type it can be read as is wanted: of arrays held as arrays of what
/// those are viewed as (`number[][]` as `any[][]`), of a class's objects held as its base class's (`Dog[]` as
/// `Animal[]`). The one array, as the view of it as `JSArray<U>`, made once while the array lives. An element type no
/// view can have (`JSArray.viewable`) gets a new array of the elements.
public func jsArrayView<E, U>(_ array: JSArray<E>, as _: U.Type) -> JSArray<U> {
    if let same = array as? JSArray<U> { return same }
    if let source = array.shared { return source.jsView(as: U.self) }
    guard JSArray<U>.viewable else { return JSArray<U>(array.jsAnyElements.map { jsViewElement($0) }) }
    return jsStandInOf(array, JSArray<U>.self) {
        let view = JSArray<U>()
        view.standingFor = array
        return view
    }
}

/// An element of a view's typed array as the view's element type: the same object where it is one (a subclass's
/// object as its base's), else the view of an array as that array type.
@usableFromInline func jsViewElement<U>(_ value: Any?) -> U {
    if let same = value as? U { return same }
    if let array = U.self as? JSArrayViewing.Type, let source = value as? JSArrayProtocol, let view = array.jsViewing(source) as? U { return view }
    fatalError("A view's element \(jsTypeof(value)) is not a \(U.self)")
}

/// An array type a typed array is viewed as.
protocol JSArrayViewing {
    static func jsViewing(_ source: JSArrayProtocol) -> AnyObject
}

extension JSArray: JSArrayViewing {
    static func jsViewing(_ source: JSArrayProtocol) -> AnyObject { source.jsView(as: Element.self) }
}

/// An array type an array of another element type, whose elements it can hold, becomes, keeping that array as its view.
protocol JSArrayAdopting {
    static func jsAdopt(_ plain: JSArrayAdoptable) -> AnyObject?
}

/// An array that can become a view of a typed array holding its elements.
protocol JSArrayAdoptable: AnyObject {
    /// The elements, nil where the array cannot become a view: it is one, its element type has none, it is reactive,
    /// or it has properties of its own.
    var jsAdoptableElements: [Any?]? { get }
    /// Becomes the view of `typed`, which holds its elements.
    func jsBecomeView(of typed: JSArrayProtocol)
}

extension JSArray: JSArrayAdoptable {
    var jsAdoptableElements: [Any?]? {
        guard JSArray.viewable, standingFor == nil, jsTracker == nil, jsSideProperties(self, create: false) == nil else { return nil }
        return held.map { JSArray.isHole($0) ? nil : jsFlat($0) }
    }

    func jsBecomeView(of typed: JSArrayProtocol) {
        held = []
        standingFor = typed
        _ = jsStandInOf(typed, JSArray<Element>.self) { self }
    }
}

extension JSArray: JSArrayAdopting {
    /// `plain`'s elements as this typed array, `plain` made its view, so both stay the one JavaScript array. Nil where
    /// an element cannot be held or `plain` cannot become a view.
    static func jsAdopt(_ plain: JSArrayAdoptable) -> AnyObject? {
        guard let values = plain.jsAdoptableElements else { return nil }
        var elements: [Element] = []
        elements.reserveCapacity(values.count)
        for value in values {
            guard let element: Element = jsConverted(value) ?? (value == nil ? JSArray.hole : nil) ?? JSArray.holding(value) else { return nil }
            elements.append(element)
        }
        let typed = JSArray<Element>(elements)
        plain.jsBecomeView(of: typed)
        return typed
    }
}

/// A value an array of numbers holds where JavaScript stores another kind of value in it (through an untyped alias,
/// `const loose: any[] = nums; loose.push("x")`): a signaling NaN (never an arithmetic result, never the empty slot's)
/// whose payload names the value. Typed code reads the slot as NaN; untyped reads (`jsElement`, typeof, printing,
/// JSON, string conversion) read the value. Each distinct value is kept while the program runs.
public func jsForeignNumber(_ value: Any?) -> Double {
    let id = jsForeignNumbers.id(of: jsFlat(value))
    return Double(bitPattern: jsForeignTag | UInt64(id))
}

@usableFromInline let jsForeignTag: UInt64 = 0x7FF1_0000_0000_0000

/// The value a number slot names (`jsForeignNumber`), nil for any other number.
@inlinable public func jsForeignEntry(_ d: Double) -> JSForeignEntry? {
    let bits = d.bitPattern
    guard bits & 0xFFFF_0000_0000_0000 == jsForeignTag else { return nil }
    return jsForeignNumbers.entry(Int(bits & 0x0000_FFFF_FFFF_FFFF))
}

public struct JSForeignEntry {
    public let value: Any?
}

@usableFromInline final class JSForeignNumbers {
    nonisolated deinit {}
    private var values: [Any?] = []
    private var objects: [ObjectIdentifier: Int] = [:]
    private var primitives: [AnyHashable: Int] = [:]
    private var undefined: Int?
    private let lock = NSLock()

    func id(of value: Any?) -> Int {
        lock.lock()
        defer { lock.unlock() }
        let known: Int?
        guard let value else {
            if let undefined { return undefined }
            undefined = values.count
            values.append(nil)
            return values.count - 1
        }
        let object = jsTypeKind(value) == .swiftClass || jsTypeKind(value) == .objCClass ? ObjectIdentifier(value as AnyObject) : nil
        let primitive = object == nil ? (value as? String).map { AnyHashable("s" + $0) } ?? (value as? Bool).map { AnyHashable($0) } : nil
        if let object { known = objects[object] } else if let primitive { known = primitives[primitive] } else { known = nil }
        if let known { return known }
        values.append(value)
        if let object { objects[object] = values.count - 1 } else if let primitive { primitives[primitive] = values.count - 1 }
        return values.count - 1
    }

    @usableFromInline func entry(_ id: Int) -> JSForeignEntry? {
        lock.lock()
        defer { lock.unlock() }
        return id < values.count ? JSForeignEntry(value: values[id]) : nil
    }
}

@usableFromInline let jsForeignNumbers = JSForeignNumbers()


extension JSArray {
    /// `array.flat()` for an array of arrays.
    public func flat<T>() -> JSArray<T> where Element == JSArray<T> {
        var out: [T] = []
        each { v, _ in
            out += v.elements
            return true
        }
        return JSArray<T>(out)
    }
}

extension JSArray where Element == Any? {
    /// `array.flat(depth)` for dynamic arrays: nested arrays are spread `depth` levels.
    public func flat(_ depth: Double = 1) -> JSArray<Any?> {
        func spread(_ values: [Any?], _ depth: Double, into out: inout [Any?]) {
            for value in values {
                if depth >= 1, let nested = value as? JSArrayProtocol {
                    spread(nested.jsAnyElements, depth - 1, into: &out)
                } else {
                    out.append(value)
                }
            }
        }
        var out: [Any?] = []
        spread(jsAnyElements, jsToIntegerOrInfinity(depth), into: &out)
        return JSArray(out)
    }
}

/// A relative index (`slice`, `splice`, `fill`, `indexOf`): negative counts from the end, clamped to 0…length.
@usableFromInline func jsRelativeIndex(_ value: Double, _ length: Int) -> Int {
    let relative = jsToIntegerOrInfinity(value)
    if relative < 0 { return Int(max(Double(length) + relative, 0)) }
    return Int(min(relative, Double(length)))
}

/// A stable merge sort: `less(a, b)` says whether `a` must come before `b`; equal elements keep their order.
/// Runs of 16 are sorted by insertion first, and two runs already in order are copied without merging.
/// Inlinable: the app's module specializes it for its element type and comparator.
@inlinable
func jsMergeSort<T>(_ values: inout [T], _ less: (T, T) throws -> Bool) rethrows {
    let n = values.count
    guard n > 1 else { return }
    let run = 16
    try values.withUnsafeMutableBufferPointer { a in
        var start = 0
        while start < n {
            let end = min(start + run, n)
            var i = start + 1
            while i < end {
                let x = a[i]
                var j = i
                while j > start, try less(x, a[j - 1]) {
                    a[j] = a[j - 1]
                    j -= 1
                }
                a[j] = x
                i += 1
            }
            start = end
        }
    }
    guard n > run else { return }
    var target = values
    var width = run
    while width < n {
        try values.withUnsafeBufferPointer { source in
            try target.withUnsafeMutableBufferPointer { merged in
                var start = 0
                while start < n {
                    let middle = min(start + width, n)
                    let end = min(start + 2 * width, n)
                    var ordered = middle >= end
                    if !ordered { ordered = try !less(source[middle], source[middle - 1]) }
                    if ordered {
                        for k in start..<end { merged[k] = source[k] }
                    } else {
                        var l = start, r = middle, k = start
                        while l < middle && r < end {
                            if try less(source[r], source[l]) {
                                merged[k] = source[r]
                                r += 1
                            } else {
                                merged[k] = source[l]
                                l += 1
                            }
                            k += 1
                        }
                        while l < middle {
                            merged[k] = source[l]
                            l += 1
                            k += 1
                        }
                        while r < end {
                            merged[k] = source[r]
                            r += 1
                            k += 1
                        }
                    }
                    start = end
                }
            }
        }
        swap(&values, &target)
        width *= 2
    }
}

/// An array's methods read by name from untyped code (`value.map(fn)` where `value` is `any`), over the
/// elements as JavaScript values. New arrays are untyped; the methods that change the array store into
/// its own element type, and throw a TypeError for a value it cannot hold.
func jsArrayMethod(_ array: JSArrayProtocol, _ key: String) -> JSMethod? {
    let each = { (callback: Any?, body: (Any?, Any?) throws -> Bool) throws in
        for (i, element) in array.jsAnyElements.enumerated() where try !body(element, try jsCall(callback, element, Double(i), array)) { return }
    }
    let number = { (args: [Any?], i: Int) -> Double? in jsIsNullish(jsArg(args, i)) ? nil : jsToNumber(jsArg(args, i)) }
    /// The position a relative index argument names, `fallback` when it is absent.
    let position = { (args: [Any?], i: Int, fallback: Int) -> Int in number(args, i).map { jsRelativeIndex($0, array.jsLength) } ?? fallback }
    let fold = { (args: [Any?], indices: [Int]) throws -> Any? in
        let elements = array.jsAnyElements
        var order = indices[...]
        var accumulator: Any?
        if args.count > 1 {
            accumulator = args[1]
        } else {
            guard let first = order.popFirst() else { throw JSException(JSTypeError("Reduce of empty array with no initial value")) }
            accumulator = elements[first]
        }
        for i in order { accumulator = try jsCall(jsArg(args, 0), accumulator, elements[i], Double(i), array) }
        return accumulator
    }
    let findLast = { (args: [Any?]) throws -> Int? in
        let elements = array.jsAnyElements
        return try elements.indices.reversed().first { jsTruthy(try jsCall(jsArg(args, 0), elements[$0], Double($0), array)) }
    }
    switch key {
    case "map":
        return { _, args in
            var out: [Any?] = []
            try each(jsArg(args, 0)) { _, r in out.append(r); return true }
            return JSArray<Any?>(out)
        }
    case "filter":
        return { _, args in
            var out: [Any?] = []
            try each(jsArg(args, 0)) { e, r in if jsTruthy(r) { out.append(e) }; return true }
            return JSArray<Any?>(out)
        }
    case "flatMap":
        return { _, args in
            var out: [Any?] = []
            try each(jsArg(args, 0)) { _, r in
                if let nested = r as? JSArrayProtocol { out += nested.jsAnyElements } else { out.append(r) }
                return true
            }
            return JSArray<Any?>(out)
        }
    case "forEach":
        return { _, args in try each(jsArg(args, 0)) { _, _ in true }; return nil }
    case "find", "findIndex":
        return { _, args in
            var found: Any? = nil, index = -1.0
            var i = 0.0
            try each(jsArg(args, 0)) { e, r in
                if jsTruthy(r) { found = e; index = i; return false }
                i += 1
                return true
            }
            return key == "find" ? found : index
        }
    case "findLast": return { _, args in try findLast(args).map { array.jsAnyElements[$0] } ?? nil }
    case "findLastIndex": return { _, args in Double(try findLast(args) ?? -1) }
    case "some", "every":
        return { _, args in
            var result = key == "every"
            try each(jsArg(args, 0)) { _, r in
                if jsTruthy(r) == (key == "some") { result = key == "some"; return false }
                return true
            }
            return result
        }
    case "reduce": return { _, args in try fold(args, Array(0..<array.jsLength)) }
    case "reduceRight": return { _, args in try fold(args, Array((0..<array.jsLength).reversed())) }
    case "includes":
        return { _, args in array.jsAnyElements[min(position(args, 1, 0), array.jsLength)...].contains { jsSameValueZero($0, jsArg(args, 0)) } }
    case "indexOf":
        return { _, args in
            let elements = array.jsAnyElements
            return Double((position(args, 1, 0)..<elements.count).first { jsStrictEquals(elements[$0], jsArg(args, 0)) } ?? -1)
        }
    case "lastIndexOf":
        return { _, args in
            let elements = array.jsAnyElements
            let from = args.count > 1 ? (number(args, 1) ?? 0) : Double(elements.count - 1)
            let last = from < 0 ? elements.count + Int(jsToIntegerOrInfinity(max(from, -Double(elements.count) - 1))) : min(Int(jsToIntegerOrInfinity(min(from, Double(elements.count)))), elements.count - 1)
            guard last >= 0 else { return -1.0 }
            return Double((0...last).reversed().first { jsStrictEquals(elements[$0], jsArg(args, 0)) } ?? -1)
        }
    case "at":
        return { _, args in
            let i = jsClampedInt(number(args, 0) ?? 0)
            return array.jsElement(at: i < 0 ? array.jsLength + i : i)
        }
    case "join", "toString":
        return { _, args in
            let separator = key == "toString" || jsIsNullish(jsArg(args, 0)) ? "," : jsToString(jsArg(args, 0))
            return array.jsAnyElements.map { jsIsNullish($0) || $0 is JSNull ? "" : jsToString($0) }.joined(separator: separator)
        }
    case "slice":
        return { _, args in
            let elements = array.jsAnyElements
            let from = position(args, 0, 0), to = position(args, 1, elements.count)
            return JSArray<Any?>(from < to ? Array(elements[from..<to]) : [])
        }
    case "concat":
        return { _, args in
            var out = array.jsAnyElements
            for item in args { if let nested = jsFlat(item) as? JSArrayProtocol { out += nested.jsAnyElements } else { out.append(item) } }
            return JSArray<Any?>(out)
        }
    case "keys", "values", "entries":
        // Live, as JavaScript's: an element pushed while iterating is reached.
        return { _, _ in
            var i = 0
            return JSIterator<Any?> {
                guard i < array.jsLength else { return nil }
                defer { i += 1 }
                return key == "keys" ? Double(i) : key == "values" ? array.jsElement(at: i) : JSArray<Any?>([Double(i), array.jsElement(at: i)])
            }
        }
    case "flat":
        return { _, args in JSArray<Any?>(array.jsAnyElements).flat(number(args, 0) ?? 1) }
    case "push":
        return { _, args in
            try array.jsSetElements(array.jsAnyElements + args)
            return Double(array.jsLength)
        }
    case "unshift":
        return { _, args in
            try array.jsSetElements(args + array.jsAnyElements)
            return Double(array.jsLength)
        }
    case "pop", "shift":
        return { _, _ in
            var elements = array.jsAnyElements
            guard !elements.isEmpty else { return nil }
            let removed = key == "pop" ? elements.removeLast() : elements.removeFirst()
            try array.jsSetElements(elements)
            return removed
        }
    case "splice":
        return { _, args in
            var elements = array.jsAnyElements
            let start = position(args, 0, 0)
            let count = args.isEmpty ? 0 : args.count == 1 ? elements.count - start : max(0, min(Int(jsToIntegerOrInfinity(number(args, 1) ?? 0)), elements.count - start))
            let removed = Array(elements[start..<start + count])
            elements.replaceSubrange(start..<start + count, with: args.dropFirst(2))
            try array.jsSetElements(elements)
            return JSArray<Any?>(removed)
        }
    case "reverse":
        return { _, _ in try array.jsSetElements(array.jsAnyElements.reversed()); return array }
    case "fill":
        return { _, args in
            var elements = array.jsAnyElements
            let from = position(args, 1, 0), to = position(args, 2, elements.count)
            if from < to { for i in from..<to { elements[i] = jsArg(args, 0) } }
            try array.jsSetElements(elements)
            return array
        }
    case "sort":
        return { _, args in
            let compare = jsArg(args, 0)
            var defined = array.jsAnyElements.filter { $0 != nil }
            let undefined = array.jsAnyElements.filter { $0 == nil }
            if jsIsNullish(compare) {
                var keyed = defined.map { (jsToString($0), $0) }
                jsMergeSort(&keyed) { jsStringLess($0.0, $1.0) }
                defined = keyed.map { $0.1 }
            } else {
                try jsMergeSort(&defined) { a, b in
                    let order = jsToNumber(try jsCall(compare, a, b))
                    return !order.isNaN && order < 0
                }
            }
            try array.jsSetElements(defined + undefined)
            return array
        }
    default:
        return nil
    }
}

/// `new Array(n)`'s length as a count: a RangeError where n is not an integer in 0…2³²−1.
public func jsArrayLength(_ length: Double) throws -> Int {
    guard length >= 0, length <= 4_294_967_295, length == length.rounded(.towardZero) else { throw JSException(JSRangeError("Invalid array length")) }
    return Int(length)
}

/// `Array(...items)`: one number is a length, anything else the elements.
public func jsArrayConstruct(_ items: [Any?]) throws -> JSArray<Any?> {
    guard items.count == 1, let length = jsFlat(items[0]) as? Double else { return JSArray(items) }
    return JSArray(Array(repeating: nil, count: try jsArrayLength(length)))
}

/// An array made with empty slots (`new Array(n)`) and filled by index, as the
/// element type it was declared with; a slot never written is a hole that type cannot hold.
public func jsFilled<T>(_ array: JSArray<T?>) -> JSArray<T> {
    JSArray(array.storage.enumerated().map { k, value in
        guard let value else { fatalError("JSArray<\(T.self)>: slot \(k) of \(array.storage.count) was never written") }
        return value
    })
}

/// `new Array(x)` of a value typed only at run time: `x` empty slots for a number (a
/// RangeError when it is no valid length), otherwise an array holding `x`.
public func jsNewArray(_ value: Any?) throws -> JSArray<Any?> {
    guard let length = jsFlat(value) as? Double else { return JSArray<Any?>([value]) }
    return JSArray<Any?>(Array(repeating: nil, count: try jsArrayLength(length)))
}
