import {timingSafeEqual,randomUUID} from 'node:crypto';
import {cleanDisplay} from './finals-display';
import {finalsQuery} from './finals-db';

export function workerRound(authorization:string|null):number|null {
 const raw=process.env.CK_WORKER_TOKENS;
 if(!raw||!authorization?.startsWith('Bearer '))return null;
 const configured=JSON.parse(raw) as Record<string,unknown>;
 const tokens=Object.entries(configured);
 if(tokens.length!==5||tokens.some(([r,t])=>! /^[1-5]$/.test(r)||typeof t!=='string'||t.length<32)||new Set(tokens.map(([,t])=>t)).size!==5)throw Error('CK_WORKER_TOKENS requires five distinct tokens of at least 32 characters');
 const supplied=Buffer.from(authorization.slice(7));
 for(const [round,token] of tokens){const expected=Buffer.from(String(token));if(supplied.length===expected.length&&timingSafeEqual(supplied,expected))return Number(round);}
 return null;
}
export async function workerAction(round:number,body:Record<string,unknown>){
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 if(typeof body.worker_id!=='string'||! /^[a-zA-Z0-9_.-]{1,100}$/.test(body.worker_id)||typeof body.instance!=='string'||!uuid.test(body.instance))throw Error('INVALID_RECORD');
 if(!['heartbeat','claim','renew','initial','step','complete','fail','offline'].includes(String(body.action)))throw Error('INVALID_ACTION');
 if(body.action==='heartbeat'){
  const m=body.manifest as Record<string,unknown>|null;
  if(!m||m.round!==round||m.contract_version!==1||typeof m.digest!=='string'||! /^[a-f0-9]{64}$/.test(m.digest)||typeof m.engine_version!=='string'||m.engine_version.length>100||!m.rules||typeof m.rules!=='object'||Array.isArray(m.rules)||!Number.isInteger(body.concurrency)||Number(body.concurrency)<1||Number(body.concurrency)>8)throw Error('CK_ENGINE_MISMATCH');
 }
 if(!['heartbeat','claim','offline'].includes(String(body.action))&&(!Number.isSafeInteger(body.job_id)||Number(body.job_id)<1||typeof body.token!=='string'||!uuid.test(body.token)))throw Error('INVALID_RECORD');
 if(body.action==='step'&&(!Number.isSafeInteger(body.expected)||Number(body.expected)<0||!body.move||!body.state||![undefined,null,'agent1','agent2','draw'].includes(body.outcome as string|null|undefined)))throw Error('INVALID_RECORD');
 if(body.action==='initial')body.state=cleanDisplay(body.state);
 if(body.action==='step'){const state=body.state as Record<string,unknown>;body.state={...state,display:cleanDisplay(state.display)};}
 const rows=await finalsQuery('SELECT ck_worker_action($1,$2,$3::uuid,$4,$5::jsonb) AS result',[round,body.worker_id,body.instance,body.action,JSON.stringify({...body,new_token:randomUUID()})]);
 return rows[0].result;
}
