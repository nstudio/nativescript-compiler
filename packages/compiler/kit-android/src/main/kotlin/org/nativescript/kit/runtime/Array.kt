package org.nativescript.kit

private val EMPTY_ARRAY_STORAGE = ArrayList<Any?>(0)

/**
 * A JavaScript array: reference semantics, JavaScript method names, `Double` indexes and lengths.
 * Reading past the end is undefined through `element`, which translated code uses for `a[i]`.
 */
open class JSArray<T>(storage: ArrayList<T>) : Iterable<T>, JSReactiveConvertible {
    @PublishedApi internal var _storage: ArrayList<T>? = storage
    @PublishedApi internal var doubles: DoubleArray? = null
    @PublishedApi internal var dSize: Int = 0

    var storage: ArrayList<T>
        get() {
            val d = doubles
            if (d != null) return materializeDoubles(d)
            return _storage!!
        }
        internal set(value) {
            doubles = null
            dSize = 0
            _storage = value
        }
    var jsTracker: JSTracker? = null

    constructor() : this(ArrayList())
    constructor(items: Collection<T>) : this(ArrayList(items))

    @Suppress("UNCHECKED_CAST")
    @PublishedApi internal fun materializeDoubles(d: DoubleArray): ArrayList<T> {
        val n = dSize
        val list = ArrayList<T>(n)
        var i = 0
        while (i < n) { list.add(d[i] as T); i++ }
        _storage = list
        doubles = null
        dSize = 0
        return list
    }

    @PublishedApi internal fun appendDouble(v: Double) {
        var d = doubles!!
        val n = dSize
        if (n == d.size) {
            d = d.copyOf(if (n == 0) 8 else n shl 1)
            doubles = d
        }
        d[n] = v
        dSize = n + 1
    }

    private fun track() { jsTracker?.track() }
    private fun trigger() { jsTracker?.trigger() }

    @Suppress("UNCHECKED_CAST")
    @PublishedApi internal fun read(i: Int): T {
        val d = doubles
        if (d != null) return d[i] as T
        val v = _storage!![i]
        if (jsTracker != null) jsReactiveAny(v)
        return v
    }

    // Elements

    val size: Int
        get() { track(); return if (doubles != null) dSize else _storage!!.size }

    /** The elements as a list, read through the tracker. */
    val elements: List<T>
        get() {
            track()
            val list = storage
            if (jsTracker != null) list.forEach { jsReactiveAny(it) }
            return list
        }

    /** `array.length`. Setting it shorter truncates; longer adds holes. */
    var length: Double
        get() { track(); return (if (doubles != null) dSize else _storage!!.size).toDouble() }
        set(value) {
            if (value < 0 || value > 4_294_967_295.0 || value != Math.floor(value)) throw JSException(JSRangeError("Invalid array length"))
            setLength(value.toInt())
        }

    @Suppress("UNCHECKED_CAST")
    internal fun setLength(n: Int) {
        if (doubles != null) {
            if (n < dSize) { dSize = n; return }
            if (n == dSize) return
        }
        val list = storage
        if (n < list.size) {
            while (list.size > n) list.removeAt(list.size - 1)
            jsHoles?.clear(n, Int.MAX_VALUE)
            trigger()
        } else if (n > list.size) {
            (jsHoles ?: java.util.BitSet().also { jsHoles = it }).set(list.size, n)
            while (list.size < n) list.add(null as T)
            trigger()
        }
    }

    /** Properties under keys that are no index (`a[0.5] = x`, `Object.defineProperty(a, …)`), as script gives an array. */
    var jsProperties: JSObject? = null

    /** `a[i]` as JavaScript reads it: undefined unless `i` is an integer index in range, or a key the array was given. */
    @Suppress("UNCHECKED_CAST")
    fun element(i: Double): T? {
        val d = doubles
        if (d != null) {
            val k = i.toInt()
            if (k >= 0 && k.toDouble() == i) return if (k < dSize) d[k] as T else null
            if (i != Math.floor(i) || i < 0 || i >= 4_294_967_295.0) return jsProperties?.get(jsNumberToString(i), this) as T?
            return null
        }
        track()
        val list = _storage!!
        val k = i.toInt()
        if (k >= 0 && k.toDouble() == i) return if (k < list.size) read(k) else null
        if (i != Math.floor(i) || i < 0 || i >= 4_294_967_295.0) return jsProperties?.get(jsNumberToString(i), this) as T?
        if (i >= list.size) return null
        return read(i.toInt())
    }

    private fun readTracked(i: Int): T {
        jsTracker!!.track()
        val v = _storage!![i]
        jsReactiveAny(v)
        return v
    }

    @Suppress("UNCHECKED_CAST")
    operator fun get(i: Int): T {
        val d = doubles
        if (d != null) return d[i] as T
        return if (jsTracker == null) _storage!![i] else readTracked(i)
    }

    operator fun get(i: Double): T = get(i.toInt())

    /** Indices a write past the end skipped (`a[1] = x` of an empty array): holes, which `for…in` and `Object.keys` leave out. */
    var jsHoles: java.util.BitSet? = null

