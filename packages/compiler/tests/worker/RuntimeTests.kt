package workertest

import org.nativescript.kit.*
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicInteger

// The runtime's shared state under threads (a worker's and the main one) and its weak tables under the GC.

private var failures = 0

private fun check(name: String, ok: Boolean, detail: () -> String = { "" }) {
    if (ok) println("✓ $name") else { failures++; println("✗ $name ${detail()}") }
}

private fun gcHard() = repeat(5) { System.gc(); System.runFinalization(); Thread.sleep(40) }

private fun field(target: Any, name: String): Any? {
    var c: Class<*>? = target.javaClass
    while (c != null) {
        c.declaredFields.firstOrNull { it.name == name }?.let { it.isAccessible = true; return it.get(target) }
        c = c.superclass
    }
    error("no field $name on ${target.javaClass}")
}

private fun buckets(table: Any): Int = (field(table, "buckets") as Map<*, *>).size

private fun onThreads(n: Int, body: (Int) -> Unit): List<Throwable> {
    val errors = java.util.Collections.synchronizedList(ArrayList<Throwable>())
    val threads = (0 until n).map { i -> Thread { try { body(i) } catch (e: Throwable) { errors.add(e) } } }
    threads.forEach { it.start() }
    threads.forEach { it.join() }
    return errors
}

private class Holder(val held: Any)

private fun joins() {
    val wrong = AtomicInteger()
    val errors = onThreads(2) { i ->
        val list = jsArrayOf<Any?>(i.toDouble(), "x", jsArrayOf<Any?>(1.0, 2.0))
        val want = "$i,x,1,2"
        repeat(200_000) { if (jsToString(list) != want) wrong.incrementAndGet() }
    }
    check("threads: arrays join on two threads at once", wrong.get() == 0 && errors.isEmpty()) { "wrong ${wrong.get()}, errors ${errors.take(2)}" }
    check("threads: an array still joins afterwards", jsToString(jsArrayOf<Any?>(1.0, 2.0)) == "1,2")
}

private fun symbolRef(): WeakReference<Any> = WeakReference(JSSymbol("dropped"))

private fun withExpando(): WeakReference<Any> {
    val key = Any()
    jsJavaSet(key, "flag", true)
    return WeakReference(key)
}

private fun symbols() {
    val made = java.util.concurrent.ConcurrentLinkedQueue<JSSymbol>()
    val errors = onThreads(4) { repeat(5_000) { made.add(JSSymbol("s")) } }
    val keys = made.map { it.key }.toSet()
    check("threads: symbols made on four threads have distinct keys", errors.isEmpty() && keys.size == made.size) { "${keys.size} keys for ${made.size} symbols" }
    check("threads: each symbol is found by its key", made.all { JSSymbol.of(it.key) === it })
    val ref = symbolRef()
    gcHard()
    check("memory: a symbol nothing holds is collected", ref.get() == null)
}

private class Shared
private open class ProtoRaceBase
private class ProtoRaceSub : ProtoRaceBase()
private open class ProtoChainBase
private class ProtoChainSub : ProtoChainBase()
private class ProtoDedup

private fun prototypes() {
    val seen = java.util.concurrent.ConcurrentLinkedQueue<Any>()
    val errors = onThreads(4) { repeat(1_000) { seen.add(JSPrototypes.of(Shared::class.java)) } }
    check("threads: one prototype per class across threads", errors.isEmpty() && seen.all { it === seen.first() })

    val startRace = java.util.concurrent.CyclicBarrier(4)
    val raceErrors = onThreads(4) { i ->
        startRace.await()
        repeat(500) {
            if (i % 2 == 0) JSPrototypes.declare(ProtoRaceBase::class.java, "v", { 7.0 }, null)
            else JSPrototypes.of(ProtoRaceBase::class.java)
        }
    }
    check("threads: concurrent declare and of preserves accessor", raceErrors.isEmpty() && JSPrototypes.holder(ProtoRaceSub::class.java, "v") != null) { "errors ${raceErrors.take(2)}" }

    JSPrototypes.declare(ProtoChainBase::class.java, "tag", { "ok" }, null)
    val startChain = java.util.concurrent.CyclicBarrier(4)
    val chainErrors = onThreads(4) { i ->
        startChain.await()
        repeat(1_000) {
            if (i == 0) JSPrototypes.of(ProtoChainBase::class.java)
            else JSPrototypes.holder(ProtoChainSub::class.java, "tag")
        }
    }
    check("threads: concurrent of and holder never caches empty chain", chainErrors.isEmpty() && JSPrototypes.holder(ProtoChainSub::class.java, "tag") != null) { "errors ${chainErrors.take(2)}" }

    repeat(50) { JSPrototypes.declare(ProtoDedup::class.java, "x", { 1.0 }, null) }
    val declared = JSPrototypes::class.java.getDeclaredField("declared").apply { isAccessible = true }.get(JSPrototypes) as Map<*, *>
    val count = (declared[ProtoDedup::class.java] as List<*>).size
    check("prototypes: repeated declare deduplicates by key", count == 1) { "got $count entries" }
}

