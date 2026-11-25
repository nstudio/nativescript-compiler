// A function called through an exported object of a module's functions, its typings overloads over an implementation
// taking a rest parameter: each call passes the arguments given, the result is read as typed, and a function the
// object is given in place of one is the one called.
import { answers, Dialogs } from './helpers/dialog-rollup.ts';

async function raise(): Promise<string> {
  const result = await Dialogs.prompt({ title: 'Raise it', message: 'Put something forward', okButtonText: 'Draft', cancelButtonText: 'Cancel', defaultText: '' });
  const title = result.result && result.text?.trim();
  if (!title) return 'nothing raised';
  return `raised "${title}"`;
}

async function main() {
  console.log(await raise());
  answers.push('  agenda item  ');
  console.log(await raise());
  answers.push('   ');
  console.log(await raise());
  const short = await Dialogs.prompt('Name?', 'anon');
  console.log(short.result, short.text);
  const only = await Dialogs.prompt('Only a message');
  console.log(only.result, JSON.stringify(only.text));
  console.log(await Dialogs.confirm('Sure?'), await Dialogs.confirm({ title: 'T', message: 'Really?' }));
  const original = Dialogs.confirm;
  Dialogs.confirm = async (arg: any) => {
    console.log('replaced', typeof arg);
    return true;
  };
  console.log(await Dialogs.confirm('Now?'));
  Dialogs.confirm = original;
  console.log(await Dialogs.confirm('Back?'), typeof Dialogs.prompt, Object.keys(Dialogs).join());
}

main();
