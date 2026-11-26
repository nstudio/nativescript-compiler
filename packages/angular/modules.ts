// Angular's packages as a compiled app's program reads them: the declarations of what the translators recognise and the
// kit implements, and the ports of @angular/forms and the Rx-based APIs this adapter ships as TypeScript.
import { dirname, join } from 'node:path';
import type { ModuleRules } from '@nstudio/nativescript-compiler/adapter-api';
import { core } from './core-api.ts';
import { RUNTIME } from './package.ts';

/** The Angular APIs over the kit's Observable and router, compiled with an app that compiles packages from their source. */
const RX_FILE = join(RUNTIME, 'angular-rx.ts');
/** @angular/forms, ported: compiled as a package's source is, its classes' type parameters erased. */
const FORMS_FILE = join(RUNTIME, 'angular-forms.ts');

const SHIMS: Record<string, string> = {
  /** The kit's Angular API: its Rx, router, HTTP and DI types, which the Angular shims and the runtime ports build on. */
  '@angular#kit': `
    import type { Observable } from 'rxjs';
    /** Angular's async pipe at one binding site. */
    export declare class AsyncPipe { transform<T>(observable: Observable<T> | null | undefined): T | null }
    export declare class TeardownHandle { readonly closed: boolean; unsubscribe(): void }
    export declare class RxObservable<T> {
      subscribe(next: (value: T) => void, error?: (err: any) => void, complete?: () => void): TeardownHandle;
      mapValues<R>(transform: (value: T) => R): RxObservable<R>;
    }
    export declare class RxSubject<T> extends RxObservable<T> { next(value: T): void; asObservable(): RxObservable<T> }
    export declare class RxBehaviorSubject<T> extends RxSubject<T> { readonly value: T; getValue(): T }
    export declare class NavigationStart { readonly id: number; readonly url: string; readonly navigationTrigger?: string; readonly restoredState?: any; constructor(id: number, url: string) }
    export declare class NavigationEnd { readonly id: number; readonly url: string; readonly urlAfterRedirects: string; constructor(id: number, url: string, urlAfterRedirects?: string) }
    export declare class NavigationCancel { readonly id: number; readonly url: string; readonly reason: string; constructor(id: number, url: string, reason?: string) }
    export declare class NavigationError { readonly id: number; readonly url: string; readonly error: any; constructor(id: number, url: string, error?: any) }
    export declare class RoutesRecognized { readonly id: number; readonly url: string; readonly urlAfterRedirects: string; readonly state: any; constructor(id: number, url: string, urlAfterRedirects?: string, state?: any) }
    export declare class ResolveStart { readonly id: number; readonly url: string; readonly urlAfterRedirects: string; readonly state: any; constructor(id: number, url: string, urlAfterRedirects?: string, state?: any) }
    export declare class ResolveEnd { readonly id: number; readonly url: string; readonly urlAfterRedirects: string; readonly state: any; constructor(id: number, url: string, urlAfterRedirects?: string, state?: any) }
    export declare class ParamMap { constructor(params?: any); has(name: string): boolean; get(name: string): string | null; getAll(name: string): string[]; readonly keys: string[] }
    export declare function convertToParamMap(params: Record<string, any>): ParamMap;
    export declare class UrlSegment { readonly path: string; readonly parameters: Record<string, string>; readonly parameterMap: ParamMap; constructor(path: string, parameters?: Record<string, string>); toString(): string }
    export declare class UrlTree { queryParams: Record<string, any>; fragment: string | null; readonly queryParamMap: ParamMap; constructor(path?: string, queryParams?: Record<string, any>, fragment?: string | null); toString(): string }
    export declare class DefaultUrlSerializer { parse(url: string): UrlTree; serialize(tree: UrlTree): string }
    export declare class ActivatedRouteSnapshot {
      readonly params: Record<string, string>;
      readonly queryParams: Record<string, string>;
      readonly data: Record<string, any>;
      readonly url: UrlSegment[];
      readonly fragment: string | null;
      readonly outlet: string;
      readonly routeConfig: any;
      title?: string;
      readonly paramMap: ParamMap;
      readonly queryParamMap: ParamMap;
      readonly root: ActivatedRouteSnapshot;
      readonly parent: ActivatedRouteSnapshot | null;
      readonly firstChild: ActivatedRouteSnapshot | null;
      readonly children: ActivatedRouteSnapshot[];
      readonly pathFromRoot: ActivatedRouteSnapshot[];
    }
    export declare function createRouterStateSnapshot(url?: string): any;
    export declare class RouterStateSnapshot { readonly url: string; readonly root: ActivatedRouteSnapshot; toString(): string }
    export declare class HttpHeaders {
      constructor(headers?: string | Record<string, string | number | (string | number)[]>);
      has(name: string): boolean;
      get(name: string): string | null;
      keys(): string[];
      getAll(name: string): string[] | null;
      append(name: string, value: string | string[]): HttpHeaders;
      set(name: string, value: string | string[]): HttpHeaders;
      delete(name: string, value?: string | string[]): HttpHeaders;
    }
    export declare class HttpParams {
      constructor(options?: { fromString?: string; fromObject?: Record<string, any> } | Record<string, any>);
      has(param: string): boolean;
      get(param: string): string | null;
      getAll(param: string): string[] | null;
      keys(): string[];
      append(param: string, value: string | number | boolean): HttpParams;
      appendAll(params: Record<string, any>): HttpParams;
      set(param: string, value: string | number | boolean): HttpParams;
      delete(param: string, value?: string | number | boolean): HttpParams;
      toString(): string;
    }
    export declare class HttpContextToken<T = any> { readonly defaultValue: () => any; constructor(defaultValue: () => T) }
    export declare class HttpContext {
      set<T>(token: HttpContextToken<T>, value: T): HttpContext;
      get(token: HttpContextToken<any>): any;
      delete(token: HttpContextToken<any>): HttpContext;
      has(token: HttpContextToken<any>): boolean;
    }
    export declare class HttpResponse<T = any> {
      readonly body: any;
      readonly headers: HttpHeaders;
      readonly status: number;
      readonly statusText: string;
      readonly url: string | null;
      readonly ok: boolean;
      readonly type: number;
      constructor(init?: { body?: T | null; headers?: HttpHeaders; status?: number; statusText?: string; url?: string });
      clone(update?: any): HttpResponse<any>;
    }
    export declare class HttpErrorResponse extends Error {
      readonly error: any;
      readonly headers: HttpHeaders;
      readonly status: number;
      readonly statusText: string;
      readonly url: string | null;
      readonly ok: boolean;
      constructor(init?: { error?: any; headers?: HttpHeaders; status?: number; statusText?: string; url?: string });
    }
    export declare class HttpRequest<T = any> {
      readonly method: string;
      readonly url: string;
      readonly body: any;
      readonly headers: HttpHeaders;
      readonly params: HttpParams;
      readonly context: HttpContext;
      readonly responseType: 'arraybuffer' | 'blob' | 'json' | 'text';
      readonly withCredentials: boolean;
      readonly reportProgress: boolean;
      readonly urlWithParams: string;
      constructor(method: string, url: string, third?: any, fourth?: any);
      clone(update?: any): HttpRequest<any>;
    }
    export declare const HTTP_INTERCEPTORS: import('@angular/core').InjectionToken<any[]>;
    export declare enum HttpStatusCode {
      Continue = 100,
      SwitchingProtocols = 101,
      Processing = 102,
      EarlyHints = 103,
      Ok = 200,
      Created = 201,
      Accepted = 202,
      NonAuthoritativeInformation = 203,
      NoContent = 204,
      ResetContent = 205,
      PartialContent = 206,
      MultiStatus = 207,
      AlreadyReported = 208,
      ImUsed = 226,
      MultipleChoices = 300,
      MovedPermanently = 301,
      Found = 302,
      SeeOther = 303,
      NotModified = 304,
      UseProxy = 305,
      Unused = 306,
      TemporaryRedirect = 307,
      PermanentRedirect = 308,
      BadRequest = 400,
      Unauthorized = 401,
      PaymentRequired = 402,
      Forbidden = 403,
      NotFound = 404,
      MethodNotAllowed = 405,
      NotAcceptable = 406,
      ProxyAuthenticationRequired = 407,
      RequestTimeout = 408,
      Conflict = 409,
      Gone = 410,
      LengthRequired = 411,
      PreconditionFailed = 412,
      PayloadTooLarge = 413,
      UriTooLong = 414,
      UnsupportedMediaType = 415,
      RangeNotSatisfiable = 416,
      ExpectationFailed = 417,
      ImATeapot = 418,
      MisdirectedRequest = 421,
      UnprocessableEntity = 422,
      Locked = 423,
      FailedDependency = 424,
      TooEarly = 425,
      UpgradeRequired = 426,
      PreconditionRequired = 428,
      TooManyRequests = 429,
      RequestHeaderFieldsTooLarge = 431,
      UnavailableForLegalReasons = 451,
      InternalServerError = 500,
      NotImplemented = 501,
      BadGateway = 502,
      ServiceUnavailable = 503,
      GatewayTimeout = 504,
      HttpVersionNotSupported = 505,
      VariantAlsoNegotiates = 506,
      InsufficientStorage = 507,
      LoopDetected = 508,
      NotExtended = 510,
      NetworkAuthenticationRequired = 511,
    }
    export declare function withInterceptors(fns: any[]): any;
    export declare function withInterceptorsFromDi(): any;
    export declare function withFetch(): any;
    export declare function provideHttpClient(...features: any[]): any;
    export declare function provideNativeScriptHttpClient(...features: any[]): any;
    export declare function provideNativeScriptNgZone(options?: any): any;
    export declare function provideRouter(routes?: any, ...features: any[]): any;
    export declare function provideNativeScriptRouter(routes?: any, ...features: any[]): any;
    export declare class HttpClientModule { static forRoot(): any }
    export declare function bootstrapApplication(component: any, options?: any): Promise<any>;
    export declare function runNativeScriptAngularApp(options: any): void;
    export declare class KitHttpClient {
      static readonly shared: KitHttpClient;
      request(first: any, url?: string, options?: any): RxObservable<any>;
      get(url: string, options?: any): RxObservable<any>;
      delete(url: string, options?: any): RxObservable<any>;
      head(url: string, options?: any): RxObservable<any>;
      options(url: string, options?: any): RxObservable<any>;
      post(url: string, body?: any, options?: any): RxObservable<any>;
      put(url: string, body?: any, options?: any): RxObservable<any>;
      patch(url: string, body?: any, options?: any): RxObservable<any>;
      jsonp(url: string, callbackParam: string): RxObservable<any>;
    }
    export declare class KitActivatedRoute {
      static current: KitActivatedRoute;
      readonly snapshot: ActivatedRouteSnapshot;
      readonly params: RxBehaviorSubject<Record<string, string>>;
      readonly queryParams: RxBehaviorSubject<Record<string, string>>;
      readonly data: RxBehaviorSubject<Record<string, any>>;
      readonly paramMap: RxBehaviorSubject<ParamMap>;
      readonly queryParamMap: RxBehaviorSubject<ParamMap>;
      readonly fragment: RxBehaviorSubject<string | null>;
      readonly title: RxBehaviorSubject<string | undefined>;
      readonly outlet: string;
      readonly routeConfig: any;
    }
    export declare class KitRouter {
      static readonly shared: KitRouter;
      readonly url: string;
      readonly routerState: any;
      readonly events: RxSubject<NavigationEnd>;
      createUrlTree(commands: any[], extras?: any): UrlTree;
      serializeUrl(url: any): string;
      parseUrl(url: string): UrlTree;
      isActive(url: any, exact?: any): boolean;
      navigate(commands: any[], extras?: any): Promise<boolean>;
      navigateByUrl(url: any, extras?: any): Promise<boolean>;
      back(options?: any): void;
      backToPreviousPage(): void;
      canGoBack(options?: any): boolean;
      canGoBackToPreviousPage(): boolean;
      /** A route guard of the route registered under \`route\`, called with Angular's arguments for its kind. */
      addGuard(route: number, kind: string, guard: (a: any, b: any, c: any, d: any) => any): void;
    }
    export declare class KitNativeDialogRef { static readonly current: KitNativeDialogRef; readonly data: any; close(result?: any): void; afterClosed(): RxObservable<any> }
    export declare class KitNativeDialogService { static readonly shared: KitNativeDialogService; open(component: any, config?: any): KitNativeDialogRef }
    /** A component's own injector, from its @Component providers: classes, and { provide, useClass | useValue | useFactory | useExisting }. */
    export declare class NodeInjector { static enter(providers: any[]): NodeInjector; leave(): void }
    /** A template's \`@let\`, read once on each check of its view; \`of\` only types a template method's parameter. */
    export declare class LetSlot<T> { static of<T>(value: T): LetSlot<T>; readonly value: T }
    /** A pure Angular pipe at one binding site: \`transform\` runs when an argument is no longer \`Object.is\` the last one. */
    export declare class PurePipeCache {
      pure1<A, R>(a: A, transform: (a: A) => R): R;
      pure2<A, B, R>(a: A, b: B, transform: (a: A, b: B) => R): R;
      pure3<A, B, C, R>(a: A, b: B, c: C, transform: (a: A, b: B, c: C) => R): R;
      pure4<A, B, C, D, R>(a: A, b: B, c: C, d: D, transform: (a: A, b: B, c: C, d: D) => R): R;
      pure5<A, B, C, D, E, R>(a: A, b: B, c: C, d: D, e: E, transform: (a: A, b: B, c: C, d: D, e: E) => R): R;
    }
  `,
  '@angular/common': `
    export declare class Location {
      path(includeHash?: boolean): string;
      go(path: string, query?: string, state?: any): void;
      replaceState(path: string, query?: string, state?: any): void;
      back(): void;
      forward(): void;
      static joinWithSlash(start: string, end: string): string;
      static stripTrailingSlash(url: string): string;
    }
    export declare function isPlatformBrowser(platformId: Object): boolean;
    export declare function isPlatformServer(platformId: Object): boolean;
    export declare const DOCUMENT: import('@angular/core').InjectionToken<any>;
    export declare const CommonModule: any;
    export declare const NgIf: any;
    export declare const NgFor: any;
    export declare const NgForOf: any;
    export declare const NgClass: any;
    export declare const NgStyle: any;
    export declare const NgSwitch: any;
    export declare const NgSwitchCase: any;
    export declare const NgSwitchDefault: any;
    export declare const NgTemplateOutlet: any;
    export declare const AsyncPipe: any;
    export declare const DatePipe: any;
    export declare const DecimalPipe: any;
    export declare const PercentPipe: any;
    export declare const CurrencyPipe: any;
    export declare const UpperCasePipe: any;
    export declare const LowerCasePipe: any;
    export declare const TitleCasePipe: any;
    export declare const SlicePipe: any;
    export declare const JsonPipe: any;
    export declare const KeyValuePipe: any;
  `,
  '@angular/common/http': `
    import type { Observable } from 'rxjs';
    import {
      HttpHeaders,
      HttpParams,
      HttpContextToken,
      HttpContext,
      HttpResponse,
      HttpErrorResponse,
      HttpRequest,
      HTTP_INTERCEPTORS,
      HttpStatusCode,
      withInterceptors,
      withInterceptorsFromDi,
      withFetch,
      provideHttpClient,
      HttpClientModule,
    } from '@angular#kit';
    export {
      HttpHeaders,
      HttpParams,
      HttpContextToken,
      HttpContext,
      HttpResponse,
      HttpErrorResponse,
      HttpRequest,
      HTTP_INTERCEPTORS,
      HttpStatusCode,
      withInterceptors,
      withInterceptorsFromDi,
      withFetch,
      provideHttpClient,
      HttpClientModule,
    };
    export interface HttpHandler { handle(req: HttpRequest<any>): Observable<any> }
    export interface HttpInterceptor { intercept(req: HttpRequest<any>, next: HttpHandler): Observable<any> }
    export type HttpInterceptorFn = (req: HttpRequest<any>, next: (req: HttpRequest<any>) => Observable<any>) => Observable<any>;
    export type HttpEvent<T = any> = HttpResponse<T>;
    export declare class HttpClient {
      request<T = any>(first: string | HttpRequest<any>, url?: string, options?: any): Observable<T>;
      get<T = any>(url: string, options?: { headers?: Record<string, string> | HttpHeaders; params?: Record<string, any> | HttpParams; responseType?: 'json'; observe?: any; context?: HttpContext }): Observable<T>;
      get(url: string, options: { headers?: Record<string, string> | HttpHeaders; params?: Record<string, any> | HttpParams; responseType: 'text'; observe?: any; context?: HttpContext }): Observable<string>;
      delete<T = any>(url: string, options?: any): Observable<T>;
      head<T = any>(url: string, options?: any): Observable<T>;
      options<T = any>(url: string, options?: any): Observable<T>;
      post<T = any>(url: string, body: any, options?: any): Observable<T>;
      put<T = any>(url: string, body: any, options?: any): Observable<T>;
      patch<T = any>(url: string, body: any, options?: any): Observable<T>;
      jsonp<T = any>(url: string, callbackParam: string): Observable<T>;
    }
  `,
  '@angular/core': `
    import { TeardownHandle } from '@angular#kit';
    export type ValueEqualityFn<T> = (a: T, b: T) => boolean;
    export interface CreateComputedOptions<T> { equal?: ValueEqualityFn<T> }
    export interface CreateSignalOptions<T> { equal?: ValueEqualityFn<T> }
    export interface WritableSignal<T> { (): T; set(value: T): void; update(fn: (value: T) => T): void; asReadonly(): Signal<T> }
    export interface Signal<T> { (): T }
    /** \`$assign\`: a decorated input the component writes itself (\`this.x = v\`), until its parent's binding changes. */
    export interface InputSignal<T> { (): T; $assign(value: T): void }
    export interface ModelSignal<T> extends WritableSignal<T> { $assign(value: T): void; subscribe(fn: (value: T) => void): TeardownHandle }
    export interface OutputEmitterRef<T> { emit(value: T): void; subscribe(fn: (value: T) => void): TeardownHandle }
    export interface OutputRef<T> { subscribe(fn: (value: T) => void): TeardownHandle }
    export declare function signal<T>(value: T, options?: CreateSignalOptions<T>): WritableSignal<T>;
    export declare function computed<T>(fn: () => T, options?: CreateComputedOptions<T>): Signal<T>;
    export declare function linkedSignal<T>(fn: () => T, options?: CreateComputedOptions<T>): WritableSignal<T>;
    export declare function linkedSignal<S, D>(options: { source: () => S; computation: (source: S, previous?: { source: S; value: D }) => D; equal?: ValueEqualityFn<D>; debugName?: string }): WritableSignal<D>;
    export declare function isSignal(value: unknown): value is Signal<unknown>;
    export declare function isDevMode(): boolean;
    export declare function enableProdMode(): void;
    export type Provider = any;
    export type EnvironmentProviders = any;
    export type ModuleWithProviders<T = any> = any;
    export type Type<T = any> = any;
    export declare function makeEnvironmentProviders(providers: any[]): EnvironmentProviders;
    export declare function provideEnvironmentInitializer(fn: () => void): EnvironmentProviders;
    export declare function provideAppInitializer(fn: () => any): EnvironmentProviders;
    export declare function importProvidersFrom(...modules: any[]): EnvironmentProviders;
    export declare class ErrorHandler { handleError(error: any): void }
    export declare function input<T>(value: T, options?: any): InputSignal<T>;
    export declare function input<T>(): InputSignal<T | undefined>;
    export declare namespace input { function required<T>(options?: any): InputSignal<T>; }
    export declare function booleanAttribute(value: unknown): boolean;
    export declare function numberAttribute(value: unknown, fallbackValue?: number): number;
    export declare function model<T>(value: T, options?: any): ModelSignal<T>;
    export declare function model<T>(): ModelSignal<T | undefined>;
    export declare namespace model { function required<T>(options?: any): ModelSignal<T>; }
    export declare function output<T = void>(options?: any): OutputEmitterRef<T>;
    export declare class InjectionToken<T = any> { readonly _desc: string; readonly _type?: T; constructor(description: string, options?: { providedIn?: 'root' | 'platform' | 'any' | null; factory: () => T }) }
    export declare function inject<T>(token: InjectionToken<T>): T;
    export declare function inject<T>(token: { prototype: T }): T;
    export declare function inject<T>(token: InjectionToken<T>, options: { optional: true; self?: boolean; skipSelf?: boolean; host?: boolean }): T | null;
    export declare function inject<T>(token: { prototype: T }, options: { optional: true; self?: boolean; skipSelf?: boolean; host?: boolean }): T | null;
    export declare function inject<T>(token: InjectionToken<T>, options?: any): T;
    export declare function inject<T>(token: { prototype: T }, options?: any): T;
    export declare function inject<T = any>(token: any, options?: any): T;
    export declare function runInInjectionContext<ReturnT>(injector: Injector, fn: () => ReturnT): ReturnT;
    export declare function forwardRef(forwardRefFn: () => any): any;
    export declare function resolveForwardRef<T>(type: T): T;
    export declare function Component(meta: any): <C>(c: C) => C;
    export declare function Injectable(meta?: any): <C>(c: C) => C;
    export declare const NO_ERRORS_SCHEMA: any;
    export declare const CUSTOM_ELEMENTS_SCHEMA: any;
    export declare function NgModule(meta: any): <C>(c: C) => C;
    export declare function Input(options?: any): any;
    export declare function Output(options?: any): any;
    export declare class EventEmitter<T = any> {
      constructor(isAsync?: boolean);
      emit(value?: T): void;
      next(value?: T): void;
      subscribe(next?: ((value: T) => void) | null, error?: ((error: any) => void) | null, complete?: (() => void) | null): TeardownHandle;
      subscribe(observer?: { next?: (value: T) => void; error?: (e: any) => void; complete?: () => void } | null): TeardownHandle;
    }
    export declare enum ChangeDetectionStrategy { OnPush = 0, Eager = 1, Default = 1 }
    export declare enum ViewEncapsulation { Emulated = 0, None = 2, ShadowDom = 3, ExperimentalIsolatedShadowDom = 4 }
    export declare function provideZoneChangeDetection(options?: any): any;
    export declare function provideZonelessChangeDetection(): any;
    export interface EffectRef { destroy(): void }
    export declare function effect(fn: (onCleanup: (cleanup: () => void) => void) => void, options?: any): EffectRef;
    export declare function untracked<T>(fn: () => T): T;
    export declare class Injector {
      static create(options: { providers: any[]; parent?: Injector; name?: string } | any[], parent?: Injector): Injector;
      get<T>(token: InjectionToken<T>, notFoundValue?: T, options?: any): T;
      get<T>(token: { prototype: T }, notFoundValue?: T, options?: any): T;
      get<T = any>(token: any, notFoundValue?: T, options?: any): T;
    }
    export declare class EnvironmentInjector extends Injector {}
    export declare function ViewChild(selector: any, options?: any): any;
    export declare function ViewChildren(selector: any, options?: any): any;
    export declare function ContentChild(selector: any, options?: any): any;
    export declare function ContentChildren(selector: any, options?: any): any;
    export declare function viewChild<T = any>(locator: any, options?: any): Signal<T | undefined>;
    export declare namespace viewChild { function required<T = any>(locator: any, options?: any): Signal<T>; }
    export declare function viewChildren<T = any>(locator: any, options?: any): Signal<readonly T[]>;
    export declare function contentChild<T = any>(locator: any, options?: any): Signal<T | undefined>;
    export declare namespace contentChild { function required<T = any>(locator: any, options?: any): Signal<T>; }
    export declare function contentChildren<T = any>(locator: any, options?: any): Signal<readonly T[]>;
    export declare function Pipe(meta: { name: string; pure?: boolean; standalone?: boolean }): <C>(c: C) => C;
    export interface PipeTransform { transform(value: any, ...args: any[]): any }
    export declare function Directive(meta?: any): <C>(c: C) => C;
    export declare function HostListener(event: string, args?: string[]): any;
    export declare function HostBinding(property?: string): any;
    export declare const Inject: { (token: any): any; new (token: any): any };
    export declare const Optional: { (): any; new (): any };
    export declare const Self: { (): any; new (): any };
    export declare const SkipSelf: { (): any; new (): any };
    export declare const Host: { (): any; new (): any };
    export declare const PLATFORM_ID: InjectionToken<Object>;
    export declare const APP_INITIALIZER: InjectionToken<readonly (() => any)[]>;
    export declare const ENVIRONMENT_INITIALIZER: InjectionToken<readonly (() => void)[]>;
    export declare abstract class ChangeDetectorRef { markForCheck(): void; detectChanges(): void; detach(): void; reattach(): void; checkNoChanges(): void }
    /** A template's view: what a native element is to Angular, read untyped (its type argument is the app's claim). */
    export declare class ElementRef<T = any> { constructor(nativeElement?: any); readonly nativeElement: any }
    export declare class TemplateRef<C = any> { readonly elementRef: ElementRef; constructor(elementRef?: ElementRef) }
    export declare class EmbeddedViewRef<C = any> { context: C; readonly rootNodes: any[]; readonly destroyed: boolean; destroy(): void; detectChanges(): void; markForCheck(): void }
    export declare class ComponentRef<C = any> { readonly instance: C; readonly location: ElementRef; readonly injector: Injector; readonly hostView: EmbeddedViewRef<C>; setInput(name: string, value: unknown): void; destroy(): void }
    export declare class ViewContainerRef {
      readonly element: ElementRef;
      readonly injector: Injector;
      readonly length: number;
      clear(): void;
      createEmbeddedView<C = any>(templateRef: TemplateRef<C>, context?: C, options?: any): EmbeddedViewRef<C>;
      createComponent<C = any>(componentType: Type<C>, options?: any): ComponentRef<C>;
      remove(index?: number): void;
    }
    export declare class ApplicationRef { readonly isStable: any; tick(): void; destroy(): void }
    export declare class SimpleChange { constructor(previousValue: any, currentValue: any, firstChange: boolean); previousValue: any; currentValue: any; firstChange: boolean; isFirstChange(): boolean }
    export type SimpleChanges<T = any> = { [propName: string]: SimpleChange };
    export interface OnChanges { ngOnChanges(changes: SimpleChanges): void }
    export declare class QueryList<T> {
      readonly length: number;
      readonly first: T;
      readonly last: T;
      readonly dirty: boolean;
      toArray(): T[];
      get(index: number): T | undefined;
      forEach(fn: (item: T, index: number, array: T[]) => void): void;
      map<U>(fn: (item: T, index: number, array: T[]) => U): U[];
      filter(fn: (item: T, index: number, array: T[]) => boolean): T[];
      find(fn: (item: T, index: number, array: T[]) => boolean): T | undefined;
      some(fn: (item: T, index: number, array: T[]) => boolean): boolean;
      notifyOnChanges(): void;
      readonly changes: { subscribe(observerOrNext?: ((value: QueryList<T>) => void) | { next?: (value: QueryList<T>) => void; error?: (e: any) => void; complete?: () => void } | null): { unsubscribe(): void } };
    }
    export declare class DestroyRef { onDestroy(callback: () => void): () => void }
    export declare class NgZone {
      static isInAngularZone(): boolean;
      readonly onStable: EventEmitter<any>;
      readonly onMicrotaskEmpty: EventEmitter<any>;
      readonly onUnstable: EventEmitter<any>;
      readonly onError: EventEmitter<any>;
      readonly isStable: boolean;
      run<T>(fn: () => T): T;
      runOutsideAngular<T>(fn: () => T): T;
      runGuarded<T>(fn: () => T): T;
      runTask<T>(fn: () => T): T;
    }
    export interface OnDestroy { ngOnDestroy(): void }
    export interface OnInit { ngOnInit(): void }
    export interface AfterViewInit { ngAfterViewInit(): void }
    export interface AfterContentInit { ngAfterContentInit(): void }
    export interface AfterViewChecked { ngAfterViewChecked(): void }
    export interface AfterContentChecked { ngAfterContentChecked(): void }
    export interface DoCheck { ngDoCheck(): void }
  `,
  '@angular/core/rxjs-interop': `
    import type { Observable, OperatorFunction } from 'rxjs';
    import type { Signal, DestroyRef } from '@angular/core';
    export declare function toSignal<T>(source: Observable<T>, options: { initialValue: T; injector?: any; requireSync?: boolean; manualCleanup?: boolean; equal?: any }): Signal<T>;
    export declare function toSignal<T>(source: Observable<T>, options: { requireSync: true; injector?: any; manualCleanup?: boolean; equal?: any }): Signal<T>;
    export declare function toSignal<T>(source: Observable<T>, options?: { injector?: any; requireSync?: boolean; manualCleanup?: boolean; equal?: any }): Signal<T | undefined>;
    export declare function toObservable<T>(source: Signal<T>, options?: { injector?: any }): Observable<T>;
    export declare function takeUntilDestroyed<T>(destroyRef?: DestroyRef): OperatorFunction<T, T>;
  `,
  '@angular/router': `
    import type { Observable } from 'rxjs';
    import {
      ActivatedRouteSnapshot,
      convertToParamMap,
      createRouterStateSnapshot,
      DefaultUrlSerializer,
      NavigationCancel,
      NavigationEnd,
      NavigationError,
      NavigationStart,
      ParamMap,
      provideRouter,
      ResolveEnd,
      ResolveStart,
      RoutesRecognized,
      RouterStateSnapshot,
      UrlSegment,
      UrlTree,
    } from '@angular#kit';
    export {
      RouterStateSnapshot,
      ActivatedRouteSnapshot,
      convertToParamMap,
      createRouterStateSnapshot,
      DefaultUrlSerializer,
      NavigationCancel,
      NavigationEnd,
      NavigationError,
      NavigationStart,
      ParamMap,
      provideRouter,
      ResolveEnd,
      ResolveStart,
      RoutesRecognized,
      UrlSegment,
      UrlTree,
    };
    export declare class ActivatedRoute {
      snapshot: ActivatedRouteSnapshot;
      params: Observable<Record<string, string>>;
      queryParams: Observable<Record<string, string>>;
      data: Observable<Record<string, any>>;
      paramMap: Observable<ParamMap>;
      queryParamMap: Observable<ParamMap>;
      fragment: Observable<string | null>;
      title: Observable<string | undefined>;
      outlet: string;
      routeConfig: any;
      readonly root: ActivatedRoute;
      readonly parent: ActivatedRoute | null;
      readonly firstChild: ActivatedRoute | null;
      readonly children: ActivatedRoute[];
      readonly pathFromRoot: ActivatedRoute[];
    }
    export type Event = NavigationEnd | NavigationStart | NavigationCancel | NavigationError | RoutesRecognized | ResolveStart | ResolveEnd;
    export type NavigationExtras = any;
    export declare class Router {
      readonly url: string;
      readonly routerState: any;
      readonly events: Observable<Event>;
      createUrlTree(commands: any[], extras?: NavigationExtras): UrlTree;
      serializeUrl(url: UrlTree): string;
      parseUrl(url: string): UrlTree;
      isActive(url: string | UrlTree, exact?: any): boolean;
      navigate(commands: any[], extras?: NavigationExtras): Promise<boolean>;
      navigateByUrl(url: string | UrlTree, extras?: NavigationExtras): Promise<boolean>;
    }
    export interface Route {
      path?: string;
      component?: any;
      redirectTo?: string;
      pathMatch?: string;
      outlet?: string;
      data?: Record<string, any>;
      canActivate?: any[];
      canActivateChild?: any[];
      canDeactivate?: any[];
      canMatch?: any[];
      resolve?: Record<string, any>;
      providers?: any[];
      children?: Route[];
      loadChildren?: () => any;
      loadComponent?: () => any;
      title?: any;
    }
    export type Routes = Route[];
    export type Params = { [key: string]: any };
    export interface IsActiveMatchOptions { matrixParams: 'exact' | 'subset' | 'ignored'; queryParams: 'exact' | 'subset' | 'ignored'; paths: 'exact' | 'subset'; fragment: 'exact' | 'ignored' }
    export type GuardResult = boolean | UrlTree;
    export type MaybeAsync<T> = T | Observable<T> | Promise<T>;
    export type CanActivateFn = (route: ActivatedRouteSnapshot, state: RouterStateSnapshot) => MaybeAsync<GuardResult>;
    export type CanActivateChildFn = (childRoute: ActivatedRouteSnapshot, state: RouterStateSnapshot) => MaybeAsync<GuardResult>;
    export type CanDeactivateFn<T> = (component: T, currentRoute: ActivatedRouteSnapshot, currentState: RouterStateSnapshot, nextState: RouterStateSnapshot) => MaybeAsync<GuardResult>;
    export type CanMatchFn = (route: Route, segments: UrlSegment[]) => MaybeAsync<GuardResult>;
    export interface CanActivate { canActivate(route: ActivatedRouteSnapshot, state: RouterStateSnapshot): MaybeAsync<GuardResult> }
    export interface CanActivateChild { canActivateChild(childRoute: ActivatedRouteSnapshot, state: RouterStateSnapshot): MaybeAsync<GuardResult> }
    export interface CanDeactivate<T> { canDeactivate(component: T, currentRoute: ActivatedRouteSnapshot, currentState: RouterStateSnapshot, nextState: RouterStateSnapshot): MaybeAsync<GuardResult> }
    export interface CanMatch { canMatch(route: Route, segments: UrlSegment[]): MaybeAsync<GuardResult> }
    export declare const RouterModule: { forRoot(routes: Routes, config?: any): any; forChild(routes: Routes): any };
    export declare function provideRouter(routes?: any, ...features: any[]): any;
    export declare const RouterOutlet: any;
    export declare const RouterLink: any;
    export declare const RouterLinkActive: any;
  `,
  // What an app implements of @angular/forms (runtime/angular-forms.ts re-exports them): declarations, no classes.
  '@angular#forms': `
    import type { Observable } from 'rxjs';
    import type { AbstractControl, ValidationErrors } from '@angular/forms';
    export interface Validator {
      validate(control: AbstractControl): ValidationErrors | null;
      registerOnValidatorChange?(fn: () => void): void;
    }
    export interface AsyncValidator extends Validator {
      validate(control: AbstractControl): Promise<ValidationErrors | null> | Observable<ValidationErrors | null>;
    }
    export interface ControlValueAccessor {
      writeValue(obj: any): void;
      registerOnChange(fn: any): void;
      registerOnTouched(fn: any): void;
      setDisabledState?(isDisabled: boolean): void;
    }
  `,
  '@nativescript/angular': `
    import type { Observable } from 'rxjs';
    import type { UrlTree } from '@angular#kit';
    export type NavigationExtras = any;
    export declare class RouterExtensions {
      readonly router: { readonly url: string; readonly events: Observable<any>; readonly routerState: any };
      readonly url: string;
      readonly events: Observable<any>;
      navigate(commands: any[], extras?: NavigationExtras): Promise<boolean>;
      navigateByUrl(url: string | UrlTree, extras?: NavigationExtras): Promise<boolean>;
      back(options?: { relativeTo?: any; outlets?: string[] }): void;
      backToPreviousPage(): void;
      canGoBack(options?: any): boolean;
      canGoBackToPreviousPage(): boolean;
    }
    export declare const NativeDialogModule: any;
    export declare const NATIVE_DIALOG_DATA: import('@angular/core').InjectionToken<any>;
    export declare function registerElement(name: string, resolver: () => any, meta?: any): void;
    export declare function isAngularHmrRestoringRoute(): boolean;
    export declare const ActionBarComponent: any;
    export declare const ActionItemDirective: any;
    export declare const NavigationButtonDirective: any;
    export declare const TabViewDirective: any;
    export declare const TabViewItemDirective: any;
    export declare const NSEmptyOutletComponent: any;
    export declare function provideNativeScriptHttpClient(...features: any[]): any;
    export declare function provideNativeScriptRouter(routes?: any, ...features: any[]): any;
    export declare function provideNativeScriptNgZone(options?: any): any;
    export declare function bootstrapApplication(component: any, options?: any): Promise<any>;
    export type NativeDialogConfig<D = any> = { data?: D; nativeOptions?: any; [key: string]: any };
    export declare class NativeDialogRef<T = any, R = any> { readonly componentInstance: T; close(result?: R): void; afterClosed(): Observable<R | undefined> }
    export declare class NativeDialogService { open<T = any, D = any, R = any>(component: any, config?: NativeDialogConfig<D>): NativeDialogRef<T, R>; closeAll(): void }
    export { NativeDialogService as NativeDialog };
    export declare const NativeScriptCommonModule: any;
    export declare const NativeScriptFormsModule: any;
    export declare const NativeScriptHttpClientModule: any;
    export declare const NativeScriptModule: any;
    export declare const NativeScriptRouterModule: { forRoot(routes: any, config?: any): any; forChild(routes: any): any };
    export declare function platformNativeScript(): { bootstrapModule(module: any, options?: any): Promise<any> };
    export declare function runNativeScriptAngularApp(options: any): void;
    export declare const PageRouterOutlet: any;
    export declare const RouterOutlet: any;
    export declare const NSRouterLink: any;
    export declare const NSRouterLinkActive: any;
  `,
};

