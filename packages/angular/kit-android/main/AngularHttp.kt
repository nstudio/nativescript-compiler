package org.nativescript.kit

import java.util.IdentityHashMap

// @angular/common/http value types

class HttpHeaders(headers: Any? = null) {
    private val storage = LinkedHashMap<String, MutableList<String>>()
    private val originalNames = LinkedHashMap<String, String>()

    init {
        val flat = jsBox(headers)
        if (flat is String) {
            for (line in flat.split("\n")) {
                val colon = line.indexOf(':')
                if (colon > 0) {
                    val name = line.substring(0, colon).trim()
                    val value = line.substring(colon + 1).trim()
                    appendInPlace(name, value)
                }
            }
        } else if (flat != null) {
            for (k in jsKeysOf(flat)) {
                val v = jsGetOptional(flat, k)
                if (jsIsNullish(v)) continue
                val lower = k.lowercase()
                if (!originalNames.containsKey(lower)) originalNames[lower] = k
                val box = jsBox(v)
                if (box is JSArray<*>) {
                    storage[lower] = box.storage.map { jsToString(it) }.toMutableList()
                } else {
                    storage[lower] = mutableListOf(jsToString(v))
                }
            }
        }
    }

    private fun appendInPlace(name: String, value: Any?) {
        val lower = name.lowercase()
        if (!originalNames.containsKey(lower)) originalNames[lower] = name
        val list = storage.getOrPut(lower) { mutableListOf() }
        val box = jsBox(value)
        if (box is JSArray<*>) {
            for (item in box.storage) list.add(jsToString(item))
        } else {
            list.add(jsToString(value))
        }
    }

    private fun cloned(): HttpHeaders {
        val copy = HttpHeaders()
        for ((k, v) in storage) copy.storage[k] = v.toMutableList()
        copy.originalNames.putAll(originalNames)
        return copy
    }

    fun has(name: String): Boolean = storage.containsKey(name.lowercase())

    fun get(name: String): String? = storage[name.lowercase()]?.firstOrNull()

    fun keys(): JSArray<String> = JSArray(originalNames.values.toMutableList())

    fun getAll(name: String): JSArray<String>? {
        val vals = storage[name.lowercase()] ?: return null
        return JSArray(vals.toMutableList())
    }

    fun append(name: String, value: Any?): HttpHeaders {
        val next = cloned()
        next.appendInPlace(name, value)
        return next
    }

    fun set(name: String, value: Any?): HttpHeaders {
        val next = cloned()
        val lower = name.lowercase()
        next.originalNames[lower] = name
        val box = jsBox(value)
        next.storage[lower] = if (box is JSArray<*>) {
            box.storage.map { jsToString(it) }.toMutableList()
        } else {
            mutableListOf(jsToString(value))
        }
        return next
    }

    fun delete(name: String, value: Any? = null): HttpHeaders {
        val next = cloned()
        val lower = name.lowercase()
        if (jsIsNullish(value)) {
            next.storage.remove(lower)
            next.originalNames.remove(lower)
        } else {
            val existing = next.storage[lower]
            if (existing != null) {
                val box = jsBox(value)
                val removeSet = if (box is JSArray<*>) box.storage.map { jsToString(it) }.toSet() else setOf(jsToString(value))
                val filtered = existing.filter { it !in removeSet }.toMutableList()
                if (filtered.isEmpty()) {
                    next.storage.remove(lower)
                    next.originalNames.remove(lower)
                } else {
                    next.storage[lower] = filtered
                }
            }
        }
        return next
    }

    fun toJSObject(): JSObject {
        val pairs = mutableListOf<Pair<String, Any?>>()
        for ((lower, vals) in storage) {
            val orig = originalNames[lower] ?: lower
            pairs.add(orig to vals.joinToString(", "))
        }
        return JSObject(pairs)
    }
}

class HttpParams(options: Any? = null) : JSStringConvertible {
    private val storage = LinkedHashMap<String, MutableList<String>>()

