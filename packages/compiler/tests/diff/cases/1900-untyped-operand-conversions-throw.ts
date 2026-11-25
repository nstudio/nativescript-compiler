// An operand held untyped: what its conversion throws (a BigInt beside a number, its own toPrimitive, valueOf or toString)
// is thrown at the operator, and caught.
function attempt(name: string, run: () => unknown) {
  try {
    console.log(name, run());
  } catch (e) {
    console.log(name, (e as Error).constructor.name, (e as Error).message);
  }
}
const big: any = 5n;
const num: any = 2;
const poisoned: any = {
  valueOf() {
    throw new RangeError('valueOf');
  },
  toString() {
    throw new RangeError('toString');
  },
};
const hinted: any = { [Symbol.toPrimitive]: (hint: string) => (hint === 'number' ? 7 : `<${hint}>`) };
attempt('big + num', () => big + num);
attempt('big + big', () => big + big);
attempt('big - num', () => big - num);
attempt('num * big', () => num * big);
attempt('big / 2', () => big / 2);
attempt('big % num', () => big % num);
attempt('num ** big', () => num ** big);
attempt('big | num', () => big | num);
attempt('num << big', () => num << big);
attempt('big >>> num', () => big >>> num);
attempt('+big', () => +big);
attempt('poisoned + 1', () => poisoned + 1);
attempt('poisoned * 2', () => poisoned * 2);
attempt('"a" + poisoned', () => 'a' + poisoned);
attempt('`${poisoned}`', () => `${poisoned}`);
attempt('+poisoned', () => +poisoned);
attempt('hinted', () => [hinted + 1, hinted * 2, `${hinted}`, 'p' + hinted, +hinted, -hinted, ~hinted, hinted - num].join(' '));
let acc: any = 1;
let n = 3;
let s = 's';
const o: any = { x: 1 };
const steps: [string, () => void][] = [
  ['acc += big', () => { acc += big; }],
  ['acc -= num', () => { acc -= num; }],
  ['acc *= big', () => { acc *= big; }],
  ['n -= big', () => { n -= big; }],
  ['n += big', () => { n += big; }],
  ['n += poisoned', () => { n += poisoned; }],
  ['n *= num', () => { n *= num; }],
  ['s += poisoned', () => { s += poisoned; }],
  ['s += hinted', () => { s += hinted; }],
  ['o.x -= big', () => { o.x -= big; }],
  ['o.x += big', () => { o.x += big; }],
  ['o.x |= num', () => { o.x |= num; }],
];
for (const [name, step] of steps) attempt(name, () => (step(), 'ok'));
console.log('after', acc, n, s, o.x);
