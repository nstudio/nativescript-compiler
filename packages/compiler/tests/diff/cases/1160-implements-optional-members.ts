// A class implementing an interface whose optional members it doesn't declare: the class is the interface wherever one
// is expected, and each such member reads as undefined and is no key of the object until written through the interface.
interface Options {
  title?: string;
  count?: number;
  onDone?: () => string;
}
interface MoreOptions extends Options {
  color?: string;
  tags?: string[];
}

class Base implements Options {
  title?: string = 'base';
}
class Dialog extends Base implements MoreOptions {
  data: MoreOptions = { color: 'red' };
  width = 3;
}

function show(o: MoreOptions): string {
  return [o.title, o.count, o.color, o.tags?.length, o.onDone ? o.onDone() : 'none'].join('|');
}

const d = new Dialog();
console.log(show(d), Object.keys(d).join(','), JSON.stringify(d));
console.log(show(d.data));
const o: MoreOptions = d;
o.color = 'blue';
o.count = 4;
o.onDone = () => 'done';
console.log(show(o), show(d), d.width, Object.keys(d).join(','), JSON.stringify(d));
o.tags = undefined;
console.log('tags' in d, Object.keys(d).join(','));
const list: Options[] = [d, new Base(), { count: 1 }];
console.log(list.map((x) => `${x.title}:${x.count}`).join(','), Object.keys(list[1]).join(','));
