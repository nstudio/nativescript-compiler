// @lenient-both
// Library mode: a subclass's field with a value that its base's constructor already made a key keeps that key's place;
// assigning it at the subclass's level of the constructor makes no new key.
class Base {
  shared: number;
  constructor() {
    this.start();
  }
  start() {
    this.shared = 1;
    (this as any).extra = 'x';
  }
}
class Middle extends Base {
  shared = 2;
  middle = 'm';
}
const m = new Middle();
console.log(Object.keys(m).join(), JSON.stringify(m));
