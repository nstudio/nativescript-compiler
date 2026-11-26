import Foundation

// Fine-grained reactivity, the model the compiled frameworks' signals, refs and
// runes share: a read inside an effect subscribes it, a write re-runs exactly
// the effects that read the value. Compiled templates bind each native
// property through one effect, so nothing is diffed.
// Main thread only; effects re-run on the app's framework's schedule (`Reactivity`).

/// A scope that owns effects and cleanups: a component instance, a branch of
/// an `if`, a row of a `for`. Disposing it disposes everything created in it.
public final class Owner {
    nonisolated deinit {}
    fileprivate var effects: [Effect] = []
    private var children: [Owner] = []
    private var cleanups: [() -> Void] = []
    private weak var parent: Owner?
    private var disposed = false

    public static fileprivate(set) var current: Owner?

    public init(parent: Owner? = Owner.current) {
        self.parent = parent
        parent?.children.append(self)
    }

    /// Runs `body` with this owner current: effects it creates belong here.
    @discardableResult
    public func run<T>(_ body: () throws -> T) rethrows -> T {
        let previous = Owner.current
        Owner.current = self
        defer { Owner.current = previous }
        return try body()
    }

    public func onCleanup(_ cleanup: @escaping () -> Void) { cleanups.append(cleanup) }


    public func dispose() {
        guard !disposed else { return }
        disposed = true
        for child in children { child.dispose() }
        for effect in effects { effect.dispose() }
        for cleanup in cleanups.reversed() { cleanup() }
        children = []; effects = []; cleanups = []
    }
}

/// Something a signal notifies.
protocol Subscriber: AnyObject {
    func invalidate()
}

/// A source an effect read; it forgets the effect when the effect re-runs.
protocol Source: AnyObject {
    func unsubscribe(_ subscriber: Subscriber)
}

private var currentEffect: Effect?
/// The memo computing now: what it reads becomes its sources, which subscribe no effect.
private var currentMemo: MemoReader?
private var batchDepth = 0
private var eventDepth = 0
private var queue: [Effect] = []
/// Derived values whose sources changed: they settle before the bindings re-run.
private var derivedQueue: [Effect] = []
private var flushing = false
private var flushScheduled = false
/// What `nextTick()` returned while an update was scheduled, settled after it.
private var flushedPromise: JSResolvers<Void>?
/// `.task`, in the microtask checkpoint after an update: updates are scheduled in a microtask.
private var afterUpdate = false
/// Signals whose readers outside an owner see the value they had before the writes.
private var holding: [Holding] = []

protocol Holding: AnyObject {
    func release()
}

/// When the effects a write invalidates re-run: the app's framework's update schedule.
public enum Reactivity {
    public enum Schedule {
        /// At once, on each write.
        case now
        /// In a microtask queued by the first write.
        case microtask
        /// In a zero-delay timer (its `setTimeout` comes before NativeScript's next-frame `requestAnimationFrame`);
        /// in a microtask during the checkpoint that follows an update.
        case task
        /// When the event being handled returns, otherwise in a microtask.
        case event
    }

    public static var schedule = Schedule.now

    /// Settles once the scheduled update has run, or now.
    public static func nextTick() -> JSPromise<Void> {
        guard flushScheduled else { return .resolve() }
        let flushed = flushedPromise ?? JSPromise<Void>.pending().1
        flushedPromise = flushed
        return flushed.promise
    }

    /// A view just created (a routed page, a dialog): what building it made pending runs now, so the view is complete
    /// before it is shown; effects pending before (`before`, from `pending()`) wait for the app's update.
    public static func detectChanges(after before: Set<ObjectIdentifier>) {
        if flushing { return }
        flushing = true
        defer { flushing = false }
        while true {
            let derived = derivedQueue.filter { !before.contains(ObjectIdentifier($0)) }
            let effects = queue.filter { !before.contains(ObjectIdentifier($0)) }
            if derived.isEmpty && effects.isEmpty { break }
            let run = derived.isEmpty ? effects : derived
            let ids = Set(run.map(ObjectIdentifier.init))
            if derived.isEmpty { queue.removeAll { ids.contains(ObjectIdentifier($0)) } } else { derivedQueue.removeAll { ids.contains(ObjectIdentifier($0)) } }
            for effect in run.sorted(by: { EffectOrder.precedes($0.key, $1.key) }) { effect.runIfStale() }
        }
    }

