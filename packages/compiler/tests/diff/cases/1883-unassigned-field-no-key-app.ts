// @assign-fields
// Class fields assigned in the constructor (an app below ES2022): a field declared without a value is no own key of
// the instance until the program assigns it, and keys then list in assignment order.
class Item {
  label!: string;
  count!: number;
  tags!: string[];
  owner: Item | undefined;
  flag!: boolean;
  name = 'n';
}
const c = new Item();
console.log(Object.keys(c).join(), 'label' in c, c.hasOwnProperty('label'), JSON.stringify(c));
c.flag = false;
c.count = 2;
c.label = 'x';
console.log(Object.keys(c).join(), 'label' in c, c.hasOwnProperty('label'), JSON.stringify(c));
c.owner = undefined;
console.log(Object.keys(c).join(), 'owner' in c, 'tags' in c);