    @Suppress("UNCHECKED_CAST")
    operator fun set(i: Int, value: T) {
        val d = doubles
        if (d != null && value is Double) {
            if (i >= 0 && i < dSize) { d[i] = value; return }
            if (i == dSize) { appendDouble(value); return }
        }
        val list = storage
        when {
            i < list.size -> { list[i] = value; jsHoles?.clear(i) }
            else -> {
                if (list.size < i) (jsHoles ?: java.util.BitSet().also { jsHoles = it }).set(list.size, i)
                while (list.size < i) list.add(null as T)
                list.add(value)
            }
        }
        trigger()
    }

    operator fun set(i: Double, value: T) {
        val d = doubles
        val k = i.toInt()
        if (d != null && value is Double && k >= 0 && k.toDouble() == i) {
            if (k < dSize) { d[k] = value; return }
            if (k == dSize) { appendDouble(value); return }
        }
        val list = storage
        if (k >= 0 && k.toDouble() == i && k < list.size) {
            list[k] = value
            jsHoles?.clear(k)
            trigger()
            return
        }
        if (i < 0 || i != Math.floor(i) || i >= 4_294_967_295.0) {
            (jsProperties ?: JSObject().also { jsProperties = it }).put(jsNumberToString(i), value)
            return
        }
        set(i.toInt(), value)
    }

    @Suppress("UNCHECKED_CAST")
    internal fun setAt(i: Int, value: Any?) = set(i, value as T)

    /** `delete array[key]`: an index in range becomes a hole; length cannot be deleted. */
    @Suppress("UNCHECKED_CAST")
    internal fun jsDeleteKey(key: String): Boolean {
        if (key == "length") throw JSException(JSTypeError("Cannot delete property 'length' of [object Array]"))
        val index = jsArrayIndex(key)
        if (index == null) {
            if (jsProperties?.delete(key) == false) throw JSException(JSTypeError("Cannot delete property '$key' of [object Array]"))
            return true
        }
        val k = index.toInt()
        if (k < storage.size) {
            storage[k] = null as T
            (jsHoles ?: java.util.BitSet().also { jsHoles = it }).set(k)
            trigger()
        }
        return true
    }

    fun at(i: Double): T? {
        val d = doubles
        if (d != null) {
            var k = jsToIntegerOrInfinity(i)
            if (k < 0) k += dSize
            @Suppress("UNCHECKED_CAST")
            return if (k >= 0 && k < dSize) d[k.toInt()] as T else null
        }
        track()
        var k = jsToIntegerOrInfinity(i)
        if (k < 0) k += storage.size
        return if (k >= 0 && k < storage.size) read(k.toInt()) else null
    }

    override fun iterator(): Iterator<T> {
        var i = 0
        return object : Iterator<T> {
            override fun hasNext(): Boolean {
                val d = doubles
                if (d != null) return i < dSize
                track()
                return i < _storage!!.size
            }
            override fun next(): T = read(i++)
        }
    }

    fun keys(): JSIterator<Double> {
        var i = 0
        return JSIterator { if (i < size) (i++).toDouble() else JSIterator.END }
    }

    fun values(): JSIterator<T> {
        var i = 0
        return JSIterator { if (i < size) read(i++) else JSIterator.END }
    }

    fun entries(): JSIterator<Pair<Double, T>> {
        var i = 0
        return JSIterator { if (i < size) Pair(i.toDouble(), read(i++)) else JSIterator.END }
    }

    // Mutation

    fun push(item: T): Double {
        val d = doubles
        if (d != null && item is Double) {
            appendDouble(item)
            return dSize.toDouble()
        }
        val list = storage
        list.add(item)
        trigger()
        return list.size.toDouble()
    }

    fun push(vararg items: T): Double {
        val d = doubles
        if (d != null && items.all { it is Double }) {
            for (item in items) appendDouble(item as Double)
            return dSize.toDouble()
        }
        val list = storage
        list.ensureCapacity(list.size + items.size)
        for (item in items) list.add(item)
        trigger()
        return list.size.toDouble()
    }

    /** `a.push(...items)`. */
    fun pushAll(items: Iterable<T>): Double {
        for (item in items.toList()) storage.add(item)
        trigger()
        return storage.size.toDouble()
    }

    @Suppress("UNCHECKED_CAST")
    fun pop(): T? {
        val d = doubles
        if (d != null) {
            if (dSize == 0) return null
            return d[--dSize] as T
        }
        val list = storage
        if (list.isEmpty()) return null
        val v = list.removeAt(list.size - 1)
        trigger()
        return v
    }

    fun shift(): T? {
        if (storage.isEmpty()) return null
        val v = storage.removeAt(0)
        trigger()
        return v
    }

    fun unshift(vararg items: T): Double {
        storage.addAll(0, items.toList())
        trigger()
        return storage.size.toDouble()
    }

    fun unshiftAll(items: Iterable<T>): Double {
        storage.addAll(0, items.toList())
        trigger()
        return storage.size.toDouble()
    }

    /** `a.splice(start, deleteCount, ...items)`; a missing deleteCount removes to the end. */
    fun splice(start: Double, deleteCount: Double? = null, vararg items: T): JSArray<T> = spliceAll(start, deleteCount, items.asList())

