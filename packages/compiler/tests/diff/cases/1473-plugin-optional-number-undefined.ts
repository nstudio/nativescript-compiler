// @plugin-both
// A plugin's optional number left undefined reads undefined where `??`, `||`, `=== undefined` or `typeof` looks at it.
import { describeSize, Gauge, gaugeSize, given, scaled } from './helpers/plugin/gauge.ts';

console.log(gaugeSize({}), gaugeSize({ size: 4 }), gaugeSize({ size: 0 }));
console.log(describeSize({}), describeSize({ size: 7 }));
console.log(scaled(), scaled(3), given(), given(2));
const g = new Gauge();
console.log(g.shown, g.kind);
g.width = 8;
console.log(g.shown, g.kind);
