// @app-lenient
// A non-strict app's own handler type whose callback is given an arrow destructuring its payload parameter, including
// one called with no payload and one with a default.
interface Note {
  id: string;
  text: string;
}

type Act = { note: Note; kind: string };

type Handler = (list: Note[], act: Act) => Note[];

function on(kind: string, handler: Handler): { kind: string; handler: Handler } {
  return { kind, handler };
}

const add = on('add', (list, { note, kind }) => [...list, { id: note.id, text: `${kind}:${note.text}` }]);
const keep = on('keep', (list, { kind } = { note: null, kind: 'none' }) => (kind === 'keep' ? list : list.slice(1)));
const reducers = [add, keep];

let list: Note[] = [];
const acts: Act[] = [
  { note: { id: 'a', text: 'one' }, kind: 'add' },
  { note: { id: 'b', text: 'two' }, kind: 'add' },
];
for (const act of acts) for (const r of reducers) if (r.kind === act.kind) list = r.handler(list, act);
console.log(JSON.stringify(list));
list = keep.handler(list, undefined);
console.log(list.length, list.map((n) => n.text).join(','));
list = keep.handler(list, { note: null, kind: 'keep' });
console.log(list.length);
