// An object literal's own `[Symbol.toStringTag]` names it in Object.prototype.toString and String(), and its own
// `[Symbol.toPrimitive]` converts it, typed or held untyped; a tag that is no string is ignored.
const typed = { [Symbol.toStringTag]: 'Typed', n: 1 };
console.log(String(typed), Object.prototype.toString.call(typed), `${typed}`, typed + '!');
const untyped: any = { [Symbol.toStringTag]: 'Untyped', a: 1 };
console.log(String(untyped), Object.prototype.toString.call(untyped), `${untyped}`);
const numbered: any = { [Symbol.toStringTag]: 7 };
console.log(String(numbered), Object.prototype.toString.call(numbered));
const withToString: any = { [Symbol.toStringTag]: 'T', toString() { return 'own'; } };
console.log(String(withToString), Object.prototype.toString.call(withToString));
class Tagged {
  get [Symbol.toStringTag]() {
    return 'Getter';
  }
}
console.log(String(new Tagged()), Object.prototype.toString.call(new Tagged()));
const prim: any = { [Symbol.toPrimitive]: (hint: string) => (hint === 'number' ? 42 : hint) };
console.log(+prim, `${prim}`, prim + '', prim * 2, String(prim));
