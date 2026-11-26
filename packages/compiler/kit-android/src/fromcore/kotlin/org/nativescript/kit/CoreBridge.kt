package org.nativescript.kit

// What compiled templates call (the code generator's vocabulary), over the
// classes compiled from @nativescript/core: children are added as
// a framework's renderer adds them, properties set as the XML builder
// sets them, errors reported as core reports what nothing catches.

/** Registered `ViewClassMeta` (`insertChild` / `removeChild`) hooks from `registerElement(tag, () => Class, meta)`. */
private object ViewMetaRegistry {
    data class Entry(val insertChild: Any?, val removeChild: Any?)
    private val byName = HashMap<String, Entry>()
    private val byClass = HashMap<Class<*>, Entry>()

    fun register(tag: String, resolver: Any?, meta: Any?) {
        val m = jsBox(meta)
        if (jsIsNullish(m)) return
        val insertChild = jsGet(m, "insertChild").let { if (jsIsNullish(it)) null else it }
        val removeChild = jsGet(m, "removeChild").let { if (jsIsNullish(it)) null else it }
        if (insertChild == null && removeChild == null) return
        val entry = Entry(insertChild, removeChild)
        byName[tag.lowercase()] = entry
        val ctor = try { if (!jsIsNullish(resolver)) jsCall(resolver) else null } catch (_: Throwable) { null }
        when (ctor) {
            is Class<*> -> {
                byClass[ctor] = entry
                byName[ctor.simpleName.lowercase()] = entry
            }
            else -> if (ctor != null && !jsIsNullish(ctor)) {
                val name = jsConstructorName(ctor)
                if (name.isNotEmpty() && name != "Object") byName[name.lowercase()] = entry
            }
        }
    }

    fun meta(owner: ViewBase): Entry? {
        var c: Class<*>? = owner.javaClass
        while (c != null && c != Any::class.java) {
            byClass[c]?.let { return it }
            byName[c.simpleName.lowercase()]?.let { return it }
            c = c.superclass
        }
        return byName[jsConstructorName(owner).lowercase()]
    }
}

/** Registers a plugin element's `ViewClassMeta` (`insertChild` / `removeChild`) so compiled templates attach children through it. */
fun kitRegisterViewMeta(tag: String, resolver: Any?, meta: Any?) {
    ViewMetaRegistry.register(tag, resolver, meta)
}

/** The template children of a container: its static views and its regions, in template order. */
class TemplateChildren internal constructor(owner: ViewBase) : RegionHost {
    private val owner = java.lang.ref.WeakReference(owner)
    private val parts = mutableListOf<RegionPart>()
    /** The views this template put in the container, in order. */
    private var placed: List<ViewBase> = emptyList()

    fun add(view: ViewBase) {
        parts.add(RegionPart.Child(view))
        apply()
    }

    fun addRegion(region: Region): Region {
        region.host = this
        parts.add(RegionPart.Nested(region))
        if (region.views.isNotEmpty()) apply()
        return region
    }

    override fun regionChanged(region: Region) = apply()

