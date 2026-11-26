package org.nativescript.kit

// Fine-grained reactivity, the model the compiled frameworks' signals, refs and
// runes share: a read inside an effect subscribes it, a write re-runs exactly
// the effects that read the value. Compiled templates bind each native
// property through one effect, so nothing is diffed.
// Main thread only; effects re-run on the app's framework's schedule (`Reactivity`).

/** A scope that owns effects and cleanups: a component instance, a branch of an `if`, a row of a `for`. */
class Owner(parent: Owner? = current) {
    internal val effects = mutableListOf<Effect>()
    private val children = mutableListOf<Owner>()
    private val cleanups = mutableListOf<() -> Unit>()
    private var disposed = false

    init {
        parent?.children?.add(this)
    }

    /** Runs `body` with this owner current: effects it creates belong here. */
    fun <T> run(body: () -> T): T {
        val previous = current
        current = this
        try {
            return body()
        } finally {
            current = previous
        }
    }

    fun onCleanup(cleanup: () -> Unit) {
        cleanups.add(cleanup)
    }

    fun dispose() {
        if (disposed) return
        disposed = true
        for (child in children) child.dispose()
        for (effect in effects) effect.dispose()
        for (cleanup in cleanups.asReversed()) cleanup()
        children.clear(); effects.clear(); cleanups.clear()
    }

    companion object {
        var current: Owner? = null
            private set
    }
}

interface Subscriber {
    fun invalidate()
}

interface Source {
    fun unsubscribe(subscriber: Subscriber)
}

private var currentEffect: Effect? = null
/** The memo computing now: what it reads becomes its sources, which subscribe no effect. */
private var currentMemo: MemoReader? = null
private var batchDepth = 0
private var eventDepth = 0
private var queue = mutableListOf<Effect>()
/** Derived values whose sources changed: they settle before the bindings re-run. */
private var derivedQueue = mutableListOf<Effect>()
private var flushing = false
private var flushScheduled = false
/** What `nextTick()` returned while an update was scheduled, settled after it. */
private var flushedPromise: JSResolvers<Unit>? = null
/** [Reactivity.Schedule.TASK], in the microtask checkpoint after an update: updates are scheduled in a microtask. */
private var afterUpdate = false
/** Signals whose readers outside an owner see the value they had before the writes. */
private val holding = mutableListOf<Signal<*>>()

/** When the effects a write invalidates re-run: the app's framework's update schedule. */
object Reactivity {
    enum class Schedule {
        /** At once, on each write. */
        NOW,
        /** In a microtask queued by the first write. */
        MICROTASK,
        /**
         * In a zero-delay timer (its `setTimeout` comes before NativeScript's next-frame `requestAnimationFrame`);
         * in a microtask during the checkpoint that follows an update.
         */
        TASK,
        /** When the event being handled returns, otherwise in a microtask. */
        EVENT,
    }

    var schedule = Schedule.NOW

    /** Settles once the scheduled update has run, or now. */
    fun nextTick(): JSPromise<Unit> {
        if (!flushScheduled) return JSPromise.resolve(Unit)
        val flushed = flushedPromise ?: JSPromise.pending<Unit>().second.also { flushedPromise = it }
        return flushed.promise
    }

    /**
     * A view just created (a routed page, a dialog): what building it made pending runs now, so the view is complete
     * before it is shown; effects pending before ([after], from [pending]) wait for the app's update.
     */
    fun detectChanges(after: Set<Effect>) {
        if (flushing) return
        flushing = true
        try {
            while (true) {
                val derived = derivedQueue.filter { it !in after }
                val effects = queue.filter { it !in after }
                if (derived.isEmpty() && effects.isEmpty()) break
                val run = if (derived.isEmpty()) effects else derived
                val ids = java.util.Collections.newSetFromMap(java.util.IdentityHashMap<Effect, Boolean>()).apply { addAll(run) }
                if (derived.isEmpty()) queue.removeAll { it in ids } else derivedQueue.removeAll { it in ids }
                for (effect in run.sortedWith { a, b -> EffectOrder.compare(a.key, b.key) }) effect.runIfStale()
            }
        } finally {
            flushing = false
        }
    }

