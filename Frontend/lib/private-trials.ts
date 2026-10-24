import {sql} from '@/lib/db';
import {backendFetch} from '@/lib/backend';
export async function enqueuePrivateTrial(id:number) {
 const rows=await sql`SELECT f.id,f.agent1_id,f.agent2_id,a.code AS agent1_code,b.code AS agent2_code
 FROM friendly_matches f JOIN arena_agents a ON a.id=f.agent1_id JOIN arena_agents b ON b.id=f.agent2_id
 WHERE f.id=${id} AND f.status='scheduled' AND f.pending_backend AND trial_scope_allowed(f.id)`;
 if(!rows.length)return false;
 const result=await backendFetch('/friendly/enqueue',{method:'POST',body:JSON.stringify({friendly_match_id:id,...rows[0],max_moves:200,
 callback_url:process.env.NEXT_PUBLIC_FRONTEND_URL||process.env.NEXTAUTH_URL||'http://localhost:3000'}),timeoutMs:10000});
 if(result.ok)await sql`UPDATE friendly_matches SET pending_backend=false WHERE id=${id} AND status='scheduled'`;
 return result.ok;
}
