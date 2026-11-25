// A module variable's initializer runs in statement order, after the calls above it: a read of a variable, or of a
// member of an object, sees what those calls assigned.
function navigatingTo(page: { bindingContext: any }) {
  page.bindingContext = { title: 'model' };
}
const page = { bindingContext: null as any };
navigatingTo(page);
const m = page.bindingContext;

const bag: any = {};
let counter = 0;
const base = 40;
function setup() {
  bag.ctx = 'b';
  counter = 5;
}
setup();
const n = bag.ctx;
const c = counter;
const sum = base + 2;
let later = counter * 2;
console.log(m, n, c, sum, later);
function show() {
  return [m.title, n, c, later];
}
counter = 7;
console.log(show(), c);

namespace Settings {
  export let level = 1;
  export function raise() {
    level = 9;
  }
  raise();
  export const seen = level;
  export const fixed = 3 * 2;
}
console.log(Settings.seen, Settings.fixed, Settings.level);
