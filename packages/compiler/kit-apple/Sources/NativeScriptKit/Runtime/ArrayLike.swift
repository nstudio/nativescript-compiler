import Foundation

// Array.prototype's methods called on a value that is no array (`Array.prototype.map.call(arrayLike, f)`), run as
// ECMA-262 §23.1.3 defines them: over ToObject(receiver), through its HasProperty, Get, Set and DeletePropertyOrThrow,
// in each algorithm's step order, which script observes through getters, `valueOf` and the errors they throw.

/// `Array.prototype[method].call(receiver, ...arguments)`.
@discardableResult
public func jsArrayPrototypeCall(_ receiver: Any?, _ method: String, _ arguments: Any?...) throws -> Any? {
    try arrayPrototypeCall(receiver, method, arguments)
}

/// `Array.prototype[method].apply(receiver, arguments)`.
@discardableResult
public func jsArrayPrototypeCall(_ receiver: Any?, _ method: String, spread arguments: [Any?]) throws -> Any? {
    try arrayPrototypeCall(receiver, method, arguments)
}

private let genericMethods: Set<String> = [
    "at", "concat", "copyWithin", "entries", "every", "fill", "filter", "find", "findIndex", "findLast", "findLastIndex",
    "flat", "flatMap", "forEach", "includes", "indexOf", "join", "keys", "lastIndexOf", "map", "pop", "push", "reduce",
    "reduceRight", "reverse", "shift", "slice", "some", "sort", "splice", "toLocaleString", "toReversed", "toSorted",
    "toSpliced", "toString", "unshift", "values", "with",
]

/// Array.prototype's method `key` read from an array the method table has no entry for: the generic algorithm, on its `this`.
func jsArrayGenericMethod(_ key: String) -> JSMethod? {
    genericMethods.contains(key) ? { this, args in try arrayPrototypeCall(this, key, args) } : nil
}

/// The methods whose undefined or null receiver V8 names in its TypeError; the others give ToObject's.
private let namedOnNullish: Set<String> = [
    "concat", "every", "filter", "find", "findIndex", "findLast", "findLastIndex", "forEach", "indexOf", "map", "reduce",
    "reduceRight", "some",
]

private let maxSafeLength = 9_007_199_254_740_991.0
private let maxArrayLength = 4_294_967_295.0

