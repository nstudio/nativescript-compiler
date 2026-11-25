export class Handler<T extends object> {
  owner: WeakRef<T>;

  constructor(owner: T) {
    this.owner = new WeakRef(owner);
  }
}

export class Panel {
  title: string;
  taps = 0;

  constructor(title: string) {
    this.title = title;
  }
}

export class PanelHandler extends Handler<Panel> {
  tap(): string {
    const owner = this.owner.deref();
    if (!owner) return 'gone';
    owner.taps++;
    return `${owner.title}:${owner.taps}`;
  }

  titleOf(): string {
    return this.owner.deref()?.title ?? 'none';
  }
}
