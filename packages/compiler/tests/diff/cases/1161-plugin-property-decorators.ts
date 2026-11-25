// @plugin-both
// A plugin's property decorators run on its class's prototype when the class is defined: each decorated field reads and
// writes through the accessor the decorator put there, with the instance as `this`.
import { Shape, Widget } from './helpers/plugin/decorated.ts';

const w = new Widget();
console.log(w.rippleColor, w.elevation);
w.rippleColor = 'red';
w.elevation = 4;
console.log(w.rippleColor, w.elevation, w.style.rippleColor, w.style.elevation);
w.style.elevation = 8;
console.log(w.elevation, Object.keys(w).join(','));

const s = new Shape();
console.log(s.fill, s.label, s.width, s.height, s.scale);
s.fill = 'blue';
s.label = 'tag';
s.width = '12.5' as any;
s.height = '3.6' as any;
s.scale = 2;
console.log(s.fill, s.label, s.width, s.height, s.scale);
console.log(s.changes.join(' '));
const t = new Shape();
console.log(t.fill, t.scale, t.changes.length);
