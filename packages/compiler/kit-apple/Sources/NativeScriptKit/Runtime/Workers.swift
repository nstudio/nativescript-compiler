import Foundation

// Web workers, URL and structured clone, matching Android's `Workers.kt`.

/// `URL`: an absolute URL, resolved against an optional base.
public final class JSURL: JSDynamic, JSStringConvertible, JSHostObject {
    nonisolated deinit {}
    public let href: String

    public init(_ url: Any?, _ base: Any? = nil) throws {
        let text = jsToString(url)
        let resolved: URL?
        if jsIsNullish(base) {
            if let u = URL(string: text), u.scheme != nil { resolved = u } else { resolved = nil }
        } else {
            let baseText = jsToString(base)
            if let b = URL(string: baseText), b.scheme != nil, let u = URL(string: text, relativeTo: b)?.absoluteURL {
                resolved = u
            } else {
                resolved = nil
            }
        }
        guard let finalURL = resolved else {
            throw JSException(JSTypeError("Invalid URL: \(text)"))
        }
        self.href = finalURL.absoluteString
    }

    public func toString() -> String { href }

    public subscript(jsKey key: String) -> Any? {
        get {
            switch key {
            case "href": return href
            case "toString": return { _, _ in self.href } as JSMethod
            default: return nil
            }
        }
        set {}
    }

    public var jsKeys: [String] { [] }
    public var jsClassName: String? { "URL" }
    public func jsInvoke(_ key: String, _ arguments: [Any?]) throws -> Any?? {
        key == "toString" ? .some(href) : nil
    }
}

/// `MessageEvent`: what a worker's message handler receives.
public final class JSMessageEvent: JSDynamic, JSHostObject {
    nonisolated deinit {}
    public let data: Any?

    public init(_ data: Any?) { self.data = data }

    public subscript(jsKey key: String) -> Any? {
        get { key == "data" ? data : nil }
        set {}
    }

    public var jsKeys: [String] { ["data"] }
    public var jsClassName: String? { "MessageEvent" }
    public func jsInvoke(_ key: String, _ arguments: [Any?]) throws -> Any?? { nil }
}

/// `ErrorEvent`: what a worker's error handler receives.
public final class JSErrorEvent: JSDynamic, JSHostObject {
    nonisolated deinit {}
    public let message: String

    public init(_ message: String) { self.message = message }

    public subscript(jsKey key: String) -> Any? {
        get { key == "message" ? message : nil }
        set {}
    }

    public var jsKeys: [String] { ["message"] }
    public var jsClassName: String? { "ErrorEvent" }
    public func jsInvoke(_ key: String, _ arguments: [Any?]) throws -> Any?? { nil }
}

/// Thread-safe registry of compiled worker scripts and currently running workers.
private nonisolated final class JSWorkerRegistry: @unchecked Sendable {
    let lock = NSLock()
    var scripts: [String: @Sendable () throws -> Void] = [:]
    var running: [String: JSWorker] = [:]
    var activeCount = 0
}

private nonisolated let workerRegistry = JSWorkerRegistry()

/// `Worker`: a compiled worker script on its own OS thread, in its own `JSRealm` (global object,
/// timers, microtasks). Messages pass between threads as structured clones (`jsStructuredClone`).
/// Also wraps a worker realm's global object via `JSWorker.fromAny(jsGlobalThis)` for `globalThis as Worker`.
public final class JSWorker: JSDynamic, JSHostObject, @unchecked Sendable {
    nonisolated deinit {}

    private var _onmessage: ((JSMessageEvent) throws -> Any?)?
    private var _onerror: ((JSErrorEvent) throws -> Any?)?

    public var onmessage: ((JSMessageEvent) throws -> Any?)? {
        get {
            if let scope {
                guard let fn = jsFlat(scope[jsKey: "onmessage"]), jsIsFunction(fn) else { return nil }
                return { event in try jsCall(fn, event) }
            }
            return _onmessage
        }
        set {
            if let scope {
                if let fn = newValue {
                    scope[jsKey: "onmessage"] = { (args: [Any?]) throws -> Any? in
                        let raw = jsArg(args, 0)
                        let ev = (jsFlat(raw) as? JSMessageEvent) ?? JSMessageEvent(jsField(raw, "data"))
                        return try fn(ev)
                    } as JSFunction
                } else {
                    scope[jsKey: "onmessage"] = nil
                }
            } else {
                _onmessage = newValue
            }
        }
    }