    /** The effects waiting for the next update. */
    fun pending(): Set<Effect> = java.util.Collections.newSetFromMap(java.util.IdentityHashMap<Effect, Boolean>()).apply {
        addAll(queue)
        addAll(derivedQueue)
    }

    /**
     * Effects invalidated after [after] ([pending]), run at once even while an outer [flush] is running: a recycled
     * list cell's bindings must settle before `itemLoading` returns, including when a list reload fires `itemLoading`
     * synchronously during an update.
     */
    fun flushScoped(after: Set<Effect>) {
        val outerFlushing = flushing
        flushing = true
        try {
            for (pass in 0 until 16) {
                val derived = derivedQueue.filter { it !in after }
                val effects = queue.filter { it !in after }
                if (derived.isEmpty() && effects.isEmpty()) break
                val run = if (derived.isEmpty()) effects else derived
                val ids = java.util.Collections.newSetFromMap(java.util.IdentityHashMap<Effect, Boolean>()).apply { addAll(run) }
                if (derived.isEmpty()) queue.removeAll { it in ids } else derivedQueue.removeAll { it in ids }
                for (effect in run.sortedWith { a, b -> EffectOrder.compare(a.key, b.key) }) effect.runIfStale(allowDefer = false)
            }
        } finally {
            flushing = outerFlushing
        }
    }

    /**
     * Optional framework hook called before a non-deferred effect re-runs on a signal write: returning true leaves
     * its signal subscriptions intact and defers execution to the framework's own view-ordered pass.
     */
    internal var shouldDeferEffect: ((Effect) -> Boolean)? = null

    /** Schedules an update and returns a settled promise, whose reactions follow it. */
    fun tick(): JSPromise<Unit> {
        scheduleFlush()
        return JSPromise.resolve(Unit)
    }

    /**
     * An event handler of a template. On the EVENT schedule the update runs when the handler returns, on TASK one
     * follows every event; handlers read held state (`stateSignal`) as the render that made them saw it until they
     * return.
     */
    fun event(handler: () -> Unit) {
        if (schedule == Schedule.TASK) scheduleFlush()
        eventDepth += 1
        try {
            handler()
        } finally {
            eventDepth -= 1
        }
        if (eventDepth == 0 && schedule != Schedule.TASK) flush()
    }

    /** An update scheduled as a write schedules one, or with [now] run at once. */
    internal fun requestUpdate(now: Boolean = false) {
        if (now) flush() else scheduleFlush()
    }

    /** Effects re-run in an update whether or not what they read changed: a framework re-checking every binding. */
    internal var rerunsUnchanged = false

    /** The framework sites running now ([site]): code the framework itself runs, whose errors it handles ([jsUncaughtHandOff]). */
    internal var sites = 0
        private set

    internal fun site(body: () -> Unit) {
        sites += 1
        try { body() } finally { sites -= 1 }
    }
}

/** Groups writes so each affected effect runs once, after the last write. */
fun batch(body: () -> Unit) {
    batchDepth += 1
    body()
    batchDepth -= 1
    if (batchDepth == 0) flush()
}

private fun scheduleFlush() {
    if (flushScheduled || flushing) return
    when {
        Reactivity.schedule == Reactivity.Schedule.NOW -> flush()
        Reactivity.schedule == Reactivity.Schedule.EVENT && eventDepth > 0 -> {}
        Reactivity.schedule == Reactivity.Schedule.TASK && !afterUpdate -> {
            flushScheduled = true
            jsSetTimeout(::scheduledFlush, 0.0)
        }
        else -> {
            flushScheduled = true
            Microtasks.enqueue(::scheduledFlush)
        }
    }
}

