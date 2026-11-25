// @app-lenient
// @assign-fields
// @members-by-name
// A setter-only accessor set by name, as core's Builder sets an attribute: the setter runs, and reading it gives undefined.
class Boom {
  log: string[] = [];
  private _size = 0;
  set fuse(v: string) {
    if (v === 'lit') throw new Error(`fuse ${v}`);
    this.log.push(`fuse=${v}`);
  }
  set size(v: number) {
    this._size = Number(v) * 2;
  }
  get doubled() {
    return this._size;
  }
}
function setPropertyValue(instance: any, name: string, value: any) {
  instance[name] = value;
}
const b = new Boom();
setPropertyValue(b, 'fuse', 'dud');
setPropertyValue(b, 'size', '21');
console.log(b.log.join(','), b.doubled, (b as any).fuse === undefined, 'fuse' in b, Object.keys(b).join(','));
try {
  setPropertyValue(b, 'fuse', 'lit');
  console.log('no throw');
} catch (e) {
  console.log('threw', (e as Error).message);
}
class Mine extends Boom {
  set fuse(v: string) {
    if (v === 'short') throw new Error(`short ${v}`);
    this.log.push(`mine=${v}`);
  }
}
const m = new Mine();
setPropertyValue(m, 'fuse', 'long');
try {
  setPropertyValue(m, 'fuse', 'short');
} catch (e) {
  console.log('threw', (e as Error).message, m.log.join(','));
}
