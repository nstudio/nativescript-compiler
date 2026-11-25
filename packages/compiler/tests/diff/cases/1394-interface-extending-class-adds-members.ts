// An interface extending a class types that class's objects with members the class lacks: script gives the object
// them as its own properties, which reads see and typed members of the class leave alone.
class Panel {
  title = 'panel';
  describe() {
    return `<${this.title}>`;
  }
}

interface TaggedPanel extends Panel {
  tag: string;
  hits?: number;
}

function tagged(panel: Panel, tag: string): TaggedPanel {
  const t = panel as TaggedPanel;
  t.tag = tag;
  return t;
}

const panel = new Panel();
const t = tagged(panel, 'first');
console.log(t.tag, t.title, t.describe(), t === panel, t.hits === undefined);
t.hits = (t.hits ?? 0) + 2;
t.title = 'renamed';
console.log(t.hits, panel.describe(), JSON.stringify(panel), Object.keys(panel).join(','));
const list: TaggedPanel[] = [t, tagged(new Panel(), 'second')];
console.log(list.map((p) => `${p.tag}:${p.describe()}:${p.hits ?? '-'}`).join(' '));
