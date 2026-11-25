import Foundation

// MARK: @angular/router value types

public final class ParamMap {
    nonisolated deinit {}
    private var storage: [String: [String]] = [:]
    private var keyOrder: [String] = []

    public init(_ params: Any? = nil) {
        guard let flat = jsFlat(params) else { return }
        if let dict = flat as? [String: String] {
            for (k, v) in dict {
                keyOrder.append(k)
                storage[k] = [v]
            }
            return
        }
        for k in jsKeysOf(flat) {
            let v = (try? jsGet(flat, k)) ?? nil
            guard !jsIsNullish(v) else { continue }
            keyOrder.append(k)
            if let arr = jsFlat(v) as? JSArrayProtocol {
                storage[k] = arr.jsAnyElements.map { jsToString($0) }
            } else {
                storage[k] = [jsToString(v)]
            }
        }
    }

    public func has(_ name: String) -> Bool {
        storage[name] != nil
    }

    public func get(_ name: String) -> String? {
        storage[name]?.first
    }

    public func getAll(_ name: String) -> JSArray<String> {
        JSArray(storage[name] ?? [])
    }

    public var keys: JSArray<String> {
        JSArray(keyOrder)
    }
}

public func convertToParamMap(_ params: Any?) -> ParamMap {
    ParamMap(params)
}

public final class UrlSegment {
    nonisolated deinit {}
    public let path: String
    public let parameters: JSRecord<String>
    public let parameterMap: ParamMap

    public init(_ path: String, _ parameters: Any? = nil) {
        self.path = path
        var dict: [String: String] = [:]
        if let flat = jsFlat(parameters) {
            if let d = flat as? [String: String] {
                dict = d
            } else {
                for k in jsKeysOf(flat) {
                    if let v = try? jsGet(flat, k), !jsIsNullish(v) {
                        dict[k] = jsToString(v)
                    }
                }
            }
        }
        self.parameters = JSRecord(dict)
        self.parameterMap = ParamMap(dict)
    }

    public func toString() -> String { path }
}

public final class UrlTree {
    nonisolated deinit {}
    private let path: String
    public var queryParams: JSObject
    public var fragment: String?

    public init(_ path: String = "/", _ queryParams: Any? = nil, _ fragment: String? = nil) {
        self.path = path.isEmpty ? "/" : path
        if let obj = jsFlat(queryParams) as? JSObject {
            self.queryParams = obj
        } else if let flat = jsFlat(queryParams) {
            var pairs: [(String, Any?)] = []
            for k in jsKeysOf(flat) {
                pairs.append((k, (try? jsGet(flat, k)) ?? nil))
            }
            self.queryParams = JSObject(pairs)
        } else {
            self.queryParams = JSObject()
        }
        self.fragment = fragment
    }

    public var queryParamMap: ParamMap {
        ParamMap(queryParams)
    }

    public func toString() -> String {
        var qParts: [String] = []
        for k in jsKeysOf(queryParams) {
            if let v = try? jsGet(queryParams, k), !jsIsNullish(v) {
                qParts.append("\(jsEncodeURIComponent(k))=\(jsEncodeURIComponent(jsToString(v)))")
            }
        }
        let q = qParts.isEmpty ? "" : "?\(qParts.joined(separator: "&"))"
        let f = fragment.map { "#\($0)" } ?? ""
        return "\(path)\(q)\(f)"
    }
}

public final class DefaultUrlSerializer {
    nonisolated deinit {}
    public init() {}
    public func parse(_ url: String) -> UrlTree {
        var raw = url.isEmpty ? "/" : url
        var fragment: String? = nil
        if let hashIdx = raw.firstIndex(of: "#") {
            fragment = String(raw[raw.index(after: hashIdx)...])
            raw = String(raw[..<hashIdx])
        }
        var qPairs: [(String, Any?)] = []
        if let qIdx = raw.firstIndex(of: "?") {
            let qStr = String(raw[raw.index(after: qIdx)...])
            raw = String(raw[..<qIdx])
            for part in qStr.split(separator: "&") {
                let s = String(part)
                if s.isEmpty { continue }
                if let eq = s.firstIndex(of: "=") {
                    let k = String(s[..<eq]).removingPercentEncoding ?? String(s[..<eq])
                    let v = String(s[s.index(after: eq)...]).removingPercentEncoding ?? String(s[s.index(after: eq)...])
                    qPairs.append((k, v))
                } else {
                    qPairs.append((s.removingPercentEncoding ?? s, ""))
                }
            }
        }
        return UrlTree(raw.isEmpty ? "/" : raw, JSObject(qPairs), fragment)
    }
    public func serialize(_ tree: UrlTree) -> String {
        tree.toString()
    }
}

