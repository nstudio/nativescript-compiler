// Function literals taking a rest parameter, held untyped and called: the arguments from the rest's position on are its
// array, however many there are.
const rest: any = (...xs: any[]) => xs;
console.log(rest('a'), rest(), rest(1, [2], { c: 3 }).length);
const lead: any = (a: string, ...more: number[]) => `${a}:${more.length}:${more.join('+')}`;
console.log(lead('p'), lead('p', 1, 2, 3), lead.length, rest.length);
const fx: any = function (first: number, ...others: unknown[]) {
	return first + others.length;
};
console.log(fx(10, 'a', 'b'), fx(1));
const counted: any = (...all: unknown[]): void => {
	console.log('count', all.length);
};
counted(1, 2);
console.log(typeof counted(), [1, 2].map(rest).map((r: any) => r.length).join());
