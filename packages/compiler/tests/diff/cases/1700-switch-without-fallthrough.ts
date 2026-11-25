// Switches whose clauses never fall through, over strings and numbers: grouped labels, a default first, in the middle
// or absent, an empty last clause, labels of side effects tested in order up to the match, a `break` inside a clause,
// clauses ending in return/continue/throw, a block declaring names, a repeated label, labels of null and undefined,
// -0 and NaN; and switches that fall through or test objects, which keep their jump table.
const log: string[] = [];
function label(s: string): string {
  log.push(s);
  return s;
}

function kind(name: string): string {
  let out = '?';
  switch (name) {
    case 'UID':
      out = 'id';
      break;
    case 'SUMMARY':
    case 'DESCRIPTION':
      out = 'text';
      break;
    default:
      out = 'other';
      break;
    case 'DTSTART': {
      const at = name.length;
      out = `start${at}`;
      break;
    }
    case 'UID':
      out = 'never';
      break;
  }
  return out;
}
console.log(['UID', 'SUMMARY', 'DESCRIPTION', 'DTSTART', 'X', ''].map(kind).join(' '));

function num(n: number): string {
  switch (n) {
    case 0:
      return 'zero';
    case 1:
    case 2:
      return 'small';
    case NaN:
      return 'nan';
    case Infinity:
      return 'inf';
    case -1:
      return 'minus';
  }
  return 'none';
}
console.log([0, -0, 1, 2, NaN, Infinity, -Infinity, -1, 3].map(num).join(' '));

function lazy(s: string): string {
  log.length = 0;
  switch (s) {
    case label('a'):
      return 'A';
    case label('b'):
      return 'B';
    case label('c'):
      return 'C';
  }
  return '-';
}
console.log(lazy('a'), log.join(''), lazy('b'), log.join(''), lazy('z'), log.join(''));

function inner(s: string, stop: boolean): string {
  const steps: string[] = [];
  switch (s) {
    case 'go':
      steps.push('1');
      if (stop) break;
      steps.push('2');
      break;
    default:
      steps.push('d');
  }
  steps.push('end');
  return steps.join(',');
}
console.log(inner('go', true), inner('go', false), inner('x', false));

function loop(items: string[]): string {
  const out: string[] = [];
  outer: for (const item of items) {
    switch (item) {
      case 'skip':
        continue;
      case 'stop':
        break outer;
      case 'bad':
        try {
          throw new Error('bad item');
        } catch (e) {
          out.push((e as Error).message);
        }
        break;
      case 'nest':
        switch (item.length) {
          case 4:
            out.push('four');
            break;
          default:
            out.push('other');
        }
        break;
      case 'last':
    }
    out.push(item);
  }
  return out.join(' ');
}
console.log(loop(['a', 'skip', 'bad', 'nest', 'last', 'b', 'stop', 'c']));

function thrower(s: string): string {
  try {
    switch (s) {
      case 'x':
        throw new Error('thrown ' + s);
      default:
        return 'kept ' + s;
    }
  } catch (e) {
    return (e as Error).message;
  }
}
console.log(thrower('x'), thrower('y'));

function maybe(s: string | undefined): string {
  switch (s) {
    case undefined:
      return 'undefined';
    case 'a':
      return 'a';
    default:
      return 'other';
  }
}
console.log(maybe(undefined), maybe('a'), maybe('b'));

function maybeNum(n: number | null): string {
  switch (n) {
    case null:
      return 'null';
    case 5:
      return 'five';
  }
  return 'else';
}
console.log(maybeNum(null), maybeNum(5), maybeNum(6));

function falls(n: number): string {
  const out: string[] = [];
  switch (n) {
    case 1:
      out.push('one');
    case 2:
      out.push('two');
      break;
    default:
      out.push('many');
  }
  return out.join('+');
}
console.log(falls(1), falls(2), falls(3));

class Box {
  constructor(readonly v: number) {}
}
const shared = new Box(1);
function which(b: Box): string {
  switch (b) {
    case shared:
      return 'shared';
    default:
      return 'other';
  }
}
console.log(which(shared), which(new Box(1)));

function defaultFirst(s: string): string {
  let r = '';
  switch (s) {
    default:
      r = 'dflt';
      break;
    case 'k':
      r = 'k';
  }
  return r;
}
console.log(defaultFirst('k'), defaultFirst('q'));

function empty(s: string): string {
  switch (s) {
    case 'a':
  }
  return 'empty ' + s;
}
console.log(empty('a'));

enum Mode {
  Week = 'week',
  Month = 'month',
  Year = 'year',
}
function route(path: string, mode: Mode): string {
  let r = '';
  switch (path) {
    case 'brief':
      r = 'brief';
      break;
    case 'meetings':
    default:
      r = 'meetings';
      break;
    case 'agenda':
      r = 'agenda';
  }
  switch (mode) {
    case Mode.Week:
      return r + '/w';
    case Mode.Month:
    default:
      return r + '/m';
  }
}
function shadowed(path: string): string {
  switch (path) {
    case 'x':
    default:
      return 'default';
    case 'x':
      return 'later x';
  }
}
console.log(route('brief', Mode.Week), route('meetings', Mode.Month), route('agenda', Mode.Year), route('?', Mode.Week), shadowed('x'), shadowed('y'));
