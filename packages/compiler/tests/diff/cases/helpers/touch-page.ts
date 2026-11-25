export class TouchAnimationsModel {
  taps = 0;
  tap() {
    return ++this.taps;
  }
}

export function navigatingTo(name: string) {
  return 'to ' + name;
}
