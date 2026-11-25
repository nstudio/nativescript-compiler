import Foundation

/// An Angular component view: a listener or `markForCheck` marks it and the views above it dirty (`markViewDirty`), a
/// signal one of its bindings read marks it to refresh, and `Zone` refreshes what is marked in `EffectOrder` key order:
/// every binding (`Check`), hook and region of the view's template and of its embedded views, applying what is no longer
/// `Object.is` the value last applied. It is the context (`EffectOrder.Scope.context`) of the scopes of its template.
public final class AngularView {
    nonisolated deinit {}
    weak var parent: AngularView?
    let prefix: [Int]
    /// Checked OnPush: a tick refreshes it only while it is `dirty`, or marked to `refresh`.
    let onPush: Bool
    var dirty = false
    /// Angular's `RefreshView`: a signal one of its bindings read changed, or `detectChanges()`.
    var refresh = false
    /// True while one of this view's effects is executing in a check pass (prevents self-deferral).
    var refreshing = false
    /// True while this view is already active in the current pass (prevents ancestor re-dirtying loops from `ngDoCheck`).
    var inPass = false
    /// Set when a `@let` in this view throws during its check pass; remaining bindings in this view skip until next pass.
    var aborted = false
    /// Component-scoped `effect()`s created during construction, flushed between `ngDoCheck` and `ngAfterContentInit`.
    var initialEffects: [Effect] = []

    init(parent: AngularView?, prefix: [Int], onPush: Bool = false) {
        self.parent = parent
        self.prefix = prefix
        self.onPush = onPush
    }

    /// Marks this view dirty and walks up to its root host view without re-dirtying ancestors already active in this pass.
    func markDirty() {
        dirty = true
        var view = parent
        while let current = view {
            if !current.inPass { current.dirty = true }
            view = current.parent
        }
    }

    final class ConstructionFrame {
        nonisolated deinit {}
        var refs: [ChangeDetectorRef] = []
        var initialEffects: [Effect] = []
    }

    static var frames: [ConstructionFrame] = []
    static let pending = NSMapTable<AnyObject, ConstructionFrame>.weakToStrongObjects()

    /// Runs a component's construction inside an exception-safe, re-entrant scope frame so `inject(ChangeDetectorRef)`
    /// and `effect()` bind to the component's own view regardless of inheritance or constructor helpers.
    public static func construct<T: AnyObject>(_ make: () throws -> T) rethrows -> T {
        let frame = ConstructionFrame()
        frames.append(frame)
        let instance: T
        do {
            instance = try make()
            frames.removeLast()
        } catch {
            frames.removeLast()
            for fx in frame.initialEffects { fx.destroy() }
            throw error
        }
        if !frame.refs.isEmpty || !frame.initialEffects.isEmpty {
            pending.setObject(frame, forKey: instance)
        }
        return instance
    }
}

extension EffectOrder.Scope {
    /// The component view whose bindings this scope's checks are.
    public var view: AngularView? { context as? AngularView }
}

extension EffectOrder {
    /// The phases of a view's scope (`Scope.next`), in the order a check of the view runs them: its own bindings (0),
    /// its embedded views, the content hooks of what it holds, its child views, their after-view hooks.
    static let embeddedPhase = 1, contentPhase = 2, childPhase = 3, viewPhase = 4

    /// A root component's host view scope: isolates each root's host hooks and `markForCheck` state from other roots.
    public static func root<T>(_ body: () throws -> T) rethrows -> T {
        Zone.install()
        let prefix = current.next(childPhase)
        let host = AngularView(parent: nil, prefix: prefix, onPush: false)
        return try run(Scope(prefix: prefix, context: host, ambient: current.ambient), body)
    }

