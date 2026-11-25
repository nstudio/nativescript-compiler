// A function's length and name: parameters before the first default or rest, and the name it is declared or bound with.
function f(...args: any[]) {
  return args;
}
function alias(x?: any) {
  return x;
}
console.log('f.length', ((a: any, b: any = 1, ...c: any[]) => 0).length, f.length, alias.length, f.name, (() => 0).name);
