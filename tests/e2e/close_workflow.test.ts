/**
 * PHASE 12 E2E TEST — complete month-end close, headless (no HTTP).
 * migrate → seed → close run → orchestrate → human decisions → complete → verify.
 * Asserts every mandatory spec behavior:
 *   - Case A: CloudScale ₹18,000 fee found, balanced JE proposed+posted, auto-resolved
 *   - Case B: material ₹18,40,000 JE pauses for CONTROLLER approval, resumes, posts
 *   - Case C: duplicate INV-7721 escalated, NOT auto-posted
 *   - Case 4: connector timeout retried with backoff, close resumes without duplicates
 *   - All journals balanced; posting idempotent; audit package certifies the close
 */
import assert from 'node:assert/strict';
import { getMemoryDb, runSchema } from '../../packages/database/src/db.ts';
import { seedDemoData } from '../../packages/database/src/seed.ts';
import { createCloseRun, orchestrate } from '../../packages/workflow/src/orchestrator.ts';
import { executeTool } from '../../packages/workflow/src/tools.ts';
import { generateAuditPackage } from '../../packages/workflow/src/auditPackage.ts';
import { computeMetrics } from '../../packages/workflow/src/metrics.ts';
import { connectorPlan, fetchBankBatch } from '../../packages/finance-engine/src/connectors.ts';

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(`${name} ${detail}`);
    console.log(`FAIL  ${name} ${detail}`);
  }
}

const db = getMemoryDb();
runSchema(db);
const seed = seedDemoData(db, 2026);

// ---- CASE 4 first: connector timeout + backoff, no duplicate ingestion ----
const plan = connectorPlan();
const batch = plan.bank_timeout_batches[0]!;
const r1 = await fetchBankBatch(db, batch, 0);
check('CASE 4: connector timeout batch recovers via retry with backoff', r1.ok === true && r1.attempts > 1, JSON.stringify({ attempts: r1.attempts }));
const before = (db.prepare(`SELECT COUNT(*) c FROM bank_transactions`).get() as { c: number }).c;
await fetchBankBatch(db, batch, 0);
await fetchBankBatch(db, batch, 0);
const after = (db.prepare(`SELECT COUNT(*) c FROM bank_transactions`).get() as { c: number }).c;
check('CASE 4: repeated connector calls do not duplicate ingested rows', before === after, `${before} vs ${after}`);

// ---- Full close ----
const closeRunId = createCloseRun(db, '2026-09');
let result = await orchestrate(db, closeRunId);
console.log(`[e2e] orchestrate #1: ${result.status}${result.paused_for_human ? ` — paused: ${result.paused_for_human.reason}` : ''}`);

// Human decision loop (Controller/CFO behaviour, like the UI)
let approvalsGiven = 0;
let rejectionsGiven = 0;
let sawControllerPause = false;
for (let guard = 0; guard < 30; guard++) {
  const run = db.prepare(`SELECT status FROM close_runs WHERE id=?`).get(closeRunId) as { status: string };
  if (run.status === 'COMPLETED') break;
  const pending = db.prepare(`
    SELECT ap.id, ap.exception_id, ap.journal_entry_id, ap.required_role, e.title, e.amount, e.type
    FROM approvals ap LEFT JOIN exceptions e ON e.id = ap.exception_id
    WHERE ap.status='PENDING' ORDER BY e.amount DESC`).all() as unknown as Array<{ id: string; exception_id: string | null; journal_entry_id: string | null; required_role: string; title: string; amount: number; type: string }>;
  if (pending.length === 0) {
    result = await orchestrate(db, closeRunId);
    continue;
  }
  for (const ap of pending) {
    const duplicate = /duplicate/i.test(ap.title) || (ap.type ?? '').includes('DUPLICATE');
    const suspicious = /suspicious/i.test(ap.title) || (ap.type ?? '').includes('SUSPICIOUS');
    const decision = duplicate || suspicious ? 'REJECT' : 'APPROVE';
    if (ap.amount >= 1_000_000) sawControllerPause = true;
    console.log(`[e2e] human ${decision} (${ap.required_role}): ${ap.title} (₹${ap.amount.toLocaleString('en-IN')})`);
    await executeTool(ctxFor(db, closeRunId), 'approval.decide', { approval_id: ap.id, decision, decided_by: 'user:controller-e2e', note: 'E2E decision' });
    if (decision === 'APPROVE') approvalsGiven += 1; else rejectionsGiven += 1;
  }
  result = await orchestrate(db, closeRunId);
}

const run = db.prepare(`SELECT status, progress FROM close_runs WHERE id=?`).get(closeRunId) as { status: string; progress: number };
console.log(`[e2e] final: ${run.status} @ ${run.progress}% — approvals ${approvalsGiven}, rejections ${rejectionsGiven}`);

check('close run reaches COMPLETED at 100%', run.status === 'COMPLETED' && run.progress === 100, `${run.status} @ ${run.progress}`);
check('material case paused the workflow for CONTROLLER approval', sawControllerPause);
check('at least one approval and one rejection were exercised', approvalsGiven >= 1 && rejectionsGiven >= 1);

// ---- CASE A verification ----
const caseA = db.prepare(`SELECT id, status, finding, recommendation FROM exceptions WHERE title LIKE '%CloudScale%INV-2841%' OR title LIKE '%INV-2841%' LIMIT 1`).get() as { id: string; status: string; finding: string; recommendation: string } | undefined;
check('CASE A: CloudScale INV-2841 exception exists and is auto-resolved', !!caseA && caseA.status === 'RESOLVED_AUTO', caseA?.status ?? 'missing');
check('CASE A: investigation identifies the payment-processing fee', !!caseA && /fee/i.test(`${caseA.finding} ${caseA.recommendation}`), `${caseA?.finding?.slice(0, 60)} … ${caseA?.recommendation?.slice(0, 60)}`);
const caseAJE = caseA ? db.prepare(`
  SELECT je.id, je.status, je.total_debit, je.total_credit FROM journal_entries je
  JOIN exceptions e ON e.id = je.exception_id WHERE e.id = ?`).get(caseA.id) as { id: string; status: string; total_debit: number; total_credit: number } | undefined : undefined;
