export interface GaugeOptions {
  size?: number;
  label?: string;
}

export function gaugeSize(o: GaugeOptions): number {
  return o.size ?? 1;
}

export function describeSize(o: GaugeOptions): string {
  return `${typeof o.size} ${o.size === undefined} ${o.size == null} ${o.size || 3}`;
}

export function scaled(n?: number): number {
  return (n ?? 2) * 10;
}

export function given(n?: number): string {
  return typeof n + ' ' + (n === undefined);
}

export class Gauge {
  width?: number;
  get shown(): number {
    return this.width ?? 5;
  }
  get kind(): string {
    return typeof this.width;
  }
}
