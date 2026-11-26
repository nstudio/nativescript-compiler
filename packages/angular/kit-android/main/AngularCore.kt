package org.nativescript.kit

import java.util.IdentityHashMap

// @angular/core as compiled Angular apps call it: dependency injection, the references it injects, bootstrap.

typealias EffectRef = Effect

/** `inject(PendingTasks)`: tracks pending async tasks (no-op in compiled native apps). */
class PendingTasks {
    fun add(): () -> Unit = {}
    fun <T> run(task: () -> T): T = task()

    companion object {
        val shared = PendingTasks()
    }
}

/** `inject(DestroyRef)`: callbacks run when the injecting component's scope ends. */
class DestroyRef internal constructor(owner: Owner?) {
    private val owner = java.lang.ref.WeakReference(owner)

    /** Registers the callback; the function returned unregisters it. */
    fun onDestroy(callback: () -> Unit): () -> Unit {
        var active = true
        owner.get()?.onCleanup { if (active) jsReport { callback() } }
        return { active = false }
    }

    companion object {
        fun current(): DestroyRef = DestroyRef(Owner.current)
    }
}

/** `ElementRef`: a view of a template, as a view query (`@ViewChild('ref', { read: ElementRef })`) gives it. */
class ElementRef(nativeElement: Any? = null) {
    var nativeElement: Any? = nativeElement
        private set

    /** A component's own ElementRef, made with the component: its template's root view, once made. */
    fun attach(host: Any?) { nativeElement = host }

    companion object {
        private val hosts = mutableListOf<Any?>()

        /** Makes a directive of an element: its `inject(ElementRef)` is the element. */
        fun <T> hosting(host: Any?, make: () -> T): T {
            hosts.add(host)
            try { return make() } finally { hosts.removeAt(hosts.size - 1) }
        }

        /** `inject(ElementRef)`: the element whose directive is being made; elsewhere, a ref to no view. */
        fun current(): ElementRef = ElementRef(hosts.lastOrNull())
    }
}

/** `SimpleChange`: one input's change, as `ngOnChanges` receives it. */
class SimpleChange(var previousValue: Any?, var currentValue: Any?, var firstChange: Boolean) {
    fun isFirstChange(): Boolean = firstChange
}

fun forwardRef(fn: () -> Any?): Any? = fn

/** Angular's `booleanAttribute` input transform: `false` / `"false"` / `null` / `undefined` -> `false`, else `true`. */
fun booleanAttribute(value: Any?): Boolean {
    val v = jsBox(value)
    if (jsIsNullish(v)) return false
    if (v is Boolean) return v
    return jsToString(v) != "false"
}

/** Angular's `numberAttribute` input transform: parses a number or returns `fallbackValue` (`NaN`). */
fun numberAttribute(value: Any?, fallbackValue: Double = Double.NaN): Double {
    val v = jsBox(value)
    if (jsIsNullish(v)) return fallbackValue
    if (v is String && v.trim().isEmpty()) return fallbackValue
    val n = jsToNumber(v)
    return if (n.isNaN()) fallbackValue else n
}

fun resolveForwardRef(value: Any?): Any? {
    val flat = jsBox(value) ?: return null
    if (flat is Function0<*>) return try { flat.invoke() } catch (t: Throwable) { jsReportUncaught(jsCaught(t)); null }
    if (flat is JSFunction && flat.length == 0) return try { flat.invoke() } catch (t: Throwable) { jsReportUncaught(jsCaught(t)); null }
    return value
}

class Optional
class Self
class SkipSelf
class Host
class Inject(val token: Any?)

/**
 * The root injector: `providedIn: 'root'` services, each made on first use in the root scope (its
 * `inject(DestroyRef)` and effects belong there) and destroyed with the app, after which the next
 * use makes a new one, as a new bootstrap does.
 */
object AppInjector {
    internal var owner = Owner(null)
    internal val services = HashMap<Class<*>, Any>()
    private val making = HashSet<Class<*>>()

    @Suppress("UNCHECKED_CAST")
    fun <T : Any> service(type: Class<T>, make: () -> T): T {
        Injector.current?.let { active ->
            if (active !== Injector.shared) {
                val found = active.get(type, Injector.NOT_FOUND, null, root = false)
                if (found !== Injector.NOT_FOUND && type.isInstance(found)) return found as T
            }
        }
        Injector.lookupClassOverride(type)?.let { if (type.isInstance(it)) return it as T }
        services[type]?.let { return it as T }
        if (!making.add(type)) throw JSException(JSError("NG0200: Circular dependency in DI detected for ${type.simpleName}"))
        try {
            val made = Injector.atRoot { untrack { owner.run(make) } }
            services[type] = made
            return made
        } finally {
            making.remove(type)
        }
    }

