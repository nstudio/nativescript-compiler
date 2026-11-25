import Foundation

// Strings from UTF-16 code units, the units JavaScript indexes strings by.

/// `units` as a string; a lone surrogate becomes U+FFFD, as `String(decoding:as: UTF16.self)` has it. Transcoded
/// here into the string's UTF-8 storage: the standard library decodes UTF-16 through its unspecialized generic
/// parser, at many times the cost.
nonisolated func jsString(utf16 units: UnsafeBufferPointer<UInt16>) -> String {
    guard !units.isEmpty else { return "" }
    return String(unsafeUninitializedCapacity: units.count * 3) { utf8 in
        var i = 0
        var o = 0
        while i < units.count {
            let u = UInt32(units[i])
            i += 1
            if u < 0x80 {
                utf8[o] = UInt8(truncatingIfNeeded: u)
                o += 1
            } else if u < 0x800 {
                utf8[o] = UInt8(truncatingIfNeeded: 0xC0 | u >> 6)
                utf8[o + 1] = UInt8(truncatingIfNeeded: 0x80 | u & 0x3F)
                o += 2
            } else if u & 0xFC00 == 0xD800, i < units.count, units[i] & 0xFC00 == 0xDC00 {
                let scalar = 0x10000 + ((u - 0xD800) << 10) + (UInt32(units[i]) - 0xDC00)
                i += 1
                utf8[o] = UInt8(truncatingIfNeeded: 0xF0 | scalar >> 18)
                utf8[o + 1] = UInt8(truncatingIfNeeded: 0x80 | scalar >> 12 & 0x3F)
                utf8[o + 2] = UInt8(truncatingIfNeeded: 0x80 | scalar >> 6 & 0x3F)
                utf8[o + 3] = UInt8(truncatingIfNeeded: 0x80 | scalar & 0x3F)
                o += 4
            } else {
                let scalar = u & 0xF800 == 0xD800 ? 0xFFFD : u
                utf8[o] = UInt8(truncatingIfNeeded: 0xE0 | scalar >> 12)
                utf8[o + 1] = UInt8(truncatingIfNeeded: 0x80 | scalar >> 6 & 0x3F)
                utf8[o + 2] = UInt8(truncatingIfNeeded: 0x80 | scalar & 0x3F)
                o += 3
            }
        }
        return o
    }
}

nonisolated func jsString<C: Collection>(utf16 units: C) -> String where C.Element == UInt16 {
    if let made = units.withContiguousStorageIfAvailable({ jsString(utf16: $0) }) { return made }
    return Array(units).withUnsafeBufferPointer { jsString(utf16: $0) }
}

/// `a` against `b` in UTF-16 code unit order, JavaScript's order of strings: -1, 0 or 1. Compared as UTF-8
/// bytes, whose order is the code points', which is the units' except where a character above U+FFFF
/// (two surrogates, D800–DFFF) meets one in U+E000–U+FFFF; the first differing bytes tell that case.
nonisolated func jsCompareUnits(_ a: String, _ b: String) -> Int {
    let compared = a.utf8.withContiguousStorageIfAvailable { x in b.utf8.withContiguousStorageIfAvailable { y in jsCompareUnits(x, y) } }
    if let compared, let compared { return compared }
    var x = a.utf16.makeIterator(), y = b.utf16.makeIterator()
    while true {
        switch (x.next(), y.next()) {
        case (nil, nil): return 0
        case (nil, _): return -1
        case (_, nil): return 1
        case let (p?, q?): if p != q { return p < q ? -1 : 1 }
        }
    }
}

nonisolated private func jsCompareUnits(_ x: UnsafeBufferPointer<UInt8>, _ y: UnsafeBufferPointer<UInt8>) -> Int {
    let n = min(x.count, y.count)
    var i = 0
    if n > 0, memcmp(x.baseAddress!, y.baseAddress!, n) != 0 {
        while x[i] == y[i] { i += 1 }
        let p = x[i], q = y[i]
        // At a lead byte: 0xF0 and above start a character above U+FFFF, 0xEE and 0xEF one in U+E000–U+FFFF.
        // Past one, the characters share their lead, and so their range.
        if p >= 0xF0 && (q == 0xEE || q == 0xEF) { return -1 }
        if q >= 0xF0 && (p == 0xEE || p == 0xEF) { return 1 }
        return p < q ? -1 : 1
    }
    return x.count == y.count ? 0 : x.count < y.count ? -1 : 1
}

