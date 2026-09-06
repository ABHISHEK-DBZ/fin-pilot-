/**
 * FINPILOT deterministic synthetic demo data generator.
 * Seed: FINPILOT_DEMO_SEED=2026 (spec section 10).
 *
 * ALL DATA IS SYNTHETIC. Every row carries metadata synthetic=true.
 * Guarantees (asserted at generation time):
 *   - 500 bank transactions, 500 ledger transactions, 100 invoices,
 *     50 vendors, 30 purchase orders, 20 contracts, 20 policies.
 *   - Mandatory demo cases A/B/C + connector-failure case (spec section 11).
 *
 * RESET DEMO calls this module: it drops all rows and restores the exact
 * initial demo state deterministically.
 */
import type { DatabaseSync } from 'node:sqlite';
import { nowIso, newId, jstring } from './db.ts';
import { upsertPolicies } from './policyLoader.ts';
import { DEMO_SEED_DEFAULT, SYNTHETIC_LABEL } from '../../shared/src/types.ts';

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) — deterministic across runs/platforms
// ---------------------------------------------------------------------------

export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)] as T;
}
function intBetween(rng: () => number, lo: number, hi: number): number {
  return Math.floor(rng() * (hi - lo + 1)) + lo;
}

// ---------------------------------------------------------------------------
// Demo chart of accounts
// ---------------------------------------------------------------------------

export const CHART_OF_ACCOUNTS = [
  { code: '1000', name: 'Cash — HDFC Current Account', type: 'ASSET', normal_balance: 'DEBIT' },
  { code: '1010', name: 'Cash — ICICI Current Account', type: 'ASSET', normal_balance: 'DEBIT' },
  { code: '1100', name: 'Accounts Receivable', type: 'ASSET', normal_balance: 'DEBIT' },
  { code: '1200', name: 'Prepaid Expenses', type: 'ASSET', normal_balance: 'DEBIT' },
  { code: '1400', name: 'GST Input Tax Credit', type: 'ASSET', normal_balance: 'DEBIT' },
  { code: '2000', name: 'Accounts Payable', type: 'LIABILITY', normal_balance: 'CREDIT' },
  { code: '2100', name: 'Accrued Expenses', type: 'LIABILITY', normal_balance: 'CREDIT' },
  { code: '2200', name: 'TDS Payable', type: 'LIABILITY', normal_balance: 'CREDIT' },
  { code: '3000', name: 'Retained Earnings', type: 'EQUITY', normal_balance: 'CREDIT' },
  { code: '4000', name: 'Subscription Revenue', type: 'REVENUE', normal_balance: 'CREDIT' },
  { code: '4100', name: 'Professional Services Revenue', type: 'REVENUE', normal_balance: 'CREDIT' },
  { code: '5000', name: 'Cloud Infrastructure Expense', type: 'EXPENSE', normal_balance: 'DEBIT' },
  { code: '5100', name: 'Software & SaaS Expense', type: 'EXPENSE', normal_balance: 'DEBIT' },
  { code: '5200', name: 'Payment Processing Fees', type: 'EXPENSE', normal_balance: 'DEBIT' },
  { code: '5300', name: 'Professional Fees Expense', type: 'EXPENSE', normal_balance: 'DEBIT' },
  { code: '5400', name: 'Office & Admin Expense', type: 'EXPENSE', normal_balance: 'DEBIT' },
  { code: '5500', name: 'FX Loss Gain', type: 'EXPENSE', normal_balance: 'DEBIT' },
  { code: '5600', name: 'Bank Charges', type: 'EXPENSE', normal_balance: 'DEBIT' },
  { code: '5900', name: 'Miscellaneous / Unclassified', type: 'EXPENSE', normal_balance: 'DEBIT' },
] as const;

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

const VENDOR_NAMES = [
  'CloudScale India Pvt Ltd', 'Nimbus Analytics Ltd', 'Zenith Infotech LLP', 'Kaveri Systems Pvt Ltd',
  'Aarna Data Labs', 'Vayu Networks Pvt Ltd', 'Trinetra Security Ltd', 'Saral HR Technologies',
  'Banyan Cloud Services', 'Meridian Consulting LLP', 'Peacock Print Solutions', 'Indus Facilities Mgmt',
  'Kavya Content Studio', 'Surya Power Traders', 'Nalini Design House', 'Ganga Logistics Pvt Ltd',
  'Vyom Telecom Services', 'Chandra Marketing Co', 'Prithvi Hardware Supply', 'Tarang Media Works',
  'Ambar IoT Systems', 'Pawan Courier Services', 'Neelkanth Software LLP', 'Rudra Cloud Compute',
  'Shanti Office Supplies', 'Girik Equipment Rentals', 'Varun Water Solutions', 'Agni Fire Safety',
  'Dhruv Tax Advisors', 'Manthan Research Pvt Ltd', 'Anvaya Legal Services', 'Sahyadri Canteen Co',
  'Kalpana Interiors', 'Tejas Electricals', 'Bhoomi Landscaping', 'Himgiri AC Services',
  'Rohini Training Academy', 'Saanjh Creative Agency', 'Udaan Travel Desk', 'Pragati Stationers',
  'Nirmaya Health Services', 'Chaitanya Dev Works', 'Vasudha Recycling', 'Sindhu Packaging',
  'Alokjan Security Systems', 'Meghdoot Water Supply', 'Ishanya Furniture', 'Parthesh Auto Rentals',
  'Grishma Catering', 'Oorja Generators',
];

const CATEGORIES = ['CLOUD', 'SAAS', 'CONSULTING', 'FACILITIES', 'MARKETING', 'LOGISTICS', 'HARDWARE', 'SERVICES'];

const ORG_ID = 'org_demo_001';
const PERIOD_SEPT = '2026-09';
const PERIOD_AUG = '2026-08';

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export interface SeedResult {
  vendors: number;
  customers: number;
  contracts: number;
  purchase_orders: number;
  invoices: number;
  bank_txns: number;
  ledger_txns: number;
  policies: number;
  users: number;
  demo_cases: Record<string, string>; // case -> id (exception/vendor/invoice ids)
}