    fun destroy() {
        val old = owner
        owner = Owner(null)
        services.clear()
        making.clear()
        Injector.reset()
        old.dispose()
    }
}

interface JSTokenKeyed {
    val jsTokenKey: Class<*>?
}

typealias NodeInjector = Injector

class Injector(providers: Any? = null, private val parent: Injector? = null) {
    /** A component's injector ([enter]): what its providers make belongs to the component, and goes when it does. */
    private var owner: Owner? = null
    private var entered: Injector? = null
    private val instanceValues = IdentityHashMap<Any, Any?>()
    private val instanceFactories = IdentityHashMap<Any, () -> Any?>()
    private val instanceMultiFactories = IdentityHashMap<Any, MutableList<() -> Any?>>()
    /** An environment injector's `ENVIRONMENT_INITIALIZER`s, run once it is made ([initialized]), in provider order. */
    private var pendingInitializers = mutableListOf<() -> Any?>()
    /** `StandaloneService`, provided per environment injector: each standalone component's own injector there, or null when its imports give no providers. */
    private val standaloneInjectors = HashMap<Class<*>, Injector?>()
    /**
     * A root view's injector made under component injectors ([enter]): those are asked first, up to the environment
     * injector they sit in, then the standalone injector ([parent]), as Angular asks element injectors first.
     */
    private var viewNodes: Injector? = null
    private var viewEnvironment: Injector? = null

    init {
        if (providers != null) registerInstance(providers)
    }

    fun get(token: Any?, notFoundValue: Any? = null, options: Any? = null): Any? = get(token, notFoundValue, options, root = true)

    /** Without [root], only what this injector and its ancestors provide: the root's answer for a service is the service's `shared`, which itself asks the active injector first. */
    internal fun get(token: Any?, notFoundValue: Any?, options: Any?, root: Boolean, until: Injector? = null): Any? {
        val unwrapped = resolveForwardRef(token)
        val skipSelf = (jsBox(jsGetOptional(options, "skipSelf")) as? Boolean) == true
        val selfOnly = (jsBox(jsGetOptional(options, "self")) as? Boolean) == true
        val key = tokenKey(unwrapped)
        if (!skipSelf && key != null) {
            if (instanceValues.containsKey(key)) return instanceValues[key]
            val multis = instanceMultiFactories[key]
            if (!multis.isNullOrEmpty()) {
                val values = multis.map { fn -> owned { runInContext(this) { try { fn() } catch (t: Throwable) { jsReportUncaught(jsCaught(t)); null } } } }
                val arr = JSArray(values.toMutableList())
                instanceValues[key] = arr
                return arr
            }
            val factory = instanceFactories[key]
            if (factory != null) {
                val v = owned { runInContext(this) { try { factory() } catch (t: Throwable) { jsReportUncaught(jsCaught(t)); null } } }
                instanceValues[key] = v
                return v
            }
        }
        if (selfOnly) return notFoundValue
        val nodes = viewNodes
        if (nodes != null) {
            val found = nodes.get(unwrapped, NOT_FOUND, null, false, viewEnvironment)
            if (found !== NOT_FOUND) return found
        }
        if (parent != null) return if (parent === until) notFoundValue else parent.get(unwrapped, notFoundValue, null, root, until)
        if (skipSelf || !root) return notFoundValue
        return resolveRoot(unwrapped, notFoundValue)
    }

    private fun initialized(): Injector {
        val initializers = pendingInitializers
        pendingInitializers = mutableListOf()
        for (initFn in initializers) runInContext(this) { try { initFn() } catch (t: Throwable) { jsReportUncaught(jsCaught(t)) } }
        return this
    }

    private fun registerInstance(providers: Any?) {
        fun walk(item: Any?) {
            val flat = jsBox(item) ?: return
            if (flat is JSArray<*>) {
                for (el in flat.storage) walk(el)
                return
            }
            if (flat is Function0<*>) {
                pendingInitializers.add { flat.invoke() }
                return
            }
            if (flat is JSFunction) {
                pendingInitializers.add { flat.invoke() }
                return
            }
            // A class: its own instance, as `{ provide: X, useClass: X }`.
            if (flat is Class<*>) {
                instanceFactories[flat] = { construct(flat) }
                instanceMultiFactories.remove(flat)
                instanceValues.remove(flat)
                return
            }
            if (flat is JSDynamic) {
                if ("providers" in flat.jsKeys) walk(flat.jsGet("providers"))
                if ("provide" in flat.jsKeys) parseProvider(flat, this)
            }
        }
        walk(providers)
    }

