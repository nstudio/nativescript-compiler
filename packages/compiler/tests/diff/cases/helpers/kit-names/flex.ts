// The app's own classes named as core's flexbox types (`FlexWrap`, `FlexGrow`), which NativeScriptKit also declares.
export default class FlexWrap {
  static made = 0;
  readonly mode: string;
  constructor(mode = 'wrap') {
    this.mode = mode;
    FlexWrap.made++;
  }
  describe(): string {
    return `wrap:${this.mode}`;
  }
}

export class FlexGrow {
  readonly grow: number;
  constructor(grow: number) {
    this.grow = grow;
  }
  describe(): string {
    return `grow:${this.grow}`;
  }
}
