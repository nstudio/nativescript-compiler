// @lenient-both
// A namespace's function whose body reads `this`: called through the namespace, its `this` is the namespace object;
// called by its bare name inside the namespace, undefined.
export namespace Paints {
  const made: { [k: string]: string } = {};
  export function paint(kind: string) {
    const cached = made[kind];
    if (cached) return cached;
    let p: string;
    switch (kind) {
      case 'stroke':
        p = 'black/' + (this === undefined ? 'bare' : 'member');
        break;
      case 'gray':
        p = paint('stroke') + '+gray/' + (this === undefined ? 'bare' : 'member');
        break;
      default:
        p = 'none';
    }
    made[kind] = p;
    return p;
  }
}

console.log(Paints.paint('gray'), Paints.paint('stroke'), Paints.paint('other'));
