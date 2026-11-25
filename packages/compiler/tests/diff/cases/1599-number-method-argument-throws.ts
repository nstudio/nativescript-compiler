// @app-lenient
// @cli-program
// A number method's argument whose valueOf throws: the call throws what it throws.
var poisoned = {
  valueOf: function () {
    throw new Error('valueOf');
  },
};
try {
  (1).toString(poisoned);
} catch (e) {
  console.log('toString threw', e.message);
}
try {
  (1).toExponential(poisoned);
} catch (e) {
  console.log('toExponential threw', e.message);
}
