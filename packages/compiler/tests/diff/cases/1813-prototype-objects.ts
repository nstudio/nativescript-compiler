// `Object.prototype` is an object in an app's code too: its methods read off it and called with a receiver.
const has = Object.prototype.hasOwnProperty;
const toText = Object.prototype.toString;
const config: { [k: string]: number } = { size: 2 };
console.log(has.call(config, 'size'), has.call(config, 'missing'), toText.call([]), toText.call(config));
console.log(Object.prototype.hasOwnProperty.call({ a: 1 }, 'a'), typeof Object.prototype.toString);