    init {
        val flat = jsBox(options)
        if (flat != null) {
            val fromString = jsGetOptional(flat, "fromString") as? String
            if (fromString != null) {
                val trimmed = if (fromString.startsWith("?")) fromString.substring(1) else fromString
                if (trimmed.isNotEmpty()) {
                    for (part in trimmed.split("&")) {
                        if (part.isEmpty()) continue
                        val eq = part.indexOf('=')
                        if (eq >= 0) {
                            appendInPlace(jsDecodeURIComponent(part.substring(0, eq)), jsDecodeURIComponent(part.substring(eq + 1)))
                        } else {
                            appendInPlace(jsDecodeURIComponent(part), "")
                        }
                    }
                }
            } else {
                val fromObj = jsGetOptional(flat, "fromObject")
                val source: Any? = if (!jsIsNullish(fromObj)) fromObj else flat
                for (k in jsKeysOf(source)) {
                    if (k == "fromString" || k == "fromObject" || k == "encoder") continue
                    val v = jsGetOptional(source, k)
                    if (jsIsNullish(v)) continue
                    val box = jsBox(v)
                    if (box is JSArray<*>) {
                        storage[k] = box.storage.map { jsToString(it) }.toMutableList()
                    } else {
                        storage[k] = mutableListOf(jsToString(v))
                    }
                }
            }
        }
    }

    private fun appendInPlace(param: String, value: Any?) {
        storage.getOrPut(param) { mutableListOf() }.add(jsToString(value))
    }

    private fun cloned(): HttpParams {
        val copy = HttpParams()
        for ((k, v) in storage) copy.storage[k] = v.toMutableList()
        return copy
    }

    fun has(param: String): Boolean = storage.containsKey(param)

    fun get(param: String): String? = storage[param]?.firstOrNull()

    fun getAll(param: String): JSArray<String>? {
        val vals = storage[param] ?: return null
        return JSArray(vals.toMutableList())
    }

    fun keys(): JSArray<String> = JSArray(storage.keys.toMutableList())

    fun append(param: String, value: Any?): HttpParams {
        val next = cloned()
        next.appendInPlace(param, value)
        return next
    }

    fun appendAll(params: Any?): HttpParams {
        val next = cloned()
        val flat = jsBox(params) ?: return next
        for (k in jsKeysOf(flat)) {
            val v = jsGetOptional(flat, k)
            if (jsIsNullish(v)) continue
            val box = jsBox(v)
            if (box is JSArray<*>) {
                for (item in box.storage) next.appendInPlace(k, item)
            } else {
                next.appendInPlace(k, v)
            }
        }
        return next
    }

    fun set(param: String, value: Any?): HttpParams {
        val next = cloned()
        next.storage[param] = mutableListOf(jsToString(value))
        return next
    }

    fun delete(param: String, value: Any? = null): HttpParams {
        val next = cloned()
        if (jsIsNullish(value)) {
            next.storage.remove(param)
        } else {
            val existing = next.storage[param]
            if (existing != null) {
                val target = jsToString(value)
                val filtered = existing.filter { it != target }.toMutableList()
                if (filtered.isEmpty()) next.storage.remove(param)
                else next.storage[param] = filtered
            }
        }
        return next
    }

    override fun toString(): String {
        val parts = mutableListOf<String>()
        for ((k, vals) in storage) {
            val ek = jsEncodeURIComponent(k)
            for (v in vals) {
                parts.add("$ek=${jsEncodeURIComponent(v)}")
            }
        }
        return parts.joinToString("&")
    }
}

class HttpContextToken(val defaultValue: () -> Any?)

class HttpContext {
    private val map = IdentityHashMap<HttpContextToken, Any?>()
    fun set(token: HttpContextToken, value: Any?): HttpContext {
        map[token] = value
        return this
    }
    fun get(token: HttpContextToken): Any? {
        if (!map.containsKey(token)) map[token] = token.defaultValue()
        return map[token]
    }
    fun delete(token: HttpContextToken): HttpContext {
        map.remove(token)
        return this
    }
    fun has(token: HttpContextToken): Boolean = map.containsKey(token)
}

class HttpResponse(options: Any? = null) {
    val body: Any?
    val headers: HttpHeaders
    val status: Double
    val statusText: String
    val url: String?
    val ok: Boolean
    val type: Double = 4.0

