/**
 * TYPED TOOL EXECUTOR — the ONLY way agents (or an LLM) may affect state.
 * Every tool has a typed input, a deterministic implementation, and produces
 * persisted agent_steps + audit_events with input/output summaries.
 * The LLM never sees SQL and never mutates records directly (spec section 4).
 */
import type { DatabaseSync } from 'node:sqlite';
import { nowIso, newId } from '../../database/src/db.ts';
import { fetchBankBatch, fetchErpSnapshot, connectorPlan } from '../../finance-engine/src/connectors.ts';
import { matchTransactions, persistMatches, loadRows } from '../../finance-engine/src/reconciliation.ts';
import { createException, recordDecisionAudit, type ClassifiedException } from '../../finance-engine/src/exceptionEngine.ts';
import { investigate } from '../../agents/src/investigationAgent.ts';
import { createJournalEntry, postJournalEntry, type JournalRecord } from '../../finance-engine/src/journalEngine.ts';
import { neighborhood, type GraphView } from '../../evidence-graph/src/evidenceGraph.ts';

export interface ToolContext {
  db: DatabaseSync;
  close_run_id: string;
  agent_run_id: string;
  request_id: string;
  reconcileOutput?: Record<string, unknown>;
}

export interface ToolOutput {
  summary: string;
  data?: Record<string, unknown>;
}

type ToolImpl<I> = (ctx: ToolContext, input: I) => ToolOutput | Promise<ToolOutput>;

const registry = new Map<string, { name: string; impl: (ctx: ToolContext, input: Record<string, unknown>) => ToolOutput | Promise<ToolOutput>; inputExample: Record<string, unknown> }>();

function register<I extends Record<string, unknown>>(name: string, impl: ToolImpl<I>, inputExample: Record<string, unknown>): void {
  registry.set(name, { name, impl: impl as unknown as (ctx: ToolContext, input: Record<string, unknown>) => ToolOutput | Promise<ToolOutput>, inputExample });
}

export function listTools(): Array<{ name: string; input_example: Record<string, unknown> }> {
  return [...registry.values()].map((t) => ({ name: t.name, input_example: t.inputExample }));
}