check('CASE A: balanced journal entry posted (Dr fees+GST / Cr cash)', !!caseAJE && caseAJE.status === 'POSTED' && caseAJE.total_debit === caseAJE.total_credit, caseAJE ? `${caseAJE.status} ${caseAJE.total_debit}/${caseAJE.total_credit}` : 'no JE');

// ---- CASE B verification ----
const caseB = db.prepare(`SELECT id, status, amount FROM exceptions WHERE title LIKE '%18,40,000%' OR amount = 1840000 LIMIT 1`).get() as { id: string; status: string; amount: number } | undefined;
check('CASE B: ₹18,40,000 accrual exception exists', !!caseB && caseB.amount === 1_840_000, caseB ? String(caseB.amount) : 'missing');
const caseBApproval = caseB ? db.prepare(`SELECT status, decided_by, decision_note FROM approvals WHERE exception_id = ? ORDER BY created_at DESC LIMIT 1`).get(caseB.id) as { status: string; decided_by: string; decision_note: string } | undefined : undefined;
check('CASE B: human APPROVE recorded by controller', !!caseBApproval && caseBApproval.status === 'APPROVED', caseBApproval ? JSON.stringify(caseBApproval) : 'no approval');
const caseBJE = caseB ? db.prepare(`SELECT status, total_debit, total_credit FROM journal_entries WHERE exception_id = ?`).get(caseB.id) as { status: string; total_debit: number; total_credit: number } | undefined : undefined;
check('CASE B: approved journal entry posted and balanced', !!caseBJE && caseBJE.status === 'POSTED' && caseBJE.total_debit === caseBJE.total_credit, caseBJE ? caseBJE.status : 'no JE');

// ---- CASE C verification ----
const caseC = db.prepare(`SELECT id, status FROM exceptions WHERE title LIKE '%INV-7721%' LIMIT 1`).get() as { id: string; status: string } | undefined;
check('CASE C: duplicate invoice INV-7721 escalated to humans then rejected', !!caseC && ['ESCALATED', 'REJECTED'].includes(caseC.status), caseC?.status ?? 'missing');
const caseCPosted = caseC ? (db.prepare(`SELECT COUNT(*) c FROM journal_entries WHERE exception_id = ? AND status='POSTED'`).get(caseC.id) as { c: number }).c : 0;
check('CASE C: duplicate was NEVER auto-posted', caseCPosted === 0);

// ---- Global invariants ----
const unbalanced = (db.prepare(`SELECT COUNT(*) c FROM journal_entries WHERE total_debit != total_credit`).get() as { c: number }).c;
check('ALL journal entries are balanced (debit = credit)', unbalanced === 0, `${unbalanced} unbalanced`);
const dupIdem = (db.prepare(`SELECT COUNT(*) c FROM (SELECT idempotency_key, COUNT(*) k FROM journal_entries GROUP BY idempotency_key HAVING k > 1)`).get() as { c: number }).c;
check('no duplicate idempotency keys across journal entries', dupIdem === 0);
const metrics = computeMetrics(db, closeRunId);
check('close metrics report real processed volume (≥1000 txns)', metrics.transactions_processed >= 1000, String(metrics.transactions_processed));
check('close progress metric is 100', metrics.close_progress === 100);
check('auto-resolutions occurred (controlled autonomy active)', metrics.auto_resolved_count >= 1, String(metrics.auto_resolved_count));

// ---- Audit package ----
const pkg = generateAuditPackage(db, closeRunId);
check('audit package certified', pkg.close_certification.certified === true);
check('audit package has all 9 spec sections', ['close_summary', 'reconciliation_report', 'exception_report', 'journal_entries', 'human_approvals', 'agent_decision_log', 'evidence_index', 'policy_checks', 'close_certification'].every((k) => k in pkg));
check('audit evidence index is populated', pkg.evidence_index.length >= 10, String(pkg.evidence_index.length));
check('audit human approvals recorded', pkg.human_approvals.length >= 1, String(pkg.human_approvals.length));
check('audit decision log references real agent runs', pkg.agent_decision_log.length >= 3, String(pkg.agent_decision_log.length));

// ---- CFO summary ----
const summary = (await import('../../packages/workflow/src/orchestrator.ts')).generateCfoSummary(db, closeRunId);
check('CFO summary generated with headline and cash movement', !!summary.headline && typeof summary.cash.opening === 'number');

console.log(`\n==========================================`);
console.log(`E2E RESULTS: ${passed} checks passed, ${failures.length} failed`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}

function ctxFor(d: import('node:sqlite').DatabaseSync, closeRunId: string): Parameters<typeof executeTool>[0] {
  const id = 'arun_e2e_' + Math.random().toString(36).slice(2, 8);
  d.prepare(`INSERT INTO agent_runs (id, close_run_id, agent, purpose, status, input_summary, attempt, started_at) VALUES (?,?, 'ORCHESTRATOR', 'E2E human decision', 'RUNNING', 'Human review session', 1, ?)`)
    .run(id, closeRunId, new Date().toISOString());
  return { db: d, close_run_id: closeRunId, agent_run_id: id, request_id: 'e2e' };
}
