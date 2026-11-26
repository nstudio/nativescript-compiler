// @angular/cdk runtime shims for compiled NativeScript Angular apps.
// Provides real compiled TypeScript classes for @angular/cdk/* services, directives and types so apps
// importing Angular CDK / Spartan Brain / Spartan Helm compile natively on Swift and Kotlin without
// browser DOM dependencies.

import { EventEmitter, InjectionToken, signal } from '@angular/core';
import { Observable, Subject } from 'rxjs';

const EMPTY_OBSERVABLE: Observable<any> = new Subject<any>().asObservable();

// ---- @angular/cdk/bidi ----

export type Direction = 'ltr' | 'rtl';

export class Directionality {
  static shared = new Directionality();
  readonly value: Direction = 'ltr';
  readonly valueSignal = signal<Direction>('ltr');
  readonly change = new EventEmitter<Direction>();
}

// ---- @angular/cdk/coercion ----

export type BooleanInput = string | boolean | null | undefined;
export type NumberInput = string | number | null | undefined;

export function coerceBooleanProperty(value: any): boolean {
  return value != null && `${value}` !== 'false';
}

export function coerceNumberProperty(value: any, fallbackValue: any = 0): any {
  if (value === null || value === undefined || value === '') return fallbackValue;
  const n = Number(value);
  return isNaN(n) ? fallbackValue : n;
}

// ---- @angular/cdk/keycodes ----

export const ENTER = 13;
export const SPACE = 32;

export function hasModifierKey(event: any, ...modifiers: string[]): boolean {
  if (!event) return false;
  if (modifiers.length) {
    return modifiers.some((m) => !!event[m]);
  }
  return !!(event.altKey || event.shiftKey || event.ctrlKey || event.metaKey);
}

// ---- @angular/cdk/platform ----

export class Platform {
  static shared = new Platform();
  isBrowser = false;
  EDGE = false;
  TRIDENT = false;
  BLINK = false;
  WEBKIT = false;
  IOS = false;
  FIREFOX = false;
  ANDROID = false;
  SAFARI = false;
}

export function normalizePassiveListenerOptions(options: any): any {
  return options;
}

// ---- @angular/cdk/portal ----

export type ComponentType<T> = new (...args: any[]) => T;

export class ComponentPortal<T = any> {
  component: any;
  viewContainerRef: any;
  injector: any;
  componentFactoryResolver: any;
  projectableNodes: any;
  constructor(component: any, viewContainerRef?: any, injector?: any, componentFactoryResolver?: any, projectableNodes?: any) {
    this.component = component;
    this.viewContainerRef = viewContainerRef;
    this.injector = injector;
    this.componentFactoryResolver = componentFactoryResolver;
    this.projectableNodes = projectableNodes;
  }
}

export class TemplatePortal<C = any> {
  templateRef: any;
  viewContainerRef: any;
  context: any;
  injector: any;
  constructor(templateRef: any, viewContainerRef: any, context?: C, injector?: any) {
    this.templateRef = templateRef;
    this.viewContainerRef = viewContainerRef;
    this.context = context;
    this.injector = injector;
  }
}

// ---- @angular/cdk/scrolling ----

export class ViewportRuler {
  static shared = new ViewportRuler();
  getViewportSize(): { width: number; height: number } {
    return { width: 0, height: 0 };
  }
  getViewportRect(): { top: number; left: number; bottom: number; right: number; height: number; width: number } {
    return { top: 0, left: 0, bottom: 0, right: 0, height: 0, width: 0 };
  }
  getViewportScrollPosition(): { top: number; left: number } {
    return { top: 0, left: 0 };
  }
  change(_throttleTime?: number): Observable<any> {
    return EMPTY_OBSERVABLE;
  }
}

// ---- @angular/cdk/observers & @angular/cdk/observers/private ----

export class CdkObserveContent {
  readonly cdkObserveContent = new EventEmitter<any>();
}