    public var onerror: ((JSErrorEvent) throws -> Any?)? {
        get {
            if let scope {
                guard let fn = jsFlat(scope[jsKey: "onerror"]), jsIsFunction(fn) else { return nil }
                return { event in try jsCall(fn, event) }
            }
            return _onerror
        }
        set {
            if let scope {
                if let fn = newValue {
                    scope[jsKey: "onerror"] = { (args: [Any?]) throws -> Any? in
                        let raw = jsArg(args, 0)
                        let ev = (jsFlat(raw) as? JSErrorEvent) ?? JSErrorEvent(jsToString(jsField(raw, "message")))
                        return try fn(ev)
                    } as JSFunction
                } else {
                    scope[jsKey: "onerror"] = nil
                }
            } else {
                _onerror = newValue
            }
        }
    }

    private let scope: JSObject?
    private let owner: JSRealm
    private let realm: JSRealm
    private let key: String
    private nonisolated let condition = NSCondition()
    private nonisolated(unsafe) var inbox: [@Sendable () throws -> Void] = []
    private nonisolated(unsafe) var terminated = false
    private nonisolated(unsafe) var closing = false
    private nonisolated(unsafe) var finished = false
    private nonisolated(unsafe) var wake: UInt64?

    private nonisolated var isLive: Bool { !terminated && !closing }

    /// Scope-backed worker wrapper (`globalThis as unknown as Worker` inside a worker script).
    private init(scope: JSObject) {
        self.scope = scope
        self.owner = JSRealm.current()
        self.realm = self.owner
        self.key = ""
        self.finished = true
    }

    /// Starts a compiled worker script on its own thread.
    public init(_ scriptURL: Any?, _ script: String? = nil) throws {
        guard let script, let entry = JSWorker.lookupScript(script) else {
            throw JSException(JSError("Worker script \(jsToString(scriptURL)) was not compiled with the app"))
        }
        let ownerRealm = JSRealm.current()
        guard ownerRealm.post != nil else {
            throw JSException(JSError("Worker: the creating thread has no event loop to receive messages"))
        }
        self.scope = nil
        self.owner = ownerRealm
        self.realm = JSRealm(isMain: false)
        self.key = script

        var previous: JSWorker?
        workerRegistry.lock.lock()
        if let current = workerRegistry.running[script], current.isLive {
            workerRegistry.lock.unlock()
            throw JSException(JSError("Worker script \(script) already runs in a worker. Its module state is shared, so one worker runs it at a time: terminate() the first, or close() it from inside, before starting another"))
        }
        previous = workerRegistry.running[script]
        workerRegistry.running[script] = self
        workerRegistry.activeCount += 1
        workerRegistry.lock.unlock()

        let selfRef = self
        realm.global["postMessage"] = { _, a in
            try selfRef.fromWorker(jsArg(a, 0), jsArg(a, 1))
            return nil
        } as JSMethod
        realm.global["close"] = { _, _ in
            selfRef.markClosing()
            return nil
        } as JSMethod
        realm.global["self"] = realm.global
        realm.global["global"] = realm.global
        realm.uncaught = { error in selfRef.toOwner(error) }
        realm.post = { job in selfRef.enqueue(job) }
        realm.loop.host = { delay in
            if let delay {
                let ns = UInt64(max(0.0, Foundation.ceil(delay)) * 1_000_000.0)
                selfRef.wake = DispatchTime.now().uptimeNanoseconds &+ ns
            } else {
                selfRef.wake = nil
            }
        }
        realm.microtasks.onEnqueue = {
            selfRef.enqueue {
                jsRunInWorker { selfRef.realm.microtasks.checkpoint() }
            }
        }

        let prev = previous
        let thread = Thread {
            selfRef.runLoop(entry: entry, previous: prev)
        }
        thread.name = "JSWorker \(script)"
        thread.start()
    }

    private nonisolated static func lookupScript(_ script: String) -> (@Sendable () throws -> Void)? {
        workerRegistry.lock.lock()
        defer { workerRegistry.lock.unlock() }
        return workerRegistry.scripts[script]
    }

    /// Whether any worker thread is currently active (used by `JSEventLoop.runUntilIdle`).
    public nonisolated static var hasActiveWorkers: Bool {
        workerRegistry.lock.lock()
        defer { workerRegistry.lock.unlock() }
        return workerRegistry.activeCount > 0
    }

    /// Waits for this worker's OS thread to exit.
    public nonisolated func join() {
        condition.lock()
        while !finished { condition.wait() }
        condition.unlock()
    }

