// @app-lenient
// @cli-program
// Promise.all over a list of one value settles with an array holding that value, a thenable adopted first.
var thenable = {
  then: function (_resolve, reject) {
    reject('no');
  },
};
async function main() {
  await Promise.all([thenable]).then(
    function () { console.log('fulfilled'); },
    function (x) { console.log('rejected', x); },
  );
  await Promise.all([Promise.resolve(7)]).then(function (xs) { console.log('one', xs.length, xs[0]); });
  await Promise.all([5]).then(function (xs) { console.log('plain', Array.isArray(xs), xs[0]); });
  await Promise.all([Promise.reject('d')]).catch(function (e) { console.log('all rejected', e); });
  var rejections = [Promise.reject('a'), new Promise((_, reject) => reject('b')), Promise.all([Promise.reject('c')])];
  await Promise.any(rejections).then(
    function () { console.log('any fulfilled'); },
    function (e) { console.log('any rejected', e.errors.join('')); },
  );
}
main();
