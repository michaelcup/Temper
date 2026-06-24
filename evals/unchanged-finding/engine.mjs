import { writeFileSync } from 'node:fs'
// Same out-of-scope file every iteration → the scope finding is IDENTICAL → the engine made zero
// progress on it → fast-bail should escalate after maxUnchangedRetries (2), not maxDomainRetries (3).
writeFileSync('outside.mjs', 'export const STRAY = 1\n')
