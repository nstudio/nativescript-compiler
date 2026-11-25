package org.nativescript.kit

// Array.prototype's methods (ECMA-262 §23.1.3) over any value as an array-like: ToObject of the receiver read by its
// "length" and its index keys through the dynamic primitives (jsGet, jsSet, jsDelete), each algorithm's steps in the
// specification's order, which getters, valueOf calls and thrown errors make observable.

private const val MAX_SAFE_INTEGER = 9007199254740991.0
private const val MAX_ARRAY_LENGTH = 4294967295.0

private val GENERIC_METHODS = hashSetOf(
    "at", "concat", "copyWithin", "entries", "every", "fill", "filter", "find", "findIndex", "findLast", "findLastIndex",
    "flat", "flatMap", "forEach", "includes", "indexOf", "join", "keys", "lastIndexOf", "map", "pop", "push", "reduce",
    "reduceRight", "reverse", "shift", "slice", "some", "sort", "splice", "toLocaleString", "toReversed", "toSorted",
    "toSpliced", "toString", "unshift", "values", "with",
)

/** Array.prototype's method `key` read from an array the dynamic method table has no entry for: the generic algorithm, on its `this`. */
internal fun jsArrayGenericMethod(key: String): JSMethod? = if (key in GENERIC_METHODS) JSMethod { self, args -> jsArrayPrototypeCall(self, key, *args) } else null

/** `Array.prototype.<method>.call(receiver, ...args)`: a real array's own method, else the method's algorithm over ToObject(receiver). */
fun jsArrayPrototypeCall(receiver: Any?, method: String, vararg args: Any?): Any? {
    val r = jsBox(receiver)
    if (method !in GENERIC_METHODS) return jsCallMethod(receiver, method, *args)
    // The dynamic method table covers only some methods; the rest run the generic algorithm, which a real array satisfies.
    if (r is JSArray<*>) jsArrayMethod(r, method)?.let { return it.call(r, args) }
    if (r == null || r === JSNull) throw JSException(JSTypeError("Array.prototype.$method called on null or undefined"))
    return ArrayLikeCall(r, args).run(method)
}

private class ArrayLikeCall(val o: Any, val args: Array<out Any?>) {
    fun arg(i: Int): Any? = if (i < args.size) jsBox(args[i]) else null

    fun run(method: String): Any? = when (method) {
        "forEach" -> { each { _, _, _ -> true }; null }
        "map" -> map()
        "filter" -> filter()
        "some" -> { var found = false; each { _, _, r -> if (jsTruthy(r)) { found = true; false } else true }; found }
        "every" -> { var all = true; each { _, _, r -> if (!jsTruthy(r)) { all = false; false } else true }; all }
        "reduce" -> reduce(false)
        "reduceRight" -> reduce(true)
        "indexOf" -> indexOf()
        "lastIndexOf" -> lastIndexOf()
        "includes" -> includes()
        "find" -> find(false, false)
        "findIndex" -> find(false, true)
        "findLast" -> find(true, false)
        "findLastIndex" -> find(true, true)
        "join" -> join()
        "toString" -> toStringMethod()
        "toLocaleString" -> toLocaleString()
        "keys" -> iterator(0)
        "values" -> iterator(1)
        "entries" -> iterator(2)
        "pop" -> pop()
        "push" -> push()
        "shift" -> shift()
        "unshift" -> unshift()
        "slice" -> slice()
        "splice" -> splice()
        "toSpliced" -> toSpliced()
        "toReversed" -> toReversed()
        "toSorted" -> toSorted()
        "sort" -> sort()
        "fill" -> fill()
        "copyWithin" -> copyWithin()
        "reverse" -> reverse()
        "at" -> at()
        "with" -> with()
        "concat" -> concat()
        "flat" -> flat()
        else -> flatMap()
    }

    private fun length(): Double = lengthOf(o)

    private fun callback(i: Int): Any? {
        val f = arg(i)
        if (!isCallable(f)) notCallable(f)
        return f
    }

