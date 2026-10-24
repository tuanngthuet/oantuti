// Read-only by default; --apply backs up and clears finals competition data.
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {mkdirSync,writeFileSync} from 'node:fs';
import {lookup} from 'node:dns/promises';
import tls from 'node:tls';
import {pinLookup} from './e2e-network.mjs';
import {finalsDataTables,ckDataTables,finalsResetQueries} from './finals-reset-queries.mjs';

const frontend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
require('@next/env').loadEnvConfig(frontend);
const {neon,neonConfig}=require('@neondatabase/serverless');
const schema=process.env.FINALS_SCHEMA||'finals';
if(!/^finals(?:_[a-z0-9_]+)?$/.test(schema))throw Error('Invalid finals schema');
const sql=neon(process.env.DATABASE_URL);
const host=new URL(neonConfig.fetchEndpoint(new URL(process.env.DATABASE_URL).hostname,5432)).hostname;
const addresses=await lookup(host,{all:true});
const address=await Promise.any(addresses.filter(a=>a.family===4).map(a=>new Promise((resolve,reject)=>{
 const socket=tls.connect({host:a.address,port:443,servername:host});
 socket.setTimeout(4000,()=>socket.destroy(Error('TLS timeout')));
 socket.once('error',reject);socket.once('secureConnect',()=>{socket.end();resolve(a.address);});
})));
pinLookup(host,address);
const [exists]=await sql`SELECT to_regclass(${schema+'.editions'}) IS NOT NULL AS present`;
if(!exists.present){console.log(JSON.stringify({schema,present:false}));process.exit(0);}
const [rules]=await sql`SELECT to_regclass(${schema+'.round_rules'}) IS NOT NULL AS present`;
const [ck]=await sql`SELECT to_regclass(${schema+'.ck_rounds'}) IS NOT NULL AS present`;
const dataTables=[...finalsDataTables,...(rules.present?['round_rules']:[]),...(ck.present?ckDataTables:[])];
const countSQL=`SELECT ${dataTables.map(table=>`(SELECT count(*)::int FROM ${schema}.${table}) AS ${table}`).join(',')}`;
const before=(await sql.query(countSQL))[0];
const editions=await sql.query(`SELECT id,name,status FROM ${schema}.editions ORDER BY id`);
if(!process.argv.includes('--apply')){
 const relations=await sql.query(`SELECT c.relname AS table_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r' ORDER BY c.relname`,[schema]);
 const foreignKeys=await sql.query(`SELECT c.conrelid::regclass::text AS source,c.confrelid::regclass::text AS target,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 AND c.contype='f'`,[schema]);
 console.log(JSON.stringify({dryRun:true,schema,counts:before,editions,relations,foreignKeys},null,2));
}else{
 const runId=`finals_reset_${Date.now()}`;
 const logDir=path.resolve(frontend,'../logs',runId);
 mkdirSync(logDir,{recursive:true,mode:0o700});
 writeFileSync(path.join(logDir,'.gitignore'),'*\n');
 const results=await sql.transaction(tx=>[
  ...finalsResetQueries(schema,runId,rules.present,ck.present).map(q=>tx.query(q.text,q.values??[])),tx.query(countSQL),
 ]);
 const backup=results.at(-2)[0];
 // The same backup is already committed in the database if local writing fails.
 writeFileSync(path.join(logDir,'backup.json'),JSON.stringify(backup),{mode:0o600});
 const deleted=Object.fromEntries(dataTables.map(table=>[table,backup.data[table].length]));
 const report={schema,runId,deleted,remaining:results.at(-1)[0],backupTable:`${schema}.reset_backups`,backupFile:path.join(logDir,'backup.json')};
 writeFileSync(path.join(logDir,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
 console.log(JSON.stringify(report,null,2));
}
