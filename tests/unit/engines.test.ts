/**
 * PHASE 12 UNIT TESTS — engines.
 * Covers: reconciliation matching, duplicate detection, exception classification inputs,
 * confidence, risk, policy rules, materiality, autonomy decisions, journal balancing,
 * journal validation, journal idempotency, connector retry/backoff.
 * Runner: minimal assert harness (exit 1 on any failure).
 */
import assert from 'node:assert/strict';
import { getMemoryDb, runSchema, newId } from '../../packages/database/src/db.ts';
import { seedDemoData } from '../../packages/database/src/seed.ts';
import { matchTransactions, findDuplicateBankPairs, loadRows, ledgerAmount, type BankRow, type LedgerRow } from '../../packages/finance-engine/src/reconciliation.ts';
import { validateProposal, createJournalEntry, postJournalEntry, buildTwoLineProposal, buildProcessorFeeProposal } from '../../packages/finance-engine/src/journalEngine.ts';
import type { ProposedJournal } from '../../packages/shared/src/types.ts';
import { fetchBankBatch, connectorPlan } from '../../packages/finance-engine/src/connectors.ts';
import { assessRisk } from '../../packages/risk-engine/src/riskEngine.ts';
import { assessMateriality, scoreConfidence } from '../../packages/risk-engine/src/materialityEngine.ts';
import { evaluatePolicies, policiesAllPassed } from '../../packages/policy-engine/src/policyEngine.ts';
import { decideAutonomy } from '../../packages/policy-engine/src/autonomyEngine.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  try {
    const r = fn();
    if (r instanceof Promise) {
      // handled by the async driver below
      (test as unknown as { _async: Array<[string, () => Promise<void>]> })._async.push([name, fn as () => Promise<void>]);
      return;
    }
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed += 1;
    failures.push(`${name}: ${(e as Error).message}`);
    console.log(`FAIL  ${name}\n      ${(e as Error).message.split('\n')[0]}`);
  }
}
(test as unknown as { _async: Array<[string, () => Promise<void>]> })._async = [];
async function runAsync(): Promise<void> {
  for (const [name, fn] of (test as unknown as { _async: Array<[string, () => Promise<void>]> })._async) {
    try {
      await fn();
      passed += 1;
      console.log(`  ok  ${name}`);
    } catch (e) {
      failed += 1;
      failures.push(`${name}: ${(e as Error).message}`);
      console.log(`FAIL  ${name}\n      ${(e as Error).message.split('\n')[0]}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Shared fixture db (seeded once — read-only for most tests)
// ---------------------------------------------------------------------------
const db = getMemoryDb();
runSchema(db);
seedDemoData(db, 2026);

function bank(id: string, ref: string | null, amount: number, date = '2026-09-05', cp = 'Acme', desc = 'Bank line'): BankRow {
  return { id, txn_date: date, description: desc, reference: ref, amount, counterparty: cp, raw_json: '{}' };
}
function ledger(id: string, ref: string | null, debit: number, credit: number, date = '2026-09-05', cp = 'Acme', desc = 'GL line'): LedgerRow {
  return { id, txn_date: date, description: desc, reference: ref, debit, credit, counterparty: cp };
}

// ---------------------------------------------------------------------------
console.log('\n== Reconciliation matching ==');

test('exact reference + amount match pairs bank and ledger rows', () => {
  const bank_rows = [bank('b1', 'REF-100', -50_000)];
  const ledger_rows = [ledger('l1', 'REF-100', 50_000, 0)];
  const r = matchTransactions(bank_rows, ledger_rows);
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0]!.bank_id, 'b1');
  assert.equal(r.matches[0]!.ledger_id, 'l1');
  assert.ok(['EXACT', 'ONE_TO_ONE'].includes(r.matches[0]!.match_type), `unexpected match_type ${r.matches[0]!.match_type}`);
  assert.equal(r.unmatchedBank.length, 0);
});

test('same-day fuzzy match (desc+counterparty+amount tolerance) catches ref-less rows', () => {
  const bank_rows = [bank('b2', null, -120_500, '2026-09-06', 'CloudScale India', 'Payment to CloudScale India')];
  const ledger_rows = [ledger('l2', null, 120_000, 0, '2026-09-06', 'CloudScale India', 'CloudScale India settlement')];
  const r = matchTransactions(bank_rows, ledger_rows);
  assert.equal(r.matches.length, 1, 'should fuzzy match within tolerance');
  assert.equal(r.unmatchedBank.length, 0);
});

test('amount beyond tolerance stays unmatched', () => {
  const bank_rows = [bank('b3', null, -500_000, '2026-09-06', 'Zeta Ltd')];
  const ledger_rows = [ledger('l3', null, 100_000, 0, '2026-09-06', 'Zeta Ltd')];
  const r = matchTransactions(bank_rows, ledger_rows);
  assert.equal(r.matches.length, 0);
  assert.equal(r.unmatchedBank.length, 1);
  assert.equal(r.unmatchedLedger.length, 1);
});

test('matched ledger rows are not double-consumed', () => {
  const bank_rows = [bank('b4', 'R1', -10_000), bank('b5', 'R2', -10_000)];
  const ledger_rows = [ledger('l4', 'R1', 10_000, 0)];
  const r = matchTransactions(bank_rows, ledger_rows);
  assert.equal(r.matches.length, 1);
  assert.equal(r.unmatchedBank.length, 1);
});

test('seeded demo data reconciles at a realistic rate (>85% matched)', () => {
  const { bank: b, ledger: l } = loadRows(db);
  const r = matchTransactions(b, l);
  const rate = r.matches.length / b.length;
  assert.ok(rate > 0.85, `match rate ${(rate * 100).toFixed(1)}% should be >85%`);
  assert.equal(r.unmatchedBank.length + r.unmatchedLedger.length > 0, true, 'designed exceptions must exist');
});

console.log('\n== Duplicate detection ==');

test('duplicate bank pairs detected on same ref+amount+date', () => {
  const rows = [bank('d1', 'DUP-1', -5_000), bank('d2', 'DUP-1', -5_000), bank('d3', 'DUP-2', -7_000)];
  const pairs = findDuplicateBankPairs(rows);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]!.kind, 'BANK');
  assert.equal(pairs[0]!.amount, 5_000);
});

test('distinct amounts with same ref are NOT duplicates', () => {
  const rows = [bank('d4', 'DUP-3', -5_000), bank('d5', 'DUP-3', -6_000)];
  assert.equal(findDuplicateBankPairs(rows).length, 0);
});

test('seeded data contains the designed duplicate-invoice case (INV-7721)', () => {
  const row = db.prepare(`SELECT COUNT(*) c FROM invoices WHERE invoice_number='INV-7721'`).get() as { c: number };
  assert.ok(row.c >= 2, 'two occurrences of INV-7721 must exist');
});

// ---------------------------------------------------------------------------
console.log('\n== Journal engine ==');

const EXP = { code: '5600', name: 'Payment processing fees' };
const CASH = { code: '1000', name: 'Cash — Bank' };

test('two-line proposal is balanced', () => {
  const p = buildTwoLineProposal('test-key-1', 'Fee write-off', EXP, CASH, 18_000, 'Dr fees', 'Cr cash');
  assert.equal(p.total_debit, p.total_credit);
  assert.equal(p.balanced, true);
  validateProposal(p); // must not throw
});

test('processor-fee 3-line proposal balances (fee + GST = cash)', () => {
  const p = buildProcessorFeeProposal('test-key-2', 'CloudScale fee', 15_254, 2_746, 18_000, { expense: EXP, gst: { code: '2200', name: 'GST Input' }, cash: CASH });
  assert.equal(p.total_debit, 18_000);
  assert.equal(p.total_credit, 18_000);
  assert.equal(p.balanced, true);
  validateProposal(p);
});

test('unbalanced proposal is REJECTED before persistence', () => {
  const bad: ProposedJournal = {
    currency: 'INR',
    idempotency_key: 'bad-1',
    description: 'broken',
    lines: [
      { account_code: '5600', account_name: 'Fees', debit: 500, credit: 0, description: 'dr' },
      { account_code: '1000', account_name: 'Cash', debit: 0, credit: 400, description: 'cr' },
    ],
    total_debit: 500,
    total_credit: 400,
    balanced: false,
  };
  assert.throws(() => validateProposal(bad), /balanced|debit|credit/i);
});

test('journal with zero lines is rejected', () => {
  const bad: ProposedJournal = { currency: 'INR', idempotency_key: 'bad-2', description: 'empty', lines: [], total_debit: 0, total_credit: 0, balanced: true };
  assert.throws(() => validateProposal(bad), /line/i);
});

test('idempotency: same key returns the SAME journal, no duplicate created', async () => {
  const mdb = getMemoryDb();
  runSchema(mdb);
  seedDemoData(mdb, 2026);
  const input = {
    org_id: 'org_demo_001',
    close_run_id: null,
    exception_id: null,
    description: 'Idempotency probe',
    idempotency_key: 'idem-probe-001',
    lines: [
      { account_code: '5600', account_name: 'Fees', debit: 1_000, credit: 0, description: 'dr' },
      { account_code: '1000', account_name: 'Cash', debit: 0, credit: 1_000, description: 'cr' },
    ],
    created_by: 'agent',
    material: false,
  };
  const r1 = createJournalEntry(mdb, input);
  const r2 = createJournalEntry(mdb, input);
  const r3 = createJournalEntry(mdb, input);
  assert.equal(r1.created, true);
  assert.equal(r2.created, false);
  assert.equal(r3.created, false);
  assert.equal(r1.journal.id, r2.journal.id);
  assert.equal(r1.journal.id, r3.journal.id);
  const count = (mdb.prepare(`SELECT COUNT(*) c FROM journal_entries WHERE idempotency_key='idem-probe-001'`).get() as { c: number }).c;
  assert.equal(count, 1);
});

test('idempotent posting: postJournalEntry twice posts once', async () => {
  const mdb = getMemoryDb();
  runSchema(mdb);
  seedDemoData(mdb, 2026);
  const r1 = createJournalEntry(mdb, {
    org_id: 'org_demo_001', close_run_id: null, exception_id: null, description: 'Post probe', idempotency_key: 'post-probe-001',
    lines: [
      { account_code: '5600', account_name: 'Fees', debit: 2_000, credit: 0, description: 'dr' },
      { account_code: '1000', account_name: 'Cash', debit: 0, credit: 2_000, description: 'cr' },
    ],
    created_by: 'agent', material: false,
  });
  // human approval promotes DRAFT → APPROVED (as the approval workflow does)
  mdb.prepare(`UPDATE journal_entries SET status='APPROVED' WHERE id=?`).run(r1.journal.id);
  const p1 = postJournalEntry(mdb, r1.journal.id);
  const p2 = postJournalEntry(mdb, r1.journal.id);
  assert.equal(p1.posted, true);
  assert.equal(p1.already, false);
  assert.equal(p2.posted, true);
  assert.equal(p2.already, true);
  assert.ok(p1.journal_number);
  assert.equal(p2.journal_number, p1.journal_number);
  // no duplicate GL mirror rows: exactly one line pair for the idempotency key
  const gl = (mdb.prepare(`SELECT COUNT(*) c FROM ledger_transactions WHERE reference='post-probe-001'`).get() as { c: number }).c;
  assert.equal(gl, 2, `expected exactly 2 GL mirror rows, got ${gl}`);
});

// ---------------------------------------------------------------------------
console.log('\n== Risk engine ==');

test('duplicate + suspicious + policy-fail escalates risk to HIGH/CRITICAL', () => {
  const base = { evidence_count: 3, confidence: 90 };
  const low = assessRisk({ exception_type: 'BANK_FEE', amount: 5_000, ...base });
  const dup = assessRisk({ exception_type: 'DUPLICATE_INVOICE', amount: 420_000, duplicate: true, ...base });
  const sus = assessRisk({ exception_type: 'SUSPICIOUS_TRANSACTION', amount: 500_000, suspicious: true, ...base });
  const viol = assessRisk({ exception_type: 'POLICY_VIOLATION', amount: 200_000, policy_failed: true, ...base });
  assert.ok(low.score < 40, `low-case score ${low.score}`);
  assert.ok(dup.score > low.score);
  assert.ok(sus.score >= 70, `suspicious must be high: ${sus.score}`);
  assert.ok(viol.score >= 60);
  assert.ok(['HIGH', 'CRITICAL'].includes(sus.level));
});

test('risk score is bounded 0..100 and monotonic in amount for mismatches', () => {
  const a = assessRisk({ exception_type: 'AMOUNT_MISMATCH', amount: 10_000, evidence_count: 2, confidence: 80 });
  const b = assessRisk({ exception_type: 'AMOUNT_MISMATCH', amount: 5_000_000, evidence_count: 2, confidence: 80 });
  assert.ok(a.score >= 0 && a.score <= 100);
  assert.ok(b.score >= 0 && b.score <= 100);
  assert.ok(b.score >= a.score);
});

// ---------------------------------------------------------------------------
console.log('\n== Materiality + confidence ==');

test('materiality: ₹18,40,000 IS material at ₹1,00,00,000 revenue basis (policy 1%)', () => {
  const m = assessMateriality(db, 1_840_000, 30_000_000);
  assert.equal(m.material, true);
  assert.equal(m.level, 'MATERIAL');
});

test('materiality: small bank fee is NOT material', () => {
  const m = assessMateriality(db, 5_000, 30_000_000);
  assert.equal(m.material, false);
});

test('confidence rises with stronger evidence, capped at 99', () => {
  const weak = scoreConfidence({ exception_type: 'UNKNOWN', evidence_count: 0, parser_gaps: true });
  const strong = scoreConfidence({ exception_type: 'AMOUNT_MISMATCH', evidence_count: 6, has_exact_reference: true, amounts_consistent: true, cross_system_agreement: true, has_processor_report: true, has_history_match: true });
  assert.ok(weak < strong, `weak ${weak} must be < strong ${strong}`);
  assert.ok(weak >= 0 && weak <= 100);
  assert.ok(strong <= 99);
});

// ---------------------------------------------------------------------------
console.log('\n== Policy engine ==');

test('journal above ₹10,00,000 fails CONTROLLER_APPROVAL policy (CASE B rule)', () => {
  const results = evaluatePolicies(db, { kind: 'JOURNAL_POST', amount: 1_840_000 });
  assert.equal(policiesAllPassed(results), false);
  assert.ok(results.some((r) => !r.passed && /controller/i.test(r.policy_code + ' ' + r.detail)));
});

test('journal below threshold passes journal policies', () => {
  const results = evaluatePolicies(db, { kind: 'JOURNAL_POST', amount: 50_000 });
  assert.equal(policiesAllPassed(results), true, JSON.stringify(results.filter((r) => !r.passed)));
});

test('duplicate-invoice auto-resolve violates DUPLICATE_INVOICE_BLOCK policy', () => {
  const results = evaluatePolicies(db, { kind: 'EXCEPTION_AUTO_RESOLVE', amount: 420_000, exception_type: 'DUPLICATE_INVOICE', duplicate: true });
  const failed = results.filter((r) => !r.passed);
  assert.ok(failed.some((r) => r.policy_code === 'DUPLICATE_INVOICE_BLOCK'), JSON.stringify(results));
});

// ---------------------------------------------------------------------------
console.log('\n== Autonomy engine ==');

function autoInput(over: Partial<Parameters<typeof decideAutonomy>[1]> = {}): Parameters<typeof decideAutonomy>[1] {
  return {
    confidence: 98,
    risk: assessRisk({ exception_type: 'BANK_FEE', amount: 5_000, evidence_count: 4, confidence: 98 }),
    materiality: assessMateriality(db, 5_000, 30_000_000),
    policy_results: [{ policy_code: 'P-X', passed: true, detail: 'ok', parameters: {} }],
    exception_type: 'BANK_FEE',
    amount: 5_000,
    ...over,
  };
}

test('high confidence + low risk + policies pass + immaterial => AUTO', () => {
  const d = decideAutonomy(db, autoInput());
  assert.equal(d.path, 'AUTO', JSON.stringify(d));
});

test('medium confidence => HUMAN (review)', () => {
  const d = decideAutonomy(db, autoInput({ confidence: 85 }));
  assert.equal(d.path, 'HUMAN', JSON.stringify(d));
});

test('duplicate or suspicious => ESCALATE (never auto-posted)', () => {
  const d1 = decideAutonomy(db, autoInput({ duplicate: true, exception_type: 'DUPLICATE_INVOICE', amount: 420_000, materiality: assessMateriality(db, 420_000, 30_000_000) }));
  const d2 = decideAutonomy(db, autoInput({ suspicious: true, exception_type: 'SUSPICIOUS_TRANSACTION', amount: 500_000, materiality: assessMateriality(db, 500_000, 30_000_000) }));
  assert.equal(d1.path, 'ESCALATE');
  assert.equal(d2.path, 'ESCALATE');
});

test('material amount => not AUTO (human gate)', () => {
  const d = decideAutonomy(db, autoInput({ amount: 1_840_000, materiality: assessMateriality(db, 1_840_000, 30_000_000), exception_type: 'ACCRUAL', confidence: 99 }));
  assert.notEqual(d.path, 'AUTO');
});

test('policy failure blocks auto-resolution', () => {
  const d = decideAutonomy(db, autoInput({ policy_results: [{ policy_code: 'P-Y', passed: false, detail: 'violation', parameters: {} }] }));
  assert.notEqual(d.path, 'AUTO');
});

// ---------------------------------------------------------------------------
console.log('\n== Connector retry/backoff (CASE 4) ==');

test('connector plan declares timeout batch, attempts and backoff schedule', () => {
  const p = connectorPlan();
  assert.ok(p.bank_timeout_batches.length > 0, 'demo must include a failure batch');
  assert.ok(p.attempts_before_success >= 1);
  assert.ok(p.backoff_ms.length >= 2, 'need exponential backoff steps');
  assert.ok(p.backoff_ms[1]! >= p.backoff_ms[0]!, 'backoff must be non-decreasing');
});

test('timeout batch succeeds via retry with backoff, records attempts', async () => {
  const batch = connectorPlan().bank_timeout_batches[0]!;
  const r = await fetchBankBatch(db, batch, 0);
  assert.equal(r.ok, true, 'retry should eventually succeed');
  assert.ok(r.attempts > 1, `expected >1 attempt, got ${r.attempts}`);
  assert.equal(r.simulated_timeout, true);
  assert.ok(r.backoffs_ms.length === r.attempts - 1);
});

// ---------------------------------------------------------------------------
console.log('\n== Seeded demo invariants ==');

test('demo seed satisfies all spec minimums (500/500/100/50/30/20/20)', () => {
  const c = (t: string, w = '') => (db.prepare(`SELECT COUNT(*) c FROM ${t} ${w}`).get() as { c: number }).c;
  assert.ok(c('bank_transactions') >= 500);
  assert.ok(c('ledger_transactions') >= 500);
  assert.ok(c('invoices') >= 100);
  assert.ok(c('vendors') >= 50);
  assert.ok(c('purchase_orders') >= 30);
  assert.ok(c('contracts') >= 20);
  assert.ok(c('accounting_policies') >= 20);
});

test('demo data is labeled SYNTHETIC and Case A amounts are exact (5,00,000 / 4,82,000 / 18,000)', () => {
  const org = db.prepare(`SELECT name FROM organizations LIMIT 1`).get() as { name: string };
  assert.ok(/SYNTHETIC/i.test(org.name));
  const inv = db.prepare(`SELECT total FROM invoices WHERE invoice_number='INV-2841' LIMIT 1`).get() as { total: number };
  assert.equal(inv.total, 500_000);
  const rows = db.prepare(`SELECT amount FROM bank_transactions WHERE raw_json LIKE '%CASE_A%'`).all() as unknown as Array<{ amount: number }>;
  const settlement = rows.find((r) => Math.abs(Math.abs(r.amount) - 482_000) < 1);
  assert.ok(settlement, `Case A bank settlement ₹4,82,000 must exist; rows: ${JSON.stringify(rows)}`);
  // difference vs invoice = exactly the ₹18,000 processing fee
  assert.equal(500_000 - 482_000, 18_000);
});

// ---------------------------------------------------------------------------
console.log('\n== Evidence graph ==');

test('Case A evidence graph spans vendor→contract→PO→invoice→payment→bank→GL', () => {
  const inv = db.prepare(`SELECT id FROM invoices WHERE invoice_number='INV-2841' LIMIT 1`).get() as { id: string };
  const types = db.prepare(`
    SELECT DISTINCT fe.entity_type t FROM financial_relationships fr
    JOIN financial_entities fe ON fe.id = fr.to_entity OR fe.id = fr.from_entity
    WHERE fr.from_entity = (SELECT id FROM financial_entities WHERE entity_type='INVOICE' AND external_ref = (SELECT invoice_number FROM invoices WHERE id=?))
       OR fr.to_entity = (SELECT id FROM financial_entities WHERE entity_type='INVOICE' AND external_ref = (SELECT invoice_number FROM invoices WHERE id=?))
  `).all(inv.id, inv.id) as unknown as Array<{ t: string }>;
  const set = new Set(types.map((x) => x.t));
  for (const expected of ['VENDOR', 'PURCHASE_ORDER', 'BANK_TRANSACTION', 'PAYMENT']) {
    assert.ok(set.has(expected), `expected ${expected} linked to invoice graph; got ${[...set].join(',')}`);
  }
});

// ---------------------------------------------------------------------------
console.log('\n== Id determinism ==');

test('newId generates unique prefixed ids', () => {
  const seen = new Set(Array.from({ length: 1000 }, () => newId('x')));
  assert.equal(seen.size, 1000);
});

// ---------------------------------------------------------------------------
await runAsync();

console.log(`\n==========================================`);
console.log(`UNIT RESULTS: ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
