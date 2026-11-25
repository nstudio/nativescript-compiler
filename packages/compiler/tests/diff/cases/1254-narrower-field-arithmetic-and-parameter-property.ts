// Fields narrower than the optional members they implement, a parameter property's among them: after undefined is
// written through the interface, the class's reads compute with undefined as JavaScript does.
interface Sized {
  width?: number;
  label?: string;
}
class Panel implements Sized {
  width = 10;
  constructor(public label: string) {}
  area(h: number): number {
    return this.width * h;
  }
}
class Wide extends Panel {
  grow(): number {
    return this.width + 1;
  }
}
const p = new Panel('a');
const w = new Wide('b');
const items: Sized[] = [p, w];
for (const s of items) {
  s.width = undefined;
  s.label = undefined;
}
console.log(p.area(2), w.grow(), `${p.label}-${w.label}`, p.width ?? 'unset', String(w.width));
items[1].width = 5;
console.log(w.grow(), w.area(3), Object.keys(w).join(','));
