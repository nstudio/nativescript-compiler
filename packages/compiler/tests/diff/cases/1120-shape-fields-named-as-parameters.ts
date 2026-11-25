// A shape's optional fields named as the parameters and locals of the members a translator writes for it
// (`key`, `had`, `unset`, `oldValue`, `order`, `keys`): `in`, the key order and writes see the fields.
interface Entry {
  title: string;
  key?: string;
  had?: boolean;
  unset?: number;
  oldValue?: string;
  order?: string[];
  keys?: string;
}

const e: Entry = { title: 'a' };
console.log('key' in e, 'had' in e, 'unset' in e, 'oldValue' in e, 'order' in e, 'keys' in e, Object.keys(e).join());
e.key = 'k';
e.oldValue = 'x';
console.log('key' in e, 'oldValue' in e, Object.keys(e).join());
e.oldValue = undefined;
e.unset = undefined;
console.log('oldValue' in e, 'unset' in e, e.oldValue, Object.keys(e).join());
e.had = false;
e.order = ['z'];
e.keys = '';
console.log(JSON.stringify(e), Object.keys(e).join());

const parsed = JSON.parse('{"title":"b","keys":"q"}') as Entry;
console.log('key' in parsed, 'keys' in parsed, Object.keys(parsed).join(), parsed.keys);
