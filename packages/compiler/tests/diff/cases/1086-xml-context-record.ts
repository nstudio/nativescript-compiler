// @members-by-name
// A page context proved to be an Observable record (`new Observable()` with literal `set` keys in the writing function):
// its keys are known, and the closures read them by name, as core's evaluator does, wrong-typed values included.
import { __nsb } from './helpers/xml-nsb.ts';
import { Observable } from './helpers/xml-models.ts';

const fruits = [{ name: 'Apples', count: 3 }, { name: 'Pears', count: 7 }];
const closures: ((m: any, c: any) => any)[] = [
  (m: any, c: any): any => ((__nsb.id(m, c, "badge")) + (("!" as any)) as any),
  (m: any, c: any): any => ((__nsb.member(__nsb.id(m, c, "fruits"), "length", 1, false)) + ((" kinds" as any)) as any),
  (m: any, c: any): any => ((__nsb.id(m, c, "picked")) || (("Nothing picked" as any)) as any),
];
function navigatingTo(page: { bindingContext: any }) {
  const model = new Observable();
  model.set('fruits', fruits);
  model.set('badge', '2 kinds');
  model.set('picked', '');
  page.bindingContext = model;
}
const page = { bindingContext: null as any };
navigatingTo(page);
const show = (label: string) => {
  const m = page.bindingContext;
  const out: string[] = [];
  for (const c of [m, { $value: m }]) for (const f of closures) out.push(String(f(m, c)));
  console.log(label, out.join(' | '));
};
show('record');
page.bindingContext.set('picked', 'Picked Pears');
show('picked');
page.bindingContext.set('badge', 7);
page.bindingContext.set('fruits', 'ab');
show('wrong types');
page.bindingContext.set('fruits', null);
page.bindingContext.set('picked', 0);
show('null and zero');