    /** The container's children made to match the template's. */
    private fun apply() {
        val owner = owner.get() ?: return
        val next = parts.flatMap { it.views }
        jsReport {
            val meta = ViewMetaRegistry.meta(owner)
            if (meta != null) {
                val kept = next.toSet()
                val active = ArrayList<ViewBase>()
                for (old in placed) {
                    if (old in kept) active.add(old)
                    else if (meta.removeChild != null) jsCall(meta.removeChild, owner, old)
                }
                val keptOrder = next.filter { v -> active.any { it === v } }
                if (active.size == keptOrder.size && active.indices.any { active[it] !== keptOrder[it] } && meta.removeChild != null) {
                    for (old in active) jsCall(meta.removeChild, owner, old)
                    active.clear()
                }
                val activeSet = java.util.Collections.newSetFromMap(java.util.IdentityHashMap<ViewBase, Boolean>())
                activeSet.addAll(active)
                if (meta.insertChild != null) {
                    for ((index, view) in next.withIndex()) {
                        if (activeSet.contains(view)) continue
                        val nextSibling = next.subList(index + 1, next.size).firstOrNull { activeSet.contains(it) }
                        jsCall(meta.insertChild, owner, view, nextSibling)
                        activeSet.add(view)
                    }
                }
            } else when (owner) {
                is LayoutBase -> {
                    val kept = next.toSet()
                    for (old in placed) if (old !in kept && old is View) owner.removeChild(old)
                    for ((index, view) in next.filterIsInstance<View>().withIndex()) {
                        val at = owner.getChildIndex(view)
                        if (at == index.toDouble()) continue
                        if (at >= 0) owner.removeChild(view)
                        // At the end, added as a renderer adds it: core then appends the native view, where an index
                        // would place it below the native view at that position (a border's, which is no child).
                        if (index.toDouble() == owner.getChildrenCount()) owner.addChild(view) else owner.insertChild(view, index.toDouble())
                    }
                }
                is Page -> {
                    val bar = next.lastOrNull { it is ActionBar } as ActionBar?
                    if (bar != null && bar !== owner.actionBar) owner.actionBar = bar
                    val content = next.lastOrNull { it !is ActionBar } as? View
                    if (content !== owner.content) owner.content = content
                }
                is ContentView -> {
                    val shown = next.lastOrNull() as? View
                    if (shown !== owner.content) owner.content = shown
                }
                is Frame -> {
                    // The first page is the one shown first; a view that is not a page is wrapped in one.
                    val first = next.firstOrNull()
                    if (placed.isEmpty() && first != null) {
                        val page = first as? Page ?: Page().also { it.content = first as? View }
                        owner.navigate(JSObject("create" to jsFunction { page }, "animated" to false))
                    }
                }
                else -> for (view in next) if (placed.none { it === view }) jsCallMethod(owner, "_addChildFromBuilder", jsConstructorName(view), view)
            }
        }
        placed = next
    }
}

private val styleAccessors = java.util.concurrent.ConcurrentHashMap<Pair<Class<*>, String>, Boolean>()

/** Whether the view's class reads the key through an accessor of its own or its prototype's (`get flexGrow()`). */
private fun hasStyleAccessor(cls: Class<*>, key: String): Boolean = styleAccessors.getOrPut(cls to key) {
    val getter = "get" + key.replaceFirstChar { it.uppercase() }
    JSPrototypes.holder(cls, key) != null || cls.methods.any { it.name == getter && it.parameterCount == 0 }
}

/** The name of a view's class as core's builder knows it (`ActionItem`). */
private fun jsConstructorName(view: Any): String = (view as? JSDynamic)?.jsClassName ?: view.javaClass.simpleName

private val templateChildrenKey = jsSymbol("NativeScriptKit:templateChildren")

val ViewBase.templateChildren: TemplateChildren
    get() {
        (jsGet(this, templateChildrenKey.key) as? TemplateChildren)?.let { return it }
        val made = TemplateChildren(this)
        jsSet(this, templateChildrenKey.key, made)
        return made
    }

/** A template's child, after those before it. */
fun ViewBase.kitAddChild(child: ViewBase) = templateChildren.add(child)

/** A template child naming a slot (`hostSlot`) the view has: set as that property, as the driver does. */
fun ViewBase.kitAddTemplateChild(child: ViewBase) {
    val slot = jsGet(child, "hostSlot") as? String
    if (slot != null && jsHasKey(this, slot)) kitSet(slot, child) else kitAddChild(child)
}

/** A run of children an `if` or `for` owns, at this point in template order. */
fun ViewBase.kitAddRegion(): Region = templateChildren.addRegion(Region(null))

/** A region made before its container mounts it, with what it already holds. */
fun ViewBase.kitAddRegion(region: Region): Region = templateChildren.addRegion(region)

/**
 * An attribute's value, as a renderer sets it: `ios:` attributes are for the other platform,
 * `android:` ones for this; a dotted name sets the path's last member, making objects along a path that has none.
 */