    /// Angular's component view: after its parent view's bindings and embedded views. `injector` is the component's
    /// own (`providers`); without one, the view's children inject from the injector the component was made in.
    public static func view<T>(for component: AnyObject? = nil, onPush: Bool = false, injector: Injector? = nil, _ body: () throws -> T) rethrows -> T {
        Zone.install()
        let prefix = current.next(childPhase)
        let view = AngularView(parent: current.view, prefix: prefix, onPush: onPush)
        if let component {
            Zone.views.setObject(view, forKey: component)
            if let frame = AngularView.pending.object(forKey: component) {
                AngularView.pending.removeObject(forKey: component)
                for ref in frame.refs { ref.view = view }
                view.initialEffects = frame.initialEffects
            }
        }
        return try run(Scope(prefix: prefix, context: view, ambient: injector ?? Injector.current), body)
    }

    /// Angular's embedded view (`@if`, `@for` content): after its declaring view's own bindings.
    public static func embedded<T>(in view: Scope, _ body: () throws -> T) rethrows -> T {
        try run(Scope(prefix: view.next(embeddedPhase), context: view.context, ambient: view.ambient), body)
    }
}

extension Effect {
    /// The component view it is a binding of.
    var view: AngularView? { context as? AngularView }

    /// Angular's `effect()`: created during component construction it flushes between `ngDoCheck` and `ngAfterContentInit`;
    /// otherwise its first run is in the next update, as change detection runs it, not at creation.
    @discardableResult
    public static func deferred(_ body: @escaping () -> Void) -> Effect {
        Zone.install()
        // Not a binding: a tick does not re-run it, only a signal it read.
        let created = Effect.created
        Effect.created = nil
        defer { Effect.created = created }
        if let frame = AngularView.frames.last {
            let fx = Effect(key: EffectOrder.key(), deferred: true, schedule: false, body)
            frame.initialEffects.append(fx)
            return fx
        }
        return Effect(key: EffectOrder.key(), deferred: true, body)
    }
}

extension Reactivity {
    /// A listener of a zoneless Angular template: the update it schedules refreshes `view` and every view above it.
    public static func event(dirty view: AngularView?, _ handler: () -> Void) {
        Zone.install()
        Zone.markDirty(view)
        event { site(handler) }
    }

    /// `ChangeDetectorRef.markForCheck()` on a zoneless view: an update refreshes it and the views above it, scheduled
    /// as a write schedules one, or run at once.
    static func markForCheck(_ view: AngularView?, now: Bool = false) {
        Zone.markDirty(view)
        requestUpdate(now: now)
    }
}

/// Angular's change detection. With zone.js, after every JavaScript task (an event handler, a timer callback, a promise
/// job) and the jobs it queued, `ApplicationRef.tick()` refreshes every Eager view from the roots; zoneless, a tick runs
/// in the update a listener, `markForCheck` or a signal a binding read schedules, and refreshes only what they marked.
/// Every effect a view's template makes is re-run in `EffectOrder` key order, deciding each view lazily when entered.
public enum Zone {
    public static var enabled = false {
        didSet {
            install()
            Microtasks.onStable = enabled ? { tick() } : nil
        }
    }

    /// Held until disposed: a binding reads no signal that would keep it alive.
    private static var effects: [Effect] = []

    private static var handing = false
    private static var installed = false

    /// Hands uncaught errors to Angular (`handOff`), keeps every view-scoped effect, and installs the unified signal
    /// deferral hook so `Check`, `Choose`, `ForEach`, and `listItems` all refresh in view order.
    static func install() {
        if jsUncaughtHandOff == nil { jsUncaughtHandOff = handOff }
        guard !installed else { return }
        installed = true
        Effect.created = { effect in
            if effect.view != nil { effects.append(effect) }
        }
        Reactivity.shouldDeferEffect = { effect in
            guard let view = effect.view, !view.refreshing else { return false }
            Zone.refresh(view)
            return true
        }
        Reactivity.rerunsUnchanged = true
    }

    /// An uncaught error as Angular takes it: with zone.js every task's error goes to the ErrorHandler (the app's,
    /// else Angular's) and never reaches the runtime; without it only an Angular catch site's does. False when it is
    /// the runtime's, as is what the handler itself throws.
    public static func handOff(_ error: Any?) -> Bool {
        guard !handing, enabled || Reactivity.sites > 0 else { return false }
        handing = true
        defer { handing = false }
        (Injector.providedErrorHandler() ?? ErrorHandler.standard).handleError(error)
        return true
    }

