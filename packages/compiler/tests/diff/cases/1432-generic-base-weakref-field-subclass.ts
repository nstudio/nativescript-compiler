// @plugin-both
// A plugin subclass of a generic base class reads the base's `WeakRef<T>` field as its own instantiation types it.
import { Panel, PanelHandler } from './helpers/plugin/owned-handler.ts';

const panel = new Panel('main');
const handler = new PanelHandler(panel);
console.log(handler.tap());
console.log(handler.tap());
console.log(handler.titleOf());
console.log(handler.owner.deref() === panel);
console.log(handler.owner === handler.owner);