export class SharedResizeObserver {
  static shared = new SharedResizeObserver();
  observe(_target: any, _options?: any): Observable<any[]> {
    return EMPTY_OBSERVABLE;
  }
}

// ---- @angular/cdk/a11y ----

export type FocusOrigin = 'touch' | 'mouse' | 'keyboard' | 'program' | null;

export interface FocusableOption {
  disabled?: boolean;
  focus(origin?: FocusOrigin): void;
  getLabel?(): string;
}

export interface Highlightable {
  disabled?: boolean;
  setActiveStyles(): void;
  setInactiveStyles(): void;
  getLabel?(): string;
}

export class FocusMonitor {
  static shared = new FocusMonitor();
  monitor(_element: any, _checkChildren?: boolean): Observable<FocusOrigin> {
    return EMPTY_OBSERVABLE;
  }
  stopMonitoring(_element: any): void {}
  focusVia(_element: any, _origin: FocusOrigin, _options?: any): void {}
}

export class InteractivityChecker {
  static shared = new InteractivityChecker();
  isDisabled(_element: any): boolean {
    return false;
  }
  isVisible(_element: any): boolean {
    return true;
  }
  isTabbable(_element: any): boolean {
    return false;
  }
  isFocusable(_element: any): boolean {
    return false;
  }
}

export class InputModalityDetector {
  static shared = new InputModalityDetector();
  readonly modalityDetected: Observable<any> = EMPTY_OBSERVABLE;
  readonly modalityChanged: Observable<any> = EMPTY_OBSERVABLE;
  mostRecentModality: any = null;
}

export class FocusKeyManager<T = any> {
  activeItem: any = null;
  activeItemIndex: number | null = null;
  readonly change = new Subject<number>();
  readonly tabOut = new Subject<void>();
  private _items: any;
  constructor(items?: any, _injector?: any) {
    this._items = items;
  }
  withWrap(_shouldWrap?: boolean): this {
    return this;
  }
  withVerticalOrientation(_enabled?: boolean): this {
    return this;
  }
  withHorizontalOrientation(_dir?: any): this {
    return this;
  }
  withTypeAhead(_debounceInterval?: number): this {
    return this;
  }
  withHomeAndEnd(_enabled?: boolean): this {
    return this;
  }
  withPageUpDown(_enabled?: boolean): this {
    return this;
  }
  withAllowedModifierKeys(_keys?: any): this {
    return this;
  }
  skipPredicate(_predicate: (item: T) => boolean): this {
    return this;
  }
  setActiveItem(item: any): void {
    if (typeof item === 'number') {
      this.activeItemIndex = item;
    } else {
      this.activeItem = item;
    }
  }
  updateActiveItem(item: any): void {
    this.setActiveItem(item);
  }
  setFirstItemActive(): void {
    this.activeItemIndex = 0;
  }
  setLastItemActive(): void {}
  setNextItemActive(): void {}
  setPreviousItemActive(): void {}
  setFocusOrigin(_origin: FocusOrigin): this {
    return this;
  }
  onKeydown(_event: any): void {}
  destroy(): void {
    this.change.complete();
    this.tabOut.complete();
  }
}

export class ActiveDescendantKeyManager<T = any> extends FocusKeyManager<T> {}

// ---- @angular/cdk/overlay ----

export interface ConnectedPosition {
  originX: 'start' | 'center' | 'end';
  originY: 'top' | 'center' | 'bottom';
  overlayX: 'start' | 'center' | 'end';
  overlayY: 'top' | 'center' | 'bottom';
  weight?: number;
  offsetX?: number;
  offsetY?: number;
  panelClass?: string | string[];
}

export type FlexibleConnectedPositionStrategyOrigin = any;

export interface PositionStrategy {
  attach(overlayRef: any): void;
  apply(): void;
  detach?(): void;
  dispose(): void;
}

export interface ScrollStrategy {
  attach(overlayRef: any): void;
  enable(): void;
  disable(): void;
  detach?(): void;
}

