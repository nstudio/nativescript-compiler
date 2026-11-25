export class Options {
  constructor(name) {
    this.name = name;
    this.retries = 0;
  }
  describe() {
    return `${this.name} x${this.retries}`;
  }
}
export class Channel {
  constructor(name) {
    this.options = new Options(name);
  }
  send(message) {
    return Promise.resolve(`${this.options.describe()}: ${message}`);
  }
}
export function configure(options) {
  options.retries = options.retries + 1;
  return options;
}
//# sourceMappingURL=index.ios.js.map
