/**
 * SMOKE: full workflow without the HTTP layer.
 * migrate → seed → create close → orchestrate → (human pause) → decide → resume → complete.
 */
import { getMemoryDb, runSchema } from '../../packages/database/src/db.ts';
import { seedDemoData } from '../../packages/database/src/seed.ts';
import { createCloseRun, orchestrate, type OrchestrateResult } from '../../packages/workflow/src/orchestrator.ts';
import { executeTool } from '../../packages/workflow/src/tools.ts';

const db = getMemoryDb();
runSchema(db);
const seed = seedDemoData(db, 2026);
console.log('[smoke] seeded:', JSON.stringify({ bank: seed.bank_txns, ledger: seed.ledger_txns }));

const closeRunId = createCloseRun(db, '2026-09');
console.log('[smoke] close run:', closeRunId);

let result: OrchestrateResult = await orchestrate(db, closeRunId);
console.log('[smoke] phase 1:', result.status, result.paused_for_human ? `paused: ${result.paused_for_human.reason}` : '');

// loop: decide pending approvals like the UI does (stop once the close completes)
let guard = 0;
while (guard++ < 20) {
  const runStatus = (db.prepare(`SELECT status FROM close_runs WHERE id=?`).get(closeRunId) as { status: string }).status;
  if (runStatus === 'COMPLETED') break;
  const pending = db.prepare(`SELECT ap.id, ap.exception_id, ap.journal_entry_id, ap.required_role, e.title, e.amount FROM approvals ap LEFT JOIN exceptions e ON e.id = ap.exception_id WHERE ap.status = 'PENDING' ORDER BY e.amount DESC`).all() as unknown as Array<{ id: string; exception_id: string | null; journal_entry_id: string | null; required_role: string; title: string; amount: number }>;
  if (pending.length === 0) {
    result = await orchestrate(db, closeRunId);
    if (result.status === 'COMPLETED') break;
    continue;
  }
  const ap = pending[0]!;
  const decision = ap.amount >= 4_000_000 || /duplicate|suspicious/i.test(ap.title) ? 'REJECT' : 'APPROVE';
  console.log(`[smoke] human ${decision}: ${ap.title} (₹${ap.amount.toLocaleString('en-IN')}) as ${ap.required_role}`);
  await executeTool(ctxFor(db, closeRunId), 'approval.decide', { approval_id: ap.id, decision, decided_by: `user:controller`, note: 'Demo decision' });
  result = await orchestrate(db, closeRunId);
  console.log('[smoke] resumed:', result.status, result.paused_for_human ? `paused again: ${result.paused_for_human.reason}` : '');
}

// verify end state
const run = db.prepare(`SELECT status, progress FROM close_runs WHERE id=?`).get(closeRunId) as { status: string; progress: number };
console.log('[smoke] final run status:', run.status, run.progress);

function ctxFor(db: import('node:sqlite').DatabaseSync, closeRunId: string): Parameters<typeof executeTool>[0] {
  const id = 'arun_human_' + Math.random().toString(36).slice(2, 8);
  db.prepare(`INSERT INTO agent_runs (id, close_run_id, agent, purpose, status, input_summary, attempt, started_at) VALUES (?,?, 'ORCHESTRATOR', 'Human decision recording', 'RUNNING', 'Human review session', 1, ?)`)
    .run(id, closeRunId, new Date().toISOString());
  return { db, close_run_id: closeRunId, agent_run_id: id, request_id: 'human-review' };
}

const je = db.prepare(`SELECT journal_number, status, amount FROM journal_entries ORDER BY created_at`).all() as unknown as Array<{ journal_number: string; status: string; amount: number }>;
console.log('[smoke] journals:', JSON.stringify(je));

const excSummary = db.prepare(`SELECT status, COUNT(*) c FROM exceptions GROUP BY status`).all() as unknown as Array<{ status: string; c: number }>;
console.log('[smoke] exception statuses:', JSON.stringify(excSummary));

if (run.status !== 'COMPLETED') {
  console.error('[smoke] FAIL: run did not complete');
  process.exit(1);
}
console.log('[smoke] PASS');
