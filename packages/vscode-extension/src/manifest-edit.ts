import { isMap, isSeq, parseDocument, type Document, type YAMLMap } from 'yaml';
import type { NodeId, RefId, RefKind } from '@figbridge/core';

export interface NewRef {
  id: RefId;
  file: string;
  nodeId: NodeId;
  name?: string;
  kind?: RefKind;
}

/**
 * Pure text transforms on the manifest. Each returns the new full text; callers wrap it in a
 * WorkspaceEdit so the change is reviewable and undoable. Comments and ordering are preserved.
 */
function load(text: string): Document {
  const doc = parseDocument(text, { keepSourceTokens: true });
  if (doc.errors.length) throw new Error(`The manifest has YAML errors: ${doc.errors[0]!.message.split('\n')[0]}`);
  return doc;
}

function refsMap(doc: Document): YAMLMap {
  let refs = doc.get('refs', true);
  if (!isMap(refs)) {
    doc.set('refs', doc.createNode({}));
    refs = doc.get('refs', true);
  }
  return refs as YAMLMap;
}

export function addRef(text: string, ref: NewRef): string {
  const doc = load(text);
  const refs = refsMap(doc);
  if (refs.has(ref.id)) throw new Error(`${ref.id} already exists in the manifest.`);
  const value: Record<string, string> = { file: ref.file, nodeId: ref.nodeId };
  if (ref.name) value.name = ref.name;
  if (ref.kind) value.kind = ref.kind;
  const node = doc.createNode(value) as YAMLMap;
  // nodeId must stay a quoted string ("1:2" is fine plain, but quoting is unambiguous).
  const nodeIdScalar = node.items.find((p) => (p.key as { value?: unknown }).value === 'nodeId');
  if (nodeIdScalar?.value && typeof nodeIdScalar.value === 'object') (nodeIdScalar.value as { type?: string }).type = 'QUOTE_DOUBLE';
  if (refs.flow) refs.flow = false;
  refs.set(doc.createNode(ref.id), node);
  return doc.toString();
}

export function addFile(text: string, alias: string, url: string, name?: string): string {
  const doc = load(text);
  let files = doc.get('files', true);
  if (!isMap(files)) {
    doc.set('files', doc.createNode({}));
    files = doc.get('files', true);
  }
  if ((files as YAMLMap).has(alias)) throw new Error(`File alias "${alias}" already exists.`);
  (files as YAMLMap).set(alias, doc.createNode(name ? { name, url } : { url }));
  return doc.toString();
}

export function retargetRef(text: string, id: RefId, file: string, nodeId: NodeId): string {
  const doc = load(text);
  const ref = refsMap(doc).get(id, true);
  if (!isMap(ref)) throw new Error(`${id} is not in the manifest.`);
  ref.set('file', file);
  const n = doc.createNode(nodeId);
  (n as { type?: string }).type = 'QUOTE_DOUBLE';
  ref.set('nodeId', n);
  return doc.toString();
}

/** Removes the mapping and lists the ID under `retired` so it is never reissued. */
export function retireRef(text: string, id: RefId): string {
  const doc = load(text);
  const refs = refsMap(doc);
  if (!refs.has(id)) throw new Error(`${id} is not in the manifest.`);
  refs.delete(id);
  for (const r of refs.items) {
    const v = r.value;
    if (isMap(v) && v.get('parentRef') === id) v.delete('parentRef');
    if (isMap(v) && v.get('replacedBy') === id) v.delete('replacedBy');
  }
  let retired = doc.get('retired', true);
  if (!isSeq(retired)) {
    doc.set('retired', doc.createNode([]));
    retired = doc.get('retired', true);
  }
  if (isSeq(retired) && !retired.items.some((i) => (i as { value?: unknown }).value === id)) retired.add(doc.createNode(id));
  return doc.toString();
}

export const MANIFEST_TEMPLATE = (alias: string, url: string, projectName: string) => `# FigBridge manifest: maps @figma reference IDs in source comments to Figma nodes.
# Commit this file. Never put access tokens or signed image URLs here.
schemaVersion: 1
project:
  name: ${JSON.stringify(projectName)}

files:
  ${alias}:
    url: ${JSON.stringify(url)}

refs: {}
`;
