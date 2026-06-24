import { writeFileSync } from 'node:fs'
writeFileSync('src/new.mjs', '// fallow-ignore-file\nexport const X = 1\n')
