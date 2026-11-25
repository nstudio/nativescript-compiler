// A typed array held untyped is one object however many times it crosses: `===` between its untyped aliases, Map and Set
// keys, WeakMap keys, indexOf and Object.is all see one array.
const nums = [1, 2];
const a1: any[] = nums;
const a2: any[] = nums;
console.log(a1 === a2, Object.is(a1, nums), Object.is(a2, a1));
const m = new Map<any, string>();
m.set(nums, 'typed');
console.log(m.get(a1), m.has(a2));
m.set(a1, 'untyped');
console.log(m.size, m.get(nums));
const s = new Set<any>([nums, a1, a2]);
console.log(s.size);
const w = new WeakMap<object, number>();
w.set(a1, 1);
console.log(w.get(nums), w.has(a2));
const list: any[] = [a1];
console.log(list.indexOf(nums), list.includes(a2));
const typedList: number[][] = [nums];
console.log(typedList.indexOf(a1), typedList.includes(a2));
const viaAny: any = nums;
const again: any[] = viaAny;
console.log(again === a1, again === nums);