    /// The effects waiting for the next update.
    public static func pending() -> Set<ObjectIdentifier> {
        Set((queue + derivedQueue).map(ObjectIdentifier.init))
    }

    /// Effects invalidated after `before` (`pending()`), run at once even while an outer `flush()` is running:
    /// a recycled list cell's bindings must settle before `itemLoading` returns, including when `reloadData()`
    /// fires `itemLoading` synchronously during an update.
    public static func flushScoped(after before: Set<ObjectIdentifier>) {
        let outerFlushing = flushing
        flushing = true
        defer { flushing = outerFlushing }
        for _ in 0..<16 {
            let derived = derivedQueue.filter { !before.contains(ObjectIdentifier($0)) }
            let effects = queue.filter { !before.contains(ObjectIdentifier($0)) }
            if derived.isEmpty && effects.isEmpty { break }
            let run = derived.isEmpty ? effects : derived
            let ids = Set(run.map(ObjectIdentifier.init))
            if derived.isEmpty { queue.removeAll { ids.contains(ObjectIdentifier($0)) } } else { derivedQueue.removeAll { ids.contains(ObjectIdentifier($0)) } }
            for effect in run.sorted(by: { EffectOrder.precedes($0.key, $1.key) }) { effect.runIfStale(allowDefer: false) }
        }
    }

    /// Optional framework hook called before a non-deferred effect re-runs on a signal write: returning true leaves
    /// its signal subscriptions intact and defers execution to the framework's own view-ordered pass.
    static var shouldDeferEffect: ((Effect) -> Bool)? = nil

    /// Schedules an update and returns a settled promise, whose reactions follow it.
    public static func tick() -> JSPromise<Void> {
        scheduleFlush()
        return .resolve()
    }

    /// An event handler of a template. On the `.event` schedule the update runs when the handler returns, on `.task`
    /// one follows every event; handlers read held state (`stateSignal`) as the render that made them saw it until
    /// they return.
    public static func event(_ handler: () -> Void) {
        if schedule == .task { scheduleFlush() }
        eventDepth += 1
        handler()
        eventDepth -= 1
        if eventDepth == 0 && schedule != .task { flush() }
    }

    /// An update scheduled as a write schedules one, or with `now` run at once.
    static func requestUpdate(now: Bool = false) {
        if now { flush() } else { scheduleFlush() }
    }

    /// Effects re-run in an update whether or not what they read changed: a framework re-checking every binding.
    static var rerunsUnchanged = false

    /// The framework sites running now (`site`): code the framework itself runs, whose errors it handles
    /// (`jsUncaughtHandOff`).
    private(set) static var sites = 0

    static func site(_ body: () -> Void) {
        sites += 1
        defer { sites -= 1 }
        body()
    }
}

/// Groups writes so each affected effect runs once, after the last write.
public func batch(_ body: () -> Void) {
    batchDepth += 1
    body()
    batchDepth -= 1
    if batchDepth == 0 { flush() }
}

private func scheduleFlush() {
    if flushScheduled || flushing { return }
    switch Reactivity.schedule {
    case .now: flush()
    case .event where eventDepth > 0: break
    case .task where !afterUpdate:
        flushScheduled = true
        jsSetTimeout(scheduledFlush, 0)
    default:
        flushScheduled = true
        Microtasks.enqueue(scheduledFlush)
    }
}

private func scheduledFlush() {
    flushScheduled = false
    flush()
    if Reactivity.schedule == .task && !afterUpdate {
        afterUpdate = true
        Microtasks.enqueue { afterUpdate = false }
    }
    if let flushed = flushedPromise {
        flushedPromise = nil
        flushed.resolve()
    }
}

private func flush() {
    if flushing { return }
    flushing = true
    if eventDepth == 0 && !holding.isEmpty {
        for signal in holding { signal.release() }
        holding = []
    }
    while !queue.isEmpty || !derivedQueue.isEmpty {
        while !derivedQueue.isEmpty {
            let derived = derivedQueue.sorted { EffectOrder.precedes($0.key, $1.key) }
            derivedQueue = []
            for effect in derived { effect.runIfStale() }
        }
        let pending = queue.sorted { EffectOrder.precedes($0.key, $1.key) }
        queue = []
        for effect in pending { effect.runIfStale() }
    }
    flushing = false
}

