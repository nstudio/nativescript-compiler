// @lenient-both
// As core's Builder sets a dotted XML attribute (`style.placeholderColor`, `ios.position`): the holder handed to
// `isKnownFunction` is whatever the dotted path reads, a view, a style object or a plain record.
const KNOWN_FUNCTIONS = 'knownFunctions';
class Observable {
  id = 0;
}
class ViewBase extends Observable {
  className = '';
}
class ListView extends ViewBase {
  static knownFunctions = ['itemTemplateSelector'];
  itemTemplateSelector: any = null;
}
class Style extends Observable {
  placeholderColor: any = null;
}
class ActionItem extends ViewBase {
  ios: any = { position: 'left', systemIcon: undefined };
  style = new Style();
}
function isKnownFunction(name: string, instance: ViewBase | object): boolean {
  return instance.constructor && KNOWN_FUNCTIONS in instance.constructor && (instance.constructor[KNOWN_FUNCTIONS] as string[]).indexOf(name) !== -1;
}
function setPropertyValue(instance: any, exports: Object, propertyName: string, propertyValue: any) {
  if (isKnownFunction(propertyName, instance) && exports && typeof exports[propertyValue] === 'function') {
    instance[propertyName] = exports[propertyValue];
  } else {
    instance[propertyName] = propertyValue;
  }
}
function setDotted(instance: any, exports: Object, attr: string, value: any) {
  const parts = attr.split('.');
  let subObj = instance;
  for (let i = 0; i < parts.length - 1; i++) {
    subObj = subObj[parts[i]];
  }
  setPropertyValue(subObj, exports, parts[parts.length - 1], value);
}
const exports = { right: () => 'fn', pick: (item: any, index: number) => (index % 2 === 0 ? 'even' : 'odd') };
const item = new ActionItem();
setDotted(item, exports, 'ios.position', 'right');
setDotted(item, exports, 'style.placeholderColor', 'red');
setDotted(item, exports, 'className', 'item');
console.log(item.ios.position, item.style.placeholderColor, item.className);
const list = new ListView();
setDotted(list, exports, 'itemTemplateSelector', 'pick');
console.log(typeof list.itemTemplateSelector, list.itemTemplateSelector({}, 1));
console.log(isKnownFunction('itemTemplateSelector', list), isKnownFunction('position', item.ios), isKnownFunction('placeholderColor', item.style));