    /** `a.splice(start, deleteCount, ...items)` with the items spread from one list. */
    fun spliceAll(start: Double, deleteCount: Double?, items: Iterable<T>): JSArray<T> {
        val n = storage.size
        val s = jsRelativeIndex(start, n)
        val d = if (deleteCount == null) n - s else maxOf(0, minOf(jsToIntegerOrInfinity(deleteCount).clampToInt(), n - s))
        val removed = ArrayList(storage.subList(s, s + d))
        storage.subList(s, s + d).clear()
        val added = items.toList()
        storage.addAll(s, added)
        if (d > 0 || added.isNotEmpty()) trigger()
        return JSArray(removed)
    }

    fun reverse(): JSArray<T> {
        val d = doubles
        if (d != null) {
            var lo = 0
            var hi = dSize - 1
            while (lo < hi) {
                val tmp = d[lo]
                d[lo] = d[hi]
                d[hi] = tmp
                lo++
                hi--
            }
            return this
        }
        storage.reverse()
        trigger()
        return this
    }

    /** `array.sort()`: in place and stable, by string form in UTF-16 order, undefined last. */
    @Suppress("UNCHECKED_CAST")
    fun sort(): JSArray<T> {
        val values = arrayOfNulls<Any?>(storage.size)
        val texts = arrayOfNulls<String>(storage.size)
        var undefineds: ArrayList<T>? = null
        var defined = 0
        // Undefined is `null` or `Unit` (jsIsNullish).
        for (e in storage) {
            if (e == null || e === Unit) (undefineds ?: ArrayList<T>().also { undefineds = it }).add(e)
            else {
                values[defined] = e
                texts[defined] = if (e is String) e else jsToString(e)
                defined++
            }
        }
        // The positions sorted by their texts, which are made once.
        val order = arrayOfNulls<Any?>(defined)
        for (k in 0 until defined) order[k] = k
        stableSort(order, defined) { a, b -> texts[a as Int]!! < texts[b as Int]!! }
        replaceSorted(defined, undefineds) { k -> values[order[k] as Int] as T }
        return this
    }

    /** `array.sort(compare)`: in place and stable; undefined last without being compared, NaN counts as 0. An undefined
     *  `compare` sorts as `sort()`. */
    @Suppress("UNCHECKED_CAST")
    fun sort(compare: ((T, T) -> Double)?): JSArray<T> {
        if (compare == null) return sort()
        val values = arrayOfNulls<Any?>(storage.size)
        var undefineds: ArrayList<T>? = null
        var defined = 0
        for (e in storage) {
            if (e == null || e === Unit) (undefineds ?: ArrayList<T>().also { undefineds = it }).add(e)
            else values[defined++] = e
        }
        stableSort(values, defined) { a, b -> compare(a as T, b as T) < 0 }
        replaceSorted(defined, undefineds) { k -> values[k] as T }
        return this
    }

    /** The storage as the `defined` sorted elements, then the undefined ones. */
    private inline fun replaceSorted(defined: Int, undefineds: List<T>?, sorted: (Int) -> T) {
        val out = ArrayList<T>(defined + (undefineds?.size ?: 0))
        for (k in 0 until defined) out.add(sorted(k))
        if (undefineds != null) out.addAll(undefineds)
        storage = out
        trigger()
    }

    fun fill(value: T, start: Double = 0.0, end: Double? = null): JSArray<T> {
        val d = doubles
        if (d != null && value is Double) {
            val n = dSize
            val s = jsRelativeIndex(start, n)
            val e = if (end == null) n else jsRelativeIndex(end, n)
            if (s < e) java.util.Arrays.fill(d, s, e, value)
            return this
        }
        val list = storage
        val n = list.size
        val s = jsRelativeIndex(start, n)
        val e = if (end == null) n else jsRelativeIndex(end, n)
        for (i in s until e) list[i] = value
        trigger()
        return this
    }

    // Copies and searches

    @Suppress("UNCHECKED_CAST")
    fun slice(start: Double = 0.0, end: Double? = null): JSArray<T> {
        val d = doubles
        if (d != null) {
            val n = dSize
            val s = jsRelativeIndex(start, n)
            val e = if (end == null) n else jsRelativeIndex(end, n)
            return (if (s < e) ofDoubles(d.copyOfRange(s, e), e - s) else ofDoubles(DoubleArray(0), 0)) as JSArray<T>
        }
        track()
        val list = storage
        val n = list.size
        val s = jsRelativeIndex(start, n)
        val e = if (end == null) n else jsRelativeIndex(end, n)
        return if (s < e) JSArray(ArrayList(list.subList(s, e))) else JSArray()
    }

    /** `array.concat(...items)`: an item that is an array adds its elements. */
    @Suppress("UNCHECKED_CAST")
    fun concatSpread(items: List<T>): JSArray<T> {
        val out = ArrayList(elements)
        for (item in items) if (item is JSArray<*>) out.addAll(item.elements as List<T>) else out.add(item)
        return JSArray(out)
    }

    fun concat(vararg parts: JSArray<T>): JSArray<T> {
        val out = ArrayList(elements)
        for (p in parts) out.addAll(p.elements)
        return JSArray(out)
    }