/// The order a framework commits its bindings in, as a key per effect: the
/// effects a write invalidates re-run in key order (lexicographic). An effect
/// takes the next key of the scope it is created in; while it runs, effects it
/// creates (a branch, a row) are keyed under its own key. Compiled templates
/// create their binding effects in their framework's order and open scopes where
/// its order is not the template's: a component after the one that created it
/// (`component`), what a view runs after its own bindings (its embedded views,
/// its child views: the later phases of `Scope.next`, which its framework's kit
/// numbers), a deeper template after every shallower one (`deeper`).
public enum EffectOrder {
    public final class Scope {
        nonisolated deinit {}
        let prefix: [Int]
        /// Next key for each phase: 0, the scope's own effects; the later ones, as its framework's kit numbers them.
        var counters: [Int] = []
        /// Templates under this many control-flow regions, keyed by the one global count (`deeper`).
        let height: Int?
        /// The framework's own state for this scope's effects (the view they check), which each effect made in the scope keeps.
        let context: AnyObject?
        /// `EffectOrder.ambient` while this scope runs.
        let ambient: AnyObject?

        init(prefix: [Int], height: Int? = nil, context: AnyObject? = nil, ambient: AnyObject? = EffectOrder.ambient) {
            self.prefix = prefix
            self.height = height
            self.context = context
            self.ambient = ambient
        }

        func next(_ phase: Int) -> [Int] {
            if let height { depthCount += 1; return [height, depthCount] }
            while counters.count <= phase { counters.append(0) }
            defer { counters[phase] += 1 }
            return prefix + [phase, counters[phase]]
        }
    }

    public static var current = Scope(prefix: [])
    /// A framework's value for the code running now (the injector it injects from): each effect and scope keeps the
    /// one current as it is made, and it is current again while they run.
    static var ambient: AnyObject?
    private static var components = 0
    private static var depthCount = 0
    /// Derived values settle in the order they were declared.
    private static var derived = 0

    static func key() -> [Int] { current.next(0) }

    static func derivedKey() -> [Int] {
        derived += 1
        return [derived]
    }

    static func precedes(_ a: [Int], _ b: [Int]) -> Bool { a.lexicographicallyPrecedes(b) }

    static func run<T>(_ scope: Scope, _ body: () throws -> T) rethrows -> T {
        let previous = current
        let outer = ambient
        current = scope
        ambient = scope.ambient
        defer {
            current = previous
            ambient = outer
        }
        return try body()
    }

    /// `scope` current again, its ambient with it: a view's update pass, run after its creation pass has left the scope.
    public static func resume<T>(_ scope: Scope, _ body: () throws -> T) rethrows -> T {
        try run(scope, body)
    }

    /// A component: ordered after every component created before it.
    public static func component<T>(_ body: () throws -> T) rethrows -> T {
        components += 1
        return try run(Scope(prefix: [components]), body)
    }

    /// An independent root (a modal dialog, a routed page): clears the enclosing view context while preserving ambient.
    public static func detached<T>(_ body: () throws -> T) rethrows -> T {
        components += 1
        return try run(Scope(prefix: [components], context: nil, ambient: ambient), body)
    }

    /// Control-flow content: one level deeper than the template that holds it.
    public static func deeper<T>(_ body: () throws -> T) rethrows -> T {
        try run(Scope(prefix: [], height: (current.height ?? 0) + 1), body)
    }

    /// A root template whose control flow is ordered by depth (`deeper`).
    public static func depth<T>(_ body: () throws -> T) rethrows -> T {
        current.height != nil ? try body() : try run(Scope(prefix: [], height: 0), body)
    }
}

/// Reads without subscribing the running effect.
public func untrack<T>(_ body: () throws -> T) rethrows -> T {
    let previous = currentEffect, previousMemo = currentMemo
    currentEffect = nil
    currentMemo = nil
    defer { currentEffect = previous; currentMemo = previousMemo }
    return try body()
}