export interface ConnectedOverlayPositionChange {
  connectionPair: ConnectedPosition;
  scrollableViewProperties: any;
}

export class FlexibleConnectedPositionStrategy implements PositionStrategy {
  _origin: any = null;
  readonly positionChanges = new Subject<ConnectedOverlayPositionChange>();
  constructor(origin?: any) {
    this._origin = origin;
  }
  withPositions(_positions: ConnectedPosition[]): this {
    return this;
  }
  withFlexibleDimensions(_flexibleDimensions?: boolean): this {
    return this;
  }
  withPush(_canPush?: boolean): this {
    return this;
  }
  withGrowAfterOpen(_growAfterOpen?: boolean): this {
    return this;
  }
  withViewportMargin(_margin: number): this {
    return this;
  }
  withLockedPosition(_isLocked?: boolean): this {
    return this;
  }
  withDefaultOffsetX(_offset: number): this {
    return this;
  }
  withDefaultOffsetY(_offset: number): this {
    return this;
  }
  withTransformOriginOn(_selector: string): this {
    return this;
  }
  setOrigin(origin: any): this {
    this._origin = origin;
    return this;
  }
  attach(_overlayRef: any): void {}
  apply(): void {}
  detach(): void {}
  reapplyLastPosition(): void {}
  dispose(): void {
    this.positionChanges.complete();
  }
}

export class GlobalPositionStrategy implements PositionStrategy {
  top(_value?: string): this {
    return this;
  }
  bottom(_value?: string): this {
    return this;
  }
  left(_value?: string): this {
    return this;
  }
  right(_value?: string): this {
    return this;
  }
  centerHorizontally(_offset?: string): this {
    return this;
  }
  centerVertically(_offset?: string): this {
    return this;
  }
  attach(_overlayRef: any): void {}
  apply(): void {}
  detach(): void {}
  dispose(): void {}
}

export class OverlayConfig {
  positionStrategy: any;
  scrollStrategy: any;
  panelClass: any;
  hasBackdrop?: boolean;
  backdropClass: any;
  width: any;
  height: any;
  minWidth: any;
  minHeight: any;
  maxWidth: any;
  maxHeight: any;
  direction: any;
  disposeOnNavigation?: boolean;
  constructor(config?: any) {
    if (config) {
      this.positionStrategy = config.positionStrategy;
      this.scrollStrategy = config.scrollStrategy;
      this.panelClass = config.panelClass;
      this.hasBackdrop = config.hasBackdrop;
      this.backdropClass = config.backdropClass;
      this.width = config.width;
      this.height = config.height;
      this.minWidth = config.minWidth;
      this.minHeight = config.minHeight;
      this.maxWidth = config.maxWidth;
      this.maxHeight = config.maxHeight;
      this.direction = config.direction;
      this.disposeOnNavigation = config.disposeOnNavigation;
    }
  }
}

class NoopScrollStrategy implements ScrollStrategy {
  attach(_overlayRef: any): void {}
  enable(): void {}
  disable(): void {}
  detach(): void {}
}

export class ScrollStrategyOptions {
  static shared = new ScrollStrategyOptions();
  noop(): ScrollStrategy {
    return new NoopScrollStrategy();
  }
  close(_config?: any): ScrollStrategy {
    return new NoopScrollStrategy();
  }
  block(): ScrollStrategy {
    return new NoopScrollStrategy();
  }
  reposition(_config?: any): ScrollStrategy {
    return new NoopScrollStrategy();
  }
}

export class OverlayPositionBuilder {
  static shared = new OverlayPositionBuilder();
  global(): GlobalPositionStrategy {
    return new GlobalPositionStrategy();
  }
  flexibleConnectedTo(origin: any): FlexibleConnectedPositionStrategy {
    return new FlexibleConnectedPositionStrategy(origin);
  }
}

