// An object literal whose keys are an event's fields (`value`, `object`, `eventName`) is its own object, not an event's data.
const a = { value: 1 as number | undefined };
console.log(a.value, JSON.stringify(a));
const b = { value: undefined as number | undefined };
b.value = 3;
console.log(b.value);
const c = { object: 'x', eventName: 'tap' };
console.log(c.object, c.eventName, Object.keys(c).join());
