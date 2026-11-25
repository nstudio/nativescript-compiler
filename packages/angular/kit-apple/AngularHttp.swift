import Foundation

// MARK: @angular/common/http value types

public final class HttpHeaders {
    nonisolated deinit {}
    private var storage: [String: [String]] = [:]
    private var originalNames: [String: String] = [:]
    private var keyOrder: [String] = []

    public init(_ headers: Any? = nil) {
        guard let flat = jsFlat(headers) else { return }
        if let str = flat as? String {
            for line in str.split(separator: "\n") {
                if let colon = line.firstIndex(of: ":") {
                    let name = line[..<colon].trimmingCharacters(in: .whitespacesAndNewlines)
                    let val = line[line.index(after: colon)...].trimmingCharacters(in: .whitespacesAndNewlines)
                    appendInPlace(name, val)
                }
            }
        } else {
            for k in jsKeysOf(flat) {
                let v = (try? jsGet(flat, k)) ?? nil
                guard !jsIsNullish(v) else { continue }
                let lower = k.lowercased()
                if originalNames[lower] == nil {
                    originalNames[lower] = k
                    keyOrder.append(lower)
                }
                if let arr = jsFlat(v) as? JSArrayProtocol {
                    storage[lower] = arr.jsAnyElements.map { jsToString($0) }
                } else {
                    storage[lower] = [jsToString(v)]
                }
            }
        }
    }

    private func appendInPlace(_ name: String, _ value: Any?) {
        let lower = name.lowercased()
        if originalNames[lower] == nil {
            originalNames[lower] = name
            keyOrder.append(lower)
        }
        var list = storage[lower] ?? []
        if let arr = jsFlat(value) as? JSArrayProtocol {
            for item in arr.jsAnyElements { list.append(jsToString(item)) }
        } else {
            list.append(jsToString(value))
        }
        storage[lower] = list
    }

    private func cloned() -> HttpHeaders {
        let copy = HttpHeaders()
        copy.storage = storage
        copy.originalNames = originalNames
        copy.keyOrder = keyOrder
        return copy
    }

    public func has(_ name: String) -> Bool {
        storage[name.lowercased()] != nil
    }

    public func get(_ name: String) -> String? {
        storage[name.lowercased()]?.first
    }

    public func keys() -> JSArray<String> {
        JSArray(keyOrder.compactMap { originalNames[$0] })
    }

    public func getAll(_ name: String) -> JSArray<String>? {
        guard let vals = storage[name.lowercased()] else { return nil }
        return JSArray(vals)
    }

    public func append(_ name: String, _ value: Any?) -> HttpHeaders {
        let next = cloned()
        next.appendInPlace(name, value)
        return next
    }

    public func set(_ name: String, _ value: Any?) -> HttpHeaders {
        let next = cloned()
        let lower = name.lowercased()
        if next.originalNames[lower] == nil {
            next.keyOrder.append(lower)
        }
        next.originalNames[lower] = name
        if let arr = jsFlat(value) as? JSArrayProtocol {
            next.storage[lower] = arr.jsAnyElements.map { jsToString($0) }
        } else {
            next.storage[lower] = [jsToString(value)]
        }
        return next
    }

    public func delete(_ name: String, _ value: Any? = nil) -> HttpHeaders {
        let next = cloned()
        let lower = name.lowercased()
        if jsIsNullish(value) {
            next.storage.removeValue(forKey: lower)
            next.originalNames.removeValue(forKey: lower)
            next.keyOrder.removeAll { $0 == lower }
        } else if let existing = next.storage[lower] {
            let removeSet: Set<String>
            if let arr = jsFlat(value) as? JSArrayProtocol {
                removeSet = Set(arr.jsAnyElements.map { jsToString($0) })
            } else {
                removeSet = [jsToString(value)]
            }
            let filtered = existing.filter { !removeSet.contains($0) }
            if filtered.isEmpty {
                next.storage.removeValue(forKey: lower)
                next.originalNames.removeValue(forKey: lower)
                next.keyOrder.removeAll { $0 == lower }
            } else {
                next.storage[lower] = filtered
            }
        }
        return next
    }

    public func toJSObject() -> JSObject {
        var pairs: [(String, Any?)] = []
        for lower in keyOrder {
            if let orig = originalNames[lower], let vals = storage[lower] {
                pairs.append((orig, vals.joined(separator: ", ")))
            }
        }
        return JSObject(pairs)
    }
}

public final class HttpParams {
    nonisolated deinit {}
    private var storage: [String: [String]] = [:]
    private var keyOrder: [String] = []

