// @swift ledger:nativeSdk
// A value held untyped, read or written where a native protocol is the type (a transition's delegate returned from a
// field read by name, an object's protocol-typed key set by name): the object itself, as script holds it.
@NativeClass
class Evictions extends NSObject implements NSCacheDelegate {
  static ObjCProtocols = [NSCacheDelegate];
  label!: string;
}

class Owner {
  [key: string]: unknown;
  get delegate(): NSCacheDelegate {
    return this['held'] as NSCacheDelegate;
  }
}

const first = Evictions.new() as Evictions;
first.label = 'first';
const owner = new Owner();
owner['held'] = first;
console.log('held', owner.delegate === first, (owner.delegate as Evictions).label);

const slot = { delegate: owner.delegate };
const second = Evictions.new() as Evictions;
second.label = 'second';
const key: string = ['dele', 'gate'].join('');
(slot as any)[key] = second;
console.log('set', slot.delegate === second, (slot.delegate as Evictions).label);
