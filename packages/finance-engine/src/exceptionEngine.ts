/**
 * EXCEPTION ENGINE — classifies unmatched/duplicate/anomalous items into typed
 * exceptions (spec section 5 list), attaches evidence, runs policy + risk +
 * materiality + confidence, and applies the autonomy decision. Every exception
 * carries amount, type, severity, confidence, risk, materiality, status,
 * evidence, recommendation and timestamps (spec section on exceptions).
 */
import type { DatabaseSync } from 'node:sqlite';
import { nowIso, newId } from '../../database/src/db.ts';
import { evaluatePolicies } from '../../policy-engine/src/policyEngine.ts';
import { decideAutonomy } from '../../policy-engine/src/autonomyEngine.ts';
import { assessRisk } from '../../risk-engine/src/riskEngine.ts';
import { assessMateriality, scoreConfidence } from '../../risk-engine/src/materialityEngine.ts';
import { linkEvidence, findEntity, evidenceCount } from '../../evidence-graph/src/evidenceGraph.ts';
import { buildProcessorFeeProposal, buildTwoLineProposal } from '../../finance-engine/src/journalEngine.ts';
import { round2 } from '../../shared/src/money.ts';
import type { PolicyResult, RiskResult, Severity } from '../../shared/src/types.ts';

export interface ClassifiedException {
  id: string;
  code: string;
  type: string;
  title: string;
  amount: number;
  severity: Severity;
  status: string;
  confidence: number;
  demo_case: string | null;
}

export interface ClassificationContext {
  close_run_id: string;
  org_id: string;
  monthly_revenue: number;
  investigation: (exc: { id: string; type: string; amount: number; bank_id?: string | null; ledger_id?: string | null; invoice_ids?: string[]; meta?: Record<string, unknown> }) => InvestigationOutcome;
}

export interface ProposedJournalSpec {
  idempotency_key: string;
  description: string;
  processor?: boolean;
  fee_excl?: number; gst?: number; cash_credit?: number;
  simple_debit?: { code: string; name: string };
  simple_credit?: { code: string; name: string };
  simple_amount?: number;
  simple_debit_desc?: string;
  simple_credit_desc?: string;
}

export interface InvestigationOutcome {
  finding: string;
  likely_cause: string;
  recommendation: string;
  confidence: number;
  evidence: Array<{ entity_key?: string; entity_type?: string; external_ref?: string; label: string; relationship: string; summary: string; metadata?: Record<string, unknown> }>;
  proposed_journal?: ProposedJournalSpec;
  suspicious?: boolean;
  duplicate?: boolean;
  cross_system_agreement?: boolean;
}

function severityOf(type: string, amount: number, riskScore: number): Severity {
  if (type === 'SUSPICIOUS_TRANSACTION' || type === 'DUPLICATE_INVOICE') return amount >= 250_000 ? 'CRITICAL' : 'HIGH';
  if (type === 'POLICY_VIOLATION') return 'HIGH';
  if (riskScore >= 70) return 'HIGH';
  if (riskScore >= 45 || amount >= 250_000) return 'MEDIUM';
  return 'LOW';
}

let excCounter = 0;

/**
 * Create a fully-analyzed exception: evidence → confidence → policies → risk →
 * materiality → autonomy decision. Persisted in one place so the audit trail
 * is complete from creation.
 */
