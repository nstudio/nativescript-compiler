// @app-lenient
// @cli-program
// Typed arrays and an array held in locals that may be null, read and written by index in a timer's callback after a
// sibling test of another such local, inside an async method's loop; and through a field that may be null.
export class Reader {
  private timer: ReturnType<typeof setInterval> | null = null;
  private spare: Uint8Array | null = null;
  async start(onValues: (values: Float32Array, names: string[]) => void): Promise<boolean> {
    for (const wide of [true, false]) {
      const bytes = new ArrayBuffer(16);
      const reals = wide ? new Float32Array(bytes) : null;
      const words = wide ? null : new Int16Array(bytes);
      const names = wide ? null : ['a', 'b', 'c'];
      if (words) {
        for (let n = 0; n < words.length; n++) words[n] = n * 1000 - 3000;
      } else {
        for (let n = 0; n < reals.length; n++) reals[n] = n / 4;
      }
      if (wide) continue;
      this.spare = new Uint8Array(4);
      const out = new Float32Array(8);
      this.timer = setInterval(() => {
        this.stop();
        if (reals) {
          out.set(reals.subarray(0, 4));
        } else {
          for (let n = 0; n < 8; n++) {
            out[n] = words[n] / 32768;
            out[n] += words[n] & 3;
            words[n] = -words[n];
            words[n] |= 1;
            words[n]++;
          }
          names[1] = names[0] + names[2];
          names[2] += '!';
          this.spare[1] = words[3] & 255;
          this.spare[2] += 7;
        }
        onValues(out, names.concat(String(words[0]), String(this.spare[1] + this.spare[2])));
      }, 1);
      return true;
    }
    return false;
  }
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
new Reader().start((values, names) => console.log([...values].map((v) => v.toFixed(4)).join(','), names.join(' ')));
