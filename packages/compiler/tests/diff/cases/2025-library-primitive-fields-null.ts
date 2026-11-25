// @lenient-both
// Library mode: a string, number or boolean field initialized to null or written null holds null, as Node holds it;
// every other one holds its value.
class Config {
  static label: string = null;
  static count: number = null;
  static flag: boolean = null;
  static plain: string = 'p';
  name: string = null;
  size: number = null;
  on: boolean = null;
  title = 'x';
  width = 2;
  clear(): void {
    this.title = null;
  }
}
function show(c: Config): string {
  return [c.name, c.name === null, typeof c.name, c.name + '!', c.size + 1, c.size === null, c.on ? 'y' : 'n', c.on === null, c.title, c.title === null, String(c.title), c.width * 2, JSON.stringify({ n: c.name, s: c.size, o: c.on, t: c.title })].join('|');
}
console.log(Config.label, Config.count, Config.flag, Config.plain);
console.log(Config.label === null, Config.count === null, Config.flag === null, typeof Config.label, `${Config.label}`, Config.count * 3);
const c = new Config();
console.log(show(c));
c.name = 'n';
c.size = 4;
c.on = true;
console.log(show(c));
c.clear();
c.name = null;
console.log(show(c));
Config.label = 'L';
Config.count = 7;
console.log(Config.label, Config.count, Config.label.length);
Config.label = null;
console.log(Config.label, Config.label == undefined, Config.label || 'fallback');