private fun keyIndex() {
    var lateKey = "undefined"
    val idx = JSKeyIndex(3) { i -> when (i) { 0 -> "\u0000@@1"; 1 -> "\u0000@@2"; 2 -> lateKey; else -> "" } }
    check("keyIndex: unresolved undefined key does not poison index", idx.of("\u0000@@1") == 0 && idx.of("\u0000@@3") == -1)
    lateKey = "\u0000@@3"
    check("keyIndex: resolves key once populated", idx.of("\u0000@@3") == 2 && idx.of("\u0000@@2") == 1)
}

private fun expandos() {
    val a = ArrayList<Any>()
    jsJavaSet(a, "flag", true)
    check("expandos: kept by identity, not by equals", jsJavaGet(ArrayList<Any>(), "flag") == null && jsJavaGet(a, "flag") == true)
    a.add(1)
    check("expandos: kept when the key's hash changes", jsJavaGet(a, "flag") == true)
    val ref = withExpando()
    gcHard()
    check("memory: an expando goes with its object", ref.get() == null)
    val host = jsJavaExpandoHost
    // As an Android host keeps a view's expandos in a view tag.
    jsJavaExpandoHost = { target, create -> if (target !is TaggedView) null else target.tag ?: if (create) JSObject().also { target.tag = it } else null }
    try {
        val viewRef = taggedView()
        gcHard()
        check("memory: an object its expando's value reaches goes when the host keeps the expando", viewRef.get() == null)
    } finally {
        jsJavaExpandoHost = host
    }
}

/** In a frame of its own: the view is unreachable once it returns. */
private fun taggedView(): WeakReference<Any> {
    val view = TaggedView()
    jsJavaSet(view, "navigation", Holder(view))
    check("expandos: the host's store is read back", (jsJavaGet(view, "navigation") as? Holder)?.held === view)
    return WeakReference(view)
}

private class TaggedView { var tag: JSObject? = null }

/** In a frame of its own: the key is unreachable once it returns. */
private fun ephemeron(map: JSWeakMap<Any, Any>): WeakReference<Any> {
    val key = JSObject()
    map.set(key, Holder(key))
    check("weak map: a plain object's entry reads back", (map.get(key) as? Holder)?.held === key && map.has(key))
    return WeakReference(key)
}

private fun weakMaps() {
    val ref = ephemeron(JSWeakMap())
    gcHard()
    check("memory: a plain-object key whose value reaches it is collected", ref.get() == null)

    val growth = JSWeakMap<Any, Any>()
    repeat(200_000) { growth.set(Any(), 1.0) }
    gcHard()
    repeat(64) { growth.set(Any(), 1.0) }
    val table = field(growth, "table")!!
    check("memory: a weak map's table shrinks once its keys are collected", buckets(table) < 1_000) { "${buckets(table)} buckets" }

    val other = JSWeakMap<Any, Any>()
    val shared = JSObject()
    growth.set(shared, "a")
    other.set(shared, "b")
    check("weak map: two maps keep their own values for one key", growth.get(shared) == "a" && other.get(shared) == "b")
    check("weak map: delete removes only that map's entry", other.delete(shared) && !other.has(shared) && growth.get(shared) == "a")
}

private fun restrictions() {
    repeat(100_000) { jsFreeze(Any()) }
    gcHard()
    val kept = Any()
    jsFreeze(kept)
    val table = Class.forName("org.nativescript.kit.LanguageKt").getDeclaredField("restricted").apply { isAccessible = true }.get(null)
    check("memory: the freeze table shrinks once its objects are collected", buckets(table) < 1_000) { "${buckets(table)} buckets" }
    check("restrictions: a frozen object stays frozen", jsIsFrozen(kept) && !jsIsFrozen(Any()))
}

private fun cursors() {
    val map = JSMap<Any?, Any?>()
    map.set("a", 1.0)
    map.set("b", 2.0)
    var n = 0
    repeat(10_000) { for (e in map) n++ }
    val list = field(field(map, "table")!!, "cursors") as List<*>
    check("memory: finished map iterations leave no cursors behind", list.size <= 1 && n == 20_000) { "${list.size} cursors" }
}

fun main() {
    joins()
    symbols()
    prototypes()
    keyIndex()
    expandos()
    weakMaps()
    restrictions()
    cursors()
    println(if (failures == 0) "runtime checks pass" else "runtime checks: $failures failed")
    kotlin.system.exitProcess(if (failures == 0) 0 else 1)
}