    private nonisolated func enqueue(_ job: @escaping @Sendable () throws -> Void) {
        condition.lock()
        if !terminated {
            inbox.append(job)
            condition.signal()
        }
        condition.unlock()
    }

    private nonisolated func markClosing() {
        condition.lock()
        closing = true
        condition.signal()
        condition.unlock()
    }

    private nonisolated func runLoop(entry: @escaping @Sendable () throws -> Void, previous: JSWorker?) {
        previous?.join()
        JSRealm.enter(realm)
        defer {
            JSRealm.leave()
            condition.lock()
            inbox.removeAll()
            finished = true
            condition.broadcast()
            condition.unlock()
            workerRegistry.lock.lock()
            if workerRegistry.running[key] === self { workerRegistry.running.removeValue(forKey: key) }
            workerRegistry.activeCount -= 1
            workerRegistry.lock.unlock()
            JSPosted.arrived.signal()
        }

        if isLive {
            runTask { try entry() }
        }

        while true {
            condition.lock()
            if !isLive {
                condition.unlock()
                break
            }
            if !inbox.isEmpty {
                let job = inbox.removeFirst()
                condition.unlock()
                runTask { try job() }
                continue
            }
            if let due = wake {
                let now = DispatchTime.now().uptimeNanoseconds
                if now >= due {
                    wake = nil
                    condition.unlock()
                    runTask { self.realm.loop.processTimers() }
                    continue
                }
                let remaining = Double(due - now) / 1_000_000_000.0
                condition.wait(until: Date(timeIntervalSinceNow: remaining))
                condition.unlock()
            } else {
                condition.wait()
                condition.unlock()
            }
        }
    }

    private nonisolated func runTask(_ body: @escaping @MainActor () throws -> Void) {
        jsRunInWorker {
            do {
                try body()
            } catch {
                self.toOwner(jsCaught(error))
            }
            if self.terminated { return }
            self.realm.microtasks.taskRan()
            self.realm.microtasks.checkpoint()
        }
    }

    /// `worker.postMessage(message, transfer)`: clones `message` (moving transferred buffers) onto the worker thread.
    public func postMessage(_ message: Any?, _ transfer: Any? = nil) throws {
        if let scope {
            if jsIsNullish(transfer) {
                _ = try jsCallMethod(scope, "postMessage", message)
            } else {
                _ = try jsCallMethod(scope, "postMessage", message, transfer)
            }
            return
        }
        guard isLive else { return }
        var seen = try jsTransferred(transfer)
        let cloned = try jsStructuredClone(message, seen: &seen)
        let carried = JSCarried(cloned)
        enqueue {
            try jsRunInWorker {
                let handler = self.realm.global["onmessage"]
                if !jsIsNullish(handler) {
                    _ = try jsCall(handler, JSMessageEvent(carried.value))
                }
            }
        }
    }

    private func fromWorker(_ message: Any?, _ transfer: Any?) throws {
        var seen = try jsTransferred(transfer)
        let cloned = try jsStructuredClone(message, seen: &seen)
        guard isLive else { return }
        let carried = JSCarried(cloned)
        if let post = owner.post {
            post {
                jsRunInWorker {
                    if !self.terminated {
                        self.ownerTask { _ = try self.onmessage?(JSMessageEvent(carried.value)) }
                    }
                }
            }
        }
    }

    private func toOwner(_ error: Any?) {
        guard isLive else { return }
        let message = "Uncaught \(jsToString(error))"
        let reported: Any?
        do {
            var seen: [ObjectIdentifier: Any?] = [:]
            reported = try jsStructuredClone(error, seen: &seen)
        } catch {
            reported = message
        }
        let carried = JSCarried(reported)
        if let post = owner.post {
            post {
                jsRunInWorker {
                    if !self.terminated {
                        self.ownerTask {
                            let handled = try self.onerror?(JSErrorEvent(message))
                            if (handled as? Bool) != true {
                                self.reportUncaught(carried.value)
                            }
                        }
                    }
                }
            }
        }
    }

    private func ownerTask(_ body: () throws -> Void) {
        do {
            try body()
        } catch {
            reportUncaught(jsCaught(error))
        }
        Microtasks.taskRan()
        Microtasks.checkpoint()
    }

    private func reportUncaught(_ error: Any?) {
        jsReportUncaught(error)
    }

    /// `terminate()`: stops the worker and drops queued messages and timers.
    public func terminate() {
        if let scope {
            _ = try? jsCallMethod(scope, "close")
            return
        }
        condition.lock()
        if terminated {
            condition.unlock()
            return
        }
        terminated = true
        inbox.removeAll()
        condition.broadcast()
        condition.unlock()
    }

