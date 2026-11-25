// A module of functions declared as overloads over one implementation taking a rest parameter, rolled up into one
// exported object, as core's dialogs are (`Dialogs = { alert, confirm, prompt, … }`).
export interface PromptOptions {
  title?: string;
  message?: string;
  okButtonText?: string;
  cancelButtonText?: string;
  defaultText?: string;
}
export interface PromptResult {
  result: boolean;
  text: string;
}

export const answers: string[] = [];

export function prompt(message: string, defaultText?: string): Promise<PromptResult>;
export function prompt(options: PromptOptions): Promise<PromptResult>;
export async function prompt(...args: any[]): Promise<PromptResult> {
  const first = args[0];
  const options: PromptOptions = typeof first === 'string' ? { message: first, defaultText: args[1] } : first;
  console.log('prompt', args.length, options.title ?? '-', options.message, JSON.stringify(options.defaultText));
  const text = answers.shift();
  return { result: text !== undefined, text: text ?? options.defaultText ?? '' };
}

export function confirm(message: string): Promise<boolean>;
export function confirm(options: { title?: string; message: string }): Promise<boolean>;
export async function confirm(arg: any): Promise<boolean> {
  console.log('confirm', typeof arg === 'string' ? arg : arg.message);
  return answers.length > 0;
}

export const Dialogs = {
  prompt,
  confirm,
};
