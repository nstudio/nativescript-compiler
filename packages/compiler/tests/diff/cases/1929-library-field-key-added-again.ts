// @lenient-both
// Library mode: a key script adds, deletes and adds again goes last again, after the fields made since.
class Note {
  text: string;
  tag: string;
  kind = 'n';
}
const n = new Note();
const any: any = n;
n.text = 't';
any.extra = 1;
n.tag = 'x';
console.log(Object.keys(n).join());
delete any.extra;
console.log(Object.keys(n).join(), 'extra' in n);
any.extra = 2;
console.log(Object.keys(n).join(), JSON.stringify(n));
