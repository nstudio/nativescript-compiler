import UIKit

// What compiled templates call (the code generator's vocabulary), over the
// classes compiled from @nativescript/core: children are added as
// a framework's renderer adds them, properties set as the XML builder
// sets them, errors reported as core reports what nothing catches.

/// Registered `ViewClassMeta` (`insertChild` / `removeChild`) hooks from `registerElement(tag, () => Class, meta)`.
private enum ViewMetaRegistry {
    struct Entry {
        let insertChild: Any?
        let removeChild: Any?
    }
    private static var byName: [String: Entry] = [:]
    private static var byType: [ObjectIdentifier: Entry] = [:]

    static func register(_ tag: String, _ resolver: Any?, _ meta: Any?) {
        guard let m = jsFlat(meta), !jsIsNullish(m) else { return }
        let insertChild = (try? jsGet(m, "insertChild")).flatMap { jsIsNullish($0) ? nil : $0 }
        let removeChild = (try? jsGet(m, "removeChild")).flatMap { jsIsNullish($0) ? nil : $0 }
        guard insertChild != nil || removeChild != nil else { return }
        let entry = Entry(insertChild: insertChild, removeChild: removeChild)
        byName[tag.lowercased()] = entry
        if let resolver = jsFlat(resolver), !jsIsNullish(resolver), let ctor = try? jsCall(resolver) {
            if let cls = ctor as? Any.Type {
                byType[ObjectIdentifier(cls)] = entry
                byName[String(describing: cls).lowercased()] = entry
            }
            let name = jsConstructorName(ctor)
            if !name.isEmpty, name != "Object" { byName[name.lowercased()] = entry }
        }
    }

    static func meta(for view: ViewBase) -> Entry? {
        var cls: AnyClass? = type(of: view)
        while let cur = cls {
            if let hit = byType[ObjectIdentifier(cur)] { return hit }
            if let hit = byName[String(describing: cur).lowercased()] { return hit }
            cls = class_getSuperclass(cur)
        }
        let name = jsConstructorName(view).lowercased()
        return byName[name]
    }
}

/// Registers a plugin element's `ViewClassMeta` (`insertChild` / `removeChild`) so compiled templates attach children through it.
public func kitRegisterViewMeta(_ tag: String, _ resolver: Any?, _ meta: Any?) {
    ViewMetaRegistry.register(tag, resolver, meta)
}

/// The template children of a container: its static views and its regions, in template order.
final class TemplateChildren: RegionHost {
    nonisolated deinit {}
    private weak var owner: ViewBase?
    private var parts: [RegionPart] = []
    /// The views this template put in the container, in order.
    private var placed: [ViewBase] = []

    init(_ owner: ViewBase) { self.owner = owner }

    func add(_ view: ViewBase) {
        parts.append(.view(view))
        apply()
    }

    func addRegion(_ region: Region) -> Region {
        region.host = self
        parts.append(.region(region))
        if !region.views.isEmpty { apply() }
        return region
    }

    func regionChanged(_ region: Region) { apply() }

