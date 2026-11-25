// @kotlin ledger:failedUnwrapThrows
// A module's `let` read before its declaration runs is a ReferenceError naming it; Kotlin finds the name in the failed lateinit read's message, pinned here.
// Swift's platform limit: the global is implicitly unwrapped and an early read traps uncatchably; a ReferenceError needs every read checked and throwing.
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
