// Core's `Source`, which the generated kits name `Source__debug_source` (each runtime has a `Source` of its own), named
// every way an app names a class: imported directly and under another name.
import { Source } from '@nativescript/core/utils/debug';
import { Source as Origin } from '@nativescript/core/utils/debug-source';

export class Located extends Source {
  constructor(uri: string) {
    super(uri, 1, 1);
  }
  describe(): string {
    return `${this.uri}:${this.line}`;
  }
}

export function locate(o: object, keep: (c: Function) => void): string {
  const s = new Source('a.xml', 1, 2);
  const t: Origin = new Origin('b.xml', 3, 4);
  const list: Source[] = [s, t, new Located('c.xml')];
  Source.set(o, s);
  keep(Source);
  keep(Origin);
  return [s.uri, t.line, o instanceof Source, o instanceof Origin, Origin.get(o) === s, list.length].join();
}
