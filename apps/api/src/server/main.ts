/**
 * FINPILOT API server — zero-dependency node:http.
 * REST + SSE. Demo RBAC via X-Finpilot-User header (user id from users table);
 * every human mutation is validated against RBAC and persisted to audit_events.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, runSchema, nowIso, newId } from '../../../../packages/database/src/db.ts';
import { seedDemoData } from '../../../../packages/database/src/seed.ts';
import { createCloseRun, orchestrate, generateCfoSummary } from '../../../../packages/workflow/src/orchestrator.ts';
import { computeMetrics } from '../../../../packages/workflow/src/metrics.ts';
import { generateAuditPackage } from '../../../../packages/workflow/src/auditPackage.ts';
import { executeTool } from '../../../../packages/workflow/src/tools.ts';
import { answerCfoQuestion } from '../../../../packages/agents/src/cfoCopilot.ts';
import { evidenceForException, neighborhood } from '../../../../packages/evidence-graph/src/evidenceGraph.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || process.env.FINPILOT_PORT || '4310', 10);
const PUBLIC_DIR = path.resolve(__dirname, '..', '..', '..', 'web', 'public');

const db = getDb();
runSchema(db);

// Auto-seed on first boot (fresh/ephemeral deployment disks): if the database has no
// organization yet, load the deterministic demo dataset (FINPILOT_DEMO_SEED, default 2026).
{
  const orgs = (db.prepare(`SELECT COUNT(*) c FROM organizations`).get() as { c: number }).c;
  if (orgs === 0) {
    const seed = seedDemoData(db, parseInt(process.env.FINPILOT_DEMO_SEED || '2026', 10));
    console.log(`[finpilot] fresh database — seeded deterministic demo data (seed ${process.env.FINPILOT_DEMO_SEED || '2026'})`);
    console.log(`[finpilot]   bank=${seed.bank_txns} ledger=${seed.ledger_txns} invoices=${seed.invoices}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Ctx { db: typeof db }

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c: Buffer) => {
      data += c.toString();
      if (data.length > 1_000_000) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data) as Record<string, unknown>); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function currentUser(req: http.IncomingMessage): { id: string; name: string; role: string; email: string } | undefined {
  const header = req.headers['x-finpilot-user'];
  const email = typeof header === 'string' && header.includes('@') ? header : null;
  const userId = typeof header === 'string' && !header.includes('@') ? header : null;
  const row = email
    ? db.prepare(`SELECT id, name, role, email FROM users WHERE email = ?`).get(email) as unknown as { id: string; name: string; role: string; email: string } | undefined
    : userId
      ? db.prepare(`SELECT id, name, role, email FROM users WHERE id = ?`).get(userId) as unknown as { id: string; name: string; role: string; email: string } | undefined
      : undefined;
  return row;
}

const WRITE_ROLES: Record<string, string[]> = {
  '/api/close/start': ['CFO', 'CONTROLLER', 'ACCOUNTANT'],
  '/api/approvals/': ['CFO', 'CONTROLLER'],
  '/api/policies/': ['CFO'],
  '/api/demo/reset': ['CFO', 'CONTROLLER'],
  '/api/copilot': ['CFO', 'CONTROLLER', 'ACCOUNTANT', 'AUDITOR'],
};

function rbacCheck(req: http.IncomingMessage, pathname: string): { ok: boolean; error?: string; user?: { id: string; name: string; role: string; email: string } | undefined } {
  const user = currentUser(req);
  const needsRole = Object.keys(WRITE_ROLES).find((k) => pathname.startsWith(k));
  if (!needsRole) return { ok: true, user };
  if (!user) return { ok: false, error: 'Authentication required — select a demo role first (X-Finpilot-User header).' };
  if (!WRITE_ROLES[needsRole]!.includes(user.role)) {
    return { ok: false, error: `RBAC: role ${user.role} is not permitted to perform this action (requires ${WRITE_ROLES[needsRole]!.join(' or ')}).` };
  }
  return { ok: true, user };
}

function auditHuman(user: { id: string; role: string; email: string }, action: string, targetType: string, targetId: string, input: string, output: string, closeRunId: string | null): void {
  db.prepare(`INSERT INTO audit_events (id, org_id, close_run_id, request_id, actor, actor_role, action, target_type, target_id, input_summary, output_summary, evidence_ids_json, confidence, policy_result, risk_result, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(newId('aud'), 'org_demo_001', closeRunId, `req:${newId('r')}`, `user:${user.email}`, user.role, action, targetType, targetId, input, output, '[]', null, null, null, nowIso());
}

function latestCloseRunId(): string | null {
  return (db.prepare(`SELECT id FROM close_runs ORDER BY created_at DESC LIMIT 1`).get() as { id: string } | undefined)?.id ?? null;
}

// SSE clients
const sseClients = new Set<http.ServerResponse>();
function sseBroadcast(event: string, data: unknown): void {
  for (const res of sseClients) {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { sseClients.delete(res); }
  }
}

// ---------------------------------------------------------------------------
// Background orchestration
// ---------------------------------------------------------------------------

const activeRuns = new Set<string>();

async function runClose(closeRunId: string): Promise<void> {
  if (activeRuns.has(closeRunId)) return;
  activeRuns.add(closeRunId);
  try {
    const result = await orchestrate(db, closeRunId);
    sseBroadcast('progress', { close_run_id: closeRunId, status: result.status, paused_for_human: result.paused_for_human, completed: result.completed });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sseBroadcast('error', { close_run_id: closeRunId, error: msg });
  } finally {
    activeRuns.delete(closeRunId);
    sseBroadcast('state', { close_run_id: closeRunId });
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const pathname = url.pathname;
  try {
    // ---- SSE ----
    if (pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: hello\ndata: {}\n\n`);
      sseClients.add(res);
      const interval = setInterval(() => {
        try { res.write(`: ping\n\n`); } catch { /* closed */ }
      }, 15000);
      req.on('close', () => { clearInterval(interval); sseClients.delete(res); });
      return;
    }

    // ---- static UI ----
    if (req.method === 'GET' && !pathname.startsWith('/api/')) {
      serveStatic(pathname, res);
      return;
    }

    // ---- health ----
    if (pathname === '/api/health') {
      json(res, 200, { ok: true, service: 'finpilot-api', time: nowIso() });
      return;
    }

    // ---- users (demo role switcher) ----
    if (pathname === '/api/users') {
      const users = db.prepare(`SELECT id, name, email, role FROM users ORDER BY CASE role WHEN 'CFO' THEN 0 WHEN 'CONTROLLER' THEN 1 WHEN 'ACCOUNTANT' THEN 2 ELSE 3 END`).all();
      json(res, 200, { users });
      return;
    }

    // ---- state (dashboard + nav data) ----
    if (pathname === '/api/state') {
      const runId = latestCloseRunId();
      const run = runId ? db.prepare(`SELECT * FROM close_runs WHERE id=?`).get(runId) : null;
      const tasks = runId ? db.prepare(`SELECT task_key, title, status, detail, attempt, started_at, finished_at FROM close_tasks WHERE close_run_id=? ORDER BY created_at`).all(runId) : [];
      const pending = pendingApprovals();
      json(res, 200, {
        org: db.prepare(`SELECT * FROM organizations LIMIT 1`).get(),
        run,
        tasks,
        metrics: computeMetrics(db, runId),
        pending_approvals: pending,
        paused: run ? (run as { status: string }).status === 'AWAITING_HUMAN' : false,
        synthetic_label: 'SYNTHETIC DEMO DATA — NOT REAL FINANCIAL INFORMATION',
      });
      return;
    }

    // ---- RBAC-guarded mutations ----
    if (['POST', 'PATCH', 'DELETE'].includes(req.method ?? '')) {
      const gate = rbacCheck(req, pathname);
      if (!gate.ok || !gate.user) {
        json(res, 403, { error: gate.error ?? 'Forbidden' });
        return;
      }
      const user = gate.user;

      if (pathname === '/api/close/start' && req.method === 'POST') {
        const existing = latestCloseRunId();
        const existingRun = existing ? db.prepare(`SELECT status FROM close_runs WHERE id=?`).get(existing) as { status: string } : null;
        let runId: string;
        if (existingRun && ['PLANNED', 'RUNNING', 'AWAITING_HUMAN', 'FAILED'].includes(existingRun.status)) {
          runId = existing!; // resume
        } else {
          runId = createCloseRun(db, '2026-09');
        }
        auditHuman(user, 'CLOSE_START', 'close_run', runId, 'Start/Resume September close', 'Workflow orchestration triggered', runId);
        void runClose(runId);
        json(res, 202, { close_run_id: runId, status: 'STARTED' });
        return;
      }

      if (pathname.startsWith('/api/approvals/') && req.method === 'POST') {
        const approvalId = pathname.split('/')[3] ?? '';
        const body = await readBody(req);
        const decision = String(body.decision ?? '');
        if (!['APPROVE', 'REJECT', 'MODIFY', 'REQUEST_MORE_EVIDENCE'].includes(decision)) {
          json(res, 400, { error: 'decision must be APPROVE | REJECT | MODIFY | REQUEST_MORE_EVIDENCE' });
          return;
        }
        const agentRunId = newAgentRun('Human review');
        const out = await executeTool({ db, close_run_id: (db.prepare(`SELECT close_run_id FROM approvals WHERE id=?`).get(approvalId) as { close_run_id: string }).close_run_id, agent_run_id: agentRunId, request_id: `human:${user.id}` },
          'approval.decide', { approval_id: approvalId, decision, decided_by: `user:${user.email} (${user.role})`, note: String(body.note ?? ''), modification_json: body.modification_json ? JSON.stringify(body.modification_json) : undefined });
        auditHuman(user, `APPROVAL_${decision}`, 'approval', approvalId, String(body.note ?? ''), out.summary, null);
        // resume workflow after decision (non-blocking)
        const runId = latestCloseRunId();
        if (runId) void runClose(runId);
        json(res, 200, { ok: true, summary: out.summary });
        return;
      }

      if (pathname.startsWith('/api/policies/') && req.method === 'PATCH') {
        const code = pathname.split('/')[3] ?? '';
        const body = await readBody(req);
        const params = body.parameters as Record<string, unknown> | undefined;
        const active = typeof body.active === 'boolean' ? (body.active ? 1 : 0) : undefined;
        const existing = db.prepare(`SELECT id FROM accounting_policies WHERE code=?`).get(code) as { id: string } | undefined;
        if (!existing) { json(res, 404, { error: `policy ${code} not found` }); return; }
        if (params) db.prepare(`UPDATE accounting_policies SET parameters_json=?, updated_at=? WHERE id=?`).run(JSON.stringify(params), nowIso(), existing.id);
        if (active !== undefined) db.prepare(`UPDATE accounting_policies SET active=? WHERE id=?`).run(active, existing.id);
        auditHuman(user, 'POLICY_UPDATE', 'policy', code, JSON.stringify(body), 'Policy parameters updated', null);
        json(res, 200, { ok: true });
        return;
      }

      if (pathname === '/api/demo/reset' && req.method === 'POST') {
        const seed = parseInt(process.env.FINPILOT_DEMO_SEED || '2026', 10);
        seedDemoData(db, seed);
        auditHuman(user, 'DEMO_RESET', 'system', 'demo', `seed=${seed}`, 'Demo state restored to initial deterministic snapshot', null);
        json(res, 200, { ok: true, seed });
        return;
      }

      if (pathname === '/api/copilot' && req.method === 'POST') {
        const body = await readBody(req);
        const question = String(body.question ?? '');
        if (!question.trim()) { json(res, 400, { error: 'question required' }); return; }
        const agentRunId = newAgentRun(`CFO Copilot: ${question.slice(0, 60)}`);
        const answer = answerCfoQuestion(db, question);
        db.prepare(`INSERT INTO agent_runs (id, close_run_id, agent, purpose, status, input_summary, output_summary, attempt, started_at, finished_at) VALUES (?,?,'CFO_COPILOT',?,'DONE',?,?,1,?,?)`)
          .run(newId('arun'), latestCloseRunId(), question, question, answer.answer, nowIso(), nowIso());
        json(res, 200, answer);
        return;
      }

      if (pathname === '/api/exceptions/request-evidence' && req.method === 'POST') {
        const body = await readBody(req);
        const excId = String(body.exception_id ?? '');
        const exc = db.prepare(`SELECT id, close_run_id, code FROM exceptions WHERE id=?`).get(excId) as { id: string; close_run_id: string; code: string } | undefined;
        if (!exc) { json(res, 404, { error: 'exception not found' }); return; }
        db.prepare(`UPDATE exceptions SET status='INVESTIGATING', updated_at=? WHERE id=?`).run(nowIso(), excId);
        auditHuman(user, 'REQUEST_MORE_EVIDENCE', 'exception', exc.code, String(body.note ?? ''), 'Investigation reopened — additional evidence requested', exc.close_run_id);
        json(res, 200, { ok: true });
        return;
      }
    }

    // ---- reads ----
    if (pathname === '/api/exceptions') {
      const runId = url.searchParams.get('close_run_id') ?? latestCloseRunId();
      const rows = runId
        ? db.prepare(`SELECT id, code, type, title, amount, severity, status, confidence, risk_level, risk_score, materiality_level, material, finding, likely_cause, recommendation, resolution, demo_case, created_at, updated_at FROM exceptions WHERE close_run_id=? ORDER BY amount DESC`).all(runId)
        : [];
      json(res, 200, { exceptions: rows });
      return;
    }
    if (pathname.startsWith('/api/exceptions/')) {
      const id = pathname.split('/')[3] ?? '';
      const exc = db.prepare(`SELECT * FROM exceptions WHERE id=? OR code=?`).get(id, id) as unknown as Record<string, unknown> | undefined;
      if (!exc) { json(res, 404, { error: 'not found' }); return; }
      const evidence = evidenceForException(db, exc.id as string);
      const jid = (db.prepare(`SELECT id FROM journal_entries WHERE exception_id=?`).get(String(exc.id)) as unknown as { id: string } | undefined)?.id ?? null;
      const journal = jid ? db.prepare(`SELECT je.*, (SELECT json_group_array(json_object('account', a.code||' '||a.name,'debit',jel.debit,'credit',jel.credit,'description',jel.description)) FROM journal_entry_lines jel JOIN ledger_accounts a ON a.id=jel.ledger_account_id WHERE jel.journal_entry_id=je.id) lines_json FROM journal_entries je WHERE je.id=?`).get(jid) as unknown as Record<string, unknown> | undefined : null;
      const approval = db.prepare(`SELECT * FROM approvals WHERE exception_id=? ORDER BY created_at DESC LIMIT 1`).get(String(exc.id)) as unknown as Record<string, unknown> | undefined;
      const graph = evidence.length > 0 ? neighborhood(db, (evidence[0] as { entity_id: string }).entity_id, 2) : { nodes: [], edges: [] } as { nodes: never[]; edges: never[] };
      json(res, 200, { exception: { ...exc, proposed_journal_json: undefined }, evidence, journal: journal ? { ...journal, lines_json: undefined, lines: JSON.parse((journal.lines_json as string) ?? '[]') } : null, approval: approval ?? null, graph });
      return;
    }
    if (pathname === '/api/reconciliation') {
      const runId = url.searchParams.get('close_run_id') ?? latestCloseRunId();
      const byType = runId ? db.prepare(`SELECT match_type, status, COUNT(*) c, SUM(amount) total FROM reconciliations WHERE close_run_id=? GROUP BY match_type, status`).all(runId) : [];
      const samples = runId ? db.prepare(`SELECT r.match_type, r.status, r.score, r.amount, b.description bank_desc, b.txn_date bank_date, l.description ledger_desc, l.txn_date ledger_date, b.reference FROM reconciliations r LEFT JOIN bank_transactions b ON b.id=r.bank_transaction_id LEFT JOIN ledger_transactions l ON l.id=r.ledger_transaction_id WHERE r.close_run_id=? ORDER BY r.score DESC LIMIT 60`).all(runId) : [];
      const noise = runId ? (db.prepare(`SELECT COUNT(*) c FROM bank_transactions b WHERE b.ingest_run_id='demo' AND NOT EXISTS (SELECT 1 FROM reconciliations r WHERE r.bank_transaction_id = b.id AND r.close_run_id = ?)`).get(runId) as unknown as { c: number }).c : 0;
      json(res, 200, { by_type: byType, samples, unmatched_note: `${noise} unmatched bank rows were routed to the exception engine for investigation; benign feed noise is summarized in the close report.` });
      return;
    }
    if (pathname === '/api/journals') {
      const runId = url.searchParams.get('close_run_id') ?? latestCloseRunId();
      const rows = db.prepare(`SELECT je.id, je.journal_number, je.description, je.status, je.total_debit, je.total_credit, je.amount, je.idempotency_key, je.material, je.posted_at, je.created_at, e.code exception_code, (SELECT json_group_array(json_object('account', a.code||' '||a.name,'debit',jel.debit,'credit',jel.credit,'description',jel.description)) FROM journal_entry_lines jel JOIN ledger_accounts a ON a.id=jel.ledger_account_id WHERE jel.journal_entry_id=je.id) lines_json FROM journal_entries je LEFT JOIN exceptions e ON e.id=je.exception_id ${runId ? 'WHERE je.close_run_id=?' : ''} ORDER BY je.created_at`).all(...(runId ? [runId] : [])) as Array<Record<string, unknown>>;
      json(res, 200, { journals: rows.map((r) => ({ ...r, lines: JSON.parse((r.lines_json as string) ?? '[]'), lines_json: undefined })) });
      return;
    }
    if (pathname === '/api/approvals') {
      json(res, 200, { pending_approvals: pendingApprovals() });
      return;
    }
    if (pathname.startsWith('/api/evidence/')) {
      const entityId = pathname.split('/')[3] ?? '';
      const depth = parseInt(url.searchParams.get('depth') ?? '2', 10);
      const node = db.prepare(`SELECT id FROM financial_entities WHERE id=? OR (entity_type || ':' || external_ref IN (SELECT entity_type || ':' || external_ref FROM financial_entities WHERE id=?))`).get(entityId, entityId);
      const target = node ? entityId : (db.prepare(`SELECT id FROM financial_entities WHERE external_ref=? LIMIT 1`).get(entityId) as { id: string } | undefined)?.id;
      if (!target) { json(res, 404, { error: 'entity not found' }); return; }
      json(res, 200, neighborhood(db, target, Math.min(4, Math.max(1, depth))));
      return;
    }
    if (pathname === '/api/agent-activity') {
      const runId = url.searchParams.get('close_run_id') ?? latestCloseRunId();
      const runs = db.prepare(`SELECT id, agent, purpose, status, input_summary, output_summary, attempt, started_at, finished_at FROM agent_runs ${runId ? 'WHERE close_run_id=?' : ''} ORDER BY started_at DESC LIMIT 50`).all(...(runId ? [runId] : [])) as Array<Record<string, unknown>>;
      const steps = db.prepare(`SELECT s.id, s.agent_run_id, s.step_number, s.kind, s.title, s.detail, s.created_at FROM agent_steps s ${runId ? `WHERE s.agent_run_id IN (SELECT id FROM agent_runs WHERE close_run_id='${runId}')` : ''} ORDER BY s.created_at LIMIT 200`).all() as Array<Record<string, unknown>>;
      const actions = db.prepare(`SELECT agent, actor, action, target_type, target_id, input_summary, output_summary, confidence, created_at FROM agent_actions ${runId ? 'WHERE close_run_id=?' : ''} ORDER BY created_at DESC LIMIT 100`).all(...(runId ? [runId] : [])) as Array<Record<string, unknown>>;
      json(res, 200, { runs, steps, actions });
      return;
    }
    if (pathname === '/api/audit') {
      const runId = url.searchParams.get('close_run_id') ?? latestCloseRunId();
      if (!runId) { json(res, 200, { package: null }); return; }
      json(res, 200, { package: generateAuditPackage(db, runId) });
      return;
    }
    if (pathname === '/api/audit/markdown') {
      const runId = url.searchParams.get('close_run_id') ?? latestCloseRunId();
      if (!runId) { json(res, 404, { error: 'no close run' }); return; }
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="finpilot-audit-package.md"' });
      res.end(auditMarkdown(generateAuditPackage(db, runId)));
      return;
    }
    if (pathname === '/api/cfo-summary') {
      const runId = url.searchParams.get('close_run_id') ?? latestCloseRunId();
      if (!runId) { json(res, 200, { summary: null }); return; }
      json(res, 200, { summary: generateCfoSummary(db, runId) });
      return;
    }
    if (pathname === '/api/forecast') {
      const m = computeMetrics(db, latestCloseRunId());
      json(res, 200, {
        cash_position: m.cash_position, cash_start: m.cash_start, cash_change: m.cash_change,
        forecast_next_month: m.forecast_next_month,
        assumptions: [
          'Outflow pace maintained from September synthetic feed',
          'Expected subscription receipts per AR schedule',
          'Committed-use accrual reverses next quarter (CASE B)',
        ],
        risk_score: m.risk_score,
      });
      return;
    }
    if (pathname === '/api/policies') {
      const rows = db.prepare(`SELECT id, code, name, description, category, parameters_json, active, version, updated_at FROM accounting_policies ORDER BY category, code`).all() as Array<Record<string, unknown>>;
      json(res, 200, { policies: rows.map((r) => ({ ...r, parameters: JSON.parse(r.parameters_json as string), parameters_json: undefined })) });
      return;
    }
    if (pathname === '/api/ao') {
      // Build With AO — actual development evidence from the repository docs (no fabricated metrics)
      const docPath = path.resolve(__dirname, '..', '..', '..', '..', 'docs', 'AO_BUILD_LOG.md');
      let content = 'AO build log not yet written.';
      try { content = fs.readFileSync(docPath, 'utf-8'); } catch { /* keep placeholder */ }
      json(res, 200, { content, note: 'All evidence below comes from the actual development log maintained during the build. No session counts or metrics are fabricated.' });
      return;
    }

    json(res, 404, { error: `no route: ${req.method} ${pathname}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json(res, 500, { error: msg });
  }
});

function pendingApprovals(): Array<Record<string, unknown>> {
  return db.prepare(`SELECT ap.id, ap.status, ap.required_role, ap.requested_by, ap.created_at, ap.journal_entry_id, ap.exception_id, e.code exc_code, e.title exc_title, e.amount exc_amount, e.severity, e.confidence, e.risk_level, e.materiality_level, e.finding, e.likely_cause, e.recommendation, e.status exc_status FROM approvals ap LEFT JOIN exceptions e ON e.id = ap.exception_id WHERE ap.status = 'PENDING' ORDER BY e.amount DESC`).all() as Array<Record<string, unknown>>;
}

function newAgentRun(purpose: string): string {
  const id = newId('arun');
  db.prepare(`INSERT INTO agent_runs (id, close_run_id, agent, purpose, status, input_summary, attempt, started_at) VALUES (?,?, 'ORCHESTRATOR', ?, 'RUNNING', ?, 1, ?)`)
    .run(id, latestCloseRunId(), purpose, purpose, nowIso());
  return id;
}

function serveStatic(pathname: string, res: http.ServerResponse): void {
  const file = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, data) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, data2) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data2);
      });
      return;
    }
    const ext = path.extname(full);
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
    res.writeHead(200, { 'Content-Type': types[ext] ?? 'application/octet-stream' });
    res.end(data);
  });
}

function auditMarkdown(pkg: ReturnType<typeof generateAuditPackage>): string {
  const L: string[] = [];
  L.push(`# FinPilot — Audit Evidence Package`);
  L.push(``);
  L.push(`> ${'SYNTHETIC DEMO DATA — NOT REAL FINANCIAL INFORMATION'}`);
  L.push(``);
  L.push(`- Close run: \`${pkg.close_run_id}\``);
  L.push(`- Generated: ${pkg.generated_at}`);
  L.push(`- Status: ${pkg.close_summary.status} (${pkg.close_summary.progress}%)`);
  L.push(``);
  L.push(`## 1. Close Summary`);
  const m = pkg.close_summary.metrics;
  L.push(`Transactions processed: ${m.transactions_processed}; matched: ${m.matched_count}; auto-resolved: ${m.auto_resolved_count}; human review: ${m.human_review_count}; unresolved: ${m.unresolved_count}; risk score: ${m.risk_score}.`);
  L.push(`Cash position: ₹${m.cash_position.toLocaleString('en-IN')} (opening ₹${m.cash_start.toLocaleString('en-IN')}).`);
  L.push(``);
  L.push(`## 2. Reconciliation Report`);
  L.push(`Total matched: ${pkg.reconciliation_report.total_matches}. By type: ${JSON.stringify(pkg.reconciliation_report.by_type)}.`);
  L.push(``);
  L.push(`## 3. Exception Report`);
  for (const e of pkg.exception_report) {
    L.push(`- **${e.code}** ${e.title} — ₹${e.amount.toLocaleString('en-IN')} | ${e.type} | sev ${e.severity} | ${e.status} | confidence ${e.confidence}% | risk ${e.risk} | ${e.materiality} | evidence: ${e.evidence_ids.length ? e.evidence_ids.join(', ') : 'none'}`);
  }
  L.push(``);
  L.push(`## 4. Journal Entries`);
  for (const j of pkg.journal_entries) {
    L.push(`- **${j.journal_number}** ${j.description} — ₹${j.total_debit.toLocaleString('en-IN')} | ${j.status} | idempotency \`${j.idempotency_key}\``);
    for (const l of j.lines) L.push(`  - ${l.account}: Dr ₹${l.debit.toLocaleString('en-IN')} / Cr ₹${l.credit.toLocaleString('en-IN')} — ${l.description}`);
  }
  L.push(``);
  L.push(`## 5. Human Approvals`);
  for (const a of pkg.human_approvals) L.push(`- ${a.approval_id} | ${a.required_role} | ${a.status} | by ${a.decided_by ?? '—'} at ${a.decided_at ?? '—'} | ${a.note ?? ''}`);
  L.push(``);
  L.push(`## 6. Agent Decision Log`);
  for (const d of pkg.agent_decision_log) L.push(`- ${d.at} | ${d.agent}/${d.actor} | ${d.action} | ${d.input} → ${d.output} | conf ${d.confidence ?? '—'}`);
  L.push(``);
  L.push(`## 7. Evidence Index`);
  for (const e of pkg.evidence_index) L.push(`- ${e.evidence_id} | ${e.exception_code} | ${e.entity_type}: ${e.entity_label} (${e.relationship}) — ${e.summary}`);
  L.push(``);
  L.push(`## 8. Policy Checks`);
  for (const p of pkg.policy_checks) L.push(`- ${p.exception_code} | ${p.policy_code} | ${p.passed ? 'PASS' : 'FAIL'} — ${p.detail}`);
  L.push(``);
  L.push(`## 9. Close Certification`);
  L.push(`Certified: **${pkg.close_certification.certified ? 'YES' : 'NO'}** — ${pkg.close_certification.statement}`);
  L.push(``);
  return L.join('\n');
}

server.listen(PORT, () => {
  console.log(`[finpilot] API + UI listening on http://localhost:${PORT}`);
  console.log('[finpilot] SYNTHETIC DEMO DATA — NOT REAL FINANCIAL INFORMATION');
});

process.on('SIGTERM', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000); });
process.on('SIGINT', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000); });
