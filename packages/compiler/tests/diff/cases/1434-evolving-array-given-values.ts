// An untyped `[]` whose only stated alias is `T[]` takes values of other declared shapes as `T`s, in place or pushed.
interface Size {
  width: number;
  height: number;
}

const s = { width: 2, height: 3 };
const sizes = [];
sizes.push({ width: 1, height: 1 });
sizes.splice(0, 1, s);
sizes.push(s);
const flag = sizes.length > 1;
sizes.splice(1, 1, flag ? s : { width: 4, height: 4 });
sizes.push(...[s, { width: 6, height: 7 }]);
const typed: Size[] = flag ? sizes : [];
console.log(typed === sizes, typed.length, typed[3].height, typed[1].width);

const slots = [];
slots[0] = s;
slots[2] = flag ? s : { width: 4, height: 4 };
const held: (Size | undefined)[] = slots;
console.log(held === slots, slots.length, slots[1] === undefined, slots[5] === undefined, held[2] === s);
