// @exit 1
// An uncaught throw during an imported module's top-level evaluation aborts dependent importers.
import { depTag } from './helpers/rev-init-throw-dep.ts';

console.log('entry-should-not-run', depTag);
