/**
 * EVIDENCE GRAPH — nodes and relationships supporting every AI decision.
 * Vendor → Contract → PO → Invoice → Payment → Bank Txn → GL Txn → Journal → Policy.
 * Traversal utilities power the Evidence UI and CFO Copilot grounding.
 */
import type { DatabaseSync } from 'node:sqlite';
import { jparse, newId, nowIso } from '../../database/src/db.ts';

export interface GraphNode {
  id: string;
  entity_type: string;
  external_ref: string | null;
  label: string;
  amount: number | null;
  timestamp: string | null;
  metadata: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  relationship: string;
  metadata: Record<string, unknown>;
}

export interface GraphView {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const nodeStmtCache = new Map<DatabaseSync, { node: import('node:sqlite').StatementSync; edge: import('node:sqlite').StatementSync }>();

function stmts(db: DatabaseSync) {
  let s = nodeStmtCache.get(db);
  if (!s) {
    s = {
      node: db.prepare(`SELECT id, entity_type, external_ref, label, amount, timestamp, metadata_json FROM financial_entities WHERE id = ?`),
      edge: db.prepare(`SELECT id, from_entity, to_entity, relationship, metadata_json FROM financial_relationships WHERE from_entity = ? OR to_entity = ?`),
    };
    nodeStmtCache.set(db, s);
  }
  return s;
}

function toNode(row: { id: string; entity_type: string; external_ref: string | null; label: string; amount: number | null; timestamp: string | null; metadata_json: string }): GraphNode {
  return { id: row.id, entity_type: row.entity_type, external_ref: row.external_ref, label: row.label, amount: row.amount, timestamp: row.timestamp, metadata: jparse(row.metadata_json, {}) };
}

/** BFS traversal around an entity up to `depth` hops (default 2). */
export function neighborhood(db: DatabaseSync, entityId: string, depth = 2): GraphView {
  const { node, edge } = stmts(db);
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const frontier = [entityId];
  nodes.set(entityId, toNode(node.get(entityId) as never));
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      const rows = edge.all(id, id) as Array<{ id: string; from_entity: string; to_entity: string; relationship: string; metadata_json: string }>;
      for (const r of rows) {
        if (!edges.has(r.id)) edges.set(r.id, { id: r.id, from: r.from_entity, to: r.to_entity, relationship: r.relationship, metadata: jparse(r.metadata_json, {}) });
        for (const nid of [r.from_entity, r.to_entity]) {
          if (!nodes.has(nid)) {
            const row = node.get(nid) as never;
            if (row) { nodes.set(nid, toNode(row)); next.push(nid); }
          }
        }
      }
    }
    frontier.length = 0;
    frontier.push(...next);
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** Look up a financial_entity by (entity_type, external_ref). */
export function findEntity(db: DatabaseSync, entityType: string, externalRef: string): GraphNode | null {
  const row = db.prepare(`SELECT id, entity_type, external_ref, label, amount, timestamp, metadata_json FROM financial_entities WHERE entity_type = ? AND external_ref = ? LIMIT 1`).get(entityType, externalRef) as { id: string; entity_type: string; external_ref: string | null; label: string; amount: number | null; timestamp: string | null; metadata_json: string } | undefined;
  return row ? toNode(row) : null;
}

export interface EvidenceLinkInput {
  exception_id: string;
  entity_id: string;
  entity_type: string;
  relationship: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

export function linkEvidence(db: DatabaseSync, input: EvidenceLinkInput): string {
  const id = newId('ev');
  db.prepare(`INSERT INTO exception_evidence (id, exception_id, entity_id, entity_type, relationship, summary, metadata_json, created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, input.exception_id, input.entity_id, input.entity_type, input.relationship, input.summary, JSON.stringify(input.metadata ?? {}), nowIso());
  return id;
}

/** All evidence rows for an exception, joined with node labels. */
export function evidenceForException(db: DatabaseSync, exceptionId: string): Array<{ id: string; entity_id: string; entity_type: string; relationship: string; summary: string; label: string; external_ref: string | null; amount: number | null; metadata: Record<string, unknown> }> {
  const rows = db.prepare(`
    SELECT e.id, e.entity_id, e.entity_type, e.relationship, e.summary, e.metadata_json,
           f.label, f.external_ref, f.amount
    FROM exception_evidence e LEFT JOIN financial_entities f ON f.id = e.entity_id
    WHERE e.exception_id = ? ORDER BY e.created_at`).all(exceptionId) as Array<{ id: string; entity_id: string; entity_type: string; relationship: string; summary: string; metadata_json: string; label: string | null; external_ref: string | null; amount: number | null }>;
  return rows.map((r) => ({ id: r.id, entity_id: r.entity_id, entity_type: r.entity_type, relationship: r.relationship, summary: r.summary, label: r.label ?? '(node removed)', external_ref: r.external_ref, amount: r.amount, metadata: jparse(r.metadata_json, {}) }));
}

/** Count of evidence items for an exception (policy EVIDENCE_REQUIRED). */
export function evidenceCount(db: DatabaseSync, exceptionId: string): number {
  return (db.prepare(`SELECT COUNT(*) c FROM exception_evidence WHERE exception_id = ?`).get(exceptionId) as { c: number }).c;
}