    fun provideSelf(instance: Any?) {
        val obj = jsBox(instance) ?: return
        instanceValues[obj::class.java] = obj
    }

    fun leave() {
        current = entered
    }

    private fun <T> owned(body: () -> T): T {
        val owner = owner ?: return body()
        return untrack { owner.run(body) }
    }

    companion object {
        internal val NOT_FOUND = Any()
        val shared = Injector()
        /** Kept by each effect and template scope as it is made, and current again while they run. */
        internal var current: Injector?
            get() = EffectOrder.ambient as? Injector
            set(value) { EffectOrder.ambient = value }
        val root: Injector get() = current ?: shared

        private val tokenValues = IdentityHashMap<Any, Any?>()
        private val tokenFactories = IdentityHashMap<Any, () -> Any?>()
        private val multiFactories = IdentityHashMap<Any, MutableList<() -> Any?>>()

        private fun tokenKey(token: Any?): Any? {
            val unwrapped = jsBox(resolveForwardRef(token))
            return (unwrapped as? JSTokenKeyed)?.jsTokenKey ?: unwrapped
        }

        /** The `ErrorHandler` the app provides, which hears what no script code caught, as Angular's zone hands it over. */
        /** `inject(ErrorHandler)`: the one provided, else Angular's own. */
        val errorHandler: ErrorHandler get() = inject(ErrorHandler::class.java) as? ErrorHandler ?: ErrorHandler.shared

        internal fun providedErrorHandler(): ErrorHandler? {
            val key = tokenKey(ErrorHandler::class.java) ?: return null
            if (!tokenValues.containsKey(key) && !tokenFactories.containsKey(key)) return null
            return resolveRoot(ErrorHandler::class.java) as? ErrorHandler
        }

        internal fun lookupClassOverride(type: Class<*>): Any? {
            if (tokenValues.containsKey(type)) return tokenValues[type]
            val factory = tokenFactories[type] ?: return null
            val v = try { factory() } catch (t: Throwable) { jsReportUncaught(jsCaught(t)); null }
            tokenValues[type] = v
            return v
        }

        fun create(options: Any?, parent: Injector? = null): Injector {
            val flat = jsBox(options) ?: return Injector(null, parent)
            if (flat is JSArray<*>) return Injector(flat, parent).initialized()
            val providers = jsGetOptional(flat, "providers") ?: flat
            val resolvedParent = (jsBox(jsGetOptional(flat, "parent")) as? Injector) ?: parent
            return Injector(providers, resolvedParent).initialized()
        }

        /**
         * `@Component({ providers })`: the component's own injector over the one it is made in, current from the
         * component's first field to the end of its constructor ([leave]), and in its view (`EffectOrder.view`).
         */
        fun enter(providers: Any?): Injector {
            val node = Injector(providers, current)
            node.owner = Owner()
            node.entered = current
            current = node
            return node
        }

        /**
         * `createRootViewInjector`: a standalone component created as a root view (bootstrap, route, dialog) is made and
         * rendered in its standalone injector, made from its imports the first time it is created over this environment
         * injector, which then runs the initializers that construct its modules.
         */
        fun <T> standalone(type: Class<*>, imports: Any?, make: () -> T): T {
            val active = current ?: shared
            var environment = active
            while (environment.owner != null) environment = environment.parent ?: shared
            val injector = if (environment.standaloneInjectors.containsKey(type)) environment.standaloneInjectors[type] else {
                val out = mutableListOf<Any?>()
                val dedup = mutableSetOf<Class<*>>()
                ngDeepForEach(imports) { walkNgModule(it, out, dedup) }
                val made = if (out.isEmpty()) null else Injector(JSArray(out), environment).initialized()
                environment.standaloneInjectors[type] = made
                made
            } ?: return make()
            if (active === environment) return runInContext(injector, make)
            val view = Injector(null, injector)
            view.viewNodes = active
            view.viewEnvironment = environment
            return runInContext(view, make)
        }

        /** What a root service makes and injects comes from the root, not from the providers of the component that injected it. */
        internal fun <T> atRoot(body: () -> T): T {
            val active = current
            current = null
            try { return body() } finally { current = active }
        }

        fun <T> runInContext(injector: Any?, fn: () -> T): T {
            val prev = current
            current = (jsBox(injector) as? Injector) ?: shared
            try { return fn() } finally { current = prev }
        }

        fun <T> root(make: () -> T): T = atRoot { untrack { AppInjector.owner.run(make) } }

        fun reset() {
            tokenValues.clear()
            tokenFactories.clear()
            multiFactories.clear()
            current = null
        }

        fun provide(token: Any?, useValue: Any? = null, useFactory: (() -> Any?)? = null) {
            val key = tokenKey(token) ?: return
            if (useFactory != null) {
                tokenFactories[key] = useFactory
                tokenValues.remove(key)
            } else {
                tokenValues[key] = useValue
                tokenFactories.remove(key)
            }
        }

        private fun instantiateClass(cls: Class<*>): Any? {
            try {
                val companionField = cls.getDeclaredField("Companion")
                val companion = companionField.get(null)
                // A package's service keeps `shared` as its own static: its root instance is the kit's `jsShared`.
                val methods = companion.javaClass.methods.filter { it.parameterCount == 0 }
                val sharedMethod = methods.firstOrNull { it.name == "getJsShared" } ?: methods.firstOrNull { it.name == "getShared" }
                if (sharedMethod != null) return sharedMethod.invoke(companion)
            } catch (_: Throwable) {}
            return try { construct(cls) } catch (_: Throwable) { null }
        }

        /** A new instance, as a child injector's `useClass` provider makes one of its own. */
        private fun construct(cls: Class<*>): Any? {
            val ctor = cls.declaredConstructors.firstOrNull { it.parameterCount == 0 } ?: return injectedConstruct(cls)
            ctor.isAccessible = true
            return try { ctor.newInstance() } catch (e: java.lang.reflect.InvocationTargetException) { throw e.targetException }
        }

        /** A service whose constructor takes what it injects: its companion's `jsConstruct` injects them from the active injector. */
        private fun injectedConstruct(cls: Class<*>): Any? {
            val companion = try { cls.getDeclaredField("Companion").get(null) } catch (_: Throwable) { return null }
            val make = companion.javaClass.methods.firstOrNull { it.name == "jsConstruct" && it.parameterCount == 0 } ?: return null
            return try { make.invoke(companion) } catch (e: java.lang.reflect.InvocationTargetException) { throw e.targetException }
        }

        private fun parseProvider(dyn: JSDynamic, target: Injector?) {
            val token = resolveForwardRef(dyn.jsGet("provide"))
            val key = tokenKey(token) ?: return
            val isMulti = (jsBox(dyn.jsGet("multi")) as? Boolean) == true
            val hasValue = "useValue" in dyn.jsKeys
            val valProp = dyn.jsGet("useValue")
            val factory = jsBox(dyn.jsGet("useFactory"))
            val existing = jsBox(dyn.jsGet("useExisting"))
            val useClass = jsBox(resolveForwardRef(dyn.jsGet("useClass")))
            val deps = (jsBox(dyn.jsGet("deps")) as? JSArray<*>)?.storage ?: emptyList<Any?>()
            val make: () -> Any? = {
                when {
                    hasValue -> valProp
                    factory != null -> {
                        val resolved = deps.map { dep ->
                            val flatDep = jsBox(dep)
                            if (flatDep is JSArray<*>) {
                                if (flatDep.storage.any { jsBox(it) is SkipSelf }) null
                                else flatDep.storage.lastOrNull()?.let { if (target != null) target.get(it) else inject(it) }
                            } else {
                                if (target != null) target.get(flatDep) else inject(flatDep)
                            }
                        }
                        jsCall(factory, *resolved.toTypedArray())
                    }
                    existing != null -> if (target != null) target.get(existing) else inject(existing)
                    useClass is Class<*> -> if (target != null) construct(useClass) else instantiateClass(useClass)
                    useClass != null -> jsCall(useClass)
                    key is Class<*> -> instantiateClass(key)
                    else -> null
                }
            }
            if (target != null) {
                if (isMulti) {
                    target.instanceMultiFactories.getOrPut(key) { mutableListOf() }.add(make)
                    target.instanceValues.remove(key)
                } else {
                    target.instanceFactories[key] = make
                    target.instanceValues.remove(key)
                }
            } else {
                if (isMulti) {
                    multiFactories.getOrPut(key) { mutableListOf() }.add(make)
                    tokenValues.remove(key)
                } else {
                    tokenFactories[key] = make
                    tokenValues.remove(key)
                }
            }
        }

        fun register(providers: Any?) {
            val initializers = mutableListOf<() -> Any?>()
            fun walk(item: Any?) {
                val flat = jsBox(item) ?: return
                if (flat is JSArray<*>) {
                    for (el in flat.storage) walk(el)
                    return
                }
                if (flat is Function0<*>) {
                    initializers.add { flat.invoke() }
                    return
                }
                if (flat is JSFunction) {
                    initializers.add { flat.invoke() }
                    return
                }
                if (flat is JSDynamic) {
                    if ("providers" in flat.jsKeys) walk(flat.jsGet("providers"))
                    if ("provide" in flat.jsKeys) parseProvider(flat, null)
                }
            }
            walk(providers)
            for (initFn in initializers) {
                try { initFn() } catch (t: Throwable) { jsReportUncaught(jsCaught(t)) }
            }
        }

        fun inject(token: Any?, options: Any? = null, notFoundValue: Any? = null): Any? {
            val unwrapped = resolveForwardRef(token)
            val active = current
            if (active != null && active !== shared) {
                return active.get(unwrapped, notFoundValue, options)
            }
            if ((jsBox(jsGetOptional(options, "skipSelf")) as? Boolean) == true) {
                return notFoundValue
            }
            return resolveRoot(unwrapped, notFoundValue)
        }

        internal fun resolveRoot(unwrapped: Any?, notFoundValue: Any? = null): Any? {
            val key = tokenKey(unwrapped) ?: return notFoundValue
            if (tokenValues.containsKey(key)) return tokenValues[key]
            val multis = multiFactories[key]
            if (!multis.isNullOrEmpty()) {
                val values = multis.map { fn -> try { fn() } catch (t: Throwable) { jsReportUncaught(jsCaught(t)); null } }
                val arr = JSArray(values.toMutableList())
                tokenValues[key] = arr
                return arr
            }
            val factory = tokenFactories[key]
            if (factory != null) {
                val v = try { factory() } catch (t: Throwable) { jsReportUncaught(jsCaught(t)); null }
                tokenValues[key] = v
                return v
            }
            if (key is InjectionToken && key.factory != null) {
                val v = try { key.factory.invoke() } catch (t: Throwable) { jsReportUncaught(jsCaught(t)); null }
                tokenValues[key] = v
                return v
            }
            if (key is Class<*>) {
                when (key) {
                    ErrorHandler::class.java -> return ErrorHandler.shared
                    Injector::class.java -> return current ?: shared
                    NgZone::class.java -> return NgZone.shared
                    DestroyRef::class.java -> return DestroyRef.current()
                    ElementRef::class.java -> return ElementRef.current()
                    ApplicationRef::class.java -> return ApplicationRef.shared
                    PendingTasks::class.java -> return PendingTasks.shared
                    Location::class.java -> return Location.shared
                    ViewContainerRef::class.java -> return ViewContainerRef()
                }
                instantiateClass(key)?.let { return it }
            }
            return notFoundValue
        }
    }
}