/** rxjs, for a build that does not compile packages from their source. */
const RXJS = `
  export declare class Subscription { readonly closed: boolean; unsubscribe(): void }
  export interface OperatorFunction<T, R> { readonly __operator: [T, R] }
  export declare class Observable<T> {
    subscribe(next: (value: T) => void): Subscription;
    pipe<A>(a: OperatorFunction<T, A>): Observable<A>;
    pipe<A, B>(a: OperatorFunction<T, A>, b: OperatorFunction<A, B>): Observable<B>;
    pipe<A, B, C>(a: OperatorFunction<T, A>, b: OperatorFunction<A, B>, c: OperatorFunction<B, C>): Observable<C>;
  }
  export declare class Subject<T> extends Observable<T> { next(value: T): void; asObservable(): Observable<T> }
  export declare class BehaviorSubject<T> extends Subject<T> { constructor(value: T); readonly value: T; getValue(): T }
  export declare class ReplaySubject<T> extends Subject<T> { constructor(bufferSize?: number) }
  export declare function map<T, R>(project: (value: T, index: number) => R): OperatorFunction<T, R>;
  export declare function filter<T, S extends T>(predicate: (value: T, index: number) => value is S): OperatorFunction<T, S>;
  export declare function filter<T>(predicate: (value: T, index: number) => boolean): OperatorFunction<T, T>;
  export declare function take<T>(count: number): OperatorFunction<T, T>;
  export declare function firstValueFrom<T>(source: Observable<T>): Promise<T>;
`;

export const modules: ModuleRules = {
  shims: SHIMS,
  fallbackShims: { rxjs: RXJS },
  substitutions: {
    ...Object.fromEntries(['@angular/common/http', '@angular/core/rxjs-interop', '@angular/router', '@nativescript/angular'].map((m) => [m, { file: RX_FILE, sourcesOnly: true }])),
    '@angular#rx': { file: RX_FILE, sourcesOnly: true, otherwise: '@angular#kit' },
    // Its controls are read untyped as often as typed (`form.get('name').value`).
    '@angular/forms': { file: FORMS_FILE, membersByName: true },
  },
  // `<package>/angular`, whose components `angularLibraries` compiles with the app's.
  isLibraryEntry: (specifier, source, virtual) => specifier === `${core.packageOf(specifier)}/angular` && virtual.some((f) => f.endsWith('.release.ts') && f.startsWith(dirname(source) + '/')),
  // `@Inject(token)`: the class's factory injects that token.
  parameterDecorators: ['Inject'],
};
