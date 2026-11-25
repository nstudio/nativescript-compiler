// `Object.assign({}, array)` copies the array's elements as index keys "0", "1", … into a plain object.
const c: any = Object.assign({}, [10, 20, 30]);
console.log(JSON.stringify(c), Object.keys(c).join(), c[1], c.length, Array.isArray(c));
const names = ['ada', 'grace'];
const byIndex = Object.assign({ first: true }, names);
console.log(byIndex[0], byIndex['1'], Object.keys(byIndex).length, JSON.stringify(byIndex));
const show = (o: any) => console.log(JSON.stringify(o), 'length' in o);
show(Object.assign({}, [undefined, 'x']));