export function createException(
  db: DatabaseSync,
  ctx: ClassificationContext,
  input: {
    type: string;
    title: string;
    amount: number;
    bank_id?: string | null;
    ledger_id?: string | null;
    invoice_ids?: string[];
    meta?: Record<string, unknown>;
    demo_case?: string | null;
  },
): ClassifiedException {
  const now = nowIso();
  const id = newId('exc');
  excCounter += 1;
  const code = `EXC-${excCounter.toString().padStart(4, '0')}`;

  db.prepare(`INSERT INTO exceptions (id, close_run_id, code, type, title, amount, currency, severity, status, confidence, risk_level, risk_score, risk_factors_json, materiality_level, material, policy_results_json, demo_case, created_at, updated_at)
              VALUES (?,?,?,?,?,?, 'INR', 'LOW', 'INVESTIGATING', 50, 'LOW', 10, '[]', 'IMMATERIAL', 0, '[]', ?, ?, ?)`)
    .run(id, ctx.close_run_id, code, input.type, input.title, input.amount, input.demo_case ?? null, now, now);

  // --- investigation (evidence gathering + finding) ---
  const outcome = ctx.investigation({ id, type: input.type, amount: input.amount, bank_id: input.bank_id, ledger_id: input.ledger_id, invoice_ids: input.invoice_ids, meta: input.meta });

  // persist evidence links (resolve entity_keys to graph node ids)
  for (const ev of outcome.evidence) {
    let nodeId: string | null = null;
    if (ev.entity_key) {
      const parts = ev.entity_key.split(':');
      nodeId = findEntity(db, parts[0] as string, parts.slice(1).join(':'))?.id ?? null;
    } else if (ev.entity_type && ev.external_ref) {
      nodeId = findEntity(db, ev.entity_type, ev.external_ref)?.id ?? null;
    }
    if (nodeId) {
      linkEvidence(db, { exception_id: id, entity_id: nodeId, entity_type: ev.entity_type ?? 'GL_TRANSACTION', relationship: ev.relationship, summary: ev.summary, metadata: ev.metadata });
    }
  }

  // --- confidence / risk / materiality / policy / autonomy ---
  const evCount = evidenceCount(db, id);
  const confidence = scoreConfidence({
    exception_type: input.type,
    evidence_count: evCount,
    has_processor_report: outcome.evidence.some((e) => e.relationship === 'SUPPORTS' && /settlement report|processor/i.test(e.label)),
    has_history_match: outcome.evidence.some((e) => /HISTORICAL/i.test(e.relationship)),
    has_exact_reference: !!input.meta?.exact_reference,
    amounts_consistent: !!input.meta?.amounts_consistent,
    duplicate_pair_found: !!input.meta?.duplicate,
    deterministic_match: !!input.meta?.deterministic_match,
    cross_system_agreement: !!outcome.cross_system_agreement,
  });
  const risk = assessRisk({
    exception_type: input.type,
    amount: input.amount,
    suspicious: outcome.suspicious || !!input.meta?.suspicious,
    duplicate: outcome.duplicate || !!input.meta?.duplicate,
    evidence_count: evCount,
    confidence,
  });
  const materiality = assessMateriality(db, input.amount, ctx.monthly_revenue);
  const policy_results: PolicyResult[] = evaluatePolicies(db, {
    kind: 'EXCEPTION_AUTO_RESOLVE',
    amount: input.amount,
    exception_type: input.type,
    suspicious: outcome.suspicious || !!input.meta?.suspicious,
    duplicate: outcome.duplicate || !!input.meta?.duplicate,
    evidence_count: evCount,
  });
  const decision = decideAutonomy(db, {
    confidence, risk, materiality, policy_results,
    exception_type: input.type,
    suspicious: outcome.suspicious || !!input.meta?.suspicious,
    duplicate: outcome.duplicate || !!input.meta?.duplicate,
    amount: input.amount,
  });

  const severity = severityOf(input.type, input.amount, risk.score);
  const status = decision.path === 'AUTO' ? 'RESOLVED_AUTO' : decision.path === 'ESCALATE' ? 'ESCALATED' : 'AWAITING_REVIEW';
  const resolution = decision.path === 'AUTO' ? 'Auto-resolved by agent under controlled autonomy policy.' : null;

  db.prepare(`UPDATE exceptions SET severity=?, status=?, confidence=?, risk_level=?, risk_score=?, risk_factors_json=?, materiality_level=?, material=?, policy_results_json=?, finding=?, likely_cause=?, recommendation=?, resolution=?, resolved_by=?, resolved_at=?, updated_at=? WHERE id=?`)
    .run(severity, status, confidence, risk.level, risk.score, JSON.stringify(risk.factors), materiality.level, materiality.material ? 1 : 0,
      JSON.stringify(policy_results), outcome.finding, outcome.likely_cause, outcome.recommendation, resolution,
      decision.path === 'AUTO' ? 'agent' : null, decision.path === 'AUTO' ? now : null, now, id);

  // proposed journal stored for review UI
  if (outcome.proposed_journal) {
    const pj = outcome.proposed_journal;
    let proposal;
    if (pj.processor && pj.fee_excl != null) {
      proposal = buildProcessorFeeProposal(pj.idempotency_key, pj.description, pj.fee_excl, pj.gst ?? 0, pj.cash_credit ?? 0,
        { expense: { code: '5200', name: 'Payment Processing Fees' }, gst: { code: '1400', name: 'GST Input Tax Credit' }, cash: { code: '1000', name: 'Cash — HDFC Current Account' } });
    } else if (pj.simple_debit && pj.simple_credit && pj.simple_amount) {
      proposal = buildTwoLineProposal(pj.idempotency_key, pj.description, pj.simple_debit, pj.simple_credit, pj.simple_amount, pj.simple_debit_desc ?? pj.description, pj.simple_credit_desc ?? pj.description);
    }
    if (proposal) {
      db.prepare(`UPDATE exceptions SET proposed_journal_json=? WHERE id=?`).run(JSON.stringify(proposal), id);
    }
  }

  return { id, code, type: input.type, title: input.title, amount: input.amount, severity, status, confidence, demo_case: input.demo_case ?? null };
}

/** Record an agent action + audit event for an exception decision. */
export function recordDecisionAudit(
  db: DatabaseSync,
  close_run_id: string,
  agent_run_id: string,
  exception: { id: string; code: string; type: string; amount: number },
  decision: { path: string; reason: string; confidence: number },
  evidence_ids: string[],
): void {
  const now = nowIso();
  db.prepare(`INSERT INTO agent_actions (id, agent_run_id, close_run_id, agent, actor, action, target_type, target_id, input_summary, output_summary, evidence_ids_json, confidence, policy_result, risk_result, created_at)
              VALUES (?,?,?, 'INVESTIGATION', 'agent', 'CLASSIFY_AND_DECIDE', 'exception', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(newId('aa'), agent_run_id, close_run_id, exception.id,
      `${exception.type} amount ₹${exception.amount.toLocaleString('en-IN')}`,
      `${decision.path}: ${decision.reason}`, JSON.stringify(evidence_ids), decision.confidence, null, null, now);
  db.prepare(`INSERT INTO audit_events (id, org_id, close_run_id, request_id, actor, actor_role, action, target_type, target_id, input_summary, output_summary, evidence_ids_json, confidence, policy_result, risk_result, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(newId('aud'), (db.prepare(`SELECT org_id FROM close_runs WHERE id=?`).get(close_run_id) as { org_id: string }).org_id,
      close_run_id, `close:${close_run_id}`, 'agent:investigation', 'AGENT', 'EXCEPTION_DECISION', 'exception', exception.id,
      `${exception.type} ₹${exception.amount.toLocaleString('en-IN')}`, decision.reason, JSON.stringify(evidence_ids), decision.confidence, null, null, now);
}
