// A `declare class` with no runtime existence typing instances of a class that matches it by shape: a field, a
// parameter, a variable and a cast typed by it hold the subclass's instance, its own members read and written by name.
class Base {
  label = 'base';
  describe() {
    return `[${this.label}]`;
  }
}

declare class IHolder extends Base {
  owner: Owner;
  pinned: boolean;
}

class Holder extends Base {
  pinned = false;
  constructor(public owner: Owner) {
    super();
  }
}

class Owner {
  holder?: IHolder;
  stored: unknown;
  constructor(public name: string) {}
}

function pin(holder: IHolder, pinned: boolean): string {
  holder.pinned = pinned;
  holder.label = pinned ? 'pinned' : 'loose';
  return `${holder.owner.name} ${holder.describe()}`;
}

const owner = new Owner('first');
let holder: IHolder | undefined = owner.holder;
console.log('empty', holder === undefined);
if (!holder) {
  holder = new Holder(owner);
  owner.holder = holder;
}
console.log(pin(owner.holder!, true), owner.holder!.pinned, holder instanceof Holder, holder.label);
owner.stored = holder;
const back = owner.stored as IHolder;
console.log(back === holder, pin(back, false), back.pinned, back.describe());
