package org.nativescript.kit

// @angular/router value types

class ParamMap(params: Any? = null) {
    private val storage = LinkedHashMap<String, List<String>>()

    init {
        val flat = jsBox(params)
        if (flat is Map<*, *>) {
            for ((k, v) in flat) {
                if (k != null && v != null) storage[k.toString()] = listOf(v.toString())
            }
        } else if (flat != null) {
            for (k in jsKeysOf(flat)) {
                val v = jsGetOptional(flat, k)
                if (jsIsNullish(v)) continue
                val box = jsBox(v)
                storage[k] = if (box is JSArray<*>) box.storage.map { jsToString(it) } else listOf(jsToString(v))
            }
        }
    }

    fun has(name: String): Boolean = storage.containsKey(name)
    fun get(name: String): String? = storage[name]?.firstOrNull()
    fun getAll(name: String): JSArray<String> = JSArray((storage[name] ?: emptyList()).toMutableList())
    val keys: JSArray<String> get() = JSArray(storage.keys.toMutableList())
}

fun convertToParamMap(params: Any?): ParamMap = ParamMap(params)

class UrlSegment(val path: String, parameters: Any? = null) : JSStringConvertible {
    val parameters: JSRecord<String>
    val parameterMap: ParamMap

    init {
        val pairs = mutableListOf<Pair<String, String>>()
        val flat = jsBox(parameters)
        if (flat is Map<*, *>) {
            for ((k, v) in flat) if (k != null && v != null) pairs.add(k.toString() to v.toString())
        } else if (flat != null) {
            for (k in jsKeysOf(flat)) {
                val v = jsGetOptional(flat, k)
                if (!jsIsNullish(v)) pairs.add(k to jsToString(v))
            }
        }
        this.parameters = JSRecord(pairs)
        this.parameterMap = ParamMap(this.parameters)
    }

    override fun toString(): String = path
}

class UrlTree(
    path: String = "/",
    queryParams: Any? = null,
    var fragment: String? = null,
) : JSStringConvertible {
    private val path: String = path.ifEmpty { "/" }
    var queryParams: JSObject = run {
        val flat = jsBox(queryParams)
        if (flat is JSObject) flat
        else if (flat != null) {
            val pairs = mutableListOf<Pair<String, Any?>>()
            for (k in jsKeysOf(flat)) pairs.add(k to jsGetOptional(flat, k))
            JSObject(pairs)
        } else JSObject()
    }

    val queryParamMap: ParamMap get() = ParamMap(queryParams)

    override fun toString(): String {
        val qParts = mutableListOf<String>()
        for (k in jsKeysOf(queryParams)) {
            val v = jsGetOptional(queryParams, k)
            if (!jsIsNullish(v)) {
                qParts.add("${jsEncodeURIComponent(k)}=${jsEncodeURIComponent(jsToString(v))}")
            }
        }
        val q = if (qParts.isEmpty()) "" else "?${qParts.joinToString("&")}"
        val f = if (fragment != null) "#$fragment" else ""
        return "$path$q$f"
    }
}

class DefaultUrlSerializer {
    fun parse(url: String): UrlTree {
        var raw = url.ifEmpty { "/" }
        var fragment: String? = null
        val hashIdx = raw.indexOf('#')
        if (hashIdx >= 0) {
            fragment = raw.substring(hashIdx + 1)
            raw = raw.substring(0, hashIdx)
        }
        val qPairs = mutableListOf<Pair<String, Any?>>()
        val qIdx = raw.indexOf('?')
        if (qIdx >= 0) {
            val qStr = raw.substring(qIdx + 1)
            raw = raw.substring(0, qIdx)
            for (part in qStr.split("&")) {
                if (part.isEmpty()) continue
                val eq = part.indexOf('=')
                if (eq >= 0) {
                    qPairs.add(jsDecodeURIComponent(part.substring(0, eq)) to jsDecodeURIComponent(part.substring(eq + 1)))
                } else {
                    qPairs.add(jsDecodeURIComponent(part) to "")
                }
            }
        }
        return UrlTree(raw.ifEmpty { "/" }, JSObject(qPairs), fragment)
    }

    fun serialize(tree: UrlTree): String = tree.toString()
}

class ActivatedRouteSnapshot(
    val params: JSRecord<String> = JSRecord(),
    val queryParams: JSRecord<String> = JSRecord(),
    val data: JSRecord<Any?> = JSRecord(),
    val url: JSArray<UrlSegment> = JSArray(),
    val fragment: String? = null,
    val outlet: String = "primary",
    val routeConfig: JSObject? = null,
) {
    var title: String? = null
    val paramMap: ParamMap get() = ParamMap(params)
    val queryParamMap: ParamMap get() = ParamMap(queryParams)
    val root: ActivatedRouteSnapshot get() = this
    val parent: ActivatedRouteSnapshot? get() = null
    val firstChild: ActivatedRouteSnapshot? get() = null
    val children: JSArray<ActivatedRouteSnapshot> get() = JSArray()
    val pathFromRoot: JSArray<ActivatedRouteSnapshot> get() = JSArray(mutableListOf(this))
}

class NavigationStart(val id: Double, val url: String) {
    val navigationTrigger: String = "imperative"
    val restoredState: Any? = null
}

/** `NavigationEnd`, the router event each completed navigation emits. */
class NavigationEnd(val id: Double, val url: String, val urlAfterRedirects: String = url)

class NavigationCancel(val id: Double, val url: String, val reason: String = "")

class NavigationError(val id: Double, val url: String, val error: Any? = null)

class RoutesRecognized(val id: Double, val url: String, val urlAfterRedirects: String = url, val state: Any? = null)

class ResolveStart(val id: Double, val url: String, val urlAfterRedirects: String = url, val state: Any? = null)

class ResolveEnd(val id: Double, val url: String, val urlAfterRedirects: String = url, val state: Any? = null)

fun createRouterStateSnapshot(url: String = "/"): JSObject =
    JSObject("url" to url, "root" to ActivatedRouteSnapshot())