private fun scheduledFlush() {
    flushScheduled = false
    flush()
    if (Reactivity.schedule == Reactivity.Schedule.TASK && !afterUpdate) {
        afterUpdate = true
        Microtasks.enqueue { afterUpdate = false }
    }
    flushedPromise?.let {
        flushedPromise = null
        it.resolve(Unit)
    }
}

private fun flush() {
    if (flushing) return
    flushing = true
    try {
        if (eventDepth == 0 && holding.isNotEmpty()) {
            for (signal in holding) signal.release()
            holding.clear()
        }
        while (queue.isNotEmpty() || derivedQueue.isNotEmpty()) {
            while (derivedQueue.isNotEmpty()) {
                val derived = derivedQueue.sortedWith { a, b -> EffectOrder.compare(a.key, b.key) }
                derivedQueue = mutableListOf()
                for (effect in derived) effect.runIfStale()
            }
            val pending = queue.sortedWith { a, b -> EffectOrder.compare(a.key, b.key) }
            queue = mutableListOf()
            for (effect in pending) effect.runIfStale()
        }
    } finally {
        flushing = false
    }
}

/**
 * The order a framework commits its bindings in, as a key per effect: the
 * effects a write invalidates re-run in key order (lexicographic). An effect
 * takes the next key of the scope it is created in; while it runs, effects it
 * creates (a branch, a row) are keyed under its own key. Compiled templates
 * create their binding effects in their framework's order and open scopes where
 * its order is not the template's: a component after the one that created it
 * ([component]), what a view runs after its own bindings (its embedded views,
 * its child views: the later phases of [Scope.next], which its framework's kit
 * numbers), a deeper template after every shallower one ([deeper]).
 */
object EffectOrder {
    /**
     * [height]: templates under this many control-flow regions, keyed by the one global count ([deeper]). [ambient]:
     * [EffectOrder.ambient] while this scope runs. [context]: the framework's own state for this scope's effects (the
     * view they check), which each effect made in the scope keeps.
     */
    class Scope internal constructor(private val prefix: List<Int>, internal val height: Int? = null, internal val ambient: Any? = EffectOrder.ambient, internal val context: Any? = null) {
        /** Next key for each phase: 0, the scope's own effects; the later ones, as its framework's kit numbers them. */
        private val counters = mutableListOf<Int>()

        internal fun next(phase: Int): List<Int> {
            if (height != null) return listOf(height, ++depthCount)
            while (counters.size <= phase) counters.add(0)
            return prefix + listOf(phase, counters[phase]++)
        }
    }

    /**
     * A framework's value for the code running now (the injector it injects from): each effect and scope keeps the one
     * current as it is made, and it is current again while they run.
     */
    internal var ambient: Any? = null
    var current = Scope(emptyList())
        private set
    private var components = 0
    private var depthCount = 0
    /** Derived values settle in the order they were declared. */
    private var derived = 0

    internal fun key(): List<Int> = current.next(0)

    internal fun derivedKey(): List<Int> = listOf(++derived)

    internal fun compare(a: List<Int>, b: List<Int>): Int {
        for (i in 0 until minOf(a.size, b.size)) if (a[i] != b[i]) return a[i].compareTo(b[i])
        return a.size.compareTo(b.size)
    }

    internal fun <T> run(scope: Scope, body: () -> T): T {
        val previous = current
        val outer = ambient
        current = scope
        ambient = scope.ambient
        try {
            return body()
        } finally {
            current = previous
            ambient = outer
        }
    }

    /** [scope] current again, its ambient with it: a view's update pass, run after its creation pass has left the scope. */
    fun <T> resume(scope: Scope, body: () -> T): T = run(scope, body)

    /** A component: ordered after every component created before it. */
    fun <T> component(body: () -> T): T = run(Scope(listOf(++components)), body)

