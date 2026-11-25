// @packages ns-fixture-channel=ns-fixture-channel/index.ios.js
// A member only a `declare module` augmentation gives a class the program imports (as a plugin declares `rippleColor` on
// core's View), read and written through the program's subclass of it: the instance's own property, undefined until set.
import { Options } from 'ns-fixture-channel';

declare module 'ns-fixture-channel' {
  interface Options {
    tint: string;
    level: number;
  }
}

class TintedOptions extends Options {
  show(): string {
    return `${this.name}:${this.tint}:${this.level}`;
  }
  paint(tint: string, level: number) {
    this.tint = tint;
    this.level = level;
  }
  brighter(): number {
    return this.level + 1;
  }
}

const o = new TintedOptions('a');
console.log(o.show(), o.tint === undefined, typeof o.level, Number.isNaN(o.brighter()));
o.paint('red', 2);
console.log(o.show(), o.tint, o.brighter(), o.describe(), Object.keys(o).join(','));