private func arrayPrototypeCall(_ receiver: Any?, _ method: String, _ args: [Any?]) throws -> Any? {
    let flat = jsFlat(receiver)
    if !genericMethods.contains(method) { return try jsCallMethod(receiver, method, spread: args) }
    // An array keeps the methods it answers itself; one it lacks (`copyWithin`) runs generically over it.
    if let array = flat as? JSArrayProtocol, let own = jsArrayMethod(array, method) { return try own(receiver, args) }
    // The comparator is checked before ToObject(this value).
    if method == "sort" || method == "toSorted" {
        let compare = jsArg(args, 0)
        if compare != nil && !isCallable(compare) {
            throw typeError("The comparison function must be either a function or undefined: \(jsToString(compare))")
        }
    }
    guard let value = flat, !(value is JSNull) else {
        throw typeError(namedOnNullish.contains(method) ? "Array.prototype.\(method) called on null or undefined" : "Cannot convert undefined or null to object")
    }
    let o = ArrayLike(value)
    switch method {
    case "forEach", "map", "filter", "some", "every": return try iterate(o, method, args)
    case "reduce", "reduceRight": return try reduce(o, right: method == "reduceRight", args)
    case "indexOf":
        let len = try o.length()
        if len == 0 { return -1.0 }
        var n = try toIntegerOrInfinity(jsArg(args, 1))
        if n == .infinity { return -1.0 }
        if n == -.infinity { n = 0 }
        let search = jsArg(args, 0)
        var found = -1.0
        try o.eachIndex(n >= 0 ? n : max(len + n, 0), len) { k in
            let key = indexKey(k)
            if o.has(key), jsStrictEquals(try o.get(key), search) { found = k; return false }
            return true
        }
        return found
    case "lastIndexOf":
        let len = try o.length()
        if len == 0 { return -1.0 }
        let n = args.count > 1 ? try toIntegerOrInfinity(args[1]) : len - 1
        if n == -.infinity { return -1.0 }
        let from = n >= 0 ? min(n, len - 1) : len + n
        let search = jsArg(args, 0)
        var found = -1.0
        try o.eachIndex(0, from + 1, descending: true) { k in
            let key = indexKey(k)
            if o.has(key), jsStrictEquals(try o.get(key), search) { found = k; return false }
            return true
        }
        return found
    case "includes":
        let len = try o.length()
        if len == 0 { return false }
        var n = try toIntegerOrInfinity(jsArg(args, 1))
        if n == .infinity { return false }
        if n == -.infinity { n = 0 }
        let search = jsArg(args, 0)
        var k = n >= 0 ? n : max(len + n, 0)
        // A key no object in the chain holds reads undefined: past `sparseLength` only the held keys and the first missing one are read.
        if len - k > sparseLength, let held = o.indexCandidates() {
            for c in held where c >= k && c < len {
                if c > k, search == nil { return true }
                if jsSameValueZero(try o.get(indexKey(c)), search) { return true }
                k = c + 1
            }
            return k < len && search == nil
        }
        while k < len {
            if jsSameValueZero(try o.get(indexKey(k)), search) { return true }
            k += 1
        }
        return false
    case "find", "findIndex", "findLast", "findLastIndex":
        let len = try o.length()
        let predicate = jsArg(args, 0), thisArg = jsArg(args, 1)
        try requireCallable(predicate)
        let last = method.hasPrefix("findLast")
        var k = last ? len - 1 : 0
        while last ? k >= 0 : k < len {
            let kValue = try o.get(indexKey(k))
            if jsIsTruthy(try jsInvoke(predicate, thisArg, [kValue, k, o.value])) { return method.hasSuffix("Index") ? k : kValue }
            k += last ? -1 : 1
        }
        return method.hasSuffix("Index") ? -1.0 : nil
    case "join": return try join(o, separator: jsArg(args, 0))
    case "toString":
        let join = try o.get("join")
        if isCallable(join) { return try jsInvoke(join, o.value, []) }
        return jsObjectToString(o.value)
    case "toLocaleString":
        let len = try o.length()
        var out = ""
        var k = 0.0
        while k < len {
            if k > 0 { out += "," }
            let element = jsFlat(try o.get(indexKey(k)))
            // The primitives' own toLocaleString, which a property read of a primitive does not reach.
            if let n = element as? Double {
                out += try jsNumberToLocaleString(n)
            } else if let big = element as? JSBigInt {
                out += try jsBigIntToLocaleString(big)
            } else if let date = element as? JSDate {
                out += try date.toLocaleString()
            } else if element is String || element is Bool {
                out += jsToString(element)
            } else if !jsIsNullish(element) {
                let f = try jsGet(element, "toLocaleString")
                if f != nil && !isCallable(f) { throw notAFunction(f) }
                out += try toString(f == nil ? try jsCallMethod(element, "toString") : try jsInvoke(f, element, []))
            }
            k += 1
        }
        return out
    case "at":
        let len = try o.length()
        let relative = try toIntegerOrInfinity(jsArg(args, 0))
        let k = relative >= 0 ? relative : len + relative
        return k < 0 || k >= len ? nil : try o.get(indexKey(k))
    case "keys", "values", "entries": return ArrayLikeIterator(o, method)
    case "slice":
        let len = try o.length()
        var k = relativeIndex(try toIntegerOrInfinity(jsArg(args, 0)), len)
        let final = jsArg(args, 1) == nil ? len : relativeIndex(try toIntegerOrInfinity(jsArg(args, 1)), len)
        var out = try ResultArray(creating: max(final - k, 0))
        var n = 0.0
        while k < final {
            let key = indexKey(k)
            if o.has(key) { out.put(n, try o.get(key)) }
            k += 1
            n += 1
        }
        return out.array(length: n)
    case "splice": return try splice(o, args)
    case "toSpliced":
        let len = try o.length()
        let start = relativeIndex(try toIntegerOrInfinity(jsArg(args, 0)), len)
        let items = Array(args.dropFirst(2))
        let skip = args.isEmpty ? 0 : args.count == 1 ? len - start : min(max(try toIntegerOrInfinity(args[1]), 0), len - start)
        let newLength = len + Double(items.count) - skip
        if newLength > maxSafeLength { throw typeError("Invalid array length") }
        var out = try ResultArray(creating: newLength)
        var i = 0.0, r = start + skip
        while i < start {
            out.put(i, try o.get(indexKey(i)))
            i += 1
        }
        for item in items {
            out.put(i, item)
            i += 1
        }
        while i < newLength {
            out.put(i, try o.get(indexKey(r)))
            i += 1
            r += 1
        }
        return out.array(length: newLength)
    case "toReversed":
        let len = try o.length()
        var out = try ResultArray(creating: len)
        var k = 0.0
        while k < len {
            out.put(k, try o.get(indexKey(len - k - 1)))
            k += 1
        }
        return out.array(length: len)
    case "with":
        let len = try o.length()
        let relative = try toIntegerOrInfinity(jsArg(args, 0))
        let index = relative >= 0 ? relative : len + relative
        if index >= len || index < 0 { throw JSException(JSRangeError("Invalid index : \(jsNumberToString(relative))")) }
        var out = try ResultArray(creating: len)
        var k = 0.0
        while k < len {
            out.put(k, k == index ? jsArg(args, 1) : try o.get(indexKey(k)))
            k += 1
        }
        return out.array(length: len)
    case "sort", "toSorted":
        let compare = jsArg(args, 0)
        let len = try o.length()
        if method == "toSorted" {
            _ = try ResultArray(creating: len)
            var items: [Any?] = []
            var k = 0.0
            while k < len {
                items.append(try o.get(indexKey(k)))
                k += 1
            }
            try sortCompared(&items, compare)
            return JSArray<Any?>(items)
        }
        var items: [Any?] = []
        try o.eachIndex(0, len) { k in
            let key = indexKey(k)
            if o.has(key) { items.append(try o.get(key)) }
            return true
        }
        try sortCompared(&items, compare)
        for (j, item) in items.enumerated() { try o.set(indexKey(Double(j)), item) }
        try o.eachIndex(Double(items.count), len) { j in
            try o.delete(indexKey(j))
            return true
        }
        return o.value
    case "fill":
        let len = try o.length()
        var k = relativeIndex(try toIntegerOrInfinity(jsArg(args, 1)), len)
        let final = jsArg(args, 2) == nil ? len : relativeIndex(try toIntegerOrInfinity(jsArg(args, 2)), len)
        while k < final {
            try o.set(indexKey(k), jsArg(args, 0))
            k += 1
        }
        return o.value
    case "copyWithin":
        let len = try o.length()
        var to = relativeIndex(try toIntegerOrInfinity(jsArg(args, 0)), len)
        var from = relativeIndex(try toIntegerOrInfinity(jsArg(args, 1)), len)
        let final = jsArg(args, 2) == nil ? len : relativeIndex(try toIntegerOrInfinity(jsArg(args, 2)), len)
        var count = min(final - from, len - to)
        var direction = 1.0
        if from < to && to < from + count {
            direction = -1
            from += count - 1
            to += count - 1
        }
        while count > 0 {
            let fromKey = indexKey(from), toKey = indexKey(to)
            if o.has(fromKey) { try o.set(toKey, try o.get(fromKey)) } else { try o.delete(toKey) }
            from += direction
            to += direction
            count -= 1
        }
        return o.value
    case "reverse": return try reverse(o)
    case "pop":
        let len = try o.length()
        if len == 0 {
            try o.set("length", 0.0)
            return nil
        }
        let key = indexKey(len - 1)
        let element = try o.get(key)
        try o.delete(key)
        try o.set("length", len - 1)
        return element
    case "push":
        var len = try o.length()
        if len + Double(args.count) > maxSafeLength {
            throw typeError("Pushing \(args.count) elements on an array-like of length \(jsNumberToString(len)) is disallowed, as the total surpasses 2**53-1")
        }
        for item in args {
            try o.set(indexKey(len), item)
            len += 1
        }
        try o.set("length", len)
        return len
    case "shift":
        let len = try o.length()
        if len == 0 {
            try o.set("length", 0.0)
            return nil
        }
        let first = try o.get("0")
        var k = 1.0
        while k < len {
            let from = indexKey(k), to = indexKey(k - 1)
            if o.has(from) { try o.set(to, try o.get(from)) } else { try o.delete(to) }
            k += 1
        }
        try o.delete(indexKey(len - 1))
        try o.set("length", len - 1)
        return first
    case "unshift":
        let len = try o.length()
        let count = Double(args.count)
        if count > 0 {
            if len + count > maxSafeLength { throw typeError("Invalid array length") }
            var k = len
            while k > 0 {
                let from = indexKey(k - 1), to = indexKey(k + count - 1)
                if o.has(from) { try o.set(to, try o.get(from)) } else { try o.delete(to) }
                k -= 1
            }
            for (j, item) in args.enumerated() { try o.set(indexKey(Double(j)), item) }
        }
        try o.set("length", len + count)
        return len + count
    case "concat":
        var out = ResultArray()
        var n = 0.0
        for item in [o.value] + args {
            if let array = jsFlat(item) as? JSArrayProtocol {
                let e = ArrayLike(array)
                let len = try e.length()
                if n + len > maxSafeLength { throw typeError("Invalid array length") }
                var k = 0.0
                while k < len {
                    let key = indexKey(k)
                    if e.has(key) { out.put(n, try e.get(key)) }
                    n += 1
                    k += 1
                }
            } else {
                if n >= maxSafeLength { throw typeError("Invalid array length") }
                out.put(n, item)
                n += 1
            }
        }
        return out.array(length: n)
    case "flat":
        let len = try o.length()
        var depth = 1.0
        if jsArg(args, 0) != nil {
            depth = try toIntegerOrInfinity(jsArg(args, 0))
            if depth < 0 { depth = 0 }
        }
        var out = ResultArray()
        let n = try flatten(into: &out, o, len, 0, depth, nil, nil)
        return out.array(length: n)
    case "flatMap":
        let len = try o.length()
        let mapper = jsArg(args, 0)
        try requireCallable(mapper)
        var out = ResultArray()
        let n = try flatten(into: &out, o, len, 0, 1, mapper, jsArg(args, 1))
        return out.array(length: n)
    default:
        return try jsCallMethod(receiver, method, spread: args)
    }
}

