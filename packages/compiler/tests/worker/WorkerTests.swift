import Foundation
import NativeScriptKit

// kit-apple's Worker on the host macOS runtime: main thread drives `JSPosted` + `JSEventLoop`.

nonisolated final class SyncCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var _value = 0
    func increment() -> Int {
        lock.lock()
        _value += 1
        let v = _value
        lock.unlock()
        return v
    }
    var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return _value
    }
}

nonisolated final class SyncList<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [T] = []
    func append(_ v: T) {
        lock.lock()
        items.append(v)
        lock.unlock()
    }
    var snapshot: [T] {
        lock.lock()
        defer { lock.unlock() }
        return items
    }
    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return items.count
    }
}

nonisolated final class Latch: @unchecked Sendable {
    private let sem = DispatchSemaphore(value: 0)
    func countDown() { sem.signal() }
    func await(_ timeoutSec: Double = 5.0) { _ = sem.wait(timeout: .now() + timeoutSec) }
}

private var failed = 0
private var passed = 0
private var reported: [String] = []

private func check(_ name: String, _ ok: Bool, _ detail: () -> String = { "" }) {
    if ok { passed += 1 } else { failed += 1 }
    print(ok ? "✓ \(name)" : "✗ \(name): \(detail())")
}

private func pumpUntil(_ timeoutMs: Int, _ pred: () -> Bool) -> Bool {
    let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(timeoutMs) * 1_000_000
    Microtasks.checkpoint()
    while !pred() {
        if JSPosted.run() {
            Microtasks.checkpoint()
            continue
        }
        if DispatchTime.now().uptimeNanoseconds >= deadline { return false }
        _ = JSPosted.arrived.wait(timeout: .now() + .milliseconds(5))
    }
    return true
}

private func pump(_ ms: Int) {
    _ = pumpUntil(ms) { false }
}

private func thrown(_ body: () throws -> Void) -> Any? {
    do {
        try body()
        return nil
    } catch {
        return jsCaught(error)
    }
}

private func onMessage(_ handler: @escaping (Any?) throws -> Void) {
    jsGlobalThis["onmessage"] = { (args: [Any?]) throws -> Any? in
        let ev = jsFlat(jsArg(args, 0)) as? JSMessageEvent
        try handler(ev?.data)
        return nil
    } as JSFunction
}

private func lifecycleTerminate() throws {
    let ticks = SyncCounter()
    let handled = SyncList<String>()
    let release = Latch()
    JSWorker.register("terminate.worker") {
        jsSetInterval({ _ = ticks.increment() }, 2.0)
        onMessage { data in
            let s = jsToString(data)
            handled.append(s)
            try jsPostMessage("reply \(s)")
            if s == "block" { release.await(5.0) }
            try jsPostMessage("done \(s)")
        }
    }
    let worker = try JSWorker("./terminate.worker", "terminate.worker")
    var got: [String] = []
    worker.onmessage = { e in got.append(jsToString(e.data)); return nil }
    try worker.postMessage("first")
    _ = pumpUntil(2000) { got.count == 2 && ticks.value > 2 }
    check("swift terminate: worker runs, timers tick", got == ["reply first", "done first"] && ticks.value > 2) { "got \(got), ticks \(ticks.value)" }
    try worker.postMessage("block")
    let spinDeadline = DispatchTime.now().uptimeNanoseconds + 2_000_000_000
    while handled.count < 2 && DispatchTime.now().uptimeNanoseconds < spinDeadline { Thread.sleep(forTimeInterval: 0.002) }
    try worker.postMessage("queued 1")
    try worker.postMessage("queued 2")
    worker.terminate()
    release.countDown()
    worker.join()
    pump(50)
    check("swift terminate: queued messages dropped", handled.snapshot == ["first", "block"]) { "handled \(handled.snapshot)" }
    check("swift terminate: no event arrives after terminate", got == ["reply first", "done first"]) { "got \(got)" }
    let after = ticks.value
    Thread.sleep(forTimeInterval: 0.03)
    check("swift terminate: worker timers stop", ticks.value == after) { "\(after) then \(ticks.value)" }
    let lateErr = thrown {
        try worker.postMessage("late")
        try worker.postMessage({ (_: [Any?]) -> Any? in nil } as JSFunction)
    }
    check("swift terminate: postMessage after terminate is no-op", lateErr == nil)
    pump(30)
    check("swift terminate: nothing handled after terminate", handled.count == 2 && got.count == 2)
    worker.terminate()
}

