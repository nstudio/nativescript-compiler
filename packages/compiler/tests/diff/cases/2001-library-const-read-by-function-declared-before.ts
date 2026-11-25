// @lenient-both
// Library mode: a const that a function declared before it reads (a function declaration is hoisted) holds its value
// for every call after the declaration runs.
class Prop {
  localName: string;
  setLocal: (v: string) => string;
  label: Prop;
  constructor(name: string) {
    this.localName = name + '-local';
    function setLocalValue(v: string): string {
      return v + ':' + property.localName + ':' + describe(property) + ':' + (other ? other.localName : 'none');
    }
    function describe(p: Prop): string {
      return p ? p.localName.toUpperCase() : 'missing';
    }
    const property = this;
    const other = name === 'b' ? new Prop('c') : null;
    this.setLocal = setLocalValue;
    this.label = property;
  }
}
const a = new Prop('a');
console.log(a.setLocal('x'), a.label === a);
const b = new Prop('b');
console.log(b.setLocal('y'));
function outer(n: number): number {
  function read(): number {
    return count * 2 + list.length;
  }
  const count = n;
  const list = [n, n];
  return read();
}
console.log(outer(3));
