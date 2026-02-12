/**
 * JSON Schema (2020-12) for `figma.design.yaml`, schema version 1.
 * Published as `schemas/figma.design.schema.json` by `pnpm --filter @figbridge/core gen:schema`.
 * Cross-record rules (alias/parent existence, cycles, duplicates, retired IDs) live in validate.ts.
 */
const REF_ID = '^[0-9A-HJKMNP-TV-Z]{12}$';
const NODE_ID = '^(?:\\d+:\\d+|[IT]\\d+:\\d+(?:;\\d+:\\d+)*)$';
const ENV_PLACEHOLDER = '^\\$\\{env:FIGMA_[A-Z0-9_]{1,64}\\}$';
const FIGMA_URL = '^https://(www\\.)?figma\\.com/(design|file)/[0-9A-Za-z]{10,128}(/.*)?$';

export const MANIFEST_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://figbridge.dev/schemas/figma.design.schema.json',
  title: 'FigBridge design manifest',
  description:
    'Maps opaque @figma reference IDs used in source comments to Figma file nodes. Never put tokens or signed URLs here.',
  type: 'object',
  required: ['schemaVersion', 'files', 'refs'],
  additionalProperties: false,
  patternProperties: { '^x-': {} },
  properties: {
    $schema: { type: 'string' },
    schemaVersion: { const: 1 },
    project: {
      type: 'object',
      additionalProperties: false,
      properties: { name: { type: 'string', minLength: 1, maxLength: 120 } },
    },
    settings: {
      type: 'object',
      additionalProperties: false,
      properties: {
        preview: {
          type: 'object',
          additionalProperties: false,
          properties: {
            format: { enum: ['png', 'jpg'], default: 'png' },
            scale: { type: 'number', minimum: 0.25, maximum: 4, default: 1 },
            ttlMinutes: { type: 'integer', minimum: 1, maximum: 10080, default: 1440 },
            hoverWidth: { type: 'integer', minimum: 120, maximum: 800, default: 360 },
          },
        },
        scan: {
          type: 'object',
          additionalProperties: false,
          properties: {
            include: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
            exclude: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
          },
        },
      },
    },
    files: {
      type: 'object',
      minProperties: 1,
      propertyNames: { pattern: '^[a-z][a-z0-9_-]{0,39}$' },
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          url: {
            type: 'string',
            maxLength: 2048,
            anyOf: [{ pattern: FIGMA_URL }, { pattern: ENV_PLACEHOLDER }],
            description: 'Figma design URL, or a ${env:FIGMA_*} placeholder.',
          },
          fileKey: { type: 'string', pattern: '^[0-9A-Za-z]{10,128}$' },
          branchKey: { type: 'string', pattern: '^[0-9A-Za-z]{10,128}$' },
        },
        oneOf: [{ required: ['url'] }, { required: ['fileKey'] }],
      },
    },
    refs: {
      type: 'object',
      propertyNames: { pattern: REF_ID },
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'nodeId'],
        properties: {
          file: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,39}$' },
          nodeId: { type: 'string', pattern: NODE_ID },
          name: { type: 'string', minLength: 1, maxLength: 200 },
          kind: { enum: ['screen', 'component', 'variant', 'asset', 'section', 'other'] },
          tags: {
            type: 'array',
            items: { type: 'string', minLength: 1, maxLength: 80 },
            uniqueItems: true,
            maxItems: 32,
          },
          parentRef: { type: 'string', pattern: REF_ID },
          deprecated: { type: 'boolean' },
          replacedBy: { type: 'string', pattern: REF_ID },
        },
      },
    },
    retired: { type: 'array', items: { type: 'string', pattern: REF_ID }, uniqueItems: true },
  },
} as const;