private func lifecycleClose() throws {
    let ticks = SyncCounter()
    let handled = SyncList<String>()
    JSWorker.register("close.worker") {
        jsSetInterval({ _ = ticks.increment() }, 2.0)
        onMessage { data in
            let s = jsToString(data)
            handled.append(s)
            if s == "close" {
                try jsPostMessage("before close")
                try jsClose()
                try jsPostMessage("after close")
            }
        }
    }
    let worker = try JSWorker("./close.worker", "close.worker")
    var got: [String] = []
    var errors = 0
    worker.onmessage = { e in got.append(jsToString(e.data)); return nil }
    worker.onerror = { _ in errors += 1; return true }
    _ = pumpUntil(1000) { ticks.value > 2 }
    try worker.postMessage("close")
    try worker.postMessage("queued")
    worker.join()
    pump(50)
    check("swift close: posted before close arrives, nothing after", got == ["before close"]) { "got \(got)" }
    check("swift close: queued messages dropped", handled.snapshot == ["close"]) { "handled \(handled.snapshot)" }
    let after = ticks.value
    Thread.sleep(forTimeInterval: 0.03)
    check("swift close: worker timers stop", ticks.value == after && errors == 0) { "\(after) then \(ticks.value), errors \(errors)" }
    try worker.postMessage("late")
    pump(20)
    check("swift close: postMessage after close is no-op", handled.count == 1)

    let again = try JSWorker("./close.worker", "close.worker")
    var gotAgain: [String] = []
    again.onmessage = { e in gotAgain.append(jsToString(e.data)); return nil }
    try again.postMessage("close")
    _ = pumpUntil(2000) { gotAgain.count == 1 }
    check("swift close: script starts again in a new worker once closed", gotAgain == ["before close"]) { "gotAgain \(gotAgain)" }
    again.join()
}

private func errorsTest() throws {
    let counter = SyncCounter()
    JSWorker.register("top-level-throws.worker") { throw JSException(JSError("at the top")) }
    let top = try JSWorker("./top-level-throws.worker", "top-level-throws.worker")
    var messages: [String] = []
    var onMain = false
    top.onerror = { e in
        messages.append(e.message)
        onMain = Thread.isMainThread
        return true
    }
    _ = pumpUntil(2000) { !messages.isEmpty }
    check("swift errors: top-level exception is ErrorEvent on main thread", messages == ["Uncaught Error: at the top"] && onMain) { "messages \(messages) onMain \(onMain)" }
    check("swift errors: onerror returning true leaves it handled", reported.isEmpty) { "reported \(reported)" }
    top.terminate()
    top.join()

    JSWorker.register("handler-throws.worker") {
        onMessage { data in
            let s = jsToString(data)
            if s == "throw" { throw JSException(JSTypeError("in onmessage")) }
            if s == "timer" { jsSetTimeout({ jsReport { throw JSException(JSRangeError("in a timer")) } }, 1.0); return }
            if s == "microtask" { jsQueueMicrotask { jsReport { throw JSException(JSError("in a microtask")) } }; return }
            try jsPostMessage("still alive \(counter.increment())")
        }
    }
    let worker = try JSWorker("./handler-throws.worker", "handler-throws.worker")
    var got: [String] = []
    var events: [String] = []
    worker.onmessage = { e in got.append(jsToString(e.data)); return nil }
    try worker.postMessage("throw")
    try worker.postMessage("ok")
    _ = pumpUntil(2000) { reported.count == 1 && got.count == 1 }
    check("swift errors: unhandled onmessage throw reported as uncaught on main thread", reported == ["main: TypeError: in onmessage"]) { "reported \(reported)" }
    check("swift errors: worker keeps running after error", got == ["still alive 1"]) { "got \(got)" }
    reported.removeAll()

    worker.onerror = { e in events.append(e.message); return nil }
    try worker.postMessage("timer")
    _ = pumpUntil(2000) { events.count == 1 && reported.count == 1 }
    check("swift errors: timer exception is ErrorEvent", events == ["Uncaught RangeError: in a timer"]) { "events \(events)" }
    check("swift errors: handler not returning true leaves it uncaught", reported == ["main: RangeError: in a timer"]) { "reported \(reported)" }
    reported.removeAll()
    events.removeAll()

    worker.onerror = { e in events.append(e.message); return true }
    try worker.postMessage("microtask")
    _ = pumpUntil(2000) { events.count == 1 }
    check("swift errors: microtask exception is ErrorEvent", events == ["Uncaught Error: in a microtask"] && reported.isEmpty) { "events \(events) reported \(reported)" }
    events.removeAll()

    worker.onerror = { _ in throw JSException(JSError("onerror throws")) }
    try worker.postMessage("throw")
    _ = pumpUntil(2000) { !reported.isEmpty }
    check("swift errors: onerror throwing is reported", reported == ["main: Error: onerror throws"]) { "reported \(reported)" }
    reported.removeAll()

    worker.terminate()
    worker.join()
}

