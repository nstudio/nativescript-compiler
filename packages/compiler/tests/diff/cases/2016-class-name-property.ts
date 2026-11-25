// A class's `name`, read on the class itself: the name it is declared with, a subclass's its own, a class named as one
// of the kit's types by its program name, and one declared in a function.
import FlexWrap from './helpers/kit-names/flex.ts';

class Widget {
  static made = 0;
}
class Gadget extends Widget {}
console.log(Widget.name, Gadget.name, typeof Widget.name, Widget.name.length);
console.log(`<${Gadget.name}>`, [Widget.name, Gadget.name].join('/'), FlexWrap.name);
function local(): string {
  class Inner {}
  return Inner.name + ':' + Widget.name.toUpperCase();
}
console.log(local(), Gadget.name === 'Gadget');
