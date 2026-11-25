// A subclass's array held as its base class's array is the same array.
class Animal {
  name: string;
  constructor(name: string) { this.name = name; }
}
class Dog extends Animal {
  bark(): string { return this.name + ' barks'; }
}
const dogs: Dog[] = [new Dog('rex')];
const animals: Animal[] = dogs;
console.log('same', animals === dogs, animals[0] === dogs[0]);
animals.push(new Dog('fido'));
console.log(dogs.length, dogs[1].bark());
dogs.pop();
console.log(animals.length);
function count(list: Animal[]): number { list.push(new Dog('max')); return list.length; }
console.log(count(dogs), dogs.length, dogs[1].bark());