// MARK: - The algorithms that share a loop

private func iterate(_ o: ArrayLike, _ method: String, _ args: [Any?]) throws -> Any? {
    let len = try o.length()
    let callback = jsArg(args, 0), thisArg = jsArg(args, 1)
    try requireCallable(callback)
    var out = method == "map" ? try ResultArray(creating: len) : ResultArray()
    var to = 0.0
    var decided: Bool?
    try o.eachIndex(0, len) { k in
        let key = indexKey(k)
        guard o.has(key) else { return true }
        let kValue = try o.get(key)
        let result = try jsInvoke(callback, thisArg, [kValue, k, o.value])
        switch method {
        case "map": out.put(k, result)
        case "filter":
            if jsIsTruthy(result) {
                out.put(to, kValue)
                to += 1
            }
        case "some": if jsIsTruthy(result) { decided = true; return false }
        case "every": if !jsIsTruthy(result) { decided = false; return false }
        default: break
        }
        return true
    }
    switch method {
    case "map": return out.array(length: len)
    case "filter": return out.array(length: to)
    case "some": return decided ?? false
    case "every": return decided ?? true
    default: return nil
    }
}

private func reduce(_ o: ArrayLike, right: Bool, _ args: [Any?]) throws -> Any? {
    let len = try o.length()
    let callback = jsArg(args, 0)
    try requireCallable(callback)
    if len == 0 && args.count < 2 { throw typeError("Reduce of empty array with no initial value") }
    var accumulator: Any? = jsArg(args, 1)
    var started = args.count >= 2
    try o.eachIndex(0, len, descending: right) { k in
        let key = indexKey(k)
        guard o.has(key) else { return true }
        let kValue = try o.get(key)
        if started {
            accumulator = try jsInvoke(callback, nil, [accumulator, kValue, k, o.value])
        } else {
            accumulator = kValue
            started = true
        }
        return true
    }
    if !started { throw typeError("Reduce of empty array with no initial value") }
    return accumulator
}

