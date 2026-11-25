// An array that may be absent, held as an array of another element type, is the one array or the same absence.
class Animal {
  constructor(public name: string) {}
}
class Dog extends Animal {}
function run(flag: boolean) {
  const cube: number[][][] = [[[1, 2], [3]]];
  const first = cube[0];
  const front: any[][] = first;
  front[0].push(9);
  console.log(front === cube[0], JSON.stringify(cube));
  const maybe: number[] | undefined = flag ? [1] : undefined;
  const looseMaybe: any[] | undefined = maybe;
  looseMaybe?.push('x');
  console.log(looseMaybe === maybe, maybe?.length);
  const dogs: Dog[] | null = flag ? [new Dog('rex')] : null;
  const animals: Animal[] | null = dogs;
  console.log(animals === dogs, animals ? animals[0].name : 'none');
  const rows: number[][] | undefined = flag ? [[1]] : undefined;
  const looseRows: any[][] | undefined = rows;
  console.log(looseRows === rows, looseRows?.[0]?.[0]);
}
run(true);
run(false);
const top: number[][][] = [[[7]]];
const topFirst = top[0];
const topFront: any[][] = topFirst;
topFront[0].push(8);
console.log(topFront === top[0], JSON.stringify(top));
