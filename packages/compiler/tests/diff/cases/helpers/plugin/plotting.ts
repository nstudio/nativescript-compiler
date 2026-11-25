// A plugin's generic view base whose data accessor pair (setter declared first) its type parameter types, two
// subclasses deep, and a renderer that reads it through the concrete subclass.
export class Point {
  constructor(public x: number, public y: number) {}
}

export class Series<P extends Point> {
  points: P[] = [];
  label = 'series';
  sum(): number {
    return this.points.reduce((s, p) => s + p.y, 0);
  }
}

export class PlotData<P extends Point, S extends Series<P>> {
  sets: S[] = [];
  first(): S {
    return this.sets[0];
  }
  get total(): number {
    return this.sets.reduce((s, x) => s + x.sum(), 0);
  }
}

export class PieSeries extends Series<Point> {
  slice = 0;
}

export class PieData extends PlotData<Point, PieSeries> {
  hole = 0.5;
}

export abstract class Plot<P extends Point, S extends Series<P>, D extends PlotData<P, S>> {
  protected mData: D = null;
  offset = 0;
  set data(d: D) {
    this.mData = d;
  }
  get data() {
    return this.mData;
  }
  dataOrNull(): D | null {
    return this.mData;
  }
  protected mLast: D = null;
  set last(d: D) {
    this.mLast = d;
  }
  get head() {
    return this.mData ? this.mData.first() : null;
  }
  lastOrNull(): D | null {
    return this.mLast;
  }
}

export class PlotScale {
  private static mFactor = 1;
  static set factor(v: number) {
    PlotScale.mFactor = v;
  }
  static get factor() {
    return PlotScale.mFactor;
  }
}

export abstract class RoundPlot<P extends Point, S extends Series<P>, D extends PlotData<P, S>> extends Plot<P, S, D> {
  rotation = 0;
}

export class PiePlot extends RoundPlot<Point, PieSeries, PieData> {}

export class PieRenderer {
  protected mPlot: PiePlot;
  constructor(plot: PiePlot) {
    this.mPlot = plot;
  }
  describe(): string {
    const data = this.mPlot.data;
    const first: PieSeries = data.first();
    const ratio = data.total / first.sum();
    const hole: number = this.mPlot.data.hole;
    let angle = this.mPlot.data.sets.length;
    angle -= first.slice;
    return `${first.label} ${ratio} ${hole} ${angle} ${data.sets.map((s) => s.slice).join('/')} ${this.mPlot.dataOrNull().hole}`;
  }
  lastRead(): string {
    const last: PieData = this.mPlot.last;
    return `${last === undefined} ${String(last)} ${this.mPlot.lastOrNull().hole}`;
  }
}

export function render(plot: PiePlot): string {
  const pie: PieData = plot.data;
  return `${pie.hole} ${plot.data.first().points.length}`;
}
