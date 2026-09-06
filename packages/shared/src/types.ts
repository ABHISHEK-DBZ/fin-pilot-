/**
 * FINPILOT shared domain types.
 * Single source of truth for workflow, exceptions, agents, policies and RBAC.
 * All data is SYNTHETIC demo data (see data/demo).
 */

// ---------------------------------------------------------------------------
// Enums (const objects — TS-erasable syntax only, runs on node --experimental-strip-types)
// ---------------------------------------------------------------------------

export const ExceptionType = {
  MISSING_LEDGER_ENTRY: 'MISSING_LEDGER_ENTRY',
  MISSING_BANK_TRANSACTION: 'MISSING_BANK_TRANSACTION',
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  DUPLICATE_TRANSACTION: 'DUPLICATE_TRANSACTION',
  DUPLICATE_INVOICE: 'DUPLICATE_INVOICE',
  TIMING_DIFFERENCE: 'TIMING_DIFFERENCE',
  BANK_FEE: 'BANK_FEE',
  FX_VARIANCE: 'FX_VARIANCE',
  WRONG_VENDOR: 'WRONG_VENDOR',
  WRONG_GL_ACCOUNT: 'WRONG_GL_ACCOUNT',
  POLICY_VIOLATION: 'POLICY_VIOLATION',
  UNSUPPORTED_TRANSACTION: 'UNSUPPORTED_TRANSACTION',
  SUSPICIOUS_TRANSACTION: 'SUSPICIOUS_TRANSACTION',
  UNKNOWN: 'UNKNOWN',
} as const;
export type ExceptionType = (typeof ExceptionType)[keyof typeof ExceptionType];

