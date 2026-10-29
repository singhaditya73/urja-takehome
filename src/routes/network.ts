import type { FastifyInstance } from 'fastify';
import * as S from '../schemas.js';
import { allHierarchyNodes, listTransformers, transformerMetersCounts } from '../store/queries.js';
import type { HierarchyNodeRow } from '../store/db.js';
import type { Services } from '../types.js';
import type { Static } from '@sinclair/typebox';

type NodeOut = Static<typeof S.HierarchyNodeOut>;

export async function networkRoutes(app: FastifyInstance, opts: { services: Services; prefix: string }): Promise<void> {
  const services = opts.services;

  app.get(
    '/network/tree',
    {
      schema: {
        response: { 200: S.NetworkTree },
        tags: ['network'],
        summary: 'Network hierarchy tree',
        description:
          'Canonical zone→DT tree reconstructed from all meter chains. Where meters disagree, majority wins and the disagreement is recorded on the node.'
      }
    },
    async () => {
      await services.index.ensureFresh();
      const rows = allHierarchyNodes(services.db);
      const byKey = new Map<string, NodeOut>();
      for (const r of rows) {
        byKey.set(`${r.level}:${r.code}`, rowToNode(r));
      }
      const data: NodeOut[] = [];
      for (const r of rows) {
        const node = byKey.get(`${r.level}:${r.code}`);
        if (!node) continue;
        if (r.parent_code && r.parent_level) {
          const parent = byKey.get(`${r.parent_level}:${r.parent_code}`);
          if (parent) {
            parent.children.push(node);
            continue;
          }
          // Parent unresolved (was blank in the source data) — orphan stays top-level.
        }
        data.push(node);
      }
      sortTree(data);
      return { data, meta: { conflicts: rows.filter((r) => r.parent_conflict === 1 || r.name_variants !== '[]').length } };
    }
  );

  app.get(
    '/network/transformers',
    {
      schema: {
        response: { 200: S.TransformerList },
        tags: ['network'],
        summary: 'Distribution transformers',
        description: 'The portal\u2019s DT master list, enriched with meter counts from our index.'
      }
    },
    async () => {
      await services.index.ensureFresh();
      const rows = listTransformers(services.db);
      const counts = transformerMetersCounts(services.db);
      return {
        data: rows.map((t) => ({
          code: t.code,
          name: t.name,
          feeder_code: t.feeder_code,
          capacity_kva: t.capacity_kva,
          meter_count: counts[t.code] ?? 0
        })),
        total: rows.length
      };
    }
  );
}

function rowToNode(r: HierarchyNodeRow): NodeOut {
  let variants: string[] = [];
  try {
    variants = JSON.parse(r.name_variants) as string[];
  } catch {
    variants = [];
  }
  return {
    level: r.level,
    code: r.code,
    name: r.name,
    name_variants: variants,
    parent_code: r.parent_code,
    parent_conflict: r.parent_conflict === 1,
    unresolved_parents: r.unresolved_parents ?? 0,
    meter_count: r.meter_count,
    children: []
  };
}

function sortTree(nodes: NodeOut[]): void {
  nodes.sort((a, b) => a.code.localeCompare(b.code));
  for (const n of nodes) sortTree(n.children);
}
