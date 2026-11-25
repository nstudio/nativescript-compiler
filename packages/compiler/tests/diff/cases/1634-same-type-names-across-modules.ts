// Interfaces and object type aliases of one name in several modules, with different members: each module's keeps its own.
import { describe, type Meeting, type Room } from './helpers/shared-types/meetings.ts';
import { hostLine } from './helpers/shared-types/hosts.ts';
interface Room2 {
  label: string;
}
const m: Meeting = { id: 7, title: 'Planning', zoomUrl: 'https://zoom.us/j/1' };
const r: Room = { floor: 3, name: 'Fir' };
const rooms: Room2[] = [{ label: 'x' }];
console.log(describe(m, r), describe({ id: 8, title: 'Retro' }, { floor: 1, name: 'Oak' }), rooms[0].label);
console.log(hostLine());
