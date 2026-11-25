// @lenient
// @swift ledger:nativeSdk
// A native object's members written and read by a literal key, as plugins do (`controller.view['elevation'] = 0`): one its
// type does not declare is the object's own property, and one a `declare class` adds to the native class it extends is
// the subclass's field.
declare class ISheetHolder extends NSObject {
  static new(): ISheetHolder;
  animated: boolean;
}

@NativeClass
class SheetHolder extends NSObject {
  animated: boolean;
  static make() {
    return SheetHolder.new() as SheetHolder;
  }
}

class Host {
  holder: any;
  show() {
    let holder: ISheetHolder = this.holder;
    if (!holder) {
      holder = SheetHolder.make();
      this.holder = holder;
    }
    holder.animated = true;
    holder['animated'] = false;
    holder['elevation'] = 0;
    console.log(holder.animated, holder['animated'], holder['elevation']);
    const plain = NSObject.new();
    plain['tag'] = 'kept';
    console.log(plain['tag'], plain['missing']);
  }
}
new Host().show();
