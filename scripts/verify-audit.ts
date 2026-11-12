// Verify an exported WATCHSHIFT audit file offline: node scripts/verify-audit.ts watchshift-audit-*.json
// Recomputes every event hash and the chain; redacted (other-team) entries are checked by link only.
import { readFileSync } from 'node:fs';
import { verifyExport, type AuditExport } from '../src/audit.ts';

const file = process.argv[2];
if (!file) { console.error('usage: npm run verify-audit -- <export.json>'); process.exit(2); }
const x = JSON.parse(readFileSync(file, 'utf8')) as AuditExport;
const r = verifyExport(x);
console.log(JSON.stringify({ file, ...r }, null, 2));
process.exit(r.ok ? 0 : 1);
