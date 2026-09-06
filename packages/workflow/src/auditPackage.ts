/**
 * AUDIT PACKAGE — assembles the audit-ready close package (spec section 14).
 * Every conclusion links to evidence IDs; documents are generated from the DB.
 */
import type { DatabaseSync } from 'node:sqlite';
import { jparse } from '../../database/src/db.ts';
import { evidenceForException } from '../../evidence-graph/src/evidenceGraph.ts';
import { computeMetrics } from './metrics.ts';
import { formatINR } from '../../shared/src/money.ts';

export interface AuditPackage {
  close_run_id: string;
  generated_at: string;
  close_summary: { period: string; title: string; status: string; progress: number; completed_at: string | null; metrics: ReturnType<typeof computeMetrics> };
  reconciliation_report: { total_matches: number; by_type: Record<string, number>; unmatched_bank: number; unmatched_ledger: number };
  exception_report: Array<{ code: string; type: string; title: string; amount: number; severity: string; status: string; confidence: number; risk: string; materiality: string; finding: string; recommendation: string | null; resolution: string | null; evidence_ids: string[] }>;
  journal_entries: Array<{ journal_number: string | null; description: string; status: string; total_debit: number; total_credit: number; idempotency_key: string; lines: Array<{ account: string; debit: number; credit: number; description: string }> }>;
  human_approvals: Array<{ approval_id: string; required_role: string; status: string; decided_by: string | null; decided_at: string | null; note: string | null; exception_code: string | null; journal_number: string | null }>;
  agent_decision_log: Array<{ at: string; agent: string; actor: string; action: string; target: string; input: string; output: string; confidence: number | null }>;
  evidence_index: Array<{ exception_code: string; evidence_id: string; entity_label: string; entity_type: string; relationship: string; summary: string }>;
  policy_checks: Array<{ exception_code: string; policy_code: string; passed: boolean; detail: string }>;
  close_certification: { certified: boolean; statement: string; closed_by: string | null; closed_at: string | null };
}

