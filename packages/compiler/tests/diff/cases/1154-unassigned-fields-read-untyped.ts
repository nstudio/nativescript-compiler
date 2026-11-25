// @app-lenient
// @assign-fields
// @members-by-name
// Fields declared without an initializer and not yet assigned, read typed where any value goes: undefined until set.
class Notifier {
  notify(name: string, value: any) {
    console.log(name, value === undefined ? 'undefined' : JSON.stringify(value));
  }
}
class Model extends Notifier {
  background: string;
  borderWidth: number;
  borderRadius: number;
  visible: boolean;
  pick(kind: string) {
    if (kind === 'solid') this.borderWidth = this.borderWidth ? 0 : 5;
    if (kind === 'none') this.borderRadius = 0;
    this.notify('background', this.background);
    this.notify('borderWidth', this.borderWidth);
    this.notify('borderRadius', this.borderRadius);
    this.notify('visible', this.visible);
  }
}
const m = new Model();
m.pick('other');
m.pick('solid');
m.pick('none');
const held: any = m.visible;
const fresh: any = new Model().borderRadius;
console.log(held === undefined, fresh === undefined);
