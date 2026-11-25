package org.nativescript.kit

/**
 * An Angular component view: a listener or `markForCheck` marks it and the views above it dirty (`markViewDirty`), a
 * signal one of its bindings read marks it to refresh, and [Zone] refreshes what is marked in `EffectOrder` key order:
 * every binding ([Check]), hook and region of the view's template and of its embedded views, applying what is no longer
 * `Object.is` the value last applied.
 */
class AngularView internal constructor(
    internal val parent: AngularView?,
    internal val prefix: List<Int>,
    internal val onPush: Boolean = false,
) {
    /** Checked OnPush: a tick refreshes it only while it is `dirty`, or marked to `refresh`. */
    internal var dirty = false
    /** Angular's `RefreshView`: a signal one of its bindings read changed, or `detectChanges()`. */
    internal var refresh = false
    /** True while one of this view's effects is executing in a check pass (prevents self-deferral). */
    internal var refreshing = false
    /** True while this view is already active in the current pass (prevents ancestor re-dirtying loops from `ngDoCheck`). */
    internal var inPass = false
    /** Set when a `@let` in this view throws during its check pass; remaining bindings in this view skip until next pass. */
    internal var aborted = false
    /** Component-scoped `effect()`s created during construction, flushed between `ngDoCheck` and `ngAfterContentInit`. */
    internal val initialEffects = mutableListOf<Effect>()

    /** Marks this view dirty and walks up to its root host view without re-dirtying ancestors already active in this pass. */
    internal fun markDirty() {
        dirty = true
        var view = parent
        while (view != null) {
            if (!view.inPass) view.dirty = true
            view = view.parent
        }
    }

    internal class ConstructionFrame {
        val refs = mutableListOf<ChangeDetectorRef>()
        val initialEffects = mutableListOf<Effect>()
    }

    companion object {
        internal val frames = mutableListOf<ConstructionFrame>()
        internal val pending = java.util.WeakHashMap<Any, ConstructionFrame>()

        /**
         * Runs a component's construction inside an exception-safe, re-entrant scope frame so `inject(ChangeDetectorRef)`
         * and `effect()` bind to the component's own view regardless of inheritance or constructor helpers.
         */
        fun <T : Any> construct(make: () -> T): T {
            val frame = ConstructionFrame()
            frames.add(frame)
            val instance = try {
                make()
            } catch (e: Throwable) {
                frames.removeAt(frames.lastIndex)
                for (fx in frame.initialEffects) fx.destroy()
                throw e
            }
            frames.removeAt(frames.lastIndex)
            if (frame.refs.isNotEmpty() || frame.initialEffects.isNotEmpty()) {
                pending[instance] = frame
            }
            return instance
        }
    }
}

/** The component view whose bindings this scope's checks are. */
val EffectOrder.Scope.view: AngularView? get() = context as? AngularView

/** The component view it is a binding of. */
internal val Effect.view: AngularView? get() = context as? AngularView

/** A root component's host view scope: isolates each root's host hooks and `markForCheck` state from other roots. */
fun <T> EffectOrder.root(body: () -> T): T {
    Zone.install()
    val prefix = current.next(CHILD_PHASE)
    val host = AngularView(null, prefix, false)
    return run(EffectOrder.Scope(prefix, null, current.ambient, host), body)
}

/**
 * Angular's component view: after its parent view's bindings and embedded views. [injector] is the component's own
 * (`providers`); without one, the view's children inject from the injector the component was made in.
 */
fun <T> EffectOrder.view(injector: Injector? = null, component: Any? = null, onPush: Boolean = false, body: () -> T): T {
    Zone.install()
    val prefix = current.next(CHILD_PHASE)
    val view = AngularView(current.view, prefix, onPush)
    if (component != null) {
        Zone.views[component] = view
        val frame = AngularView.pending.remove(component)
        if (frame != null) {
            for (ref in frame.refs) ref.view = view
            view.initialEffects.addAll(frame.initialEffects)
        }
    }
    return run(EffectOrder.Scope(prefix, null, injector ?: Injector.current, view), body)
}

