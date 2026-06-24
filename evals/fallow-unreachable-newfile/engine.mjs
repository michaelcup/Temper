import { writeFileSync } from 'node:fs'
// Adds a dynamically-loaded plugin that the (stubbed) fallow gate reports as unreachable — the engine
// can't make it statically reachable in scope, so the loop should hand it the dynamic-load fix and
// escalate fast (deadFileHits reaches the threshold) rather than burn every iteration.
writeFileSync('newfile.mjs', 'export function plugin() {\n  return 42\n}\n')