    init {
        val flat = jsBox(options)
        body = jsGetOptional(flat, "body")
        val h = jsBox(jsGetOptional(flat, "headers"))
        headers = (h as? HttpHeaders) ?: HttpHeaders(h)
        val st = jsGetOptional(flat, "status").let { if (jsIsNullish(it)) 200.0 else jsToNumber(it) }
        status = st
        statusText = (jsGetOptional(flat, "statusText") as? String) ?: "OK"
        url = jsGetOptional(flat, "url") as? String
        ok = st >= 200.0 && st < 300.0
    }

    fun clone(update: Any? = null): HttpResponse {
        val flat = jsBox(update)
        val hasBody = flat is JSDynamic && "body" in flat.jsKeys
        val nextBody = if (hasBody) jsGetOptional(flat, "body") else body
        val nextHeaders = (jsBox(jsGetOptional(flat, "headers")) as? HttpHeaders) ?: headers
        val nextStatus = jsGetOptional(flat, "status").let { if (jsIsNullish(it)) status else jsToNumber(it) }
        val nextStatusText = (jsGetOptional(flat, "statusText") as? String) ?: statusText
        val nextUrl = (jsGetOptional(flat, "url") as? String) ?: url
        return HttpResponse(JSObject(
            "body" to nextBody,
            "headers" to nextHeaders,
            "status" to nextStatus,
            "statusText" to nextStatusText,
            "url" to nextUrl,
        ))
    }
}

class HttpErrorResponse(options: Any? = null) : JSError(
    run {
        val flat = jsBox(options)
        val st = jsGetOptional(flat, "status").let { if (jsIsNullish(it)) 0.0 else jsToNumber(it) }
        val stText = (jsGetOptional(flat, "statusText") as? String) ?: "Unknown Error"
        val u = (jsGetOptional(flat, "url") as? String) ?: "(unknown url)"
        "Http failure response for $u: ${jsToString(st)} $stText"
    }
) {
    val error: Any?
    val headers: HttpHeaders
    val status: Double
    val statusText: String
    val url: String?
    val ok: Boolean = false

    init {
        name = "HttpErrorResponse"
        val flat = jsBox(options)
        error = jsGetOptional(flat, "error")
        val h = jsBox(jsGetOptional(flat, "headers"))
        headers = (h as? HttpHeaders) ?: HttpHeaders(h)
        status = jsGetOptional(flat, "status").let { if (jsIsNullish(it)) 0.0 else jsToNumber(it) }
        statusText = (jsGetOptional(flat, "statusText") as? String) ?: "Unknown Error"
        url = jsGetOptional(flat, "url") as? String
    }
}