    /** An independent root (a modal dialog, a routed page): clears the enclosing view context while preserving ambient. */
    fun <T> detached(body: () -> T): T = run(Scope(listOf(++components), null, ambient, null), body)

    /** Control-flow content: one level deeper than the template that holds it. */
    fun <T> deeper(body: () -> T): T = run(Scope(emptyList(), (current.height ?: 0) + 1), body)

    /** A root template whose control flow is ordered by depth ([deeper]). */
    fun <T> depth(body: () -> T): T = if (current.height != null) body() else run(Scope(emptyList(), 0), body)
}

/** Reads without subscribing the running effect. */
fun <T> untrack(body: () -> T): T {
    val previous = currentEffect
    val previousMemo = currentMemo
    currentEffect = null
    currentMemo = null
    try {
        return body()
    } finally {
        currentEffect = previous
        currentMemo = previousMemo
    }
}

/**
 * A list's items as a template binds them (a ListView's `items`), read in an effect: [apply] takes their elements unless
 * they are `Object.is` the items it last took and hold the same elements, as every framework's binding of a list's items
 * sets them (Angular's binding check and its ListView's differ); core's ListView reloads every row each time its items
 * are set. What reading them throws is reported, and nothing is applied.
 */
fun <Item> listItems(read: () -> JSArray<Item>, apply: (List<Item>) -> Unit) {
    var given: Any? = null
    var applied: List<Item>? = null
    Effect {
        val items = try { read() } catch (e: Throwable) { jsReportUncaught(jsCaught(e)); return@Effect }
        val elements = items.elements.toList()
        val previous = applied
        if (previous != null && jsSameValue(items, given) && previous.size == elements.size && previous.indices.all { jsSameValue(previous[it], elements[it]) }) return@Effect
        given = items
        applied = elements
        untrack { apply(elements) }
    }
}

/**
 * A sectioned list's sections and their rows, read in an effect: snapshots both the outer sections and every
 * section's rows so in-place mutations of a section's row array are detected.
 */
fun <Section, Row> listSections(read: () -> JSArray<Section>, rows: (Section) -> List<Row>, apply: (List<Section>, List<List<Row>>) -> Unit) {
    var given: Any? = null
    var applied: List<Section>? = null
    var appliedRows: List<List<Row>>? = null
    Effect {
        val sections = try { read() } catch (e: Throwable) { jsReportUncaught(jsCaught(e)); return@Effect }
        val elements = sections.elements.toList()
        val sectionRows = elements.map { rows(it).toList() }
        val previous = applied
        val prevRows = appliedRows
        if (previous != null && prevRows != null && jsSameValue(sections, given) &&
            previous.size == elements.size &&
            previous.indices.all { jsSameValue(previous[it], elements[it]) } &&
            prevRows.indices.all { i ->
                val a = prevRows[i]; val b = sectionRows[i]
                a.size == b.size && a.indices.all { j -> jsSameValue(a[j], b[j]) }
            }) return@Effect
        given = sections
        applied = elements
        appliedRows = sectionRows
        untrack { apply(elements, sectionRows) }
    }
}

/**
 * Where a list's rows are made: the owner and effect scope current where the list is bound. A native list loads its rows
 * later, outside that code; [render] makes one in a new owner under the list's and in the list's scope, so the row's
 * effects order, refresh and end with the template declaring it (a framework's row view is a child of that template's).
 * What [body] throws disposes the row's owner and is rethrown.
 */
class RowScope {
    private val owner = Owner.current
    private val scope = EffectOrder.current

    fun <T> render(body: () -> T): T {
        val row = Owner(owner)
        try {
            return EffectOrder.resume(scope) { row.run(body) }
        } catch (e: Throwable) {
            row.dispose()
            throw e
        }
    }
}

