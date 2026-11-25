export interface PickerApi {
  authorize(): Promise<string>;
  present(): Promise<string[]>;
}

export abstract class PickerBase implements PickerApi {
  abstract authorize(): Promise<string>;
  abstract present(): Promise<string[]>;
  protected mapResult(result: string) {
    return result === 'authorized' ? 'yes' : 'no: ' + result;
  }
}
