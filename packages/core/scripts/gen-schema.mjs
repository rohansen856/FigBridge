// Writes the manifest JSON Schema from the compiled core to <repo>/schemas/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST_SCHEMA } from '../dist/manifest/schema.js';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'schemas', 'figma.design.schema.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(MANIFEST_SCHEMA, null, 2) + '\n');
console.log('wrote', out);