    /// Component views by component instance.
    static let views = NSMapTable<AnyObject, AngularView>.weakToWeakObjects()

    /// An input of an OnPush component set to a value not `Object.is` the last (`markDirtyIfOnPush`); not its first
    /// value, which its view's first update follows, as Angular's creation does.
    public static func inputChanged(_ component: AnyObject) {
        if !creating { views.object(forKey: component)?.dirty = true }
    }

    /// Flushes construction-scoped `effect()`s of `component` between `ngDoCheck` and `ngAfterContentInit`.
    public static func flushEffects(for component: AnyObject) {
        guard let view = views.object(forKey: component), !view.initialEffects.isEmpty else { return }
        let pending = view.initialEffects
        view.initialEffects = []
        for fx in pending {
            Reactivity.site { fx.runIfStale() }
        }
    }

    private static var creating = false

    static func applying(first: Bool, _ apply: () -> Void) {
        let outer = creating
        creating = first
        defer { creating = outer }
        apply()
    }

    /// Zoneless `markViewDirty`: `view` and the views up to its root host view, refreshed by the tick in the update the caller schedules.
    static func markDirty(_ view: AngularView?) {
        guard let view else { return }
        view.markDirty()
        if !enabled { scheduleTick() }
    }

    /// A binding/region of `view` read a signal that changed.
    static func refresh(_ view: AngularView) {
        view.refresh = true
        if !enabled { scheduleTick() }
    }

    /// The zoneless tick, an effect keyed after every other, so in an update it runs once user `effect()`s have run.
    private static var ticker: Effect?

    private static func scheduleTick() {
        if ticker == nil {
            let created = Effect.created
            Effect.created = nil
            defer { Effect.created = created }
            ticker = Owner(parent: nil).run { EffectOrder.run(EffectOrder.Scope(prefix: [Int.max], context: nil, ambient: nil)) { Effect(key: [Int.max]) { untrack { runCycle(roots: nil) } } } }
        }
        ticker?.invalidate()
    }

    /// `ApplicationRef.tick()` with zone.js (Angular 22 `detectChangesInViewWhileDirty`/`detectChangesInView`), run at once.
    public static func tick() {
        runCycle(roots: nil)
    }

    /// Subtree-scoped `ChangeDetectorRef.detectChanges()` for both zone.js and zoneless modes.
    static func detectChanges(in view: AngularView) {
        runCycle(roots: [ObjectIdentifier(view)])
    }

    private static func isDescendant(_ view: AngularView, ofAny roots: Set<ObjectIdentifier>) -> Bool {
        var cur = view.parent
        while let p = cur {
            if roots.contains(ObjectIdentifier(p)) { return true }
            cur = p.parent
        }
        return false
    }

    private static func runCycle(roots: Set<ObjectIdentifier>?) {
        var checked = Set<ObjectIdentifier>()
        for pass in 0..<100 {
            if !runPass(roots: roots, isRootPass: pass == 0 && roots == nil, checked: &checked) { break }
        }
    }

