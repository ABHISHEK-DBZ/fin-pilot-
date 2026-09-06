/**
 * CONFIDENCE + MATERIALITY engines.
 * Materiality: policy-parameterised thresholds (fixed + percent-of-revenue basis)
 * from the MATERIALITY_BASIS policy. Confidence: deterministic evidence-based
 * scoring for classification quality (0..100) — no opaque model magic.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { MaterialityResult } from '../../shared/src/types.ts';
import { jparse } from '../../database/src/db.ts';

// ---------------------------------------------------------------------------
// Materiality
// ---------------------------------------------------------------------------

export function assessMateriality(db: DatabaseSync, amount: number, revenueBasis: number): MaterialityResult {
  const row = db.prepare(`SELECT parameters_json FROM accounting_policies WHERE code = 'MATERIALITY_BASIS' AND active = 1`).get() as { parameters_json: string } | undefined;
  const params = row ? jparse(row.parameters_json, { fixed_inr: 1_000_000, revenue_percent: 0.5 }) : { fixed_inr: 1_000_000, revenue_percent: 0.5 };
  const fixed = Number(params.fixed_inr ?? 1_000_000);
  const pct = Number(params.revenue_percent ?? 0.5);
  const threshold = Math.max(fixed, (revenueBasis * pct) / 100);
  let level: MaterialityResult['level'];
  if (amount >= threshold * 2) level = 'HIGHLY_MATERIAL';
  else if (amount >= threshold) level = 'MATERIAL';
  else if (amount >= threshold * 0.1) level = 'LOW';
  else level = 'IMMATERIAL';
  return {
    level,
    material: amount >= threshold,
    amount,
    threshold: Math.round(threshold),
    basis: `max(fixed ₹${fixed.toLocaleString('en-IN')}, ${pct}% of monthly revenue ₹${revenueBasis.toLocaleString('en-IN')}) = ₹${Math.round(threshold).toLocaleString('en-IN')}`,
  };
}

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

export interface ConfidenceInput {
  exception_type: string;
  evidence_count: number;
  has_processor_report?: boolean;
  has_history_match?: boolean;
  has_exact_reference?: boolean;
  amounts_consistent?: boolean;
  duplicate_pair_found?: boolean;
  parser_gaps?: boolean;         // description unparseable / OCR gaps
  cross_system_agreement?: boolean; // invoice ↔ PO ↔ ledger agree
  deterministic_match?: boolean;   // pattern-based classification (marker in feed)
}

/**
 * Deterministic confidence score for a classification (0..100).
 * Transparent additive model — auditors can trace every component.
 */
export function scoreConfidence(input: ConfidenceInput): number {
  let c = 55; // base
  if (input.evidence_count >= 6) c += 12; else if (input.evidence_count >= 3) c += 8; else c -= 10;
  if (input.has_exact_reference) c += 12;
  if (input.amounts_consistent) c += 8;
  if (input.cross_system_agreement) c += 8;
  if (input.has_processor_report) c += 7;
  if (input.has_history_match) c += 6;
  if (input.duplicate_pair_found) c += 12;
  if (input.deterministic_match) c += 10;
  if (input.parser_gaps) c -= 12;
  return Math.max(5, Math.min(99, Math.round(c)));
}