/// `s`'s UTF-16 code units: an ASCII string's are its bytes, widened.
nonisolated func jsUnits(_ s: String) -> [UInt16] {
    let widened: [UInt16]?? = s.utf8.withContiguousStorageIfAvailable { bytes in
        guard bytes.count == s.utf16.count else { return nil }
        return [UInt16](unsafeUninitializedCapacity: bytes.count) { units, count in
            for i in 0..<bytes.count { units[i] = UInt16(bytes[i]) }
            count = bytes.count
        }
    }
    if let widened, let widened { return widened }
    return Array(s.utf16)
}

/// A one-unit string; a lone surrogate becomes U+FFFD, as in `jsString(utf16:)`.
nonisolated func jsString(unit: UInt16) -> String {
    Unicode.Scalar(unit).map { String(Character($0)) } ?? "\u{FFFD}"
}

/// `s` read by UTF-16 unit offset without copying its units: an ASCII string's unit is its byte, read in place;
/// any other's is reached through the UTF-16 view, whose offsets a native string's breadcrumbs make O(1) amortised.
/// A scan over many units walks a view index (`index(_:)`) rather than reading each offset anew. Nonisolated: a
/// closure isolated to the main actor checks the executor each time it runs, which costs more than the read.
nonisolated struct JSStringUnits {
    let string: String
    let count: Int
    /// Whether the units are the string's contiguous UTF-8 bytes: never for a bridged string, whose UTF-8 is not stored.
    let ascii: Bool

    init(_ s: String) {
        string = s
        let count = s.utf16.count
        self.count = count
        ascii = s.utf8.withContiguousStorageIfAvailable { $0.count == count } ?? false
    }

    /// The unit at `i`, which must be in `0..<count`.
    subscript(i: Int) -> UInt16 {
        if ascii, let byte = string.utf8.withContiguousStorageIfAvailable({ $0[i] }) { return UInt16(byte) }
        return string.utf16[index(i)]
    }

    func index(_ i: Int) -> String.UTF16View.Index {
        string.utf16.index(string.utf16.startIndex, offsetBy: i)
    }

    /// The string of the units in `range`, which must be within `0...count`.
    func slice(_ range: Range<Int>) -> String {
        guard !range.isEmpty else { return "" }
        let utf8 = string.utf8
        if ascii {
            let lower = utf8.index(utf8.startIndex, offsetBy: range.lowerBound)
            return String(Substring(utf8[lower..<utf8.index(lower, offsetBy: range.count)]))
        }
        return jsString(utf16: string.utf16[index(range.lowerBound)..<index(range.upperBound)])
    }

    /// Whether `search`'s units occur at `at`.
    func matches(_ search: String, at: Int) -> Bool {
        let n = search.utf16.count
        guard at >= 0, at + n <= count else { return false }
        if n == 0 { return true }
        if ascii {
            var needle = search
            return needle.withUTF8 { sep in
                guard sep.count == n, let p = sep.baseAddress else { return false }
                return string.utf8.withContiguousStorageIfAvailable { bytes in bytes.baseAddress.map { memcmp($0 + at, p, n) == 0 } } == true
            }
        }
        return string.utf16[index(at)...].starts(with: search.utf16)
    }

    /// Where `search`'s units first occur at or after `from`, which must be within `0...count`.
    func firstIndex(of search: String, from: Int) -> Int? {
        let n = search.utf16.count
        if n == 0 { return from }
        if from + n > count { return nil }
        if ascii {
            var needle = search
            return needle.withUTF8 { sep -> Int? in
                // A needle that is not ASCII has units no ASCII string holds.
                guard sep.count == n, let p = sep.baseAddress else { return nil }
                return string.utf8.withContiguousStorageIfAvailable { bytes -> Int? in
                    guard let base = bytes.baseAddress, let hit = memmem(base + from, count - from, p, n) else { return nil }
                    return base.distance(to: hit.assumingMemoryBound(to: UInt8.self))
                } ?? nil
            }
        }
        let units = string.utf16, needle = Array(search.utf16)
        var at = index(from)
        for i in from...(count - n) {
            if units[at] == needle[0] {
                var j = units.index(after: at), k = 1
                while k < n && units[j] == needle[k] { units.formIndex(after: &j); k += 1 }
                if k == n { return i }
            }
            units.formIndex(after: &at)
        }
        return nil
    }
}
