// console.log prints an array's holes as empty items, runs of them counted together.
const sparse: number[] = [];
sparse[2] = 7;
console.log(sparse, sparse.length);
const names: string[] = ['a'];
names[3] = 'd';
console.log(names);
console.log(new Array(3));
const a: any = [1, 2, 3, 4];
delete a[1];
delete a[2];
console.log(a);
const u: any[] = ['x'];
u.length = 3;
console.log(u);
const tail: any = [1, 2, 3];
delete tail[2];
console.log(tail);
