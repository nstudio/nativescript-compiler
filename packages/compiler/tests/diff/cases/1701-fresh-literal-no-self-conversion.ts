// Fresh literals placed where their own type goes: an empty array and an empty dictionary, each the object it was made
// as (aliases share writes, keys keep order). 1706: an object literal of a shape held as a wider intersection type.
interface Ev {
  uid: string;
  tags: string[];
}
const events: Ev[] = [];
const alias = events;
events.push({ uid: 'u1', tags: ['x'] });
const params: Record<string, string> = {};
const paramsAlias = params;
params['TZID'] = 'UTC';
params.b = 'second';
console.log(alias.length, alias === events, JSON.stringify(events), JSON.stringify(paramsAlias), Object.keys(params).join(','));
const nested: Record<string, number[]> = {};
nested.a = [];
nested.a.push(1);
console.log(JSON.stringify(nested), Object.keys(nested).length);
