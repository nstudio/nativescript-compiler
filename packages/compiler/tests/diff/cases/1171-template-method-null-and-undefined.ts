// A component's method telling null from undefined in an array parameter, called as its template's bindings call it
// (`$bN()` reading `this`): null, undefined, an array, a field holding null and an optional chain's missing member.
// Strict: a non-strict app is translated from its program checked strictly, which `@app-lenient` does not do.
interface Person {
  name: string;
  tags: string[];
}
class Kinds {
  xs: string[] = ['a', 'b'];
  none: string[] | null = null;
  person: Person | null = null;
  kind(list: string[] | undefined | null): string {
    return list === null ? 'null' : list === undefined ? 'undefined' : 'list ' + list.length + ' ' + list.join(',');
  }
  $b0() {
    return this.kind(null);
  }
  $b1() {
    return this.kind(undefined);
  }
  $b2() {
    return this.kind(this.xs);
  }
  $b3() {
    return this.kind(this.none);
  }
  $b4() {
    return this.kind(this.person?.tags);
  }
}
const k = new Kinds();
console.log(k.$b0(), k.$b1(), k.$b2(), k.$b3(), k.$b4());
k.person = { name: 'p', tags: ['x'] };
console.log(k.$b4(), k.kind(null), k.kind(undefined));
