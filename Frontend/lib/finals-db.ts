import {snapshotSQL} from './finals-snapshot';
import {neon} from '@neondatabase/serverless';

export const finalsSchema=process.env.FINALS_SCHEMA||'finals';
const sourceSchema=process.env.DATABASE_SCHEMA||'public';
if(!/^finals(?:_[a-z0-9_]+)?$/.test(finalsSchema)||!/^[a-z_][a-z0-9_]*$/.test(sourceSchema))throw Error('Invalid database schema');
const database=neon(process.env.DATABASE_URL!);
export async function finalsQuery(text:string,values:unknown[]=[]){
 for(let attempt=0;;attempt++){
  try{
   const result=await database.transaction(tx=>[
    tx`SELECT set_config('search_path',${finalsSchema+',pg_catalog'},true)`,tx.query(text,values),
   ]);return result[1];
  }catch(error){
   if(attempt>=2||!/fetch failed|connect|timeout|ECONNRESET/i.test(error instanceof Error?error.message:String(error)))throw error;
   await new Promise(resolve=>setTimeout(resolve,400*(attempt+1)));
  }
 }
}

/** Selection + private code snapshot are one SQL statement, not a stale browser list. */
export async function snapshotFinals(actor:number,name:string,requestId:string){
 const result=await finalsQuery(snapshotSQL(sourceSchema),[actor,name,requestId]);
 return result[0].id;
}