/** Angular's embedded view (`@if`, `@for` content): after its declaring view's own bindings. */
fun <T> EffectOrder.embedded(view: EffectOrder.Scope, body: () -> T): T = run(EffectOrder.Scope(view.next(EMBEDDED_PHASE), null, view.ambient, view.context), body)

/**
 * The phases of a view's scope ([EffectOrder.Scope.next]), in the order a check of the view runs them: its own bindings
 * (0), its embedded views, the content hooks of what it holds, its child views, their after-view hooks.
 */
private const val EMBEDDED_PHASE = 1
private const val CONTENT_PHASE = 2
private const val CHILD_PHASE = 3
private const val VIEW_PHASE = 4

/** Angular's `effect()`: created during component construction it flushes between `ngDoCheck` and `ngAfterContentInit`; otherwise its first run is in the next update. */
fun Effect.Companion.deferred(body: () -> Unit): Effect {
    Zone.install()
    // Not a binding: a tick does not re-run it, only a signal it read.
    val created = Effect.created
    Effect.created = null
    try {
        val frame = AngularView.frames.lastOrNull()
        if (frame != null) {
            val fx = Effect(EffectOrder.key(), false, body, deferred = true, schedule = false)
            frame.initialEffects.add(fx)
            return fx
        }
        return Effect(EffectOrder.key(), false, body, deferred = true)
    } finally {
        Effect.created = created
    }
}

/** A listener of a zoneless Angular template: the update it schedules refreshes [view] and every view above it. */
fun Reactivity.event(view: AngularView?, handler: () -> Unit) {
    Zone.install()
    Zone.markDirty(view)
    event { site(handler) }
}

/**
 * `ChangeDetectorRef.markForCheck()` on a zoneless view: an update refreshes it and the views above it, scheduled as a
 * write schedules one, or run at once.
 */
internal fun Reactivity.markForCheck(view: AngularView?, now: Boolean = false) {
    Zone.markDirty(view)
    requestUpdate(now)
}

/**
 * Angular's change detection. With zone.js, after every JavaScript task (an event handler, a timer callback, a promise
 * job) and the jobs it queued, `ApplicationRef.tick()` refreshes every Eager view from the roots; zoneless, a tick runs
 * in the update a listener, `markForCheck` or a signal a binding read schedules, and refreshes only what they marked.
 * Every effect a view's template makes is re-run in `EffectOrder` key order, deciding each view lazily when entered.
 */
object Zone {
    var enabled = false
        set(value) {
            field = value
            install()
            Microtasks.onStable = if (value) ({ tick() }) else null
        }

    /** Held until disposed: a binding reads no signal that would keep it alive. */
    private val effects = mutableListOf<Effect>()

    private var handing = false
    private var installed = false

    /**
     * Hands uncaught errors to Angular ([handOff]), keeps every view-scoped effect, and installs the unified signal
     * deferral hook so `Check`, `Choose`, `ForEach`, and `listItems` all refresh in view order.
     */
    internal fun install() {
        if (jsUncaughtHandOff == null) jsUncaughtHandOff = ::handOff
        if (installed) return
        installed = true
        Effect.created = { if (it.view != null) effects.add(it) }
        Reactivity.shouldDeferEffect = { effect ->
            val view = effect.view
            if (view != null && !view.refreshing) {
                refresh(view)
                true
            } else {
                false
            }
        }
        Reactivity.rerunsUnchanged = true
    }

    /**
     * An uncaught error as Angular takes it: with zone.js every task's error goes to the ErrorHandler (the app's,
     * else Angular's) and never reaches the runtime; without it only an Angular catch site's does. False when it is
     * the runtime's, as is what the handler itself throws.
     */
    fun handOff(error: Any?): Boolean {
        if (handing || !(enabled || Reactivity.sites > 0)) return false
        handing = true
        try {
            (Injector.providedErrorHandler() ?: ErrorHandler.shared).handleError(error)
        } catch (t: Throwable) {
            jsReportUncaught(jsCaught(t))
        } finally {
            handing = false
        }
        return true
    }