public final class ActivatedRouteSnapshot {
    nonisolated deinit {}
    public let params: JSRecord<String>
    public let queryParams: JSRecord<String>
    public let data: JSRecord<Any?>
    public let url: JSArray<UrlSegment>
    public let fragment: String?
    public let outlet: String
    public let routeConfig: JSObject?
    public var title: String?

    public init(
        params: JSRecord<String> = JSRecord([:]),
        queryParams: JSRecord<String> = JSRecord([:]),
        data: JSRecord<Any?> = JSRecord([:]),
        url: JSArray<UrlSegment> = JSArray(),
        fragment: String? = nil,
        outlet: String = "primary",
        routeConfig: JSObject? = nil
    ) {
        self.params = params
        self.queryParams = queryParams
        self.data = data
        self.url = url
        self.fragment = fragment
        self.outlet = outlet
        self.routeConfig = routeConfig
    }

    public var paramMap: ParamMap { ParamMap(params) }
    public var queryParamMap: ParamMap { ParamMap(queryParams) }
    public var root: ActivatedRouteSnapshot { self }
    public var parent: ActivatedRouteSnapshot? { nil }
    public var firstChild: ActivatedRouteSnapshot? { nil }
    public var children: JSArray<ActivatedRouteSnapshot> { JSArray() }
    public var pathFromRoot: JSArray<ActivatedRouteSnapshot> { JSArray([self]) }
}

public final class NavigationStart {
    nonisolated deinit {}
    public let id: Double
    public let url: String
    public let navigationTrigger: String = "imperative"
    public let restoredState: Any? = nil
    public init(_ id: Double, _ url: String) {
        self.id = id
        self.url = url
    }
}

/// `NavigationEnd`, the router event each completed navigation emits.
public final class NavigationEnd {
    nonisolated deinit {}
    public let id: Double
    public let url: String
    public let urlAfterRedirects: String
    public init(id: Double, url: String, urlAfterRedirects: String) {
        self.id = id
        self.url = url
        self.urlAfterRedirects = urlAfterRedirects
    }
    public convenience init(_ id: Double, _ url: String, _ urlAfterRedirects: String? = nil) {
        self.init(id: id, url: url, urlAfterRedirects: urlAfterRedirects ?? url)
    }
}

public final class NavigationCancel {
    nonisolated deinit {}
    public let id: Double
    public let url: String
    public let reason: String
    public init(_ id: Double, _ url: String, _ reason: String = "") {
        self.id = id
        self.url = url
        self.reason = reason
    }
}

public final class NavigationError {
    nonisolated deinit {}
    public let id: Double
    public let url: String
    public let error: Any?
    public init(_ id: Double, _ url: String, _ error: Any? = nil) {
        self.id = id
        self.url = url
        self.error = error
    }
}

public final class RoutesRecognized {
    nonisolated deinit {}
    public let id: Double
    public let url: String
    public let urlAfterRedirects: String
    public let state: Any?
    public init(_ id: Double, _ url: String, _ urlAfterRedirects: String? = nil, _ state: Any? = nil) {
        self.id = id
        self.url = url
        self.urlAfterRedirects = urlAfterRedirects ?? url
        self.state = state
    }
}

public final class ResolveStart {
    nonisolated deinit {}
    public let id: Double
    public let url: String
    public let urlAfterRedirects: String
    public let state: Any?
    public init(_ id: Double, _ url: String, _ urlAfterRedirects: String? = nil, _ state: Any? = nil) {
        self.id = id
        self.url = url
        self.urlAfterRedirects = urlAfterRedirects ?? url
        self.state = state
    }
}

public final class ResolveEnd {
    nonisolated deinit {}
    public let id: Double
    public let url: String
    public let urlAfterRedirects: String
    public let state: Any?
    public init(_ id: Double, _ url: String, _ urlAfterRedirects: String? = nil, _ state: Any? = nil) {
        self.id = id
        self.url = url
        self.urlAfterRedirects = urlAfterRedirects ?? url
        self.state = state
    }
}

public func createRouterStateSnapshot(_ url: String = "/") -> JSObject {
    JSObject([("url", url), ("root", ActivatedRouteSnapshot())])
}