    /// Runs one in-order `EffectOrder` pass, evaluating each view's eligibility lazily when entered so OnPush inputs
    /// and `ngDoCheck` `markForCheck()` take effect in the same pass before `ngAfterViewChecked`, and wrapping each
    /// Phase 0 scope in `EmbeddedViews.begin()`/`flush()`.
    private static func runPass(roots: Set<ObjectIdentifier>?, isRootPass: Bool, checked: inout Set<ObjectIdentifier>) -> Bool {
        effects.removeAll { $0.disposed }
        let snapshot = effects.sorted { EffectOrder.precedes($0.key, $1.key) }
        var decision: [ObjectIdentifier: Bool] = [:]
        var enteredViews: [AngularView] = []
        var ranAny = false

        func enter(_ view: AngularView) -> Bool {
            let id = ObjectIdentifier(view)
            if let d = decision[id] { return d }
            if let scoped = roots, !scoped.contains(id) && !isDescendant(view, ofAny: scoped) {
                decision[id] = false
                return false
            }
            let isTarget = roots?.contains(id) == true && !checked.contains(id)
            let parentActive: Bool
            let parentDone: Bool
            if let p = view.parent {
                parentActive = enter(p)
                parentDone = checked.contains(ObjectIdentifier(p))
            } else {
                parentActive = isRootPass && enabled
                parentDone = true
            }
            let active = isTarget || view.refresh || ((parentActive || parentDone) && view.dirty) || (parentActive && !view.onPush)
            decision[id] = active
            if active {
                view.inPass = true
                view.dirty = false
                view.refresh = false
                view.aborted = false
                checked.insert(id)
                enteredViews.append(view)
            }
            return active
        }

        var openPrefix: [Int]? = nil
        defer {
            if openPrefix != nil {
                openPrefix = nil
                jsReport { try EmbeddedViews.flush() }
            }
            for v in enteredViews {
                v.inPass = false
                v.refreshing = false
            }
        }

        for effect in snapshot {
            guard !effect.disposed, let view = effect.view else { continue }
            guard enter(view), !view.aborted else { continue }
            let phase0Prefix: [Int]? = effect.key.count >= 2 && effect.key[effect.key.count - 2] == 0 ? Array(effect.key.dropLast(2)) : nil
            if phase0Prefix != openPrefix {
                if openPrefix != nil { jsReport { try EmbeddedViews.flush() } }
                if phase0Prefix != nil { EmbeddedViews.begin() }
                openPrefix = phase0Prefix
            }
            ranAny = true
            view.refreshing = true
            effect.runNow()
            view.refreshing = false
        }
        return ranAny
    }
}

/// A binding as Angular checks it (`bindingUpdated`): re-read on every check of its view,
/// applied only when the value is not `Object.is` the last one applied; what reading it
/// throws is reported, and nothing is applied. With `abortOnThrow`, a throw aborts the rest of the view's pass.
public func Check<T>(abortOnThrow: Bool = false, _ read: @escaping () throws -> T, _ apply: @escaping (T) -> Void) {
    var last: T?
    var started = false
    Effect {
        if EffectOrder.current.view?.aborted == true { return }
        let first = !started
        started = true
        guard let value = jsReported(read) else {
            if abortOnThrow { EffectOrder.current.view?.aborted = true }
            return
        }
        if let previous = last, jsSameValue(typed: previous, value) { return }
        last = value
        untrack { Zone.applying(first: first) { apply(value) } }
    }
}

/// A hook Angular runs on every check of the view its component or directive is in (`ngDoCheck`): now, after the init
/// hook, then each time the view is checked, at its place among the view's bindings.
public func EveryCheck(_ hook: @escaping () -> Void) {
    everyCheck(0, hook)
}

/// `ngAfterContentChecked`: now, after `ngAfterContentInit`, then on every check of the view, after its embedded views.
public func ContentChecked(_ hook: @escaping () -> Void) {
    everyCheck(EffectOrder.contentPhase, hook)
}

/// `ngAfterViewChecked`: now, after `ngAfterViewInit`, then on every check of the view, after its child views.
public func ViewChecked(_ hook: @escaping () -> Void) {
    everyCheck(EffectOrder.viewPhase, hook)
}

private func everyCheck(_ phase: Int, _ hook: @escaping () -> Void) {
    _ = Effect(key: EffectOrder.current.next(phase)) { untrack(hook) }
}

/// A template's `@let`, made in its view's creation pass from the closure reading its value: `store()`, at its place in
/// the update pass, reads it once on every check of the view as a binding does (`Check`), and its readers read `value`,
/// tracking it. Before a read has given it a value, `value` throws as Angular's does.
public final class LetSlot<T> {
    nonisolated deinit {}
    private let read: () throws -> T
    private let held = Signal<T>(unset: "NG0314: Attempting to access a @let declaration whose value is not available yet")

    public init(_ read: @escaping () throws -> T) { self.read = read }

    public var value: T { held.value }

    public func store() {
        Check(abortOnThrow: true, read) { [held] in held.value = $0 }
    }
}