private func join(_ o: ArrayLike, separator: Any?) throws -> String {
    let len = try o.length()
    let separator = separator == nil ? "," : try toString(separator)
    // A receiver reached again while its own elements are joined joins as "", as V8's cycle check does.
    let id = jsIsObject(o.value) ? ObjectIdentifier(o.value as AnyObject) : nil
    if let id {
        if JSJoinGuard.active.contains(id) { return "" }
        JSJoinGuard.active.append(id)
    }
    defer { if id != nil { JSJoinGuard.active.removeLast() } }
    var out = ""
    var k = 0.0
    while k < len {
        if k > 0 { out += separator }
        let element = try o.get(indexKey(k))
        if !jsIsNullish(element) { out += try toString(element) }
        k += 1
    }
    return out
}

private func splice(_ o: ArrayLike, _ args: [Any?]) throws -> Any? {
    let len = try o.length()
    let start = relativeIndex(try toIntegerOrInfinity(jsArg(args, 0)), len)
    let items = Array(args.dropFirst(2))
    let itemCount = Double(items.count)
    let deleteCount = args.isEmpty ? 0 : args.count == 1 ? len - start : min(max(try toIntegerOrInfinity(args[1]), 0), len - start)
    if len + itemCount - deleteCount > maxSafeLength { throw typeError("Invalid array length") }
    var removed = try ResultArray(creating: deleteCount)
    var k = 0.0
    while k < deleteCount {
        let from = indexKey(start + k)
        if o.has(from) { removed.put(k, try o.get(from)) }
        k += 1
    }
    if itemCount < deleteCount {
        k = start
        while k < len - deleteCount {
            let from = indexKey(k + deleteCount), to = indexKey(k + itemCount)
            if o.has(from) { try o.set(to, try o.get(from)) } else { try o.delete(to) }
            k += 1
        }
        k = len
        while k > len - deleteCount + itemCount {
            try o.delete(indexKey(k - 1))
            k -= 1
        }
    } else if itemCount > deleteCount {
        k = len - deleteCount
        while k > start {
            let from = indexKey(k + deleteCount - 1), to = indexKey(k + itemCount - 1)
            if o.has(from) { try o.set(to, try o.get(from)) } else { try o.delete(to) }
            k -= 1
        }
    }
    k = start
    for item in items {
        try o.set(indexKey(k), item)
        k += 1
    }
    try o.set("length", len - deleteCount + itemCount)
    return removed.array(length: deleteCount)
}