fun ViewBase.kitSet(name: String, given: Any?) {
    if (name.startsWith("ios:") || name.startsWith("ios.")) return
    val value = jsBox(given)
    val key = if (name.startsWith("android:")) name.removePrefix("android:") else name
    jsReport {
        // `style="color: red"`: core's `style` setter takes a string as inline CSS, which its Kotlin accessor, typed `Style`, cannot.
        if (key == "style" && value is String) { setInlineStyle(value); return@jsReport }
        val path = key.split(".")
        if (path.size == 1) {
            // A style property the view's accessor passes to its style (`backgroundColor`), which converts what the template gives;
            // without such an accessor (`zIndex`) the value lands on the object and styles nothing, as in NativeScript.
            val styled = JSPrototypes.holder(Style::class.java, key) != null
            val holder = JSPrototypes.holder(javaClass, key)
            // View.prototype accessors core defines for style properties (`flexWrapBefore`) take a typed value, which a
            // template's text would be coerced to (`"true"` to false); the style's converter parses it as NativeScript does.
            if (styled && value is String && holder != null && holder === JSPrototypes.holder(View::class.java, key)) {
                style?.let { jsSet(it, key, value); return@jsReport }
            }
            if (holder != null) {
                // A property of the view's own (an ActionItem's `visibility`), or an accessor passing a typed value to the style.
                try { set(key, value) } catch (e: ClassCastException) { if (styled) style?.let { jsSet(it, key, value) } ?: throw e else throw e }
                return@jsReport
            }
            if (styled && hasStyleAccessor(javaClass, key)) style?.let { jsSet(it, key, value); return@jsReport }
            set(key, value)
            return@jsReport
        }
        var target: Any? = this
        for (member in path.dropLast(1)) {
            var next = jsGet(target, member)
            if (jsIsNullish(next)) { next = JSObject(); jsSet(target, member, next) }
            target = next
        }
        jsSet(target, path.last(), value)
    }
}

/**
 * A listener for a template's event binding. A list's `itemTap` carries the row's item context
 * (`item`, `index`, `even`, `odd`), as a framework's ListView adds it.
 */
fun ViewBase.kitOn(eventName: String, handler: (EventData) -> Unit) {
    val list = if (eventName == "itemTap") this as? ListView else null
    jsReport {
        on(eventName, { data ->
            if (list != null) {
                val index = jsToNumber(jsGet(data, "index"))
                jsReport { jsSet(data, "item", list._getDataItem(index)) }
                jsSet(data, "even", index % 2.0 == 0.0)
                jsSet(data, "odd", index % 2.0 != 0.0)
            }
            handler(data)
            // Promise jobs run when a handler returns: a looper kept busy by redrawing views never idles.
            Microtasks.checkpoint()
        })
    }
}

/** What an event carries beyond its name and sender (`value`, `index`…), read by name. */
val EventData.value: Any? get() = jsGet(this, "value")

/** `$navigateTo(Component)`: the topmost frame shows the view the template makes. */
fun kitNavigate(animated: Boolean = true, create: () -> View) {
    jsReport {
        val frame = FrameBase.topmost() ?: return@jsReport
        frame.navigate(JSObject("create" to jsFunction { create() }, "animated" to animated))
    }
}

/** `$navigateBack()`. */
fun kitNavigateBack() {
    jsReport { FrameBase.goBack() }
}

/** The pages a navigation is building, innermost last: a page component renders into the innermost. */
internal val pagesBuilding = ArrayList<Page>()

/** The page a page component's template fills. */
fun routedPage(): Page = pagesBuilding.lastOrNull() ?: Page()

// List templates

/** A row's item and index as its template's bindings read them. A recycled cell keeps its views; writing the next item re-runs only its bindings. */
class ListRow<Item> internal constructor(item: Item, index: Double) {
    val item = Signal(item) { _, _ -> false }
    val index = Signal(index)
}

/** A list row's item context, what an `itemTemplateSelector` receives. */
class ListItem<T>(val item: T, val index: Double, val even: Boolean, val odd: Boolean)

private val listRowKey = jsSymbol("NativeScriptKit:listRow")
private val listTemplateKey = jsSymbol("NativeScriptKit:listTemplate")

/**
 * A ListView's items and the templates that render them, as a framework gives them to core:
 * `itemTemplates` naming each template, the selector choosing a row's template, and each row's view made
 * on `itemLoading`, where a reused cell's view is kept when its template is the row's. Items that throw are
 * reported and the list keeps its items; a selector that throws is reported and the row takes the default template.
 */
fun <Item> ListView.bind(items: () -> JSArray<Item>, templates: List<String> = listOf("default"), selector: ((Item, Double) -> String)? = null, render: ((String, ListRow<Item>) -> View)? = null) =
    kitBindItems(items, templates, selector, render)