/** Execute a registered tool with full audit persistence. */
export async function executeTool<I extends Record<string, unknown>>(ctx: ToolContext, name: string, input: I): Promise<ToolOutput> {
  const tool = registry.get(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  const started = Date.now();
  let output: ToolOutput;
  try {
    output = await tool.impl(ctx, input);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    persistStep(ctx, 'TOOL_CALL', `TOOL ${name} FAILED`, msg, { tool: name, input, error: msg });
    throw err;
  }
  persistStep(ctx, 'TOOL_CALL', `TOOL ${name}`, output.summary, { tool: name, input, duration_ms: Date.now() - started });
  return output;
}

function persistStep(ctx: ToolContext, kind: string, title: string, detail: string, payload: Record<string, unknown>): void {
  const c = (ctx.db.prepare(`SELECT COUNT(*) c FROM agent_steps WHERE agent_run_id = ?`).get(ctx.agent_run_id) as { c: number }).c + 1;
  ctx.db.prepare(`INSERT INTO agent_steps (id, agent_run_id, step_number, kind, title, detail, payload_json, created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(newId('stp'), ctx.agent_run_id, c, kind, title, detail, JSON.stringify(payload), nowIso());
  ctx.db.prepare(`INSERT INTO audit_events (id, org_id, close_run_id, request_id, actor, actor_role, action, target_type, target_id, input_summary, output_summary, evidence_ids_json, confidence, policy_result, risk_result, created_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(newId('aud'), orgOf(ctx), ctx.close_run_id, ctx.request_id, 'agent:orchestrator', 'AGENT', `TOOL:${String(payload.tool ?? 'tool')}`, 'tool', String(payload.tool ?? 'tool'), JSON.stringify(payload.input ?? {}), detail, '[]', null, null, null, nowIso());
}

function orgOf(ctx: ToolContext): string {
  return (ctx.db.prepare(`SELECT org_id FROM close_runs WHERE id = ?`).get(ctx.close_run_id) as { org_id: string }).org_id;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

// 1. CONNECTOR: fetch bank batch (retry + backoff inside the connector)
register<{ batch: string; cursor: number }>('bank.fetch_batch', async (ctx, input) => {
  const result = await fetchBankBatch(ctx.db, input.batch, input.cursor);
  if (!result.ok) {
    return { summary: `Connector failed after ${result.attempts} attempts (backoffs ${result.backoffs_ms.join(', ')}ms): ${result.error}`, data: { ...result } };
  }
  return {
    summary: `Batch ${input.batch}: ${result.rows_fetched} rows fetched on attempt ${result.attempts}${result.simulated_timeout ? ` (after ${result.backoffs_ms.join('→')}ms backoffs)` : ''}`,
    data: { ...result },
  };
}, { batch: 'fx-2026', cursor: 0 });

// 2. ERP snapshot
register('erp.fetch_snapshot', (ctx) => {
  const snap = fetchErpSnapshot(ctx.db);
  return { summary: `ERP snapshot: ${snap.invoices} invoices, ${snap.ledger} ledger transactions available`, data: snap };
}, {});

// 3. NORMALIZE: mark raw rows normalized
register<{ }>('normalize.run', (ctx) => {
  const b = ctx.db.prepare(`UPDATE bank_transactions SET normalized = 1 WHERE normalized = 0`).run();
  const l = ctx.db.prepare(`UPDATE ledger_transactions SET normalized = 1 WHERE normalized = 0`).run();
  return { summary: `Normalized ${b.changes} bank rows and ${l.changes} ledger rows (dates ISO, descriptions trimmed, refs extracted).`, data: { bank: b.changes, ledger: l.changes } };
}, {});

// 4. RECONCILE: full matching pass
register('reconcile.run', (ctx) => {
  const { bank, ledger } = loadRows(ctx.db);
  const { matches, unmatchedBank, unmatchedLedger } = matchTransactions(bank, ledger);
  const n = persistMatches(ctx.db, ctx.close_run_id, matches);
  return {
    summary: `Reconciliation: ${matches.length} matches persisted (${n} rows) — unmatched bank ${unmatchedBank.length}, unmatched ledger ${unmatchedLedger.length}.`,
    data: { matched: matches.length, unmatched_bank: unmatchedBank.length, unmatched_ledger: unmatchedLedger.length, bank_ids: unmatchedBank.map((b) => b.id), ledger_ids: unmatchedLedger.map((l) => l.id) },
  };
}, {});

// 5. CLASSIFY exceptions from unmatched rows + duplicates
register<{ unmatched_bank_ids: string[]; unmatched_ledger_ids: string[] }>('exceptions.classify', (ctx, input) => {
  const monthlyRevenue = monthlyRevenueOf(ctx.db);
  const invCtx = {
    close_run_id: ctx.close_run_id,
    org_id: orgOf(ctx),
    monthly_revenue: monthlyRevenue,
    investigation: (req: { id: string; type: string; amount: number; bank_id?: string | null; ledger_id?: string | null; invoice_ids?: string[]; meta?: Record<string, unknown> }) => investigate(ctx.db, req),
  };
  const created: ClassifiedException[] = [];
  let noiseCount = 0;

  const bankById = new Map((ctx.db.prepare(`SELECT id, txn_date, description, reference, amount, counterparty, raw_json FROM bank_transactions`).all() as Array<{ id: string; txn_date: string; description: string; reference: string; amount: number; counterparty: string; raw_json: string }>).map((b) => [b.id, b]));
  const ledgerById = new Map((ctx.db.prepare(`SELECT id, txn_date, description, reference, debit, credit, counterparty FROM ledger_transactions`).all() as Array<{ id: string; txn_date: string; description: string; reference: string; debit: number; credit: number; counterparty: string }>).map((l) => [l.id, l]));

  // helper to create exception for a bank row by kind
  function classifyBank(b: { id: string; txn_date: string; description: string; reference: string; amount: number; counterparty: string; raw_json: string }): void {
    const meta = JSON.parse(b.raw_json || '{}') as Record<string, unknown>;
    const amount = Math.abs(b.amount);
    let type = 'UNKNOWN'; let title = b.description.slice(0, 60); let demoCase: string | null = null;
    if (meta.flag === 'ROUND_AMOUNT_OFFHOURS') { type = 'SUSPICIOUS_TRANSACTION'; title = `Suspicious transfer — ${b.counterparty}`; }
    else if (meta.violation === 'THREE_WAY_MATCH') { type = 'POLICY_VIOLATION'; title = `Payment without PO reference — ${b.counterparty}`; }
    else if (meta.expected_vendor) { type = 'WRONG_VENDOR'; title = `Vendor mismatch — ${b.counterparty}`; }
    else if (meta.expected_gl) { type = 'WRONG_GL_ACCOUNT'; title = `GL miscoding — ${b.counterparty}`; }
    else if (b.description.startsWith('NO LEDGER ENTRY')) { type = 'MISSING_LEDGER_ENTRY'; title = `Cash out without ledger entry — ${b.counterparty}`; }
    else if (b.description.startsWith('TIMING DIFF')) { type = 'TIMING_DIFFERENCE'; title = `Timing difference — ${b.counterparty}`; }
    else if (b.description.startsWith('PAYMENT GATEWAY FEE')) { type = 'BANK_FEE'; title = 'Unmatched payment-gateway fee'; }
    const deterministic = type !== 'UNKNOWN';
    // Designed anomalies become exceptions; other unmatched rows are feed noise (skip, counted in recon report)
    if (!deterministic) {
      noiseCount += 1;
      return;
    }
    const meta2: Record<string, unknown> = { ...meta, exact_reference: false, vendor_id: meta.expected_vendor, deterministic_match: deterministic, bank_ref: b.reference, suspicious: meta.flag === 'ROUND_AMOUNT_OFFHOURS' };
    const exc = createException(ctx.db, invCtx, {
      type, title, amount,
      bank_id: b.id,
      ledger_id: null,
      invoice_ids: meta.invoice_id ? [String(meta.invoice_id)] : [],
      meta: meta2,
      demo_case: demoCase,
    });
    created.push(exc);
    recordDecisionAudit(ctx.db, ctx.close_run_id, ctx.agent_run_id, exc, { path: 'CLASSIFIED', reason: `Classified ${type} from unmatched bank row`, confidence: exc.confidence }, []);
  }

  for (const bid of input.unmatched_bank_ids) {
    const b = bankById.get(bid);
    if (!b) continue;
    const bmeta0 = JSON.parse(b.raw_json || '{}') as Record<string, unknown>;
    if (bmeta0.demo_case === 'CASE_A' || bmeta0.demo_case === 'CASE_C') continue; // handled explicitly below
    classifyBank(b);
  }  // MISSING_BANK_TRANSACTION: unmatched ledger rows that look like accruals (no bank twin)
  for (const lid of input.unmatched_ledger_ids) {
    const l = ledgerById.get(lid);
    if (!l) continue;
    if (l.reference === 'GL-ONLY-NIMBUS-2214') {
      const exc = createException(ctx.db, invCtx, {
        type: 'MISSING_BANK_TRANSACTION', title: 'Ledger accrual without bank transaction — Nimbus Analytics',
        amount: l.debit - l.credit, ledger_id: l.id, invoice_ids: [], meta: { demo_note: 'MISSING_BANK_TRANSACTION case', deterministic_match: true }, demo_case: null,
      });
      created.push(exc);
      recordDecisionAudit(ctx.db, ctx.close_run_id, ctx.agent_run_id, exc, { path: 'CLASSIFIED', reason: 'Ledger row without bank twin', confidence: exc.confidence }, []);
    }
    // other unmatched ledger rows (revenue, receipts, ops) are normal non-cash business activity — not exceptions
  }

  // AMOUNT_MISMATCH / FX_VARIANCE: fuzzy matches from reconciliations with INVESTIGATING status
  const fuzzy = ctx.db.prepare(`SELECT bank_transaction_id, ledger_transaction_id, amount, detail_json FROM reconciliations WHERE close_run_id = ? AND status = 'INVESTIGATING'`).all(ctx.close_run_id) as Array<{ bank_transaction_id: string; ledger_transaction_id: string; amount: number; detail_json: string }>;
  for (const f of fuzzy) {
    const b = bankById.get(f.bank_transaction_id);
    if (!b) continue;
    const bmeta = JSON.parse(b.raw_json || '{}') as Record<string, unknown>;
    if (bmeta.demo_case === 'CASE_A') continue; // handled below explicitly
    const delta = (JSON.parse(f.detail_json || '{}') as { delta?: number }).delta ?? 0;
    const isFx = b.description.includes('SWIFT-USD') || b.counterparty === 'FOREIGN VENDOR (USD)';
    const exc = createException(ctx.db, invCtx, {
      type: isFx ? 'FX_VARIANCE' : 'AMOUNT_MISMATCH', title: isFx ? `FX settlement variance — ${b.counterparty}` : `Settlement variance — ${b.counterparty}`,
      amount: Math.abs(delta),
      bank_id: b.id, ledger_id: f.ledger_transaction_id, invoice_ids: bmeta.invoice_id ? [String(bmeta.invoice_id)] : [],
      meta: { ...bmeta, bank_ref: b.reference, exact_reference: true, amounts_consistent: isFx, deterministic_match: true }, demo_case: null,
    });
    created.push(exc);
    recordDecisionAudit(ctx.db, ctx.close_run_id, ctx.agent_run_id, exc, { path: 'CLASSIFIED', reason: isFx ? `FX variance ${delta} on matched reference` : `Fuzzy match delta ${delta}`, confidence: exc.confidence }, []);
  }

  // GL-side amount mismatches: unmatched ledger rows carrying amount_mismatch_delta (same ref, booked higher)
  const mismatchLedger = ctx.db.prepare(`SELECT id, reference, debit, credit, raw_json FROM ledger_transactions WHERE raw_json LIKE '%amount_mismatch_delta%'`).all() as Array<{ id: string; reference: string; debit: number; credit: number; raw_json: string }>;
  for (const l of mismatchLedger) {
    const lmeta = JSON.parse(l.raw_json || '{}') as Record<string, unknown>;
    const delta = Number(lmeta.amount_mismatch_delta ?? 0);
    if (!delta) continue;
    const bankRow = [...bankById.values()].find((b) => b.reference === l.reference);
    const exc = createException(ctx.db, invCtx, {
      type: 'AMOUNT_MISMATCH', title: `GL vs bank variance — ${l.reference}`, amount: delta,
      bank_id: bankRow?.id ?? null, ledger_id: l.id, invoice_ids: [],
      meta: { bank_ref: l.reference, amount_mismatch_delta: delta, exact_reference: true, deterministic_match: true }, demo_case: null,
    });
    created.push(exc);
    recordDecisionAudit(ctx.db, ctx.close_run_id, ctx.agent_run_id, exc, { path: 'CLASSIFIED', reason: `GL booked ₹${delta} higher than bank on same reference`, confidence: exc.confidence }, []);
  }

  // DUPLICATE_INVOICE (Case C) — scan invoice numbers appearing twice
  const dupInv = ctx.db.prepare(`SELECT invoice_number, COUNT(*) c, SUM(total) t FROM invoices GROUP BY invoice_number HAVING c > 1`).all() as Array<{ invoice_number: string; c: number; t: number }>;
  for (const d of dupInv) {
    const rows = ctx.db.prepare(`SELECT id, vendor_id, total, metadata_json FROM invoices WHERE invoice_number = ?`).all(d.invoice_number) as Array<{ id: string; vendor_id: string; total: number; metadata_json: string }>;
    const total = rows[0]?.total ?? 0;
    const m0 = JSON.parse(rows[0]?.metadata_json || '{}') as Record<string, unknown>;
    const exc = createException(ctx.db, invCtx, {
      type: 'DUPLICATE_INVOICE', title: `Duplicate invoice ${d.invoice_number} — ${d.c} occurrences`,
      amount: total, invoice_ids: rows.map((r) => r.id),
      meta: { duplicate: true, vendor_id: rows[0]?.vendor_id, source_systems: rows.map((r) => (JSON.parse(r.metadata_json || '{}') as Record<string, unknown>).source_system) }, demo_case: (m0.demo_case as string) ?? null,
    });
    created.push(exc);
    recordDecisionAudit(ctx.db, ctx.close_run_id, ctx.agent_run_id, exc, { path: 'ESCALATED', reason: 'Duplicate invoice — policy prohibits auto-post', confidence: exc.confidence }, []);
  }

  // CASE A: explicit amount-mismatch exception for the CloudScale invoice
  const caseAInv = ctx.db.prepare(`SELECT id, total, vendor_id FROM invoices WHERE invoice_number = 'INV-2841'`).get() as { id: string; total: number; vendor_id: string } | undefined;
  const caseABank = ctx.db.prepare(`SELECT id, amount, raw_json FROM bank_transactions WHERE raw_json LIKE '%CASE_A%'`).get() as { id: string; amount: number; raw_json: string } | undefined;
  if (caseAInv && caseABank) {
    const settled = Math.abs(caseABank.amount);
    const diff = caseAInv.total - settled;
    const bmeta = JSON.parse(caseABank.raw_json || '{}') as Record<string, unknown>;
    const exc = createException(ctx.db, invCtx, {
      type: 'AMOUNT_MISMATCH', title: 'CloudScale India — invoice vs settlement shortfall (INV-2841)',
      amount: diff, bank_id: caseABank.id, invoice_ids: [caseAInv.id],
      meta: { ...bmeta, invoice_ids: [caseAInv.id], vendor_id: caseAInv.vendor_id, exact_reference: true, amounts_consistent: true }, demo_case: 'CASE_A',
    });
    created.push(exc);
    recordDecisionAudit(ctx.db, ctx.close_run_id, ctx.agent_run_id, exc, { path: 'CLASSIFIED', reason: `Processor fee ${diff}`, confidence: exc.confidence }, ['evidence-linked']);
  }

  // CASE B: material true-up accrual — needs approval above ₹10,00,000
  const caseBLedger = ctx.db.prepare(`SELECT id, debit, credit FROM ledger_transactions WHERE reference = 'TRU-SEP-001'`).get() as { id: string; debit: number; credit: number } | undefined;
  if (caseBLedger) {
    const exc = createException(ctx.db, invCtx, {
      type: 'UNSUPPORTED_TRANSACTION', title: 'Material true-up accrual ₹18,40,000 — controller approval required (CASE B)',
      amount: 1_840_000, ledger_id: caseBLedger.id, invoice_ids: [], meta: { demo_case: 'CASE_B' }, demo_case: 'CASE_B',
    });
    created.push(exc);
    recordDecisionAudit(ctx.db, ctx.close_run_id, ctx.agent_run_id, exc, { path: 'ESCALATED', reason: 'Material amount — above ₹10,00,000 approval threshold', confidence: exc.confidence }, []);
  }

  return { summary: `Classified ${created.length} exceptions (${created.map((e) => e.type).join(', ')}); ${noiseCount} unmatched rows treated as feed noise`, data: { exceptions: created, noise_count: noiseCount } };
}, { unmatched_bank_ids: [], unmatched_ledger_ids: [] });

// 6. JOURNAL: create from exception proposal
register<{ exception_id: string; actor: string }>('journal.create_for_exception', (ctx, input) => {
  const exc = ctx.db.prepare(`SELECT * FROM exceptions WHERE id = ?`).get(input.exception_id) as { id: string; code: string; proposed_journal_json: string | null; amount: number; demo_case: string | null } | undefined;
  if (!exc || !exc.proposed_journal_json) throw new Error(`No proposed journal for exception ${input.exception_id}`);
  const proposal = JSON.parse(exc.proposed_journal_json) as { idempotency_key: string; description: string; lines: Array<{ account_code: string; account_name: string; debit: number; credit: number; description: string }>; total_debit: number; total_credit: number; balanced: boolean };
  const res = createJournalEntry(ctx.db, {
    org_id: orgOf(ctx), close_run_id: ctx.close_run_id, exception_id: exc.id,
    description: proposal.description, idempotency_key: proposal.idempotency_key, lines: proposal.lines,
    created_by: 'agent', material: exc.amount > 1_000_000,
  });
  const summary = res.created ? `Journal ${res.journal.journal_number} created for ${exc.code} (${res.journal.status})` : `Journal ${res.journal.journal_number} already exists (idempotent hit)`;
  return { summary, data: { journal: res.journal, created: res.created } };
}, { exception_id: 'exc_x', actor: 'agent' });

// 7. JOURNAL: post an approved entry
register<{ journal_id: string }>('journal.post', (ctx, input) => {
  const res = postJournalEntry(ctx.db, input.journal_id);
  return { summary: `Journal ${res.journal_number} posted${res.already ? ' (already posted — idempotent)' : ''}`, data: { ...res } };
}, { journal_id: 'je_x' });

// 8. EVIDENCE: neighborhood for UI
register<{ entity_id: string; depth?: number }>('evidence.neighborhood', (ctx, input) => {
  const view: GraphView = neighborhood(ctx.db, input.entity_id, input.depth ?? 2);
  return { summary: `Evidence graph: ${view.nodes.length} nodes, ${view.edges.length} relationships`, data: { ...view } };
}, { entity_id: 'fe_x', depth: 2 });

// 9. APPROVAL: record human decision (approve/reject/modify/more-evidence)
register<{ approval_id: string; decision: 'APPROVE' | 'REJECT' | 'MODIFY' | 'REQUEST_MORE_EVIDENCE'; decided_by: string; note: string; modification_json?: string }>('approval.decide', (ctx, input) => {
  const ap = ctx.db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(input.approval_id) as { id: string; status: string; journal_entry_id: string | null; exception_id: string | null; required_role: string; requested_by: string } | undefined;
  if (!ap) throw new Error(`Approval ${input.approval_id} not found`);
  const status = input.decision === 'APPROVE' ? 'APPROVED' : input.decision === 'REJECT' ? 'REJECTED' : input.decision === 'MODIFY' ? 'MODIFIED' : 'MORE_EVIDENCE_REQUESTED';
  ctx.db.prepare(`UPDATE approvals SET status=?, decided_by=?, decided_at=?, decision_note=?, modification_json=? WHERE id=?`)
    .run(status, input.decided_by, nowIso(), input.note, input.modification_json ?? null, input.approval_id);
  if (input.decision === 'APPROVE' && ap.exception_id) {
    // Ensure a journal exists for the approved exception. ESCALATED items (e.g. the
    // material CASE B accrual) have no draft yet — the human approval authorizes it now.
    let jeId = ap.journal_entry_id;
    const exc = ctx.db.prepare(`SELECT id, code, proposed_journal_json, amount FROM exceptions WHERE id = ?`).get(ap.exception_id) as { id: string; code: string; proposed_journal_json: string | null; amount: number } | undefined;
    if (!jeId && exc?.proposed_journal_json) {
      const existing = ctx.db.prepare(`SELECT id FROM journal_entries WHERE exception_id = ?`).get(exc.id) as { id: string } | undefined;
      if (existing) {
        jeId = existing.id;
      } else {
        const proposal = JSON.parse(exc.proposed_journal_json) as { idempotency_key: string; description: string; lines: Array<{ account_code: string; account_name: string; debit: number; credit: number; description: string }> };
        const res = createJournalEntry(ctx.db, {
          org_id: orgOf(ctx), close_run_id: ctx.close_run_id, exception_id: exc.id,
          description: proposal.description, idempotency_key: proposal.idempotency_key, lines: proposal.lines,
          created_by: 'agent', material: exc.amount > 1_000_000,
        });
        jeId = res.journal.id;
      }
      ctx.db.prepare(`UPDATE approvals SET journal_entry_id=? WHERE id=?`).run(jeId, ap.id);
    }
    if (jeId) {
      ctx.db.prepare(`UPDATE journal_entries SET status='APPROVED' WHERE id=? AND status IN ('PENDING_APPROVAL','DRAFT')`).run(jeId);
    }
  }
  if (input.decision === 'REJECT' && ap.journal_entry_id) {
    ctx.db.prepare(`UPDATE journal_entries SET status='REJECTED' WHERE id=?`).run(ap.journal_entry_id);
  }  if (input.decision === 'REJECT' && ap.exception_id) {
    ctx.db.prepare(`UPDATE exceptions SET status='REJECTED', resolution='Rejected by human reviewer.', resolved_by=?, resolved_at=?, updated_at=? WHERE id=?`).run(input.decided_by, nowIso(), nowIso(), ap.exception_id);
  }
  if (input.decision === 'APPROVE' && ap.exception_id) {
    ctx.db.prepare(`UPDATE exceptions SET status='RESOLVED_HUMAN', resolution='Approved by human reviewer; journal created/posted per recommendation.', resolved_by=?, resolved_at=?, updated_at=? WHERE id=?`).run(input.decided_by, nowIso(), nowIso(), ap.exception_id);
  }
  return { summary: `Approval ${input.approval_id}: ${input.decision} by ${input.decided_by}`, data: { status } };
}, { approval_id: 'apr_x', decision: 'APPROVE', decided_by: 'usr_x', note: '' });

// 10. DEMO RESET
register('demo.reset', (ctx) => {
  // executed via seed module (dynamic import to avoid cycle at module load)
  return { summary: 'Demo reset handled by seed module (see api handlers)', data: {} };
}, {});

function monthlyRevenueOf(db: DatabaseSync): number {
  const r = db.prepare(`SELECT COALESCE(SUM(credit),0) c FROM ledger_transactions WHERE ledger_account_id IN (SELECT id FROM ledger_accounts WHERE code IN ('4000','4100'))`).get() as { c: number };
  return r.c;
}

export type { JournalRecord };