class HttpRequest(
    method: String,
    val url: String,
    third: Any? = null,
    fourth: Any? = null,
) {
    val method: String = method.uppercase()
    val body: Any?
    val headers: HttpHeaders
    val params: HttpParams
    val context: HttpContext
    val responseType: String
    val withCredentials: Boolean
    val reportProgress: Boolean

    init {
        val hasBody = fourth != null || this.method == "POST" || this.method == "PUT" || this.method == "PATCH" || this.method == "JSONP"
        body = if (hasBody) third else null
        val opt = jsBox(if (hasBody) fourth else third)
        val h = jsBox(jsGetOptional(opt, "headers"))
        headers = (h as? HttpHeaders) ?: HttpHeaders(h)
        val p = jsBox(jsGetOptional(opt, "params"))
        params = (p as? HttpParams) ?: HttpParams(p)
        context = (jsBox(jsGetOptional(opt, "context")) as? HttpContext) ?: HttpContext()
        responseType = (jsGetOptional(opt, "responseType") as? String) ?: "json"
        withCredentials = jsTruthy(jsGetOptional(opt, "withCredentials") ?: false)
        reportProgress = jsTruthy(jsGetOptional(opt, "reportProgress") ?: false)
    }

    val urlWithParams: String
        get() {
            val q = params.toString()
            if (q.isEmpty()) return url
            return if (url.contains("?")) "$url&$q" else "$url?$q"
        }

    fun clone(update: Any? = null): HttpRequest {
        val flat = jsBox(update)
        val nextMethod = (jsGetOptional(flat, "method") as? String) ?: method
        val nextUrl = (jsGetOptional(flat, "url") as? String) ?: url
        val hasBody = flat is JSDynamic && "body" in flat.jsKeys
        val nextBody = if (hasBody) jsGetOptional(flat, "body") else body
        var nextHeaders = (jsBox(jsGetOptional(flat, "headers")) as? HttpHeaders) ?: headers
        val setHeaders = jsBox(jsGetOptional(flat, "setHeaders"))
        if (setHeaders != null) {
            for (k in jsKeysOf(setHeaders)) {
                nextHeaders = nextHeaders.set(k, jsGetOptional(setHeaders, k))
            }
        }
        var nextParams = (jsBox(jsGetOptional(flat, "params")) as? HttpParams) ?: params
        val setParams = jsBox(jsGetOptional(flat, "setParams"))
        if (setParams != null) {
            for (k in jsKeysOf(setParams)) {
                nextParams = nextParams.set(k, jsGetOptional(setParams, k))
            }
        }
        val nextContext = (jsBox(jsGetOptional(flat, "context")) as? HttpContext) ?: context
        val nextRespType = (jsGetOptional(flat, "responseType") as? String) ?: responseType
        val nextCreds = jsGetOptional(flat, "withCredentials")?.let { jsTruthy(it) } ?: withCredentials
        val nextProg = jsGetOptional(flat, "reportProgress")?.let { jsTruthy(it) } ?: reportProgress
        return HttpRequest(nextMethod, nextUrl, nextBody, JSObject(
            "headers" to nextHeaders,
            "params" to nextParams,
            "context" to nextContext,
            "responseType" to nextRespType,
            "withCredentials" to nextCreds,
            "reportProgress" to nextProg,
        ))
    }
}

val HTTP_INTERCEPTORS = InjectionToken("HTTP_INTERCEPTORS")

val HttpStatusCode = JSObject(
    "Continue" to 100.0,
    "SwitchingProtocols" to 101.0,
    "Ok" to 200.0,
    "Created" to 201.0,
    "Accepted" to 202.0,
    "NoContent" to 204.0,
    "MovedPermanently" to 301.0,
    "Found" to 302.0,
    "NotModified" to 304.0,
    "BadRequest" to 400.0,
    "Unauthorized" to 401.0,
    "Forbidden" to 403.0,
    "NotFound" to 404.0,
    "MethodNotAllowed" to 405.0,
    "Conflict" to 409.0,
    "UnprocessableEntity" to 422.0,
    "TooManyRequests" to 429.0,
    "InternalServerError" to 500.0,
    "BadGateway" to 502.0,
    "ServiceUnavailable" to 503.0,
    "GatewayTimeout" to 504.0,
)

fun withInterceptors(fns: Any?): Any? = JSObject("__kind" to "withInterceptors", "fns" to fns)
fun withInterceptorsFromDi(): Any? = JSObject("__kind" to "withInterceptorsFromDi")
fun withFetch(): Any? = JSObject("__kind" to "withFetch")
fun provideHttpClient(@Suppress("UNUSED_PARAMETER") vararg features: Any?): Any? = JSArray<Any?>()
fun provideNativeScriptHttpClient(@Suppress("UNUSED_PARAMETER") vararg features: Any?): Any? = JSArray<Any?>()
fun provideNativeScriptNgZone(@Suppress("UNUSED_PARAMETER") options: Any? = null): Any? = JSArray<Any?>()
fun provideRouter(@Suppress("UNUSED_PARAMETER") routes: Any? = null, @Suppress("UNUSED_PARAMETER") vararg features: Any?): Any? = JSArray<Any?>()
fun provideNativeScriptRouter(@Suppress("UNUSED_PARAMETER") routes: Any? = null, @Suppress("UNUSED_PARAMETER") vararg features: Any?): Any? = JSArray<Any?>()

class HttpClientModule {
    companion object {
        fun forRoot(): Any? = JSObject("ngModule" to HttpClientModule::class.java)
    }
}
