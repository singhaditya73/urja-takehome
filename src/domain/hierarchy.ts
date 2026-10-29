/**
 * Builds a canonical network tree from per-meter hierarchy chains.
 *
 * The portal hands us a denormalized chain per meter (zone -> ... -> dt), and
 * the chains disagree with each other and with the DT master list: codes show
 * up blank, the same code carries different names on different meters
 * (DT-007 is both "Old Malviya Nagar Xfmr" and "Sanganer DT 7"), and the same
 * subdivision sits under different divisions depending on the meter.
 *
 * Strategy: majority vote per (level, code) for names, majority vote for the
 * parent, and record every disagreement instead of hiding it. Blank codes are
 * skipped (a node with no code can't be pinned in a tree); their meters still
 * count on the levels we could resolve.
 */

export interface ChainEntry {
  code: string;
  name: string;
}
export type MeterChain = Partial<Record<HierarchyLevel, ChainEntry>>;

export const HIERARCHY_LEVELS = [
  'zone',
  'circle',
  'division',
  'subdivision',
  'substation',
  'feeder',
  'dt'
] as const;
export type HierarchyLevel = (typeof HIERARCHY_LEVELS)[number];

export interface ResolvedNode {
  level: HierarchyLevel;
  code: string;
  name: string;
  name_variants: string[];
  parent_level: HierarchyLevel | null;
  parent_code: string | null;
  parent_conflict: boolean; // meters disagree about this node's parent
  unresolved_parents: number; // chains where the parent link is missing entirely
  meter_count: number;
}

interface Acc {
  names: Map<string, number>;
  parents: Map<string, number>; // key `${parent_level}:${parent_code}`
  unresolvedParents: number; // meters whose chain leaves this node's parent blank
  meters: number;
}

function isBlank(v: string | undefined | null): boolean {
  return v === undefined || v === null || v.trim() === '';
}

export function buildHierarchy(chains: MeterChain[]): { nodes: ResolvedNode[]; conflicts: number } {
  const acc = new Map<string, Acc>();

  const levelIndex = (lvl: HierarchyLevel): number => HIERARCHY_LEVELS.indexOf(lvl);

  for (const chain of chains) {
    for (const lvl of HIERARCHY_LEVELS) {
      const entry = chain[lvl];
      if (!entry || isBlank(entry.code)) continue;
      const key = `${lvl}\u0000${entry.code}`;
      let node = acc.get(key);
      if (!node) {
        node = { names: new Map(), parents: new Map(), meters: 0, unresolvedParents: 0 };
        acc.set(key, node);
      }
      if (!isBlank(entry.name)) {
        node.names.set(entry.name, (node.names.get(entry.name) ?? 0) + 1);
      }
      node.meters += 1;

      // Parent is the IMMEDIATE level above. If that level exists in the chain
      // but carries a blank code, the parent is unknown — we record that as an
      // unresolved link rather than skipping a level (a DT under a substation
      // would silently misplace two levels of the network).
      const idx = levelIndex(lvl);
      if (idx === 0) continue;
      const parentLevel = HIERARCHY_LEVELS[idx - 1];
      const parentEntry = chain[parentLevel as HierarchyLevel];
      if (parentEntry && !isBlank(parentEntry.code)) {
        const pk = `${parentLevel}\u0000${parentEntry.code}`;
        node.parents.set(pk, (node.parents.get(pk) ?? 0) + 1);
      } else {
        node.unresolvedParents += 1;
      }
    }
  }

  const nodes: ResolvedNode[] = [];
  let conflicts = 0;
  for (const [key, data] of acc) {
    const [level, code] = key.split('\u0000') as [string, string];
    const names = [...data.names.entries()].sort((a, b) => b[1] - a[1]);
    const topName = names[0]?.[0] ?? code;
    const variants = names.slice(1).map(([n]) => n);

    let parentLevel: HierarchyLevel | null = null;
    let parentCode: string | null = null;
    let parentConflict = false;
    if (data.parents.size > 0) {
      const parents = [...data.parents.entries()].sort((a, b) => b[1] - a[1]);
      const top = parents[0];
      if (top) {
        const [lvl, code] = top[0].split('\u0000') as [string, string];
        parentLevel = lvl as HierarchyLevel;
        parentCode = code;
        parentConflict = parents.length > 1;
      }
    }
    if (variants.length > 0 || parentConflict) conflicts += 1;

    nodes.push({
      level: level as HierarchyLevel,
      code,
      name: topName,
      name_variants: variants,
      parent_level: parentLevel,
      parent_code: parentCode,
      parent_conflict: parentConflict,
      unresolved_parents: data.unresolvedParents,
      meter_count: data.meters
    });
  }

  nodes.sort((a, b) =>
    (HIERARCHY_LEVELS.indexOf(a.level) - HIERARCHY_LEVELS.indexOf(b.level)) || a.code.localeCompare(b.code)
  );
  return { nodes, conflicts };
}
