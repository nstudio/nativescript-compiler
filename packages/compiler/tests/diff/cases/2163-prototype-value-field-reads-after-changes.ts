// @lenient-both
// Fields their class's prototype gives values, read on instances of the class and of a subclass in turn after the
// prototype's value changes, the subclass's prototype gives its own and deletes it, and an instance writes its own.
class Toggle {
  flag: boolean;
  label: string;
}
class Sub extends Toggle {}
function run() {
  Toggle.prototype.flag = true;
  Toggle.prototype.label = 'base';
  const t = new Toggle();
  const u = new Sub();
  const both = [t, u, t, u];
  const read = () => both.map((x) => `${x.flag}/${x.label}`).join();
  console.log('a', read());
  Toggle.prototype.flag = false;
  console.log('b', read());
  Sub.prototype.label = 'sub';
  console.log('c', read());
  delete (Sub.prototype as any).label;
  console.log('d', read());
  u.flag = true;
  Toggle.prototype.label = 'again';
  console.log('e', read());
}
run();
