import { Hub } from './hub-core.ts';

declare module './hub-core.ts' {
  interface Hub {
    store(prefix?: string): string;
    twice(n: number): number;
    count(): number;
    version: number;
  }
}

Hub.prototype.store = function (prefix?: string) {
  return `${prefix ?? 'store'} of ${this.name}`;
};
Hub.prototype.twice = function (n: number) {
  return n * 2 + this.name.length;
};

let counted = 0;

export function installCount() {
  Hub.prototype.count = function () {
    return ++counted;
  };
  Hub.prototype.version = 2;
}
