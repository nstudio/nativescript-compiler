// @app-lenient
// Array.prototype's methods called on values that are no arrays (`Array.prototype.map.call(arrayLike, f)`): each reads
// its receiver by `length` and index keys, skipping the keys it lacks, as the specification's algorithms do.
var like: any = { 0: 'a', 1: 'b', 3: 'd', length: 4 };
var seen: any[] = [];
Array.prototype.forEach.call(like, function (v, i) { seen.push(i + '=' + v); });
console.log(seen.join(' '));
console.log(Array.prototype.join.call(like, '-'), Array.prototype.indexOf.call(like, 'd'), Array.prototype.lastIndexOf.call(like, 'a'), Array.prototype.includes.call(like, undefined));
console.log(JSON.stringify(Array.prototype.filter.call(like, function (v) { return v !== 'b'; })), Array.prototype.some.call(like, function (v) { return v === 'd'; }), Array.prototype.every.call(like, function (v) { return typeof v === 'string'; }));
console.log(Array.prototype.reduce.call(like, function (acc, v) { return acc + v; }), Array.prototype.reduceRight.call(like, function (acc, v) { return acc + v; }, '>'));
console.log(JSON.stringify(Array.prototype.slice.call(like, 1, 3)), Array.prototype.find.call(like, function (v) { return v > 'a'; }), Array.prototype.findLastIndex.call(like, function (v) { return v === 'a'; }));
console.log(JSON.stringify(Array.prototype.map.call('abc', function (c) { return c.toUpperCase(); })), Array.prototype.join.call('xyz', '+'), Array.prototype.reduce.call(true, function () {}, -1));
var len: any = { length: { valueOf: function () { return 2; } }, 0: 5, 1: 7 };
console.log(Array.prototype.map.call(len, function (v) { return v * 2; }).join(','));
var stack: any = { length: 0 };
console.log(Array.prototype.push.call(stack, 1, 2, 3), stack.length, Array.prototype.pop.call(stack), stack.length, JSON.stringify(stack));
console.log(Array.prototype.shift.call(stack), Array.prototype.unshift.call(stack, 'z'), JSON.stringify(stack));
var r: any = { 0: 1, 1: 2, 2: 3, length: 3 };
Array.prototype.reverse.call(r);
console.log(JSON.stringify(r), JSON.stringify(Array.prototype.splice.call(r, 1, 1, 'x', 'y')), JSON.stringify(r));
var s: any = { 0: 3, 1: 1, 2: 2, length: 3 };
Array.prototype.sort.call(s);
Array.prototype.fill.call({ length: 0 }, 1);
console.log(JSON.stringify(s), JSON.stringify(Array.prototype.fill.call({ length: 2 }, 0)), JSON.stringify(Array.prototype.copyWithin.call({ 0: 1, 1: 2, 2: 3, length: 3 }, 0, 1)));
console.log(JSON.stringify(Array.prototype.concat.call([1], [2], 3)), JSON.stringify(Array.prototype.flat.call({ 0: [1, [2]], length: 1 })), Array.prototype.at.call(like, -1));
console.log(JSON.stringify([...Array.prototype.keys.call({ length: 2 })]), JSON.stringify([...Array.prototype.entries.call({ 0: 'q', length: 1 })]));
console.log(Array.prototype.toLocaleString.call({ 0: 1234.5, 1: null, 2: 'x', 3: { toLocaleString() { return 'L'; } }, length: 4 }));
var list = [1, 2, 3];
console.log(Array.prototype.reduce.call(list, function (a, b) { return a + b; }), JSON.stringify(Array.prototype.copyWithin.call([1, 2, 3, 4], 0, 2)), Array.prototype.indexOf.apply(like, ['b']));
for (const run of [
  () => Array.prototype.map.call(null, function (v) { return v; }),
  () => Array.prototype.forEach.call(like, 3),
  () => Array.prototype.reduce.call({ length: 0 }, function () {}),
]) {
  try {
    run();
  } catch (e) {
    console.log((e as Error).constructor.name, (e as Error).message);
  }
}
