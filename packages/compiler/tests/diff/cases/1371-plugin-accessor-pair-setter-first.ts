// @plugin-both
// A plugin's generic accessor pair declared setter first, read through a concrete subclass two levels down into typed
// locals, arithmetic, compound assignment and method calls; a getter-only and a setter-only member (the plugin reads it:
// undefined), and a static pair declared setter first.
import { PieData, PiePlot, PieRenderer, PieSeries, PlotScale, Point, render } from './helpers/plugin/plotting.ts';

const plot = new PiePlot();
const data = new PieData();
const a = new PieSeries();
a.points = [new Point(0, 2), new Point(1, 3)];
a.slice = 1;
const b = new PieSeries();
b.points = [new Point(0, 5)];
b.slice = 4;
data.sets = [a, b];
plot.data = data;
console.log(new PieRenderer(plot).describe());
console.log(render(plot));
const head: PieSeries = plot.head;
console.log(head.slice, head.sum());
plot.last = data;
console.log(new PieRenderer(plot).lastRead());
PlotScale.factor = 3;
const factor: number = PlotScale.factor;
PlotScale.factor += 2;
console.log(factor * 2, PlotScale.factor);
