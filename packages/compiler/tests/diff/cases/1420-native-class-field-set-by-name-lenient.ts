// @lenient
// @swift ledger:nativeSdk
// A native subclass's own fields written by name from untyped code, as a plugin's delegate keeps its sub-delegates:
// an array, a number and an object field each take the value written and read it back.
@NativeClass
class Relay extends NSObject {
  subDelegates: Array<any>;
  count: number;
  label: string;
  static make(): Relay {
    const r = Relay.new() as Relay;
    r.subDelegates = [];
    r.count = 0;
    r.label = 'start';
    return r;
  }
}

const relay = Relay.make();
const untyped: any = relay;
untyped.subDelegates = ['a', 'b'];
untyped.count = 3;
untyped.label = 'next';
console.log(relay.subDelegates.length, relay.count, relay.label);
untyped.subDelegates = [1];
console.log(relay.subDelegates.length, relay.subDelegates[0]);