class InjectionToken(val desc: String = "", options: Any? = null) {
    val factory: (() -> Any?)? = run {
        val fn = jsBox(jsGetOptional(options, "factory")) ?: return@run null
        { jsCall(fn) }
    }
    override fun toString(): String = "InjectionToken $desc"
}

/** Open: an app's class may extend it (`class AppErrorHandler extends ErrorHandler`), provided as `{ provide: ErrorHandler, useClass }`. */
open class ErrorHandler : JSDynamic {
    open fun handleError(error: Any?) { jsError("ERROR", error) }
    private var added: JSObject? = null
    override fun jsGet(key: String): Any? = added?.get(key)
    override fun jsSet(key: String, value: Any?) { (added ?: JSObject().also { added = it })[key] = value }
    override val jsKeys: List<String> get() = added?.keys ?: emptyList()
    override val jsClassName: String? get() = "ErrorHandler"
    companion object {
        val shared = ErrorHandler()
    }
}

/** Providers are registered once, by the injector they are given to (`bootstrapApplication`'s), as Angular's are. */
fun makeEnvironmentProviders(providers: Any?): Any? = providers

fun provideEnvironmentInitializer(fn: () -> Any?): Any? = fn
fun provideAppInitializer(fn: () -> Any?): Any? = fn

/** An `@NgModule` class's companion: its metadata, evaluated once, and its construction with its constructor's parameters injected. */
interface JSNgModuleDef {
    val jsNgImports: Any?
    val jsNgProviders: Any?
    fun jsNgConstruct(): Any?
}

