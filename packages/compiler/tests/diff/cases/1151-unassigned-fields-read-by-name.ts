// @app-lenient
// @assign-fields
// @members-by-name
// Fields declared without an initializer and not yet assigned, read by name as a binding reads them: undefined until set.
class Model {
  private _kind: string = 'buttons';
  background: string;
  borderWidth: number;
  visible: boolean;
  shadow: string;
  get kind(): string {
    return this._kind;
  }
  read(name: string) {
    return (this as any)[name];
  }
  pick(kind: string) {
    this._kind = kind;
    if (kind === 'solid') this.background = '#65ADF1';
    if (kind === 'wide') this.borderWidth = this.borderWidth ? 0 : 5;
  }
}
function show(m: Model, label: string) {
  const names = ['background', 'borderWidth', 'visible', 'shadow', 'kind'];
  console.log(label, names.map((n) => `${n}=${m.read(n) === undefined ? 'undefined' : JSON.stringify(m.read(n))}`).join(' '));
  console.log(label, names.map((n) => `${n in m}`).join(','), Object.keys(m).join(','), JSON.stringify(m));
}
const m = new Model();
show(m, 'new');
m.pick('solid');
show(m, 'solid');
m.pick('wide');
m.visible = false;
show(m, 'wide');
const any: any = new Model();
console.log(any['borderWidth'] === undefined, typeof any.shadow, any['shadow'] ?? 'none');
