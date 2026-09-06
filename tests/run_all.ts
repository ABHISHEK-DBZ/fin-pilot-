/**
 * Test runner — executes the full Phase 12 suite and aggregates results.
 * Exits non-zero if any suite fails.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const suites = [
  'tests/unit/engines.test.ts',
  'tests/e2e/close_workflow.test.ts',
];

let failed = 0;
for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  const r = spawnSync('node', [path.join(__dirname, '..', suite)], { stdio: 'inherit' });
  if (r.status !== 0) failed += 1;
}
console.log('\n====================================');
console.log(failed === 0 ? 'ALL SUITES PASSED' : `${failed} SUITE(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
