-- FINPILOT database schema.
-- Portable SQL: runs on SQLite (embedded demo) and is the canonical model for the
-- PostgreSQL deployment profile (see docker-compose.yml --profile pg).
-- Spec section 9 mandates these tables. All financial data is SYNTHETIC.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Core / RBAC
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  fiscal_year_start TEXT NOT NULL DEFAULT '2026-04-01',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('CFO','CONTROLLER','ACCOUNTANT','AUDITOR')),
  org_id TEXT NOT NULL REFERENCES organizations(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Financial master data (SYNTHETIC)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bank_accounts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  account_number_masked TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  opening_balance REAL NOT NULL DEFAULT 0,
  connector TEXT NOT NULL DEFAULT 'synthetic-bank',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vendors (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  gstin_masked TEXT,
  category TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contracts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  vendor_id TEXT NOT NULL REFERENCES vendors(id),
  contract_number TEXT NOT NULL,
  title TEXT NOT NULL,
  value REAL NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  payment_terms TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  vendor_id TEXT NOT NULL REFERENCES vendors(id),
  po_number TEXT NOT NULL UNIQUE,
  contract_id TEXT REFERENCES contracts(id),
  total REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL DEFAULT 'OPEN',
  issued_date TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id TEXT PRIMARY KEY,
  purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id),
  line_number INTEGER NOT NULL,
  description TEXT NOT NULL,
  gl_account_code TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL,
  amount REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  vendor_id TEXT NOT NULL REFERENCES vendors(id),
  invoice_number TEXT NOT NULL,
  purchase_order_id TEXT REFERENCES purchase_orders(id),
  amount REAL NOT NULL,
  tax REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  invoice_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
-- NOTE: no UNIQUE(vendor_id, invoice_number) constraint: duplicate invoices DO arrive in
-- real ERP feeds (spec Case C) and must be detected by the exception engine, not blocked
-- by the database. Detection is the engine's job.
CREATE INDEX IF NOT EXISTS idx_invoice_vendor_number ON invoices(vendor_id, invoice_number);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  line_number INTEGER NOT NULL,
  description TEXT NOT NULL,
  gl_account_code TEXT NOT NULL,
  amount REAL NOT NULL
);

-- ---------------------------------------------------------------------------
-- Transactions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ledger_accounts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')),
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('DEBIT','CREDIT')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id),
  txn_date TEXT NOT NULL,
  value_date TEXT,
  description TEXT NOT NULL,
  reference TEXT,
  amount REAL NOT NULL,            -- signed: positive credit (inflow), negative debit (outflow)
  balance REAL,
  counterparty TEXT,
  raw_json TEXT NOT NULL DEFAULT '{}',
  normalized INTEGER NOT NULL DEFAULT 0,
  ingest_run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bank_txn_date ON bank_transactions(txn_date);
CREATE INDEX IF NOT EXISTS idx_bank_ref ON bank_transactions(reference);

CREATE TABLE IF NOT EXISTS ledger_transactions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  ledger_account_id TEXT NOT NULL REFERENCES ledger_accounts(id),
  txn_date TEXT NOT NULL,
  description TEXT NOT NULL,
  reference TEXT,
  debit REAL NOT NULL DEFAULT 0,
  credit REAL NOT NULL DEFAULT 0,
  counterparty TEXT,
  raw_json TEXT NOT NULL DEFAULT '{}',
  normalized INTEGER NOT NULL DEFAULT 0,
  ingest_run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_txn_date ON ledger_transactions(txn_date);
CREATE INDEX IF NOT EXISTS idx_ledger_ref ON ledger_transactions(reference);

