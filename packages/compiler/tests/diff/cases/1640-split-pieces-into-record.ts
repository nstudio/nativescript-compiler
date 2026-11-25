// A string's split pieces destructured past the end and stored in a record typed to hold strings: the entry holds
// undefined, which a truth test, `in`, `typeof`, JSON and a member call on it see as JavaScript does.
function attempt(label: string, f: () => unknown) {
  try {
    console.log(label, f());
  } catch (e) {
    console.log(label, (e as Error).name);
  }
}
function parseParams(line: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const p of line.split(';')) {
    const [k, v] = p.split('=');
    params[k] = v;
  }
  return params;
}
const params = parseParams('TZID=Europe/Paris;FLAG;X=1');
console.log(params['TZID'], params['FLAG'], params['X'], params['NONE']);
if (params['FLAG']) console.log('flag set');
else console.log('flag unset');
console.log(Object.keys(params).join(','), 'FLAG' in params, params['FLAG'] === undefined, typeof params['FLAG'], params.FLAG ?? 'dflt');
console.log(JSON.stringify(params), Object.values(params).length, `${params['FLAG']}`, String(params.FLAG), params['FLAG'] + '!');
const tz = { tzid: 'UTC' };
if (params['TZID']) tz.tzid = params['TZID'];
console.log(tz.tzid);
attempt('upper', () => params['FLAG'].toUpperCase());
attempt('length', () => params.FLAG.length);
attempt('ok', () => params['TZID'].toUpperCase());

function fieldsOf(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const [name, value] = text.split(':');
  fields[name] = value;
  fields.copy = fields[name];
  return fields;
}
const fields = fieldsOf('only');
for (const [k, v] of Object.entries(fields)) console.log('entry', k, v === undefined, typeof v);
for (const v of Object.values(fields)) console.log('value', v ?? 'none');
console.log(JSON.stringify(fields), Object.keys(fields).length, fieldsOf('a:b').a);

function groupsOf(words: string[], extra: string[][]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const w of words) {
    let list = groups[w[0]];
    if (!list) {
      list = [];
      groups[w[0]] = list;
    }
    list.push(w);
  }
  groups['none'] = extra[3];
  return groups;
}
const g = groupsOf(['ab', 'ac', 'bd'], []);
console.log(Object.keys(g).join(','), g.a.length, g['none'] === undefined, JSON.stringify(g));
attempt('none', () => g['none'].length);
