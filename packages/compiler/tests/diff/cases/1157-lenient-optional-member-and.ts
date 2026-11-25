// @app-lenient
// A non-strict app's optional boolean member as an operand of `&&` and `||` with another boolean: tested as a condition,
// and as a value whose truth is what is printed.
interface Options {
  b?: boolean;
  n?: number;
  s?: string;
}
function show(options: Options, x: number) {
  if (options.b && x > 1) console.log('big');
  if (x > 0 && !options.b) console.log('positive, not b');
  if (options.b || x === 0) console.log('b or zero');
  const ok = options.b && x > 0;
  const either = x > 1 || options.b;
  console.log(!!ok, !either, ok ? 'ok' : 'not ok', either ? 'either' : 'neither');
  console.log(options.b || x, options.s || 'none', options.n || -1);
}
show({}, 2);
show({ b: false, n: 0, s: '' }, 2);
show({ b: true, n: 3, s: 'a' }, 2);
show({ b: true, n: 3, s: 'a' }, 0);
