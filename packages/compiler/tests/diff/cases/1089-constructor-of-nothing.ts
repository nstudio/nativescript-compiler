// @lenient-both
// As core's `isKnownFunction` and the fragment transitions read it: `.constructor` of a typed parameter, which script may
// call with nothing.
class ListViewBase {
  static knownFunctions = ['itemTemplateSelector'];
}
class ListView extends ListViewBase {}
function constructorOf(instance: ListViewBase): any {
  return instance.constructor;
}
function knownFunctionsOf(instance: ListViewBase): string[] {
  return instance.constructor['knownFunctions'];
}
console.log(constructorOf(new ListView()) === ListView, knownFunctionsOf(new ListView()).length);
try {
  constructorOf(undefined as any);
} catch (e) {
  console.log(String(e));
}