    fun toReversed(): JSArray<T> = JSArray(ArrayList(elements.reversed()))
    fun toSorted(): JSArray<T> = JSArray(ArrayList(elements)).sort()
    fun toSorted(compare: ((T, T) -> Double)?): JSArray<T> = JSArray(ArrayList(elements)).sort(compare)

    fun indexOf(value: Any?, fromIndex: Double = 0.0): Double {
        val n = size
        for (i in jsRelativeIndex(fromIndex, n) until n) if (jsStrictEquals(storage[i], value)) return i.toDouble()
        return -1.0
    }

    fun lastIndexOf(value: Any?, fromIndex: Double? = null): Double {
        val n = size
        var i = if (fromIndex == null) n - 1 else { val k = jsToIntegerOrInfinity(fromIndex); if (k < 0) (n + k).clampToInt() else minOf(k, (n - 1).toDouble()).toInt() }
        while (i >= 0) { if (jsStrictEquals(storage[i], value)) return i.toDouble(); i-- }
        return -1.0
    }

    fun includes(value: Any?, fromIndex: Double = 0.0): Boolean {
        val n = size
        for (i in jsRelativeIndex(fromIndex, n) until n) if (jsSameValueZero(storage[i], value)) return true
        return false
    }

    // Callbacks see the length the array had when the call started, and current elements. Each arity has its own
    // loop: a wrapper around a shorter callback would box every index.

    fun find(f: (T) -> Boolean): T? {
        for (i in 0 until size) { val v = read(i); if (f(v)) return v }
        return null
    }

    fun find(f: (T, Double) -> Boolean): T? {
        for (i in 0 until size) { val v = read(i); if (f(v, i.toDouble())) return v }
        return null
    }

    fun find(f: (T, Double, JSArray<T>) -> Boolean): T? {
        for (i in 0 until size) { val v = read(i); if (f(v, i.toDouble(), this)) return v }
        return null
    }

    fun findIndex(f: (T) -> Boolean): Double {
        for (i in 0 until size) if (f(read(i))) return i.toDouble()
        return -1.0
    }

    fun findIndex(f: (T, Double) -> Boolean): Double {
        for (i in 0 until size) if (f(read(i), i.toDouble())) return i.toDouble()
        return -1.0
    }

    fun findIndex(f: (T, Double, JSArray<T>) -> Boolean): Double {
        for (i in 0 until size) if (f(read(i), i.toDouble(), this)) return i.toDouble()
        return -1.0
    }

    fun findLast(f: (T) -> Boolean): T? {
        for (i in size - 1 downTo 0) { val v = read(i); if (f(v)) return v }
        return null
    }

    fun findLast(f: (T, Double) -> Boolean): T? {
        for (i in size - 1 downTo 0) { val v = read(i); if (f(v, i.toDouble())) return v }
        return null
    }

    fun findLastIndex(f: (T) -> Boolean): Double {
        for (i in size - 1 downTo 0) if (f(read(i))) return i.toDouble()
        return -1.0
    }

    fun findLastIndex(f: (T, Double) -> Boolean): Double {
        for (i in size - 1 downTo 0) if (f(read(i), i.toDouble())) return i.toDouble()
        return -1.0
    }

    fun some(f: (T) -> Boolean): Boolean {
        val n = size
        for (i in 0 until minOf(n, storage.size)) if (f(read(i))) return true
        return false
    }

    fun some(f: (T, Double) -> Boolean): Boolean {
        val n = size
        for (i in 0 until minOf(n, storage.size)) if (f(read(i), i.toDouble())) return true
        return false
    }

    fun some(f: (T, Double, JSArray<T>) -> Boolean): Boolean {
        val n = size
        for (i in 0 until minOf(n, storage.size)) if (f(read(i), i.toDouble(), this)) return true
        return false
    }

    fun every(f: (T) -> Boolean): Boolean {
        val n = size
        for (i in 0 until minOf(n, storage.size)) if (!f(read(i))) return false
        return true
    }

    fun every(f: (T, Double) -> Boolean): Boolean {
        val n = size
        for (i in 0 until minOf(n, storage.size)) if (!f(read(i), i.toDouble())) return false
        return true
    }

    fun every(f: (T, Double, JSArray<T>) -> Boolean): Boolean {
        val n = size
        for (i in 0 until minOf(n, storage.size)) if (!f(read(i), i.toDouble(), this)) return false
        return true
    }

    inline fun forEach(f: (T) -> Unit) {
        val list = storage
        val n = size
        var i = 0
        if (jsTracker == null) {
            while (i < n && i < list.size) { f(list[i]); i++ }
        } else {
            while (i < n && i < list.size) { f(read(i)); i++ }
        }
    }

    inline fun forEach(f: (T, Double) -> Unit) {
        val list = storage
        val n = size
        var i = 0
        if (jsTracker == null) {
            while (i < n && i < list.size) { f(list[i], i.toDouble()); i++ }
        } else {
            while (i < n && i < list.size) { f(read(i), i.toDouble()); i++ }
        }
    }

