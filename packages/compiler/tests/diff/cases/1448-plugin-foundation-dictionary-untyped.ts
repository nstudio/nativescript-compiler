// @plugin
// @swift ledger:nativeSdk
// A plugin's own conversion of a Foundation dictionary it is handed untyped (`data instanceof NSDictionary`): each of its
// keys (`allKeys`) with that key's value (`objectForKey`), a key it lacks null.
function deserialize(data: any): any {
  if (data instanceof NSNull) return null;
  if (data instanceof NSDictionary) {
    const dict = {};
    for (let i = 0, n = data.allKeys.count; i < n; i++) {
      const key = data.allKeys.objectAtIndex(i);
      dict[key] = deserialize(data.objectForKey(key));
    }
    return dict;
  }
  return data;
}

const d = NSDictionary.dictionaryWithObjectsForKeys(NSArray.arrayWithArray(['x', 2, NSNull.null()] as any), NSArray.arrayWithArray(['a', 'b', 'c'] as any));
const o = deserialize(d);
// Foundation gives the keys in no defined order: what is printed holds in any.
const want: { [key: string]: any } = { a: 'x', b: 2, c: null };
const keys = Object.keys(o);
console.log(keys.length, keys.every((k) => ['a', 'b', 'c'].indexOf(k) >= 0 && o[k] === want[k]), d.objectForKey('missing') === null, d.objectForKey('a'));