/// Angular refreshes an embedded view (an `@if` branch, a `@for` row) after the bindings of the view declaring it, in
/// the order its containers hold them, before that view's child components: `collect` runs a view's bindings, then the
/// update passes of the branches and rows they made (`later`), each in the owner and scope it was made in. A branch a
/// re-run condition makes outside any `collect` is updated at once.
public enum EmbeddedViews {
    private struct Held {
        let owner: Owner?
        let scope: EffectOrder.Scope
        let update: () throws -> Void
    }

    private static var held: [[Held]] = []

    static func begin() { held.append([]) }

    static func flush() throws {
        guard !held.isEmpty else { return }
        let updates = held.removeLast()
        for h in updates {
            try untrack {
                try EffectOrder.resume(h.scope) {
                    if let owner = h.owner { try owner.run(h.update) } else { try h.update() }
                }
            }
        }
    }

    public static func collect(_ bindings: () throws -> Void) throws {
        begin()
        do {
            try bindings()
        } catch {
            if !held.isEmpty { held.removeLast() }
            throw error
        }
        try flush()
    }

    public static func later(_ update: @escaping () throws -> Void) throws {
        if held.isEmpty { return try update() }
        held[held.count - 1].append(Held(owner: Owner.current, scope: EffectOrder.current, update: update))
    }
}

/// A pure Angular pipe at one binding site (`ɵɵpipeBind1`…): `transform` runs when an argument is no longer
/// `Object.is` the one it last ran with, and otherwise the result it gave is returned. What it throws is not kept.
public final class PurePipeCache {
    nonisolated deinit {}
    private var arguments: [Any?]?
    private var result: AnyObject?

    private final class Kept<R> {
        let value: R
        init(_ value: R) { self.value = value }
    }

    public init() {}

    private func run<R>(_ given: [Any?], _ transform: () throws -> R) rethrows -> R {
        if let arguments, arguments.count == given.count, zip(arguments, given).allSatisfy({ jsSameValue($0, $1) }), let kept = result as? Kept<R> {
            return kept.value
        }
        let value = try transform()
        arguments = given
        result = Kept(value)
        return value
    }

    public func pure1<A, R>(_ a: A, _ transform: (A) throws -> R) rethrows -> R { try run([a]) { try transform(a) } }
    public func pure2<A, B, R>(_ a: A, _ b: B, _ transform: (A, B) throws -> R) rethrows -> R { try run([a, b]) { try transform(a, b) } }
    public func pure3<A, B, C, R>(_ a: A, _ b: B, _ c: C, _ transform: (A, B, C) throws -> R) rethrows -> R { try run([a, b, c]) { try transform(a, b, c) } }
    public func pure4<A, B, C, D, R>(_ a: A, _ b: B, _ c: C, _ d: D, _ transform: (A, B, C, D) throws -> R) rethrows -> R { try run([a, b, c, d]) { try transform(a, b, c, d) } }
    public func pure5<A, B, C, D, E, R>(_ a: A, _ b: B, _ c: C, _ d: D, _ e: E, _ transform: (A, B, C, D, E) throws -> R) rethrows -> R { try run([a, b, c, d, e]) { try transform(a, b, c, d, e) } }
}

/// `inject(ChangeDetectorRef)`: binds to the component's own view when injected inside `AngularView.construct`,
/// or the declaring view otherwise (directives, pipes). `markForCheck` marks it and its ancestors up to its root host
/// view dirty; `detectChanges` refreshes only its own view subtree.
public final class ChangeDetectorRef {
    nonisolated deinit {}
    weak var view: AngularView?

    init(_ view: AngularView?) { self.view = view }

    public static func current() -> ChangeDetectorRef {
        if let frame = AngularView.frames.last {
            let ref = ChangeDetectorRef(nil)
            frame.refs.append(ref)
            return ref
        }
        return ChangeDetectorRef(EffectOrder.current.view)
    }

    public func markForCheck() {
        if Zone.enabled { view?.markDirty(); return }
        Reactivity.markForCheck(view)
    }

    /// Refreshes this view subtree now, under both zone.js and zoneless modes.
    public func detectChanges() {
        guard let view else { return }
        Zone.detectChanges(in: view)
    }

    public func detach() {}
    public func reattach() {}
    public func checkNoChanges() {}
}
