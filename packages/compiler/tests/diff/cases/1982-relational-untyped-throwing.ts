// A relational operator converts its operands as script does: an object's own valueOf that throws reaches the `catch`,
// the left operand converts before the right whichever operator it is, and BigInts compare with numbers and strings by
// their values.
const big: any = 5n;
const small: any = 2n;
const num: any = 3;
const str: any = '10';
const bad: any = { valueOf() { throw new Error('no value'); } };
console.log(big < num, big > num, num <= big, big >= 5, str < num, str > 9, '9' < str);
console.log(big > 4.5, small < big, small >= 2, big <= '5', big < 'x', num >= big);
try { console.log(bad < num); } catch (e) { console.log('bad', (e as Error).message); }
try { console.log(num > bad); } catch (e) { console.log('bad right', (e as Error).message); }
const order: string[] = [];
const first: any = { valueOf() { order.push('first'); return 1; } };
const second: any = { valueOf() { order.push('second'); return 2; } };
console.log(first > second, first <= second, second >= first, second < first, order.join(' '));
function below(a: any, b: any): boolean {
	return a < b;
}
try { console.log(below(1, 2), below('b', 'a'), below(bad, 1)); } catch (e) { console.log('below', (e as Error).message); }
const values: any[] = [3n, 1, 2n, 0.5];
console.log(values.filter((v) => v > 1).length, values.filter((v) => v <= 1).length);