    fun forEach(f: (T, Double, JSArray<T>) -> Unit) {
        val list = storage
        val n = size
        var i = 0
        while (i < n && i < list.size) { f(read(i), i.toDouble(), this); i++ }
    }

    inline fun <U> map(f: (T) -> U): JSArray<U> {
        val list = storage
        val n = size
        val out = ArrayList<U>(n)
        var i = 0
        if (jsTracker == null) {
            while (i < n && i < list.size) { out.add(f(list[i])); i++ }
        } else {
            while (i < n && i < list.size) { out.add(f(read(i))); i++ }
        }
        return JSArray(out)
    }

    inline fun <U> map(f: (T, Double) -> U): JSArray<U> {
        val list = storage
        val n = size
        val out = ArrayList<U>(n)
        var i = 0
        if (jsTracker == null) {
            while (i < n && i < list.size) { out.add(f(list[i], i.toDouble())); i++ }
        } else {
            while (i < n && i < list.size) { out.add(f(read(i), i.toDouble())); i++ }
        }
        return JSArray(out)
    }

    fun <U> map(f: (T, Double, JSArray<T>) -> U): JSArray<U> {
        val list = storage
        val n = size
        val out = ArrayList<U>(n)
        var i = 0
        while (i < n && i < list.size) { out.add(f(read(i), i.toDouble(), this)); i++ }
        return JSArray(out)
    }

    inline fun filter(f: (T) -> Boolean): JSArray<T> {
        val list = storage
        val n = size
        val out = ArrayList<T>()
        var i = 0
        if (jsTracker == null) {
            while (i < n && i < list.size) { val v = list[i]; if (f(v)) out.add(v); i++ }
        } else {
            while (i < n && i < list.size) { val v = read(i); if (f(v)) out.add(v); i++ }
        }
        return JSArray(out)
    }

    inline fun filter(f: (T, Double) -> Boolean): JSArray<T> {
        val list = storage
        val n = size
        val out = ArrayList<T>()
        var i = 0
        if (jsTracker == null) {
            while (i < n && i < list.size) { val v = list[i]; if (f(v, i.toDouble())) out.add(v); i++ }
        } else {
            while (i < n && i < list.size) { val v = read(i); if (f(v, i.toDouble())) out.add(v); i++ }
        }
        return JSArray(out)
    }

    fun filter(f: (T, Double, JSArray<T>) -> Boolean): JSArray<T> {
        val n = size
        val out = ArrayList<T>()
        var i = 0
        while (i < n && i < storage.size) { val v = read(i); if (f(v, i.toDouble(), this)) out.add(v); i++ }
        return JSArray(out)
    }

    fun <U> flatMap(f: (T) -> JSArray<U>): JSArray<U> {
        val out = ArrayList<U>()
        val n = size
        var i = 0
        while (i < n && i < storage.size) { out.addAll(f(read(i)).storage); i++ }
        return JSArray(out)
    }

    fun <U> flatMap(f: (T, Double) -> JSArray<U>): JSArray<U> {
        val out = ArrayList<U>()
        val n = size
        var i = 0
        while (i < n && i < storage.size) { out.addAll(f(read(i), i.toDouble()).storage); i++ }
        return JSArray(out)
    }

    inline fun <U> reduce(f: (U, T) -> U, initial: U): U {
        var acc = initial
        val list = storage
        val n = size
        var i = 0
        if (jsTracker == null) {
            while (i < n && i < list.size) { acc = f(acc, list[i]); i++ }
        } else {
            while (i < n && i < list.size) { acc = f(acc, read(i)); i++ }
        }
        return acc
    }

    fun <U> reduce(f: (U, T, Double) -> U, initial: U): U {
        var acc = initial
        val n = size
        var i = 0
        while (i < n && i < storage.size) { acc = f(acc, read(i), i.toDouble()); i++ }
        return acc
    }

    fun <U> reduce(f: (U, T, Double, JSArray<T>) -> U, initial: U): U {
        var acc = initial
        val n = size
        var i = 0
        while (i < n && i < storage.size) { acc = f(acc, read(i), i.toDouble(), this); i++ }
        return acc
    }

    private fun emptyReduce(): Nothing = throw JSException(JSTypeError("Reduce of empty array with no initial value"))

    fun reduce(f: (T, T) -> T): T {
        if (size == 0) emptyReduce()
        var acc = read(0)
        for (i in 1 until size) acc = f(acc, read(i))
        return acc
    }

    fun reduce(f: (T, T, Double, JSArray<T>) -> T): T {
        if (size == 0) emptyReduce()
        var acc = read(0)
        for (i in 1 until size) acc = f(acc, read(i), i.toDouble(), this)
        return acc
    }

    fun reduce(f: (T, T, Double) -> T): T {
        if (size == 0) emptyReduce()
        var acc = read(0)
        for (i in 1 until size) acc = f(acc, read(i), i.toDouble())
        return acc
    }

    fun <U> reduceRight(f: (U, T) -> U, initial: U): U {
        var acc = initial
        for (i in size - 1 downTo 0) acc = f(acc, read(i))
        return acc
    }

    fun <U> reduceRight(f: (U, T, Double) -> U, initial: U): U {
        var acc = initial
        for (i in size - 1 downTo 0) acc = f(acc, read(i), i.toDouble())
        return acc
    }

