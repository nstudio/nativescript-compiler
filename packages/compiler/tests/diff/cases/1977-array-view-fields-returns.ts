// A subclass array stored in a base-class array field, returned as one, and given back: one array throughout.
class Animal {
  constructor(public name: string) {}
}
class Cat extends Animal {
  meow(): string { return this.name + ' meows'; }
}
class Shelter {
  animals: Animal[] = [];
  admit(list: Animal[]): Animal[] {
    this.animals = list;
    list.push(new Cat('tom'));
    return list;
  }
}
const cats: Cat[] = [new Cat('kit')];
const shelter = new Shelter();
const back = shelter.admit(cats);
console.log(back === cats, shelter.animals === cats, cats.length, cats[1].meow());
shelter.animals.pop();
console.log(cats.length, back.length);
function grids(): any[][] {
  const g: number[][] = [[1, 2]];
  const loose: any[][] = g;
  loose[0].push(3);
  return g;
}
console.log(JSON.stringify(grids()));