private func reverse(_ o: ArrayLike) throws -> Any? {
    let len = try o.length()
    let middle = (len / 2).rounded(.down)
    let swap = { (lower: Double) throws in
        let upper = len - lower - 1
        let lowerKey = indexKey(lower), upperKey = indexKey(upper)
        let lowerExists = o.has(lowerKey)
        let lowerValue = lowerExists ? try o.get(lowerKey) : nil
        let upperExists = o.has(upperKey)
        let upperValue = upperExists ? try o.get(upperKey) : nil
        if lowerExists && upperExists {
            try o.set(lowerKey, upperValue)
            try o.set(upperKey, lowerValue)
        } else if upperExists {
            try o.set(lowerKey, upperValue)
            try o.delete(upperKey)
        } else if lowerExists {
            try o.delete(lowerKey)
            try o.set(upperKey, lowerValue)
        }
    }
    // A pair of which neither key is held changes nothing: past `sparseLength` only the pairs a held key belongs to are visited.
    if middle > sparseLength, let held = o.indexCandidates() {
        let lowers = Set(held.filter { $0 < len }.map { $0 < middle ? $0 : len - $0 - 1 }).filter { $0 >= 0 && $0 < middle }.sorted()
        for lower in lowers { try swap(lower) }
        return o.value
    }
    var lower = 0.0
    while lower != middle {
        try swap(lower)
        lower += 1
    }
    return o.value
}

/// FlattenIntoArray: the next index of `target` to write.
private func flatten(into target: inout ResultArray, _ source: ArrayLike, _ sourceLength: Double, _ start: Double, _ depth: Double, _ mapper: Any?, _ thisArg: Any?) throws -> Double {
    var targetIndex = start
    var sourceIndex = 0.0
    while sourceIndex < sourceLength {
        let key = indexKey(sourceIndex)
        if source.has(key) {
            var element = try source.get(key)
            if mapper != nil { element = try jsInvoke(mapper, thisArg, [element, sourceIndex, source.value]) }
            if depth > 0, let nested = jsFlat(element) as? JSArrayProtocol {
                let inner = ArrayLike(nested)
                targetIndex = try flatten(into: &target, inner, try inner.length(), targetIndex, depth == .infinity ? depth : depth - 1, nil, nil)
            } else {
                if targetIndex >= maxSafeLength { throw typeError("Invalid array length") }
                target.put(targetIndex, element)
                targetIndex += 1
            }
        }
        sourceIndex += 1
    }
    return targetIndex
}

/// SortIndexedProperties' sort with SortCompare: undefined last, then the comparator's order or the strings' code units; stable.
private func sortCompared(_ items: inout [Any?], _ compare: Any?) throws {
    let undefinedCount = items.filter { $0 == nil }.count
    var defined = items.filter { $0 != nil }
    if compare == nil {
        try jsMergeSort(&defined) { a, b in jsStringLess(try toString(a), try toString(b)) }
    } else {
        try jsMergeSort(&defined) { a, b in
            let order = try toNumber(try jsInvoke(compare, nil, [a, b]))
            return !order.isNaN && order < 0
        }
    }
    items = defined + Array(repeating: nil, count: undefinedCount)
}