export const Severity = { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH', CRITICAL: 'CRITICAL' } as const;
export type Severity = (typeof Severity)[keyof typeof Severity];

export const RiskLevel = { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' } as const;
export type RiskLevel = (typeof RiskLevel)[keyof typeof RiskLevel];

export const MaterialityLevel = { IMMATERIAL: 'IMMATERIAL', LOW: 'LOW', MATERIAL: 'MATERIAL', HIGHLY_MATERIAL: 'HIGHLY_MATERIAL' } as const;
export type MaterialityLevel = (typeof MaterialityLevel)[keyof typeof MaterialityLevel];

export const ExceptionStatus = {
  OPEN: 'OPEN',
  INVESTIGATING: 'INVESTIGATING',
  AWAITING_REVIEW: 'AWAITING_REVIEW',
  RESOLVED_AUTO: 'RESOLVED_AUTO',
  RESOLVED_HUMAN: 'RESOLVED_HUMAN',
  ESCALATED: 'ESCALATED',
  REJECTED: 'REJECTED',
  CLOSED: 'CLOSED',
} as const;
export type ExceptionStatus = (typeof ExceptionStatus)[keyof typeof ExceptionStatus];

export const DecisionAction = { APPROVE: 'APPROVE', REJECT: 'REJECT', MODIFY: 'MODIFY', REQUEST_MORE_EVIDENCE: 'REQUEST_MORE_EVIDENCE' } as const;
export type DecisionAction = (typeof DecisionAction)[keyof typeof DecisionAction];

export const ResolutionPath = { AUTO: 'AUTO', HUMAN: 'HUMAN', ESCALATE: 'ESCALATE' } as const;
export type ResolutionPath = (typeof ResolutionPath)[keyof typeof ResolutionPath];

export const Role = { CFO: 'CFO', CONTROLLER: 'CONTROLLER', ACCOUNTANT: 'ACCOUNTANT', AUDITOR: 'AUDITOR' } as const;
export type Role = (typeof Role)[keyof typeof Role];

export const Agent = { ORCHESTRATOR: 'ORCHESTRATOR', RECONCILIATION: 'RECONCILIATION', INVESTIGATION: 'INVESTIGATION', CFO_COPILOT: 'CFO_COPILOT' } as const;
export type Agent = (typeof Agent)[keyof typeof Agent];

export const CloseStatus = {
  PLANNED: 'PLANNED',
  RUNNING: 'RUNNING',
  AWAITING_HUMAN: 'AWAITING_HUMAN',
  COMPLETING: 'COMPLETING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;
export type CloseStatus = (typeof CloseStatus)[keyof typeof CloseStatus];

export const TaskStatus = { PENDING: 'PENDING', RUNNING: 'RUNNING', DONE: 'DONE', FAILED: 'FAILED', SKIPPED: 'SKIPPED', PAUSED: 'PAUSED' } as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const JournalStatus = { DRAFT: 'DRAFT', PENDING_APPROVAL: 'PENDING_APPROVAL', APPROVED: 'APPROVED', POSTED: 'POSTED', REJECTED: 'REJECTED' } as const;
export type JournalStatus = (typeof JournalStatus)[keyof typeof JournalStatus];

export const ApprovalStatus = { PENDING: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED', MODIFIED: 'MODIFIED', MORE_EVIDENCE_REQUESTED: 'MORE_EVIDENCE_REQUESTED' } as const;
export type ApprovalStatus = (typeof ApprovalStatus)[keyof typeof ApprovalStatus];

export const EntityType = {
  VENDOR: 'VENDOR',
  CONTRACT: 'CONTRACT',
  PURCHASE_ORDER: 'PURCHASE_ORDER',
  INVOICE: 'INVOICE',
  PAYMENT: 'PAYMENT',
  BANK_TRANSACTION: 'BANK_TRANSACTION',
  GL_TRANSACTION: 'GL_TRANSACTION',
  JOURNAL_ENTRY: 'JOURNAL_ENTRY',
  POLICY: 'POLICY',
} as const;
export type EntityType = (typeof EntityType)[keyof typeof EntityType];

// Workflow plan: ordered close tasks (spec section 2)
export const CloseTaskKeys = [
  'LOAD_DATA',
  'NORMALIZE',
  'RECONCILE',
  'CLASSIFY_EXCEPTIONS',
  'INVESTIGATE',
  'DECIDE_AUTONOMY',
  'PREPARE_JOURNALS',
  'HUMAN_APPROVAL',
  'POST_JOURNALS',
  'COMPLETE_CLOSE',
  'CFO_REPORT',
  'AUDIT_PACKAGE',
] as const;
export type CloseTaskKey = (typeof CloseTaskKeys)[number];

// ---------------------------------------------------------------------------
// Structured records
// ---------------------------------------------------------------------------

export interface PolicyResult {
  policy_code: string;
  passed: boolean;
  detail: string;
  parameters: Record<string, unknown>;
}

export interface RiskResult {
  level: RiskLevel;
  score: number; // 0..100
  factors: string[];
}

export interface MaterialityResult {
  level: MaterialityLevel;
  material: boolean;
  amount: number;
  threshold: number;
  basis: string;
}

export interface AutonomyDecision {
  path: ResolutionPath;
  reason: string;
  confidence: number;
  policy_results: PolicyResult[];
  risk: RiskResult;
  materiality: MaterialityResult;
  requires_role: Role;
}

export interface InvestigationFinding {
  finding: string;
  likely_cause: string;
  recommendation: string;
  confidence: number;
  risk: RiskResult;
  required_human_action: DecisionAction | null;
  proposed_journal: ProposedJournal | null;
  evidence_refs: string[];
}

export interface ProposedJournalLine {
  account_code: string;
  account_name: string;
  debit: number;
  credit: number;
  description: string;
}

export interface ProposedJournal {
  idempotency_key: string;
  description: string;
  currency: string;
  lines: ProposedJournalLine[];
  total_debit: number;
  total_credit: number;
  balanced: boolean;
}

export interface WorkflowCheckpoint {
  task_index: number;
  task_key: CloseTaskKey | null;
  saved_at: string;
  state: Record<string, unknown>;
}

// Dashboard metrics — always computed from the database (spec section 12)
export interface DashboardMetrics {
  close_progress: number; // 0..100
  transactions_processed: number;
  matched_count: number;
  auto_resolved_count: number;
  human_review_count: number;
  unresolved_count: number;
  escalated_count: number;
  cash_position: number;
  cash_start: number;
  cash_change: number;
  forecast_next_month: number;
  risk_score: number;
  exception_severity_counts: Record<Severity, number>;
  journal_stats: { total: number; posted: number; pending_approval: number; rejected: number };
}

export const DEMO_SEED_DEFAULT = 2026;
export const SYNTHETIC_LABEL = 'SYNTHETIC DEMO DATA — NOT REAL FINANCIAL INFORMATION';