    /** forEach, some, every: `body` sees each present element and the callback's result; false stops the loop. */
    private inline fun each(body: (Any?, Double, Any?) -> Boolean) {
        val len = length()
        val f = callback(0)
        val thisArg = arg(1)
        var k = 0.0
        while (k < len) {
            val key = indexKey(k)
            if (hasProperty(o, key)) {
                val v = getProperty(o, key)
                if (!body(v, k, jsCallValue(f, thisArg, false, v, k, o))) return
            }
            k++
        }
    }

    private fun map(): JSArray<Any?> {
        val len = length()
        val f = callback(0)
        val thisArg = arg(1)
        val out = ArrayOut(arrayCreateLength(len))
        var k = 0.0
        while (k < len) {
            val key = indexKey(k)
            if (hasProperty(o, key)) out.set(k, jsCallValue(f, thisArg, false, getProperty(o, key), k, o))
            k++
        }
        return out.array()
    }

    private fun filter(): JSArray<Any?> {
        val out = ArrayOut(0.0)
        var to = 0.0
        each { v, _, r -> if (jsTruthy(r)) out.set(to++, v); true }
        return out.array()
    }

    private fun reduce(fromEnd: Boolean): Any? {
        val len = length()
        val f = callback(0)
        if (len == 0.0 && args.size < 2) throw JSException(JSTypeError("Reduce of empty array with no initial value"))
        var k = if (fromEnd) len - 1 else 0.0
        val inRange = { i: Double -> if (fromEnd) i >= 0 else i < len }
        val step = if (fromEnd) -1.0 else 1.0
        var acc: Any?
        if (args.size >= 2) acc = arg(1)
        else {
            var present = false
            acc = null
            while (!present && inRange(k)) {
                val key = indexKey(k)
                present = hasProperty(o, key)
                if (present) acc = getProperty(o, key)
                k += step
            }
            if (!present) throw JSException(JSTypeError("Reduce of empty array with no initial value"))
        }
        while (inRange(k)) {
            val key = indexKey(k)
            if (hasProperty(o, key)) acc = jsCallValue(f, null, false, acc, getProperty(o, key), k, o)
            k += step
        }
        return acc
    }

    /** The first index a search from `fromIndex` looks at, or null where none is in range. */
    private fun startIndex(len: Double, fromIndex: Any?): Double? {
        var n = jsToIntegerOrInfinity(toNumber(fromIndex))
        if (n == Double.POSITIVE_INFINITY) return null
        if (n == Double.NEGATIVE_INFINITY) n = 0.0
        return if (n >= 0) n else maxOf(len + n, 0.0)
    }

    private fun indexOf(): Double {
        val len = length()
        if (len == 0.0) return -1.0
        var k = startIndex(len, arg(1)) ?: return -1.0
        val search = arg(0)
        while (k < len) {
            val key = indexKey(k)
            if (hasProperty(o, key) && jsStrictEquals(getProperty(o, key), search)) return k
            k++
        }
        return -1.0
    }

    private fun lastIndexOf(): Double {
        val len = length()
        if (len == 0.0) return -1.0
        val n = if (args.size >= 2) jsToIntegerOrInfinity(toNumber(arg(1))) else len - 1
        if (n == Double.NEGATIVE_INFINITY) return -1.0
        var k = if (n >= 0) minOf(n, len - 1) else len + n
        val search = arg(0)
        while (k >= 0) {
            val key = indexKey(k)
            if (hasProperty(o, key) && jsStrictEquals(getProperty(o, key), search)) return k
            k--
        }
        return -1.0
    }

    private fun includes(): Boolean {
        val len = length()
        if (len == 0.0) return false
        var k = startIndex(len, arg(1)) ?: return false
        val search = arg(0)
        while (k < len) {
            if (jsSameValueZero(getProperty(o, indexKey(k)), search)) return true
            k++
        }
        return false
    }

