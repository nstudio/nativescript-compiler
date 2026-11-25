export interface OptionsApi {
  name: string;
  retries: number;
  describe(): string;
}

export interface ChannelApi {
  readonly options: OptionsApi;
  send(message: string): Promise<string>;
}

export declare class Options implements OptionsApi {
  name: string;
  retries: number;
  constructor(name: string);
  describe(): string;
}

export declare class Channel implements ChannelApi {
  readonly options: OptionsApi;
  constructor(name: string);
  send(message: string): Promise<string>;
}

export declare function configure(options: OptionsApi): OptionsApi;
