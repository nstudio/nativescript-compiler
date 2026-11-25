// @lenient-both
// Library mode: an object literal made as one of the program's classes runs none of the class's field initializers,
// their effects included; `new` runs them all, in order.
const log: string[] = [];
function next(tag: string): number {
  log.push(tag);
  return log.length;
}
class Step {
  name: string;
  order: number = next('order');
  label = 'step';
  stamp: number = next('stamp');
}
function steps(list: Step[]): string {
  return list.map((s) => `${s.name}:${s.order}:${s.label}:${s.stamp}`).join(',');
}
const made = new Step();
made.name = 'made';
console.log(steps([made]), log.join());
const literal: Step = { name: 'literal', order: 7, label: 'mine', stamp: 0 };
console.log(steps([literal]), log.join());
const partial = [{ name: 'p', order: 2 }].map((x) => ({ name: x.name, order: x.order * 10, label: 'mapped', stamp: -1 }));
const held: Step[] = partial;
console.log(steps(held), log.join(), held[0].stamp);
const again = new Step();
again.name = 'again';
console.log(steps([again]), log.join());
