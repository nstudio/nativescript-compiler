// An array of a subclass's objects given to a function taking the base class's array is the same array.
abstract class Control {
  constructor(public name: string) {}
  abstract sync(): string;
}

class Model extends Control {
  pending = true;
  sync(): string {
    this.pending = false;
    return `${this.name}!`;
  }
}

class Named extends Control {
  sync(): string {
    return this.name.toUpperCase();
  }
}

function syncAll(controls: Control[]): string {
  const out: string[] = [];
  controls.forEach((c: Control) => out.push(c.sync()));
  for (const c of controls) out.push(c.name);
  if (controls.length > 1) out.push(controls[1].name, String(controls.some((c) => c instanceof Model)));
  return out.join(',');
}

function first(controls: Control[]): Control | undefined {
  return controls.find((c) => c.name.length > 0);
}

function same(controls: Control[], other: unknown): boolean {
  return controls === other && other === controls;
}

class Form {
  private readonly models: Model[] = [];
  readonly named: Named[] = [];
  add(m: Model): void {
    this.models.push(m);
  }
  submit(): string {
    return syncAll(this.models);
  }
  pending(): number {
    return this.models.filter((m) => m.pending).length;
  }
  track(): boolean {
    return same(this.models, this.models) && !same(this.models, this.named);
  }
}

const plain: Control[] = [new Named('z')];
const form = new Form();
form.add(new Model('a'));
form.add(new Model('b'));
console.log(form.submit(), form.pending());
form.named.push(new Named('x'), new Named('y'));
console.log(syncAll(form.named), first(form.named) === form.named[0]);
console.log(form.track(), same(form.named, form.named), same(plain, plain), same(plain, [...plain]));
console.log(syncAll(plain), first(plain) === plain[0]);
