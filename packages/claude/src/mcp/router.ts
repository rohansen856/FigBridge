import { dirname, sep } from 'node:path';
import { glob } from 'tinyglobby';
import { findManifestRoot, MANIFEST_FILENAME, Scanner } from '@figbridge/core';
import { DiskIndexer } from './indexer.js';
import { normalizeRelPath, Tools } from './tools.js';

const DISCOVERY_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/build/**',
  '**/dist/**',
  '**/out/**',
  '**/.dart_tool/**',
  '**/.next/**',
  '**/Pods/**',
];

type ToolResult = Record<string, unknown>;

/**
 * Spreads tool calls across every FigBridge project under the Claude project root:
 * - an enclosing manifest (the root or an ancestor) makes a single project;
 * - otherwise one project per `figma.design.yaml` below the root, plus a link-only project at
 *   the root that skips the nested ones.
 * All paths in and out are relative to the Claude project root.
 */
export class ProjectRouter {
  private constructor(
    readonly start: string,
    private readonly projects: Array<{ prefix: string; tools: Tools; indexer: DiskIndexer }>,
  ) {}

  static async create(start: string, scanner: Scanner): Promise<ProjectRouter> {
    const enclosing = findManifestRoot(start);
    if (enclosing) {
      // The project root is above the start directory: paths stay relative to that root.
      const indexer = new DiskIndexer(enclosing, scanner);
      return new ProjectRouter(enclosing, [{ prefix: '', tools: new Tools(indexer), indexer }]);
    }
    const found = await glob(`**/${MANIFEST_FILENAME}`, {
      cwd: start,
      ignore: DISCOVERY_IGNORE,
      followSymbolicLinks: false,
      onlyFiles: true,
      deep: 8,
    });
    const nested = found
      .map((f) => dirname(f).split(sep).join('/'))
      .filter((d) => d !== '.')
      .sort();
    const projects = nested.map((dir) => {
      const inner = nested
        .filter((o) => o !== dir && o.startsWith(`${dir}/`))
        .map((o) => o.slice(dir.length + 1));
      const indexer = new DiskIndexer(`${start}/${dir}`, scanner, inner);
      return { prefix: `${dir}/`, tools: new Tools(indexer, `${dir}/`), indexer };
    });
    const rootIndexer = new DiskIndexer(start, scanner, nested);
    projects.push({ prefix: '', tools: new Tools(rootIndexer, ''), indexer: rootIndexer });
    return new ProjectRouter(start, projects);
  }

  /** Projects ordered with the most specific (longest prefix) first. */
  private ordered() {
    return [...this.projects].sort((a, b) => b.prefix.length - a.prefix.length);
  }

  private projectSummary() {
    return this.projects.map((p) => ({ root: p.prefix || '.', manifest: !p.indexer.linksOnly }));
  }

  async resolveRef(refId: string): Promise<ToolResult> {
    let fallback: ToolResult | undefined;
    const unresolvedOccurrences: unknown[] = [];
    for (const p of this.ordered()) {
      const r = (await p.tools.resolveRef(refId)) as ToolResult;
      if (r.found) return { ...r, project: p.prefix || '.' };
      if (Array.isArray(r.occurrences)) unresolvedOccurrences.push(...r.occurrences);
      if (!fallback || (fallback.reason === 'no-manifest' && r.reason !== 'no-manifest')) fallback = r;
    }
    return {
      ...fallback!,
      ...(unresolvedOccurrences.length ? { occurrences: unresolvedOccurrences.slice(0, 20) } : {}),
      projects: this.projectSummary(),
    };
  }

  async searchRefs(args: {
    query?: string;
    fileAlias?: string;
    tag?: string;
    status?: 'used' | 'unused' | 'unresolved' | 'deprecated';
    limit?: number;
    cursor?: number;
  }): Promise<ToolResult> {
    const limit = Math.min(100, Math.max(1, args.limit ?? 25));
    const offset = Math.max(0, args.cursor ?? 0);
    const all: unknown[] = [];
    let base: ToolResult | undefined;
    for (const p of this.ordered()) {
      if (p.indexer.linksOnly && args.status !== 'unresolved') {
        await p.indexer.refresh();
        continue; // no manifest, nothing to list
      }
      const r = (await p.tools.searchRefs({ ...args, limit: 100, cursor: 0 })) as ToolResult & {
        results: unknown[];
      };
      base ??= r;
      for (const item of r.results) all.push({ ...(item as object), project: p.prefix || '.' });
    }
    const page = all.slice(offset, offset + limit);
    // Per-project envelope fields (manifestPath, manifestState) don't apply to merged results.
    const { manifestPath: _mp, manifestState: _ms, ...shared } = base ?? {};
    return {
      ...shared,
      total: all.length,
      results: page,
      ...(offset + limit < all.length ? { nextCursor: offset + limit } : {}),
      projects: this.projectSummary(),
    };
  }

  async refsForSource(args: { path: string; line?: number }): Promise<ToolResult> {
    const path = normalizeRelPath(args.path);
    const owner = path ? this.ordered().find((p) => !p.prefix || path.startsWith(p.prefix)) : undefined;
    if (!path || !owner) return (await this.projects[0]!.tools.refsForSource(args)) as ToolResult;
    const r = (await owner.tools.refsForSource({
      ...args,
      path: path.slice(owner.prefix.length),
    })) as ToolResult;
    return { ...r, path, project: owner.prefix || '.' };
  }

  async health(): Promise<ToolResult> {
    const perProject: unknown[] = [];
    const problems: unknown[] = [];
    const totals: Record<string, number> = {};
    for (const p of this.ordered()) {
      const h = (await p.tools.health()) as unknown as ToolResult & {
        summary: Record<string, unknown>;
        problems: Array<Record<string, unknown>>;
        manifestDiagnostics: unknown[];
      };
      if (p.indexer.linksOnly && !(h.summary.occurrences as number)) continue; // empty link-only root
      perProject.push({
        project: p.prefix || '.',
        manifest: !p.indexer.linksOnly,
        summary: h.summary,
        ...(p.indexer.linksOnly ? {} : { manifestDiagnostics: h.manifestDiagnostics }),
      });
      for (const pr of h.problems)
        problems.push({
          ...pr,
          project: p.prefix || '.',
          ...(pr.path ? { path: p.prefix + String(pr.path) } : {}),
        });
      for (const [k, v] of Object.entries(h.summary))
        if (typeof v === 'number') totals[k] = (totals[k] ?? 0) + v;
    }
    return {
      totals,
      projects: perProject,
      problems: problems.slice(0, 50),
      ...(problems.length > 50 ? { moreProblems: problems.length - 50 } : {}),
      ...(perProject.length === 0
        ? { message: `No ${MANIFEST_FILENAME} and no @figma link annotations were found under this project.` }
        : {}),
    };
  }
}