    /// The container's children made to match the template's.
    private func apply() {
        guard let owner else { return }
        let next: [ViewBase] = parts.flatMap(\.views)
        jsReport {
            if let meta = ViewMetaRegistry.meta(for: owner) {
                let kept = Set(next.map(ObjectIdentifier.init))
                var active: [ViewBase] = []
                for old in placed {
                    if kept.contains(ObjectIdentifier(old)) {
                        active.append(old)
                    } else if let remove = meta.removeChild {
                        _ = try jsCall(remove, owner, old)
                    }
                }
                let keptOrder = next.filter { view in active.contains(where: { $0 === view }) }
                if active.count == keptOrder.count, zip(active, keptOrder).contains(where: { $0 !== $1 }), let remove = meta.removeChild {
                    for old in active { _ = try jsCall(remove, owner, old) }
                    active = []
                }
                var activeIds = Set(active.map(ObjectIdentifier.init))
                if let insert = meta.insertChild {
                    for (index, view) in next.enumerated() where !activeIds.contains(ObjectIdentifier(view)) {
                        let nextSibling = next.dropFirst(index + 1).first { activeIds.contains(ObjectIdentifier($0)) }
                        _ = try jsCall(insert, owner, view, nextSibling as Any?)
                        activeIds.insert(ObjectIdentifier(view))
                    }
                }
            } else if let layout = owner as? LayoutBase {
                let kept = Set(next.map(ObjectIdentifier.init))
                for old in placed where !kept.contains(ObjectIdentifier(old)) {
                    if let view = old as? View { try layout.removeChild(view) }
                }
                for (index, view) in next.compactMap({ $0 as? View }).enumerated() {
                    let at = try layout.getChildIndex(view)
                    if at == Double(index) { continue }
                    if at >= 0 { try layout.removeChild(view) }
                    // At the end, added as a renderer adds it: core then appends the native view, where an index
                    // would place it below the native view at that position (a border's, which is no child).
                    if try Double(index) == layout.getChildrenCount() { try layout.addChild(view) } else { _ = try layout.insertChild(view, Double(index)) }
                }
            } else if let page = owner as? Page {
                if let bar = next.last(where: { $0 is ActionBar }) as? ActionBar, bar !== page.actionBar { page.actionBar = bar }
                let content = next.last { !($0 is ActionBar) } as? View
                if content !== page.content { page.content = content }
            } else if let content = owner as? ContentView {
                let shown = next.last as? View
                if shown !== content.content { content.content = shown }
            } else if let frame = owner as? Frame {
                // The first page is the one shown first; a view that is not a page is wrapped in one.
                if placed.isEmpty, let first = next.first {
                    let page: Page
                    if let p = first as? Page { page = p } else { page = try Page(); page.content = first as? View }
                    let entry = JSObject([("create", { (_: [Any?]) throws -> Any? in page } as JSFunction), ("animated", false)])
                    try frame.navigate(entry)
                }
            } else {
                for view in next where !placed.contains(where: { $0 === view }) {
                    _ = try jsCallMethod(owner, "_addChildFromBuilder", jsConstructorName(view), view)
                }
            }
        }
        placed = next
    }
}

private let templateChildrenKey = JSSymbol("NativeScriptKit:templateChildren")

extension ViewBase {
    var templateChildren: TemplateChildren {
        if let found = self[jsKey: templateChildrenKey.key] as? TemplateChildren { return found }
        let made = TemplateChildren(self)
        self[jsKey: templateChildrenKey.key] = made
        return made
    }

    /// A template's child, after those before it.
    public func kitAddChild(_ child: ViewBase) { templateChildren.add(child) }

    /// A template child naming a slot (`hostSlot`) the view has: set as that property, as the driver does.
    public func kitAddTemplateChild(_ child: ViewBase) {
        if let slot = child[jsKey: "hostSlot"] as? String, jsHasKey(self, slot) { kitSet(slot, child) } else { kitAddChild(child) }
    }

    /// A run of children an `if` or `for` owns, at this point in template order.
    public func kitAddRegion() -> Region { templateChildren.addRegion(Region(host: nil)) }

    /// A region made before its container mounts it, with what it already holds.
    @discardableResult
    public func kitAddRegion(_ region: Region) -> Region { templateChildren.addRegion(region) }

    /// An attribute's value, as a renderer sets it: `android:` attributes are for the other platform,
    /// `ios:` ones for this; a dotted name sets the path's last member (`ios.position` sets `ios`'s
    /// `position`, as `set-value` does), making objects along a path that has none.
    public func kitSet(_ name: String, _ value: Any?) {
        if name.hasPrefix("android:") || name.hasPrefix("android.") { return }
        let value = jsFlat(value)
        let key = name.hasPrefix("ios:") ? String(name.dropFirst(4)) : name
        jsReport {
            let path = key.split(separator: ".").map(String.init)
            guard path.count > 1 else { return try self.set(key, value) }
            var target: Any? = self
            for member in path.dropLast() {
                var next = try jsGet(target, member)
                if jsIsNullish(next) { next = JSObject(); try jsSet(target, member, next) }
                target = next
            }
            if let last = path.last { try jsSet(target, last, value) }
        }
    }