private fun ngModuleDef(value: Any?): Pair<Class<*>, JSNgModuleDef>? {
    val cls = jsBox(value) as? Class<*> ?: return null
    val def = try { cls.getDeclaredField("Companion").get(null) as? JSNgModuleDef } catch (_: Throwable) { null } ?: return null
    return cls to def
}

private fun ngDeepForEach(value: Any?, body: (Any?) -> Unit) {
    val flat = jsBox(value) ?: return
    if (flat is JSArray<*>) for (el in flat.storage) ngDeepForEach(el, body) else body(flat)
}

/**
 * Angular's `walkProviderTree`: each module once, its imports first (a `ModuleWithProviders`' providers after all of
 * them), then the module itself, the initializer that makes it when the injector is made, and its own providers.
 * Returns whether [container] is a `ModuleWithProviders`.
 */
private fun walkNgModule(container: Any?, out: MutableList<Any?>, dedup: MutableSet<Class<*>>): Boolean {
    val flat = jsBox(resolveForwardRef(container)) ?: return false
    val direct = ngModuleDef(flat)
    val (cls, def) = direct ?: ngModuleDef(jsGetOptional(flat, "ngModule")) ?: return false
    if (dedup.add(cls)) {
        val withProviders = mutableListOf<Any?>()
        ngDeepForEach(def.jsNgImports) { if (walkNgModule(it, out, dedup)) withProviders.add(it) }
        for (m in withProviders) ngDeepForEach(jsGetOptional(m, "providers")) { out.add(it) }
        out.add(JSObject(listOf<Pair<String, Any?>>(Pair("provide", cls), Pair("useFactory", { def.jsNgConstruct() }))))
        out.add({ Injector.inject(cls) })
        ngDeepForEach(def.jsNgProviders) { out.add(it) }
    }
    return direct == null && flat is JSDynamic && "providers" in flat.jsKeys
}

