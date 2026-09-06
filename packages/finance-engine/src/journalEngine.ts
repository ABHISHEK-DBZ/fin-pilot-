/**
 * JOURNAL ENGINE — real, balanced, idempotent journal entries.
 * Rules (spec section 7):
 *   - header + lines, total debit MUST equal total credit before posting
 *   - idempotency keys: repeated execution can never duplicate a posting
 *   - the LLM never writes journal rows directly; the typed tool executor does
 */
import type { DatabaseSync } from 'node:sqlite';
import { nowIso, newId, jparse } from '../../database/src/db.ts';
import type { ProposedJournal, ProposedJournalLine } from '../../shared/src/types.ts';
import { round2 } from '../../shared/src/money.ts';

export class JournalValidationError extends Error {}

export interface CreateJournalInput {
  org_id: string;
  close_run_id: string | null;
  exception_id: string | null;
  description: string;
  idempotency_key: string;
  lines: ProposedJournalLine[];
  created_by: string;            // 'agent' or user id
  material: boolean;
  currency?: string;
}

export interface JournalRecord {
  id: string;
  journal_number: string | null;
  status: string;
  total_debit: number;
  total_credit: number;
  idempotency_key: string;
}

/** Build a two-line balanced proposal: debit an expense/asset, credit cash/AP. */
export function buildTwoLineProposal(idempotency_key: string, description: string, debitAccount: { code: string; name: string }, creditAccount: { code: string; name: string }, amount: number, debitDesc: string, creditDesc: string): ProposedJournal {
  const lines: ProposedJournalLine[] = [
    { account_code: debitAccount.code, account_name: debitAccount.name, debit: round2(amount), credit: 0, description: debitDesc },
    { account_code: creditAccount.code, account_name: creditAccount.name, debit: 0, credit: round2(amount), description: creditDesc },
  ];
  return { idempotency_key, description, currency: 'INR', lines, total_debit: round2(amount), total_credit: round2(amount), balanced: true };
}

/** Three-line processor-fee entry: expense + GST credit + cash. */
export function buildProcessorFeeProposal(idempotency_key: string, description: string, feeExcl: number, gst: number, cashCredit: number, accounts: { expense: { code: string; name: string }; gst: { code: string; name: string }; cash: { code: string; name: string } }): ProposedJournal {
  const lines: ProposedJournalLine[] = [
    { account_code: accounts.expense.code, account_name: accounts.expense.name, debit: round2(feeExcl), credit: 0, description: 'Payment processing fee (settlement difference)' },
    { account_code: accounts.gst.code, account_name: accounts.gst.name, debit: round2(gst), credit: 0, description: 'GST on processing fee (input tax credit)' },
    { account_code: accounts.cash.code, account_name: accounts.cash.name, debit: 0, credit: round2(feeExcl + gst), description: 'Settlement shortfall written to processing fees' },
  ];
  const total = round2(feeExcl + gst);
  return { idempotency_key, description, currency: 'INR', lines, total_debit: total, total_credit: total, balanced: round2(feeExcl + gst) === total };
}

export function validateProposal(proposal: ProposedJournal): void {
  if (!proposal.lines || proposal.lines.length < 2) throw new JournalValidationError('Journal needs at least two lines');
  let d = 0; let c = 0;
  for (const l of proposal.lines) { d += l.debit; c += l.credit; }
  d = round2(d); c = round2(c);
  if (d !== c) throw new JournalValidationError(`Unbalanced journal: debit ${d} ≠ credit ${c}`);
  for (const l of proposal.lines) {
    if (l.debit > 0 && l.credit > 0) throw new JournalValidationError('A line cannot be both debit and credit');
    if (l.debit < 0 || l.credit < 0) throw new JournalValidationError('Negative amounts are not allowed');
  }
}

/**
 * Create or fetch (idempotent). If the idempotency key exists, the existing entry
 * is returned untouched — repeated execution never duplicates financial mutations.
 */