    /// A listener for a template's event binding. A list's `itemTap` carries the row's item context
    /// (`item`, `index`, `even`, `odd`), as a framework's ListView adds it.
    public func kitOn(_ eventName: String, _ handler: @escaping (EventData) -> Void) {
        let list = eventName == "itemTap" ? self as? ListView : nil
        jsReport {
            try self.on(eventName, { (data: EventData?) in
                guard let data else { return }
                if let list {
                    let index = jsToNumber(data[jsKey: "index"])
                    jsReport { data[jsKey: "item"] = try list._getDataItem(index) }
                    data[jsKey: "even"] = jsMod(index, 2) == 0
                    data[jsKey: "odd"] = jsMod(index, 2) != 0
                }
                handler(data)
            })
        }
    }
}

extension RegionFragment {
    /// The same vocabulary for a branch or row whose views a region holds.
    public func kitAddChild(_ child: ViewBase) { addChild(child) }
    public func kitAddTemplateChild(_ child: ViewBase) { addTemplateChild(child) }
    public func kitAddRegion() -> Region { addRegion() }
}

extension EventData {
    /// What an event carries beyond its name and sender (`value`, `index`…), read by name.
    public var value: Any? { self[jsKey: "value"] }
}

/// `$navigateTo(Component)`: the topmost frame shows the view the template makes.
public func kitNavigate(animated: Bool = true, _ create: @escaping () throws -> View) {
    jsReport {
        guard let frame = try Frame.topmost() else { return }
        try frame.navigate(JSObject([("create", { (_: [Any?]) throws -> Any? in try create() } as JSFunction), ("animated", animated)]))
    }
}

/// `$navigateBack()`.
public func kitNavigateBack() {
    jsReport { _ = try Frame.goBack() }
}

extension Page {
    /// The pages a navigation is building, innermost last: a page component renders into the innermost.
    static var building: [Page] = []

    /// The page a page component's template fills.
    public static func routed() throws -> Page {
        if let page = building.last { return page }
        return try Page()
    }
}

/// The app: its stylesheet, which core loads as `app.css`, then the root view the template makes, as `Application.run({ create })` starts it.
public enum NativeScriptApplication {
    /// The app's stylesheet as its build parsed it, for an app whose own entry runs core's `Application.run`.
    public static var cssAST: String? {
        get { CorePackages.appCSSAST }
        set { CorePackages.appCSSAST = newValue; CorePackages.installModuleLoader() }
    }

    /// The app, its stylesheet given as the AST its NativeScript build ships (`css2json-loader`'s).
    public static func run(cssAST: String, _ root: @escaping () throws -> View) {
        CorePackages.appCSSAST = cssAST
        run(css: "", root)
    }

    /// What every app's entry sets up before its first module runs, whether the kit runs the app or the app's own `Application.run` does.
    public static func prepare(cssAST: String? = nil) {
        // Console output reaches a pipe (`simctl launch --console`, Xcode) line by line, as the JS runtime's does.
        setvbuf(stdout, nil, _IOLBF, 0)
        UncaughtErrors.install()
        // Promise callbacks and reactive updates run after each batch of UIKit work (an event handler, a layout pass), as the JS runtime drains microtasks after native calls into script.
        JSEventLoop.installRunLoopObserver()
        if let cssAST { self.cssAST = cssAST }
        Probe.traceIfRequested()
        Probe.scheduleIfRequested()
    }

    public static func run(css: String, _ root: @escaping () throws -> View) {
        prepare()
        CorePackages.appCSS = css
        CorePackages.installModuleLoader()
        CoreModules.initialize()
        jsReport {
            try jsUnwrap(Core_application_application.Application, "run").run(JSObject([("create", { (_: [Any?]) throws -> Any? in try root() } as JSFunction)]))
        }
    }
}

