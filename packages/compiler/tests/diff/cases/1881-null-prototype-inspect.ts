// console.log prints an object without a prototype with Node's null-prototype tag.
const bare: any = Object.create(null);
console.log(bare);
bare.k = 1;
console.log(bare);
