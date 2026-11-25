// Slots that may hold null and undefined both, of an object type (an own class, a library object) or a string: a
// callback's result given to a library's generic callback type, a parameter, a field, an element read as a receiver.
class Meta {
  constructor(public name: string) {}
}
interface State {
  meta: Meta | null | undefined;
  label?: string | null;
}
const states: State[] = [{ meta: new Meta('a') }, { meta: null }, { meta: undefined, label: null }];

// A callback's result, given to a library's generic callback type.
const metas = states.map((s: State) => s.meta);
console.log('map', metas.length, metas[0]?.name, metas[1] === null, metas[2] === undefined, metas[1] === undefined);
const labels = states.map((s) => s.label);
console.log('labels', labels[0] === undefined, labels[2] === null, String(labels[2]), `${labels[0]}`);
const firstNull = states.find((s) => s.meta === null);
console.log('find', firstNull !== undefined, firstNull?.meta === null);

// A parameter of a library object's type.
function describe(value: Date | null | undefined): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  return String(value.getTime());
}
console.log('date', describe(new Date(5)), describe(null), describe(undefined));
function shown(value: Meta | null | undefined): string {
  return value === null ? 'null' : value === undefined ? 'undefined' : value.name;
}
console.log('class', shown(states[0].meta), shown(states[1].meta), shown(states[2].meta));

// A field.
class Holder {
  current: Meta | null | undefined;
  set(m: Meta | null | undefined): void {
    this.current = m;
  }
}
const h = new Holder();
console.log('field', h.current === undefined, h.current === null);
h.set(null);
console.log('field null', h.current === undefined, h.current === null);
h.set(new Meta('b'));
console.log('field set', h.current?.name);
