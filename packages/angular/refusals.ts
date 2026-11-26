import type { RefusalKind } from '@nstudio/nativescript-compiler/adapter-api';

const ISOLATE = 'move the code into a plain function of its own with typed parameters and result, so the rest of the module translates; the refusal then names only that function';

export const refusals = {
  'library-injectable': { class: 'gap', title: "an injected class only a library's typings declare", suggestion: ISOLATE },
} as const satisfies Record<string, RefusalKind>;

declare module '@nstudio/nativescript-compiler/adapter-api' {
  interface AdapterRefusalIds extends Record<keyof typeof refusals, true> {}
}