/// A list's items as a template binds them (a ListView's `items`), read in an effect: `apply` takes their elements
/// unless they are `Object.is` the items it last took and hold the same elements, as every framework's binding of a
/// list's items sets them (Angular's binding check and its ListView's differ); core's ListView reloads every row each
/// time its items are set. What reading them throws is reported, and nothing is applied.
public func listItems<Items: Sequence>(_ read: @escaping () throws -> Items, _ apply: @escaping ([Items.Element]) -> Void) {
    var given: Any?
    var applied: [Items.Element]?
    Effect {
        let items: Items
        do { items = try read() } catch { jsReportUncaught(jsCaught(error)); return }
        let elements = Array(items)
        if let previous = applied, jsSameValue(items as Any?, given), previous.count == elements.count,
           zip(previous, elements).allSatisfy({ jsSameValue($0 as Any?, $1 as Any?) }) { return }
        given = items
        applied = elements
        untrack { apply(elements) }
    }
}

/// A sectioned list's sections and their rows, read in an effect: snapshots both the outer sections and every
/// section's rows so in-place mutations of a section's row array are detected.
public func listSections<Sections: Sequence, Item>(_ read: @escaping () throws -> Sections, rows: @escaping (Sections.Element) -> [Item], _ apply: @escaping ([Sections.Element], [[Item]]) -> Void) {
    var given: Any?
    var applied: [Sections.Element]?
    var appliedRows: [[Item]]?
    Effect {
        let sections: Sections
        do { sections = try read() } catch { jsReportUncaught(jsCaught(error)); return }
        let elements = Array(sections)
        let sectionRows = elements.map(rows)
        if let previous = applied, let prevRows = appliedRows, jsSameValue(sections as Any?, given),
           previous.count == elements.count,
           zip(previous, elements).allSatisfy({ jsSameValue($0 as Any?, $1 as Any?) }),
           zip(prevRows, sectionRows).allSatisfy({ a, b in a.count == b.count && zip(a, b).allSatisfy({ jsSameValue($0 as Any?, $1 as Any?) }) }) { return }
        given = sections
        applied = elements
        appliedRows = sectionRows
        untrack { apply(elements, sectionRows) }
    }
}

/// Where a list's rows are made: the owner and effect scope current where the list is bound. A native list loads its rows
/// later, outside that code; `render` makes one in a new owner under the list's and in the list's scope, so the row's
/// effects order, refresh and end with the template declaring it (a framework's row view is a child of that template's).
/// What `body` throws disposes the row's owner and is rethrown.
public final class RowScope {
    nonisolated deinit {}
    private let owner: Owner?
    private let scope: EffectOrder.Scope

    public init() {
        owner = Owner.current
        scope = EffectOrder.current
    }

    public func render<T>(_ body: () throws -> T) throws -> T {
        let row = Owner(parent: owner)
        do { return try EffectOrder.resume(scope) { try row.run(body) } } catch {
            row.dispose()
            throw error
        }
    }
}

/// Something a memo read: its version changes when its value does.
protocol Versioned: Source {
    var version: Int { get }
    /// Brings the value up to date, so `version` is current.
    func settle()
    /// Subscribes `effect` to the signals under this value.
    func subscribe(_ effect: Effect)
}

protocol MemoReader: AnyObject {
    func track(_ source: Versioned)
}

/// A computed value: kept, so reads share it, until a value it read has a new version; then it is computed again on
/// the next read. A result `same` as the kept one keeps the kept one and its version. Nothing it read holds it: a
/// reader asks for its value.
public final class Memo<T>: Versioned, MemoReader, JSDynamic {
    nonisolated deinit {}
    private let compute: () throws -> T
    private let same: (T, T) throws -> Bool
    private var cached: Result<T, Error>?
    private var sources: [(source: Versioned, version: Int)] = []
    private(set) var version = 0
    private var computing = false

    public init(_ compute: @escaping () throws -> T, equals same: @escaping (T, T) throws -> Bool) {
        self.compute = compute
        self.same = same
    }

    public convenience init(_ compute: @escaping () throws -> T) {
        self.init(compute, equals: { _, _ in false })
    }

    public convenience init(_ compute: @escaping () throws -> T) where T: Equatable {
        self.init(compute, equals: { $0 == $1 })
    }

    func track(_ source: Versioned) {
        if !sources.contains(where: { $0.source === source }) { sources.append((source, source.version)) }
    }

    func settle() {
        if cached != nil && sources.allSatisfy({ $0.source.settle(); return $0.source.version == $0.version }) { return }
        sources = []
        let previous = currentEffect, previousMemo = currentMemo
        currentEffect = nil
        currentMemo = self
        computing = true
        let next = Result { try compute() }
        computing = false
        currentEffect = previous
        currentMemo = previousMemo
        if case .success(let old)? = cached, case .success(let new) = next {
            // What `same` throws becomes the value, as a throw of the computation does.
            do { if try same(old, new) { return } } catch {
                cached = .failure(error)
                version += 1
                return
            }
        }
        cached = next
        version += 1
    }

