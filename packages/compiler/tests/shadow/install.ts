// The shadow modes a run's environment names, installed as the compiler's observers (src/semantics/observers.ts):
//   node --import tests/shadow/install.ts <a compiler entry or a harness> …
// NS_CONVERSION_SHADOW, NS_FORMS_SHADOW, NS_KEEP_SHADOW and NS_HELD_SHADOW each name the JSONL file that mode appends to.
import { observers } from '../../src/semantics/observers.ts';
import { shadowConversions } from './conversion.ts';
import { shadowForms } from './forms.ts';
import { shadowHeld } from './held.ts';
import { shadowKeep } from './keep.ts';

if (process.env.NS_CONVERSION_SHADOW) observers.translator = shadowConversions;
if (process.env.NS_FORMS_SHADOW) observers.states = shadowForms;
if (process.env.NS_KEEP_SHADOW) observers.keep = shadowKeep;
if (process.env.NS_HELD_SHADOW) observers.held = shadowHeld;