    private fun find(fromEnd: Boolean, index: Boolean): Any? {
        val len = length()
        val f = callback(0)
        val thisArg = arg(1)
        var k = if (fromEnd) len - 1 else 0.0
        while (if (fromEnd) k >= 0 else k < len) {
            val v = getProperty(o, indexKey(k))
            if (jsTruthy(jsCallValue(f, thisArg, false, v, k, o))) return if (index) k else v
            if (fromEnd) k-- else k++
        }
        return if (index) -1.0 else null
    }

    /** Join's and toLocaleString's loop; an object met again inside its own joining is "", as V8 makes it. */
    private inline fun joined(separator: () -> String, element: (Any?) -> String): String {
        val len = length()
        val sep = separator()
        val guard = jsJoinGuard
        if (guard.any { it === o }) return ""
        guard.add(o)
        try {
            val out = StringBuilder()
            var k = 0.0
            while (k < len) {
                if (k > 0) out.append(sep)
                val v = getProperty(o, indexKey(k))
                if (v != null && v !== JSNull) out.append(element(v))
                k++
            }
            return out.toString()
        } finally {
            guard.removeAt(guard.size - 1)
        }
    }

    private fun join(): String = joined({ arg(0)?.let { toStr(it) } ?: "," }) { toStr(it) }

    private fun toStringMethod(): Any? {
        val join = getProperty(o, "join")
        return if (isCallable(join)) jsCallValue(join, o, false) else jsObjectToString(o)
    }

    private fun toLocaleString(): String = joined({ "," }) { v ->
        when (v) {
            is String -> v
            is Boolean -> jsToString(v)
            is Double -> jsNumberToLocaleString(v)
            is JSBigInt -> jsBigIntToLocaleString(v)
            is JSSymbol -> v.toString()
            is JSDate -> v.toLocaleString()
            else -> {
                val f = getProperty(v ?: return@joined "", "toLocaleString")
                // Object.prototype.toLocaleString, which the kit's Object.prototype lacks: this.toString().
                toStr(if (isCallable(f)) jsCallValue(f, v, false) else if (isObject(v)) toStringOf(v) else notCallable(f))
            }
        }
    }

    private fun toStringOf(v: Any): Any? {
        val f = getProperty(v, "toString")
        return if (isCallable(f)) jsCallValue(f, v, false) else if (v is JSObject) notCallable(f) else jsToString(v)
    }

    /** %ArrayIteratorPrototype%.next over the array-like: its length read again at each step. `kind` 0 keys, 1 values, 2 entries. */
    private fun iterator(kind: Int): ArrayLikeIterator {
        var index = 0.0
        var done = false
        return ArrayLikeIterator {
            if (done) JSIterator.END
            else if (index >= lengthOf(o)) { done = true; JSIterator.END }
            else {
                val k = index++
                when (kind) {
                    0 -> k
                    1 -> getProperty(o, indexKey(k))
                    else -> JSArray(arrayListOf<Any?>(k, getProperty(o, indexKey(k))))
                }
            }
        }
    }

    private fun pop(): Any? {
        val len = length()
        if (len == 0.0) {
            setProperty(o, "length", 0.0)
            return null
        }
        val key = indexKey(len - 1)
        val v = getProperty(o, key)
        deleteProperty(o, key)
        setProperty(o, "length", len - 1)
        return v
    }

    private fun push(): Double {
        var len = length()
        if (len + args.size > MAX_SAFE_INTEGER) throw JSException(JSTypeError("Pushing ${args.size} elements on an array-like of length ${jsNumberToString(len)} is disallowed, as the total surpasses 2**53-1"))
        for (i in args.indices) setProperty(o, indexKey(len++), arg(i))
        setProperty(o, "length", len)
        return len
    }