/** Something a memo read: its version changes when its value does. */
interface Versioned : Source {
    val version: Int
    /** Brings the value up to date, so `version` is current. */
    fun settle()
    /** Subscribes `effect` to the signals under this value. */
    fun subscribe(effect: Effect)
}

interface MemoReader {
    fun track(source: Versioned)
}

/**
 * A computed value: kept, so reads share it, until a value it read has a new version; then it is computed again on the
 * next read. A result `same` as the kept one (Object.is) keeps the kept one and its version. Nothing it read holds it: a
 * reader asks for its value.
 */
class Memo<T>(private val compute: () -> T, private val same: (T, T) -> Boolean = ::jsSame) : Versioned, MemoReader, JSDynamic {
    private var cached: Result<T>? = null
    private val sources = mutableListOf<Pair<Versioned, Int>>()
    override var version = 0
        private set
    private var computing = false

    override fun track(source: Versioned) {
        if (sources.none { it.first === source }) sources.add(source to source.version)
    }

    override fun settle() {
        if (cached != null && sources.all { it.first.settle(); it.first.version == it.second }) return
        sources.clear()
        val previous = currentEffect
        val previousMemo = currentMemo
        currentEffect = null
        currentMemo = this
        computing = true
        val next = try {
            Result.success(compute())
        } catch (e: Throwable) {
            Result.failure(e)
        } finally {
            computing = false
            currentEffect = previous
            currentMemo = previousMemo
        }
        val old = cached
        // What `same` throws becomes the value, as a throw of the computation does.
        val kept = try {
            old != null && old.isSuccess && next.isSuccess && same(old.getOrThrow(), next.getOrThrow())
        } catch (e: Throwable) {
            cached = Result.failure(e)
            version += 1
            return
        }
        if (kept) return
        cached = next
        version += 1
    }

    override fun subscribe(effect: Effect) {
        for (s in sources.toList()) s.first.subscribe(effect)
    }

    override fun unsubscribe(subscriber: Subscriber) {}

    /** The value, rethrowing what computing it threw (kept like a value). */
    val value: T
        get() {
            if (computing) throw JSException(JSError("Detected cycle in computations."))
            settle()
            val memo = currentMemo
            if (memo != null) memo.track(this) else currentEffect?.let { subscribe(it) }
            return cached!!.getOrThrow()
        }

    /** A function's local `computed()` (`val total by Memo(…)`): each read of the local is the memo's value. */
    operator fun getValue(thisRef: Any?, property: kotlin.reflect.KProperty<*>): T = value

    override val jsKeys: List<String> get() = listOf("value")
    override val jsClassName: String? get() = null
    override fun jsGet(key: String): Any? = if (key == "value") value else null
    override fun jsSet(key: String, value: Any?) {}
}

/**
 * A value that notifies the effects that read it. A write of an equal value
 * (`equals`, by default `==`: Object.is for numbers and strings, identity for
 * the runtime's objects) is ignored.
 */
class Signal<T>(private var stored: T, private val equals: ((T, T) -> Boolean)? = null) : Versioned, JSDynamic {
    private val subscribers = LinkedHashSet<Subscriber>()
    override var version = 0
        private set
    private var link: Link<T>? = null
    /** Framework state (`stateSignal`): read outside an owner, the value before the writes not yet committed. */
    internal var holds = false
    private var held: Any? = NOT_HELD
    /** A read-only signal's getter (`computed()`, a computed field): each read is its value, tracked by what it reads. */
    private var compute: (() -> T)? = null
    /** The error a read throws until the first write, for a signal made with no value ([unset]). */
    private var unsetError: String? = null

