import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {lookup} from 'node:dns/promises';
import tls from 'node:tls';
import {splitSql} from './sql-statements.mjs';
import {pinLookup} from './e2e-network.mjs';
const require=createRequire(import.meta.url);require('@next/env').loadEnvConfig(process.cwd());
const {neon,neonConfig}=require('@neondatabase/serverless');const sql=neon(process.env.DATABASE_URL);
const schema=process.env.FINALS_SCHEMA||'finals';if(!/^finals(?:_[a-z0-9_]+)?$/.test(schema))throw Error('FINALS_SCHEMA must be finals or finals_*');
const host=new URL(neonConfig.fetchEndpoint(new URL(process.env.DATABASE_URL).hostname,5432)).hostname;
const addresses=await lookup(host,{all:true});
const address=await Promise.any(addresses.filter(a=>a.family===4).map(a=>new Promise((resolve,reject)=>{const socket=tls.connect({host:a.address,port:443,servername:host});socket.setTimeout(3000,()=>socket.destroy(new Error('TLS timeout')));socket.once('error',reject);socket.once('secureConnect',()=>{resolve(a.address);socket.end();});})));
pinLookup(host,address);
const existing=(await sql`SELECT to_regclass(${schema+'.editions'}) IS NOT NULL AS migrated,to_regclass(${schema+'.ck_rounds'}) IS NOT NULL AS upgraded`)[0];
const active=existing.migrated?await sql.query(`SELECT p.edition_id,p.round,count(*)::int AS pairs FROM ${schema}.pairs p WHERE p.status='running' GROUP BY p.edition_id,p.round ORDER BY p.edition_id,p.round`):[];
if(!process.argv.includes('--apply'))console.log(JSON.stringify({schema,...existing,activeLegacyRounds:existing.upgraded?[]:active,blocked:!existing.upgraded&&active.length>0},null,2));
else{
 const fingerprint=`SELECT (SELECT count(*) FROM public.users) AS users,(SELECT count(*) FROM public.arena_agents) AS agents,
 (SELECT count(*) FROM public.rated_matches) AS rated,(SELECT count(*) FROM public.rated_match_move_history) AS moves,
 (SELECT count(*) FROM public.friendly_matches) AS friendly,
 (SELECT md5(COALESCE(string_agg(concat_ws(':',id,code,rating,trueskill_mu,trueskill_sigma,status,is_active,is_public,wins,losses,draws),'|' ORDER BY id),'')) FROM public.arena_agents) AS digest`;
 const files=existing.migrated?['finals_workers_migration.sql']:['finals_migration.sql','finals_workers_migration.sql'];
 const statements=files.flatMap(file=>splitSql(readFileSync(file,'utf8').replaceAll('__FINALS_SCHEMA__',schema)));
 const result=await sql.transaction(tx=>[
 tx`SELECT 1 AS migration_start`,
 tx.query(`CREATE TEMP TABLE finals_before ON COMMIT DROP AS ${fingerprint}`),tx.query(fingerprint),
 ...statements.map(s=>tx.query(s)),
 tx.query(`CREATE TEMP TABLE finals_after ON COMMIT DROP AS ${fingerprint}`),
 tx.query(`DO $$ BEGIN IF (SELECT row_to_json(b)::text FROM finals_before b)<>(SELECT row_to_json(a)::text FROM finals_after a) THEN RAISE EXCEPTION 'Regular data preservation failed';END IF;END $$`),tx.query(fingerprint),
 ],{isolationLevel:'RepeatableRead'});
 const report={appliedAt:new Date().toISOString(),schema,before:result[2],after:result.at(-1),preserved:true};
 mkdirSync('../logs',{recursive:true});
 const backup=(await sql.query(`SELECT data FROM ${schema}.ck_upgrade_backup WHERE id=true`))[0];
 const backupDir=`../logs/ck-upgrade-${Date.now()}`;mkdirSync(backupDir,{mode:0o700});writeFileSync(backupDir+'/backup.json',JSON.stringify(backup),{mode:0o600});
 report.backupFile=backupDir+'/backup.json';
 writeFileSync('../logs/finals-rollout.json',JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report,null,2));
}
