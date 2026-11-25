// Reading or writing moved module-level const/let bindings before initialization across an import cycle throws ReferenceError.
import { runCycle } from './helpers/rev-init-cycle-a.ts';

for (const line of runCycle()) console.log(line);
