/**
 * RISK ENGINE — deterministic 0..100 risk scoring with factor attribution.
 * Not an LLM: transparent, auditable rules (spec section 4). Every score lists
 * the factors that moved it, so decisions are explainable to auditors.
 */
import type { RiskResult, RiskLevel, Severity } from '../../shared/src/types.ts';

export interface RiskInput {
  exception_type: string;
  amount: number;
  suspicious?: boolean;
  duplicate?: boolean;
  policy_failed?: boolean;
  evidence_count: number;
  days_outstanding?: number;
  confidence: number;          // 0..100
  round_amount?: boolean;
  new_vendor?: boolean;
}

function levelOf(score: number): RiskLevel {
  if (score >= 70) return 'HIGH';
  if (score >= 40) return 'MEDIUM';
  return 'LOW';
}

export function assessRisk(input: RiskInput): RiskResult {
  const factors: string[] = [];
  let score = 10; // baseline
  factors.push('Baseline operational risk (10)');

  // Type-based risk
  switch (input.exception_type) {
    case 'SUSPICIOUS_TRANSACTION': score += 45; factors.push('Suspicious transaction indicator (+45)'); break;
    case 'DUPLICATE_INVOICE': score += 35; factors.push('Duplicate invoice — double-payment/fraud exposure (+35)'); break;
    case 'DUPLICATE_TRANSACTION': score += 30; factors.push('Duplicate transaction (+30)'); break;
    case 'POLICY_VIOLATION': score += 30; factors.push('Policy violation (+30)'); break;
    case 'MISSING_LEDGER_ENTRY': score += 25; factors.push('Cash movement without ledger entry (+25)'); break;
    case 'WRONG_VENDOR': score += 20; factors.push('Wrong counterparty — misposting risk (+20)'); break;
    case 'WRONG_GL_ACCOUNT': score += 15; factors.push('GL misclassification (+15)'); break;
    case 'FX_VARIANCE': score += 12; factors.push('FX exposure (+12)'); break;
    case 'AMOUNT_MISMATCH': score += 12; factors.push('Amount mismatch (+12)'); break;
    case 'BANK_FEE': score += 5; factors.push('Bank fee — routine (+5)'); break;
    case 'TIMING_DIFFERENCE': score += 4; factors.push('Timing difference — routine (+4)'); break;
    case 'UNSUPPORTED_TRANSACTION': score += 20; factors.push('Transaction lacks support (+20)'); break;
    default: factors.push('Unclassified exception (+8)'); score += 8;
  }

  if (input.amount >= 1_000_000) { score += 20; factors.push(`Material size ₹${input.amount.toLocaleString('en-IN')} (≥ ₹10,00,000) (+20)`); }
  else if (input.amount >= 250_000) { score += 10; factors.push(`Large amount ₹${input.amount.toLocaleString('en-IN')} (+10)`); }

  if (input.suspicious) { score += 25; factors.push('Suspicious flag from connector/classifier (+25)'); }
  if (input.duplicate) { score += 15; factors.push('Duplicate evidence (+15)'); }
  if (input.policy_failed) { score += 20; factors.push('Policy check failed (+20)'); }
  if (input.evidence_count < 3) { score += 10; factors.push(`Thin evidence (${input.evidence_count} items) (+10)`); }
  if ((input.days_outstanding ?? 0) > 30) { score += 8; factors.push('Aged item (>30 days) (+8)'); }
  if (input.round_amount) { score += 8; factors.push('Suspiciously round amount (+8)'); }
  if (input.new_vendor) { score += 8; factors.push('First-time vendor (+8)'); }
  if (input.confidence < 80) { score += 12; factors.push(`Low AI confidence (${input.confidence.toFixed(0)}%) (+12)`); }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const level = levelOf(score);
  return { level, score, factors };
}