    fun <U> reduceRight(f: (U, T, Double, JSArray<T>) -> U, initial: U): U {
        var acc = initial
        for (i in size - 1 downTo 0) acc = f(acc, read(i), i.toDouble(), this)
        return acc
    }

    fun reduceRight(f: (T, T) -> T): T {
        if (size == 0) emptyReduce()
        var acc = read(size - 1)
        for (i in size - 2 downTo 0) acc = f(acc, read(i))
        return acc
    }

    fun reduceRight(f: (T, T, Double, JSArray<T>) -> T): T {
        if (size == 0) emptyReduce()
        var acc = read(size - 1)
        for (i in size - 2 downTo 0) acc = f(acc, read(i), i.toDouble(), this)
        return acc
    }

    fun reduceRight(f: (T, T, Double) -> T): T {
        if (size == 0) emptyReduce()
        var acc = read(size - 1)
        for (i in size - 2 downTo 0) acc = f(acc, read(i), i.toDouble())
        return acc
    }

    fun join(separator: String? = ","): String { track(); return jsJoin(storage, separator ?: ",", this) }

    /** `array.flat(depth)` over untyped elements. */
    fun flatAny(depth: Double = 1.0): JSArray<Any?> {
        val out = ArrayList<Any?>()
        fun add(list: List<Any?>, d: Double) {
            for (v in list) if (v is JSArray<*> && d >= 1) add(v.storage, d - 1) else out.add(v)
        }
        add(elements, depth)
        return JSArray(out)
    }

    override fun jsMakeReactive() {
        val d = doubles
        if (d != null) materializeDoubles(d)
        if (jsTracker == null) jsTracker = JSTracker()
    }

    override fun toString(): String = jsInspect(this)

    companion object {
        @Suppress("UNCHECKED_CAST")
        @PublishedApi internal fun ofDoubles(data: DoubleArray, count: Int): JSArray<Double> {
            val a = JSArray<Double>(EMPTY_ARRAY_STORAGE as ArrayList<Double>)
            a._storage = null
            a.doubles = data
            a.dSize = count
            return a
        }

        fun doubles(): JSArray<Double> = ofDoubles(DoubleArray(0), 0)
        fun doublesOf(vararg items: Double): JSArray<Double> = ofDoubles(items, items.size)
        fun doublesFilled(length: Double, value: Double): JSArray<Double> {
            val n = length.toInt()
            val data = DoubleArray(n)
            if (value != 0.0) java.util.Arrays.fill(data, value)
            return ofDoubles(data, n)
        }

        fun <T> of(vararg items: T): JSArray<T> = JSArray(items.toList())
        fun <T> from(items: Iterable<T>): JSArray<T> = JSArray(ArrayList(items.toList()))
        fun <T> from(items: Iterable<T>, f: (T, Double) -> T): JSArray<T> = JSArray(ArrayList(items.mapIndexed { i, v -> f(v, i.toDouble()) }))
        fun <T> fromLength(length: Double, f: (Double) -> T): JSArray<T> = JSArray(ArrayList((0 until jsToIntegerOrInfinity(length).clampToInt()).map { f(it.toDouble()) }))
        fun isArray(value: Any?): Boolean = value is JSArray<*>
    }
}

/** Unboxed numeric element read (`a[i]` as `Double`): `NaN` past the end, matching `(element(i) ?: Double.NaN)`. */
fun JSArray<Double>.numberAt(i: Double): Double {
    val d = doubles
    val k = i.toInt()
    if (d != null && k >= 0 && k < dSize && k.toDouble() == i) return d[k]
    return element(i) ?: Double.NaN
}

/** Unboxed numeric element write (`a[i] = v`). */
fun JSArray<Double>.setDouble(i: Double, value: Double) {
    val d = doubles
    val k = i.toInt()
    if (d != null && k >= 0 && k.toDouble() == i) {
        if (k < dSize) { d[k] = value; return }
        if (k == dSize) { appendDouble(value); return }
    }
    set(i, value)
}

/** Unboxed numeric compound addition (`a[i] += delta`). */
fun JSArray<Double>.addDoubleAt(i: Double, delta: Double) {
    val d = doubles
    val k = i.toInt()
    if (d != null && k >= 0 && k < dSize && k.toDouble() == i) {
        d[k] += delta
        return
    }
    set(i, (element(i) ?: Double.NaN) + delta)
}

/** Unboxed single-element push onto a numeric array. */
fun JSArray<Double>.pushDouble(value: Double): Double {
    if (doubles != null) {
        appendDouble(value)
        return dSize.toDouble()
    }
    return push(value)
}

/** Unboxed `number[].map((x) => ...): number[]`. */
inline fun JSArray<Double>.mapDouble(f: (Double) -> Double): JSArray<Double> {
    val d = doubles
    if (d != null) {
        val n = dSize
        val out = DoubleArray(n)
        var i = 0
        while (i < n && i < dSize) { out[i] = f(d[i]); i++ }
        return JSArray.ofDoubles(out, i)
    }
    val list = storage
    val n = size
    val out = DoubleArray(n)
    var i = 0
    if (jsTracker == null) {
        while (i < n && i < list.size) { out[i] = f(list[i]); i++ }
    } else {
        while (i < n && i < list.size) { out[i] = f(read(i)); i++ }
    }
    return JSArray.ofDoubles(out, i)
}

