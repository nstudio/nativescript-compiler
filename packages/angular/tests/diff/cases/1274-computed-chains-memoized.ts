// Computeds reading computeds: each recomputes only when a signal under it changed, and an equal result stops the chain.
import { signal, computed } from '@angular/core';

const width = signal(3);
const height = signal(4);
let areaRuns = 0, labelRuns = 0, parityRuns = 0;
const area = computed(() => { areaRuns++; return width() * height(); });
const parity = computed(() => { parityRuns++; return area() % 2 === 0 ? 'even' : 'odd'; });
const label = computed(() => { labelRuns++; return { text: `${parity()} area` }; });

const l1 = label();
console.log(l1.text, areaRuns, parityRuns, labelRuns);
console.log('same:', label() === l1, areaRuns, parityRuns, labelRuns);
width.set(5);
const l2 = label();
console.log('even->even:', l2.text, l2 === l1, areaRuns, parityRuns, labelRuns);
height.set(5);
const l3 = label();
console.log('even->odd:', l3.text, l3 === l1, areaRuns, parityRuns, labelRuns);
width.set(5);
console.log('same write:', label() === l3, areaRuns, parityRuns, labelRuns);

const flag = signal(true);
const a = signal('A');
const b = signal('B');
let pickRuns = 0;
const pick = computed(() => { pickRuns++; return flag() ? a() : b(); });
console.log(pick(), pickRuns);
b.set('B2');
console.log('unread dep:', pick(), pickRuns);
flag.set(false);
console.log(pick(), pickRuns);
a.set('A2');
console.log('dropped dep:', pick(), pickRuns);