    @Suppress("UNCHECKED_CAST")
    var value: T
        get() {
            compute?.let { return it() }
            link?.let { return linkedValue(it) }
            val reader = currentMemo
            if (reader != null) reader.track(this) else currentEffect?.let { subscribe(it) }
            unsetError?.let { throw JSException(JSError(it)) }
            if (held !== NOT_HELD && Owner.current == null) return held as T
            return stored
        }
        set(newValue) {
            val l = link
            if (l != null) settleLink(l)
            if (unsetError != null) unsetError = null
            else if (l?.valid != false && (equals?.invoke(stored, newValue) ?: (stored == newValue))) return
            if (l != null) {
                l.valid = true
                l.error = null
            }
            if (holds && held === NOT_HELD) {
                held = stored
                holding.add(this)
            }
            stored = newValue
            version += 1
            for (target in subscribers.toList()) target.invalidate()
            if (batchDepth == 0 && !flushing && !(queue.isEmpty() && derivedQueue.isEmpty() && holding.isEmpty())) scheduleFlush()
        }

    internal fun release() {
        held = NOT_HELD
    }

    /** `signal.update { it + 1 }`. */
    fun update(transform: (T) -> T) {
        link?.let { l ->
            settleLink(l)
            l.error?.let { throw it }
        }
        unsetError?.let { throw JSException(JSError(it)) }
        value = transform(stored)
    }

    /** This signal with no value until its first write (a required input before its parent sets it): a read throws `error` until then. */
    fun unset(error: String): Signal<T> {
        unsetError = error
        return this
    }

    override fun unsubscribe(subscriber: Subscriber) {
        subscribers.remove(subscriber)
    }

    /**
     * Runs the link's computation when it never ran or a value it read has a new version. A result `equals` to the value
     * keeps the value and its version; what the computation or `equals` throws is kept until a value it read changes.
     */
    private fun settleLink(link: Link<T>) {
        if (link.computing) return
        if (link.ran && link.sources.all { it.first.settle(); it.first.version == it.second }) return
        val valid = link.valid
        link.sources.clear()
        val previous = currentEffect
        val previousMemo = currentMemo
        currentEffect = null
        currentMemo = link
        link.computing = true
        val next = try {
            Result.success(link.compute(valid, stored))
        } catch (e: Throwable) {
            Result.failure(e)
        } finally {
            link.computing = false
            currentEffect = previous
            currentMemo = previousMemo
        }
        link.ran = true
        try {
            val v = next.getOrThrow()
            if (valid && untrack { equals?.invoke(stored, v) ?: (stored == v) }) return
            stored = v
            link.valid = true
            link.error = null
        } catch (e: Throwable) {
            link.valid = false
            link.error = e
        }
        version += 1
    }

    /** A linked signal's value, brought up to date; what its computation threw is thrown again. */
    private fun linkedValue(link: Link<T>): T {
        if (link.computing) throw JSException(JSError("Detected cycle in computations."))
        settleLink(link)
        val reader = currentMemo
        if (reader != null) reader.track(this) else currentEffect?.let { subscribe(it) }
        link.error?.let { throw it }
        return stored
    }

    override fun settle() {
        link?.let { settleLink(it) }
    }

    /** Subscribes [effect] to this signal and, for a linked one, to the values its computation read. */
    override fun subscribe(effect: Effect) {
        subscribers.add(effect)
        effect.track(this)
        link?.let { for (s in it.sources.toList()) s.first.subscribe(effect) }
    }

    override val jsKeys: List<String> get() = listOf("value")
    override val jsClassName: String? get() = null
    override fun jsGet(key: String): Any? = if (key == "value") value else null
    @Suppress("UNCHECKED_CAST")
    override fun jsSet(key: String, value: Any?) {
        if (key == "value") this.value = (if (value === JSNull) null else value) as T
    }

    /**
     * A `linkedSignal`'s computation, run as a memo's is: on the first read or write, and on each one after a value it
     * read has a new version. [compute] is handed whether the signal holds a value (computed or written; not on the
     * first run nor after a run that threw) and that value.
     */
    private class Link<T>(val compute: (Boolean, T) -> T) : MemoReader {
        val sources = mutableListOf<Pair<Versioned, Int>>()
        var ran = false
        var computing = false
        var valid = false
        var error: Throwable? = null

