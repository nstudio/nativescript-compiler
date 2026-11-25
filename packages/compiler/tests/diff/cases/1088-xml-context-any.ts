// @members-by-name
// A context written as `any` is not proved, even when the value is an app class's instance: its closures read by name,
// and give what the typed reads would.
import { __nsb } from './helpers/xml-nsb.ts';
import { HelloWorldModel } from './helpers/xml-models.ts';

const closure: (m: any, c: any) => any = (m: any, c: any): any => ((("Taps: " as any)) + (__nsb.id(m, c, "counter")) as any);
function load(kind: string): any {
  return kind === 'model' ? new HelloWorldModel() : { counter: kind };
}
function navigatingTo(page: { bindingContext: any }, kind: string) {
  page.bindingContext = load(kind);
}
function run(kind: string) {
  const page = { bindingContext: null as any };
  navigatingTo(page, kind);
  const m = page.bindingContext;
  console.log(kind, closure(m, m), closure(m, { $value: m }), m instanceof HelloWorldModel);
  if (m instanceof HelloWorldModel) {
    m.onTap();
    m.onTap();
    console.log(closure(m, m), m.counter === 2);
  }
}
run('model');
run('json');
