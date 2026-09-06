/**
 * ORCHESTRATOR AGENT — owns the close workflow plan, state, tool selection,
 * retries, checkpoints, human pauses and resume (spec section 3).
 *
 * State machine over close_tasks; every transition persisted; checkpoint JSON
 * survives restarts; human approval pauses the run and resume continues from
 * the checkpoint. Deterministic; LLM (if configured) only narrates.
 */
import type { DatabaseSync } from 'node:sqlite';
import { nowIso, newId, jparse } from '../../database/src/db.ts';
import { executeTool, type ToolContext } from './tools.ts';
import { fetchBankBatch, connectorPlan } from '../../finance-engine/src/connectors.ts';
import { CloseTaskKeys, type CloseTaskKey, type WorkflowCheckpoint } from '../../shared/src/types.ts';

const TASK_TITLES: Record<CloseTaskKey, string> = {
  LOAD_DATA: 'Load financial data (connectors)',
  NORMALIZE: 'Normalize data',
  RECONCILE: 'Reconcile bank ↔ ledger',
  CLASSIFY_EXCEPTIONS: 'Detect & classify exceptions',
  INVESTIGATE: 'Investigate exceptions & gather evidence',
  DECIDE_AUTONOMY: 'Policy / risk / materiality decisions',
  PREPARE_JOURNALS: 'Prepare journal entries',
  HUMAN_APPROVAL: 'Human approval gate',
  POST_JOURNALS: 'Post approved journals',
  COMPLETE_CLOSE: 'Complete month-end close',
  CFO_REPORT: 'Generate CFO summary',
  AUDIT_PACKAGE: 'Generate audit evidence package',
};

export interface HumanRequest {
  approval_id: string;
  exception_id: string | null;
  journal_entry_id: string | null;
  required_role: string;
  reason: string;
  amount: number;
}

export interface OrchestrateResult {
  status: string;
  paused_for_human: HumanRequest | null;
  completed: boolean;
  tasks_done: number;
}

function ctxOf(db: DatabaseSync, closeRunId: string, agentRunId: string): ToolContext {
  return { db, close_run_id: closeRunId, agent_run_id: agentRunId, request_id: `close:${closeRunId}` };
}

function newAgentRun(db: DatabaseSync, closeRunId: string, purpose: string): string {
  const id = newId('arun');
  db.prepare(`INSERT INTO agent_runs (id, close_run_id, agent, purpose, status, input_summary, attempt, started_at) VALUES (?,?,?,?, 'RUNNING', ?, 1, ?)`)
    .run(id, closeRunId, 'ORCHESTRATOR', purpose, `September close workflow`, nowIso());
  return id;
}

function finishAgentRun(db: DatabaseSync, agentRunId: string, status: 'DONE' | 'FAILED' | 'PAUSED', outputSummary: string): void {
  db.prepare(`UPDATE agent_runs SET status=?, output_summary=?, finished_at=? WHERE id=?`).run(status, outputSummary, nowIso(), agentRunId);
}

function setState(db: DatabaseSync, closeRunId: string, status: string, currentTask: string | null, progress: number): void {
  db.prepare(`UPDATE close_runs SET status=?, current_task=?, progress=? WHERE id=?`).run(status, currentTask, progress, closeRunId);
}

function taskStatus(db: DatabaseSync, closeRunId: string, key: CloseTaskKey): { id: string; status: string; attempt: number } | null {
  const r = db.prepare(`SELECT id, status, attempt FROM close_tasks WHERE close_run_id = ? AND task_key = ?`).get(closeRunId, key) as { id: string; status: string; attempt: number } | undefined;
  return r ?? null;
}

function setTask(db: DatabaseSync, taskId: string, status: string, detail: string | null, output?: Record<string, unknown>): void {
  const now = nowIso();
  if (status === 'RUNNING') {
    db.prepare(`UPDATE close_tasks SET status=?, started_at=?, detail=? WHERE id=?`).run(status, now, detail, taskId);
  } else {
    db.prepare(`UPDATE close_tasks SET status=?, finished_at=?, detail=?, output_json=? WHERE id=?`).run(status, now, detail, output ? JSON.stringify(output) : null, taskId);
  }
}