    func subscribe(_ effect: Effect) {
        for s in sources { s.source.subscribe(effect) }
    }

    func unsubscribe(_ subscriber: Subscriber) {}

    /// The value, rethrowing what computing it threw (kept like a value).
    public func read() throws -> T {
        if computing { throw JSException(value: JSError("Detected cycle in computations.")) }
        settle()
        if let memo = currentMemo { memo.track(self) } else if let effect = currentEffect { subscribe(effect) }
        return try cached!.get()
    }

    public var value: T { jsReportedOrZero(read) }

    public var jsKeys: [String] { ["value"] }
    public var jsClassName: String? { nil }
    public subscript(jsKey key: String) -> Any? {
        get { key == "value" ? value : nil }
        set {}
    }
}

/// The `equal` of a signal's options, read by name; `default` when they give none.
public func jsEqualOption<T>(_ options: Any?, default fallback: @escaping (T, T) -> Bool) -> (T, T) throws -> Bool {
    guard let equal = (try? jsGet(options, "equal")) ?? nil, !jsIsNullish(equal) else { return fallback }
    return { a, b in jsTruthy(try jsCall(equal, a, b)) }
}

/// An `equal` a signal's write calls, which cannot throw: a throw is reported, and the values taken as unequal.
public func jsReportingEquals<T>(_ equal: @escaping (T, T) throws -> Bool) -> (T, T) -> Bool {
    { a, b in jsReportedOrZero { try equal(a, b) } }
}

/// A value that notifies the effects that read it.
public final class Signal<T>: Versioned, Holding, JSDynamic {
    nonisolated deinit {}
    private enum Backing {
        case stored(T)
        case computed(() -> T)
        /// No value until the first write; a read throws the error.
        case unset(String)
        /// A linked signal with no value: its computation has not run, or its last run threw (`Link.error`).
        case linking
    }
    /// A `linkedSignal`'s computation, run as a memo's is: on the first read or write, and on each one after a value it
    /// read has a new version.
    private final class Link: MemoReader {
        nonisolated deinit {}
        /// Handed the signal's value (computed or written), nil on the first run and after a run that threw.
        let compute: (T?) throws -> T
        var sources: [(source: Versioned, version: Int)] = []
        var ran = false
        var computing = false
        var error: Error?

        init(_ compute: @escaping (T?) throws -> T) { self.compute = compute }

        func track(_ source: Versioned) {
            if !sources.contains(where: { $0.source === source }) { sources.append((source, source.version)) }
        }
    }
    private var backing: Backing
    private var link: Link?
    private var subscribers: [ObjectIdentifier: Subscriber] = [:]
    private let same: (T, T) throws -> Bool
    private(set) var version = 0
    /// Framework state (`stateSignal`): read outside an owner, the value before the writes not yet committed.
    fileprivate var holds = false
    private var held: T?

    public init(_ value: T) {
        backing = .stored(value)
        same = { _, _ in false }
    }

    public init(_ value: T) where T: Equatable {
        backing = .stored(value)
        same = { $0 == $1 }
    }

    /// A signal whose writes compare with `equals` (JavaScript's `Object.is` for objects). A plain write reports what it
    /// throws and takes the values as unequal; `setThrowing`/`updateThrowing` throw it.
    public init(_ value: T, equals: @escaping (T, T) throws -> Bool) {
        backing = .stored(value)
        same = equals
    }

    /// A signal with no value until its first write (a required input before its parent sets it): `requiredValue()`
    /// throws `error` until then.
    public init(unset error: String) {
        backing = .unset(error)
        same = { _, _ in false }
    }

    public init(unset error: String) where T: Equatable {
        backing = .unset(error)
        same = { $0 == $1 }
    }

    public init(unset error: String, equals: @escaping (T, T) throws -> Bool) {
        backing = .unset(error)
        same = equals
    }

    public init(computing compute: @escaping () throws -> T) {
        backing = .computed({ jsReportedOrZero(compute) })
        same = { _, _ in false }
    }

