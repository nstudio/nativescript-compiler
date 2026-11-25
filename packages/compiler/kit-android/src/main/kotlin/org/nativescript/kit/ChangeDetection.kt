package org.nativescript.kit

/**
 * A watcher: `changed` runs with the new and old value when `source`'s
 * value is no longer `Object.is` the last one, and at once when `immediate`
 * (old undefined); what `changed` reads is not tracked.
 */
fun <T> Watch(immediate: Boolean, source: () -> T, changed: (T, T?) -> Unit) {
    var last: T? = null
    var started = false
    Effect {
        val value = source()
        val old = last
        last = value
        if (!started) {
            started = true
            if (immediate) untrack { changed(value, null) }
            return@Effect
        }
        if (jsSameValue(old, value)) return@Effect
        untrack { changed(value, old) }
    }
}

private var users = 0

/** A component's own effect: after every template effect a write invalidates, in creation order. */
fun <T> EffectOrder.user(body: () -> T): T = EffectOrder.run(EffectOrder.Scope(listOf(Int.MAX_VALUE, ++users)), body)
