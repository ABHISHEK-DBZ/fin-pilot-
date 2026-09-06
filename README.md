# FinPilot — Autonomous Month-End Close Agent

> **Close the books. Not just chat about them.**
> Track 2 — Autonomous Office of the CFO

FinPilot is a working month-end close system: it ingests synthetic bank + ERP data,
reconciles bank against ledger, detects and investigates exceptions, applies policy / risk /
materiality / confidence scoring, auto-resolves safe cases, pauses for human approval on
material or risky ones, posts balanced idempotent journal entries, and produces a
CFO summary plus an audit-ready evidence package — all persisted in a real database and
driven through a real API and UI.

**All demo data is synthetic** (`FINPILOT_DEMO_SEED=2026`) and labeled as such everywhere.

---

## Quick start

```bash
npm install          # zero runtime deps; typescript for typecheck only
npm run seed         # migrate + seed deterministic demo data (seed 2026)
npm start            # http://localhost:4310
npm test             # full suite: 33 unit tests + 24 E2E checks
```

Requires Node.js ≥ 22.5 (uses the built-in `node:sqlite` module — no native compilation,
no external database). PostgreSQL deployment profile: see `docker-compose.yml` (`--profile pg`).

## Demo walkthrough (5 minutes)

1. Open http://localhost:4310 → pick a role (CFO, Controller, Accountant, Auditor — RBAC enforced).
2. **Overview** — live close metrics from the database (transactions, matches, auto-resolved, cash, risk).
3. **Close** → **Start September Close**. The orchestrator runs: ingest → normalize → reconcile →
   exceptions → investigate → autonomy decisions → journals. It **pauses** at the material
   ₹18,40,000 true-up accrual (Case B) awaiting **Controller** approval.
4. Switch role to Controller → approve → the close **resumes from checkpoint** and completes.
5. **Exceptions** — open any exception: finding, likely cause, recommendation, confidence, risk
   factors, policy results, proposed balanced journal, and the **evidence graph**
   (Vendor → Contract → PO → Invoice → Payment → Bank → GL → Policy).
   Demo cases:
   - **Case A** — CloudScale India INV-2841: ₹5,00,000 invoiced vs ₹4,82,000 settled; agent
     identifies the ₹18,000 payment-processing fee (processor report + 3-month fee history)
     and posts a balanced fee/GST/cash journal — auto-resolved at 98% confidence.
   - **Case C** — duplicate invoice INV-7721 (₹4,20,000 ×2): detected, escalated, never auto-posted.
6. **Audit** — the certified audit package (9 sections) with evidence-linked conclusions; download as Markdown.
7. **Build With AO** — the actual AI-assisted development log (no fabricated metrics).
8. **RESET DEMO** (Settings / Overview header) — restores the exact initial demo state.

Demo case 4 (bank connector timeout) runs inside the close: the synthetic connector fails
with `ETIMEDOUT`, retries with exponential backoff, and the workflow resumes from checkpoint
with no duplicate ingestion or posting — see the Agent Activity timeline.

## Architecture (financial safety first)

```
LLM-free decision core (deterministic, auditable)
  Reconciliation → Exception classification → Investigation (evidence-gathering)
  → Policy engine → Risk engine → Materiality → Confidence → Autonomy decision
  → (AUTO resolve | HUMAN review | ESCALATE)
  → Approval gate (typed tool executor only) → Journal engine (balanced, idempotent)
  → Database → Evidence graph → Audit package
```

- **Agents never touch SQL.** All mutations go through ~10 typed tools
  (`packages/workflow/src/tools.ts`), each persisted as `agent_steps` + `audit_events`.
- **Journals are validated** (debit = credit, non-empty lines, account codes) *before*
  persistence and re-verified at posting; `idempotency_key` has a unique index, so repeated
  execution can never duplicate a financial mutation.
- **Human-in-the-loop** is real: the workflow persists state, pauses, records the decision
  (APPROVE / REJECT / MODIFY / REQUEST MORE EVIDENCE), and resumes from checkpoint.
- **Autonomy thresholds are configurable** at runtime (Policies page / `data/policies/demo_policies.yaml`):
  auto-resolve requires confidence ≥ 97%, LOW risk, all policies passed, and amount below
  the materiality/review threshold; duplicates, suspicious items, policy failures, or
  material amounts escalate to humans.

## Repository layout

```
packages/
  shared/          domain types + money utilities
  database/        schema (29 tables), migrations, deterministic seed (2026), policy loader
  finance-engine/  connectors (retry/backoff), reconciliation, exceptions, journal engine
  policy-engine/   policy rules, autonomy decision engine
  risk-engine/     risk scoring, materiality, confidence
  agents/          investigation agent, CFO copilot (grounded, no hallucination)
  evidence-graph/  financial entities + relationships + neighborhood queries
  workflow/        typed tool executor, orchestrator (state machine, checkpoints), metrics, audit package
apps/
  api/             HTTP + SSE server, RBAC, static hosting (zero deps)
  web/             enterprise CFO UI (vanilla JS SPA)
data/              SQLite db, demo policies, fixtures
tests/             unit + E2E suites (npm test)
docs/              AO build log
```

## Demo roles (RBAC)

| Role | Can |
|---|---|
| CFO | everything: start close, approve, edit policies, reset demo |
| Controller | start close, approve/reject/modify |
| Accountant | start close, view, request evidence |
| Auditor | read-only everything, incl. audit package |

All users are demo users (`X-Finpilot-User` header selects the acting role); passwords are out
of scope for the public demo, and the complete demo runs without real bank/ERP credentials.

## Configuration

See `.env.example`: `FINPILOT_DEMO_SEED` (2026), `PORT` (4310), `FINPILOT_DB_PATH`,
optional LLM provider keys (used only for narrative phrasing — every number and evidence
link comes from the database; the LLM never mutates state).

## Documentation

- `docs/AO_BUILD_LOG.md` — actual AI-assisted development evidence (sessions, decisions, bugs, tests)
- `docker-compose.yml` — optional PostgreSQL profile for production-style deployment