    /// A `computed()` held as a signal: its reads are the memo's.
    public init(_ memo: Memo<T>) {
        backing = .computed({ memo.value })
        same = { _, _ in false }
    }

    public init(linked compute: @escaping () throws -> T) {
        backing = .linking
        same = { _, _ in false }
        link = Link { _ in try compute() }
    }

    public init(linked compute: @escaping () throws -> T) where T: Equatable {
        backing = .linking
        same = { $0 == $1 }
        link = Link { _ in try compute() }
    }

    public init(linked compute: @escaping () throws -> T, equals: @escaping (T, T) throws -> Bool) {
        backing = .linking
        same = equals
        link = Link { _ in try compute() }
    }

    /// A signal linked to `source`: `computation` is handed the source's value and, once the signal holds a value
    /// (from a prior run or a write), the source value of the last run that returned (nil when none has yet) with that value.
    public init<S>(source: @escaping () throws -> S, computation: @escaping (S, (source: S?, value: T)?) throws -> T, equals: @escaping (T, T) throws -> Bool) {
        backing = .linking
        same = equals
        var last: S?
        link = Link { current in
            let s = try source()
            let v = try computation(s, current.map { (source: last, value: $0) })
            last = s
            return v
        }
    }

    /// Runs the link's computation when it never ran or a value it read has a new version. A result `same` as the value
    /// keeps the value and its version; what the computation or `same` throws is kept until a value it read changes.
    private func settleLink() {
        guard let link, !link.computing else { return }
        if link.ran && link.sources.allSatisfy({ $0.source.settle(); return $0.source.version == $0.version }) { return }
        var current: T?
        if case .stored(let v) = backing { current = v }
        link.sources = []
        let previous = currentEffect, previousMemo = currentMemo
        currentEffect = nil
        currentMemo = link
        link.computing = true
        let next = Result { try link.compute(current) }
        link.computing = false
        currentEffect = previous
        currentMemo = previousMemo
        link.ran = true
        do {
            let v = try next.get()
            if let current, try untrack({ try same(current, v) }) { return }
            link.error = nil
            backing = .stored(v)
        } catch {
            link.error = error
            backing = .linking
        }
        version += 1
    }

    /// A linked signal's value, brought up to date; what its computation threw is thrown again.
    private func linkedValue() throws -> T {
        if link?.computing == true { throw JSException(value: JSError("Detected cycle in computations.")) }
        settleLink()
        if let memo = currentMemo { memo.track(self) } else if let effect = currentEffect { subscribe(effect) }
        if let error = link?.error { throw error }
        guard case .stored(let v) = backing else { fatalError("unreachable: a link that ran without throwing holds a value") }
        return v
    }

    public var value: T {
        get {
            if link != nil { return jsReportedOrZero(linkedValue) }
            let current: T
            switch backing {
            case .computed(let compute):
                return compute()
            case .stored(let s):
                current = s
            case .unset:
                return jsReportedOrZero(requiredValue)
            case .linking:
                return jsReportedOrZero(linkedValue)
            }
            if let memo = currentMemo { memo.track(self) } else if let effect = currentEffect { subscribe(effect) }
            if let held, Owner.current == nil { return held }
            return current
        }
        set {
            settleLink()
            if case .stored(let current) = backing, jsReportedOrZero({ try same(current, newValue) }) { return }
            store(newValue)
        }
    }

    /// The value, read as `value` is; a signal still unset throws its error, the read tracked so a write runs it again.
    /// A linked signal throws what its computation threw.
    public func requiredValue() throws -> T {
        if link != nil { return try linkedValue() }
        if case .unset(let error) = backing {
            if let memo = currentMemo { memo.track(self) } else if let effect = currentEffect { subscribe(effect) }
            throw JSException(value: JSError(error))
        }
        return value
    }

    /// A `set` where `equal` may throw: the throw reaches the caller and nothing is written.
    public func setThrowing(_ newValue: T) throws {
        settleLink()
        if case .stored(let current) = backing, try same(current, newValue) { return }
        store(newValue)
    }

    /// An `update` where `equal` may throw, or the signal may still be unset (its error thrown before `transform` runs),
    /// or its link's computation threw (that thrown).
    public func updateThrowing(_ transform: (T) throws -> T) throws {
        settleLink()
        if let error = link?.error { throw error }
        if case .unset(let error) = backing { throw JSException(value: JSError(error)) }
        try setThrowing(transform(currentValue))
    }

