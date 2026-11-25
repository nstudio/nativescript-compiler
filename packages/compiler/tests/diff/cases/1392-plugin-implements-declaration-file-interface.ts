// @packages ns-fixture-channel=ns-fixture-channel/index.ios.js
// A plugin's classes implementing interfaces only its declaration file declares (`index.d.ts`, as
// @nativescript/firebase-core's `FirebaseOptions implements IFirebaseOptions`), held and passed by those interfaces.
import { Channel, Options, configure } from 'ns-fixture-channel';

async function main() {
  const channel = new Channel('primary');
  console.log(await channel.send('hello'));
  const options = configure(new Options('second'));
  console.log(options.describe(), options instanceof Options, configure(channel.options).describe());
  console.log(await channel.send('again'));
}
main();
