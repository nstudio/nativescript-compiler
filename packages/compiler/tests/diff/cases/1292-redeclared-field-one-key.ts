// A subclass field redeclaring its base's, of the same type or over an untyped one: one property, so one key.
class Base {
  width: number = 1;
  tag: any = 'base';
  name = 'b';
}
class Wide extends Base {
  width: number = 3;
  tag: string = 'wide';
}
const w = new Wide();
console.log(JSON.stringify(w), Object.keys(w).join(','), w.tag.length);
const b: Base = w;
b.tag = 7;
b.width = 4;
console.log(JSON.stringify(w), Object.keys(w).length, w.tag, typeof w.tag, w.width + 1);
