// @app-lenient
// @cli-program
// A promise held untyped whose value is an object of a shape: its reaction gets that object itself.
var nonThenable = { then: null };
var settled = { then: null, n: 1 };
var p2;
p2 = Promise.resolve().then(function () {
  return nonThenable;
});
p2.then(function (value) {
  console.log('same', value === nonThenable);
});
var p3;
p3 = Promise.resolve(settled);
p3.then(function (value) {
  console.log('settled', value === settled, value.n);
});