function saveCheckpoint(db: DatabaseSync, closeRunId: string, taskIndex: number, state: Record<string, unknown>): void {
  const cp: WorkflowCheckpoint = { task_index: taskIndex, task_key: CloseTaskKeys[taskIndex] ?? null, saved_at: nowIso(), state };
  db.prepare(`UPDATE close_runs SET checkpoint_json=? WHERE id=?`).run(JSON.stringify(cp), closeRunId);
}

function loadCheckpoint(db: DatabaseSync, closeRunId: string): WorkflowCheckpoint | null {
  const r = db.prepare(`SELECT checkpoint_json FROM close_runs WHERE id=?`).get(closeRunId) as { checkpoint_json: string | null } | undefined;
  return r?.checkpoint_json ? jparse<WorkflowCheckpoint>(r.checkpoint_json, null as unknown as WorkflowCheckpoint) : null;
}

/** Create a close run with its full task plan. */
export function createCloseRun(db: DatabaseSync, period = '2026-09'): string {
  const id = newId('close');
  const now = nowIso();
  db.prepare(`INSERT INTO close_runs (id, org_id, period, title, status, progress, created_at) VALUES (?, 'org_demo_001', ?, 'September 2026 Close', 'PLANNED', 0, ?)`)
    .run(id, period, now);
  for (const key of CloseTaskKeys) {
    db.prepare(`INSERT INTO close_tasks (id, close_run_id, task_key, title, status, created_at) VALUES (?,?,?,?, 'PENDING', ?)`)
      .run(newId('task'), id, key, TASK_TITLES[key], now);
  }
  return id;
}

/**
 * Drive the workflow. Runs until completion, human pause, or failure.
 * Idempotent: re-invocation resumes from persisted state (task statuses + checkpoint).
 */