    /** Component views by component instance. */
    internal val views = java.util.WeakHashMap<Any, AngularView>()

    /**
     * An input of an OnPush component set to a value not `Object.is` the last (`markDirtyIfOnPush`); not its first
     * value, which its view's first update follows, as Angular's creation does.
     */
    fun inputChanged(component: Any) {
        if (!creating) views[component]?.dirty = true
    }

    /** Flushes construction-scoped `effect()`s of [component] between `ngDoCheck` and `ngAfterContentInit`. */
    fun flushEffects(component: Any) {
        val view = views[component] ?: return
        if (view.initialEffects.isEmpty()) return
        val pending = view.initialEffects.toList()
        view.initialEffects.clear()
        for (fx in pending) {
            Reactivity.site { fx.runIfStale() }
        }
    }

    private var creating = false

    internal inline fun applying(first: Boolean, apply: () -> Unit) {
        val outer = creating
        creating = first
        try { apply() } finally { creating = outer }
    }

    /** Zoneless `markViewDirty`: [view] and the views up to its root host view, refreshed by the tick in the update the caller schedules. */
    internal fun markDirty(view: AngularView?) {
        if (view == null) return
        view.markDirty()
        if (!enabled) scheduleTick()
    }

    /** A binding/region of [view] read a signal that changed. */
    internal fun refresh(view: AngularView) {
        view.refresh = true
        if (!enabled) scheduleTick()
    }

    /** The zoneless tick, an effect keyed after every other, so in an update it runs once user `effect()`s have run. */
    private var ticker: Effect? = null

    private fun scheduleTick() {
        if (ticker == null) {
            val created = Effect.created
            Effect.created = null
            try {
                ticker = Owner(null).run { EffectOrder.run(EffectOrder.Scope(listOf(Int.MAX_VALUE), null, null, null)) { Effect(listOf(Int.MAX_VALUE), false, { untrack { runCycle(null) } }) } }
            } finally {
                Effect.created = created
            }
        }
        ticker?.invalidate()
    }

    /** `ApplicationRef.tick()` with zone.js (Angular 22 `detectChangesInViewWhileDirty`/`detectChangesInView`), run at once. */
    fun tick() {
        runCycle(null)
    }

    /** Subtree-scoped `ChangeDetectorRef.detectChanges()` for both zone.js and zoneless modes. */
    internal fun detectChanges(view: AngularView) {
        val scoped = java.util.Collections.newSetFromMap(java.util.IdentityHashMap<AngularView, Boolean>())
        scoped.add(view)
        runCycle(scoped)
    }

    private fun isDescendant(view: AngularView, roots: Set<AngularView>): Boolean {
        var cur = view.parent
        while (cur != null) {
            if (cur in roots) return true
            cur = cur.parent
        }
        return false
    }

    private fun runCycle(roots: Set<AngularView>?) {
        val checked = java.util.Collections.newSetFromMap(java.util.IdentityHashMap<AngularView, Boolean>())
        for (pass in 0 until 100) {
            if (!runPass(roots, pass == 0 && roots == null, checked)) break
        }
    }

