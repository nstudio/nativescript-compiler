// A function declared `boolean` whose result is read from an untyped value, tested as a condition: negated,
// directly, and in a logical expression (test262's propertyHelper isEnumerable).
const hasOwn = (obj: any, name: any): boolean => obj.hasOwnProperty(name);

function isEnumerable(obj: any, name: any): boolean {
  let stringCheck = false;
  if (typeof name === 'string') {
    for (const x in obj) {
      if (x === name) {
        stringCheck = true;
        break;
      }
    }
  } else stringCheck = true;
  return stringCheck && hasOwn(obj, name) && obj.propertyIsEnumerable(name);
}

function flag(o: any): boolean {
  return o.flag;
}

const o: any = { a: 1, flag: undefined };
if (!isEnumerable(o, 'a')) console.log('a not enumerable');
else console.log('a enumerable');
if (isEnumerable(o, 'b')) console.log('b enumerable');
else console.log('b not enumerable');
console.log(isEnumerable(o, 'a') && !flag(o) ? 'and: yes' : 'and: no');
if (!flag(o)) console.log('flag undefined is falsy');
console.log(isEnumerable(o, 'b'), flag(o));