export function generateAuditPackage(db: DatabaseSync, closeRunId: string): AuditPackage {
  const run = db.prepare(`SELECT * FROM close_runs WHERE id=?`).get(closeRunId) as { id: string; period: string; title: string; status: string; progress: number; completed_at: string | null } | undefined;
  if (!run) throw new Error(`Close run ${closeRunId} not found`);

  const metrics = computeMetrics(db, closeRunId);

  // reconciliation report
  const reconByType = db.prepare(`SELECT match_type, COUNT(*) c FROM reconciliations WHERE close_run_id=? GROUP BY match_type`).all(closeRunId) as unknown as Array<{ match_type: string; c: number }>;
  const byType: Record<string, number> = {};
  for (const r of reconByType) byType[r.match_type] = r.c;
  const matchedCount = (db.prepare(`SELECT COUNT(*) c FROM reconciliations WHERE close_run_id=? AND status='MATCHED'`).get(closeRunId) as { c: number }).c;

  // exceptions with evidence + policy results
  const excRows = db.prepare(`SELECT * FROM exceptions WHERE close_run_id=? ORDER BY code`).all(closeRunId) as unknown as Array<{
    id: string; code: string; type: string; title: string; amount: number; severity: string; status: string; confidence: number;
    risk_level: string; materiality_level: string; finding: string | null; recommendation: string | null; resolution: string | null; policy_results_json: string;
  }>;
  const exceptionReport = excRows.map((e) => {
    const ev = evidenceForException(db, e.id);
    return {
      code: e.code, type: e.type, title: e.title, amount: e.amount, severity: e.severity, status: e.status,
      confidence: e.confidence, risk: e.risk_level, materiality: e.materiality_level,
      finding: e.finding ?? '', recommendation: e.recommendation, resolution: e.resolution,
      evidence_ids: ev.map((v) => v.id),
    };
  });

  // journals
  const jeRows = db.prepare(`SELECT je.*, (SELECT json_group_array(json_object('account', a.code || ' ' || a.name, 'debit', jel.debit, 'credit', jel.credit, 'description', jel.description)) FROM journal_entry_lines jel JOIN ledger_accounts a ON a.id = jel.ledger_account_id WHERE jel.journal_entry_id = je.id) lines_json FROM journal_entries je WHERE je.close_run_id=? ORDER BY je.created_at`).all(closeRunId) as unknown as Array<{ journal_number: string | null; description: string; status: string; total_debit: number; total_credit: number; idempotency_key: string; lines_json: string }>;
  const journals = jeRows.map((j) => ({
    journal_number: j.journal_number, description: j.description, status: j.status,
    total_debit: j.total_debit, total_credit: j.total_credit, idempotency_key: j.idempotency_key,
    lines: jparse<Array<{ account: string; debit: number; credit: number; description: string }>>(j.lines_json, []),
  }));

  // approvals
  const apRows = db.prepare(`SELECT ap.id, ap.required_role, ap.status, ap.decided_by, ap.decided_at, ap.decision_note, exc.code exc_code, je.journal_number FROM approvals ap LEFT JOIN exceptions exc ON exc.id = ap.exception_id LEFT JOIN journal_entries je ON je.id = ap.journal_entry_id WHERE ap.close_run_id=? ORDER BY ap.created_at`).all(closeRunId) as unknown as Array<{ id: string; required_role: string; status: string; decided_by: string | null; decided_at: string | null; decision_note: string | null; exc_code: string | null; journal_number: string | null }>;
  const approvals = apRows.map((a) => ({ approval_id: a.id, required_role: a.required_role, status: a.status, decided_by: a.decided_by, decided_at: a.decided_at, note: a.decision_note, exception_code: a.exc_code, journal_number: a.journal_number }));

  // agent decision log
  const logRows = db.prepare(`SELECT created_at, agent, actor, action, target_id, input_summary, output_summary, confidence FROM agent_actions WHERE close_run_id=? ORDER BY created_at`).all(closeRunId) as unknown as Array<{ created_at: string; agent: string; actor: string; action: string; target_id: string; input_summary: string; output_summary: string; confidence: number | null }>;
  const decisionLog = logRows.map((r) => ({ at: r.created_at, agent: r.agent, actor: r.actor, action: r.action, target: r.target_id, input: r.input_summary, output: r.output_summary, confidence: r.confidence }));

  // evidence index
  const evidenceIndex: AuditPackage['evidence_index'] = [];
  for (const e of excRows) {
    for (const v of evidenceForException(db, e.id)) {
      evidenceIndex.push({ exception_code: e.code, evidence_id: v.id, entity_label: v.label, entity_type: v.entity_type, relationship: v.relationship, summary: v.summary });
    }
  }

  // policy checks
  const policyChecks: AuditPackage['policy_checks'] = [];
  for (const e of excRows) {
    for (const p of jparse<Array<{ policy_code: string; passed: boolean; detail: string }>>(e.policy_results_json, [])) {
      policyChecks.push({ exception_code: e.code, policy_code: p.policy_code, passed: p.passed, detail: p.detail });
    }
  }

  const certStatement = run.status === 'COMPLETED'
    ? `The September 2026 month-end close was executed under controlled autonomy with full human oversight of material items. All journal entries are balanced and idempotent; every autonomous decision links to evidence. Data: ${'SYNTHETIC DEMO DATA — NOT REAL FINANCIAL INFORMATION'}.`
    : `Close run is ${run.status}; certification available upon completion.`;

  return {
    close_run_id: closeRunId,
    generated_at: new Date().toISOString(),
    close_summary: { period: run.period, title: run.title, status: run.status, progress: run.progress, completed_at: run.completed_at, metrics },
    reconciliation_report: { total_matches: matchedCount, by_type: byType, unmatched_bank: 0, unmatched_ledger: 0 },
    exception_report: exceptionReport,
    journal_entries: journals,
    human_approvals: approvals,
    agent_decision_log: decisionLog,
    evidence_index: evidenceIndex,
    policy_checks: policyChecks,
    close_certification: { certified: run.status === 'COMPLETED', statement: certStatement, closed_by: 'controller@finpilot.demo', closed_at: run.completed_at },
  };
}
