// A typed alias of an untyped object is the object: a write through either is seen through the other, including
// keys added and deleted later.
interface Settings {
  volume: number;
  label: string;
  muted?: boolean;
}

function louder(s: Settings) {
  s.volume = s.volume + 1;
  s.label = s.label + '!';
}

const source: any = JSON.parse('{"volume": 3, "label": "a", "extra": true}');
const s: Settings = source;
louder(source);
console.log(source.volume, source.label, s.volume, s.label);
source.volume = 10;
source.muted = true;
console.log(s.volume, s.muted, Object.keys(s).join(','));
delete source.muted;
console.log(s.muted, 'muted' in s, Object.keys(s).join(','));
s.label = 'z';
delete (s as any).extra;
console.log(source.label, Object.keys(source).join(','), JSON.stringify(s));
