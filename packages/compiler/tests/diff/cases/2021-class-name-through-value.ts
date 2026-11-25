// A class's `name` read through a value holding the class: a variable, a parameter typed by what it reads, an array's element.
class Widget {
  static made = 0;
}
class Gadget extends Widget {}
const k = Gadget;
console.log(k.name, k === Gadget);
function nameOf(c: { name: string }): string {
  return c.name;
}
console.log(nameOf(Widget), nameOf(Gadget));
const kinds = [Widget, Gadget];
console.log(kinds.map((c) => c.name).join('/'));
let chosen: typeof Widget = Widget;
chosen = Gadget;
console.log(chosen.name);
