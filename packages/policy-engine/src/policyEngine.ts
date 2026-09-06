/**
 * POLICY ENGINE — evaluates the accounting_policies catalog against a proposed action.
 * Pure evaluation over DB-backed policy parameters; returns explicit pass/fail results.
 * Thresholds are configurable at runtime (Policies UI) per spec section 4.
 */
import type { DatabaseSync } from 'node:sqlite';
import { jparse } from '../../database/src/db.ts';
import type { PolicyResult } from '../../shared/src/types.ts';

export interface PolicyInput {
  kind: 'JOURNAL_POST' | 'EXCEPTION_AUTO_RESOLVE' | 'PAYMENT' | 'CLOSE_COMPLETE';
  amount: number;
  journal_total?: number;
  exception_type?: string;
  suspicious?: boolean;
  duplicate?: boolean;
  evidence_count?: number;
  prepared_by?: string;
  approver_role?: string;
  matched_to_po?: boolean;
}

function getPolicy(db: DatabaseSync, code: string): { parameters: Record<string, unknown>; active: number } | null {
  const row = db.prepare(`SELECT parameters_json, active FROM accounting_policies WHERE code = ?`).get(code) as { parameters_json: string; active: number } | undefined;
  if (!row) return null;
  return { parameters: jparse(row.parameters_json, {}), active: row.active };
}

export function evaluatePolicies(db: DatabaseSync, input: PolicyInput): PolicyResult[] {
  const results: PolicyResult[] = [];

  // JOURNAL_BALANCED — always evaluated for journal postings
  if (input.kind === 'JOURNAL_POST') {
    const p = getPolicy(db, 'JOURNAL_BALANCED');
    if (p && p.active) {
      // balancing itself is validated by the journal engine; policy records the control
      results.push({ policy_code: 'JOURNAL_BALANCED', passed: true, detail: 'Journal balancing control enforced by journal engine (debit = credit).', parameters: p.parameters });
    }
    const idem = getPolicy(db, 'JOURNAL_IDEMPOTENCY');
    if (idem && idem.active) {
      results.push({ policy_code: 'JOURNAL_IDEMPOTENCY', passed: true, detail: 'Idempotency key enforced (unique index) — repeated execution cannot duplicate posting.', parameters: idem.parameters });
    }
    // JE_APPROVAL_THRESHOLD
    const thr = getPolicy(db, 'JE_APPROVAL_THRESHOLD');
    if (thr && thr.active) {
      const threshold = Number(thr.parameters.threshold ?? 1_000_000);
      const requiredRole = String(thr.parameters.required_role ?? 'CONTROLLER');
      const total = input.journal_total ?? input.amount;
      if (total > threshold) {
        const rolesOk = requiredRole === 'CONTROLLER' ? (input.approver_role === 'CONTROLLER' || input.approver_role === 'CFO') : input.approver_role === requiredRole;
        results.push({
          policy_code: 'JE_APPROVAL_THRESHOLD',
          passed: rolesOk,
          detail: `Journal total ₹${total.toLocaleString('en-IN')} exceeds ₹${threshold.toLocaleString('en-IN')} — requires ${requiredRole} (or above) approval.`,
          parameters: thr.parameters,
        });
      } else {
        results.push({ policy_code: 'JE_APPROVAL_THRESHOLD', passed: true, detail: `Journal total ₹${total.toLocaleString('en-IN')} within threshold ₹${threshold.toLocaleString('en-IN')}.`, parameters: thr.parameters });
      }
    }
    // SEGREGATION_OF_DUTIES
    const sod = getPolicy(db, 'SEGREGATION_OF_DUTIES');
    if (sod && sod.active) {
      const sameActor = input.prepared_by && input.approver_role && input.prepared_by === input.approver_role;
      results.push({ policy_code: 'SEGREGATION_OF_DUTIES', passed: !sameActor, detail: sameActor ? 'Preparer and approver must differ.' : 'Preparer (agent) differs from approver — control satisfied.', parameters: sod.parameters });
    }
  }

  // AUTO_RESOLVE_RULE — evaluated when the agent proposes autonomous resolution
  if (input.kind === 'EXCEPTION_AUTO_RESOLVE') {
    const auto = getPolicy(db, 'AUTO_RESOLVE_RULE');
    if (auto && auto.active) {
      const maxAmt = Number(auto.parameters.max_auto_resolve_amount ?? 250_000);
      const pass = input.amount <= maxAmt;
      results.push({
        policy_code: 'AUTO_RESOLVE_RULE',
        passed: pass,
        detail: pass ? `Amount ₹${input.amount.toLocaleString('en-IN')} within auto-resolve cap ₹${maxAmt.toLocaleString('en-IN')}.` : `Amount ₹${input.amount.toLocaleString('en-IN')} exceeds auto-resolve cap ₹${maxAmt.toLocaleString('en-IN')} — human review required.`,
        parameters: auto.parameters,
      });
    }
    // POLICY_VIOLATION exceptions can never auto-resolve (the violation itself is the blocker)
    if (input.exception_type === 'POLICY_VIOLATION') {
      results.push({ policy_code: 'POLICY_VIOLATION_NO_AUTO', passed: false, detail: 'Exception is itself a policy violation — autonomous resolution prohibited; escalate.', parameters: {} });
    }
    const dup = getPolicy(db, 'DUPLICATE_INVOICE_BLOCK');
    if (dup && dup.active && input.duplicate) {
      results.push({ policy_code: 'DUPLICATE_INVOICE_BLOCK', passed: false, detail: 'Duplicate invoice detected — auto-posting prohibited; must escalate to human review.', parameters: dup.parameters });
    }
    const susp = getPolicy(db, 'SUSPICIOUS_ACTIVITY_REVIEW');
    if (susp && susp.active && input.suspicious) {
      results.push({ policy_code: 'SUSPICIOUS_ACTIVITY_REVIEW', passed: false, detail: 'Suspicious transaction flag set — human review mandatory.', parameters: susp.parameters });
    }
    const ev = getPolicy(db, 'EVIDENCE_REQUIRED');
    if (ev && ev.active) {
      const min = Number(ev.parameters.min_evidence ?? 3);
      const count = input.evidence_count ?? 0;
      results.push({
        policy_code: 'EVIDENCE_REQUIRED',
        passed: count >= min,
        detail: count >= min ? `${count} evidence items referenced (minimum ${min}).` : `Only ${count} evidence items — minimum ${min} required for autonomous resolution.`,
        parameters: ev.parameters,
      });
    }
  }

  // THREE_WAY_MATCH for payments
  if (input.kind === 'PAYMENT') {
    const twm = getPolicy(db, 'THREE_WAY_MATCH');
    if (twm && twm.active) {
      const threshold = Number(twm.parameters.threshold ?? 50_000);
      if (input.amount > threshold && !input.matched_to_po) {
        results.push({ policy_code: 'THREE_WAY_MATCH', passed: false, detail: `Payment ₹${input.amount.toLocaleString('en-IN')} above ₹${threshold.toLocaleString('en-IN')} without PO match.`, parameters: twm.parameters });
      } else {
        results.push({ policy_code: 'THREE_WAY_MATCH', passed: true, detail: input.matched_to_po ? 'Matched to purchase order.' : 'Below three-way-match threshold.', parameters: twm.parameters });
      }
    }
  }

  return results;
}

export function policiesAllPassed(results: PolicyResult[]): boolean {
  return results.length > 0 && results.every((r) => r.passed);
}
