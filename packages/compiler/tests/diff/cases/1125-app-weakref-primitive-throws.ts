// App code's `new WeakRef` of an untyped primitive throws, as in JS; core's (case 1124) holds it.
const primitive: any = 5;
try {
  new WeakRef(primitive);
} catch (e) {
  console.log('weak', e instanceof TypeError);
}
