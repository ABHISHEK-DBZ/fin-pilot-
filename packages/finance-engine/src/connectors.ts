/**
 * Synthetic connectors (spec section 18: "deterministic synthetic connectors").
 * No real credentials. Bank connector simulates a timeout for one batch to
 * demonstrate retry-with-backoff and safe checkpoint resume (spec section 11,
 * failure case). All data remains SYNTHETIC.
 */
import { jparse, nowIso, newId } from '../../database/src/db.ts';

export interface ConnectorFetchResult {
  ok: boolean;
  batch: string;
  rows_fetched: number;
  attempts: number;
  backoffs_ms: number[];
  error: string | null;
  simulated_timeout: boolean;
}

export interface ConnectorPlan {
  bank_timeout_batches: string[];      // batches whose first N attempts time out
  attempts_before_success: number;     // 2 => 2 failures then success on 3rd
  backoff_ms: number[];                // per-retry backoff used in logs
}

const BASE_BACKOFF_MS = 40; // demo-scale backoff (production would be seconds)

export function connectorPlan(): ConnectorPlan {
  const seed = process.env.FINPILOT_DEMO_SEED || '2026';
  return {
    bank_timeout_batches: [`fx-${seed}`],
    attempts_before_success: parseInt(process.env.FINPILOT_BANK_TIMEOUT_AFTER_ATTEMPTS || '2', 10),
    backoff_ms: [BASE_BACKOFF_MS, BASE_BACKOFF_MS * 4, BASE_BACKOFF_MS * 8],
  };
}

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => { syntheticSetTimeout(resolve, ms); });

function syntheticSetTimeout(fn: () => void, ms: number): void {
  // Named indirection keeps the connector pure and unit-testable.
  globalThis.setTimeout(fn, ms);
}

/**
 * Fetch a bank batch with retry + exponential backoff.
 * Idempotent: batch id + cursor makes refetching safe.
 */
export async function fetchBankBatch(
  db: import('node:sqlite').DatabaseSync,
  batch: string,
  cursor: number,
  plan: ConnectorPlan = connectorPlan(),
): Promise<ConnectorFetchResult> {
  const shouldTimeout = plan.bank_timeout_batches.includes(batch);
  let attempts = 0;
  const backoffs: number[] = [];
  let error: string | null = null;

  while (attempts < 3) {
    attempts += 1;
    if (shouldTimeout && attempts <= plan.attempts_before_success) {
      error = `ETIMEDOUT: synthetic bank connector timeout on ${batch} (attempt ${attempts})`;
      const wait = plan.backoff_ms[Math.min(attempts - 1, plan.backoff_ms.length - 1)] as number;
      backoffs.push(wait);
      await sleep(wait); // exponential backoff, demo-scaled
      continue;
    }
    // success path — return the batch cursor result
    const rows = db.prepare(`SELECT COUNT(*) c FROM bank_transactions WHERE ingest_run_id = ?`).get(batch) as { c: number };
    return { ok: true, batch, rows_fetched: rows.c, attempts, backoffs_ms: backoffs, error: null, simulated_timeout: shouldTimeout && attempts > 1 };
  }
  return { ok: false, batch, rows_fetched: fetchRowEstimate(db, batch), attempts, backoffs_ms: backoffs, error: error ?? 'unknown connector failure', simulated_timeout: true };
}

function fetchRowEstimate(db: import('node:sqlite').DatabaseSync, batch: 'demo' | string): number {
  return (db.prepare(`SELECT COUNT(*) c FROM bank_transactions WHERE ingest_run_id = 'demo'`).get() as { c: number }).c;
}

/**
 * ERP connector: pulls invoices + ledger from the "ERP" (our synthetic tables).
 * Deterministic, no failure simulation.
 */
export function fetchErpSnapshot(db: import('node:sqlite').DatabaseSync): { invoices: number; ledger: number } {
  const inv = db.prepare(`SELECT COUNT(*) c FROM invoices`).get() as { c: number };
  const led = db.prepare(`SELECT COUNT(*) c FROM ledger_transactions`).get() as { c: number };
  return { invoices: inv.c, ledger: led.c };
}