    private fun shift(): Any? {
        val len = length()
        if (len == 0.0) {
            setProperty(o, "length", 0.0)
            return null
        }
        val first = getProperty(o, "0")
        var k = 1.0
        while (k < len) {
            move(k, k - 1)
            k++
        }
        deleteProperty(o, indexKey(len - 1))
        setProperty(o, "length", len - 1)
        return first
    }

    /** Index `from`'s value to index `to`, or `to` deleted where `from` is absent. */
    private fun move(from: Double, to: Double) {
        val fromKey = indexKey(from)
        val toKey = indexKey(to)
        if (hasProperty(o, fromKey)) setProperty(o, toKey, getProperty(o, fromKey)) else deleteProperty(o, toKey)
    }

    private fun unshift(): Double {
        val len = length()
        val count = args.size
        if (count > 0) {
            if (len + count > MAX_SAFE_INTEGER) throw JSException(JSTypeError("Invalid array length"))
            var k = len
            while (k > 0) {
                move(k - 1, k + count - 1)
                k--
            }
            for (j in 0 until count) setProperty(o, indexKey(j.toDouble()), arg(j))
        }
        setProperty(o, "length", len + count)
        return len + count
    }

    private fun relative(value: Any?, len: Double): Double {
        val n = jsToIntegerOrInfinity(toNumber(value))
        return if (n == Double.NEGATIVE_INFINITY) 0.0 else if (n < 0) maxOf(len + n, 0.0) else minOf(n, len)
    }

    private fun relativeEnd(value: Any?, len: Double): Double = if (value == null) len else relative(value, len)

    private fun slice(): JSArray<Any?> {
        val len = length()
        var k = relative(arg(0), len)
        val final = relativeEnd(arg(1), len)
        val out = ArrayOut(arrayCreateLength(maxOf(final - k, 0.0)))
        var n = 0.0
        while (k < final) {
            val key = indexKey(k)
            if (hasProperty(o, key)) out.set(n, getProperty(o, key))
            k++
            n++
        }
        out.length = n
        return out.array()
    }

    private fun deleteCount(len: Double, start: Double): Double = when (args.size) {
        0 -> 0.0
        1 -> len - start
        else -> minOf(maxOf(jsToIntegerOrInfinity(toNumber(arg(1))), 0.0), len - start)
    }

    private fun splice(): JSArray<Any?> {
        val len = length()
        val start = relative(arg(0), len)
        val itemCount = maxOf(args.size - 2, 0)
        val deleteCount = deleteCount(len, start)
        if (len + itemCount - deleteCount > MAX_SAFE_INTEGER) throw JSException(JSTypeError("Invalid array length"))
        val removed = ArrayOut(arrayCreateLength(deleteCount))
        var k = 0.0
        while (k < deleteCount) {
            val key = indexKey(start + k)
            if (hasProperty(o, key)) removed.set(k, getProperty(o, key))
            k++
        }
        removed.length = deleteCount
        if (itemCount < deleteCount) {
            k = start
            while (k < len - deleteCount) {
                move(k + deleteCount, k + itemCount)
                k++
            }
            k = len
            while (k > len - deleteCount + itemCount) {
                deleteProperty(o, indexKey(k - 1))
                k--
            }
        } else if (itemCount > deleteCount) {
            k = len - deleteCount
            while (k > start) {
                move(k + deleteCount - 1, k + itemCount - 1)
                k--
            }
        }
        for (i in 0 until itemCount) setProperty(o, indexKey(start + i), arg(i + 2))
        setProperty(o, "length", len - deleteCount + itemCount)
        return removed.array()
    }

    private fun toSpliced(): JSArray<Any?> {
        val len = length()
        val start = relative(arg(0), len)
        val insertCount = maxOf(args.size - 2, 0)
        val skipCount = deleteCount(len, start)
        val newLen = len + insertCount - skipCount
        if (newLen > MAX_SAFE_INTEGER) throw JSException(JSTypeError("Invalid array length"))
        val out = ArrayOut(arrayCreateLength(newLen))
        var i = 0.0
        var r = start + skipCount
        while (i < start) { out.set(i, getProperty(o, indexKey(i))); i++ }
        for (j in 0 until insertCount) out.set(i++, arg(j + 2))
        while (i < newLen) { out.set(i++, getProperty(o, indexKey(r))); r++ }
        return out.array()
    }

