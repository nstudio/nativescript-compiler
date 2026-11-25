// @app-lenient
// A non-strict app's static string, number and boolean fields initialized to null or written null hold null, as
// JavaScript holds it; every other one holds its value.
class Settings {
  static theme: string = null;
  static scale: number = null;
  static dark: boolean = null;
  static title: string = 'app';
  static size = 3;
}
function report(): string {
  return [Settings.theme, Settings.theme === null, typeof Settings.scale, Settings.scale + 1, Settings.dark ? 'd' : 'l', `${Settings.theme}`, Settings.title, Settings.size].join('|');
}
console.log(report());
Settings.theme = 'blue';
Settings.scale = 2;
Settings.dark = true;
console.log(report());
Settings.theme = null;
Settings.title = null;
console.log(report(), Settings.title === null, JSON.stringify({ t: Settings.theme, n: Settings.title, s: Settings.scale }));