/// LengthOfArrayLike(ToObject(value)), and Get of each index, for a built-in that reads an array-like in the
/// specification's order.
func jsArrayLikeReader(_ value: Any) throws -> (length: Double, get: (Int) throws -> Any?) {
    if let array = value as? JSArrayProtocol { return (Double(array.jsLength), { $0 < array.jsLength ? array.jsElement(at: $0) : nil }) }
    if jsNumeric(value) != nil || value is Bool || value is JSSymbol || value is JSBigInt { return (0, { _ in nil }) }
    let o = ArrayLike(value)
    return (try o.length(), { try o.get(String($0)) })
}

// MARK: - The object, as the algorithms reach it

/// Past this many indexes, a loop over a plain object (and its prototypes) visits only the index keys they hold.
private let sparseLength = 100_000.0

/// O = ToObject(receiver): a string is read as its String object's code units, read-only; a number, boolean, bigint or
/// symbol as a wrapper with no index keys, whose writes nothing reads again.
private final class ArrayLike {
    nonisolated deinit {}
    let value: Any
    private lazy var units: [UInt16] = (value as? String).map(jsUnits) ?? []

    init(_ value: Any) { self.value = value }

    /// LengthOfArrayLike.
    func length() throws -> Double {
        if let string = value as? String { return Double(string.utf16.count) }
        let length = try toIntegerOrInfinity(try get("length"))
        return length <= 0 ? 0 : min(length, maxSafeLength)
    }

    /// HasProperty, own or inherited.
    func has(_ key: String) -> Bool {
        switch value {
        case is String: return key == "length" || (canonicalIndex(key).map { $0 < Double(units.count) } ?? false) || objectPrototypeHas(key)
        case let object as JSObject:
            var current: Any? = object
            while let holder = current as? JSObject {
                if holder.has(key) { return true }
                current = prototype(of: holder)
            }
            return current.map { jsHasKey($0, key) || jsIn(key, $0) } ?? false
        case let array as JSArrayProtocol:
            if key == "length" { return true }
            if let index = jsArrayIndex(key) { return array.jsHasElement(at: Int(index)) || objectPrototypeHas(key) }
            return jsSideProperties(array, create: false)?.has(key) == true || objectPrototypeHas(key)
        default:
            return jsHasKey(value, key) || (jsIsObject(value) && jsIn(key, value)) || objectPrototypeHas(key)
        }
    }

    /// Get, a getter running with the object as `this`.
    func get(_ key: String) throws -> Any? {
        switch value {
        case is String:
            if key == "length" { return Double(units.count) }
            if let index = canonicalIndex(key), index < Double(units.count) { return jsString(unit: units[Int(index)]) }
            return try jsGet(value, key) ?? objectPrototypeGet(key)
        case let object as JSObject:
            var current: Any? = object
            while let holder = current as? JSObject {
                if holder.has(key) { return try holder.get(key, receiver: object) }
                current = prototype(of: holder)
            }
            return try current.map { try jsGet($0, key) } ?? nil
        default:
            if let found = try jsGet(value, key) { return found }
            return try objectPrototypeGet(key)
        }
    }

    /// Set(O, key, value, true).
    func set(_ key: String, _ newValue: Any?) throws {
        if value is String {
            guard key == "length" || canonicalIndex(key).map({ $0 < Double(units.count) }) == true else { return }
            throw typeError("Cannot assign to read only property '\(key)' of object '[object String]'")
        }
        try jsSet(value, key, newValue)
    }

    /// DeletePropertyOrThrow.
    func delete(_ key: String) throws {
        if value is String {
            guard key == "length" || canonicalIndex(key).map({ $0 < Double(units.count) }) == true else { return }
            throw typeError("Cannot delete property '\(key)' of [object String]")
        }
        try jsDelete(value, key)
    }