    public init(_ options: Any? = nil) {
        guard let flat = jsFlat(options) else { return }
        if let fromString = (try? jsGet(flat, "fromString")) as? String {
            let trimmed = fromString.hasPrefix("?") ? String(fromString.dropFirst()) : fromString
            if !trimmed.isEmpty {
                for part in trimmed.split(separator: "&") {
                    let s = String(part)
                    if let eq = s.firstIndex(of: "=") {
                        let k = String(s[..<eq]).removingPercentEncoding ?? String(s[..<eq])
                        let v = String(s[s.index(after: eq)...]).removingPercentEncoding ?? String(s[s.index(after: eq)...])
                        appendInPlace(k, v)
                    } else {
                        appendInPlace(s.removingPercentEncoding ?? s, "")
                    }
                }
            }
        } else {
            let fromObj = (try? jsGet(flat, "fromObject")) ?? nil
            let source: Any? = !jsIsNullish(fromObj) ? fromObj : flat
            for k in jsKeysOf(source) {
                if k == "fromString" || k == "fromObject" || k == "encoder" { continue }
                let v = (try? jsGet(source, k)) ?? nil
                guard !jsIsNullish(v) else { continue }
                if !keyOrder.contains(k) { keyOrder.append(k) }
                if let arr = jsFlat(v) as? JSArrayProtocol {
                    storage[k] = arr.jsAnyElements.map { jsToString($0) }
                } else {
                    storage[k] = [jsToString(v)]
                }
            }
        }
    }

    private func appendInPlace(_ param: String, _ value: Any?) {
        if !keyOrder.contains(param) { keyOrder.append(param) }
        var list = storage[param] ?? []
        list.append(jsToString(value))
        storage[param] = list
    }

    private func cloned() -> HttpParams {
        let copy = HttpParams()
        copy.storage = storage
        copy.keyOrder = keyOrder
        return copy
    }

    public func has(_ param: String) -> Bool {
        storage[param] != nil
    }

    public func get(_ param: String) -> String? {
        storage[param]?.first
    }

    public func getAll(_ param: String) -> JSArray<String>? {
        guard let vals = storage[param] else { return nil }
        return JSArray(vals)
    }

    public func keys() -> JSArray<String> {
        JSArray(keyOrder)
    }

    public func append(_ param: String, _ value: Any?) -> HttpParams {
        let next = cloned()
        next.appendInPlace(param, value)
        return next
    }

    public func appendAll(_ params: Any?) -> HttpParams {
        let next = cloned()
        guard let flat = jsFlat(params) else { return next }
        for k in jsKeysOf(flat) {
            let v = (try? jsGet(flat, k)) ?? nil
            guard !jsIsNullish(v) else { continue }
            if let arr = jsFlat(v) as? JSArrayProtocol {
                for item in arr.jsAnyElements { next.appendInPlace(k, item) }
            } else {
                next.appendInPlace(k, v)
            }
        }
        return next
    }

    public func set(_ param: String, _ value: Any?) -> HttpParams {
        let next = cloned()
        if !next.keyOrder.contains(param) { next.keyOrder.append(param) }
        next.storage[param] = [jsToString(value)]
        return next
    }

    public func delete(_ param: String, _ value: Any? = nil) -> HttpParams {
        let next = cloned()
        if jsIsNullish(value) {
            next.storage.removeValue(forKey: param)
            next.keyOrder.removeAll { $0 == param }
        } else if let existing = next.storage[param] {
            let target = jsToString(value)
            let filtered = existing.filter { $0 != target }
            if filtered.isEmpty {
                next.storage.removeValue(forKey: param)
                next.keyOrder.removeAll { $0 == param }
            } else {
                next.storage[param] = filtered
            }
        }
        return next
    }

    public func toString() -> String {
        var parts: [String] = []
        for k in keyOrder {
            guard let vals = storage[k] else { continue }
            let ek = jsEncodeURIComponent(k)
            for v in vals {
                parts.append("\(ek)=\(jsEncodeURIComponent(v))")
            }
        }
        return parts.joined(separator: "&")
    }
}

public final class HttpContextToken {
    nonisolated deinit {}
    public let defaultValue: () -> Any?
    public init(_ defaultValue: @escaping () throws -> Any?) {
        self.defaultValue = { jsReported { try defaultValue() } ?? nil }
    }
}

