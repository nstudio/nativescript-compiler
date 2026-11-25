// Classes named as the kit's types, declared in another module and constructed, read and tested here.
import FlexWrap, { FlexGrow } from './helpers/kit-names/flex.ts';

function build(make: () => FlexWrap): string {
  return make().describe();
}

const wrap = new FlexWrap();
const grow = new FlexGrow(2);
console.log(wrap.describe(), grow.describe(), wrap.mode, grow.grow);
console.log(build(() => new FlexWrap('nowrap')), [3, 4].map((n) => new FlexGrow(n).describe()).join());
const items: FlexGrow[] = [grow, new FlexGrow(5)];
console.log(items.map((g) => g.grow).join(), wrap instanceof FlexWrap, items[1] instanceof FlexGrow);
console.log(FlexWrap.made);