// MARK: List templates

/// A row's view from its template; one whose template throws is reported and shows an empty view, and the list goes on.
private func rowView(_ rows: RowScope, _ reports: RenderReports, _ render: () throws -> View) -> View? {
    do {
        let view = try rows.render(render)
        reports.succeeded()
        return view
    } catch {
        reports.failed(error)
        return try? ContentView()
    }
}

/// A row's item and index as its template's bindings read them. A recycled
/// cell keeps its views; writing the next item re-runs only its bindings.
public final class ListRow<Item> {
    nonisolated deinit {}
    public let item: Signal<Item>
    public let index: Signal<Double>

    init(_ item: Item, _ index: Double) {
        self.item = Signal(item)
        self.index = Signal(index)
    }
}

/// A list row's item context, what an `itemTemplateSelector` receives.
public struct ListItem<T> {
    public let item: T
    public let index: Double
    public let even: Bool
    public let odd: Bool

    public init(item: T, index: Double, even: Bool, odd: Bool) {
        self.item = item
        self.index = index
        self.even = even
        self.odd = odd
    }
}

private let listRowKey = JSSymbol("NativeScriptKit:listRow")

/// The template a row's selector names; one that throws is reported, and the row takes the default template.
private func selectedTemplate<Item>(_ selector: (Item, Double) throws -> String, _ item: Item, _ index: Double) -> String {
    do { return try selector(item, index) } catch {
        jsReportUncaught(jsCaught(error))
        return "default"
    }
}
private let listTemplateKey = JSSymbol("NativeScriptKit:listTemplate")

// Any view hosting item templates as ListView does (items, itemTemplates, itemTemplateSelector, `itemLoading` taking
// the row's view): ListView, and plugins' that follow it, the Pager.
extension View {
    /// A ListView's items and the templates that render them, as a framework
    /// gives them to core: `itemTemplates` naming each template, the selector
    /// choosing a row's template, and each row's view made on `itemLoading`, where
    /// a reused cell's view is kept when its template is the row's. Core's own
    /// `default` template comes before any template a list names, so a list's
    /// templates make no views of their own. Items that throw are reported and the
    /// list keeps its items; a selector that throws is reported and the row takes
    /// the default template.
    public func bind<Items: Sequence>(items: @escaping () throws -> Items, templates: [String] = ["default"], selector: ((Items.Element, Double) throws -> String)? = nil,
                                      render: ((String, ListRow<Items.Element>) throws -> View)? = nil) {
        typealias Item = Items.Element
        var current: [Item] = []
        let rowScope = RowScope()
        let reports = RenderReports("\(jsConstructorName(self)) item template")
        if render != nil {
            kitSet("itemTemplates", JSArray<Any?>(templates.map { key in
                JSObject([("key", key), ("createView", { (_: [Any?]) throws -> Any? in nil } as JSFunction)]) as Any?
            }))
        }
        if let selector {
            kitSet("itemTemplateSelector", { (args: [Any?]) throws -> Any? in
                let index = jsToNumber(args.count > 1 ? args[1] : nil)
                guard index >= 0, Int(index) < current.count else { return templates.first }
                return selectedTemplate(selector, current[Int(index)], index)
            } as JSFunction)
        }
        kitOn("itemLoading") { data in
            let index = jsToNumber(data[jsKey: "index"])
            guard index >= 0, Int(index) < current.count else { return }
            let item = current[Int(index)]
            let key = selector.map { selectedTemplate($0, item, index) } ?? templates.first ?? "default"
            if let view = data[jsKey: "view"] as? ViewBase, let row = view[jsKey: listRowKey.key] as? ListRow<Item>,
               view[jsKey: listTemplateKey.key] as? String == key {
                let before = Reactivity.pending()
                row.item.value = item
                row.index.value = index
                Reactivity.flushScoped(after: before)
                return
            }
            guard let render else { return }
            let row = ListRow(item, index)
            guard let view = rowView(rowScope, reports, { try render(key, row) }) else { return }
            view[jsKey: listRowKey.key] = row
            view[jsKey: listTemplateKey.key] = key
            data[jsKey: "view"] = view
        }
        listItems(items) { [weak self] elements in
            current = elements
            self?.kitSet("items", JSArray<Any?>(elements.map { $0 as Any? }))
        }
    }