public final class HttpContext {
    nonisolated deinit {}
    private var map: [ObjectIdentifier: Any?] = [:]
    public init() {}
    @discardableResult
    public func set(_ token: HttpContextToken, _ value: Any?) -> HttpContext {
        map[ObjectIdentifier(token)] = value
        return self
    }
    public func get(_ token: HttpContextToken) -> Any? {
        let key = ObjectIdentifier(token)
        if let val = map[key] { return val }
        let def = token.defaultValue()
        map[key] = def
        return def
    }
    @discardableResult
    public func delete(_ token: HttpContextToken) -> HttpContext {
        map.removeValue(forKey: ObjectIdentifier(token))
        return self
    }
    public func has(_ token: HttpContextToken) -> Bool {
        map[ObjectIdentifier(token)] != nil
    }
}

public final class HttpResponse {
    nonisolated deinit {}
    public let body: Any?
    public let headers: HttpHeaders
    public let status: Double
    public let statusText: String
    public let url: String?
    public let ok: Bool
    public let type: Double = 4

    public init(_ options: Any? = nil) {
        let flat = jsFlat(options)
        self.body = (try? jsGet(flat, "body")) ?? nil
        self.headers = (jsFlat((try? jsGet(flat, "headers")) ?? nil) as? HttpHeaders) ?? HttpHeaders((try? jsGet(flat, "headers")) ?? nil)
        let st = (try? jsGet(flat, "status")).flatMap { jsIsNullish($0) ? nil : jsToNumber($0) } ?? 200
        self.status = st
        self.statusText = ((try? jsGet(flat, "statusText")) as? String) ?? "OK"
        self.url = (try? jsGet(flat, "url")) as? String
        self.ok = st >= 200 && st < 300
    }

    public func clone(_ update: Any? = nil) -> HttpResponse {
        let flat = jsFlat(update)
        let hasBody = (flat as? JSObject)?.has("body") == true || (flat as? JSDynamic).map { jsHasKey($0, "body") } == true
        let nextBody = hasBody ? ((try? jsGet(flat, "body")) ?? nil) : body
        let nextHeaders = (jsFlat((try? jsGet(flat, "headers")) ?? nil) as? HttpHeaders) ?? headers
        let nextStatus = (try? jsGet(flat, "status")).flatMap { jsIsNullish($0) ? nil : jsToNumber($0) } ?? status
        let nextStatusText = ((try? jsGet(flat, "statusText")) as? String) ?? statusText
        let nextUrl = ((try? jsGet(flat, "url")) as? String) ?? url
        return HttpResponse(JSObject([
            ("body", nextBody),
            ("headers", nextHeaders),
            ("status", nextStatus),
            ("statusText", nextStatusText),
            ("url", nextUrl),
        ]))
    }
}

public final class HttpErrorResponse: JSError {
    nonisolated deinit {}
    public let error: Any?
    public let headers: HttpHeaders
    public let status: Double
    public let statusText: String
    public let url: String?
    public let ok = false

    public init(_ options: Any? = nil) {
        let flat = jsFlat(options)
        let st = (try? jsGet(flat, "status")).flatMap { jsIsNullish($0) ? nil : jsToNumber($0) } ?? 0
        let stText = ((try? jsGet(flat, "statusText")) as? String) ?? "Unknown Error"
        let u = (try? jsGet(flat, "url")) as? String
        self.error = (try? jsGet(flat, "error")) ?? nil
        self.headers = (jsFlat((try? jsGet(flat, "headers")) ?? nil) as? HttpHeaders) ?? HttpHeaders((try? jsGet(flat, "headers")) ?? nil)
        self.status = st
        self.statusText = stText
        self.url = u
        super.init("Http failure response for \(u ?? "(unknown url)"): \(jsToString(st)) \(stText)")
        self.name = "HttpErrorResponse"
    }
}

public final class HttpRequest {
    nonisolated deinit {}
    public let method: String
    public let url: String
    public let body: Any?
    public let headers: HttpHeaders
    public let params: HttpParams
    public let context: HttpContext
    public let responseType: String
    public let withCredentials: Bool
    public let reportProgress: Bool

    public init(_ method: String, _ url: String, _ third: Any? = nil, _ fourth: Any? = nil) {
        let upper = method.uppercased()
        self.method = upper
        self.url = url
        let hasBody = fourth != nil || upper == "POST" || upper == "PUT" || upper == "PATCH" || upper == "JSONP"
        self.body = hasBody ? third : nil
        let opt = jsFlat(hasBody ? fourth : third)
        self.headers = (jsFlat((try? jsGet(opt, "headers")) ?? nil) as? HttpHeaders) ?? HttpHeaders((try? jsGet(opt, "headers")) ?? nil)
        self.params = (jsFlat((try? jsGet(opt, "params")) ?? nil) as? HttpParams) ?? HttpParams((try? jsGet(opt, "params")) ?? nil)
        self.context = (jsFlat((try? jsGet(opt, "context")) ?? nil) as? HttpContext) ?? HttpContext()
        self.responseType = ((try? jsGet(opt, "responseType")) as? String) ?? "json"
        self.withCredentials = jsTruthy((try? jsGet(opt, "withCredentials")) ?? false)
        self.reportProgress = jsTruthy((try? jsGet(opt, "reportProgress")) ?? false)
    }