private func cloningTest() throws {
    let o = JSObject()
    o["n"] = 1.5; o["s"] = "text"; o["b"] = true; o["nil"] = jsNull; o["u"] = nil
    o["list"] = JSArray<Any?>([1.0, JSArray<Any?>(["deep"]), JSObject([("k", "v")])])
    let buffer = try JSArrayBuffer(8.0)
    let floats = try JSFloat32Array(buffer: buffer, 0.0, 2.0)
    let bytes = try JSUint8Array(buffer: buffer)
    floats[jsElement: 0] = 0.5
    o["floats"] = floats; o["bytes"] = bytes; o["buffer"] = buffer
    let map = JSMap<Any?, Any?>()
    _ = map.set("a", JSArray<Any?>([1.0]))
    o["map"] = map
    let set = JSSet<Any?>()
    _ = set.add("x"); _ = set.add(2.0)
    o["set"] = set
    o["date"] = JSDate(1_700_000_000_000.0)
    o["error"] = JSTypeError("cloned")
    o["self"] = o
    let loop = JSArray<Any?>()
    loop.storage.append(loop)
    o["loop"] = loop

    let copy = try jsStructuredClone(o) as! JSObject
    check("swift clone: primitives, strings, nested arrays/objects", copy !== o && (copy["n"] as? Double) == 1.5 && (copy["s"] as? String) == "text" && (copy["b"] as? Bool) == true && copy["nil"] is JSNull && copy["u"] == nil && jsInspect(copy["list"]) == jsInspect(o["list"]) && (copy["list"] as AnyObject) !== (o["list"] as AnyObject)) { jsInspect(copy) }
    let f = copy["floats"] as! JSFloat32Array
    let cb = copy["buffer"] as! JSArrayBuffer
    floats[jsElement: 0] = 9.0
    check("swift clone: typed arrays & buffers copied, views share copied buffer", f[jsElement: 0] == 0.5 && f.buffer === cb && (copy["bytes"] as! JSUint8Array).buffer === cb && cb !== buffer && cb.byteLength == 8.0) { "f0 \(f[jsElement: 0])" }
    let cm = copy["map"] as! JSMap<Any?, Any?>
    let cs = copy["set"] as! JSSet<Any?>
    check("swift clone: Map, Set, Date", cm !== map && jsInspect(cm) == jsInspect(map) && cs.has("x") && cs.has(2.0) && (copy["date"] as! JSDate).time == 1_700_000_000_000.0 && (copy["date"] as AnyObject) !== (o["date"] as AnyObject))
    check("swift clone: Error preserves name & message", (copy["error"] as? JSTypeError)?.message == "cloned")
    check("swift clone: cycles preserved", (copy["self"] as? JSObject) === copy && ((copy["loop"] as! JSArray<Any?>).storage[0] as AnyObject) === (copy["loop"] as AnyObject))

    let fnErr = thrown { _ = try jsStructuredClone({ (_: [Any?]) -> Any? in nil } as JSFunction) } as? JSDOMException
    let symErr = thrown { _ = try jsStructuredClone(jsSymbol("s")) } as? JSDOMException
    let hostErr = thrown { _ = try jsStructuredClone(try JSURL("https://example.com")) } as? JSDOMException
    check("swift clone: functions, symbols, host objects throw DataCloneError", [fnErr, symErr, hostErr].allSatisfy { $0?.name == "DataCloneError" })

    JSWorker.register("echo.worker") {
        onMessage { data in
            if (data as? String) == "function" {
                try jsPostMessage({ (_: [Any?]) -> Any? in nil } as JSFunction)
            } else {
                try jsPostMessage(data)
            }
        }
    }
    let worker = try JSWorker("./echo.worker", "echo.worker")
    var got: [Any?] = []
    var events: [String] = []
    worker.onmessage = { e in got.append(e.data); return nil }
    worker.onerror = { e in events.append(e.message); return true }
    let sendErr = thrown { try worker.postMessage(JSArray<Any?>([{ (_: [Any?]) -> Any? in nil } as JSFunction])) } as? JSDOMException
    check("swift clone: posting function throws DataCloneError to sender", sendErr?.name == "DataCloneError")

    let sent = try JSArrayBuffer(16.0)
    try JSUint8Array(buffer: sent)[jsElement: 3] = 7.0
    let view = try JSUint8Array(buffer: sent, 2.0, 4.0)
    try worker.postMessage(o)
    try worker.postMessage(JSObject([("view", view)]), JSArray<Any?>([sent]))
    try worker.postMessage("function")
    let doubleTransfer = thrown { try worker.postMessage(sent, JSArray<Any?>([sent])) } as? JSDOMException
    _ = pumpUntil(2000) { got.count == 2 && events.count == 1 }
    let back = got.first as? JSObject
    check("swift clone: round trip preserves data and cycles", back != nil && back !== o && (back!["self"] as? JSObject) === back! && (back!["floats"] as! JSFloat32Array)[jsElement: 0] == floats[jsElement: 0])
    let moved = (got.count > 1 ? (got[1] as? JSObject)?["view"] : nil) as? JSUint8Array
    let detachedErr = thrown { _ = try JSUint8Array(buffer: sent) }
    check("swift transfer: sender buffer is detached", sent.byteLength == 0.0 && detachedErr is JSTypeError) { "byteLength \(sent.byteLength), err \(String(describing: detachedErr))" }
    check("swift transfer: receiver view reads moved bytes", moved != nil && moved!.buffer.byteLength == 16.0 && moved![jsElement: 1] == 7.0 && moved!.length == 4.0)
    check("swift transfer: detached buffer cannot be transferred again", doubleTransfer?.name == "DataCloneError")
    check("swift clone: worker posting function triggers DataCloneError ErrorEvent", events.count == 1 && events[0].hasPrefix("Uncaught DataCloneError")) { "events \(events)" }
    worker.terminate()
    worker.join()
}

