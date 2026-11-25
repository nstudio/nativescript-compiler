import { Application, Trace } from '@nativescript/core';
import { resolveModuleName } from '@nativescript/core/module-name-resolver';

Application.on(Application.launchEvent, () => {
  console.log('launched');
});
Trace.setCategories(Trace.categories.concat(Trace.categories.Binding, Trace.categories.Style));
console.log('resolved', resolveModuleName('main-page', 'xml'));

Application.run({ moduleName: 'app-root' });
