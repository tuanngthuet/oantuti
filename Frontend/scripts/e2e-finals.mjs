// Isolated PGlite + actual Python worker + Bubblewrap. Never reads database env files.
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const frontend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const child=spawn(process.execPath,[path.join(frontend,'node_modules/vitest/vitest.mjs'),'run','lib/finals-workers.integration.test.ts','lib/finals-worker-e2e.test.ts'],{
 cwd:frontend,stdio:'inherit',env:{...process.env,CK_REAL_E2E:'1'},
});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
