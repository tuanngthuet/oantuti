// Run from Frontend: node scripts/seed-demo-data.mjs [--apply] [--prefix demo]
import {createRequire} from 'node:module';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {demoFixtures, strategies} from './demo-data-fixtures.mjs';
import {pinLookup} from './e2e-network.mjs';
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const option = (flag, fallback) => {const i=args.indexOf(flag); if(i<0)return fallback; if(!args[i+1]||args[i+1].startsWith('--'))throw Error(`Missing ${flag} value`); return args[i+1];};
const fixtures = demoFixtures(option('--prefix','demo'));
const summary = {users:fixtures.users.length, teams:fixtures.teams.map(t=>({name:t.name,members:t.members})),
  agents:fixtures.agents.length, publicAgents:fixtures.agents.filter(a=>a.is_public).length,
  strategies:Object.fromEntries(strategies.map((s,i)=>[s,fixtures.agents.filter(a=>a.level===i).length])),
  accounts:`${fixtures.users[0].username}–${fixtures.users.at(-1).username}`, password:'12345678',
  validation:'scheduled through normal validation pipeline; no artificial ratings or completed games'};
if (!args.includes('--apply')) { console.log(JSON.stringify({dryRun:true,...summary},null,2)); process.exit(0); }
require('@next/env').loadEnvConfig(process.cwd());
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL is required');
if (process.env.DATABASE_SCHEMA && process.env.DATABASE_SCHEMA !== 'public') throw Error('This command targets public only');
if(args.includes('--neon-host'))pinLookup(option('--neon-host'),option('--neon-address'));
const bcrypt = require('bcryptjs');
const {neon} = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
for (const user of fixtures.users) user.password_hash = await bcrypt.hash('12345678',12);
for (const agent of fixtures.agents) {
  // Fixture sources contain no ambiguous trailing whitespace or multiline literals.
  agent.normalized_code = agent.code.replace(/\r\n?/g,'\n').split('\n').map(l=>l.replace(/[\t ]+$/,'')).join('\n').replace(/^\n+|\n+$/g,'');
  agent.code_fingerprint = createHash('sha256').update(agent.normalized_code).digest('hex');
}
const migration = readFileSync(new URL('./seed-demo-data.sql',import.meta.url),'utf8');
const result = await sql.transaction(tx => [
  tx.query("SELECT set_config('search_path','public',true),set_config('app.demo_payload',$1,true)",[JSON.stringify(fixtures)]),
  tx.query(migration),
  tx.query(`SELECT u.username,count(a.id)::int AS submissions,current_team(u.id) AS team_id
    FROM users u LEFT JOIN arena_agents a ON a.user_id=u.id WHERE u.username=ANY($1::text[])
    GROUP BY u.id ORDER BY u.username`,[fixtures.users.map(u=>u.username)]),
]);
const directory = path.resolve('../logs',`demo-data-${Date.now()}`);
mkdirSync(directory,{recursive:true,mode:0o700});
const report = {appliedAt:new Date().toISOString(),...summary,accounts:result[2]};
writeFileSync(path.join(directory,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({applied:true,...summary,report:path.join(directory,'report.json')},null,2));
