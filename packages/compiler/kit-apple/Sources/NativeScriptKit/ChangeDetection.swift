import Foundation

/// A watcher: `changed` runs with the new and old value when `source`'s
/// value is no longer `Object.is` the last one, and at once when `immediate`
/// (old undefined); what `changed` reads is not tracked.
public func Watch<T>(immediate: Bool, _ source: @escaping () -> T, _ changed: @escaping (T, T?) -> Void) {
    var last: T?
    var started = false
    Effect {
        let value = source()
        let old = last
        last = value
        if !started {
            started = true
            if immediate { untrack { changed(value, nil) } }
            return
        }
        if let old, jsSameValue(old, value) { return }
        untrack { changed(value, old) }
    }
}

extension EffectOrder {
    private static var users = 0

    /// A component's own effect: after every template effect a write invalidates, in creation order.
    public static func user<T>(_ body: () -> T) -> T {
        users += 1
        return run(Scope(prefix: [Int.max, users]), body)
    }
}
