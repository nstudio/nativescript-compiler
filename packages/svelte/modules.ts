import type { ModuleRules } from '@nstudio/nativescript-compiler/adapter-api';

export const modules: ModuleRules = {
  shims: {
    'svelte': `
    export declare function tick(): Promise<void>;
    `,
    'svelte/store': `
    import type { Sig } from '@nativescript/release';
    export interface Writable<T> extends Sig<T> { set(value: T): void; update(fn: (value: T) => T): void }
    export declare function writable<T>(value: T): Writable<T>;
    export declare function get<T>(store: Writable<T>): T;
    `,
    '@nativescript-community/svelte-native': `
    export declare function navigate(options: { page: any; props?: Record<string, any> }): void;
    export declare function svelteNativeNoFrame(component: any, props: any): void;
    `,
  },
  componentExtensions: ['.svelte'],
};
