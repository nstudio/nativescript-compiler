import { ChannelApi, OptionsApi } from '.';

export class Options implements OptionsApi {
  retries = 0;
  constructor(public name: string) {}
  describe() {
    return `${this.name} x${this.retries}`;
  }
}

export class Channel implements ChannelApi {
  readonly options: OptionsApi;
  constructor(name: string) {
    this.options = new Options(name);
  }
  send(message: string) {
    return Promise.resolve(`${this.options.describe()}: ${message}`);
  }
}

export function configure(options: OptionsApi): OptionsApi {
  options.retries = options.retries + 1;
  return options;
}