        override fun track(source: Versioned) {
            if (sources.none { it.first === source }) sources.add(source to source.version)
        }
    }

    companion object {
        private val NOT_HELD = Any()

        /** A `computed()` held as a signal: its reads are the memo's. */
        fun <T> computed(memo: Memo<T>): Signal<T> = computing { memo.value }

        @Suppress("UNCHECKED_CAST")
        fun <T> computing(compute: () -> T): Signal<T> = Signal(null as T).also { it.compute = compute }

        /** What an [unset] signal is made with: never read, the first write replacing it. */
        @Suppress("UNCHECKED_CAST")
        fun <T> placeholder(): T = null as T

        fun <T> linked(compute: () -> T, equals: ((T, T) -> Boolean)? = null): Signal<T> =
            Signal(placeholder<T>(), equals).also { it.link = Link { _, _ -> compute() } }

        /**
         * A signal linked to [source]: `computation` is handed the source's value and, once the signal holds a value
         * (from a prior run or a write), the source value of the last run that returned (null when none has yet) with that value.
         */
        fun <S, T> linked(source: () -> S, computation: (S, Pair<S?, T>?) -> T, equals: ((T, T) -> Boolean)? = null): Signal<T> {
            var last: Pair<S, Unit>? = null
            return Signal(placeholder<T>(), equals).also {
                it.link = Link { valid, value ->
                    val s = source()
                    val previous = if (valid) Pair(last?.first, value) else null
                    computation(s, previous).also { last = Pair(s, Unit) }
                }
            }
        }
    }
}

/** The `equal` of a signal's options, read by name; `default` when they give none. */
fun <T> jsEqualOption(options: Any?, default: (T, T) -> Boolean): (T, T) -> Boolean {
    val equal = jsGetOptional(options, "equal")
    return if (jsIsNullish(equal)) default else { a, b -> jsTruthy(jsCall(equal, a, b)) }
}

/**
 * State the handlers of a render read as it rendered (untracked reads see the last flush) until the
 * writes commit.
 */
fun <T> stateSignal(signal: Signal<T>): Signal<T> {
    signal.holds = true
    return signal
}

/** Runs `body` now and again whenever a signal it read changes; [deferred], its first run is in the next update (or when flushed by a framework if [schedule] is false), not at creation. */
class Effect internal constructor(internal val key: List<Int>, private val derived: Boolean, body: () -> Unit, private val deferred: Boolean = false, schedule: Boolean = true) : Subscriber {
    private var body: (() -> Unit)? = body
    private val sources = LinkedHashSet<Source>()
    private var stale = false
    private var started = false
    private var owner: Owner? = null
    private val height = EffectOrder.current.height
    private val ambient = EffectOrder.ambient
    /** The context of the scope it was made in ([EffectOrder.Scope.context]). */
    internal val context = EffectOrder.current.context
    /** Made in a scope with a context, or deferred: a framework site ([Reactivity.site]) runs it. */
    private val site = context != null || deferred

    constructor(body: () -> Unit) : this(EffectOrder.key(), false, body)

    init {
        Owner.current?.effects?.add(this)
        created?.invoke(this)
        if (deferred) {
            stale = true
            if (schedule) {
                queue.add(this)
                scheduleFlush()
            }
        } else {
            run()
            started = true
        }
    }

    internal val disposed: Boolean get() = body == null

    companion object {
        /** Called with each effect as it is made, for a framework that re-runs them all. */
        internal var created: ((Effect) -> Unit)? = null
    }

    /** Stops it: it runs no more, and what its runs made is disposed. */
    fun destroy() = dispose()

    internal fun track(source: Source) {
        sources.add(source)
    }

    override fun invalidate() {
        if (body == null || stale) return
        stale = true
        if (derived) derivedQueue.add(this) else queue.add(this)
    }