    private var currentValue: T {
        switch backing {
        case .stored(let s): return s
        case .computed(let c): return c()
        case .unset: return jsReportedOrZero(requiredValue)
        case .linking: return jsReportedOrZero(linkedValue)
        }
    }

    private func store(_ newValue: T) {
        if case .stored(let current) = backing, holds && held == nil {
            held = current
            holding.append(self)
        }
        backing = .stored(newValue)
        link?.error = nil
        version += 1
        let targets = Array(subscribers.values)
        for target in targets { target.invalidate() }
        if batchDepth == 0 && !flushing && !(queue.isEmpty && derivedQueue.isEmpty && holding.isEmpty) { scheduleFlush() }
    }

    func release() { held = nil }

    func settle() { settleLink() }

    /// Subscribes `effect` to this signal and, for a linked one, to the values its computation read.
    func subscribe(_ effect: Effect) {
        subscribers[ObjectIdentifier(effect)] = effect
        effect.track(self)
        for s in link?.sources ?? [] { s.source.subscribe(effect) }
    }

    /// `signal.update { $0 + 1 }`. A linked signal whose computation threw reports it and writes nothing.
    public func update(_ transform: (T) throws -> T) rethrows {
        settleLink()
        if let error = link?.error { return jsReport { throw error } }
        value = try transform(currentValue)
    }

    func unsubscribe(_ subscriber: Subscriber) { subscribers[ObjectIdentifier(subscriber)] = nil }

    public var jsKeys: [String] { ["value"] }
    public var jsClassName: String? { nil }
    public subscript(jsKey key: String) -> Any? {
        get { key == "value" ? value : nil }
        set {
            guard key == "value" else { return }
            let unwrapped: Any? = jsIsNullish(newValue) ? nil : newValue
            if let v = unwrapped as? T { value = v }
        }
    }
}

/// State the handlers of a render read as it rendered (untracked reads see the last flush) until the
/// writes commit.
public func stateSignal<T>(_ signal: Signal<T>) -> Signal<T> {
    signal.holds = true
    return signal
}

/// Runs `body` now and again whenever a signal it read changes.
public final class Effect: Subscriber {
    nonisolated deinit {}
    private var body: (() -> Void)?
    private var sources: [ObjectIdentifier: Source] = [:]
    private var stale = false
    private var owner: Owner?
    let key: [Int]
    private let height: Int?
    /// The context of the scope it was made in (`EffectOrder.Scope.context`).
    let context: AnyObject?
    private let ambient: AnyObject?
    private let derived: Bool
    private let deferred: Bool
    private var started = false
    /// Made in a scope with a context, or deferred: a framework site (`Reactivity.site`) runs it.
    private let site: Bool

    @discardableResult
    public convenience init(_ body: @escaping () -> Void) {
        self.init(key: EffectOrder.key(), body)
    }

    /// `deferred`: its first run is in the next update (or when flushed by a framework if `schedule` is false), not at creation.
    init(key: [Int], derived: Bool = false, deferred: Bool = false, schedule: Bool = true, _ body: @escaping () -> Void) {
        self.body = body
        self.key = key
        self.derived = derived
        self.deferred = deferred
        height = EffectOrder.current.height
        context = EffectOrder.current.context
        site = context != nil || deferred
        ambient = EffectOrder.ambient
        Owner.current?.effects.append(self)
        Effect.created?(self)
        if deferred {
            stale = true
            if schedule {
                queue.append(self)
                scheduleFlush()
            }
        } else {
            run()
            started = true
        }
    }

    /// Stops it: it runs no more, and what its runs made is disposed.
    public func destroy() { dispose() }

    /// Called with each effect as it is made, for a framework that re-runs them all.
    static var created: ((Effect) -> Void)?

    var disposed: Bool { body == nil }

    fileprivate func track(_ source: Source) { sources[ObjectIdentifier(source)] = source }

    func invalidate() {
        guard body != nil, !stale else { return }
        stale = true
        if derived { derivedQueue.append(self) } else { queue.append(self) }
    }

    func runIfStale(allowDefer: Bool = true) {
        guard stale else { return }
        if allowDefer && started && !deferred, let deferCheck = Reactivity.shouldDeferEffect, deferCheck(self) {
            stale = false
            return
        }
        stale = false
        run()
        started = true
    }