/** Unboxed `number[].filter((x) => ...): number[]`. */
inline fun JSArray<Double>.filterDouble(f: (Double) -> Boolean): JSArray<Double> {
    val d = doubles
    if (d != null) {
        val n = dSize
        var out = DoubleArray(if (n > 16) n ushr 1 else n)
        var count = 0
        var i = 0
        while (i < n && i < dSize) {
            val v = d[i]
            if (f(v)) {
                if (count == out.size) out = out.copyOf(if (count == 0) 8 else count shl 1)
                out[count++] = v
            }
            i++
        }
        return JSArray.ofDoubles(out, count)
    }
    val list = storage
    val n = size
    var out = DoubleArray(if (n > 16) n ushr 1 else n)
    var count = 0
    var i = 0
    if (jsTracker == null) {
        while (i < n && i < list.size) {
            val v = list[i]
            if (f(v)) {
                if (count == out.size) out = out.copyOf(if (count == 0) 8 else count shl 1)
                out[count++] = v
            }
            i++
        }
    } else {
        while (i < n && i < list.size) {
            val v = read(i)
            if (f(v)) {
                if (count == out.size) out = out.copyOf(if (count == 0) 8 else count shl 1)
                out[count++] = v
            }
            i++
        }
    }
    return JSArray.ofDoubles(out, count)
}

/** Unboxed `number[].reduce((a, b) => ..., initial): number`. */
inline fun JSArray<Double>.reduceDouble(f: (Double, Double) -> Double, initial: Double): Double {
    var acc = initial
    val d = doubles
    if (d != null) {
        val n = dSize
        var i = 0
        while (i < n && i < dSize) { acc = f(acc, d[i]); i++ }
        return acc
    }
    val list = storage
    val n = size
    var i = 0
    if (jsTracker == null) {
        while (i < n && i < list.size) { acc = f(acc, list[i]); i++ }
    } else {
        while (i < n && i < list.size) { acc = f(acc, read(i)); i++ }
    }
    return acc
}

/** Unboxed in-place stable merge sort for `number[].sort((a, b) => ...)`. */
inline fun JSArray<Double>.sortDouble(compare: (Double, Double) -> Double): JSArray<Double> {
    val d = doubles
    if (d != null) {
        val n = dSize
        if (n >= 2) {
            var src: DoubleArray = d
            var dst = DoubleArray(n)
            var width = 1
            while (width < n) {
                var lo = 0
                while (lo < n) {
                    val mid = minOf(lo + width, n)
                    val hi = minOf(lo + 2 * width, n)
                    if (mid >= hi || !(compare(src[mid], src[mid - 1]) < 0.0)) {
                        System.arraycopy(src, lo, dst, lo, hi - lo)
                    } else {
                        var i = lo
                        var j = mid
                        var k = lo
                        while (i < mid && j < hi) {
                            if (compare(src[j], src[i]) < 0.0) dst[k++] = src[j++] else dst[k++] = src[i++]
                        }
                        while (i < mid) dst[k++] = src[i++]
                        while (j < hi) dst[k++] = src[j++]
                    }
                    lo += 2 * width
                }
                val t = src
                src = dst
                dst = t
                width *= 2
            }
            if (src !== d) System.arraycopy(src, 0, d, 0, n)
        }
        return this
    }
    val list = storage
    val n = list.size
    val values = arrayOfNulls<Any?>(n)
    var undefineds: ArrayList<Double>? = null
    var defined = 0
    for (e in list) {
        if (e == null) (undefineds ?: ArrayList<Double>().also { undefineds = it }).add(e)
        else values[defined++] = e
    }
    if (defined >= 2) {
        var src = values
        var dst = arrayOfNulls<Any?>(defined)
        var width = 1
        while (width < defined) {
            var lo = 0
            while (lo < defined) {
                val mid = minOf(lo + width, defined)
                val hi = minOf(lo + 2 * width, defined)
                if (mid >= hi || !(compare(src[mid] as Double, src[mid - 1] as Double) < 0.0)) {
                    System.arraycopy(src, lo, dst, lo, hi - lo)
                } else {
                    var i = lo
                    var j = mid
                    var k = lo
                    while (i < mid && j < hi) {
                        if (compare(src[j] as Double, src[i] as Double) < 0.0) dst[k++] = src[j++] else dst[k++] = src[i++]
                    }
                    while (i < mid) dst[k++] = src[i++]
                    while (j < hi) dst[k++] = src[j++]
                }
                lo += 2 * width
            }
            val t = src
            src = dst
            dst = t
            width *= 2
        }
        if (src !== values) System.arraycopy(src, 0, values, 0, defined)
    }
    val out = ArrayList<Double>(n)
    for (k in 0 until defined) out.add(values[k] as Double)
    if (undefineds != null) out.addAll(undefineds)
    _storage = out
    doubles = null
    dSize = 0
    jsTracker?.trigger()
    return this
}

