// @lenient-both
// Library mode: destructuring a class reads its static properties, each once, in order, as `X.A` reads them; a
// subclass reads its base's.
class Build {
  static FINGERPRINT = 'fp';
  static SDK = 34;
  static board: Build = null;
  static get MODEL(): string {
    console.log('MODEL read');
    return 'm';
  }
}
class Device extends Build {
  static HARDWARE = 'hw';
}
function info(): string {
  const { FINGERPRINT, SDK } = Build;
  return FINGERPRINT + ',' + (SDK + 1);
}
function more(): void {
  const { SDK: level, MODEL, board } = Build;
  console.log(level, MODEL, board == null, board ? 'board' : 'none');
  let { HARDWARE, FINGERPRINT: fp } = Device;
  HARDWARE = HARDWARE + '!';
  console.log(HARDWARE, fp);
}
console.log(info());
more();
Build.FINGERPRINT = 'fp2';
Build.board = new Build();
console.log(info());
more();
