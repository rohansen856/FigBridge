// Writes THIRD_PARTY_NOTICES.md for the packages that actually end up in a bundle.
// usage: writeNotices(metafile, outFile, extraEntries)
import { existsSync, readFileSync, writeFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function packageRoot(file) {
  let dir = dirname(resolve(file));
  for (;;) {
    const pj = join(dir, 'package.json');
    if (existsSync(pj)) {
      const pkg = JSON.parse(readFileSync(pj, 'utf8'));
      if (pkg.name && !pkg.private) return { dir, pkg };
    }
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

export function writeNotices(metafile, outFile, extras = []) {
  const seen = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    if (!input.includes('node_modules')) continue;
    const root = packageRoot(input);
    if (!root || seen.has(root.pkg.name)) continue;
    seen.set(root.pkg.name, root);
  }
  const sections = [];
  const all = [...seen.values()].map(({ dir, pkg }) => ({ name: pkg.name, version: pkg.version, license: typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license ?? 'UNKNOWN'), dir: realpathSync(dir) }));
  all.push(...extras);
  for (const p of all.sort((a, b) => a.name.localeCompare(b.name))) {
    const licenseFile = p.licenseFile ?? readdirSync(p.dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
    const text = licenseFile ? readFileSync(join(p.dir, licenseFile), 'utf8').trim() : `License: ${p.license}`;
    sections.push(`## ${p.name}${p.version ? ` ${p.version}` : ''} — ${p.license}\n\n\`\`\`\n${text}\n\`\`\``);
  }
  const bad = all.filter((p) => !/^(MIT|ISC|BSD-2-Clause|BSD-3-Clause|Apache-2\.0|0BSD|Unlicense|BlueOak-1\.0\.0|Python-2\.0|\(MIT OR CC0-1\.0\))$/.test(p.license));
  if (bad.length) throw new Error(`Unreviewed licenses: ${bad.map((p) => `${p.name} (${p.license})`).join(', ')}`);
  writeFileSync(outFile, `# Third-party notices\n\nThis product bundles the following open-source software.\n\n${sections.join('\n\n')}\n`);
  return all.map((p) => `${p.name} ${p.license}`);
}
