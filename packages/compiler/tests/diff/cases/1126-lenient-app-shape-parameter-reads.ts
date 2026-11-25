// @app-lenient
// A non-strict app's parameter of an object type, which Kotlin holds nullable, read member by member.
class Model {
  first = true;
  label = '';
  constructor(options: { isModal?: boolean; second?: boolean; tag?: string }) {
    this.first = !options.second;
    this.label = `${options.tag}`;
  }
}
function make(context: any) {
  return new Model(context);
}
const m = make({ second: true, tag: 'x' });
console.log(m.first, m.label);
try {
  make(undefined);
} catch (e) {
  console.log(e instanceof TypeError);
}
