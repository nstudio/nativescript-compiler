// A `linkedSignal` read or updated through each form that may throw rethrows what computing it threw: options whose
// `computation` or `source` throws, a source that is itself a linked signal that threw, a constant given it, a class's
// field, and an `equal` that throws.
import { signal, linkedSignal } from '@angular/core';

const step = signal(0);
const viaOptions = linkedSignal({
  source: step,
  computation: (s: number) => {
    if (s < 0) throw new Error('negative ' + s);
    return 'n' + s;
  },
});
step.set(-1);
try {
  console.log('options', viaOptions());
} catch (e) {
  console.log('options threw', (e as Error).message);
}
try {
  viaOptions.update((v) => v + '!');
} catch (e) {
  console.log('options update threw', (e as Error).message);
}
step.set(2);
console.log('options', viaOptions());

const badSource = linkedSignal({
  source: () => {
    if (step() === 3) throw new Error('source ' + step());
    return step();
  },
  computation: (s: number) => s * 10,
});
step.set(3);
try {
  console.log('source', badSource());
} catch (e) {
  console.log('source threw', (e as Error).message);
}

const inner = linkedSignal(() => {
  if (step() === 3) throw new Error('inner');
  return step() + 1;
});
const outer = linkedSignal({ source: inner, computation: (s: number) => s * 2 });
try {
  console.log('outer', outer());
} catch (e) {
  console.log('outer threw', (e as Error).message);
}
const alias = inner;
try {
  console.log('alias', alias());
} catch (e) {
  console.log('alias threw', (e as Error).message);
}
step.set(4);
console.log('outer', outer(), 'alias', alias());

class Holder {
  limit = signal(5);
  capped = linkedSignal(() => {
    if (this.limit() > 9) throw new Error('over ' + this.limit());
    return this.limit();
  });
  show(): string {
    try {
      return 'capped ' + this.capped();
    } catch (e) {
      return 'capped threw ' + (e as Error).message;
    }
  }
}
const h = new Holder();
console.log(h.show());
h.limit.set(12);
console.log(h.show());
h.capped.set(1);
console.log(h.show());

const picky = linkedSignal(() => step() * 2, {
  equal: (a: number, b: number) => {
    if (b === 10) throw new Error('equal ' + a + ' ' + b);
    return a === b;
  },
});
console.log('picky', picky());
step.set(5);
try {
  console.log('picky', picky());
} catch (e) {
  console.log('picky threw', (e as Error).message);
}

const recStep = signal(0);
const recInferred = linkedSignal({
  source: () => {
    if (recStep() === 0) throw new Error('rec-src 0');
    return recStep();
  },
  computation: (s, previous) => {
    if (!previous) return 'init:' + s;
    return `${s}:${previous.source === undefined ? 'unset' : previous.source}/${previous.value}`;
  },
});
try {
  console.log('rec-inf', recInferred());
} catch (e) {
  console.log('rec-inf threw', (e as Error).message);
}
recInferred.set('manual');
console.log('rec-inf set', recInferred());
recStep.set(2);
console.log('rec-inf after-set', recInferred());
recStep.set(3);
console.log('rec-inf next', recInferred());

const annStep = signal(0);
const recAnnotated = linkedSignal({
  source: () => {
    if (annStep() === 0) throw new Error('ann-src 0');
    return annStep();
  },
  computation: (s: number, previous?: { source: number; value: string }): string => {
    if (!previous) return 'init:' + s;
    return `${s}:${typeof previous.source}:${previous.source ?? -1}/${previous.value}`;
  },
});
try {
  console.log('rec-ann', recAnnotated());
} catch (e) {
  console.log('rec-ann threw', (e as Error).message);
}
recAnnotated.set('recovered');
annStep.set(4);
console.log('rec-ann after-set', recAnnotated());
annStep.set(5);
console.log('rec-ann next', recAnnotated());

const objStep = signal(0);
const recObj = linkedSignal({
  source: () => {
    if (objStep() === 0) throw new Error('obj-src 0');
    return { id: objStep() };
  },
  computation: (s, previous) => {
    if (!previous) return 'init:' + s.id;
    return `${s.id}:${previous.source === undefined ? 'unset' : previous.source.id}/${previous.value}`;
  },
});
try {
  console.log('rec-obj', recObj());
} catch (e) {
  console.log('rec-obj threw', (e as Error).message);
}
recObj.set('obj-manual');
objStep.set(7);
console.log('rec-obj after-set', recObj());
objStep.set(8);
console.log('rec-obj next', recObj());
