// @lenient-both
// Library mode: a field declared without a value that the class's prototype gives a value reads that value until the
// object has its own, which its first write makes a key.
class Toggle {
  flag: boolean;
  label: string;
  size = 1;
}
Toggle.prototype.flag = true;
const t = new Toggle();
const any: any = t;
console.log(Object.keys(t).join(), t.flag, any['flag'], t.hasOwnProperty('flag'), 'flag' in t);
t.label = 'l';
t.flag = false;
console.log(Object.keys(t).join(), t.flag, any['flag'], t.hasOwnProperty('flag'), JSON.stringify(t));
console.log(new Toggle().flag, Object.keys(new Toggle()).join());