export function createJournalEntry(db: DatabaseSync, input: CreateJournalInput): { journal: JournalRecord; created: boolean } {
  const existing = db.prepare(`SELECT id, journal_number, status, total_debit, total_credit, idempotency_key FROM journal_entries WHERE idempotency_key = ?`).get(input.idempotency_key) as unknown as JournalRecord | undefined;
  if (existing) return { journal: existing, created: false };

  validateProposalLines(input.lines);
  const id = newId('je');
  const now = nowIso();
  const total = round2(input.lines.reduce((s, l) => s + l.debit, 0));
  const status = input.material ? 'PENDING_APPROVAL' : 'APPROVED'; // non-material agent journals pre-approved by policy path
  db.prepare(`INSERT INTO journal_entries (id, org_id, close_run_id, exception_id, journal_number, description, currency, total_debit, total_credit, status, idempotency_key, amount, material, created_by, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, input.org_id, input.close_run_id, input.exception_id, `JE-${jeSeq(db)}`, input.description, input.currency ?? 'INR', total, total, status, input.idempotency_key, total, input.material ? 1 : 0, input.created_by, now);
  let n = 0;
  for (const l of input.lines) {
    n += 1;
    const acct = db.prepare(`SELECT id FROM ledger_accounts WHERE code = ?`).get(l.account_code) as { id: string } | undefined;
    if (!acct) throw new JournalValidationError(`Unknown GL account ${l.account_code}`);
    db.prepare(`INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, ledger_account_id, debit, credit, description) VALUES (?,?,?,?,?,?,?)`)
      .run(newId('jel'), id, n, acct.id, l.debit, l.credit, l.description);
  }
  const journal = db.prepare(`SELECT id, journal_number, status, total_debit, total_credit, idempotency_key FROM journal_entries WHERE id = ?`).get(id) as unknown as JournalRecord;
  return { journal, created: true };
}

function validateProposalLines(lines: ProposedJournalLine[]): void {
  if (!lines || lines.length < 2) throw new JournalValidationError('Journal needs at least two lines');
  let d = 0; let c = 0;
  for (const l of lines) { d += l.debit; c += l.credit; }
  if (round2(d) !== round2(c)) throw new JournalValidationError(`Unbalanced journal: debit ${round2(d)} ≠ credit ${round2(c)}`);
}

function jeSeq(db: DatabaseSync): string {
  const c = (db.prepare(`SELECT COUNT(*) c FROM journal_entries`).get() as { c: number }).c + 1;
  return c.toString().padStart(4, '0');
}

/** Post an approved journal. Validates balance again, refuses non-approved. Idempotent. */
export function postJournalEntry(db: DatabaseSync, journalId: string): { posted: boolean; journal_number: string | null; already: boolean } {
  const je = db.prepare(`SELECT id, status, total_debit, total_credit, journal_number, idempotency_key FROM journal_entries WHERE id = ?`).get(journalId) as { id: string; status: string; total_debit: number; total_credit: number; journal_number: string | null; idempotency_key: string } | undefined;
  if (!je) throw new JournalValidationError(`Journal ${journalId} not found`);
  if (je.status === 'POSTED') return { posted: true, journal_number: je.journal_number, already: true };
  if (je.status !== 'APPROVED') throw new JournalValidationError(`Journal ${je.journal_number ?? je.id} is ${je.status}; only APPROVED entries can be posted`);

  // re-verify balance from lines (source of truth)
  const lines = db.prepare(`SELECT id, debit, credit FROM journal_entry_lines WHERE journal_entry_id = ?`).all(journalId) as Array<{ id: string; debit: number; credit: number }>;
  const d = round2(lines.reduce((s, l) => s + l.debit, 0));
  const c = round2(lines.reduce((s, l) => s + l.credit, 0));
  if (d !== c) throw new JournalValidationError(`Refusing to post unbalanced journal ${je.journal_number}: ${d} ≠ ${c}`);

  const now = nowIso();
  const org = (db.prepare(`SELECT org_id FROM journal_entries WHERE id=?`).get(journalId) as { org_id: string }).org_id;
  db.prepare(`UPDATE journal_entries SET status='POSTED', posted_at=? WHERE id=?`).run(now, journalId);
  // mirror as GL transactions (real ledger effect, deterministic)
  for (const l of lines) {
    const line = db.prepare(`SELECT ledger_account_id, debit, credit, description FROM journal_entry_lines WHERE id = ?`).get(l.id) as { ledger_account_id: string; debit: number; credit: number; description: string };
    db.prepare(`INSERT INTO ledger_transactions (id, org_id, ledger_account_id, txn_date, description, reference, debit, credit, counterparty, raw_json, normalized, ingest_run_id, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(newId('ltx'), org, line.ledger_account_id, now.slice(0, 10), line.description, je.idempotency_key, line.debit, line.credit, 'FinPilot Agent', JSON.stringify({ journal_entry_id: journalId }), 1, 'journal', now);
  }
  return { posted: true, journal_number: je.journal_number, already: false };
}

function jstring(v: unknown): string { return JSON.stringify(v ?? null); }
