// @app-lenient
// A non-strict app writes null and undefined into fields declared string, number and boolean, then reads them back.
class Model {
  background: string;
  width: number;
  on: boolean;
  constructor() {
    this.background = 'red';
    this.width = 2;
    this.on = true;
  }
  clear() {
    this.background = null;
    this.width = null;
    this.on = null;
  }
  unset() {
    this.background = undefined;
    this.width = undefined;
    this.on = undefined;
  }
}
function show(label: string, m: Model) {
  console.log(label, m.background, m.width, m.on);
  console.log(JSON.stringify({ background: m.background, width: m.width, on: m.on }));
  console.log(m.background === null, m.width === null, m.on === null, m.background === undefined, m.width == null);
  console.log(`${m.background}|${m.width}|${m.on}`, typeof m.background, typeof m.width, typeof m.on);
}
const m = new Model();
show('set', m);
m.clear();
show('null', m);
m.unset();
show('undefined', m);
m.background = 'blue';
m.width = 0;
m.on = false;
show('again', m);
class Tagged extends Model {
  tag: string = 'a';
  drop() {
    this.tag = null;
    this.width = undefined;
  }
}
class Holder {
  items: string[] = [];
  label: string;
  empty() {
    this.label = null;
  }
}
class Counter extends Holder {
  count: number = 1;
  reset() {
    this.count = null;
    this.empty();
  }
}
const t = new Tagged();
t.drop();
console.log(JSON.stringify(t), t.tag === null, t.width === undefined);
const c = new Counter();
c.reset();
console.log(JSON.stringify(c), c.count === null, c.count == undefined, c.label === null);
