// A class's static field keyed by a module's symbol, read and written through `this` in its static accessor and
// methods: missing until set, then the value set.
const handle_ = Symbol('[[handle]]');

class Connection {
  constructor(public key: string) {}
}

class Client {
  private static [handle_]: Connection;
  private static get handle(): Connection {
    if (!this[handle_]) throw new Error('not initialized');
    return this[handle_];
  }
  static initialize(key: string): void {
    this[handle_] = new Connection(key);
  }
  static describe(): string {
    try { return this.handle.key; } catch (e) { return (e as Error).message; }
  }
}

console.log(Client.describe());
Client.initialize('k1');
console.log(Client.describe());
