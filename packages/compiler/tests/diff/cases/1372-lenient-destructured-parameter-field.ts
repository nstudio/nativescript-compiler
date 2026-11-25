// @app-lenient
// A non-strict app's parsed payload field, whose type the program tests, destructured in handlers' parameters (a
// function's, a library callback's, nested, defaulted, beside a rest) and read by name: object, null and missing alike.
interface Note {
  id: string;
  text: string;
}

interface Reply {
  note: Note;
  code: number;
}

type Act = { note: Note; kind: string; meta: { by: Note; at: number } };

function describe(act: Act): string {
  const n: Note = act.note;
  return n ? `${n.id}:${n.text}` : `none(${n === null ? 'null' : typeof n})`;
}

function add(list: string[], { note, kind }: Act): string[] {
  return [...list, `${kind}=${note ? note.text : String(note)}`];
}

const replies: Reply[] = JSON.parse('[{"note":{"id":"a","text":"one"},"code":1},{"note":null,"code":2},{"code":3}]');
const by: Note = { id: 'u', text: 'x' };
const acts: Act[] = [];
let list: string[] = [];
for (const r of replies) {
  const act: Act = { note: r.note, kind: `k${r.code}`, meta: { by, at: r.code } };
  acts.push(act);
  console.log(describe(act));
  list = add(list, act);
}
console.log(list.join(','));
const authors = acts.reduce((out: string[], { meta: { by }, note = by, ...rest }) => [...out, `${by.id}/${note ? note.id : String(note)}/${Object.keys(rest).join('+')}`], []);
console.log(authors.join(','));