    private fun toReversed(): JSArray<Any?> {
        val len = length()
        val out = ArrayOut(arrayCreateLength(len))
        var k = 0.0
        while (k < len) { out.set(k, getProperty(o, indexKey(len - k - 1))); k++ }
        return out.array()
    }

    private fun comparator(): Any? {
        val f = arg(0)
        if (f != null && !isCallable(f)) throw JSException(JSTypeError("The comparison function must be either a function or undefined: ${toDisplay(f)}"))
        return f
    }

    /** SortIndexedProperties: the values at 0…len-1 (only the present ones where `skipHoles`), sorted by SortCompare. */
    private fun sorted(len: Double, compare: Any?, skipHoles: Boolean): List<Any?> {
        val defined = ArrayList<Any?>()
        var undefineds = 0
        var k = 0.0
        while (k < len) {
            val key = indexKey(k)
            if (!skipHoles || hasProperty(o, key)) {
                val v = getProperty(o, key)
                if (v == null) undefineds++ else defined.add(v)
            }
            k++
        }
        val items = defined.toTypedArray()
        val less: (Any?, Any?) -> Boolean = if (compare != null) { x, y ->
            val v = toNumber(jsCallValue(compare, null, false, x, y))
            v < 0
        } else { x, y -> toStr(x) < toStr(y) }
        stableSort(items, items.size, less)
        return items.asList() + List(undefineds) { null }
    }

    private fun toSorted(): JSArray<Any?> {
        val compare = comparator()
        val len = length()
        val out = ArrayOut(arrayCreateLength(len))
        sorted(len, compare, false).forEachIndexed { j, v -> out.set(j.toDouble(), v) }
        return out.array()
    }

    private fun sort(): Any {
        val compare = comparator()
        val len = length()
        val items = sorted(len, compare, true)
        var j = 0.0
        for (v in items) setProperty(o, indexKey(j++), v)
        while (j < len) deleteProperty(o, indexKey(j++))
        return o
    }

    private fun fill(): Any {
        val len = length()
        var k = relative(arg(1), len)
        val final = relativeEnd(arg(2), len)
        val value = arg(0)
        while (k < final) setProperty(o, indexKey(k++), value)
        return o
    }

    private fun copyWithin(): Any {
        val len = length()
        var to = relative(arg(0), len)
        var from = relative(arg(1), len)
        val final = relativeEnd(arg(2), len)
        var count = minOf(final - from, len - to)
        var direction = 1.0
        if (from < to && to < from + count) {
            direction = -1.0
            from += count - 1
            to += count - 1
        }
        while (count > 0) {
            move(from, to)
            from += direction
            to += direction
            count--
        }
        return o
    }

    private fun reverse(): Any {
        val len = length()
        val middle = Math.floor(len / 2)
        var lower = 0.0
        while (lower != middle) {
            val upper = len - lower - 1
            val lowerKey = indexKey(lower)
            val upperKey = indexKey(upper)
            val lowerExists = hasProperty(o, lowerKey)
            val lowerValue = if (lowerExists) getProperty(o, lowerKey) else null
            val upperExists = hasProperty(o, upperKey)
            val upperValue = if (upperExists) getProperty(o, upperKey) else null
            if (lowerExists && upperExists) {
                setProperty(o, lowerKey, upperValue)
                setProperty(o, upperKey, lowerValue)
            } else if (upperExists) {
                setProperty(o, lowerKey, upperValue)
                deleteProperty(o, upperKey)
            } else if (lowerExists) {
                deleteProperty(o, lowerKey)
                setProperty(o, upperKey, lowerValue)
            }
            lower++
        }
        return o
    }

