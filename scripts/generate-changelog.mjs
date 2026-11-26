#!/usr/bin/env node
// Generates Markdown release notes / changelog for a GitHub Release.
// Usage:
//   node scripts/generate-changelog.mjs --version <ver> --core-version <coreVer> --core-ref <ref> --dist-tag <tag> [--published pkg1,pkg2] [--skipped pkg3] [--out release-notes.md]
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (flag, fallback = '') => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};

const version = opt('--version');
const coreVersion = opt('--core-version');
const coreRef = opt('--core-ref');
const distTag = opt('--dist-tag', 'alpha');
const outFile = opt('--out');
const published = opt('--published')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const skipped = opt('--skipped')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!version) {
  console.error('Missing --version');
  process.exit(2);
}

const git = (...gitArgs) => {
  try {
    return execFileSync('git', gitArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

const currentTag = `v${version}`;
const tags = git('tag', '--list', 'v*', '--sort=-creatordate')
  .split('\n')
  .map((t) => t.trim())
  .filter((t) => t && t !== currentTag);
const prevTag = tags[0] ?? '';
const range = prevTag ? `${prevTag}..HEAD` : 'HEAD';

const rawLog = git('log', range, '--no-merges', '--format=%H%x1f%h%x1f%s');
const commits = rawLog
  ? rawLog
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, short, subject] = line.split('\x1f');
        return { sha, short, subject };
      })
  : [];

const groups = {
  feat: { title: 'Features', items: [] },
  fix: { title: 'Bug Fixes', items: [] },
  perf: { title: 'Performance', items: [] },
  refactor: { title: 'Refactoring', items: [] },
  docs: { title: 'Documentation', items: [] },
  other: { title: 'Maintenance & CI', items: [] },
};

for (const c of commits) {
  const m = /^(feat|fix|perf|refactor|docs|ci|chore|build|test)(?:\(([^)]+)\))?(!)?:\s*(.+)$/.exec(c.subject);
  const entry = m
    ? `- ${m[2] ? `**${m[2]}:** ` : ''}${m[4]} (\`${c.short}\`)`
    : `- ${c.subject} (\`${c.short}\`)`;
  const kind = m?.[1];
  if (kind && kind in groups) groups[kind].items.push(entry);
  else groups.other.items.push(entry);
}

const lines = [];
lines.push(`## ${currentTag}`);
lines.push('');
if (coreVersion) {
  lines.push(`Built with kits generated from \`@nativescript/core@${coreVersion}\`${coreRef ? ` (\`${coreRef}\`)` : ''}.`);
  lines.push('');
}

if (published.length) {
  lines.push('### Published Packages');
  lines.push('');
  lines.push('| Package | Version | Dist-Tag |');
  lines.push('| --- | --- | --- |');
  for (const pkg of published) {
    lines.push(`| [\`${pkg}\`](https://www.npmjs.com/package/${pkg}/v/${version}) | \`${version}\` | \`${distTag}\` |`);
  }
  lines.push('');
  if (published.includes('@nstudio/nativescript-compiler')) {
    lines.push('```sh');
    lines.push(`ns extension install @nstudio/nativescript-compiler@${version}`);
    lines.push('```');
    lines.push('');
  }
}

if (skipped.length) {
  lines.push('### Skipped Packages');
  lines.push('');
  for (const entry of skipped) lines.push(`- ${entry}`);
  lines.push('');
}

lines.push('### Changes');
lines.push('');
let wroteAny = false;
for (const g of Object.values(groups)) {
  if (!g.items.length) continue;
  wroteAny = true;
  lines.push(`#### ${g.title}`);
  lines.push('');
  lines.push(...g.items);
  lines.push('');
}
if (!wroteAny) {
  lines.push('- Initial release.');
  lines.push('');
}

if (prevTag) {
  lines.push(`**Full Changelog:** https://github.com/nstudio/nativescript-compiler/compare/${prevTag}...${currentTag}`);
  lines.push('');
}

const markdown = lines.join('\n');
if (outFile) {
  writeFileSync(outFile, markdown);
} else {
  process.stdout.write(markdown);
}
