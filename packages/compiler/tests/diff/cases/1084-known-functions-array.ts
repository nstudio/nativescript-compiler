// @lenient-both
// As core's Builder sets an XML attribute: a static array declared on a base class (`ListViewBase.knownFunctions`),
// looked up by key on a subclass instance's constructor, decides whether the attribute names a code-behind export.
const KNOWN_FUNCTIONS = 'knownFunctions';
class ViewBase {
  className = '';
}
class ListViewBase extends ViewBase {
  static knownFunctions = ['itemTemplateSelector', 'itemIdGenerator'];
  itemTemplateSelector: any = null;
}
class ListView extends ListViewBase {}
class Plain extends ViewBase {
  itemTemplateSelector: any = null;
}
function isKnownFunction(name: string, instance: ViewBase): boolean {
  return instance.constructor && KNOWN_FUNCTIONS in instance.constructor && (instance.constructor[KNOWN_FUNCTIONS] as string[]).indexOf(name) !== -1;
}
function setPropertyValue(instance: any, exports: Object, propertyName: string, propertyValue: any) {
  if (isKnownFunction(propertyName, instance) && exports && typeof exports[propertyValue] === 'function') {
    instance[propertyName] = exports[propertyValue];
  } else {
    instance[propertyName] = propertyValue;
  }
}
const exports = { selectTemplate: (item: any, index: number) => (index % 2 === 0 ? 'even' : 'odd') };
const list = new ListView();
setPropertyValue(list, exports, 'className', 'list');
setPropertyValue(list, exports, 'itemTemplateSelector', 'selectTemplate');
console.log(list.className, typeof list.itemTemplateSelector, list.itemTemplateSelector({}, 0), list.itemTemplateSelector({}, 1));
const plain = new Plain();
setPropertyValue(plain, exports, 'itemTemplateSelector', 'selectTemplate');
console.log(typeof plain.itemTemplateSelector, plain.itemTemplateSelector);
console.log(isKnownFunction('itemIdGenerator', list), isKnownFunction('className', list), isKnownFunction('itemTemplateSelector', plain));
