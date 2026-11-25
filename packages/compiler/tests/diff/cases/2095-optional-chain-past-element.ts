// An optional chain going on past a link that may be missing (`a?.[0].name`, `b?.dog!.name`): undefined where the
// chain stops, else read on, a TypeError where that link is missing.
class Dog {
	constructor(public name: string) {}
	speak(): string {
		return this.name + ' barks';
	}
}
class Kennel {
	dogs: Dog[] = [new Dog('Fido')];
	keeper?: Dog;
}
function first(a: Dog[] | null): string | undefined {
	return a?.[0].name;
}
function speakAt(a: Dog[] | undefined, i: number): string | undefined {
	return a?.[i].speak();
}
function nameLength(a: Dog[] | null): number | undefined {
	return a?.[0].name.length;
}
function kennelFirst(k: Kennel | null): string | undefined {
	return k?.dogs[0].name;
}
function grid(g: number[][] | null): number | undefined {
	return g?.[1][0];
}
function keeper(k: Kennel | null): string | undefined {
	return k?.keeper!.name;
}
function firstOrNot(a: Dog[] | null): string | undefined {
	return a?.[0]?.name;
}
function dogNameLength(d: Dog | null): number | undefined {
	return d?.name.length;
}
const withKeeper = new Kennel();
withKeeper.keeper = new Dog('Ann');
console.log(first(null), first([new Dog('Rex')]));
console.log(speakAt(undefined, 0), speakAt([new Dog('A'), new Dog('B')], 1));
console.log(nameLength(null), nameLength([new Dog('Spot')]));
console.log(kennelFirst(null), kennelFirst(new Kennel()));
console.log(grid(null), grid([[1], [2, 3]]));
console.log(keeper(null), keeper(withKeeper));
console.log(firstOrNot(null), firstOrNot([]), firstOrNot([new Dog('Max')]));
console.log(dogNameLength(null), dogNameLength(new Dog('Rex')));
const empty = new Kennel();
empty.dogs = [];
for (const f of [() => first([]), () => speakAt([], 2), () => nameLength([]), () => kennelFirst(empty), () => grid([[1]]), () => keeper(new Kennel())]) {
	try {
		console.log(f());
	} catch (e) {
		console.log((e as Error).name, (e as Error).message);
	}
}
