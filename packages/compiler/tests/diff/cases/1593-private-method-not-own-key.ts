// A private method is no property: the string "#m" names neither an own property nor an inherited one.
class C {
  #m() {
    return 'private';
  }
  check(): void {
    console.log(this.hasOwnProperty('#m'), '#m' in this, this.#m());
  }
}
new C().check();
const o: any = new C();
console.log(Object.keys(o).length, o.hasOwnProperty('#m'), '#m' in o);
