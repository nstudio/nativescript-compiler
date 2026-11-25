// @app-lenient
// @swift ledger:nativeSdk
// A key a native class doesn't declare, read and written by a literal key on its own objects and through a field typed
// as NSObject: the object keeps it, undefined until written, then the value, then null.
class Player {
  name = 'player';
  ready = false;
  observer: NSObject;
  attach(): void {
    this.observer = Observer.new();
    console.log('unset', (this.observer as Observer).owned(), this.observer['owner'] === undefined);
    this.observer['owner'] = this;
  }
  detach(): void {
    this.observer['owner'] = null;
  }
}

@NativeClass
class Observer extends NSObject {
  owned(): string {
    if (this['owner'] && this['owner'].name === 'player' && !this['owner'].ready) this['owner'].ready = true;
    return this['owner'] ? this['owner'].name : this['owner'] === null ? 'null' : 'undefined';
  }
}

const p = new Player();
p.attach();
console.log('set', (p.observer as Observer).owned(), p.ready, p.observer['owner'] === p);
p.detach();
console.log('cleared', (p.observer as Observer).owned(), p.observer['owner'] === null, p.observer['owner'] === undefined);