    /// `close()`: on a worker global scope, stops the worker after the current task.
    public func close() {
        if let scope {
            _ = try? jsCallMethod(scope, "close")
        } else {
            terminate()
        }
    }

    public subscript(jsKey key: String) -> Any? {
        get {
            if let scope { return scope[jsKey: key] }
            switch key {
            case "postMessage":
                return { _, a in try self.postMessage(jsArg(a, 0), jsArg(a, 1)); return nil } as JSMethod
            case "terminate":
                return { _, _ in self.terminate(); return nil } as JSMethod
            case "onmessage":
                return onmessage
            case "onerror":
                return onerror
            default:
                return nil
            }
        }
        set {
            if let scope {
                scope[jsKey: key] = newValue
                return
            }
            let flat = jsFlat(newValue)
            switch key {
            case "onmessage":
                if let flat, jsIsFunction(flat) {
                    onmessage = { event in try jsCall(flat, event) }
                } else {
                    onmessage = nil
                }
            case "onerror":
                if let flat, jsIsFunction(flat) {
                    onerror = { event in try jsCall(flat, event) }
                } else {
                    onerror = nil
                }
            default:
                break
            }
        }
    }

    public var jsKeys: [String] { scope?.jsKeys ?? [] }
    public var jsClassName: String? { "Worker" }
    public func jsInvoke(_ key: String, _ arguments: [Any?]) throws -> Any?? {
        if scope != nil { return nil }
        switch key {
        case "postMessage":
            try postMessage(jsArg(arguments, 0), jsArg(arguments, 1))
            return .some(nil)
        case "terminate":
            terminate()
            return .some(nil)
        case "close":
            close()
            return .some(nil)
        default:
            return nil
        }
    }

    /// Registers a compiled worker script's module initializer by its app-relative path.
    public static func register(_ script: String, _ entry: @escaping () throws -> Void) {
        let carried = JSCarried(entry)
        workerRegistry.lock.lock()
        workerRegistry.scripts[script] = { try jsRunInWorker { try carried.value() } }
        workerRegistry.lock.unlock()
    }

    /// `globalThis as Worker` inside a worker script: wraps the worker realm's global object as a `JSWorker`.
    public static func fromAny(_ value: Any?) throws -> JSWorker {
        if let worker = fromAnyOrNil(value) { return worker }
        throw JSException(JSTypeError("\(jsTypeof(value)) is not a JSWorker"))
    }

    /// Non-throwing `JSWorker` conversion for optional/shape fields.
    public static func fromAnyOrNil(_ value: Any?) -> JSWorker? {
        let flat = jsFlat(value)
        if let w = flat as? JSWorker { return w }
        if let obj = flat as? JSObject { return JSWorker(scope: obj) }
        return nil
    }
}

/// HTML StructuredSerialize/Deserialize in one step: deep-copies plain data, buffers, typed arrays,
/// Date, RegExp, Array, Map, Set, and standard Errors, preserving cycles and shared buffer views;
/// refuses functions, symbols, and host objects with `DataCloneError`.
public func jsStructuredClone(_ value: Any?) throws -> Any? {
    var seen: [ObjectIdentifier: Any?] = [:]
    return try jsStructuredClone(value, seen: &seen)
}

