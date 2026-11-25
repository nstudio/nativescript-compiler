// What an untyped alias of a typed array reports and prints is the array's: Array.isArray, keys, JSON, console.log,
// and a named property written through one alias read through another.
const nums = [1, 2];
const loose: any[] = nums;
console.log(Array.isArray(loose), Object.keys(loose).join(','), JSON.stringify(loose));
console.log(loose);
const anyNums: any = nums;
(loose as any).tag = 'x';
console.log(anyNums.tag, Object.keys(anyNums).join(','));
console.log(String(loose), `${loose}`, loose.toString());
const sparse: number[] = [];
sparse[2] = 7;
const ls: any[] = sparse;
console.log(ls.length, 0 in ls, 2 in ls, ls[0]);
ls.push(8);
console.log(sparse.length, sparse[3], 1 in sparse);
