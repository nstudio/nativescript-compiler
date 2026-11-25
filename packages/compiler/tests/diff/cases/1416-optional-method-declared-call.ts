// A method declared optional on the static type and not defined there (an abstract base's `m?(): void;`, an interface
// merged into the class), called on a value of that type: the method of the object's own class where it has one;
// with `?.()` undefined where not.
abstract class Driver<D = unknown> {
  constructor(public name: string) {}
  update?(data: D): string;
  register?(callback: (data: D) => void): void;
  stop?(): void;
  abstract start(): string;
}
interface Driver<D> {
  pause?(reason: string): string;
}
class PlainDriver extends Driver<string> {
  start(): string {
    return `${this.name} started`;
  }
}
class FullDriver extends Driver<string> {
  log: string[] = [];
  start(): string {
    return `${this.name} started`;
  }
  update(data: string): string {
    this.log.push(`update ${data}`);
    return `${this.name} updated`;
  }
  register(callback: (data: string) => void): void {
    callback(`${this.name} registered`);
  }
  stop(): void {
    this.log.push('stop');
  }
  pause(reason: string): string {
    return `${this.name} paused: ${reason}`;
  }
}

class Host {
  driver: Driver<string>;
  constructor(driver: Driver<string>) {
    this.driver = driver;
  }
  run(): string[] {
    const out = [this.driver.start(), String(this.driver.update?.('one')), String(this.driver?.pause?.('tick')), typeof this.driver.stop];
    this.driver.stop?.();
    if (this.driver.register) this.driver.register((data) => out.push(data));
    return out;
  }
}

console.log(new Host(new PlainDriver('plain')).run().join(' | '));
const full = new FullDriver('full');
console.log(new Host(full).run().join(' | '), full.log.join(','));