/** What is not a compiled NgModule (the kit's own modules) is given to the injector as it is. */
fun importProvidersFrom(vararg modules: Any?): Any? {
    val out = mutableListOf<Any?>()
    val dedup = HashSet<Class<*>>()
    val withProviders = mutableListOf<Any?>()
    ngDeepForEach(JSArray(modules.toMutableList())) { source ->
        if (walkNgModule(source, out, dedup)) withProviders.add(source)
        else if (ngModuleDef(source) == null && ngModuleDef(jsGetOptional(source, "ngModule")) == null) out.add(source)
    }
    for (m in withProviders) ngDeepForEach(jsGetOptional(m, "providers")) { out.add(it) }
    return JSArray(out)
}

val PLATFORM_ID = InjectionToken("PLATFORM_ID", JSObject("factory" to { "browser" }))
val APP_INITIALIZER = InjectionToken("APP_INITIALIZER")
val ENVIRONMENT_INITIALIZER = InjectionToken("ENVIRONMENT_INITIALIZER")

fun isPlatformBrowser(platformId: Any?): Boolean = jsToString(platformId) == "browser"
fun isPlatformServer(platformId: Any?): Boolean = jsToString(platformId) == "server"

/** `NgZone` without zone.js: both run their function at once. */
class NgZone {
    val onStable = Emitter<Any?>()
    val onMicrotaskEmpty = Emitter<Any?>()
    val onUnstable = Emitter<Any?>()
    val onError = Emitter<Any?>()
    val isStable = true
    fun <T> run(fn: () -> T): T = fn()
    fun <T> runOutsideAngular(fn: () -> T): T = fn()
    fun <T> runGuarded(fn: () -> T): T = fn()
    fun <T> runTask(fn: () -> T): T = fn()

    companion object {
        val shared = NgZone()
        fun isInAngularZone(): Boolean = true
    }
}

class TemplateRef(val elementRef: ElementRef = ElementRef()) {
    var _render: ((Any, Any?) -> Unit)? = null
    var _detached: ((Any?, Any?) -> EmbeddedViewRef)? = null

    fun createEmbeddedView(context: Any? = null, injector: Any? = null): EmbeddedViewRef =
        _detached?.invoke(context, injector) ?: EmbeddedViewRef(context)

