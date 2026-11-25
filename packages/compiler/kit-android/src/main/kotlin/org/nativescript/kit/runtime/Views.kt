package org.nativescript.kit

import java.lang.ref.WeakReference

/**
 * An object of one shape's class standing for an object of another class (`T.jsView`): it keeps no fields of its
 * own and reads and writes its root's keys, so it is the root in every JavaScript sense.
 */
interface JSViewing : JSDynamic {
    val jsViewRoot: JSDynamic?
}

private val jsViews = JSWeakIdentityTable<MutableMap<Class<*>, WeakReference<Any>>>()

/** The object `value` is in JavaScript: a view's root, else `value` itself. */
@Suppress("NOTHING_TO_INLINE")
inline fun jsIdentity(value: Any?): Any? = if (value is JSViewing) value.jsViewRoot ?: value else value

/**
 * The object a view of `value` reads: `value`'s own root when it is a view, a [JSPrimitiveRoot] when it is no object,
 * null when it is an object with no keys of its own to read.
 */
fun jsViewRootOf(value: Any?): JSDynamic? {
    val v = jsBox(value)
    val d = v as? JSDynamic ?: return if (v == null || v === JSNull || v is Boolean || v is Double || v is String || v is JSSymbol || v is JSBigInt) JSPrimitiveRoot(v) else null
    return (d as? JSViewing)?.jsViewRoot ?: d
}

/**
 * A value that is no object, held as an object type (`x as any as Shape`): what a view of it reads is the value's
 * own, and an iteration step given it throws as for the value.
 */
class JSPrimitiveRoot internal constructor(val value: Any?) : JSDynamic {
    private val written = LinkedHashMap<String, Any?>()
    override fun jsGet(key: String): Any? = if (written.containsKey(key)) written[key] else jsField(value, key)
    override fun jsSet(key: String, value: Any?) { written[key] = value }
    override val jsKeys: List<String> get() = written.keys.toList()
    override val jsClassName: String? get() = null
}

/** The one view of `root` as `type` while it is alive, made by `make` when there is none. Views are held weakly: each holds its root. */
fun <T : JSViewing> jsViewOf(root: JSDynamic, type: Class<T>, make: (JSDynamic) -> T): T {
    // An object of the type already is the object read.
    @Suppress("UNCHECKED_CAST")
    if (type.isInstance(root)) return root as T
    val views = jsViews.getOrPut(root) { HashMap(2) }
    synchronized(views) {
        @Suppress("UNCHECKED_CAST")
        (views[type]?.get() as T?)?.let { return it }
        return make(root).also { views[type] = WeakReference(it) }
    }
}