    /**
     * Runs one in-order `EffectOrder` pass, evaluating each view's eligibility lazily when entered so OnPush inputs
     * and `ngDoCheck` `markForCheck()` take effect in the same pass before `ngAfterViewChecked`, and wrapping each
     * Phase 0 scope in [EmbeddedViews.begin]/[EmbeddedViews.flush].
     */
    private fun runPass(roots: Set<AngularView>?, isRootPass: Boolean, checked: MutableSet<AngularView>): Boolean {
        effects.removeAll { it.disposed }
        val snapshot = effects.sortedWith { a, b -> EffectOrder.compare(a.key, b.key) }
        val decision = java.util.IdentityHashMap<AngularView, Boolean>()
        val enteredViews = mutableListOf<AngularView>()
        var ranAny = false

        fun enter(view: AngularView): Boolean {
            decision[view]?.let { return it }
            if (roots != null && view !in roots && !isDescendant(view, roots)) {
                decision[view] = false
                return false
            }
            val isTarget = roots != null && view in roots && view !in checked
            val parent = view.parent
            val parentActive: Boolean
            val parentDone: Boolean
            if (parent != null) {
                parentActive = enter(parent)
                parentDone = parent in checked
            } else {
                parentActive = isRootPass && enabled
                parentDone = true
            }
            val active = isTarget || view.refresh || ((parentActive || parentDone) && view.dirty) || (parentActive && !view.onPush)
            decision[view] = active
            if (active) {
                view.inPass = true
                view.dirty = false
                view.refresh = false
                view.aborted = false
                checked.add(view)
                enteredViews.add(view)
            }
            return active
        }

        var openPrefix: List<Int>? = null
        try {
            for (effect in snapshot) {
                if (effect.disposed) continue
                val view = effect.view ?: continue
                if (!enter(view) || view.aborted) continue
                val phase0Prefix: List<Int>? = if (effect.key.size >= 2 && effect.key[effect.key.size - 2] == 0) effect.key.subList(0, effect.key.size - 2) else null
                if (phase0Prefix != openPrefix) {
                    if (openPrefix != null) jsReport { EmbeddedViews.flush() }
                    if (phase0Prefix != null) EmbeddedViews.begin()
                    openPrefix = phase0Prefix
                }
                ranAny = true
                view.refreshing = true
                try {
                    effect.runNow()
                } finally {
                    view.refreshing = false
                }
            }
        } finally {
            if (openPrefix != null) {
                openPrefix = null
                jsReport { EmbeddedViews.flush() }
            }
            for (v in enteredViews) {
                v.inPass = false
                v.refreshing = false
            }
        }
        return ranAny
    }
}

/**
 * A binding as Angular checks it (`bindingUpdated`): re-read on every check of its view,
 * applied only when the value is not `Object.is` the last one applied. With [abortOnThrow], a throw aborts the rest
 * of the view's pass.
 */
fun <T> Check(read: () -> T, apply: (T) -> Unit) = Check(false, read, apply)

fun <T> Check(abortOnThrow: Boolean, read: () -> T, apply: (T) -> Unit) {
    var last: Any? = UNCHECKED
    var started = false
    Effect {
        if (EffectOrder.current.view?.aborted == true) return@Effect
        val first = !started
        started = true
        val value = try {
            read()
        } catch (e: Throwable) {
            if (abortOnThrow) EffectOrder.current.view?.aborted = true
            throw e
        }
        if (last !== UNCHECKED && jsSameValue(last, value)) return@Effect
        last = value
        untrack { Zone.applying(first) { apply(value) } }
    }
}

private val UNCHECKED = Any()

/**
 * A hook Angular runs on every check of the view its component or directive is in (`ngDoCheck`): now, after the init
 * hook, then each time the view is checked, at its place among the view's bindings.
 */
fun EveryCheck(hook: () -> Unit) = everyCheck(0, hook)

/** `ngAfterContentChecked`: now, after `ngAfterContentInit`, then on every check of the view, after its embedded views. */
fun ContentChecked(hook: () -> Unit) = everyCheck(CONTENT_PHASE, hook)

/** `ngAfterViewChecked`: now, after `ngAfterViewInit`, then on every check of the view, after its child views. */
fun ViewChecked(hook: () -> Unit) = everyCheck(VIEW_PHASE, hook)

private fun everyCheck(phase: Int, hook: () -> Unit) {
    Effect(EffectOrder.current.next(phase), false, { untrack(hook) })
}

/**
 * A template's `@let`, made in its view's creation pass from the closure reading its value: [store], at its place in
 * the update pass, reads it once on every check of the view as a binding does ([Check]), and its readers read [value],
 * tracking it. Before a read has given it a value, [value] throws as Angular's does.
 */
class LetSlot<T>(private val read: () -> T) {
    @Suppress("UNCHECKED_CAST")
    private val held = Signal(null as T).unset("NG0314: Attempting to access a @let declaration whose value is not available yet")