    companion object {
        private val stack = mutableListOf<TemplateRef>()
        fun current(): TemplateRef = stack.lastOrNull() ?: TemplateRef()
        fun <T> with(ref: TemplateRef, body: () -> T): T {
            stack.add(ref)
            try { return body() } finally { stack.removeAt(stack.lastIndex) }
        }
    }
}

class EmbeddedViewRef(var context: Any? = null, private var onDestroyFn: (() -> Unit)? = null) {
    var rootNodes: JSArray<Any?> = JSArray()
    var destroyed: Boolean = false
        private set
    fun destroy() {
        if (destroyed) return
        destroyed = true
        onDestroyFn?.invoke()
        onDestroyFn = null
    }
    fun detectChanges() {}
    fun markForCheck() {}
}

class ComponentRef(
    var instance: Any? = null,
    val location: ElementRef = ElementRef(),
    val injector: Injector = Injector.shared,
) {
    val hostView = EmbeddedViewRef(instance)
    fun setInput(name: String, value: Any?) {
        val inst = instance ?: return
        try { jsSet(inst, name, value) } catch (_: Throwable) {}
    }
    fun destroy() { hostView.destroy() }
}

class ViewContainerRef(val injector: Injector = Injector.current ?: Injector.shared) {
    val element = ElementRef()
    private val views = mutableListOf<EmbeddedViewRef>()
    var _mount: ((TemplateRef, Any?) -> EmbeddedViewRef)? = null
    var _clear: (() -> Unit)? = null
    val length: Double get() = views.size.toDouble()
    fun clear() {
        for (v in views) v.destroy()
        views.clear()
        _clear?.invoke()
    }
    fun createEmbeddedView(templateRef: Any?, context: Any? = null, @Suppress("UNUSED_PARAMETER") options: Any? = null): EmbeddedViewRef {
        val tpl = jsBox(templateRef) as? TemplateRef
        val view = when {
            tpl != null && _mount != null -> _mount!!.invoke(tpl, context)
            tpl != null -> tpl.createEmbeddedView(context)
            else -> EmbeddedViewRef(context)
        }
        views.add(view)
        return view
    }
    fun createComponent(componentType: Any?, @Suppress("UNUSED_PARAMETER") options: Any? = null): ComponentRef {
        val flat = jsBox(componentType)
        val inst = when (flat) {
            is Class<*> -> try {
                val ctor = flat.declaredConstructors.firstOrNull { it.parameterCount == 0 }
                ctor?.isAccessible = true
                ctor?.newInstance()
            } catch (_: Throwable) { null }
            null -> null
            else -> try { jsCall(flat) } catch (_: Throwable) { null }
        }
        val ref = ComponentRef(inst)
        views.add(ref.hostView)
        return ref
    }
    fun remove(index: Double? = null) {
        if (views.isEmpty()) return
        val idx = index?.toInt() ?: (views.size - 1)
        if (idx in views.indices) {
            views[idx].destroy()
            views.removeAt(idx)
        }
    }

    companion object {
        private val stack = mutableListOf<ViewContainerRef>()
        fun current(): ViewContainerRef = stack.lastOrNull() ?: ViewContainerRef()
        fun <T> with(ref: ViewContainerRef, body: () -> T): T {
            stack.add(ref)
            try { return body() } finally { stack.removeAt(stack.lastIndex) }
        }
    }
}

class ApplicationRef {
    val isStable = Emitter<Boolean>()
    fun tick() {}
    fun attachView(@Suppress("UNUSED_PARAMETER") view: Any?) {}
    fun detachView(@Suppress("UNUSED_PARAMETER") view: Any?) {}
    fun destroy() {}
    companion object {
        val shared = ApplicationRef()
    }
}

