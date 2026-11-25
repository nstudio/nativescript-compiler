// @members-by-name
// A page context proved to be an app class: the compiled closures read its members directly behind `instanceof`, and
// any other context takes the reads by name. Both give what core's evaluator gives, with wrong-typed values written by
// name (as `Observable.set` writes them) read the same way through either.
import { __nsb } from './helpers/xml-nsb.ts';
import { HelloWorldModel as __nsCtx0, Observable } from './helpers/xml-models.ts';

const typed: ((m: any, c: any) => any)[] = [
  (m: any, c: any): any => m instanceof __nsCtx0 ? ((("Taps: " as any)) + ((m.counter as any)) as any) : ((("Taps: " as any)) + (__nsb.id(m, c, "counter")) as any),
  (m: any, c: any): any => m instanceof __nsCtx0 ? (((((m.counter as any)) > ((3 as any)) as any)) ? (("Many taps" as any)) : (("Few taps" as any))) : ((((__nsb.id(m, c, "counter")) > ((3 as any)) as any)) ? (("Many taps" as any)) : (("Few taps" as any))),
  (m: any, c: any): any => m instanceof __nsCtx0 ? ((__nsb.member((m.items as any), "length", 1, false)) + ((" items" as any)) as any) : ((__nsb.member(__nsb.id(m, c, "items"), "length", 1, false)) + ((" items" as any)) as any),
];
const byName: ((m: any, c: any) => any)[] = [
  (m: any, c: any): any => ((("Taps: " as any)) + (__nsb.id(m, c, "counter")) as any),
  (m: any, c: any): any => ((((__nsb.id(m, c, "counter")) > ((3 as any)) as any)) ? (("Many taps" as any)) : (("Few taps" as any))),
  (m: any, c: any): any => ((__nsb.member(__nsb.id(m, c, "items"), "length", 1, false)) + ((" items" as any)) as any),
];
const show = (m: any, label: string) => {
  for (const c of [m, { $value: m }]) {
    const a = typed.map((f) => String(f(m, c)));
    let same = true;
    for (let i = 0; i < byName.length; i++) if (String(byName[i](m, c)) !== a[i]) same = false;
    console.log(label, a.join(' | '), same);
  }
};
const model = new __nsCtx0();
show(model, 'new');
for (let i = 0; i < 4; i++) model.onTap();
show(model, 'tapped');
const anyModel: any = model;
anyModel.items = ['x'];
show(model, 'items by name');
// A wrong-typed value written by name is read as the by-name read reads it.
model.set('counter', '2');
const agree = () => {
  const out: boolean[] = [];
  for (let i = 0; i < typed.length; i++) out.push(String(typed[i](model, model)) === String(byName[i](model, model)));
  return out.join(' ');
};
console.log('counter by name', agree());
model.set('items', null);
console.log('items null', agree());
// Other contexts: a plain object, another Observable, an object without the keys.
show({ counter: 9, items: [1, 2] }, 'plain');
const other = new Observable();
other.set('counter', 1);
other.set('items', []);
show(other, 'other');
show({ counter: 0, items: { length: 'n' } }, 'shape');
show({}, 'empty');
