// @app-lenient
// A plain class's fields that hold null as well as undefined: a field declared without a value reads
// undefined, one given null reads null, and each reads the state it was last given.
class Timer {
  label: string = null;
  id: number;
  done: boolean;
  owner: { name: string } = null;
  start(n: number): void { this.id = n; this.label = 'run'; this.done = false; this.owner = { name: 'a' }; }
  stop(): void { this.id = null; this.label = undefined; this.done = null; this.owner = undefined; }
  show(): string {
    return `${typeof this.label} ${typeof this.id} ${typeof this.done} ${String(this.id)} ${JSON.stringify([this.label, this.id, this.done, this.owner])} ${this.id == null} ${this.id === undefined} ${this.label === null}`;
  }
}

const t = new Timer();
console.log(t.show());
t.start(3);
console.log(t.show());
t.stop();
console.log(t.show());
