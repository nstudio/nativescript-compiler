// @app-lenient
// A typed array's element, written and read through a field and an index Kotlin holds nullable: a callback's index
// passed on, compound and update assignments, and every element kind.
class Counts {
  private bytes: Uint8Array;
  private words: Int16Array;
  private reals: Float64Array;
  private readonly size: number;
  private readonly squares: Float32Array;
  constructor(names: string[]) {
    this.size = names.length;
    this.squares = new Float32Array(this.size);
    for (let n = 0; n < this.size; n++) this.squares[n] = n * n;
    this.bytes = new Uint8Array(names.length);
    this.words = new Int16Array(names.length);
    this.reals = new Float64Array(names.length);
    names.forEach((name, index) => this.learn(name, index));
    let none: number;
    if (names.length > 9) this.learn('', none);
  }
  private learn(name: string, index: number): void {
    this.bytes[index] = new Set(name.split('')).size;
    this.words[index] = -name.length * 1000;
    this.reals[index] = name.length / 3;
    this.bytes[index] += 250;
    this.words[index]++;
    this.reals[index] *= 2;
    this.bytes[index + 0] -= this.words[index] & 7;
  }
  report(): string {
    return [...this.bytes].join(',') + ' ' + [...this.words].join(',') + ' ' + [...this.reals].map((r) => r.toFixed(3)).join(',');
  }
}
console.log(new Counts(['ab', 'abc', 'aaaa', '']).report());
