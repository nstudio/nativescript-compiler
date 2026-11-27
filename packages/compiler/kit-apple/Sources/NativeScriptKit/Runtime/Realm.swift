import Foundation

// A realm's per-thread state: its global object, timers, microtask queue and per-thread runtime scratch state.
// A worker's thread enters its own realm; every other thread runs in the app's (`main`), as all code did before workers.

/// Runs a `@MainActor` closure on a worker thread where the worker owns its own isolated `JSRealm`.
@usableFromInline nonisolated func jsRunInWorker(_ body: @escaping @MainActor () throws -> Void) throws {
    let fn = unsafeBitCast(body, to: (() throws -> Void).self)
    try fn()
}

/// Runs a non-throwing `@MainActor` closure on a worker thread.
@usableFromInline nonisolated func jsRunInWorker(_ body: @escaping @MainActor () -> Void) {
    let fn = unsafeBitCast(body, to: (() -> Void).self)
    fn()
}

/// Runs a value-returning `@MainActor` closure on a worker thread.
@usableFromInline nonisolated func jsRunInWorker<T>(_ body: @escaping @MainActor () -> T) -> T {
    let fn = unsafeBitCast(body, to: (() -> T).self)
    return fn()
}

/// Thread-local pointer to the current thread's `JSRealm` (nil on threads using `JSRealm.main`).
private nonisolated final class JSRealmTLS: @unchecked Sendable {
    let key: pthread_key_t
    init() {
        var k: pthread_key_t = 0
        pthread_key_create(&k, nil)
        key = k
    }
}

private nonisolated let jsRealmTLS = JSRealmTLS()

/// Per-realm script state: global object, event loop, microtask queue, and thread-confined scratch fields.
public final class JSRealm: @unchecked Sendable {
    nonisolated deinit {}

    public let global: JSObject
    let loop: JSEventLoopState
    let microtasks: JSMicrotasks
    /// Runs a job on this realm's thread from any thread: the host installs it for the app's realm.
    public nonisolated(unsafe) var post: ((@Sendable @escaping () -> Void) -> Void)?
    /// Where an uncaught error in this realm goes; nil reports it as the app's.
    var uncaught: ((Any?) -> Void)?

    /// Per-thread cycle guard for `Array.prototype.join`.
    var joining: [ObjectIdentifier] = []
    /// Per-thread refused dynamic write (`jsSet`).
    var refusedWrite: JSException?
    /// Per-thread last RegExp subject cache.
    var lastRegExpSubject: JSRegExpSubject?
    /// Per-thread RegExp VM (matching runs no script, so each realm owns its own VM without locking).
    let regexVM = RegexVM()

    init(isMain: Bool = false) {
        self.global = JSObject([("DOMException", jsDOMExceptionConstructor), ("performance", jsDateBuiltin)])
        self.loop = JSEventLoopState(isMain: isMain)
        self.microtasks = JSMicrotasks()
        if isMain {
            self.post = { job in
                JSPosted.post {
                    job()
                }
            }
        }
    }

    /// The app's main-thread realm.
    public nonisolated static let main: JSRealm = {
        let make: @MainActor () -> JSRealm = { JSRealm(isMain: true) }
        return unsafeBitCast(make, to: (() -> JSRealm).self)()
    }()

    /// The realm of the calling thread: a worker's own on a worker thread, else `main`.
    @inline(__always)
    public nonisolated static func current() -> JSRealm {
        if let raw = pthread_getspecific(jsRealmTLS.key) {
            return Unmanaged<JSRealm>.fromOpaque(raw).takeUnretainedValue()
        }
        return main
    }

    nonisolated static func enter(_ realm: JSRealm) {
        pthread_setspecific(jsRealmTLS.key, Unmanaged.passUnretained(realm).toOpaque())
    }

    nonisolated static func leave() {
        pthread_setspecific(jsRealmTLS.key, nil)
    }
}
