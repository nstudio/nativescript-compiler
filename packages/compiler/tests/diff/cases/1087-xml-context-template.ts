// @members-by-name
// A template's rows take the element type of their owner's `items`: rows of an app class are read directly behind
// `instanceof`, rows of an object type by name. A row whose item is null, or not of the class, takes the reads by name.
import { __nsb } from './helpers/xml-nsb.ts';
import { Fruit as __nsCtx1 } from './helpers/xml-models.ts';

const ofClass: (m: any, c: any) => any = (m: any, c: any): any => m instanceof __nsCtx1 ? (((m.count as any)) + ((" left" as any)) as any) : ((__nsb.id(m, c, "count")) + ((" left" as any)) as any);
const ofObject: (m: any, c: any) => any = (m: any, c: any): any => ((__nsb.id(m, c, "count")) + ((" left" as any)) as any);

const classRows: __nsCtx1[] = [new __nsCtx1('Apples', 3), new __nsCtx1('Pears', 7)];
const objectRows = [{ name: 'Plums', count: 12 }, { name: 'Figs', count: 0 }];
const row = (m: any) => {
  const out: string[] = [];
  for (const c of [m, { $value: m }]) out.push(String(ofClass(m, c)), String(ofObject(m, c)));
  return out.join(' | ');
};
for (const r of classRows) console.log('class', r.name, row(r));
for (const r of objectRows) console.log('object', r.name, row(r));
// Core gives a recycled row `global` as its context.
console.log('recycled', row(global));
const wrong: any = classRows[0];
wrong.count = 'many';
console.log('wrong-typed', String(ofClass(wrong, wrong)) === String(ofObject(wrong, wrong)));
wrong.count = null;
console.log('null', String(ofClass(wrong, wrong)) === String(ofObject(wrong, wrong)));
