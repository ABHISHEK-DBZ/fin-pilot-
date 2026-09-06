/**
 * RECONCILIATION ENGINE — matches bank ↔ ledger deterministically first
 * (reference join), then fuzzy (amount + date window + counterparty similarity).
 * Produces persisted reconciliation rows and feeds unmatched pairs to the
 * exception engine. Pure functions over typed rows; no LLM in the hot path.
 */
import type { DatabaseSync } from 'node:sqlite';
import { nowIso, newId, jparse } from '../../database/src/db.ts';
import { round2 } from '../../shared/src/money.ts';

export interface BankRow { id: string; txn_date: string; description: string; reference: string | null; amount: number; counterparty: string | null; raw_json: string }
export interface LedgerRow { id: string; txn_date: string; description: string; reference: string | null; debit: number; credit: number; counterparty: string | null }

export interface MatchResult {
  bank_id: string;
  ledger_id: string | null;
  match_type: 'EXACT' | 'FUZZY' | 'ONE_TO_ONE' | 'GROUPED' | 'UNMATCHED';
  status: 'MATCHED' | 'UNMATCHED' | 'INVESTIGATING';
  score: number;
  amount: number;
  detail: Record<string, unknown>;
}

const AMOUNT_TOL = 1;               // exact amounts within ₹1
const FUZZY_TOL_PCT = 0.015;        // 1.5% window for fuzzy amount match
const DATE_WINDOW_DAYS = 5;

function daysBetween(a: string, b: string): number {
  const da = new Date(a).getTime();
  const dbb = new Date(b).getTime();
  return Math.abs(Math.round((da - dbb) / 86_400_000));
}