/** Any view taking core's item templates as ListView does (`itemTemplates`, `itemLoading`, `items`): a plugin's Pager. */
fun <Item> ViewBase.kitBindItems(items: () -> JSArray<Item>, templates: List<String> = listOf("default"), selector: ((Item, Double) -> String)? = null, render: ((String, ListRow<Item>) -> View)? = null) {
    var current: List<Item> = emptyList()
    bindRows(
        templates, selector, render,
        selected = { args -> jsToNumber(args.getOrNull(1)).let { index -> if (index < 0 || index.toInt() >= current.size) null else current[index.toInt()] to index } },
        loading = { data -> jsToNumber(jsGet(data, "index")).let { index -> if (index < 0 || index.toInt() >= current.size) null else current[index.toInt()] to index } },
    )
    val list = java.lang.ref.WeakReference(this)
    listItems(items) { elements ->
        current = elements
        list.get()?.kitSet("items", JSArray<Any?>(elements.map { it as Any? }))
    }
}

/**
 * A sectioned ListView (`sectioned`): its items are the sections, each holding its rows in `items`, which core reads
 * by name; `itemLoading` gives a row's `section` and its `index` in that section.
 */
fun <Section, Row> ListView.kitBindSections(sections: () -> JSArray<Section>, rows: (Section) -> List<Row>, templates: List<String> = listOf("default"), selector: ((Row, Double) -> String)? = null, render: ((String, ListRow<Row>) -> View)? = null) {
    var currentRows: List<List<Row>> = emptyList()
    @Suppress("UNCHECKED_CAST")
    bindRows(
        templates, selector, render,
        selected = { args -> (args.getOrNull(0) as Row) to jsToNumber(args.getOrNull(1)) },
        loading = { data ->
            val section = jsToNumber(jsGet(data, "section")).toInt()
            val index = jsToNumber(jsGet(data, "index"))
            val inSection = currentRows.getOrNull(section)
            if (inSection == null || index < 0 || index.toInt() >= inSection.size) null else inSection[index.toInt()] to index
        },
    )
    val list = java.lang.ref.WeakReference(this)
    listSections(sections, rows) { all, grouped ->
        currentRows = grouped
        list.get()?.kitSet("items", JSArray<Any?>(all.map { it as Any? }))
    }
}

/** The template a row's selector names; one that throws is reported, and the row takes the default template. */
private fun <Row> selectedTemplate(selector: (Row, Double) -> String, item: Row, index: Double): String =
    try {
        selector(item, index)
    } catch (e: Throwable) {
        jsReportUncaught(jsCaught(e))
        "default"
    }

/** The templates, selector and `itemLoading` of a view taking item templates; `selected` and `loading` find a row and its index. */
private fun <Row> ViewBase.bindRows(templates: List<String>, selector: ((Row, Double) -> String)?, render: ((String, ListRow<Row>) -> View)?, selected: (List<Any?>) -> Pair<Row, Double>?, loading: (EventData) -> Pair<Row, Double>?) {
    val rowScope = RowScope()
    val reports = RenderReports("${jsConstructorName(javaClass)} item template")
    if (render != null) {
        kitSet("itemTemplates", JSArray<Any?>(templates.map { key -> JSObject("key" to key, "createView" to jsFunction { null }) }))
    }
    if (selector != null) {
        kitSet("itemTemplateSelector", jsFunction { args ->
            val found = selected(args)
            if (found == null) templates.firstOrNull() else selectedTemplate(selector, found.first, found.second)
        })
    }
    kitOn("itemLoading") { data ->
        val (item, index) = loading(data) ?: return@kitOn
        val key = selector?.let { selectedTemplate(it, item, index) } ?: templates.firstOrNull() ?: "default"
        val reused = jsGet(data, "view") as? ViewBase
        @Suppress("UNCHECKED_CAST")
        val row = reused?.let { jsGet(it, listRowKey.key) as? ListRow<Row> }
        if (reused != null && row != null && jsGet(reused, listTemplateKey.key) == key) {
            val before = Reactivity.pending()
            row.item.value = item
            row.index.value = index
            Reactivity.flushScoped(after = before)
            return@kitOn
        }
        if (render == null) return@kitOn
        val made = ListRow(item, index)
        // A template that throws is reported, and its row shows an empty view.
        val view = try {
            rowScope.render { render(key, made) }.also { reports.succeeded() }
        } catch (e: Throwable) {
            reports.failed(e)
            runCatching { ContentView() }.getOrNull() ?: return@kitOn
        }
        jsSet(view, listRowKey.key, made)
        jsSet(view, listTemplateKey.key, key)
        jsSet(data, "view", view)
    }
}