    /// A sectioned list (`sectioned` set): its items are the sections, each with its rows as core reads them
    /// (`section.items`); a row's template and view as for `bind(items:)`, at the row's section and index.
    /// A `header` renders the sticky header core makes for each section, from its `stickyHeaderTemplate` as a function, and
    /// binds it to the section core gives it as its binding context.
    public func bind<Sections: Sequence, Item>(sections: @escaping () throws -> Sections, rows: @escaping (Sections.Element) -> [Item], templates: [String] = ["default"],
                                               selector: ((Item, Double) throws -> String)? = nil, render: ((String, ListRow<Item>) throws -> View)? = nil,
                                               header: ((ListRow<Sections.Element>) throws -> View)? = nil) {
        typealias Section = Sections.Element
        var current: [[Item]] = []
        var sectionValues: [Section] = []
        let rowScope = RowScope()
        let reports = RenderReports("\(jsConstructorName(self)) item template")
        let itemAt = { (section: Double, index: Double) -> Item? in
            guard section >= 0, Int(section) < current.count, index >= 0, Int(index) < current[Int(section)].count else { return nil }
            return current[Int(section)][Int(index)]
        }
        if render != nil {
            kitSet("itemTemplates", JSArray<Any?>(templates.map { key in
                JSObject([("key", key), ("createView", { (_: [Any?]) throws -> Any? in nil } as JSFunction)]) as Any?
            }))
        }
        if let selector {
            // Core gives the row's item, its index in its section and the section's items.
            kitSet("itemTemplateSelector", { (args: [Any?]) throws -> Any? in
                guard let item = args.first.flatMap({ $0 as? Item }) else { return templates.first }
                return selectedTemplate(selector, item, jsToNumber(args.count > 1 ? args[1] : nil))
            } as JSFunction)
        }
        if let header {
            kitSet("stickyHeaderTemplate", { (_: [Any?]) throws -> Any? in
                guard let first = sectionValues.first else { return nil }
                let row = ListRow(first, 0)
                let view = try rowScope.render { try header(row) }
                view.kitOn("bindingContextChange") { [weak view] _ in
                    guard let section = view?.bindingContext as? Section else { return }
                    let before = Reactivity.pending()
                    row.item.value = section
                    row.index.value = Double(sectionValues.firstIndex { ($0 as AnyObject) === (section as AnyObject) } ?? 0)
                    Reactivity.flushScoped(after: before)
                }
                return view
            } as JSFunction)
        }
        kitOn("itemLoading") { data in
            let index = jsToNumber(data[jsKey: "index"])
            guard let item = itemAt(jsToNumber(data[jsKey: "section"]), index) else { return }
            let key = selector.map { selectedTemplate($0, item, index) } ?? templates.first ?? "default"
            if let view = data[jsKey: "view"] as? ViewBase, let row = view[jsKey: listRowKey.key] as? ListRow<Item>,
               view[jsKey: listTemplateKey.key] as? String == key {
                let before = Reactivity.pending()
                row.item.value = item
                row.index.value = index
                Reactivity.flushScoped(after: before)
                return
            }
            guard let render else { return }
            let row = ListRow(item, index)
            guard let view = rowView(rowScope, reports, { try render(key, row) }) else { return }
            view[jsKey: listRowKey.key] = row
            view[jsKey: listTemplateKey.key] = key
            data[jsKey: "view"] = view
        }
        listSections(sections, rows: rows) { [weak self] all, grouped in
            sectionValues = all
            current = grouped
            self?.kitSet("items", JSArray<Any?>(all.map { $0 as Any? }))
        }
    }
}
