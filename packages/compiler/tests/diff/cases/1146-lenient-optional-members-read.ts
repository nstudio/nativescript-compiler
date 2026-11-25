// @app-lenient
// A non-strict app's optional members of an options object: a boolean read into a template string while undefined,
// and one stored into a class's boolean field (a class extending nothing) or passed for a boolean parameter.
interface Options {
  flag?: boolean;
  b?: boolean;
  n?: number;
  s?: string;
}
class Holder {
  b: boolean;
  n: number;
  constructor(options: Options) {
    this.b = options.b;
    this.n = options.n;
  }
}
function pick(v: boolean, n: number) {
  return v === true ? n : -1;
}
function show(options: Options) {
  console.log(`flag=${options.flag} n=${options.n} s=${options.s}`);
  console.log('flag ' + options.flag, pick(options.b, 1));
  const h = new Holder(options);
  if (options.b !== undefined && options.n !== undefined) console.log(h.b, h.n, `${h.b}`);
}
show({});
show({ flag: true, b: false, n: 2, s: 'x' });
show({ flag: false, b: true, n: 0 });
