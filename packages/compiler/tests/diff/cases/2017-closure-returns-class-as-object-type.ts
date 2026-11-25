// A closure returning a class instance where a function returning an object type is expected: the instance, its
// methods and fields read through that type.
class Wrap {
  readonly mode: string;
  constructor(mode = 'wrap') {
    this.mode = mode;
  }
  describe(): string {
    return `wrap:${this.mode}`;
  }
}
class Grow {
  grow: number;
  constructor(grow: number) {
    this.grow = grow;
  }
  describe(): string {
    return `grow:${this.grow}`;
  }
}
function build(make: () => { describe(): string }): string {
  return make().describe();
}
console.log(build(() => new Wrap()), build(() => new Grow(2)));
const made = [1, 3].map((n) => build(() => new Grow(n)));
console.log(made.join());
function keep(make: () => { mode: string; describe(): string }): { mode: string; describe(): string } {
  return make();
}
const kept = keep(() => new Wrap('nowrap'));
console.log(kept.mode, kept.describe(), kept instanceof Wrap);
