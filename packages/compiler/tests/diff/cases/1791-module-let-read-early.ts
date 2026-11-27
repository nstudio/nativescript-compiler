// A module's `let` read before its declaration runs is a ReferenceError naming it on both backends.
class Box {
  value: string;
  constructor(value: string) {
    this.value = value;
  }
}
function early(): string {
  try {
    return later.value;
  } catch (e) {
    return (e as Error).name + ': ' + (e as Error).message;
  }
}
console.log(early());
let later = new Box('set');
console.log(early());
