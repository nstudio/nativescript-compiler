// @app-lenient
// A field initialized from a module variable declared without a value, which the module sets before any instance is
// made and a handler later sets to an untyped value.
let saved: number;
if (typeof saved === 'undefined') {
  saved = 2;
}
class Model {
  index = saved;
  label = 'model';
  changed(data: any) {
    saved = data.value;
    this.index = data.value;
  }
}
const m = new Model();
console.log(m.index + 1, m.label);
m.changed({ value: 5 });
console.log(m.index, new Model().index);
