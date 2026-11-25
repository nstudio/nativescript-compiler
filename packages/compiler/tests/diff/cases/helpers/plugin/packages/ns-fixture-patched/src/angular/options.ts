export interface Options {
  title: string;
  pinned: boolean;
}

export const DEFAULTS: Options = { title: 'untitled', pinned: false };

export function merged(options: Partial<Options>): Options {
  return { ...DEFAULTS, ...options };
}
