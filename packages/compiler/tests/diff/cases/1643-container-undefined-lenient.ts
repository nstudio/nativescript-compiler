// @app-lenient
// A non-strict app's record, array and Map typed to hold strings or numbers, given the undefined of a split piece past
// the end, an index past an array's end and a Map's missing entry: each holds undefined, as JavaScript does.
function attempt(label: string, f: () => unknown) {
  try {
    console.log(label, f());
  } catch (e) {
    console.log(label, (e as Error).name);
  }
}
interface Event {
  tzid: string;
  name: string;
}
function parseLine(line: string, cur: Event): Record<string, string> {
  const params: Record<string, string> = {};
  for (const p of line.split(';')) {
    const [k, v] = p.split('=');
    params[k] = v;
  }
  if (params['TZID']) cur.tzid = params['TZID'];
  if (params['NAME']) cur.name = params['NAME'];
  return params;
}
const ev: Event = { tzid: 'UTC', name: 'none' };
const params = parseLine('TZID;NAME=Standup', ev);
console.log(ev.tzid, ev.name, 'TZID' in params, params['TZID'] === undefined, JSON.stringify(params));
attempt('upper', () => params['TZID'].toUpperCase());

const codes: string[] = ['SU', 'MO'];
const wanted: string[] = [codes[5]];
console.log(wanted.length, wanted[0] === undefined, wanted.join('+'), JSON.stringify(wanted));
const sizes = new Map<string, number>([['s', 1]]);
const picked: number[] = [];
for (const k of ['s', 'm']) picked.push(sizes.get(k));
const byName: Record<string, number> = {};
byName.m = sizes.get('m');
console.log(picked.length, picked[1] === undefined, JSON.stringify(picked), 'm' in byName, byName.m === undefined);
for (const n of picked) console.log('picked', n === undefined ? 'U' : n.toFixed(1));