export class OverlayRef {
  hostElement: any = {};
  overlayElement: any = {};
  backdropElement: any = null;
  private _config: OverlayConfig;
  private _attached = false;
  private _direction: Direction = 'ltr';
  private readonly _attachments = new Subject<void>();
  private readonly _detachments = new Subject<void>();
  private readonly _backdropClick = new Subject<any>();
  private readonly _keydownEvents = new Subject<any>();
  private readonly _outsidePointerEvents = new Subject<any>();
  constructor(config?: any) {
    this._config = config instanceof OverlayConfig ? config : new OverlayConfig(config);
  }
  attach(_portal: any): any {
    this._attached = true;
    this._attachments.next();
    return null;
  }
  detach(): any {
    if (this._attached) {
      this._attached = false;
      this._detachments.next();
    }
    return null;
  }
  dispose(): void {
    this.detach();
    this._attachments.complete();
    this._detachments.complete();
    this._backdropClick.complete();
    this._keydownEvents.complete();
    this._outsidePointerEvents.complete();
  }
  hasAttached(): boolean {
    return this._attached;
  }
  backdropClick(): Observable<any> {
    return this._backdropClick.asObservable();
  }
  attachments(): Observable<void> {
    return this._attachments.asObservable();
  }
  detachments(): Observable<void> {
    return this._detachments.asObservable();
  }
  keydownEvents(): Observable<any> {
    return this._keydownEvents.asObservable();
  }
  outsidePointerEvents(): Observable<any> {
    return this._outsidePointerEvents.asObservable();
  }
  updatePosition(): void {}
  updatePositionStrategy(strategy: any): void {
    this._config.positionStrategy = strategy;
  }
  updateSize(_sizeConfig: any): void {}
  setDirection(dir: any): void {
    this._direction = dir === 'rtl' ? 'rtl' : 'ltr';
  }
  getDirection(): Direction {
    return this._direction;
  }
  getConfig(): OverlayConfig {
    return this._config;
  }
  addPanelClass(_classes: any): void {}
  removePanelClass(_classes: any): void {}
}

export class OverlayOutsideClickDispatcher {
  static shared = new OverlayOutsideClickDispatcher();
  _attachedOverlays: OverlayRef[] = [];
  add(overlayRef: OverlayRef): void {
    if (!this._attachedOverlays.includes(overlayRef)) this._attachedOverlays.push(overlayRef);
  }
  remove(overlayRef: OverlayRef): void {
    const i = this._attachedOverlays.indexOf(overlayRef);
    if (i >= 0) this._attachedOverlays.splice(i, 1);
  }
}

export class Overlay {
  static shared = new Overlay();
  readonly scrollStrategies = ScrollStrategyOptions.shared;
  position(): OverlayPositionBuilder {
    return OverlayPositionBuilder.shared;
  }
  create(config?: any): OverlayRef {
    return new OverlayRef(config);
  }
}

export const OVERLAY_DEFAULT_CONFIG = new InjectionToken<any>('OVERLAY_DEFAULT_CONFIG');

// ---- @angular/cdk/dialog ----

export type AutoFocusTarget = 'dialog' | 'first-tabbable' | 'first-heading' | string | boolean;
export type RestoreFocusValue = boolean | string | HTMLElement;

export const DIALOG_DATA = new InjectionToken<any>('DialogData');

export class DialogRef<R = unknown, C = unknown> {
  id = '';
  componentInstance: any = null;
  readonly config: any;
  readonly overlayRef: OverlayRef;
  readonly closed = new Subject<any>();
  readonly backdropClick = new Subject<any>();
  readonly keydownEvents = new Subject<any>();
  readonly outsidePointerEvents = new Subject<any>();
  disableClose?: boolean;
  constructor(overlayRef?: OverlayRef, config?: any) {
    this.overlayRef = overlayRef ?? new OverlayRef();
    this.config = config ?? {};
  }
  close(result?: any, _options?: any): void {
    this.closed.next(result);
    this.closed.complete();
    this.overlayRef.dispose();
  }
  updatePosition(_position?: any): this {
    return this;
  }
  updateSize(_width?: any, _height?: any): this {
    return this;
  }
  addPanelClass(_classes: any): this {
    return this;
  }
  removePanelClass(_classes: any): this {
    return this;
  }
}