/** `[a, b, c]`. */
fun <T> jsArrayOf(vararg items: T): JSArray<T> = JSArray(items.toList())

/** `[[1, 2], [3]].flat()`. */
fun <U> JSArray<JSArray<U>>.flat(): JSArray<U> {
    val out = ArrayList<U>()
    for (inner in elements) out.addAll(inner.elements)
    return JSArray(out)
}

/** `new Array<T>(n).fill(v)`. */
fun <T> jsArrayFilled(length: Double, value: T): JSArray<T> {
    val n = length.toInt()
    val storage = ArrayList<T>(n)
    for (k in 0 until n) storage.add(value)
    return JSArray(storage)
}

/** An untyped value read as an array whose elements convert with `element`. */
@Suppress("UNCHECKED_CAST")
fun <T> jsArrayFrom(value: Any?, element: (Any?) -> T): JSArray<T> {
    // A Java array (`Array.create(…)`): its elements, copied.
    if (value != null && value.javaClass.isArray) return JSArray(ArrayList((0 until java.lang.reflect.Array.getLength(value)).map { element(fromJavaValue(java.lang.reflect.Array.get(value, it))) }))
    if (value !is JSArray<*>) return JSArray()
    val mapped = value.storage.map(element)
    // Elements that are already of the type: the same array, so what is written through either is in both.
    // A number or string converted to itself comes back in a new box.
    if (mapped.indices.all { val m = mapped[it]; val v = value.storage[it]; m === v || ((m is Double || m is String) && m == v) }) return value as JSArray<T>
    return JSArray(ArrayList(mapped))
}

internal fun Double.clampToInt(): Int = when {
    this.isNaN() -> 0
    this > Int.MAX_VALUE -> Int.MAX_VALUE
    this < Int.MIN_VALUE -> Int.MIN_VALUE
    else -> this.toInt()
}

/** ToIntegerOrInfinity. */
fun jsToIntegerOrInfinity(value: Double): Double = when {
    value.isNaN() -> 0.0
    value.isInfinite() -> value
    else -> if (value < 0) Math.ceil(value) + 0.0 else Math.floor(value)
}

/** A relative index (`slice`, `splice`, `fill`): negative counts from the end; clamped to 0…length. */
internal fun jsRelativeIndex(value: Double, length: Int): Int {
    val k = jsToIntegerOrInfinity(value)
    return if (k < 0) maxOf(0.0, length + k).toInt() else minOf(k, length.toDouble()).toInt()
}

/** A stable merge sort tolerating inconsistent comparators, as Array.prototype.sort must. */
@Suppress("UNCHECKED_CAST")
internal fun <E> jsMergeSort(items: MutableList<E>, less: (E, E) -> Boolean) {
    val n = items.size
    if (n < 2) return
    val values = arrayOfNulls<Any?>(n)
    for (i in 0 until n) values[i] = items[i]
    stableSort(values, n) { a, b -> less(a as E, b as E) }
    for (i in 0 until n) items[i] = values[i] as E
}

/**
 * Sorts `items[0, n)` stably with `less`, tolerating inconsistent comparators: bottom-up merges between two
 * arrays. Two runs already in order are copied after one comparison, so sorted input takes about n of them.
 */
internal inline fun stableSort(items: Array<Any?>, n: Int, less: (Any?, Any?) -> Boolean) {
    if (n < 2) return
    var src = items
    var dst = arrayOfNulls<Any?>(n)
    var width = 1
    while (width < n) {
        var lo = 0
        while (lo < n) {
            val mid = minOf(lo + width, n)
            val hi = minOf(lo + 2 * width, n)
            if (mid >= hi || !less(src[mid], src[mid - 1])) {
                System.arraycopy(src, lo, dst, lo, hi - lo)
            } else {
                var i = lo
                var j = mid
                var k = lo
                while (i < mid && j < hi) {
                    if (less(src[j], src[i])) dst[k++] = src[j++] else dst[k++] = src[i++]
                }
                while (i < mid) dst[k++] = src[i++]
                while (j < hi) dst[k++] = src[j++]
            }
            lo += 2 * width
        }
        val t = src
        src = dst
        dst = t
        width *= 2
    }
    if (src !== items) System.arraycopy(src, 0, items, 0, n)
}

/** `Array(...items)`: one number is a length, anything else the elements. */
fun jsArrayConstruct(items: List<Any?>): JSArray<Any?> {
    val length = items.singleOrNull() as? Double ?: return JSArray(ArrayList(items))
    if (length < 0 || length > 4_294_967_295.0 || length != Math.floor(length)) throw JSException(JSRangeError("Invalid array length"))
    return JSArray(ArrayList<Any?>(List(length.toInt()) { null }))
}

/** What a template's `@for` renders: the array's elements, none where it is missing (`row?.children`). */
val <T> JSArray<T>?.forItems: List<T> get() = this?.elements ?: emptyList()

/** An untyped `@for` source: its elements as `Array.from` reads them, none where it is missing. */
@get:JvmName("untypedForItems")
val Any?.forItems: List<Any?> get() = if (jsIsNullish(this)) emptyList() else jsArrayFrom(this) { it }.elements
