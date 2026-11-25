// @app-lenient
// @assign-fields
// @members-by-name
// A non-strict app's model sets fields declared string, number and boolean to null and back, as toolbox's box-shadow
// page does, and notifies each value read typed.
class Notifier {
  notify(name: string, value: any) {
    console.log(name, value === null ? 'null' : value === undefined ? 'undefined' : JSON.stringify(value), typeof value);
  }
}
class Shadow extends Notifier {
  borderColor: string;
  borderWidth: number;
  visible: boolean;
  toggle() {
    this.borderColor = this.borderColor ? null : 'green blue';
    this.borderWidth = this.borderWidth ? null : 3;
    this.visible = this.visible ? null : true;
    this.notify('borderColor', this.borderColor);
    this.notify('borderWidth', this.borderWidth);
    this.notify('visible', this.visible);
  }
  none() {
    this.borderColor = null;
    this.borderWidth = undefined;
    this.notify('borderColor', this.borderColor);
    this.notify('borderWidth', this.borderWidth);
    console.log(this.borderColor === null, this.borderWidth === undefined, this.borderColor == null, `${this.borderColor}`);
  }
}
const s = new Shadow();
s.toggle();
s.toggle();
s.toggle();
s.none();
console.log(JSON.stringify(s), s.borderColor || 'falsy');