    /// Runs immediately in a framework-driven check pass, clearing any queued staleness so it does not double-run.
    func runNow() {
        guard body != nil else { return }
        stale = false
        run()
        started = true
    }

    private func run() {
        guard let body else { return }
        for source in sources.values { source.unsubscribe(self) }
        sources = [:]
        // Effects and views made by the previous run (a branch, a row) go with it.
        owner?.dispose()
        // The effect, not whatever owner is current when it re-runs, owns what each run makes.
        owner = Owner(parent: nil)
        let previous = currentEffect
        currentEffect = self
        let scope = EffectOrder.Scope(prefix: key, height: height, context: context, ambient: ambient)
        if site { Reactivity.site { EffectOrder.run(scope) { owner?.run(body) } } } else { EffectOrder.run(scope) { owner?.run(body) } }
        currentEffect = previous
    }

    fileprivate func dispose() {
        for source in sources.values { source.unsubscribe(self) }
        sources = [:]
        body = nil
        owner?.dispose()
        owner = nil
    }
}

/// A derived value: `body` stores it when its sources change, in the
/// update after the writes and before any binding re-runs; read before that, it is the old value.
@discardableResult
public func derive(_ body: @escaping () -> Void) -> Effect {
    Effect(key: EffectOrder.derivedKey(), derived: true, body)
}

/// A top-level owner for an app or a navigation entry.
@discardableResult
public func createRoot<T>(_ body: (Owner) throws -> T) rethrows -> T {
    let owner = Owner(parent: nil)
    return try owner.run { try body(owner) }
}

/// What a `subscribe` returns: `unsubscribe()` runs its teardown once, and `closed` says whether it has.
public final class TeardownHandle {
    nonisolated deinit {}
    private var teardown: (() -> Void)?
    public private(set) var closed = false

    public init(_ teardown: (() -> Void)? = nil) { self.teardown = teardown }

    public func unsubscribe() {
        guard !closed else { return }
        closed = true
        let finalize = teardown
        teardown = nil
        finalize?()
    }
}

/// An event a component raises: the parent subscribes, the component emits.
public final class Emitter<T> {
    nonisolated deinit {}
    private final class Handler {
        nonisolated deinit {}
        let fn: (T) -> Void
        init(_ fn: @escaping (T) -> Void) { self.fn = fn }
    }
    private var handlers: [Handler] = []
    public init(_ isAsync: Bool = false) {}
    public func on(_ handler: @escaping (T) -> Void) { handlers.append(Handler(handler)) }
    public func emit(_ value: T) { for h in handlers { h.fn(value) } }
    public func next(_ value: T) { emit(value) }

    @discardableResult
    public func subscribe(_ next: @escaping (T) -> Void) -> TeardownHandle {
        let box = Handler(next)
        handlers.append(box)
        return TeardownHandle { [weak self] in
            self?.handlers.removeAll { $0 === box }
        }
    }

    @discardableResult
    public func subscribe(_ next: @escaping (T) throws -> Void) -> TeardownHandle {
        subscribe { value in jsReport { try next(value) } }
    }

    @discardableResult
    public func subscribe(_ observerOrNext: Any? = nil, _ error: Any? = nil, _ complete: Any? = nil) -> TeardownHandle {
        let box = Handler { value in
            guard let sub = jsFlat(observerOrNext) else { return }
            if let dyn = sub as? JSDynamic, jsHasKey(dyn, "next") || (dyn as? JSObject)?.has("next") == true {
                jsReport { _ = try jsCallMethod(sub, "next", value) }
            } else {
                jsReport { _ = try jsCall(sub, value) }
            }
        }
        handlers.append(box)
        return TeardownHandle { [weak self] in
            self?.handlers.removeAll { $0 === box }
        }
    }
}

extension Emitter where T: AnyObject {
    /// An untyped handler (`(e: any) => …`) of an emitter of objects, which the `Any?` overload could only call as script.
    @discardableResult
    public func subscribe(_ next: @escaping (Any?) throws -> Void) -> TeardownHandle {
        subscribe { (value: T) throws in try next(value) }
    }
}

extension Emitter where T == Void {
    public func emit() { emit(()) }
    public func next() { emit(()) }
}

extension Emitter where T == Any? {
    public func emit() { emit(nil) }
    public func next() { emit(nil) }
}