private let nullPtr: JSObject? = nil

private func secondWorkerAndScope() throws {
    let started = SyncList<String>()
    let release = Latch()
    JSWorker.register("single.worker") {
        started.append("single")
        onMessage { data in
            let s = jsToString(data)
            if s == "block" { release.await(5.0) }
            try jsPostMessage("single \(s)")
        }
    }
    JSWorker.register("other.worker") {
        let scope = try JSWorker.fromAny(jsGlobalThis)
        jsGlobalThis["mine"] = "other's global"
        scope.onmessage = { e in
            try scope.postMessage("other \(jsToString(e.data)) \(jsToString(jsGlobalThis["mine"]))")
            return nil
        }
    }
    let first = try JSWorker("./single.worker", "single.worker")
    let second = thrown { _ = try JSWorker("./single.worker", "single.worker") } as? JSError
    check("swift second worker: second live worker of same script fails", second?.message.contains("single.worker already runs in a worker") == true) { "\(String(describing: second?.message))" }
    let other = try JSWorker("./other.worker", "other.worker")
    var got: [String] = []
    first.onmessage = { e in got.append(jsToString(e.data)); return nil }
    other.onmessage = { e in got.append(jsToString(e.data)); return nil }
    try first.postMessage("a")
    try other.postMessage("b")
    _ = pumpUntil(2000) { got.count == 2 }
    check("swift second worker: side-by-side scripts have isolated globals & JSWorker.fromAny works", Set(got) == Set(["single a", "other b other's global"]) && jsGlobalThis["mine"] == nil) { "got \(got)" }
    try first.postMessage("block")
    pump(20)
    first.terminate()
    let third = try JSWorker("./single.worker", "single.worker")
    pump(50)
    check("swift second worker: restart waits for previous thread exit", started.count == 1) { "started \(started.snapshot)" }
    release.countDown()
    _ = pumpUntil(2000) { started.count == 2 }
    check("swift second worker: ...and then starts", started.count == 2) { "started \(started.snapshot)" }
    third.terminate()
    other.terminate()
    third.join()
    other.join()
}

@main
enum WorkerTestsMain {
    static func main() {
        jsUncaughtHandler = { value in
            reported.append("\(Thread.isMainThread ? "main" : "other"): \(jsToString(value))")
        }
        do {
            try lifecycleTerminate()
            try lifecycleClose()
            try errorsTest()
            try cloningTest()
            try secondWorkerAndScope()
        } catch {
            failed += 1
            print("✗ uncaught in test driver: \(jsToString(jsCaught(error)))")
        }
        check("swift: no active workers left", !JSWorker.hasActiveWorkers)
        print("\(passed) of \(passed + failed) swift worker checks pass")
        exit(failed == 0 ? 0 : 1)
    }
}
