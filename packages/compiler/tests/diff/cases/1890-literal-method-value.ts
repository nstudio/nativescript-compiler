// An object literal's method read as a value is the function it holds: called alone, passed, compared.
const math = {
  base: 10,
  twice(n: number) { return n * 2; },
  label(s: string) { return '<' + s + '>'; },
};
const twice = math.twice;
console.log('alone', twice(4));
console.log('map', [1, 2, 3].map(math.twice).join(','));
console.log('same', math.twice === math.twice, twice === math.twice);
const maybe: typeof math | undefined = Math.random() < 2 ? math : undefined;
const fromMaybe = maybe?.label;
console.log('optional', fromMaybe ? fromMaybe('x') : 'none');
math.twice = (n: number) => n * 3;
console.log('replaced', math.twice(4), twice(4));
function apply(f: (s: string) => string, v: string) { return f(v); }
console.log('passed', apply(math.label, 'y'));
