// A set on an object runs a setter its prototype chain holds, with the object as `this`, and makes no own property; an
// inherited getter without a setter refuses the set.
const log: string[] = [];
const store = new Map<unknown, unknown>();
const proto: any = {
  set v(x: any) { log.push('set'); store.set(this, x); },
  get v() { return store.get(this); },
};
const o: any = Object.create(proto);
o.v = 5;
console.log(log.join(','), o.v, Object.keys(o).length, Object.prototype.hasOwnProperty.call(o, 'v'), store.get(proto));
const grand: any = Object.create(o);
grand.v = 6;
console.log(log.join(','), grand.v, o.v, Object.keys(grand).length);
const getterOnly: any = Object.create({ get r() { return 1; } });
try { getterOnly.r = 2; console.log('no throw', getterOnly.r); } catch (e) { console.log((e as Error).constructor.name, (e as Error).message); }
const k = 'v';
const viaKey: any = Object.create(proto);
viaKey[k] = 7;
console.log(viaKey.v, Object.keys(viaKey).length, store.size);