-- ---------------------------------------------------------------------------
-- Close runs & workflow
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS close_runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  period TEXT NOT NULL,                 -- e.g. '2026-09'
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PLANNED','RUNNING','AWAITING_HUMAN','COMPLETING','COMPLETED','FAILED','CANCELLED')),
  progress INTEGER NOT NULL DEFAULT 0,
  current_task TEXT,
  checkpoint_json TEXT,                 -- WorkflowCheckpoint
  metrics_json TEXT,                    -- cached dashboard snapshot
  cfo_summary_json TEXT,                -- generated CFO summary document
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS close_tasks (
  id TEXT PRIMARY KEY,
  close_run_id TEXT NOT NULL REFERENCES close_runs(id),
  task_key TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','RUNNING','DONE','FAILED','SKIPPED','PAUSED')),
  attempt INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  output_json TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Reconciliation / exceptions / evidence
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS reconciliations (
  id TEXT PRIMARY KEY,
  close_run_id TEXT NOT NULL REFERENCES close_runs(id),
  bank_transaction_id TEXT REFERENCES bank_transactions(id),
  ledger_transaction_id TEXT REFERENCES ledger_transactions(id),
  match_type TEXT NOT NULL CHECK (match_type IN ('EXACT','FUZZY','ONE_TO_ONE','GROUPED','UNMATCHED')),
  status TEXT NOT NULL CHECK (status IN ('MATCHED','UNMATCHED','INVESTIGATING')),
  score REAL NOT NULL,
  amount REAL NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recon_run ON reconciliations(close_run_id);

CREATE TABLE IF NOT EXISTS exceptions (
  id TEXT PRIMARY KEY,
  close_run_id TEXT NOT NULL REFERENCES close_runs(id),
  code TEXT NOT NULL,                    -- human code e.g. EXC-0001
  type TEXT NOT NULL,                    -- ExceptionType
  title TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  severity TEXT NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status TEXT NOT NULL CHECK (status IN ('OPEN','INVESTIGATING','AWAITING_REVIEW','RESOLVED_AUTO','RESOLVED_HUMAN','ESCALATED','REJECTED','CLOSED')),
  confidence REAL NOT NULL,              -- 0..100
  risk_level TEXT NOT NULL CHECK (risk_level IN ('LOW','MEDIUM','HIGH')),
  risk_score REAL NOT NULL,
  risk_factors_json TEXT NOT NULL DEFAULT '[]',
  materiality_level TEXT NOT NULL CHECK (materiality_level IN ('IMMATERIAL','LOW','MATERIAL','HIGHLY_MATERIAL')),
  material REAL NOT NULL,
  policy_results_json TEXT NOT NULL DEFAULT '[]',
  finding TEXT,
  likely_cause TEXT,
  recommendation TEXT,
  proposed_journal_json TEXT,
  resolution TEXT,
  resolved_by TEXT,                      -- user id or 'agent'
  resolved_at TEXT,
  demo_case TEXT,                        -- 'CASE_A' | 'CASE_B' | 'CASE_C' | 'CONNECTOR' | NULL
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exc_run ON exceptions(close_run_id);
CREATE INDEX IF NOT EXISTS idx_exc_status ON exceptions(status);

CREATE TABLE IF NOT EXISTS exception_evidence (
  id TEXT PRIMARY KEY,
  exception_id TEXT NOT NULL REFERENCES exceptions(id),
  entity_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  relationship TEXT NOT NULL,            -- e.g. 'SUPPORTS', 'HISTORICAL_FEE', 'POLICY'
  summary TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exc_evidence ON exception_evidence(exception_id);

CREATE TABLE IF NOT EXISTS financial_entities (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('VENDOR','CONTRACT','PURCHASE_ORDER','INVOICE','PAYMENT','BANK_TRANSACTION','GL_TRANSACTION','JOURNAL_ENTRY','POLICY')),
  external_ref TEXT,
  label TEXT NOT NULL,
  amount REAL,
  timestamp TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fe_type ON financial_entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_fe_ext ON financial_entities(external_ref);

CREATE TABLE IF NOT EXISTS financial_relationships (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  from_entity TEXT NOT NULL REFERENCES financial_entities(id),
  to_entity TEXT NOT NULL REFERENCES financial_entities(id),
  relationship TEXT NOT NULL,            -- e.g. 'ISSUED_BY','COVERED_BY','SETTLED_BY','RECORDED_AS','GOVERNED_BY'
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rel_from ON financial_relationships(from_entity);
CREATE INDEX IF NOT EXISTS idx_rel_to ON financial_relationships(to_entity);

-- ---------------------------------------------------------------------------
-- Journal engine
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  close_run_id TEXT REFERENCES close_runs(id),
  exception_id TEXT REFERENCES exceptions(id),
  journal_number TEXT UNIQUE,            -- JE-0001
  description TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  total_debit REAL NOT NULL,
  total_credit REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','POSTED','REJECTED')),
  idempotency_key TEXT NOT NULL UNIQUE,  -- repeated execution cannot duplicate
  amount REAL NOT NULL,
  material INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,              -- 'agent' or user id
  posted_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_je_idem ON journal_entries(idempotency_key);

CREATE TABLE IF NOT EXISTS journal_entry_lines (
  id TEXT PRIMARY KEY,
  journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id),
  line_number INTEGER NOT NULL,
  ledger_account_id TEXT NOT NULL REFERENCES ledger_accounts(id),
  debit REAL NOT NULL DEFAULT 0,
  credit REAL NOT NULL DEFAULT 0,
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  journal_entry_id TEXT REFERENCES journal_entries(id),
  exception_id TEXT REFERENCES exceptions(id),
  close_run_id TEXT REFERENCES close_runs(id),
  requested_by TEXT NOT NULL,
  required_role TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED','MODIFIED','MORE_EVIDENCE_REQUESTED')),
  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT,
  modification_json TEXT,
  created_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Agent system + audit
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  close_run_id TEXT REFERENCES close_runs(id),
  agent TEXT NOT NULL CHECK (agent IN ('ORCHESTRATOR','RECONCILIATION','INVESTIGATION','CFO_COPILOT')),
  purpose TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','DONE','FAILED','PAUSED')),
  input_summary TEXT,
  output_summary TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_steps (
  id TEXT PRIMARY KEY,
  agent_run_id TEXT NOT NULL REFERENCES agent_runs(id),
  step_number INTEGER NOT NULL,
  kind TEXT NOT NULL,                    -- 'PLAN','STATE_TRANSITION','TOOL_CALL','HUMAN_PAUSE','CHECKPOINT','RETRY'
  title TEXT NOT NULL,
  detail TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_actions (
  id TEXT PRIMARY KEY,
  agent_run_id TEXT NOT NULL REFERENCES agent_runs(id),
  close_run_id TEXT,
  agent TEXT NOT NULL,
  actor TEXT NOT NULL,                   -- 'agent' | user id
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  input_summary TEXT NOT NULL,
  output_summary TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL,
  policy_result TEXT,
  risk_result TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_actions_run ON agent_actions(agent_run_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  close_run_id TEXT,
  request_id TEXT,
  actor TEXT NOT NULL,                   -- 'agent:<name>' or 'user:<email>'
  actor_role TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  input_summary TEXT NOT NULL DEFAULT '',
  output_summary TEXT NOT NULL DEFAULT '',
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL,
  policy_result TEXT,
  risk_result TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_run ON audit_events(close_run_id);

-- Policies (configurable, versioned)
CREATE TABLE IF NOT EXISTS accounting_policies (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,             -- e.g. AUTO_RESOLVE, JE_APPROVAL_THRESHOLD
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  parameters_json TEXT NOT NULL,         -- JSON parameters (thresholds etc.)
  active INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