    /// Visits `from..<to` (or `to-1` down to `from`) until `body` gives false. Past `sparseLength` indexes, over a plain
    /// object whose prototypes are plain too, only the index keys they held when the loop began.
    func eachIndex(_ from: Double, _ to: Double, descending: Bool = false, _ body: (Double) throws -> Bool) throws {
        guard from < to else { return }
        if to - from > sparseLength, let held = indexCandidates() {
            let range = held.filter { $0 >= from && $0 < to }
            for k in descending ? Array(range.reversed()) : range {
                if try !body(k) { return }
            }
            return
        }
        var k = descending ? to - 1 : from
        while descending ? k >= from : k < to {
            if try !body(k) { return }
            k += descending ? -1 : 1
        }
    }

    /// The index keys of a plain object and its prototype chain, ascending; nil where the chain holds anything else.
    func indexCandidates() -> [Double]? {
        guard var current = value as? JSObject else { return nil }
        var keys = Set<Double>()
        while true {
            for key in current.ownPropertyNames { if let k = canonicalIndex(key) { keys.insert(k) } }
            guard let next = prototype(of: current) else { break }
            guard let proto = next as? JSObject else { return nil }
            current = proto
        }
        return keys.sorted()
    }

    private func prototype(of object: JSObject) -> Any? {
        if let proto = jsFlat(object.jsPrototype) { return proto is JSNull ? nil : proto }
        return object === JSPrototypes.objectPrototype ? nil : JSPrototypes.objectPrototype
    }

    private func objectPrototypeHas(_ key: String) -> Bool { JSPrototypes.objectPrototype.has(key) }

    private func objectPrototypeGet(_ key: String) throws -> Any? {
        JSPrototypes.objectPrototype.has(key) ? try JSPrototypes.objectPrototype.get(key, receiver: value) : nil
    }
}

/// %ArrayIteratorPrototype%.next over an array-like: the length read again at each step, done for good once past it.
private final class ArrayLikeIterator: JSIterator<Any?>, JSHostObject {
    nonisolated deinit {}
    private var object: ArrayLike?
    private var index = 0.0
    private let kind: String

    init(_ object: ArrayLike, _ kind: String) {
        self.object = object
        self.kind = kind
        super.init(tag: "Array Iterator")
    }

    override func jsNext(_ value: Any?) throws -> JSStep {
        guard let o = object else { return JSStep(nil, true) }
        if index >= (try o.length()) {
            object = nil
            return JSStep(nil, true)
        }
        let k = index
        index += 1
        switch kind {
        case "keys": return JSStep(k, false)
        case "values": return JSStep(try o.get(indexKey(k)), false)
        default: return JSStep(JSArray<Any?>([k, try o.get(indexKey(k))]), false)
        }
    }

    /// `iterator.next()` called on the iterator held untyped.
    func jsInvoke(_ key: String, _ arguments: [Any?]) throws -> Any?? {
        key == "next" ? .some(jsIterResultObject(try jsNext(nil))) : nil
    }
}

/// ArrayCreate's elements, written by index; an index never written reads undefined.
private struct ResultArray {
    private var storage: [Any?] = []

    init() {}

    /// ArrayCreate(length): a RangeError past 2³²−1.
    init(creating length: Double) throws {
        if length > maxArrayLength { throw JSException(JSRangeError("Invalid array length")) }
    }

    mutating func put(_ k: Double, _ value: Any?) {
        let index = Int(k)
        if index < storage.count {
            storage[index] = value
            return
        }
        if index > storage.count { storage.append(contentsOf: repeatElement(nil, count: index - storage.count)) }
        storage.append(value)
    }

    func array(length: Double) -> JSArray<Any?> {
        let n = Int(length)
        return JSArray<Any?>(n > storage.count ? storage + Array(repeating: nil, count: n - storage.count) : storage)
    }
}

// MARK: - Conversions that throw what script's conversions throw

/// The property key of index `k`, a whole number below 2⁵³: its canonical numeric string.
private func indexKey(_ k: Double) -> String { String(Int64(k)) }

/// The index a canonical numeric key names ("0"…"9007199254740990"), else nil.
private func canonicalIndex(_ key: String) -> Double? {
    let utf8 = key.utf8
    guard let first = utf8.first, utf8.count <= 16, first >= 0x30, first <= 0x39, first != 0x30 || utf8.count == 1 else { return nil }
    var n: Int64 = 0
    for c in utf8 {
        guard c >= 0x30 && c <= 0x39 else { return nil }
        n = n * 10 + Int64(c - 0x30)
    }
    return Double(n) < maxSafeLength ? Double(n) : nil
}

