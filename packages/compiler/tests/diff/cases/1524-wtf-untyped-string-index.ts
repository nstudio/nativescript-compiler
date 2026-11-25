// A string held untyped read at an index, past its ends and through at() and charAt().
const prod: any = 'production';
console.log('"str"[1]', prod[1], prod[-1], prod.at(-1), prod.charAt(99));
