// @lenient-both
// Library mode: a string, number or boolean static declared without a value and written null is undefined until its
// first write and null once written null, as Node holds it.
class Config {
  static level: number;
  static label: string;
  static flag: boolean;
  static count: number;
  static hits: number;
  static set(): void {
    Config.level = 3;
    Config.label = 'x';
    Config.flag = true;
  }
  static clear(): void {
    Config.level = null;
    Config.label = null;
    Config.flag = null;
  }
  static own(): string {
    return [this.level, this.level === undefined, typeof this.label].join('|');
  }
}
function show(): string {
  return [Config.level, Config.level === undefined, Config.level === null, typeof Config.level, String(Config.level), Config.level + 1, Config.label, typeof Config.label, Config.label == null, Config.label === undefined, `${Config.label}`, Config.label + '!', Config.flag, typeof Config.flag, Config.flag === null, Config.own()].join('|');
}
console.log(show());
Config.set();
console.log(show());
Config.clear();
console.log(show());
Config.set();
console.log(show());
Config.count = null;
Config.count += 2;
Config.label = null;
Config.label += '?';
console.log(Config.count, Config.label);
const before = Config.hits++;
Config.hits++;
console.log(before, Config.hits, typeof Config.hits);
Config.hits = null;
const after = ++Config.hits;
Config.hits--;
console.log(after, Config.hits, Config.own());
