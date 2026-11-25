import type { ModuleRules } from '@nstudio/nativescript-compiler/adapter-api';

export const modules: ModuleRules = {
  shims: {
    'nativescript-vue': `
    import type { DeepRef } from '@nativescript/release';
    export type Ref<T> = DeepRef<T>;
    export declare function ref<T>(value: T): DeepRef<T>;
    export declare function computed<T>(fn: () => T): { readonly value: T };
    export declare function nextTick(): Promise<void>;
    export declare function $navigateTo(component: any, options?: { props?: Record<string, any> }): void;
    export interface ModalOptions { props?: Record<string, any>; fullscreen?: boolean; animated?: boolean; cancelable?: boolean; closeCallback?: (result?: any) => void }
    export declare function $showModal(component: any, options?: ModalOptions): { then(fn: (result?: any) => void): void };
    export declare function $closeModal(result?: any): void;
    export declare function createApp(component: any): { start(): void };
    export interface ListItem<T = any> { item: T; index: number; even: boolean; odd: boolean }
    import type { ItemEventData } from '@nativescript/core';
    export interface ListViewItemTapEvent<T = any> extends ItemEventData { item: T; value: any }
    `,
  },
  componentExtensions: ['.vue'],
};