open class Renderer2 {
    val data: JSObject = JSObject()
    open fun destroy() {}
    open fun createElement(name: String, @Suppress("UNUSED_PARAMETER") namespace: String? = null): Any? = JSObject("tagName" to name)
    open fun createComment(value: String): Any? = JSObject("comment" to value)
    open fun createText(value: String): Any? = JSObject("text" to value)
    open fun appendChild(@Suppress("UNUSED_PARAMETER") parent: Any?, @Suppress("UNUSED_PARAMETER") newChild: Any?) {}
    open fun insertBefore(@Suppress("UNUSED_PARAMETER") parent: Any?, @Suppress("UNUSED_PARAMETER") newChild: Any?, @Suppress("UNUSED_PARAMETER") refChild: Any?, @Suppress("UNUSED_PARAMETER") isMove: Boolean? = null) {}
    open fun removeChild(@Suppress("UNUSED_PARAMETER") parent: Any?, @Suppress("UNUSED_PARAMETER") oldChild: Any?, @Suppress("UNUSED_PARAMETER") isHostElement: Boolean? = null) {}
    open fun selectRootElement(selectorOrNode: Any?, @Suppress("UNUSED_PARAMETER") preserveContent: Boolean? = null): Any? = selectorOrNode
    open fun parentNode(node: Any?): Any? = jsGetOptional(node, "parent")
    open fun nextSibling(@Suppress("UNUSED_PARAMETER") node: Any?): Any? = null
    open fun setAttribute(el: Any?, name: String, value: String, @Suppress("UNUSED_PARAMETER") namespace: String? = null) { jsSet(el, name, value) }
    open fun removeAttribute(el: Any?, name: String, @Suppress("UNUSED_PARAMETER") namespace: String? = null) { jsSet(el, name, null) }
    open fun addClass(@Suppress("UNUSED_PARAMETER") el: Any?, @Suppress("UNUSED_PARAMETER") name: String) {}
    open fun removeClass(@Suppress("UNUSED_PARAMETER") el: Any?, @Suppress("UNUSED_PARAMETER") name: String) {}
    open fun setStyle(@Suppress("UNUSED_PARAMETER") el: Any?, @Suppress("UNUSED_PARAMETER") style: String, @Suppress("UNUSED_PARAMETER") value: Any?, @Suppress("UNUSED_PARAMETER") flags: Any? = null) {}
    open fun removeStyle(@Suppress("UNUSED_PARAMETER") el: Any?, @Suppress("UNUSED_PARAMETER") style: String, @Suppress("UNUSED_PARAMETER") flags: Any? = null) {}
    open fun setProperty(el: Any?, name: String, value: Any?) { jsSet(el, name, value) }
    open fun setValue(node: Any?, value: String) { jsSet(node, "text", value) }
    open fun listen(@Suppress("UNUSED_PARAMETER") target: Any?, @Suppress("UNUSED_PARAMETER") eventName: String, @Suppress("UNUSED_PARAMETER") callback: (Any?) -> Any?): () -> Unit = {}
    companion object {
        val shared = Renderer2()
        val current: Renderer2 get() = Injector.inject(Renderer2::class.java, JSObject("optional" to true)) as? Renderer2 ?: shared
    }
}

open class RendererFactory2 {
    open fun createRenderer(@Suppress("UNUSED_PARAMETER") hostElement: Any?, @Suppress("UNUSED_PARAMETER") type: Any? = null): Renderer2 = Renderer2.current
    companion object {
        val shared = RendererFactory2()
        val current: RendererFactory2 get() = Injector.inject(RendererFactory2::class.java, JSObject("optional" to true)) as? RendererFactory2 ?: shared
    }
}

class Location {
    private var currentPath = "/"
    fun path(@Suppress("UNUSED_PARAMETER") includeHash: Boolean = false): String = currentPath
    fun go(path: String, query: String = "", @Suppress("UNUSED_PARAMETER") state: Any? = null) {
        currentPath = if (query.isEmpty()) path else "$path?$query"
    }
    fun replaceState(path: String, query: String = "", state: Any? = null) = go(path, query, state)
    fun back() {}
    fun forward() {}
    companion object {
        val shared = Location()
        fun joinWithSlash(start: String, end: String): String {
            if (start.isEmpty()) return end
            if (end.isEmpty()) return start
            val s = if (start.endsWith("/")) start.dropLast(1) else start
            val e = if (end.startsWith("/")) end.drop(1) else end
            return "$s/$e"
        }
        fun stripTrailingSlash(url: String): String =
            if (url.length > 1 && url.endsWith("/")) url.dropLast(1) else url
    }
}

fun bootstrapApplication(@Suppress("UNUSED_PARAMETER") rootComponent: Any?, options: Any? = null): JSPromise<Any?> {
    val providers = jsGetOptional(options, "providers")
    if (!jsIsNullish(providers)) Injector.register(providers)
    return JSPromise.resolve<Any?>(ApplicationRef.shared)
}

fun runNativeScriptAngularApp(options: Any? = null) {
    val fn = jsBox(jsGetOptional(options, "appModuleBootstrap")) ?: return
    jsReport { jsCall(fn) }
}