    private fun at(): Any? {
        val len = length()
        val n = jsToIntegerOrInfinity(toNumber(arg(0)))
        val k = if (n >= 0) n else len + n
        return if (k < 0 || k >= len) null else getProperty(o, indexKey(k))
    }

    private fun with(): JSArray<Any?> {
        val len = length()
        val n = jsToIntegerOrInfinity(toNumber(arg(0)))
        val index = if (n >= 0) n else len + n
        if (index >= len || index < 0) throw JSException(JSRangeError("Invalid index : ${jsNumberToString(n)}"))
        val out = ArrayOut(arrayCreateLength(len))
        val value = arg(1)
        var k = 0.0
        while (k < len) { out.set(k, if (k == index) value else getProperty(o, indexKey(k))); k++ }
        return out.array()
    }

    private fun concat(): JSArray<Any?> {
        val out = ArrayOut(0.0)
        var n = 0.0
        for (i in -1 until args.size) {
            val e = if (i < 0) o else arg(i)
            if (e is JSArray<*> || e is Pair<*, *> || e is Triple<*, *, *>) {
                val len = lengthOf(e)
                if (n + len > MAX_SAFE_INTEGER) throw JSException(JSTypeError("Invalid array length"))
                var k = 0.0
                while (k < len) {
                    val key = indexKey(k)
                    if (hasProperty(e, key)) out.set(n, getProperty(e, key))
                    k++
                    n++
                }
            } else {
                if (n >= MAX_SAFE_INTEGER) throw JSException(JSTypeError("Invalid array length"))
                out.set(n++, e)
            }
        }
        out.length = n
        return out.array()
    }

    private fun flat(): JSArray<Any?> {
        val len = length()
        var depth = if (arg(0) == null) 1.0 else jsToIntegerOrInfinity(toNumber(arg(0)))
        if (depth < 0) depth = 0.0
        val out = ArrayOut(0.0)
        flatten(out, o, len, 0.0, depth, null, null)
        return out.array()
    }

    private fun flatMap(): JSArray<Any?> {
        val len = length()
        val f = callback(0)
        val out = ArrayOut(0.0)
        flatten(out, o, len, 0.0, 1.0, f, arg(1))
        return out.array()
    }

    /** FlattenIntoArray: the target index after the source's elements, flattened `depth` levels, are added from `start`. */
    private fun flatten(target: ArrayOut, source: Any, sourceLen: Double, start: Double, depth: Double, mapper: Any?, thisArg: Any?): Double {
        var targetIndex = start
        var k = 0.0
        while (k < sourceLen) {
            val key = indexKey(k)
            if (hasProperty(source, key)) {
                var element = getProperty(source, key)
                if (mapper != null) element = jsBox(jsCallValue(mapper, thisArg, false, element, k, source))
                if (depth > 0 && (element is JSArray<*> || element is Pair<*, *> || element is Triple<*, *, *>)) {
                    targetIndex = flatten(target, element, lengthOf(element), targetIndex, if (depth == Double.POSITIVE_INFINITY) depth else depth - 1, null, null)
                } else {
                    if (targetIndex >= MAX_SAFE_INTEGER) throw JSException(JSTypeError("Invalid array length"))
                    target.set(targetIndex++, element)
                }
            }
            k++
        }
        return targetIndex
    }
}

/** An array iterator script may hold untyped: its `next` is readable by name. */
private class ArrayLikeIterator(step: () -> Any?) : JSIterator<Any?>(step) {
    override fun jsGet(key: String): Any? = if (key == "next") JSMethod { _, a -> jsNextResult(a.getOrNull(0)) } else null
}

/**
 * The array ArrayCreate makes for a method's result, filled before anything can read it: the indices set, the others
 * holes. A length past what a kit array holds is a RangeError when the array is made, though JavaScript's sparse arrays
 * hold it.
 */
private class ArrayOut(var length: Double) {
    private val values = java.util.TreeMap<Long, Any?>()

