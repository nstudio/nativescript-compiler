export interface AskerApi {
  authorize(): Promise<{ authorized: boolean; details: string[] }>;
}

export abstract class AskerBase implements AskerApi {
  abstract authorize(): Promise<{ authorized: boolean; details: string[] }>;
  protected mapResult(keys: string[]) {
    return { authorized: keys.length > 1, details: keys };
  }
}
