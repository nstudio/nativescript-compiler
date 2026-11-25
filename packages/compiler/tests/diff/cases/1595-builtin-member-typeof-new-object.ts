// @app-lenient
// @cli-program
// A built-in's member is what the built-in has, and `new Object(v)` is v itself, a new object for undefined and null.
console.log(typeof Date.now, typeof Object.keys, typeof Math.max, typeof JSON.stringify, typeof Promise.all);
var re = /a[a-z]{2,4}/;
var s = new Object('abcdefghi');
console.log(re.test(s as any), re.exec(s as any) !== null, String(s));
var same = { a: 1 };
console.log(new Object(same) === same);
var made = new Object(null);
made['k'] = 1;
console.log(Object.keys(made), typeof new Object(undefined));
