// A value `Object.defineProperty(this, …)` or `Object.defineProperties(this, …)` gives under a method's name is the
// object's own: calls on that object read it, other objects of the class keep the method.
class Query {
  _matches = false;
  open(media: string) {
    Object.defineProperties(this, { _illegal: { value: null }, describe: { value: () => `own ${media}`, writable: true } });
    Object.defineProperty(this, 'size', { value: (n: number) => n * 10 });
  }
  get matches(): boolean {
    this._illegal?.();
    return this._matches;
  }
  _illegal() {
    throw new TypeError('Illegal invocation');
  }
  describe(): string {
    return 'class';
  }
  size(n: number): number {
    return n;
  }
}
const q = new Query();
q.open('print');
console.log(q.matches, q.describe(), q.size(4));
const plain = new Query();
try {
  console.log(plain.matches);
} catch (e) {
  console.log((e as Error).message);
}
console.log(plain.describe(), plain.size(4));
