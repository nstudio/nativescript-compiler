// @app-lenient
// Code checked without strictNullChecks types a match as present: no match is null, held as such, and reading it is
// JavaScript's TypeError.
const t = (f: () => unknown, k: string) => {
  try {
    console.log(k, f());
  } catch (e) {
    console.log(k, 'caught', e instanceof TypeError);
  }
};
const s: string = 'abc';
t(() => {
  const m = s.match(/x/);
  return m[0];
}, 'element');
t(() => {
  const m = s.match(/x/);
  return m.index;
}, 'index');
t(() => {
  const m = /z/.exec(s);
  return m.length;
}, 'exec');
t(() => {
  const m = s.match(/x/);
  return m === null;
}, 'null');
t(() => {
  const m = s.match(/(b)/);
  return m[1] + m.index;
}, 'found');
