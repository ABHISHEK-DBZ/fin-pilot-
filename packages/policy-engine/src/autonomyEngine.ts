/**
 * AUTONOMY ENGINE — combines policy results, risk, materiality and confidence
 * into a single controlled-autonomy decision (spec section 4):
 *   AUTO      : confidence >= threshold AND low risk AND policies pass AND below materiality
 *   HUMAN     : medium confidence / configurable review conditions
 *   ESCALATE  : high risk, policy failure, suspicious, duplicates, or material per policy
 * Deterministic and fully explained — no LLM in this path.
 */
import type { DatabaseSync } from 'node:sqlite';
import { jparse } from '../../database/src/db.ts';
import type { AutonomyDecision, PolicyResult, RiskResult, MaterialityResult, Role } from '../../shared/src/types.ts';

export interface AutonomyInput {
  confidence: number;            // 0..100
  risk: RiskResult;
  materiality: MaterialityResult;
  policy_results: PolicyResult[];
  exception_type: string;
  suspicious?: boolean;
  duplicate?: boolean;
  amount: number;
}

function thresholds(db: DatabaseSync): { autoConfidence: number; reviewFloor: number; reviewRoleThreshold: number } {
  const auto = db.prepare(`SELECT parameters_json FROM accounting_policies WHERE code='AUTO_RESOLVE_RULE' AND active=1`).get() as { parameters_json: string } | undefined;
  const review = db.prepare(`SELECT parameters_json FROM accounting_policies WHERE code='REVIEW_RULE' AND active=1`).get() as { parameters_json: string } | undefined;
  const a = auto ? jparse(auto.parameters_json, { min_confidence: 97 }) : { min_confidence: 97 };
  const r = review ? jparse(review.parameters_json, { review_confidence_floor: 80, review_amount_role_threshold: 100_000 }) : { review_confidence_floor: 80, review_amount_role_threshold: 100_000 };
  return {
    autoConfidence: Number(a.min_confidence ?? 97),
    reviewFloor: Number(r.review_confidence_floor ?? 80),
    reviewRoleThreshold: Number(r.review_amount_role_threshold ?? 100_000),
  };
}

export function decideAutonomy(db: DatabaseSync, input: AutonomyInput): AutonomyDecision {
  const t = thresholds(db);
  const failed = input.policy_results.filter((p) => !p.passed);
  const blocking = failed.filter((p) =>
    p.policy_code === 'AUTO_RESOLVE_RULE' ||
    p.policy_code === 'DUPLICATE_INVOICE_BLOCK' ||
    p.policy_code === 'SUSPICIOUS_ACTIVITY_REVIEW' ||
    p.policy_code === 'EVIDENCE_REQUIRED' ||
    p.policy_code === 'THREE_WAY_MATCH' ||
    p.policy_code === 'VENDOR_BANK_CHANGE_REVIEW');

  const highRisk = input.risk.level === 'HIGH';
  const isMaterial = input.materiality.material;

  // ESCALATE — any hard blocker
  if (highRisk || failed.length > 0 || input.suspicious || input.duplicate || input.exception_type === 'SUSPICIOUS_TRANSACTION' || input.exception_type === 'DUPLICATE_INVOICE') {
    const reasons: string[] = [];
    if (highRisk) reasons.push(`high risk (score ${input.risk.score})`);
    for (const f of blocking.length ? blocking : failed) reasons.push(`${f.policy_code}: ${f.detail}`);
    if (input.suspicious || input.exception_type === 'SUSPICIOUS_TRANSACTION') reasons.push('suspicious activity flag');
    if (input.duplicate || input.exception_type === 'DUPLICATE_INVOICE') reasons.push('duplicate detection');
    return {
      path: 'ESCALATE',
      reason: `Escalated — ${reasons.join('; ')}.`,
      confidence: input.confidence,
      policy_results: input.policy_results,
      risk: input.risk,
      materiality: input.materiality,
      requires_role: isMaterial || input.amount > t.reviewRoleThreshold ? 'CONTROLLER' : 'ACCOUNTANT',
    };
  }

  // AUTO — confidence, low risk, policies pass, below materiality.
  // Deterministic pattern-based classifications (marker metas like processor reports,
  // exact round-trip accounting) are auto-resolvable at the confidence threshold;
  // other items need >= 97 and the reviewer defaults to the policy review floor.
  const autoReady = input.confidence >= t.autoConfidence && input.risk.level === 'LOW' && failed.length === 0 && !isMaterial && input.amount <= t.reviewRoleThreshold;
  if (autoReady) {
    return {
      path: 'AUTO',
      reason: `Auto-resolved — confidence ${input.confidence.toFixed(1)}% ≥ ${t.autoConfidence}%, risk LOW (${input.risk.score}), all policies passed, amount ₹${input.amount.toLocaleString('en-IN')} below review threshold ₹${t.reviewRoleThreshold.toLocaleString('en-IN')}.`,
      confidence: input.confidence,
      policy_results: input.policy_results,
      risk: input.risk,
      materiality: input.materiality,
      requires_role: 'ACCOUNTANT',
    };
  }

  // HUMAN REVIEW — everything else
  const reasons: string[] = [];
  if (input.confidence < t.autoConfidence) reasons.push(`confidence ${input.confidence.toFixed(1)}% below auto threshold ${t.autoConfidence}%`);
  if (input.risk.level !== 'LOW') reasons.push(`risk ${input.risk.level} (${input.risk.score})`);
  if (input.materiality.level !== 'IMMATERIAL') reasons.push(`materiality ${input.materiality.level}`);
  if (input.amount > t.reviewRoleThreshold) reasons.push(`amount above ₹${t.reviewRoleThreshold.toLocaleString('en-IN')}`);
  return {
    path: 'HUMAN',
    reason: `Human review required — ${reasons.join('; ')}.`,
    confidence: input.confidence,
    policy_results: input.policy_results,
    risk: input.risk,
    materiality: input.materiality,
    requires_role: input.amount > t.reviewRoleThreshold || isMaterial ? 'CONTROLLER' : 'ACCOUNTANT',
  };
}
