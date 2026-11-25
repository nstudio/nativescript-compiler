export class Rect {
  w: number;
  constructor(w: number) { this.w = w; }
  width(): number { return this.w; }
}

export class Port {
  contentRect: Rect;
  constructor(w: number) { this.contentRect = new Rect(w); }
  zoomedOut(): boolean { return this.contentRect.w < 50; }
}

export class Axis {
  mPort: Port;
  constructor(p?: Port) { this.mPort = p; }
  wide(): string {
    const port = this.mPort;
    if (port?.contentRect.width() > 10 && !port.zoomedOut()) return 'wide';
    return port?.contentRect.width() > 10 ? 'zoomed' : 'narrow';
  }
}

export class Field {
  listeners: string[] = [];
  addEventListener(name: string) { this.listeners.push(name); }
}

export class Fields {
  dateField: Field;
  timeField: Field;
  constructor(date?: Field) { this.dateField = date; }
  wire(): string {
    this.dateField?.addEventListener('dateChange');
    this.timeField?.addEventListener('timeChange');
    return (this.dateField?.listeners.join(',') ?? 'none') + '/' + (this.timeField?.listeners.length ?? -1);
  }
}