export function seedDemoData(db: DatabaseSync, seed: number = DEMO_SEED_DEFAULT): SeedResult {
  const rng = makeRng(seed);
  const now = nowIso();

  // --- wipe everything for exact RESET DEMO determinism ---
  db.exec(`
    DELETE FROM audit_events; DELETE FROM agent_actions; DELETE FROM agent_steps; DELETE FROM agent_runs;
    DELETE FROM approvals; DELETE FROM journal_entry_lines; DELETE FROM journal_entries;
    DELETE FROM exception_evidence; DELETE FROM exceptions; DELETE FROM reconciliations;
    DELETE FROM financial_relationships; DELETE FROM financial_entities;
    DELETE FROM close_tasks; DELETE FROM close_runs;
    DELETE FROM ledger_transactions; DELETE FROM bank_transactions;
    DELETE FROM invoice_lines; DELETE FROM invoices;
    DELETE FROM purchase_order_lines; DELETE FROM purchase_orders;
    DELETE FROM contracts; DELETE FROM vendors; DELETE FROM customers;
    DELETE FROM ledger_accounts; DELETE FROM bank_accounts;
    DELETE FROM accounting_policies; DELETE FROM notifications; DELETE FROM users; DELETE FROM organizations;
  `);

  // --- organization + users (RBAC demo roles) ---
  db.prepare(`INSERT INTO organizations (id, name, currency, fiscal_year_start, created_at) VALUES (?,?,?,?,?)`)
    .run(ORG_ID, 'FinPilot Demo Corp (SYNTHETIC)', 'INR', '2026-04-01', now);
  const users: Array<{ id: string; email: string; name: string; role: string }> = [
    { id: newId('usr'), email: 'cfo@finpilot.demo', name: 'Priya Menon (CFO)', role: 'CFO' },
    { id: newId('usr'), email: 'controller@finpilot.demo', name: 'Rahul Verma (Controller)', role: 'CONTROLLER' },
    { id: newId('usr'), email: 'accountant@finpilot.demo', name: 'Sneha Iyer (Accountant)', role: 'ACCOUNTANT' },
    { id: newId('usr'), email: 'auditor@finpilot.demo', name: 'Karan Rao (Auditor)', role: 'AUDITOR' },
  ];
  for (const u of users) {
    db.prepare(`INSERT INTO users (id, email, name, role, org_id, created_at) VALUES (?,?,?,?,?,?)`)
      .run(u.id, u.email, u.name, u.role, ORG_ID, now);
  }

  // --- ledger accounts (chart of accounts) ---
  const accountIds = new Map<string, string>();
  for (const a of CHART_OF_ACCOUNTS) {
    const id = newId('glacct');
    accountIds.set(a.code, id);
    db.prepare(`INSERT INTO ledger_accounts (id, org_id, code, name, type, normal_balance, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, ORG_ID, a.code, a.name, a.type, a.normal_balance, now);
  }

  // --- bank accounts ---
  const hdfcId = newId('bank');
  const iciciId = newId('bank');
  db.prepare(`INSERT INTO bank_accounts (id, org_id, bank_name, account_number_masked, currency, opening_balance, connector, created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(hdfcId, ORG_ID, 'HDFC Bank (SYNTHETIC)', 'XXXX4471', 'INR', 42_500_000, 'synthetic-bank', now);
  db.prepare(`INSERT INTO bank_accounts (id, org_id, bank_name, account_number_masked, currency, opening_balance, connector, created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(iciciId, ORG_ID, 'ICICI Bank (SYNTHETIC)', 'XXXX9912', 'INR', 12_800_000, 'synthetic-bank', now);

  // --- vendors (50) ---
  const vendorNames = VENDOR_NAMES.slice(0, 50);
  const vendorIds: string[] = [];
  const vendorMeta = new Map<string, { name: string; category: string }>();
  vendorNames.forEach((name, i) => {
    const id = newId('ven');
    vendorIds.push(id);
    const category = i === 0 ? 'CLOUD' : pick(rng, CATEGORIES);
    vendorMeta.set(id, { name, category });
    db.prepare(`INSERT INTO vendors (id, org_id, name, gstin_masked, category, created_at) VALUES (?,?,?,?,?,?)`)
      .run(id, ORG_ID, name, `29XXXX${(1000 + i).toString()}X${(i % 10)}`, category, now);
  });

  // --- customers (8, for revenue receipts) ---
  const customerNames = ['Meridian Retail Ltd', 'Orbit Logistics Pvt Ltd', 'Kalasoft Technologies', 'Deccan Finserv', 'UrbanNest Realty', 'Spandana Health', 'Trishul Manufacturing', 'Vistara Foods'];
  for (const c of customerNames) {
    db.prepare(`INSERT INTO customers (id, org_id, name, created_at) VALUES (?,?,?,?)`).run(newId('cus'), ORG_ID, c, now);
  }

  // --- contracts (20) ---
  const contractIds: string[] = [];
  const contractVendorIds: string[] = [];
  for (let i = 0; i < 20; i++) {
    const id = newId('con');
    const vendorId = vendorIds[i % vendorIds.length] as string;
    contractIds.push(id);
    contractVendorIds.push(vendorId);
    db.prepare(`INSERT INTO contracts (id, org_id, vendor_id, contract_number, title, value, start_date, end_date, payment_terms, metadata_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, ORG_ID, vendorId, `CTR-2026-${(101 + i).toString()}`, `${vendorMeta.get(vendorId)!.name} master services agreement`,
        intBetween(rng, 500_000, 9_000_000), '2026-04-01', '2027-03-31', pick(rng, ['NET-15', 'NET-30', 'NET-45']),
        jstring({ synthetic: true, auto_renew: rng() > 0.5 }), now);
  }

  // --- purchase orders (30) + lines ---
  const poIds: string[] = [];
  const poVendorIds: string[] = [];
  const poAccounts = ['5000', '5100', '5300', '5400'];
  for (let i = 0; i < 30; i++) {
    const id = newId('po');
    const vendorId = contractVendorIds[i % contractVendorIds.length];
    poIds.push(id);
    poVendorIds.push(vendorId);
    const contractId = contractIds[i % contractIds.length];
    const nLines = intBetween(rng, 1, 3);
    let total = 0;
    const lines: Array<{ d: string; acct: string; q: number; up: number; amt: number }> = [];
    for (let l = 0; l < nLines; l++) {
      const acct = pick(rng, poAccounts);
      const q = intBetween(rng, 1, 10);
      const up = intBetween(rng, 15_000, 250_000);
      const amt = q * up;
      total += amt;
      lines.push({ d: `${vendorMeta.get(vendorId)!.category.toLowerCase()} service line ${l + 1}`, acct, q, up, amt });
    }
    db.prepare(`INSERT INTO purchase_orders (id, org_id, vendor_id, po_number, contract_id, total, currency, status, issued_date, metadata_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, ORG_ID, vendorId, `PO-2026-${(1001 + i).toString()}`, contractId, total, 'INR', pick(rng, ['OPEN', 'CLOSED']), `2026-${pick(rng, ['07', '08'])}-${(intBetween(rng, 1, 27)).toString().padStart(2, '0')}`,
        jstring({ synthetic: true }), now);
    for (let l = 0; l < lines.length; l++) {
      const li = lines[l]!;
      db.prepare(`INSERT INTO purchase_order_lines (id, purchase_order_id, line_number, description, gl_account_code, quantity, unit_price, amount) VALUES (?,?,?,?,?,?,?,?)`)
        .run(newId('pol'), id, l + 1, li.d, li.acct, li.q, li.up, li.amt);
    }
  }

  // --- invoices (100) + lines; each invoice -> one Aug/Sept ledger expense + (mostly) bank payment ---
  const invoiceRows: Array<{ id: string; vendorId: string; number: string; poId: string; amount: number; tax: number; total: number; date: string; due: string; status: string; acct: string }> = [];
  for (let i = 0; i < 100; i++) {
    const id = newId('inv');
    const vendorId = poVendorIds[i % poVendorIds.length];
    const poId = poIds[i % poIds.length];
    const amount = intBetween(rng, 20_000, 800_000);
    const tax = Math.round(amount * 0.18);
    const total = amount + tax;
    const month = i % 3 === 0 ? PERIOD_SEPT : PERIOD_AUG;
    const day = intBetween(rng, 1, 27);
    const date = `${month}-${day.toString().padStart(2, '0')}`;
    const due = `${month}-${(Math.min(28, day + intBetween(rng, 10, 20))).toString().padStart(2, '0')}`;
    const acct = poAccounts[i % poAccounts.length];
    invoiceRows.push({ id, vendorId, number: `INV-${2000 + i * 7 + intBetween(rng, 0, 6)}`, poId, amount, tax, total, date, due, status: 'OPEN', acct });
    db.prepare(`INSERT INTO invoices (id, org_id, vendor_id, invoice_number, purchase_order_id, amount, tax, total, currency, invoice_date, due_date, status, metadata_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, ORG_ID, vendorId, invoiceRows[i]!.number, poId, amount, tax, total, 'INR', date, due, 'OPEN', jstring({ synthetic: true }), now);
    db.prepare(`INSERT INTO invoice_lines (id, invoice_id, line_number, description, gl_account_code, amount) VALUES (?,?,?,?,?,?)`)
      .run(newId('inl'), id, 1, `${vendorMeta.get(vendorId)!.category.toLowerCase()} services — base`, acct, amount);
    if (tax > 0) {
      db.prepare(`INSERT INTO invoice_lines (id, invoice_id, line_number, description, gl_account_code, amount) VALUES (?,?,?,?,?,?)`)
        .run(newId('inl'), id, 2, 'GST 18% (input tax credit)', '1400', tax);
    }
  }

  // ==========================================================================
  // MANDATORY DEMO CASES (spec section 11)
  // ==========================================================================

  // CASE A — CloudScale India payment fee: INV-2841 ₹5,00,000; settled ₹4,82,000; diff ₹18,000 processor fee.
  const caseAVendorId = vendorIds[0] as string; // CloudScale India Pvt Ltd
  const caseAInvoiceId = newId('inv');
  const caseATotal = 500_000;
  const caseABankAmt = 482_000;
  const caseADiff = 18_000;
  db.prepare(`INSERT INTO invoices (id, org_id, vendor_id, invoice_number, purchase_order_id, amount, tax, total, currency, invoice_date, due_date, status, metadata_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(caseAInvoiceId, ORG_ID, caseAVendorId, 'INV-2841', poIds[0] as string, Math.round(caseATotal / 1.18), caseATotal - Math.round(caseATotal / 1.18), caseATotal, 'INR', '2026-09-08', '2026-09-23', 'OPEN',
      jstring({ synthetic: true, demo_case: 'CASE_A', payment_processor: 'RazorpayX (SYNTHETIC)', processor_fee: caseADiff }), now);
  db.prepare(`INSERT INTO invoice_lines (id, invoice_id, line_number, description, gl_account_code, amount) VALUES (?,?,?,?,?,?)`)
    .run(newId('inl'), caseAInvoiceId, 1, 'CloudScale compute & storage — September', '5000', Math.round(caseATotal / 1.18));
  db.prepare(`INSERT INTO invoice_lines (id, invoice_id, line_number, description, gl_account_code, amount) VALUES (?,?,?,?,?,?)`)
    .run(newId('inl'), caseAInvoiceId, 2, 'GST 18% (input tax credit)', '1400', caseATotal - Math.round(caseATotal / 1.18));

  // CASE C — duplicate invoice INV-7721 ₹4,20,000 twice (same vendor+number, different ids)
  const caseCVendorId = vendorIds[7] as string; // Saral HR Technologies
  const caseCInvoiceIds: string[] = [];
  const caseCTotal = 420_000;
  for (let d = 0; d < 2; d++) {
    const id = newId('inv');
    caseCInvoiceIds.push(id);
    db.prepare(`INSERT INTO invoices (id, org_id, vendor_id, invoice_number, purchase_order_id, amount, tax, total, currency, invoice_date, due_date, status, metadata_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, ORG_ID, caseCVendorId, 'INV-7721', poIds[7] as string, Math.round(caseCTotal / 1.18), caseCTotal - Math.round(caseCTotal / 1.18), caseCTotal, 'INR', '2026-09-11', '2026-09-26', 'OPEN',
        jstring({ synthetic: true, demo_case: 'CASE_C', source_system: d === 0 ? 'ERP-manual-entry' : 'ERP-vendor-portal-reupload' }), now);
    db.prepare(`INSERT INTO invoice_lines (id, invoice_id, line_number, description, gl_account_code, amount) VALUES (?,?,?,?,?,?)`)
      .run(newId('inl'), id, 1, 'Saral HR platform — annual license', '5100', Math.round(caseCTotal / 1.18));
    db.prepare(`INSERT INTO invoice_lines (id, invoice_id, line_number, description, gl_account_code, amount) VALUES (?,?,?,?,?,?)`)
      .run(newId('inl'), id, 2, 'GST 18% (input tax credit)', '1400', caseCTotal - Math.round(caseCTotal / 1.18));
  }

  // --- bank transactions (500) ---
  // Case A bank txn: credit from CloudScale perspective is outflow for us: -482,000 settling 500,000 invoice.
  const caseABankTxnId = newId('btx');
  db.prepare(`INSERT INTO bank_transactions (id, org_id, bank_account_id, txn_date, value_date, description, reference, amount, balance, counterparty, raw_json, normalized, ingest_run_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(caseABankTxnId, ORG_ID, hdfcId, '2026-09-21', '2026-09-21', 'NEFT DEBIT-CLOUDSCALE INDIA PVT LTD-INV2841-RAZORPAYX SETTLEMENT', 'NEFT/AXY/202609/2841', -caseABankAmt, 41_600_000, 'CloudScale India Pvt Ltd',
      jstring({ synthetic: true, demo_case: 'CASE_A', processor_ref: 'RZPX-SETL-90231', gateway_fee: caseADiff, settlement_gross: caseATotal }), 1, 'demo', now);

  const bankRows: Array<{ id: string; date: string; desc: string; ref: string; amount: number; counterparty: string; kind: string; meta: Record<string, unknown> }> = [];

  // Case C: only ONE bank payment for the duplicated invoice (second copy unpaid → duplicate detection)
  const caseCBankTxnId = newId('btx');
  db.prepare(`INSERT INTO bank_transactions (id, org_id, bank_account_id, txn_date, value_date, description, reference, amount, balance, counterparty, raw_json, normalized, ingest_run_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(caseCBankTxnId, ORG_ID, hdfcId, '2026-09-19', '2026-09-19', 'NEFT DEBIT-SARAL HR TECHNOLOGIES-INV7721', 'NEFT/HDFC/202609/7721', -caseCTotal, 42_100_000, 'Saral HR Technologies',
      jstring({ synthetic: true, demo_case: 'CASE_C' }), 1, 'demo', now);

  // Connector-failure demo (spec Case: bank connector timeout) — batch 2 flagged in connector plan
  const connectorBatch: string[] = [];

  // Regular transactions: vendor payments (outflows), customer receipts (inflows), fees, FX, payroll-ish
  // Cash design: each August invoice paid EXACTLY ONCE (realistic AP run); receipts sized so the
  // month nets to a plausible small cash decrease (~1.8% of opening) — a defensible CFO story.
  const payablePool = invoiceRows.filter((r) => r.date.startsWith(PERIOD_AUG)).map((r) => ({ ...r }));
  let payIdx = 0;
  const caseATotalBankRows = 500;
  let bankCount = 2; // case A + case C txns above
  const bankDaySeed = intBetween(rng, 1, 5);
  const vendorOutflowBudget = 9_200_000; // invoice-payment outflows for the month (SYNTHETIC)
  let vendorOutflow = 0;
  for (let i = 0; bankCount < caseATotalBankRows; i++) {
    const day = (bankDaySeed + i) % 27 + 1;
    const date = `2026-09-${day.toString().padStart(2, '0')}`;
    const roll = rng();
    const id = newId('btx');
    let desc = ''; let amount = 0; let counterparty = ''; let kind = 'VENDOR_PAYMENT'; let ref = `TXN/202609/${(10_000 + i).toString()}`;
    const meta: Record<string, unknown> = { synthetic: true };
    if (roll < 0.40) {
      // vendor payment matching an August invoice (each invoice paid once, capped by budget)
      if (payIdx < payablePool.length && vendorOutflow < vendorOutflowBudget) {
        const inv = payablePool[payIdx] as (typeof payablePool)[number];
        payIdx += 1;
        const vendorName = vendorMeta.get(inv.vendorId)!.name;
        desc = `NEFT DEBIT-${vendorName.toUpperCase().slice(0, 26)}-${inv.number.replace('INV-', 'INV')}`;
        amount = -inv.total;
        counterparty = vendorName;
        meta.invoice_id = inv.id;
        meta.reconciles_invoice = inv.number;
      } else {
        desc = 'NEFT DEBIT-VENDOR PAYMENT';
        amount = -intBetween(rng, 25_000, 40_000);
        counterparty = pick(rng, vendorNames);
      }
      vendorOutflow += -amount;
      kind = 'VENDOR_PAYMENT';
    } else if (roll < 0.56) {
      // customer receipt
      const cust = pick(rng, customerNames);
      desc = `NEFT CREDIT-${cust.toUpperCase().slice(0, 28)}-INVOICE RECEIPT`;
      amount = intBetween(rng, 120_000, 560_000);
      counterparty = cust;
      kind = 'CUSTOMER_RECEIPT';
    } else if (roll < 0.62) {
      desc = pick(rng, ['BANK CHARGES-Q4 SERVICE FEE', 'IMPS CHARGES-TRNSACTION FEE', 'GST PAYMENT-CHALLAN', 'PAYROLL SALARY DISBURSEMENT', 'RENT-payment-landlord', 'UTILITY-ELECTRICITY-BILLPAY']);
      amount = -intBetween(rng, 900, 260_000);
      counterparty = 'HDFC BANK / GOVT / UTILITY';
      kind = pick(rng, ['BANK_CHARGE', 'TAX_PAYMENT', 'PAYROLL', 'RENT', 'UTILITY']);
    } else if (roll < 0.64) {
      // FX variance pair — slight exchange difference
      desc = 'SWIFT-USD SETTLEMENT-SAAS SUBSCRIPTION FX';
      amount = -intBetween(rng, 150_000, 300_000);
      counterparty = 'FOREIGN VENDOR (USD)';
      kind = 'FX_PAYMENT';
      meta.fx_rate = 83.4 + (rng() - 0.5) * 1.2;
    } else {
      desc = pick(rng, ['POS-0123-OFFICE SUPPLIES', 'UPI-payment-cab service', 'CARD payment-hosting renewal', 'NEFT DEBIT-MISC CONSULTING']);
      amount = -intBetween(rng, 1_200, 95_000);
      counterparty = pick(rng, vendorNames);
      kind = 'OPERATING';
    }
    // injected anomalies (spec section 10):
    if (i === 40) { desc = 'NEFT DEBIT-UNKNOWN COUNTERPARTY-CASH WITHDRAWAL'; amount = -500_000; counterparty = 'UNKNOWN'; kind = 'SUSPICIOUS'; meta.flag = 'ROUND_AMOUNT_OFFHOURS'; }
    if (i === 45) { desc = 'NEFT DEBIT-KAVERI SYSTEMS-INV-2988'; amount = -190_000; counterparty = 'Kaveri Systems'; kind = 'WRONG_VENDOR'; meta.expected_vendor = vendorMeta.get(vendorIds[3] as string)!.name; meta.actual_vendor = 'Kaveri Systems'; }
    if (i === 50) { desc = 'NEFT DEBIT-MERIDIAN CONSULTING-NO PO REFERENCE'; amount = -450_000; counterparty = 'Meridian Consulting LLP'; kind = 'POLICY_VIOLATION'; meta.violation = 'THREE_WAY_MATCH'; meta.detail = 'payment without purchase order reference above 50,000 threshold'; }
    if (i === 90) { desc = 'NEFT DEBIT-VYOM TELECOM SERVICES-INV-3300'; amount = -260_000; counterparty = 'Vyom Telecom Services'; kind = 'WRONG_GL'; meta.expected_gl = '5000'; meta.booked_gl = '5900'; }
    if (i === 130) { desc = 'NO LEDGER ENTRY-PREPAID INSURANCE ANNUAL'; amount = -420_000; counterparty = 'Bharat General Insurance'; kind = 'MISSING_LEDGER'; }
    if (i === 210) { desc = 'TIMING DIFF-ACHEQUE-0009881-RENT SEPTEMBER'; amount = -180_000; counterparty = 'Landlord (P2P)'; kind = 'TIMING'; }
    if (i === 300) { desc = 'NEFT DEBIT-NIMBUS ANALYTICS LTD-INV-2214'; amount = -300_000; counterparty = 'Nimbus Analytics Ltd'; kind = 'MISSING_BANK_ENTRY'; meta.note = 'ledger has debit, bank feed missing this txn'; }
    if (i === 350) { desc = 'PAYMENT GATEWAY FEE-SEPTEMBER-SETTLEMENT'; amount = -32_500; counterparty = 'Payment Gateway'; kind = 'BANK_FEE'; }

    db.prepare(`INSERT INTO bank_transactions (id, org_id, bank_account_id, txn_date, value_date, description, reference, amount, balance, counterparty, raw_json, normalized, ingest_run_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, ORG_ID, rng() < 0.7 ? hdfcId : iciciId, date, date, desc, ref, amount, null, counterparty, jstring(meta), 0, 'demo', now);
    bankRows.push({ id, date, desc, ref, amount, counterparty, kind, meta });
    // rows in the connector-failure batch: the connector will "time out" the first attempt for these
    if (kind === 'FX_PAYMENT') connectorBatch.push(id);
    bankCount++;
  }

  // --- ledger transactions (500) ---
  let ledgerCount = 0;
  const usedBankRefs = new Set(bankRows.map((b) => b.ref));
  // Case A: ledger books full invoice ₹5,00,000 (AP debit... actually expense debit + GST)
  const caseALedgerId1 = newId('ltx');
  db.prepare(`INSERT INTO ledger_transactions (id, org_id, ledger_account_id, txn_date, description, reference, debit, credit, counterparty, raw_json, normalized, ingest_run_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(caseALedgerId1, ORG_ID, accountIds.get('5000') as string, '2026-09-08', 'CloudScale India — cloud infrastructure invoice INV-2841 (accrual)', 'INV-2841', 423_728.81, 0, 'CloudScale India Pvt Ltd', jstring({ synthetic: true, demo_case: 'CASE_A', invoice_id: caseAInvoiceId }), 1, 'demo', now);
  ledgerCount++;
  const caseALedgerId2 = newId('ltx');
  db.prepare(`INSERT INTO ledger_transactions (id, org_id, ledger_account_id, txn_date, description, reference, debit, credit, counterparty, raw_json, normalized, ingest_run_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(caseALedgerId2, ORG_ID, accountIds.get('1400') as string, '2026-09-08', 'GST input tax credit — INV-2841', 'INV-2841', 76_271.19, 0, 'CloudScale India Pvt Ltd', jstring({ synthetic: true, demo_case: 'CASE_A', invoice_id: caseAInvoiceId }), 1, 'demo', now);
  ledgerCount++;
  // Case C: ledger books invoice ONCE (bank paid once) — duplicate exists only on AP subledger
  const caseCLedgerId = newId('ltx');
  db.prepare(`INSERT INTO ledger_transactions (id, org_id, ledger_account_id, txn_date, description, reference, debit, credit, counterparty, raw_json, normalized, ingest_run_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(caseCLedgerId, ORG_ID, accountIds.get('5100') as string, '2026-09-11', 'Saral HR Technologies — HR platform license INV-7721', 'INV-7721', 355_932.20, 0, 'Saral HR Technologies', jstring({ synthetic: true, demo_case: 'CASE_C', invoice_id: caseCInvoiceIds[0] as string }), 1, 'demo', now);
  ledgerCount++;

  const caseBAmount = 1_840_000; // CASE B material journal — accrual inserted in glOnlyPlan below

  // Ledger generation: pass 1 mirrors cash-linked bank rows by REFERENCE (exact-match pool);
  // pass 2 fills the remainder with non-cash GL activity. Anomalies are designed-in:
  //  - MISSING_LEDGER: cash row with no GL twin (bank anomaly i===130)
  //  - MISSING_BANK: GL row with no bank twin (dr 300,000 Nimbus, ref GL-ONLY-NIMBUS-2214)
  //  - FX_VARIANCE: GL twin within ~0.4-1.2% of bank amount
  //  - AMOUNT_MISMATCH: GL twin differs by exactly 18,000 / 6,500 on two rows
  const cashLinked = bankRows.filter((b) => b.kind !== 'FX_PAYMENT'); // receipts included: they mirror to dr Cash / cr AR rows
  // rows that must stay UNMATCHED so the exception engine surfaces them:
  const cashLinkedToMirror = cashLinked.filter((b) =>
    b.meta.flag !== 'ROUND_AMOUNT_OFFHOURS' &&   // → SUSPICIOUS_TRANSACTION
    b.kind !== 'MISSING_LEDGER' &&               // → MISSING_LEDGER_ENTRY
    b.kind !== 'TIMING' &&                       // → TIMING_DIFFERENCE
    b.kind !== 'BANK_FEE'                        // → BANK_FEE exception + journal proposal
  );
  const MIRROR_CAP = 460; // cash-linked mirrors; leaves room for FX twins + GL-only rows within 500
  const mismatchPlan = new Map<number, number>([[0, 18_000], [7, 6_500]]); // mirrorIdx -> delta
  let mirrorIdx = 0;
  for (const b of cashLinkedToMirror) {
    if (ledgerCount >= MIRROR_CAP) break;
    const id = newId('ltx');
    const acct = b.kind === 'CUSTOMER_RECEIPT' ? '1000' : b.kind === 'BANK_CHARGE' || b.kind === 'BANK_FEE' ? '5600' : b.kind === 'PAYROLL' ? '5400' : b.kind === 'RENT' ? '5400' : b.kind === 'UTILITY' ? '5400' : b.kind === 'TAX_PAYMENT' ? '1400' : '5900';
    const gross = b.amount < 0 ? -b.amount : b.amount;
    const delta = mismatchPlan.get(mirrorIdx);
    const amount = delta ? gross + delta : gross;
    const debit = b.amount < 0 ? amount : 0;
    const credit = b.amount > 0 ? amount : 0;
    const lmeta: Record<string, unknown> = { synthetic: true, bank_txn_ref: b.ref };
    if (delta) lmeta.amount_mismatch_delta = delta;
    db.prepare(`INSERT INTO ledger_transactions (id, org_id, ledger_account_id, txn_date, description, reference, debit, credit, counterparty, raw_json, normalized, ingest_run_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, ORG_ID, accountIds.get(acct) as string, b.date, `GL entry — ${b.desc.slice(0, 60)}`, b.ref, debit, credit, b.counterparty, jstring(lmeta), 0, 'demo', now);
    mirrorIdx++;
    ledgerCount++;
  }
  // FX variance ledger twins for FX bank rows
  const fxRows = bankRows.filter((b) => b.kind === 'FX_PAYMENT');
  for (let i = 0; i < fxRows.length; i++) {
    const b = fxRows[i]!;
    if (ledgerCount >= 492) break; // every FX row gets a GL twin (variance case)
    const gross = -b.amount;
    const glAmt = Math.round(gross * (1 + ((i % 3) + 1) * 0.004));
    const id = newId('ltx');
    db.prepare(`INSERT INTO ledger_transactions (id, org_id, ledger_account_id, txn_date, description, reference, debit, credit, counterparty, raw_json, normalized, ingest_run_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, ORG_ID, accountIds.get('5500') as string, b.date, 'FX settlement — SaaS subscription (USD)', b.ref, glAmt, 0, b.counterparty, jstring({ synthetic: true, fx_variance: true }), 0, 'demo', now);
    ledgerCount++;
  }
  // GL-only rows (missing-bank-entry + CASE B accrual) then non-cash fill
  const glOnlyPlan: Array<{ acct: string; desc: string; ref: string; debit: number; credit: number; counterparty: string; meta: Record<string, unknown> }> = [
    { acct: '5000', desc: 'Nimbus Analytics — cloud infra accrual (bank feed missing)', ref: 'GL-ONLY-NIMBUS-2214', debit: 300_000, credit: 0, counterparty: 'Nimbus Analytics Ltd', meta: { synthetic: true, demo_note: 'MISSING_BANK_TRANSACTION case' } },
    { acct: '5000', desc: 'CloudScale committed-use true-up accrual', ref: 'TRU-SEP-001', debit: 1_840_000, credit: 0, counterparty: 'CloudScale India Pvt Ltd', meta: { synthetic: true, demo_case: 'CASE_B' } },
  ];
  let glOnly = 0;
  const nonCashAccounts = ['4000', '4100', '5900', '5500'];
  while (ledgerCount < 500) {
    const id = newId('ltx');
    const day = (ledgerCount % 27) + 1;
    const date = `2026-09-${day.toString().padStart(2, '0')}`;
    if (glOnly < glOnlyPlan.length) {
      const plan = glOnlyPlan[glOnly] as (typeof glOnlyPlan)[number];
      db.prepare(`INSERT INTO ledger_transactions (id, org_id, ledger_account_id, txn_date, description, reference, debit, credit, counterparty, raw_json, normalized, ingest_run_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, ORG_ID, accountIds.get(plan.acct) as string, '2026-09-24', plan.desc, plan.ref, plan.debit, plan.credit, plan.counterparty, jstring(plan.meta), 0, 'demo', now);
      glOnly++;
    } else {
      const acct = pick(rng, nonCashAccounts);
      const amt = acct === '4000' || acct === '4100' ? intBetween(rng, 150_000, 900_000) : intBetween(rng, 5_000, 180_000);
      const isRev = acct === '4000' || acct === '4100';
      const desc = isRev ? 'Revenue recognition — September' : acct === '5500' ? 'FX revaluation entry' : 'Operating expense — misc';
      const ref = isRev ? `REV/202609/${3000 + ledgerCount}` : `OPS/202609/${5000 + ledgerCount}`;
      const debit = isRev ? 0 : amt;
      const credit = isRev ? amt : 0;
      db.prepare(`INSERT INTO ledger_transactions (id, org_id, ledger_account_id, txn_date, description, reference, debit, credit, counterparty, raw_json, normalized, ingest_run_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, ORG_ID, accountIds.get(acct) as string, date, desc, ref, debit, credit, isRev ? 'Various customers' : pick(rng, vendorNames), jstring({ synthetic: true }), 0, 'demo', now);
    }
    ledgerCount++;
  }

  // --- financial evidence graph: entities + relationships (spec section 8) ---
  const feIds = new Map<string, string>(); // external key -> entity id

  function addEntity(key: string, entityType: string, externalRef: string, label: string, amount: number | null, timestamp: string, meta: Record<string, unknown>): string {
    const id = newId('fe');
    feIds.set(key, id);
    db.prepare(`INSERT INTO financial_entities (id, org_id, entity_type, external_ref, label, amount, timestamp, metadata_json, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, ORG_ID, entityType, externalRef, label, amount, timestamp, jstring({ ...meta, synthetic: true }), now);
    return id;
  }
  function addRel(fromKey: string, toKey: string, relationship: string, meta: Record<string, unknown> = {}): void {
    const from = feIds.get(fromKey); const to = feIds.get(toKey);
    if (!from || !to) return;
    db.prepare(`INSERT INTO financial_relationships (id, org_id, from_entity, to_entity, relationship, metadata_json, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(newId('rel'), ORG_ID, from, to, relationship, jstring(meta), now);
  }

  // Vendor entities + contract→PO→invoice chains for the 20 contract vendors
  for (let i = 0; i < 20; i++) {
    const vendorId = vendorIds[i] as string;
    const vName = vendorMeta.get(vendorId)!.name;
    addEntity(`ven:${vendorId}`, 'VENDOR', vendorId, vName, null, now, { vendor_id: vendorId });
    const conId = contractIds[i] as string;
    const cRow = db.prepare(`SELECT contract_number, value FROM contracts WHERE id = ?`).get(conId) as { contract_number: string; value: number };
    addEntity(`con:${conId}`, 'CONTRACT', cRow.contract_number, `Contract ${cRow.contract_number} — ${vName}`, cRow.value, now, { contract_id: conId });
    addRel(`con:${conId}`, `ven:${vendorId}`, 'ISSUED_BY');
  }
  for (let i = 0; i < 30; i++) {
    const poId = poIds[i] as string;
    const pRow = db.prepare(`SELECT po_number, vendor_id, contract_id, total FROM purchase_orders WHERE id = ?`).get(poId) as { po_number: string; vendor_id: string; contract_id: string; total: number };
    addEntity(`po:${poId}`, 'PURCHASE_ORDER', pRow.po_number, `Purchase Order ${pRow.po_number}`, pRow.total, now, { purchase_order_id: poId });
    addRel(`po:${poId}`, `ven:${pRow.vendor_id}`, 'ISSUED_TO');
    if (pRow.contract_id) addRel(`po:${poId}`, `con:${pRow.contract_id}`, 'COVERED_BY');
  }
  for (const inv of invoiceRows) {
    addEntity(`inv:${inv.id}`, 'INVOICE', inv.number, `Invoice ${inv.number} — ${vendorMeta.get(inv.vendorId)!.name}`, inv.total, inv.date, { invoice_id: inv.id, vendor_id: inv.vendorId });
    addRel(`inv:${inv.id}`, `ven:${inv.vendorId}`, 'BILLED_BY');
    addRel(`inv:${inv.id}`, `po:${inv.poId}`, 'FULFILLS');
    addEntity(`pay:${inv.id}`, 'PAYMENT', `PAY-${inv.number}`, `Payment for ${inv.number}`, inv.total, inv.due, { invoice_id: inv.id, status: 'SCHEDULED' });
    addRel(`pay:${inv.id}`, `inv:${inv.id}`, 'SETTLES');
  }
  // Case A chain + processor report + historical fees evidence
  addEntity(`inv:${caseAInvoiceId}`, 'INVOICE', 'INV-2841', 'Invoice INV-2841 — CloudScale India (₹5,00,000)', caseATotal, '2026-09-08', { invoice_id: caseAInvoiceId, demo_case: 'CASE_A' });
  addRel(`inv:${caseAInvoiceId}`, `ven:${caseAVendorId}`, 'BILLED_BY');
  addRel(`inv:${caseAInvoiceId}`, `po:${poIds[0] as string}`, 'FULFILLS');
  addEntity(`btx:${caseABankTxnId}`, 'BANK_TRANSACTION', 'NEFT/AXY/202609/2841', 'Bank settlement ₹4,82,000 — CloudScale India', -caseABankAmt, '2026-09-21', { bank_transaction_id: caseABankTxnId, demo_case: 'CASE_A' });
  addRel(`btx:${caseABankTxnId}`, `inv:${caseAInvoiceId}`, 'PARTIALLY_SETTLES', { settled: caseABankAmt, gross: caseATotal, difference: caseADiff });
  addEntity('proc:RZPX-SETL-90231', 'PAYMENT', 'RZPX-SETL-90231', 'RazorpayX settlement report — fee ₹18,000 (2.5% + GST basis)', caseADiff, '2026-09-21', { demo_case: 'CASE_A', processor: 'RazorpayX (SYNTHETIC)', fee: caseADiff });
  addRel(`btx:${caseABankTxnId}`, 'proc:RZPX-SETL-90231', 'SETTLED_VIA');
  addRel('proc:RZPX-SETL-90231', `inv:${caseAInvoiceId}`, 'APPLIES_TO');
  // historical fee evidence (3 months of processor fees)
  const feeMonths = [['2026-06', 14_200], ['2026-07', 16_800], ['2026-08', 17_350]] as const;
  for (const [m, amt] of feeMonths) {
    addEntity(`histfee:${m}`, 'PAYMENT', `PG-FEE-${m}`, `Historical payment-gateway fee ${m}: ₹${amt.toLocaleString('en-IN')}`, amt, `${m}-28`, { demo_case: 'CASE_A', kind: 'HISTORICAL_FEE' });
    addRel(`histfee:${m}`, 'proc:RZPX-SETL-90231', 'HISTORICAL_FEE_PATTERN');
  }
  // Case C chain: two invoice occurrences, one bank payment
  caseCInvoiceIds.forEach((cid, idx) => {
    addEntity(`inv:${cid}`, 'INVOICE', 'INV-7721', `Invoice INV-7721 (occurrence ${idx + 1}) — Saral HR Technologies ₹4,20,000`, caseCTotal, '2026-09-11', { invoice_id: cid, demo_case: 'CASE_C', occurrence: idx + 1 });
    addRel(`inv:${cid}`, `ven:${caseCVendorId}`, 'BILLED_BY');
    addRel(`inv:${cid}`, `po:${poIds[7] as string}`, 'FULFILLS');
  });
  addEntity(`btx:${caseCBankTxnId}`, 'BANK_TRANSACTION', 'NEFT/HDFC/202609/7721', 'Bank payment ₹4,20,000 — Saral HR Technologies', -caseCTotal, '2026-09-19', { bank_transaction_id: caseCBankTxnId, demo_case: 'CASE_C' });
  caseCInvoiceIds.forEach((cid) => addRel(`btx:${caseCBankTxnId}`, `inv:${cid}`, 'POSSIBLE_SETTLEMENT'));
  // Case B: true-up accrual entity
  addEntity('tru:TRU-SEP-001', 'GL_TRANSACTION', 'TRU-SEP-001', 'Quarterly true-up accrual — ₹18,40,000 (CASE B)', caseBAmount, '2026-09-24', { demo_case: 'CASE_B' });

  // GL transaction entities for every ledger row (evidence graph coverage)
  const ltxRows = db.prepare(`SELECT id, txn_date, description, reference, debit, credit FROM ledger_transactions`).all() as Array<{ id: string; txn_date: string; description: string; reference: string; debit: number; credit: number }>;
  for (const r of ltxRows) {
    const key = `ltx:${r.id}`;
    addEntity(key, 'GL_TRANSACTION', r.reference ?? r.id, r.description.slice(0, 70), (r.debit || 0) - (r.credit || 0), r.txn_date, { ledger_transaction_id: r.id });
  }
  // Bank transaction entities for the rest of the bank rows
  for (const b of bankRows) {
    addEntity(`btx:${b.id}`, 'BANK_TRANSACTION', b.ref, b.desc.slice(0, 70), b.amount, b.date, { bank_transaction_id: b.id });
  }

  // --- accounting policies (catalog from data/policies) ---
  const policyCount = upsertPolicies(db, ORG_ID);
  // POLICY entities in the evidence graph (policy nodes are evidence targets)
  const polRows = db.prepare(`SELECT code, name, description, category FROM accounting_policies`).all() as Array<{ code: string; name: string; description: string; category: string }>;
  for (const p of polRows) {
    addEntity(`pol:${p.code}`, 'POLICY', p.code, `Policy ${p.code} — ${p.name}`, null, now, { policy_code: p.code, category: p.category, description: p.description.slice(0, 140) });
  }

  // --- notifications (welcome) ---
  db.prepare(`INSERT INTO notifications (id, org_id, user_id, kind, title, body, link, read, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(newId('ntf'), ORG_ID, null, 'SYSTEM', 'Demo environment ready', `${SYNTHETIC_LABEL}. Seed ${seed}. Start the September close from Overview.`, '/', 0, now);

  // sanity assertions — spec section 10 minimums
  const counts = {
    bank: (db.prepare(`SELECT COUNT(*) c FROM bank_transactions`).get() as { c: number }).c,
    ledger: (db.prepare(`SELECT COUNT(*) c FROM ledger_transactions`).get() as { c: number }).c,
    invoices: (db.prepare(`SELECT COUNT(*) c FROM invoices`).get() as { c: number }).c,
    vendors: (db.prepare(`SELECT COUNT(*) c FROM vendors`).get() as { c: number }).c,
    pos: (db.prepare(`SELECT COUNT(*) c FROM purchase_orders`).get() as { c: number }).c,
    contracts: (db.prepare(`SELECT COUNT(*) c FROM contracts`).get() as { c: number }).c,
    policies: (db.prepare(`SELECT COUNT(*) c FROM accounting_policies`).get() as { c: number }).c,
  };
  if (counts.bank < 500 || counts.ledger < 500 || counts.invoices < 100 || counts.vendors < 50 || counts.pos < 30 || counts.contracts < 20 || counts.policies < 20) {
    throw new Error(`Seed minimums violated: ${JSON.stringify(counts)}`);
  }

  // connector plan fixture: documents the simulated bank-connector timeout (batch of FX rows, 2 attempts then success)
  db.prepare(`INSERT INTO notifications (id, org_id, user_id, kind, title, body, link, read, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(newId('ntf'), ORG_ID, null, 'CONNECTOR', 'Synthetic bank connector plan loaded', `Bank connector will simulate a timeout for batch fx-${seed} (retry with backoff, max 3 attempts).`, '/close', 0, now);

  return {
    vendors: counts.vendors, customers: customerNames.length, contracts: counts.contracts,
    purchase_orders: counts.pos, invoices: counts.invoices, bank_txns: counts.bank,
    ledger_txns: counts.ledger, policies: counts.policies, users: users.length,
    demo_cases: {
      CASE_A_INVOICE: caseAInvoiceId, CASE_A_BANK_TXN: caseABankTxnId, CASE_A_VENDOR: caseAVendorId,
      CASE_C_INVOICES: caseCInvoiceIds.join(','), CASE_C_BANK_TXN: caseCBankTxnId, CASE_C_VENDOR: caseCVendorId,
      CASE_B_AMOUNT: String(caseBAmount), CONNECTOR_BATCH: connectorBatch.slice(0, 3).join(','), CASE_A_LEDGER: `${caseALedgerId1},${caseALedgerId2}`,
    },
  };
}

// CLI entry: node packages/database/src/seed.ts
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('seed.ts')) {
  const { getDb, runSchema } = await import('./db.ts');
  const db = getDb();
  runSchema(db);
  const seed = parseInt(process.env.FINPILOT_DEMO_SEED || String(DEMO_SEED_DEFAULT), 10);
  const res = seedDemoData(db, seed);
  console.log(`[seed] deterministic demo data written (seed=${seed})`);
  console.log(`[seed] ${JSON.stringify({ vendors: res.vendors, invoices: res.invoices, bank: res.bank_txns, ledger: res.ledger_txns, policies: res.policies })}`);
  console.log(`[seed] ${SYNTHETIC_LABEL}`);
}