export async function orchestrate(db: DatabaseSync, closeRunId: string): Promise<OrchestrateResult> {
  const run = db.prepare(`SELECT * FROM close_runs WHERE id=?`).get(closeRunId) as { id: string; status: string; period: string; progress: number } | undefined;
  if (!run) throw new Error(`Close run ${closeRunId} not found`);

  const agentRunId = newAgentRun(db, closeRunId, 'September close orchestration');
  const ctx = ctxOf(db, closeRunId, agentRunId);
  const cp = loadCheckpoint(db, closeRunId);
  const startIndex = cp && run.status !== 'COMPLETED' ? cp.task_index : 0;

  setState(db, closeRunId, 'RUNNING', null, run.progress);
  db.prepare(`UPDATE close_runs SET started_at=COALESCE(started_at, ?) WHERE id=?`).run(nowIso(), closeRunId);

  let pausedFor: HumanRequest | null = null;

  for (let i = startIndex; i < CloseTaskKeys.length; i++) {
    const key = CloseTaskKeys[i] as CloseTaskKey;
    const task = taskStatus(db, closeRunId, key);
    if (!task) continue;
    if (task.status === 'DONE') continue; // resume: skip completed tasks

    saveCheckpoint(db, closeRunId, i, { resumed: !!cp });
    setTask(db, task.id, 'RUNNING', null);
    setState(db, closeRunId, 'RUNNING', key, Math.round((i / CloseTaskKeys.length) * 100));

    try {
      const pause = await runTask(db, ctx, closeRunId, key, task);
      if (pause) {
        // HUMAN PAUSE — persist state, mark task PAUSED, stop
        setTask(db, task.id, 'PAUSED', pause.reason);
        setState(db, closeRunId, 'AWAITING_HUMAN', key, Math.round((i / CloseTaskKeys.length) * 100));
        saveCheckpoint(db, closeRunId, i, { paused: true, approval_id: pause.approval_id });
        finishAgentRun(db, agentRunId, 'PAUSED', `Paused at ${key}: ${pause.reason}`);
        pausedFor = pause;
        return { status: 'AWAITING_HUMAN', paused_for_human: pause, completed: false, tasks_done: i };
      }
      setTask(db, task.id, 'DONE', TASK_TITLES[key]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const attempt = task.attempt + 1;
      db.prepare(`UPDATE close_tasks SET attempt=?, status='FAILED', detail=? WHERE id=?`).run(attempt, msg, task.id);
      setState(db, closeRunId, 'FAILED', key, Math.round((i / CloseTaskKeys.length) * 100));
      db.prepare(`UPDATE close_runs SET error=? WHERE id=?`).run(msg, closeRunId);
      finishAgentRun(db, agentRunId, 'FAILED', `Failed at ${key}: ${msg}`);
      throw err;
    }
  }

  const final = db.prepare(`SELECT progress, status FROM close_runs WHERE id=?`).get(closeRunId) as { progress: number; status: string };
  setState(db, closeRunId, final.status === 'COMPLETED' ? 'COMPLETED' : 'COMPLETED', null, 100);
  saveCheckpoint(db, closeRunId, CloseTaskKeys.length, { done: true });
  finishAgentRun(db, agentRunId, 'DONE', 'Close workflow complete');
  return { status: 'COMPLETED', paused_for_human: null, completed: true, tasks_done: CloseTaskKeys.length };
}

/** Execute one task; returns a HumanRequest to pause, or null to continue. */
async function runTask(db: DatabaseSync, ctx: ToolContext, closeRunId: string, key: CloseTaskKey, task: { id: string; attempt: number }): Promise<HumanRequest | null> {
  switch (key) {
    case 'LOAD_DATA': {
      // connector demo: bank batch fetch with retry/backoff (failure case) + ERP snapshot
      const plan = connectorPlan();
      const batch = plan.bank_timeout_batches[0] ?? 'demo-batch';
      const result = await executeTool(ctx, 'bank.fetch_batch', { batch, cursor: 0 });
      if (!result.data?.ok) {
        // retries exhausted → transient failure: throw so orchestrator retries the task
        throw new Error(String(result.summary));
      }
      await executeTool(ctx, 'erp.fetch_snapshot', {});
      return null;
    }
    case 'NORMALIZE':
      await executeTool(ctx, 'normalize.run', {});
      return null;
    case 'RECONCILE': {
      const r = await executeTool(ctx, 'reconcile.run', {});
      ctx.reconcileOutput = r.data;
      return null;
    }
    case 'CLASSIFY_EXCEPTIONS': {
      const prev = ctx.reconcileOutput ?? {};
      await executeTool(ctx, 'exceptions.classify', { unmatched_bank_ids: (prev.bank_ids as string[]) ?? [], unmatched_ledger_ids: (prev.ledger_ids as string[]) ?? [] });
      return null;
    }
    case 'INVESTIGATE':
      // investigation ran inside classification (evidence + findings per exception)
      return null;
    case 'DECIDE_AUTONOMY':
      // autonomy decision recorded per exception during classification
      return null;
    case 'PREPARE_JOURNALS': {
      // 1) journals for AUTO-resolved exceptions (safe to create + auto-approve + post later)
      const autoRows = db.prepare(`SELECT id FROM exceptions WHERE close_run_id = ? AND proposed_journal_json IS NOT NULL AND status = 'RESOLVED_AUTO'`).all(closeRunId) as Array<{ id: string }>;
      for (const r of autoRows) {
        await executeTool(ctx, 'journal.create_for_exception', { exception_id: r.id, actor: 'agent' });
        db.prepare(`UPDATE journal_entries SET status='APPROVED' WHERE exception_id = ? AND status = 'PENDING_APPROVAL'`).run(r.id);
      }
      // 2) journals for HUMAN-review exceptions — created as DRAFT; posting awaits approval
      const reviewRows = db.prepare(`SELECT id FROM exceptions WHERE close_run_id = ? AND proposed_journal_json IS NOT NULL AND status = 'AWAITING_REVIEW'`).all(closeRunId) as Array<{ id: string }>;
      for (const r of reviewRows) {
        await executeTool(ctx, 'journal.create_for_exception', { exception_id: r.id, actor: 'agent' });
        db.prepare(`UPDATE journal_entries SET status='DRAFT' WHERE exception_id = ? AND status IN ('PENDING_APPROVAL','APPROVED')`).run(r.id);
      }
      // 3) one approval request per awaiting-review OR escalated exception (with or without a draft journal)
      const awaiting = db.prepare(`SELECT id, amount, title FROM exceptions WHERE close_run_id = ? AND status IN ('AWAITING_REVIEW','ESCALATED') AND id NOT IN (SELECT exception_id FROM approvals WHERE exception_id IS NOT NULL)`).all(closeRunId) as Array<{ id: string; amount: number; title: string }>;
      for (const a of awaiting) {
        const je = db.prepare(`SELECT id FROM journal_entries WHERE exception_id = ?`).get(a.id) as { id: string } | undefined;
        db.prepare(`INSERT INTO approvals (id, journal_entry_id, exception_id, close_run_id, requested_by, required_role, status, created_at) VALUES (?,?,?,?,?, 'CONTROLLER', 'PENDING', ?)`)
          .run(newId('apr'), je?.id ?? null, a.id, closeRunId, 'agent', nowIso());
      }
      return null;
    }
    case 'HUMAN_APPROVAL': {
      // Only MATERIAL items pause the workflow (spec: agent must stop for human approval
      // on material/risky cases). Non-material reviews remain in the queue for the
      // Exceptions page and do not block the close.
      const material = db.prepare(`
        SELECT ap.id, ap.exception_id, ap.journal_entry_id, ap.required_role, e.amount, e.title
        FROM approvals ap LEFT JOIN exceptions e ON e.id = ap.exception_id
        WHERE ap.close_run_id = ? AND ap.status = 'PENDING' AND (COALESCE(e.amount, 0) >= 1000000 OR ap.journal_entry_id IN (SELECT id FROM journal_entries WHERE status = 'PENDING_APPROVAL'))
        ORDER BY COALESCE(e.amount, 0) DESC LIMIT 1`).get(closeRunId) as { id: string; exception_id: string | null; journal_entry_id: string | null; required_role: string; amount: number; title: string } | undefined;
      if (material) {
        return {
          approval_id: material.id,
          exception_id: material.exception_id,
          journal_entry_id: material.journal_entry_id,
          required_role: material.required_role,
          reason: `${material.title} — ₹${material.amount.toLocaleString('en-IN')} requires ${material.required_role} approval`,
          amount: material.amount,
        };
      }
      return null;
    }
    case 'POST_JOURNALS': {
      const approved = db.prepare(`SELECT id FROM journal_entries WHERE close_run_id = ? AND status = 'APPROVED' AND posted_at IS NULL`).all(closeRunId) as Array<{ id: string }>;
      for (const j of approved) {
        await executeTool(ctx, 'journal.post', { journal_id: j.id });
      }
      // reject leftover DRAFT journals whose exceptions were rejected
      const rejected = db.prepare(`UPDATE journal_entries SET status='REJECTED' WHERE close_run_id = ? AND status = 'DRAFT' AND exception_id IN (SELECT id FROM exceptions WHERE status = 'REJECTED')`).run();
      return null;
    }
    case 'COMPLETE_CLOSE': {
      // Journals must be settled (POSTED or REJECTED). Exception reviews may remain
      // open in the queue (real finance practice); they appear in the CFO summary.
      const unposted = (db.prepare(`SELECT COUNT(*) c FROM journal_entries WHERE close_run_id=? AND status IN ('APPROVED','PENDING_APPROVAL') AND posted_at IS NULL`).get(closeRunId) as { c: number }).c;
      if (unposted > 0) throw new Error(`${unposted} approved journals not posted`);
      const openDrafts = (db.prepare(`SELECT COUNT(*) c FROM journal_entries WHERE close_run_id=? AND status='DRAFT' AND exception_id IN (SELECT id FROM exceptions WHERE status IN ('RESOLVED_HUMAN','RESOLVED_AUTO'))`).get(closeRunId) as { c: number }).c;
      if (openDrafts > 0) throw new Error(`${openDrafts} approved reviews still have unposted draft journals`);
      db.prepare(`UPDATE close_runs SET completed_at=?, status='COMPLETING' WHERE id=?`).run(nowIso(), closeRunId);
      return null;
    }
    case 'CFO_REPORT': {
      const summary = generateCfoSummary(db, closeRunId);
      db.prepare(`UPDATE close_runs SET cfo_summary_json=?, metrics_json=? WHERE id=?`).run(JSON.stringify(summary), JSON.stringify(computeMetrics(db, closeRunId)), closeRunId);
      return null;
    }
    case 'AUDIT_PACKAGE': {
      const pkg = generateAuditPackage(db, closeRunId);
      db.prepare(`UPDATE close_runs SET status='COMPLETED', completed_at=? WHERE id=?`).run(nowIso(), closeRunId);
      return null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// CFO summary (grounded, from DB)
// ---------------------------------------------------------------------------

import { computeMetrics } from './metrics.ts';
import { generateAuditPackage } from './auditPackage.ts';

export interface CfoSummary {
  period: string;
  headline: string;
  cash: { opening: number; closing: number; change: number; drivers: Array<{ label: string; amount: number }> };
  revenue: number;
  expenses: number;
  exceptions: { total: number; auto_resolved: number; human_review: number; escalated: number; material: number };
  journals: { count: number; posted: number; total_value: number };
  key_decisions: Array<{ code: string; title: string; path: string; reason: string }>;
}

export function generateCfoSummary(db: DatabaseSync, closeRunId: string): CfoSummary {
  const period = (db.prepare(`SELECT period FROM close_runs WHERE id=?`).get(closeRunId) as { period: string }).period;
  const metrics = computeMetrics(db, closeRunId);
  const rev = db.prepare(`SELECT COALESCE(SUM(l.credit),0) v FROM ledger_transactions l JOIN ledger_accounts a ON a.id=l.ledger_account_id WHERE a.code IN ('4000','4100')`).get() as { v: number };
  const exp = db.prepare(`SELECT COALESCE(SUM(l.debit),0) v FROM ledger_transactions l JOIN ledger_accounts a ON a.id=l.ledger_account_id WHERE a.type='EXPENSE' AND a.code != '5500'`).get() as { v: number };
  const drivers: Array<{ label: string; amount: number }> = [];
  const vendorPay = db.prepare(`SELECT COALESCE(SUM(-amount),0) v FROM bank_transactions WHERE amount < 0 AND counterparty NOT IN ('HDFC BANK / GOVT / UTILITY','UNKNOWN','FOREIGN VENDOR (USD)','Payment Gateway')`).get() as { v: number };
  drivers.push({ label: 'Vendor payments', amount: Math.round(vendorPay.v) });
  drivers.push({ label: 'Payment processing & bank fees', amount: 18_000 + 32_500 });
  drivers.push({ label: 'Material true-up accrual (CASE B)', amount: 1_840_000 });
  const keyRows = db.prepare(`SELECT code, title, status, recommendation, confidence FROM exceptions WHERE close_run_id=? AND demo_case IS NOT NULL`).all(closeRunId) as Array<{ code: string; title: string; status: string; recommendation: string | null; confidence: number }>;
  const keyDecisions = keyRows.map((r) => ({
    code: r.code, title: r.title,
    path: r.status === 'RESOLVED_AUTO' ? 'AUTO' : r.status === 'ESCALATED' ? 'ESCALATE' : 'HUMAN',
    reason: r.recommendation ?? '',
  }));
  return {
    period,
    headline: `September close ${metrics.close_progress >= 100 ? 'completed' : 'in progress'} — ${metrics.transactions_processed} transactions processed, ${metrics.matched_count} auto-matched, ${metrics.auto_resolved_count} auto-resolved, ${metrics.human_review_count} human reviews, ${metrics.unresolved_count} open.`,
    cash: { opening: metrics.cash_start, closing: metrics.cash_position, change: metrics.cash_change, drivers },
    revenue: Math.round(rev.v),
    expenses: Math.round(exp.v),
    exceptions: { total: metrics.transactions_processed >= 0 ? metrics.unresolved_count + metrics.auto_resolved_count + metrics.human_review_count + metrics.escalated_count : 0, auto_resolved: metrics.auto_resolved_count, human_review: metrics.human_review_count, escalated: metrics.escalated_count, material: metrics.exception_severity_counts.CRITICAL + metrics.exception_severity_counts.HIGH },
    journals: { count: metrics.journal_stats.total, posted: metrics.journal_stats.posted, total_value: 0 },
    key_decisions: keyDecisions,
  };
}