export class Dialog {
  static shared = new Dialog();
  openDialogs: DialogRef<any, any>[] = [];
  open<R = unknown, D = unknown, C = unknown>(
    _componentOrTemplateRef: any,
    config?: { providers?: (dialogRef: DialogRef<R, C>, config: any) => any; [key: string]: any },
  ): DialogRef<R, C> {
    const ref = new DialogRef<R, C>(new OverlayRef(config), config);
    this.openDialogs.push(ref);
    return ref;
  }
  closeAll(): void {
    for (const ref of this.openDialogs.slice()) ref.close();
    this.openDialogs = [];
  }
  getDialogById(id: string): DialogRef<any, any> | undefined {
    return this.openDialogs.find((d) => d.id === id);
  }
}

// ---- @angular/cdk/menu ----

export interface Menu {
  id: string;
  orientation: 'horizontal' | 'vertical';
  nativeElement: any;
  focusFirstItem(focusOrigin: any): void;
  focusLastItem(focusOrigin: any): void;
}

export class CdkMenuBase implements Menu {
  id = '';
  orientation: 'horizontal' | 'vertical' = 'vertical';
  nativeElement: any = null;
  readonly items: readonly CdkMenuItem[] = [];
  readonly closed = new EventEmitter<void>();
  focusFirstItem(_focusOrigin?: any): void {}
  focusLastItem(_focusOrigin?: any): void {}
  setActiveMenuItem(_item: CdkMenuItem): void {}
}

export class CdkMenu extends CdkMenuBase {
  static shared = new CdkMenu();
}

export class CdkMenuBar extends CdkMenuBase {}

export class CdkMenuGroup {}

export class CdkMenuItem {
  static shared = new CdkMenuItem();
  readonly _elementRef: any = { nativeElement: null };
  disabled = false;
  typeaheadLabel: string | null = null;
  readonly hasMenu = false;
  readonly triggered = new EventEmitter<void>();
  trigger(_options?: { keepOpen?: boolean }): void {
    if (!this.disabled) this.triggered.emit();
  }
  isMenuOpen(): boolean {
    return false;
  }
  getMenuTrigger(): CdkMenuTrigger | null {
    return null;
  }
  focus(): void {}
  getLabel(): string {
    return this.typeaheadLabel ?? '';
  }
}

export class CdkMenuItemSelectable extends CdkMenuItem {
  checked = false;
}

export class CdkMenuItemCheckbox extends CdkMenuItemSelectable {
  override trigger(options?: { keepOpen?: boolean }): void {
    if (!this.disabled) {
      this.checked = !this.checked;
      super.trigger(options);
    }
  }
}

export class CdkMenuItemRadio extends CdkMenuItemSelectable {
  override trigger(options?: { keepOpen?: boolean }): void {
    if (!this.disabled) {
      this.checked = true;
      super.trigger(options);
    }
  }
}

export class CdkMenuTrigger {
  static shared = new CdkMenuTrigger();
  readonly injector: any = null;
  menuTemplateRef: any = null;
  menuPosition: ConnectedPosition[] = [];
  menuData: any = null;
  readonly opened = new EventEmitter<void>();
  readonly closed = new EventEmitter<void>();
  private _open = false;
  isOpen(): boolean {
    return this._open;
  }
  open(): void {
    this._open = true;
    this.opened.emit();
  }
  close(): void {
    if (this._open) {
      this._open = false;
      this.closed.emit();
    }
  }
  toggle(): void {
    if (this._open) this.close();
    else this.open();
  }
  getMenu(): Menu | undefined {
    return undefined;
  }
}

export class CdkContextMenuTrigger extends CdkMenuTrigger {}
