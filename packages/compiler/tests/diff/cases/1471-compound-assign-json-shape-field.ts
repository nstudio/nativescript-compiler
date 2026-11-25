// Compound and update assignments on fields of a shape read from JSON: a present number computes as JS does, and a
// missing one reads undefined, so the result is NaN. The object is evaluated once.
interface Settings {
  volume: number;
  label: string;
}
let reads = 0;
function settings(x: Settings) {
  reads++;
  return x;
}
const s = JSON.parse('{"volume": 3, "label": "a"}') as Settings;
s.volume += 1;
s.volume *= 2;
s.volume -= 0.5;
s.volume /= 5;
settings(s).volume += 10;
s.label += 'b';
console.log(s.volume, s.label, reads, JSON.stringify(s));
s.volume %= 4;
s.volume **= 2;
console.log(s.volume);
const t = JSON.parse('{"label": "x"}') as Settings;
t.volume += 1;
console.log(t.volume, Number.isNaN(t.volume), JSON.stringify(t));
const u = JSON.parse('{"label": "x"}') as Settings;
u.volume++;
u.volume -= 2;
console.log(u.volume, JSON.stringify(u));