    internal fun runIfStale(allowDefer: Boolean = true) {
        if (!stale) return
        val deferCheck = Reactivity.shouldDeferEffect
        if (allowDefer && started && !deferred && deferCheck != null && deferCheck(this)) {
            stale = false
            return
        }
        stale = false
        run()
        started = true
    }

    /** Runs immediately in a framework-driven check pass, clearing any queued staleness so it does not double-run. */
    internal fun runNow() {
        if (body == null) return
        stale = false
        run()
        started = true
    }

    private fun run() {
        val body = body ?: return
        for (source in sources) source.unsubscribe(this)
        sources.clear()
        // Effects and views made by the previous run (a branch, a row) go with it.
        owner?.dispose()
        // The effect, not whatever owner is current when it re-runs, owns what each run makes.
        val next = Owner(null)
        owner = next
        val previous = currentEffect
        currentEffect = this
        // What an effect throws is reported, as a framework's scheduler reports a failed job: the update goes on.
        val guarded = {
            try {
                EffectOrder.run(EffectOrder.Scope(key, height, ambient, context)) { next.run(body) }
            } catch (e: Throwable) {
                jsReportUncaught(jsCaught(e))
            } finally {
                currentEffect = previous
            }
        }
        if (site) Reactivity.site(guarded) else guarded()
    }

    internal fun dispose() {
        for (source in sources) source.unsubscribe(this)
        sources.clear()
        body = null
        owner?.dispose()
        owner = null
    }
}

/**
 * A derived value: `body` stores it when its sources change, in the
 * update after the writes and before any binding re-runs; read before that, it is the old value.
 */
fun derive(body: () -> Unit): Effect = Effect(EffectOrder.derivedKey(), true, body)

/** A top-level owner for an app or a navigation entry. */
fun <T> createRoot(body: (Owner) -> T): T {
    val owner = Owner(null)
    return owner.run { body(owner) }
}

/** What a `subscribe` returns: [unsubscribe] runs its teardown once, and [closed] says whether it has. */
class TeardownHandle(private var teardown: (() -> Unit)? = null) {
    var closed = false
        private set

    fun unsubscribe() {
        if (closed) return
        closed = true
        val finalize = teardown
        teardown = null
        finalize?.invoke()
    }
}

/** An event a component raises: the parent subscribes, the component emits. */
class Emitter<T>(@Suppress("UNUSED_PARAMETER") isAsync: Boolean = false) {
    private class Handler<T>(val fn: (T) -> Unit)
    private val handlers = mutableListOf<Handler<T>>()

    fun on(handler: (T) -> Unit) {
        handlers.add(Handler(handler))
    }

    fun emit(value: T) {
        for (h in handlers.toList()) h.fn(value)
    }

    fun next(value: T) {
        emit(value)
    }

    fun subscribe(next: (T) -> Unit): TeardownHandle {
        val box = Handler(next)
        handlers.add(box)
        return TeardownHandle { handlers.remove(box) }
    }

    fun subscribe(observerOrNext: Any? = null, @Suppress("UNUSED_PARAMETER") error: Any? = null, @Suppress("UNUSED_PARAMETER") complete: Any? = null): TeardownHandle {
        val box = Handler<T> { value ->
            val sub = jsBox(observerOrNext) ?: return@Handler
            if (sub is JSDynamic && ("next" in sub.jsKeys || sub.jsHasMember("next"))) {
                jsReport { jsCallMethod(sub, "next", value) }
            } else {
                jsReport { jsCall(sub, value) }
            }
        }
        handlers.add(box)
        return TeardownHandle { handlers.remove(box) }
    }
}

fun Emitter<Unit>.emit() = emit(Unit)
fun Emitter<Unit>.next() = emit(Unit)

@JvmName("emitNullableAny")
fun Emitter<Any?>.emit() = emit(null)
@JvmName("nextNullableAny")
fun Emitter<Any?>.next() = emit(null)