/// A relative start or end (`slice`, `fill`, `splice`): from the end when negative, clamped to 0…length.
private func relativeIndex(_ relative: Double, _ length: Double) -> Double {
    relative < 0 ? max(length + relative, 0) : min(relative, length)
}

private func typeError(_ message: String) -> JSException { JSException(JSTypeError(message)) }

private func isCallable(_ value: Any?) -> Bool {
    guard let f = jsFlat(value) else { return false }
    return f is JSFunctionObject || f is JSFunction || f is JSMethod
}

private func requireCallable(_ value: Any?) throws {
    if !isCallable(value) { throw notAFunction(value) }
}

/// V8's TypeError for a callback that is not callable: the value's type, and a primitive's value.
private func notAFunction(_ value: Any?) -> JSException {
    let described: String
    switch jsFlat(value) {
    case nil: described = "undefined"
    case is JSNull: described = "object null"
    case let s as String: described = "string \"\(s)\""
    case let b as Bool: described = "boolean \(b)"
    case let d as Double: described = "number \(jsNumberToString(d))"
    case let v?: described = jsTypeof(v)
    }
    return typeError("\(described) is not a function")
}

private func isPrimitive(_ value: Any?) -> Bool {
    guard let v = jsFlat(value) else { return true }
    return !jsIsObject(v) || v is JSNull || v is JSSymbol || v is JSBigInt
}

/// ToPrimitive of an object read by key: its `[Symbol.toPrimitive]`, else OrdinaryToPrimitive over `valueOf` and
/// `toString`, own or inherited, a TypeError where none gives a primitive.
private func objectToPrimitive(_ object: Any, _ hint: String) throws -> Any? {
    let o = ArrayLike(object)
    if let exotic = jsFlat(try o.get(JSSymbol.toPrimitive.key)), !(exotic is JSNull) {
        try requireCallable(exotic)
        let result = jsFlat(try jsInvoke(exotic, object, [hint]))
        if isPrimitive(result) { return result }
        throw typeError("Cannot convert object to primitive value")
    }
    for name in hint == "string" ? ["toString", "valueOf"] : ["valueOf", "toString"] {
        let method = try o.get(name)
        guard isCallable(method) else { continue }
        let result = jsFlat(try jsInvoke(method, object, []))
        if isPrimitive(result) { return result }
    }
    throw typeError("Cannot convert object to primitive value")
}

/// ToPrimitive of an object through its own `valueOf`, `toString` or `[Symbol.toPrimitive]`, rethrowing what they
/// throw; nil where the object has none of them.
private func userPrimitive(_ value: Any, _ hint: String) throws -> Any?? {
    if let object = value as? JSObject { return .some(try objectToPrimitive(object, hint)) }
    // An object literal's class converts by its own `valueOf` and `toString`, but its `jsToPrimitive` stops at the first.
    if let literal = value as? JSDynamic, literal[jsKey: JSSymbol.toPrimitive.key] == nil, literal.jsKeys.contains(where: { $0 == "valueOf" || $0 == "toString" }) {
        return .some(try objectToPrimitive(literal, hint))
    }
    if hint != "string", let convertible = value as? JSValueOfConvertible {
        let primitive = jsFlat(try convertible.jsValueOf())
        if isPrimitive(primitive) { return .some(primitive) }
    }
    if let convertible = value as? JSToPrimitive { return .some(jsFlat(try convertible.jsToPrimitive(hint))) }
    if let convertible = value as? JSStringConvertible { return .some(try convertible.toString()) }
    return nil
}

private func toNumber(_ value: Any?) throws -> Double {
    guard let v = jsFlat(value) else { return .nan }
    if v is JSSymbol { throw typeError("Cannot convert a Symbol value to a number") }
    if v is JSBigInt { throw typeError("Cannot convert a BigInt value to a number") }
    if jsIsObject(v), !(v is JSNull), let primitive = try userPrimitive(v, "number") { return try toNumber(primitive) }
    return jsToNumber(v)
}

private func toIntegerOrInfinity(_ value: Any?) throws -> Double { jsToIntegerOrInfinity(try toNumber(value)) }

private func toString(_ value: Any?) throws -> String {
    guard let v = jsFlat(value) else { return "undefined" }
    if v is JSSymbol { throw typeError("Cannot convert a Symbol value to a string") }
    if jsIsObject(v), !(v is JSNull), !(v is JSBigInt), let primitive = try userPrimitive(v, "string") { return try toString(primitive) }
    return jsToString(v)
}