func jsStructuredClone(_ value: Any?, seen: inout [ObjectIdentifier: Any?]) throws -> Any? {
    let flat = jsFlat(value)
    guard let v = flat else { return nil }
    if v is JSNull || v is String || v is Double || v is Bool || v is JSBigInt { return v }
    if let n = jsNumeric(v) { return n }

    let fail: () throws -> Never = {
        throw JSException(JSDOMException("\(type(of: v)) could not be cloned.", "DataCloneError"))
    }
    if jsIsFunction(v) { try fail() }

    if let obj = v as AnyObject? {
        let id = ObjectIdentifier(obj)
        if let existing = seen[id] { return existing }
    }

    if let buf = v as? JSArrayBuffer {
        if buf.detached {
            throw JSException(JSDOMException("An ArrayBuffer is detached and could not be cloned.", "DataCloneError"))
        }
        let copy = buf.slice()
        seen[ObjectIdentifier(buf)] = copy
        return copy
    }
    if let ta = v as? JSTypedArrayProtocol {
        guard let clonedBuf = try jsStructuredClone(ta.buffer, seen: &seen) as? JSArrayBuffer else {
            try fail()
        }
        let copy = ta.jsClone(buffer: clonedBuf)
        seen[ObjectIdentifier(ta)] = copy
        return copy
    }
    if let dv = v as? JSDataView {
        guard let clonedBuf = try jsStructuredClone(dv.buffer, seen: &seen) as? JSArrayBuffer else {
            try fail()
        }
        let copy = try JSDataView(buffer: clonedBuf, dv.byteOffset, dv.byteLength)
        seen[ObjectIdentifier(dv)] = copy
        return copy
    }
    if let d = v as? JSDate {
        let copy = JSDate(d.time)
        seen[ObjectIdentifier(d)] = copy
        return copy
    }
    if let re = v as? JSRegExp {
        let copy = try JSRegExp(re.source, re.flags)
        seen[ObjectIdentifier(re)] = copy
        return copy
    }
    if let arr = v as? JSArrayProtocol {
        let copy = JSArray<Any?>()
        seen[ObjectIdentifier(arr)] = copy
        for e in arr.jsAnyElements {
            copy.storage.append(try jsStructuredClone(e, seen: &seen))
        }
        return copy
    }
    if let map = v as? JSMapProtocol {
        let copy = JSMap<Any?, Any?>()
        seen[ObjectIdentifier(map)] = copy
        for (k, val) in map.jsAnyEntries {
            _ = copy.set(try jsStructuredClone(k, seen: &seen), try jsStructuredClone(val, seen: &seen))
        }
        return copy
    }
    if let set = v as? JSSetProtocol {
        let copy = JSSet<Any?>()
        seen[ObjectIdentifier(set)] = copy
        for e in set.jsAnyValues {
            _ = copy.add(try jsStructuredClone(e, seen: &seen))
        }
        return copy
    }
    if let err = v as? JSError {
        let copy: JSError
        if let dom = err as? JSDOMException {
            copy = JSDOMException(dom.message, dom.name)
        } else {
            switch err.name {
            case "TypeError": copy = JSTypeError(err.message)
            case "RangeError": copy = JSRangeError(err.message)
            case "SyntaxError": copy = JSSyntaxError(err.message)
            case "ReferenceError": copy = JSReferenceError(err.message)
            default: copy = JSError(err.message)
            }
        }
        copy.stack = err.stack
        seen[ObjectIdentifier(err)] = copy
        return copy
    }
    if v is JSSymbol || v is JSHostObject {
        try fail()
    }
    if let dyn = v as? JSDynamic {
        let copy = JSObject()
        seen[ObjectIdentifier(dyn)] = copy
        for k in dyn.jsKeys {
            copy[k] = try jsStructuredClone(dyn[jsKey: k], seen: &seen)
        }
        return copy
    }
    try fail()
}

/// Prepares the transfer map for `postMessage(message, transfer)`.
func jsTransferred(_ transfer: Any?) throws -> [ObjectIdentifier: Any?] {
    var seen: [ObjectIdentifier: Any?] = [:]
    let flat = jsFlat(transfer)
    let listObj: Any?
    if flat is JSArrayProtocol || flat == nil || flat is JSNull {
        listObj = flat
    } else {
        listObj = jsField(flat, "transfer")
    }
    guard let arr = listObj as? JSArrayProtocol else { return seen }
    let items = arr.jsAnyElements.map { jsFlat($0) }
    var buffers: [JSArrayBuffer] = []
    for (idx, item) in items.enumerated() {
        guard let buf = item as? JSArrayBuffer else {
            throw JSException(JSDOMException("Value at index \(idx) does not have a transferable type.", "DataCloneError"))
        }
        let id = ObjectIdentifier(buf)
        if seen.keys.contains(id) {
            throw JSException(JSDOMException("ArrayBuffer at index \(idx) is a duplicate of an earlier ArrayBuffer.", "DataCloneError"))
        }
        seen[id] = nil
        buffers.append(buf)
    }
    for buf in buffers {
        seen[ObjectIdentifier(buf)] = try buf.transfer()
    }
    return seen
}

/// A worker script's own `postMessage(message, transfer)`.
public func jsPostMessage(_ message: Any?, _ transfer: Any? = nil) throws {
    let fn = jsGlobalThis["postMessage"]
    if jsIsNullish(transfer) {
        _ = try jsCall(fn, message)
    } else {
        _ = try jsCall(fn, message, transfer)
    }
}

/// A worker script's own `close()`.
public func jsClose() throws {
    _ = try jsCall(jsGlobalThis["close"])
}