    public var urlWithParams: String {
        let q = params.toString()
        if q.isEmpty { return url }
        return url.contains("?") ? "\(url)&\(q)" : "\(url)?\(q)"
    }

    public func clone(_ update: Any? = nil) -> HttpRequest {
        let flat = jsFlat(update)
        let nextMethod = ((try? jsGet(flat, "method")) as? String) ?? method
        let nextUrl = ((try? jsGet(flat, "url")) as? String) ?? url
        let hasBody = (flat as? JSObject)?.has("body") == true || (flat as? JSDynamic).map { jsHasKey($0, "body") } == true
        let nextBody = hasBody ? ((try? jsGet(flat, "body")) ?? nil) : body
        var nextHeaders = (jsFlat((try? jsGet(flat, "headers")) ?? nil) as? HttpHeaders) ?? headers
        if let setHeaders = jsFlat((try? jsGet(flat, "setHeaders")) ?? nil) {
            for k in jsKeysOf(setHeaders) {
                nextHeaders = nextHeaders.set(k, (try? jsGet(setHeaders, k)) ?? nil)
            }
        }
        var nextParams = (jsFlat((try? jsGet(flat, "params")) ?? nil) as? HttpParams) ?? params
        if let setParams = jsFlat((try? jsGet(flat, "setParams")) ?? nil) {
            for k in jsKeysOf(setParams) {
                nextParams = nextParams.set(k, (try? jsGet(setParams, k)) ?? nil)
            }
        }
        let nextContext = (jsFlat((try? jsGet(flat, "context")) ?? nil) as? HttpContext) ?? context
        let nextRespType = ((try? jsGet(flat, "responseType")) as? String) ?? responseType
        let nextCreds = (try? jsGet(flat, "withCredentials")).map { jsTruthy($0) } ?? withCredentials
        let nextProg = (try? jsGet(flat, "reportProgress")).map { jsTruthy($0) } ?? reportProgress
        return HttpRequest(nextMethod, nextUrl, nextBody, JSObject([
            ("headers", nextHeaders),
            ("params", nextParams),
            ("context", nextContext),
            ("responseType", nextRespType),
            ("withCredentials", nextCreds),
            ("reportProgress", nextProg),
        ]))
    }
}

public let HTTP_INTERCEPTORS = InjectionToken("HTTP_INTERCEPTORS")

public let HttpStatusCode = JSObject([
    ("Continue", 100.0),
    ("SwitchingProtocols", 101.0),
    ("Ok", 200.0),
    ("Created", 201.0),
    ("Accepted", 202.0),
    ("NoContent", 204.0),
    ("MovedPermanently", 301.0),
    ("Found", 302.0),
    ("NotModified", 304.0),
    ("BadRequest", 400.0),
    ("Unauthorized", 401.0),
    ("Forbidden", 403.0),
    ("NotFound", 404.0),
    ("MethodNotAllowed", 405.0),
    ("Conflict", 409.0),
    ("UnprocessableEntity", 422.0),
    ("TooManyRequests", 429.0),
    ("InternalServerError", 500.0),
    ("BadGateway", 502.0),
    ("ServiceUnavailable", 503.0),
    ("GatewayTimeout", 504.0),
])

public func withInterceptors(_ fns: Any?) -> Any? { JSObject([("__kind", "withInterceptors"), ("fns", fns)]) }
public func withInterceptorsFromDi() -> Any? { JSObject([("__kind", "withInterceptorsFromDi")]) }
public func withFetch() -> Any? { JSObject([("__kind", "withFetch")]) }
public func provideHttpClient(_ features: Any?...) -> Any? { JSArray<Any?>() }
public func provideNativeScriptHttpClient(_ features: Any?...) -> Any? { JSArray<Any?>() }
public func provideNativeScriptNgZone(_ options: Any? = nil) -> Any? { JSArray<Any?>() }
public func provideRouter(_ routes: Any? = nil, _ features: Any?...) -> Any? { JSArray<Any?>() }
public func provideNativeScriptRouter(_ routes: Any? = nil, _ features: Any?...) -> Any? { JSArray<Any?>() }

public final class HttpClientModule {
    nonisolated deinit {}
    public init() {}
    public static func forRoot() -> Any? { JSObject([("ngModule", HttpClientModule.self)]) }
}