    val value: T get() = held.value

    fun store() = Check(true, read) { held.value = it }
}

/**
 * Angular refreshes an embedded view (an `@if` branch, a `@for` row) after the bindings of the view declaring it, in
 * the order its containers hold them, before that view's child components: [collect] runs a view's bindings, then the
 * update passes of the branches and rows they made ([later]), each in the owner and scope it was made in. A branch a
 * re-run condition makes outside any [collect] is updated at once.
 */
object EmbeddedViews {
    private class Held(val owner: Owner?, val scope: EffectOrder.Scope, val update: () -> Unit)

    private val held = mutableListOf<MutableList<Held>>()

    internal fun begin() {
        held.add(mutableListOf())
    }

    internal fun flush() {
        if (held.isEmpty()) return
        val updates = held.removeAt(held.lastIndex)
        for (h in updates) {
            untrack {
                EffectOrder.resume(h.scope) {
                    val owner = h.owner
                    if (owner != null) owner.run(h.update) else h.update()
                }
            }
        }
    }

    fun collect(bindings: () -> Unit) {
        begin()
        try {
            bindings()
        } catch (e: Throwable) {
            if (held.isNotEmpty()) held.removeAt(held.lastIndex)
            throw e
        }
        flush()
    }

    fun later(update: () -> Unit) {
        if (held.isEmpty()) return update()
        held.last().add(Held(Owner.current, EffectOrder.current, update))
    }
}

/**
 * A pure Angular pipe at one binding site (`ɵɵpipeBind1`…): `transform` runs when an argument is no longer
 * `Object.is` the one it last ran with, and otherwise the result it gave is returned. What it throws is not kept.
 */
class PurePipeCache {
    private var arguments: List<Any?>? = null
    private var result: Any? = null

    @Suppress("UNCHECKED_CAST")
    private inline fun <R> run(given: List<Any?>, transform: () -> R): R {
        val last = arguments
        if (last != null && last.size == given.size && last.indices.all { jsSameValue(last[it], given[it]) }) return result as R
        val value = transform()
        arguments = given
        result = value
        return value
    }

    fun <A, R> pure1(a: A, transform: (A) -> R): R = run(listOf(a)) { transform(a) }
    fun <A, B, R> pure2(a: A, b: B, transform: (A, B) -> R): R = run(listOf(a, b)) { transform(a, b) }
    fun <A, B, C, R> pure3(a: A, b: B, c: C, transform: (A, B, C) -> R): R = run(listOf(a, b, c)) { transform(a, b, c) }
    fun <A, B, C, D, R> pure4(a: A, b: B, c: C, d: D, transform: (A, B, C, D) -> R): R = run(listOf(a, b, c, d)) { transform(a, b, c, d) }
    fun <A, B, C, D, E, R> pure5(a: A, b: B, c: C, d: D, e: E, transform: (A, B, C, D, E) -> R): R = run(listOf(a, b, c, d, e)) { transform(a, b, c, d, e) }
}

/**
 * `inject(ChangeDetectorRef)`: binds to the component's own view when injected inside [AngularView.construct], or the
 * declaring view otherwise (directives, pipes). `markForCheck` marks it and its ancestors up to its root host view
 * dirty; `detectChanges` refreshes only its own view subtree.
 */
class ChangeDetectorRef internal constructor(internal var view: AngularView?) {
    fun markForCheck() {
        if (Zone.enabled) view?.markDirty() else Reactivity.markForCheck(view)
    }

    /** Refreshes this view subtree now, under both zone.js and zoneless modes. */
    fun detectChanges() {
        val v = view ?: return
        Zone.detectChanges(v)
    }

    fun detach() {}
    fun reattach() {}
    fun checkNoChanges() {}

    companion object {
        fun current(): ChangeDetectorRef {
            val frame = AngularView.frames.lastOrNull()
            if (frame != null) {
                val ref = ChangeDetectorRef(null)
                frame.refs.add(ref)
                return ref
            }
            return ChangeDetectorRef(EffectOrder.current.view)
        }
    }
}