    fun set(k: Double, v: Any?) {
        values[k.toLong()] = v
        if (k >= length) length = k + 1
    }

    fun array(): JSArray<Any?> {
        if (length > Int.MAX_VALUE - 8) throw JSException(JSRangeError("Invalid array length"))
        val n = length.toInt()
        val storage = ArrayList<Any?>(n)
        for (i in 0 until n) storage.add(null)
        val out = JSArray(storage)
        if (values.size < n) {
            val holes = java.util.BitSet(n)
            holes.set(0, n)
            for ((k, v) in values) { storage[k.toInt()] = v; holes.clear(k.toInt()) }
            out.jsHoles = holes
        } else for ((k, v) in values) storage[k.toInt()] = v
        return out
    }
}

/** LengthOfArrayLike(ToObject(o)), for a built-in that reads an array-like in the specification's order. */
internal fun jsArrayLikeLength(o: Any): Double = if (o is JSArray<*>) o.storage.size.toDouble() else lengthOf(o)

/** Get(ToObject(o), k). */
internal fun jsArrayLikeGet(o: Any, k: Int): Any? = if (o is JSArray<*>) o.storage.getOrNull(k) else getProperty(o, k.toString())

/** ArrayCreate's length check: past 2³²-1 a RangeError. */
private fun arrayCreateLength(n: Double): Double {
    if (n > MAX_ARRAY_LENGTH) throw JSException(JSRangeError("Invalid array length"))
    return n
}

/** An integer index as a property key: its canonical numeric string, never exponent form. */
private fun indexKey(k: Double): String = k.toLong().toString()

/** LengthOfArrayLike: ToLength(Get(O, "length")). */
private fun lengthOf(o: Any): Double {
    val n = jsToIntegerOrInfinity(toNumber(getProperty(o, "length")))
    return if (n <= 0) 0.0 else minOf(n, MAX_SAFE_INTEGER)
}

private fun isPrimitive(v: Any?): Boolean =
    v == null || v === JSNull || v is String || v is Boolean || v is JSSymbol || v is JSBigInt || jsNumeric(v) != null

private fun isObject(v: Any?): Boolean = !isPrimitive(v)

private fun isCallable(v: Any?): Boolean = jsIsFunction(v)

/** V8's description of a value in the comparator's TypeError. */
private fun toDisplay(v: Any?): String = when {
    v == null -> "undefined"
    v === JSNull -> "null"
    v is String -> v
    v is JSSymbol -> v.toString()
    v is JSBigInt -> v.toString()
    jsNumeric(v) != null || v is Boolean -> jsToString(v)
    else -> "#<Object>"
}

private fun notCallable(v: Any?): Nothing {
    val description = when {
        v == null -> "undefined"
        v === JSNull -> "object null"
        v is String -> "string \"$v\""
        v is Boolean -> "boolean $v"
        v is JSSymbol -> "symbol"
        v is JSBigInt -> "bigint"
        jsNumeric(v) != null -> "number ${jsToString(v)}"
        else -> "object"
    }
    throw JSException(JSTypeError("$description is not a function"))
}

/** An object whose conversion to a primitive reads its `valueOf` and `toString` by name. */
private fun convertsByName(v: Any?): Boolean = v is JSDynamic && v !is JSToPrimitive && v !is JSDate

/**
 * ToPrimitive of an object read by name: its `[Symbol.toPrimitive]`, else `valueOf` and `toString` in the hint's order.
 * A typed object's class may hold either method without naming it to `jsGet`: a name it lacks is Object.prototype's.
 */
