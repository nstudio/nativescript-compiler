// @swift ledger:unmetInterfaceMembers
// A subclass implementing its own options interface, with a field narrower than the untyped one it overrides: the
// group (both interfaces' optional members, the base's untyped field, the override) is held untyped, and a function
// field narrower than its optional member is held optional. Kotlin: a class that cannot meet the interface's inherited
// members (Picker) still implements it.
interface DialogOptions {
  height?: any;
  title?: string;
  close?: () => void;
}
interface FormDialogOptions extends DialogOptions {
  placeholder?: string;
}
class Dialog implements DialogOptions {
  height: any = 250;
  title: string = 'dialog';
  close = () => console.log('closed', this.title);
}
class FormDialog extends Dialog implements FormDialogOptions {
  height: number = 225;
  placeholder: string = 'type';
  taller(): number {
    return this.height + 10;
  }
}
// Not held as the interface it names, whose inherited members it cannot meet (a method for a function field, a
// narrower field for an untyped one): the class alone.
class Picker implements FormDialogOptions {
  height: number = 500;
  placeholder: string = 'pick';
  close(): void {
    console.log('picked', this.placeholder, this.height);
  }
}
function open(o: FormDialogOptions): string {
  return `${o.title}:${o.height}:${o.placeholder}`;
}
const f = new FormDialog();
f.close();
console.log(f.taller(), open(f), JSON.stringify(f));
const o: FormDialogOptions = f;
o.height = 'auto';
o.placeholder = undefined;
o.close?.();
console.log(f.height, f.placeholder, open(f), JSON.stringify(f));
const p = new Picker();
p.close();
console.log(JSON.stringify(p), p.height / 2);
