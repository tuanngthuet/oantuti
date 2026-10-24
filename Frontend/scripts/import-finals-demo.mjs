// Read-only unless --apply. Copy a completed hosted season into the normal database with fresh IDs.
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import tls from 'node:tls';
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {splitSql} from './sql-statements.mjs';
import {pinLookup} from './e2e-network.mjs';
import {finalsDemoImportQueries} from './finals-demo-import-queries.mjs';
const frontend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),root=path.dirname(frontend),require=createRequire(import.meta.url);
require('@next/env').loadEnvConfig(frontend);
const {neon,neonConfig}=require('@neondatabase/serverless'),sql=neon(process.env.DATABASE_URL);
const state=JSON.parse(readFileSync(path.join(root,'logs/ck-season-state.json'),'utf8'));
const source=state.source,sourceFinals=state.finals,target='finals',sourceEdition=Number(state.editionId);
assert.match(source,/^ott_ck_season_\d+_[a-f0-9]{6}$/);assert.match(sourceFinals,/^finals_ck_season_\d+_[a-f0-9]{6}$/);assert.ok(state.passed);
const host=new URL(neonConfig.fetchEndpoint(new URL(process.env.DATABASE_URL).hostname,5432)).hostname;
const address=await Promise.any((await lookup(host,{all:true})).filter(a=>a.family===4).map(a=>new Promise((resolve,reject)=>{
 const socket=tls.connect({host:a.address,port:443,servername:host});socket.setTimeout(3500,()=>socket.destroy(Error('TLS timeout')));socket.once('error',reject);socket.once('secureConnect',()=>{socket.end();resolve(a.address);});
})));pinLookup(host,address);
const migrated=(await sql.query("SELECT to_regclass('finals.ck_rounds') IS NOT NULL AS upgraded"))[0].upgraded;
const prior=(await sql.query("SELECT a.edition_id FROM finals.audit a JOIN finals.editions e ON e.id=a.edition_id WHERE a.action='demo_import' AND a.payload->>'source_schema'=$1 AND a.payload->>'source_edition_id'=$2",[sourceFinals,String(sourceEdition)]))[0];
if(prior){console.log(JSON.stringify({alreadyImported:true,edition_id:prior.edition_id,target}));process.exit(0);}
const active=await sql.query("SELECT id,name,status FROM finals.editions WHERE status IN('locked','ready','running')");
const collisions=await sql.query(`SELECT u.username FROM public.users u JOIN ${source}.users s ON s.username=u.username WHERE NOT s.is_admin`);
const sourceCounts=(await sql.query(`SELECT (SELECT count(*)::int FROM ${sourceFinals}.entrants WHERE edition_id=$1) AS entrants,(SELECT count(*)::int FROM ${sourceFinals}.pairs WHERE edition_id=$1) AS pairs,(SELECT count(*)::int FROM ${sourceFinals}.games g JOIN ${sourceFinals}.pairs p ON p.id=g.pair_id WHERE p.edition_id=$1) AS games,(SELECT count(*)::int FROM ${sourceFinals}.moves m JOIN ${sourceFinals}.attempts a ON a.id=m.attempt_id JOIN ${sourceFinals}.games g ON g.id=a.game_id JOIN ${sourceFinals}.pairs p ON p.id=g.pair_id WHERE p.edition_id=$1) AS moves`,[sourceEdition]))[0];
assert.deepEqual(sourceCounts,{entrants:16,pairs:16,games:32,moves:348});
if(active.length||collisions.length){console.log(JSON.stringify({blocked:true,activeEditions:active,usernameCollisions:collisions},null,2));process.exitCode=2;}
else if(!process.argv.includes('--apply'))console.log(JSON.stringify({dryRun:true,source,sourceFinals,target,requiresWorkersMigration:!migrated,sourceCounts,accountsToAdd:18,archivedAgentReferencesToAdd:16,ordinaryRatingHistoryCopied:false,blocked:false},null,2));
else{
 const folder=path.join(root,'logs','ck-demo-import-'+Date.now());mkdirSync(folder,{recursive:true,mode:0o700});writeFileSync(path.join(folder,'.gitignore'),'*\n');
 const backup={createdAt:new Date().toISOString(),source,sourceFinals,target,public:{},finals:{}};
 for(const schema of ['public','finals']){
  const tables=schema==='public'?['users','teams','team_members','arena_agents']:(await sql.query("SELECT tablename FROM pg_tables WHERE schemaname='finals' ORDER BY tablename")).map(t=>t.tablename);
  for(const table of tables){assert.match(table,/^[a-z_][a-z0-9_]*$/);backup[schema][table]=(await sql.query(`SELECT coalesce(jsonb_agg(t ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM ${schema}.${table} t`))[0].rows;}
 }
 writeFileSync(path.join(folder,'before.json'),JSON.stringify(backup),{mode:0o600});
 const normalTables=['rated_matches','friendly_matches','rated_match_move_history','arena_matches','match_move_history'];
 const fingerprintSQL=`SELECT jsonb_build_object(${normalTables.map(table=>`'${table}',(SELECT jsonb_build_object('count',count(*),'digest',md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),''))) FROM public.${table} t)`).join(',')}) AS data`;
 const before=(await sql.query(fingerprintSQL))[0].data;
 const requestId=randomUUID(),name='Demo Chung kết — mùa thử đã hoàn tất';
 const migration=migrated?[]:splitSql(readFileSync(path.join(frontend,'finals_workers_migration.sql'),'utf8').replaceAll('__FINALS_SCHEMA__',target)).map(text=>({text}));
 const graph=finalsDemoImportQueries({source,sourceFinals,target,sourceEdition,requestId,name});
 const statements=[
  {text:"SET LOCAL lock_timeout='10s'"},
  {text:`CREATE TEMP TABLE ck_demo_normal_before ON COMMIT DROP AS ${fingerprintSQL}`},
  ...migration,
  ...graph,
  {text:`CREATE TEMP TABLE ck_demo_normal_after ON COMMIT DROP AS ${fingerprintSQL}`},
  {text:"DO $$ BEGIN IF (SELECT data FROM ck_demo_normal_before) IS DISTINCT FROM (SELECT data FROM ck_demo_normal_after) THEN RAISE EXCEPTION 'DEMO_ORDINARY_MATCH_HISTORY_CHANGED';END IF;END $$"},
 ];
 const result=await sql.transaction(tx=>statements.map(q=>tx.query(q.text,q.values??[])),{isolationLevel:'RepeatableRead'});
 const mapping=result[2+migration.length+graph.length-1][0];
 // Persist the mapping immediately after commit, before read-only verification.
 const report={applied:true,appliedAt:new Date().toISOString(),source,sourceFinals,target,sourceEdition,editionId:Number(mapping.edition_id),name,requestId,mapping,backupFile:path.join(folder,'before.json'),logDir:folder,route:{host,address},normalBefore:before};
 writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2),{mode:0o600});writeFileSync(path.join(root,'logs/ck-demo-import-state.json'),JSON.stringify(report,null,2),{mode:0o600});
 const after=(await sql.query(fingerprintSQL))[0].data;assert.deepEqual(after,before);
 for(const [table,rows] of Object.entries(backup.public)){
  const existing=rows.length?await sql.query(`SELECT to_jsonb(t) AS row FROM public.${table} t WHERE ${table==='team_members'?'user_id':'id'}=ANY($1::bigint[]) ORDER BY ${table==='team_members'?'user_id':'id'}`,[rows.map(r=>r[table==='team_members'?'user_id':'id'])]):[];
  const sort=items=>items.map(r=>JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a],[b])=>a.localeCompare(b))))).sort();assert.ok(isDeepStrictEqual(sort(existing.map(r=>r.row)),sort(rows)),`Existing ${table} must remain unchanged`);
 }
 const counts=(await sql.query(`SELECT (SELECT count(*)::int FROM finals.entrants WHERE edition_id=$1) AS entrants,(SELECT count(*)::int FROM finals.pairs WHERE edition_id=$1) AS pairs,(SELECT count(*)::int FROM finals.games g JOIN finals.pairs p ON p.id=g.pair_id WHERE p.edition_id=$1) AS games,(SELECT count(*)::int FROM finals.moves m JOIN finals.attempts a ON a.id=m.attempt_id JOIN finals.games g ON g.id=a.game_id JOIN finals.pairs p ON p.id=g.pair_id WHERE p.edition_id=$1) AS moves`,[report.editionId]))[0];assert.deepEqual(counts,sourceCounts);
 report.verified=true;report.counts=counts;report.normalAfter=after;report.existingAccountsAndAgentsPreserved=true;
 writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2),{mode:0o600});writeFileSync(path.join(root,'logs/ck-demo-import-state.json'),JSON.stringify(report,null,2),{mode:0o600});
 console.log(JSON.stringify({applied:true,verified:true,target,editionId:report.editionId,counts,accountsAdded:18,archivedAgentReferencesAdded:16,ordinaryMatchHistoryPreserved:true,existingAdminPasswordPreserved:true,report:path.join(folder,'report.json')},null,2));
}
