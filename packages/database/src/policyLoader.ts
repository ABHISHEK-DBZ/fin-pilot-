/**
 * Policy catalog loader: parses data/policies/*.yaml and upserts into accounting_policies.
 * Policies are configurable at runtime (Policies UI) — thresholds visible & editable
 * by CFO/Controller per spec section 4.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from './yaml.ts';
import { nowIso, newId } from './db.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface PolicyDef {
  id: string;
  org_id: string;
  code: string;
  name: string;
  description: string;
  category: string;
  parameters_json: string;
  active: number;
  version: number;
  updated_at: string;
  created_at: string;
}

interface CatalogShape {
  policies?: Array<{
    code?: string;
    name?: string;
    description?: string;
    category?: string;
    parameters?: Record<string, unknown>;
  }>;
}

export interface PolicyCatalogEntry {
  code: string;
  name: string;
  description: string;
  category: string;
  parameters: Record<string, unknown>;
}

export function loadPolicyCatalog(): PolicyCatalogEntry[] {
  const dir = path.join(__dirname, '..', '..', '..', 'data', 'policies');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')) : [];
  const all: PolicyCatalogEntry[] = [];
  for (const f of files) {
    const parsed = parseYaml(fs.readFileSync(path.join(dir, f), 'utf-8')) as CatalogShape;
    for (const p of parsed.policies ?? []) {
      if (p.code) {
        all.push({ code: p.code, name: p.name ?? p.code, description: p.description ?? '', category: p.category ?? 'GENERAL', parameters: p.parameters ?? {} });
      }
    }
  }
  return all;
}

export function upsertPolicies(db: import('node:sqlite').DatabaseSync, orgId: string): number {
  const defs = loadPolicyCatalog();
  const now = nowIso();
  let n = 0;
  for (const p of defs) {
    const existing = db.prepare(`SELECT id, version FROM accounting_policies WHERE code = ?`).get(p.code) as { id: string; version: number } | undefined;
    if (existing) {
      db.prepare(`UPDATE accounting_policies SET name=?, description=?, category=?, parameters_json=?, active=1, updated_at=? WHERE id=?`)
        .run(p.name, p.description, p.category, JSON.stringify(p.parameters), now, existing.id);
    } else {
      db.prepare(`INSERT INTO accounting_policies (id, org_id, code, name, description, category, parameters_json, active, version, updated_at, created_at)
                  VALUES (?,?,?,?,?,?,?,1,1,?,?)`)
        .run(newId('pol'), orgId, p.code, p.name, p.description, p.category, JSON.stringify(p.parameters), now, now);
    }
    n += 1;
  }
  return n;
}
