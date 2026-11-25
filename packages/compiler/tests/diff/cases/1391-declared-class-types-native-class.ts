// @swift ledger:nativeSdk
// A `declare class` with no runtime existence typing an instance of a native class that matches it by shape, as a
// plugin's controllers do (`declare class IController extends UIViewController` for its `@NativeClass` subclass):
// fields, parameters and casts typed by it hold the native class's instance.
declare class IHolderImpl extends NSObject {
  static new(): IHolderImpl;
  owner: WeakRef<Owner>;
  pinned: boolean;
}

@NativeClass
class HolderImpl extends NSObject {
  owner!: WeakRef<Owner>;
  pinned!: boolean;
  static initWithOwner(owner: Owner) {
    const holder = HolderImpl.new() as HolderImpl;
    holder.owner = new WeakRef(owner);
    return holder;
  }
  describe() {
    return `${this.owner.deref()?.name ?? 'gone'}${this.pinned ? ' pinned' : ''}`;
  }
}

class Owner {
  holder!: IHolderImpl;
  stored: unknown;
  constructor(public name: string) {}
}

function pin(holder: IHolderImpl, pinned: boolean): string {
  holder.pinned = pinned;
  return holder.owner.deref()?.name ?? 'none';
}

const owner = new Owner('first');
let holder: IHolderImpl = owner.holder;
console.log('empty', holder === undefined);
if (!holder) {
  holder = HolderImpl.initWithOwner(owner);
  owner.holder = holder;
}
console.log(pin(owner.holder, true), owner.holder.pinned, holder instanceof HolderImpl, (holder as unknown as HolderImpl).describe());
owner.stored = holder;
const back = owner.stored as IHolderImpl;
console.log(back === holder, pin(back, false), back.pinned);