private fun objectToPrimitive(o: JSDynamic, hint: String): Any? {
    val exotic = getProperty(o, JSSymbol.toPrimitive.key)
    if (exotic != null && exotic !== JSNull) {
        if (!isCallable(exotic)) notCallable(exotic)
        val r = jsBox(jsCallValue(exotic, o, false, hint))
        if (isPrimitive(r)) return r
        throw JSException(JSTypeError("Cannot convert object to primitive value"))
    }
    for (name in if (hint == "string") listOf("toString", "valueOf") else listOf("valueOf", "toString")) {
        val f = getProperty(o, name)
        val r = when {
            isCallable(f) -> jsBox(jsCallValue(f, o, false))
            o is JSObject -> continue
            name == "toString" -> jsToString(o)
            o is JSValueOf -> jsBox(o.jsValueOf())
            else -> continue
        }
        if (isPrimitive(r)) return r
    }
    throw JSException(JSTypeError("Cannot convert object to primitive value"))
}

/** ToNumber: a bigint is a TypeError, which `jsToNumber` (`Number()`) converts. */
private fun toNumber(value: Any?): Double = when (val v = jsBox(value)) {
    is JSBigInt -> throw JSException(JSTypeError("Cannot convert a BigInt value to a number"))
    else -> if (convertsByName(v)) toNumber(objectToPrimitive(v as JSDynamic, "number")) else jsToNumber(v)
}

/** ToString: a symbol is a TypeError. */
private fun toStr(value: Any?): String = when (val v = jsBox(value)) {
    is String -> v
    is JSSymbol -> throw JSException(JSTypeError("Cannot convert a Symbol value to a string"))
    else -> if (convertsByName(v)) toStr(objectToPrimitive(v as JSDynamic, "string")) else jsToString(v)
}

private fun stringIndex(s: String, key: String): Int? = jsArrayIndex(key)?.takeIf { it < s.length }?.toInt()

/** Get(O, key) of ToObject(o): a string's code units, nothing indexed on another primitive's wrapper. */
private fun getProperty(o: Any, key: String): Any? = jsBox(when (o) {
    is String -> if (key == "length") o.length.toDouble() else stringIndex(o, key)?.let { o[it].toString() } ?: if (jsArrayIndex(key) != null) null else jsGet(o, key)
    is Boolean, is JSSymbol, is JSBigInt -> if (key == "length" || jsArrayIndex(key) != null) null else jsGet(o, key)
    else -> if (jsNumeric(o) != null) { if (key == "length" || jsArrayIndex(key) != null) null else jsGet(o, key) }
        else if (inheritsIndex(o, key)) JSPrototypes.objectPrototype.get(key, o) else jsGet(o, key)
})

/**
 * Whether a typed object reads an index key from Object.prototype, as it lacks the key itself. Only index keys: a class's
 * methods are not all keys `jsHasOwn` sees, and Object.prototype's `toString` must not hide one.
 */
private fun inheritsIndex(o: Any, key: String): Boolean =
    o is JSDynamic && o !is JSObject && jsArrayIndex(key) != null && JSPrototypes.objectPrototype.has(key) && !jsHasOwn(o, key)

/** HasProperty(O, key). */
private fun hasProperty(o: Any, key: String): Boolean = when (o) {
    is String -> key == "length" || stringIndex(o, key) != null
    is Boolean, is JSSymbol, is JSBigInt -> false
    else -> jsNumeric(o) == null && jsHasKey(o, key)
}

/** Set(O, key, value, true): a TypeError where it fails. */
private fun setProperty(o: Any, key: String, value: Any?) {
    when (o) {
        is String -> if (key == "length" || stringIndex(o, key) != null) throw JSException(JSTypeError("Cannot assign to read only property '$key' of object '[object String]'"))
        is Boolean, is JSSymbol, is JSBigInt -> {}
        else -> if (jsNumeric(o) == null) jsSet(o, key, value)
    }
}

/** DeletePropertyOrThrow(O, key). */
private fun deleteProperty(o: Any, key: String) {
    when (o) {
        is String -> if (key == "length" || stringIndex(o, key) != null) throw JSException(JSTypeError("Cannot delete property '$key' of [object String]"))
        is Boolean, is JSSymbol, is JSBigInt -> {}
        else -> if (jsNumeric(o) == null) jsDelete(o, key)
    }
}