function tokenOverlap(a: string, b: string): number {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter((t) => t.length > 2);
  const sa = new Set(norm(a)); const sb = new Set(norm(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let hit = 0;
  for (const t of sa) if (sb.has(t)) hit++;
  return hit / Math.max(sa.size, sb.size);
}

export function ledgerAmount(l: LedgerRow): number {
  return round2(l.debit - l.credit); // expense/outflow positive like bank |outflow|
}

/**
 * Full matching pass. Deterministic order: reference-exact → amount-exact →
 * fuzzy amount/date/counterparty. Consumes each ledger row at most once.
 */
export function matchTransactions(bankRows: BankRow[], ledgerRows: LedgerRow[]): { matches: MatchResult[]; unmatchedBank: BankRow[]; unmatchedLedger: LedgerRow[] } {
  const matches: MatchResult[] = [];
  const usedLedger = new Set<string>();
  const ledgerByRef = new Map<string, LedgerRow[]>();
  for (const l of ledgerRows) {
    if (!l.reference) continue;
    const arr = ledgerByRef.get(l.reference) ?? [];
    arr.push(l);
    ledgerByRef.set(l.reference, arr);
  }

  // Pass 1: exact reference + exact amount
  for (const b of bankRows) {
    if (!b.reference) continue;
    const candidates = ledgerByRef.get(b.reference) ?? [];
    const bankAbs = Math.abs(b.amount);
    for (const l of candidates) {
      if (usedLedger.has(l.id)) continue;
      const diff = Math.abs(Math.abs(ledgerAmount(l)) - bankAbs);
      if (diff <= AMOUNT_TOL) {
        usedLedger.add(l.id);
        matches.push({ bank_id: b.id, ledger_id: l.id, match_type: 'EXACT', status: 'MATCHED', score: 1, amount: bankAbs, detail: { basis: 'reference+amount', reference: b.reference } });
        break;
      }
    }
  }

  // Pass 2: amount-exact without reference (date window, counterparty similarity)
  for (const b of bankRows) {
    if (matches.some((m) => m.bank_id === b.id)) continue;
    const bankAbs = Math.abs(b.amount);
    let best: { l: LedgerRow; score: number } | null = null;
    for (const l of ledgerRows) {
      if (usedLedger.has(l.id)) continue;
      const la = Math.abs(ledgerAmount(l));
      if (Math.abs(la - bankAbs) > AMOUNT_TOL) continue;
      if (daysBetween(b.txn_date, l.txn_date) > DATE_WINDOW_DAYS) continue;
      const sim = tokenOverlap(b.description + ' ' + (b.counterparty ?? ''), l.description + ' ' + (l.counterparty ?? ''));
      const score = 0.8 + sim * 0.2;
      if (!best || score > best.score) best = { l, score };
    }
    if (best) {
      usedLedger.add(best.l.id);
      matches.push({ bank_id: b.id, ledger_id: best.l.id, match_type: 'ONE_TO_ONE', status: 'MATCHED', score: round2(best.score), amount: bankAbs, detail: { basis: 'amount+date+counterparty' } });
    }
  }

  // Pass 3: fuzzy amount within 1.5% (mismatches, FX) — same date window, requires reference or counterparty token overlap ≥ 0.4
  for (const b of bankRows) {
    if (matches.some((m) => m.bank_id === b.id)) continue;
    const bankAbs = Math.abs(b.amount);
    let best: { l: LedgerRow; score: number; delta: number } | null = null;
    for (const l of ledgerRows) {
      if (usedLedger.has(l.id)) continue;
      const la = Math.abs(ledgerAmount(l));
      const delta = la - bankAbs;
      if (Math.abs(delta) <= AMOUNT_TOL || bankAbs <= 0) continue;
      if (Math.abs(delta) / bankAbs > FUZZY_TOL_PCT) continue;
      if (daysBetween(b.txn_date, l.txn_date) > DATE_WINDOW_DAYS) continue;
      const refAgree = !!(b.reference && l.reference && b.reference === l.reference);
      const sim = tokenOverlap(b.description + ' ' + (b.counterparty ?? ''), l.description + ' ' + (l.counterparty ?? ''));
      if (!refAgree && sim < 0.4) continue;
      const score = refAgree ? 0.95 : 0.75 + sim * 0.2;
      if (!best || score > best.score) best = { l, score, delta };
    }
    if (best) {
      usedLedger.add(best.l.id);
      matches.push({ bank_id: b.id, ledger_id: best.l.id, match_type: 'FUZZY', status: 'INVESTIGATING', score: round2(best.score), amount: bankAbs, detail: { basis: 'fuzzy-amount', delta: round2(best.delta) } });
    }
  }

  const unmatchedBank = bankRows.filter((b) => !matches.some((m) => m.bank_id === b.id));
  const unmatchedLedger = ledgerRows.filter((l) => !usedLedger.has(l.id));
  return { matches, unmatchedBank, unmatchedLedger };
}

/** Duplicate detection: same (counterparty, amount, near-date) bank rows; same (vendor, number) invoices. */
export interface DuplicatePair { kind: 'BANK' | 'INVOICE'; a: string; b: string; amount: number; detail: string }

export function findDuplicateBankPairs(rows: BankRow[]): DuplicatePair[] {
  const out: DuplicatePair[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i] as BankRow; const b = rows[j] as BankRow;
      if (a.amount === b.amount && a.counterparty && a.counterparty === b.counterparty && a.amount < 0) {
        if (daysBetween(a.txn_date, b.txn_date) <= 3) {
          out.push({ kind: 'BANK', a: a.id, b: b.id, amount: Math.abs(a.amount), detail: `identical debit ₹${Math.abs(a.amount).toLocaleString('en-IN')} to ${a.counterparty} within 3 days` });
        }
      }
    }
  }
  return out;
}

/** Persist matches into reconciliations. */
export function persistMatches(db: DatabaseSync, closeRunId: string, matches: MatchResult[]): number {
  const now = nowIso();
  let n = 0;
  for (const m of matches) {
    db.prepare(`INSERT INTO reconciliations (id, close_run_id, bank_transaction_id, ledger_transaction_id, match_type, status, score, amount, detail_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(newId('rec'), closeRunId, m.bank_id, m.ledger_id, m.match_type, m.status, m.score, m.amount, JSON.stringify(m.detail), now);
    n++;
  }
  return n;
}

export function loadRows(db: DatabaseSync): { bank: BankRow[]; ledger: LedgerRow[] } {
  const bank = db.prepare(`SELECT id, txn_date, description, reference, amount, counterparty, raw_json FROM bank_transactions`).all() as unknown as BankRow[];
  const ledger = db.prepare(`SELECT id, txn_date, description, reference, debit, credit, counterparty FROM ledger_transactions`).all() as unknown as LedgerRow[];
  return { bank, ledger };
}
