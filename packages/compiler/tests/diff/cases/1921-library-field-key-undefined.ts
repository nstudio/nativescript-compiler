// @lenient-both
// Library mode: writing undefined to a field declared without a value makes its key all the same; reading one never
// written by key is undefined.
class Box {
  value: number;
  text: string;
  owner: Box;
  constructor(public id: number) {}
}
const b = new Box(1);
const any: any = b;
console.log(Object.keys(b).join(), any['value'], any['text'], 'owner' in b);
b.owner = undefined;
b.text = 't';
console.log(Object.keys(b).join(), 'owner' in b, b.hasOwnProperty('text'), JSON.stringify(b));
