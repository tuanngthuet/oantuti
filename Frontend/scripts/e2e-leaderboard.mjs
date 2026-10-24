// Real Neon + Chrome, using a newly-created schema only. Never starts a worker.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import {createServer} from 'node:http';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import tls from 'node:tls';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { pinLookup } from './e2e-network.mjs';
import { splitSql } from './sql-statements.mjs';
const require = createRequire(import.meta.url);
const bcrypt = require('bcryptjs');
require('@next/env').loadEnvConfig(process.cwd());
const { neon, neonConfig } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
const host = new URL(neonConfig.fetchEndpoint(new URL(process.env.DATABASE_URL).hostname, 5432)).hostname;
const addresses = await lookup(host, { all: true });
const address = await Promise.any(addresses.filter(a => a.family === 4).map(a => new Promise((resolve, reject) => {
  const socket = tls.connect({ host: a.address, port: 443, servername: host });
  socket.setTimeout(3000, () => socket.destroy(new Error('TLS timeout')));
  socket.once('error', reject);
  socket.once('secureConnect', () => { resolve(a.address); socket.end(); });
})));
pinLookup(host, address);
const schema = `ott_lb_e2e_${Date.now()}_${randomUUID().slice(0, 6)}`;
assert.match(schema, /^ott_lb_e2e_\d+_[a-f0-9]{6}$/);
const logDir = path.resolve('../logs', schema);
mkdirSync(logDir, { recursive: true });
writeFileSync(path.join(logDir,'.gitignore'),'*\n');
// Next normalizes loopback redirects to localhost; keep auth cookies on that host.
const base = 'http://localhost:3100';
try { await fetch(base, { signal: AbortSignal.timeout(1500) }); throw new Error('Port 3100 is occupied'); }
catch (e) { if (e.message === 'Port 3100 is occupied') throw e; }
const scoped = async (text, values = []) => (await sql.transaction(tx => [tx`SELECT set_config('search_path', ${schema}, true)`, ...splitSql(text).map(statement => tx.query(statement, values))]))[1];
const checks = [];
const testPassword = `AuthTest_${randomUUID()}`;
let child, browser, offlineBackend, created = false, passed = false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function check(name, fn) {
  if(process.argv.includes('--team-wave-only')&&!name.startsWith('Team tab'))return;
  await fn(); checks.push(name); console.log(`PASS ${name}`);
}
try {
  await sql.query(`CREATE SCHEMA ${schema}`); created = true;
  const statements = ['database.sql','arena_schema.sql','tournament_schema.sql','trueskill_migration.sql','friendly_challenge_migration.sql','execution_token_migration.sql','adaptive_rating_migration.sql','teams_migration.sql','team_join_requests_migration.sql','private_trials_migration.sql']
    .flatMap(file => splitSql(readFileSync(file, 'utf8')));
  await sql.transaction(tx => [tx`SELECT set_config('search_path', ${schema}, true)`, ...statements.map(s => tx.query(s))]);
  // Synthetic outcomes exist only in this disposable test schema, never in public.
  await scoped(`UPDATE users SET username='alpha' WHERE id=1;
    INSERT INTO users(username,password_hash) VALUES ('beta','PRIVATE_HASH'),('gamma','PRIVATE_HASH');
    INSERT INTO arena_agents(user_id,agent_name,code,status,is_active,rating,wins,losses) VALUES
      (1,'Alpha Best','PRIVATE_SOURCE','active',true,1400,12,13),
      (2,'Beta Best','PRIVATE_SOURCE','active',true,1500,13,12),
      (1,'Alpha Archived','PRIVATE_SOURCE','active',false,1700,0,0),
      (1,'Alpha New','PRIVATE_SOURCE','active',true,1600,0,0),
      (3,'Gamma New','PRIVATE_SOURCE','active',true,1000,0,0),
      (1,'Alpha Rejected','PRIVATE_SOURCE','rejected',false,2000,0,0)`);
  await scoped('UPDATE arena_agents SET is_public=true');
  await scoped('UPDATE users SET password_hash=$1 WHERE id IN (1,2,3)', [bcrypt.hashSync(testPassword,4)]);
  await scoped(`INSERT INTO rated_matches(kind,agent1_id,agent2_id,status,outcome,winner_agent_id,finished_at,scheduled_at,total_moves,
    agent1_mu_before,agent1_sigma_before,agent1_mu_after,agent1_sigma_after,agent2_mu_before,agent2_sigma_before,agent2_mu_after,agent2_sigma_after,rating_delta_agent1,rating_delta_agent2)
    SELECT 'rating',1,2,'finished',CASE WHEN n%2=0 THEN 'agent1' ELSE 'agent2' END,CASE WHEN n%2=0 THEN 1 ELSE 2 END,
      NOW()-n*INTERVAL '1 minute',NOW()-n*INTERVAL '1 minute',1,30,4,31,4,32,4,31,4,40,-40 FROM generate_series(1,25) n`);
  await scoped(`INSERT INTO rated_match_move_history(rated_match_id,move_number,player,from_col,from_row,to_col,to_row,from_pos,to_pos,piece_type)
    SELECT n,1,1,1,3,0,3,'b4','a4','ROCK' FROM generate_series(1,25) n`);
  await scoped(`INSERT INTO rated_matches(kind,agent1_id,agent2_id,status) VALUES ('rating',1,2,'scheduled');
    INSERT INTO rated_matches(kind,agent1_id,agent2_id,status,outcome,finished_at) SELECT 'rating',5,2,'finished','draw',NOW() FROM generate_series(1,9)`);
  // Fence every test submission off from the real Redis/backend. This is not a worker.
  offlineBackend=createServer((_req,res)=>{res.writeHead(503,{'Content-Type':'application/json'});res.end('{"error":"Isolated E2E backend offline"}');});
  await new Promise(resolve=>offlineBackend.listen(0,'127.0.0.1',resolve));
  const backendUrl=`http://127.0.0.1:${offlineBackend.address().port}`;
  const fd = openSync(path.join(logDir, 'frontend.log'), 'a', 0o600);
  child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3100'], {
    cwd: process.cwd(), stdio: ['ignore', fd, fd], env: { ...process.env,
      DATABASE_SCHEMA: schema, NEXT_BUILD_DIR: '.next-leaderboard-test',
      BACKEND_URL:backendUrl,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${path.resolve('scripts/e2e-network.mjs')}`.trim(),
      OTT_E2E_NEON_HOST: host, OTT_E2E_NEON_ADDRESS: address },
  }); closeSync(fd);
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/api/arena/leaderboard`)).ok) break; } catch { /* Wait for owned server. */ }
    assert.ok(i < 60 && child.exitCode === null, 'Owned frontend did not become ready'); await pause(500);
  }
  await check('public real-Neon standings and private source protection', async () => {
    const data = await (await fetch(`${base}/api/arena/leaderboard`)).json();
    assert.equal(data.total, 2); assert.equal(data.leaderboard[1].agent.agent_name, 'Alpha Best');
    assert.equal(data.leaderboard[1].approved_agents, 3); assert.ok(!JSON.stringify(data).includes('PRIVATE'));
    assert.equal((await fetch(`${base}/api/arena/agents/1`, { method:'PATCH', headers: {'Content-Type':'application/json'}, body:'{"status":"active"}' })).status,403);
    assert.equal((await fetch(`${base}/api/arena/agents/1/history?matchId=27`)).status,404);
  });
  browser = await chromium.launch({ executablePath: '/opt/google/chrome/chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  async function fillAuth(username) {
    await page.getByLabel('Tên đăng nhập',{exact:true}).fill(username);
    await page.getByLabel('Mật khẩu',{exact:true}).fill(testPassword);
  }
  await check('admin settings lists validation with self-play, queue stages and mobile layout',async()=>{
    const agent=Number((await scoped("INSERT INTO arena_agents(user_id,agent_name,code,status,is_active) VALUES(1,'Settings Selfplay','PRIVATE_SOURCE','validating',false) RETURNING id"))[0].id);
    const validation=await scoped("INSERT INTO rated_matches(kind,agent1_id,agent2_id,status,dispatched_at) VALUES('validation',$1,$1,'scheduled',NULL),('validation',$1,$1,'scheduled',now()) RETURNING id",[agent]);
    const admin=await browser.newContext({viewport:{width:1440,height:1000}});
    try{
      assert.equal((await admin.request.post(`${base}/api/auth/login`,{data:{username:'alpha',password:testPassword}})).status(),200);
      const response=await admin.request.get(`${base}/api/admin/system-status`);assert.equal(response.status(),200);
      const data=await response.json();assert.equal(data.match_stats_by_kind.validation.pending,2);
      assert.ok(data.recent_matches.some(m=>m.source==='validation'&&Number(m.id)===Number(validation[0].id)));
      const settings=await admin.newPage();settings.on('pageerror',e=>errors.push(e.message));
      await settings.goto(`${base}/admin/settings`);
      await settings.getByText('Đã gửi queue · chờ worker',{exact:true}).waitFor();
      await settings.getByText('Chờ gửi vào queue',{exact:true}).first().waitFor();
      assert.equal(await settings.locator('tr').filter({hasText:'Settings Selfplay'}).count(),2);
      assert.ok((await settings.locator('tr').filter({hasText:'Settings Selfplay'}).first().textContent()).includes('Self-play'));
      await settings.screenshot({path:path.join(logDir,'settings-validation-desktop.png'),fullPage:true});
      await settings.setViewportSize({width:390,height:844});
      assert.equal(await settings.locator('body').evaluate(el=>el.scrollWidth<=window.innerWidth),true);
      await settings.screenshot({path:path.join(logDir,'settings-validation-mobile.png'),fullPage:true});
    }finally{await admin.close();}
  });
  await check('guest dashboard and login/register links preserve the chosen feature', async () => {
    await page.goto(`${base}/dashboard`);
    await page.locator('main a[href="/arena/submit"]').waitFor();
    await page.getByRole('link',{name:'Đăng nhập',exact:true}).waitFor();
    await page.getByRole('link',{name:'Đăng ký',exact:true}).waitFor();
    assert.equal(await page.getByText('Quản Trị Hệ Thống (Admin)',{exact:false}).count(),0);
    await page.screenshot({path:path.join(logDir,'guest-dashboard.png'),fullPage:true});
    await page.locator('main a[href="/arena/submit"]').click();
    await page.waitForURL('**/login?redirect=%2Farena%2Fsubmit');
    await page.getByRole('link',{name:'Đăng ký',exact:true}).click();
    await page.waitForURL('**/register?redirect=%2Farena%2Fsubmit');
    await page.getByRole('link',{name:'Đăng nhập',exact:true}).click();
    await page.waitForURL('**/login?redirect=%2Farena%2Fsubmit');
    await fillAuth('beta'); await page.getByRole('button',{name:'Đăng nhập',exact:true}).click();
    await page.waitForURL(`${base}/arena/submit`);
    await page.getByRole('button',{name:'Đăng xuất',exact:true}).waitFor();
    const admin = await context.request.get(`${base}/admin/workers`,{maxRedirects:0});
    assert.equal(new URL(admin.headers().location).pathname,'/403');
  });
  await check('failed logout retains the session; successful logout returns to public dashboard', async () => {
    await page.route('**/api/auth/logout',route => route.fulfill({status:500,json:{error:'test failure'}}));
    await page.getByRole('button',{name:'Đăng xuất',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'Không thể đăng xuất'}).waitFor();
    assert.equal(new URL(page.url()).pathname,'/arena/submit');
    assert.equal((await context.request.get(`${base}/api/auth/me`)).status(),200);
    await page.unroute('**/api/auth/logout');
    await page.getByRole('button',{name:'Đăng xuất',exact:true}).click();
    await page.waitForURL(`${base}/dashboard`);
    await page.getByRole('link',{name:'Đăng nhập',exact:true}).waitFor();
    assert.equal(await page.getByText('beta',{exact:true}).count(),0);
    assert.equal((await context.request.get(`${base}/api/arena/agents`)).status(),401);
    await page.goBack();
    await page.goto(`${base}/arena/submit?template=first`);
    await page.waitForURL('**/login?redirect=%2Farena%2Fsubmit%3Ftemplate%3Dfirst');
    const friendly = await context.request.get(`${base}/arena/friendly?tab=history`,{maxRedirects:0});
    assert.equal(new URL(friendly.headers().location).searchParams.get('redirect'),'/arena/friendly?tab=history');
  });
  await check('registration returns to the feature and unsafe redirect cannot leave the app', async () => {
    await page.goto(`${base}/register?redirect=${encodeURIComponent('/arena/submit?from=registration')}`);
    await fillAuth(`guest_${randomUUID().slice(0,8)}`);
    await page.getByRole('button',{name:'Đăng ký',exact:true}).click();
    await page.waitForURL(`${base}/arena/submit?from=registration`);
    await page.getByRole('button',{name:'Đăng xuất',exact:true}).click();
    await page.waitForURL(`${base}/dashboard`);
    await page.goto(`${base}/login?redirect=${encodeURIComponent('//evil.test')}`);
    await fillAuth('beta'); await page.getByRole('button',{name:'Đăng nhập',exact:true}).click();
    await page.waitForURL(`${base}/dashboard`);
    await page.getByRole('button',{name:'Đăng xuất',exact:true}).click();
    await page.waitForURL(`${base}/dashboard`);
    await page.getByRole('link',{name:'Đăng nhập',exact:true}).waitFor();
  });
  await check('admin logout clears administrative dashboard and mobile guest dashboard remains accessible', async () => {
    await page.goto(`${base}/login`); await fillAuth('alpha');
    await page.getByRole('button',{name:'Đăng nhập',exact:true}).click();
    await page.waitForURL(`${base}/dashboard`);
    await page.getByText('Quản Trị Hệ Thống (Admin)',{exact:false}).waitFor();
    await page.getByRole('button',{name:'Đăng xuất',exact:true}).click();
    await page.getByRole('link',{name:'Đăng nhập',exact:true}).waitFor();
    await page.reload();
    assert.equal(await page.getByText('Quản Trị Hệ Thống (Admin)',{exact:false}).count(),0);
    await page.setViewportSize({width:390,height:844});
    await page.locator('main a[href="/arena/submit"]').waitFor();
    assert.equal(await page.locator('body').evaluate(el => el.scrollWidth <= window.innerWidth),true);
    await page.screenshot({path:path.join(logDir,'guest-dashboard-mobile.png'),fullPage:true});
    await page.setViewportSize({width:1600,height:1100});
  });
  await check('leaderboard per user, multi-agent menu and archived history', async () => {
    await page.goto(`${base}/arena/leaderboard`);
    await page.getByRole('cell', { name: 'alpha', exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Game History của Alpha Best', exact:true }).count(),1);
    await page.getByLabel('Các agents của alpha', { exact:true }).click();
    await page.getByText('Alpha Archived', {exact:true}).waitFor();
    assert.equal(await page.getByText('Alpha Rejected', {exact:true}).count(),0);
    await page.getByRole('link').filter({hasText:'Alpha Archived'}).click();
    await page.getByText('Chọn một trận bên trái để xem replay.', {exact:true}).waitFor();
    assert.ok(page.url().includes('/agents/3/history'));
    await page.getByRole('link', { name:'Quay lại leaderboard' }).click();
    await page.getByRole('link', { name: 'Game History của Alpha Best', exact:true }).waitFor();
    await page.screenshot({path:path.join(logDir,'leaderboard.png'),fullPage:true});
  });
  await check('split Game History reuses original board and switches real replays', async () => {
    await page.getByRole('link', { name: 'Game History của Alpha Best', exact:true }).click();
    await page.waitForURL('**/history?matchId=1&result=all');
    await page.getByRole('button',{name:'▶ Tự động phát',exact:true}).waitFor();
    assert.equal(await page.locator('header').count(),1);
    await page.getByRole('button',{name:'Tiến ▶',exact:true}).click();
    await page.getByText('1/1',{exact:true}).waitFor();
    const refreshed = page.waitForResponse(r => r.url().includes('/api/arena/agents/1/history?') && r.status() === 200);
    await page.getByRole('button',{name:'↻ Làm mới',exact:true}).click();
    await refreshed;
    await page.getByText('1/1',{exact:true}).waitFor();
    await page.locator('aside button').filter({hasText:'alpha'}).nth(2).click();
    await page.waitForURL('**/history?matchId=2&result=all');
    await page.getByText('0/1',{exact:true}).waitFor();
    await page.goBack(); await page.waitForURL('**/history?matchId=1&result=all');
    await page.getByRole('button',{name:'▶ Tự động phát',exact:true}).waitFor();
    await page.goForward(); await page.waitForURL('**/history?matchId=2&result=all');
    await page.getByRole('button',{name:'▶ Tự động phát',exact:true}).waitFor();
    await page.getByRole('button', {name:'Tải thêm trận',exact:true}).click();
    await page.getByText('#25',{exact:true}).waitFor();
    await page.screenshot({path:path.join(logDir,'game-history.png'),fullPage:true});
    await page.getByRole('combobox',{name:'Lọc kết quả'}).selectOption('scheduled');
    await page.locator('aside button').filter({hasText:'alpha'}).first().click();
    await page.getByText('Trận chưa hoàn thành. Replay sẽ xuất hiện khi có kết quả.',{exact:true}).waitFor();
    await page.reload();
    await page.getByText('Trận chưa hoàn thành. Replay sẽ xuất hiện khi có kết quả.',{exact:true}).waitFor();
  });
  await check('calibration and search preserve global rank', async () => {
    await page.goto(`${base}/arena/leaderboard`);
    await page.getByRole('tab',{name:/Đang hiệu chỉnh/}).click();
    await page.getByText('Hiệu chỉnh 9/10',{exact:false}).waitFor();
    await page.getByRole('tab',{name:/Bảng xếp hạng/}).click();
    await page.getByLabel('Tìm leaderboard').fill('Alpha Best');
    await page.getByRole('cell',{name:'alpha',exact:true}).waitFor();
    assert.equal(await page.locator('tbody tr').count(),1);
    assert.equal(await page.locator('tbody tr td').first().innerText(),'2');
  });
  await check('mobile history, public agent detail and legacy replay links', async () => {
    await page.setViewportSize({width:390,height:844});
    await page.goto(`${base}/arena/agents/1/history?matchId=1`);
    await page.getByRole('button',{name:'Xem replay',exact:true}).click();
    await page.getByRole('button',{name:'▶ Tự động phát',exact:true}).waitFor();
    assert.equal(await page.locator('body').evaluate(el => el.scrollWidth <= window.innerWidth),true);
    await page.screenshot({path:path.join(logDir,'game-history-mobile.png'),fullPage:true});
    await page.getByRole('button',{name:'Danh sách trận',exact:true}).click();
    await page.getByRole('heading',{name:'Games (26)',exact:true}).waitFor();
    await page.goto(`${base}/arena/agents/1`);
    await page.getByRole('heading',{name:'Lịch sử điểm rating',exact:true}).waitFor();
    await page.goto(`${base}/arena/replay/rating/1`);
    await page.getByRole('button',{name:'▶ Tự động phát',exact:true}).waitFor();
  });
  await check('Team tab wave requests reach the leader, cancel and approve across desktop/mobile',async()=>{
    await scoped("INSERT INTO users(username,password_hash) VALUES('wave_leader',$1),('wave_applicant',$1),('wave_outsider',$1)",[bcrypt.hashSync(testPassword,4)]);
    const leader=await browser.newContext({viewport:{width:1440,height:1000}});
    const applicant=await browser.newContext({viewport:{width:390,height:844}});
    const outsider=await browser.newContext();
    let teamId;
    try{
      for(const [ctx,username] of [[leader,'wave_leader'],[applicant,'wave_applicant'],[outsider,'wave_outsider']])
        assert.equal((await ctx.request.post(`${base}/api/auth/login`,{data:{username,password:testPassword}})).status(),200);
      const created=await leader.request.post(`${base}/api/team`,{data:{action:'create',name:'Wave Pioneers'}});
      assert.equal(created.status(),200);teamId=Number((await created.json()).team_id);
      assert.equal((await leader.request.post(`${base}/api/team`,{data:{action:'update',name:'Wave Pioneers',recruiting:true}})).status(),200);
      await page.setViewportSize({width:1440,height:1000});
      await page.goto(`${base}/arena/leaderboard`);await page.getByRole('tab',{name:'Team 👋',exact:true}).click();
      await page.getByRole('heading',{name:'Wave Pioneers',exact:true}).waitFor();
      await page.getByRole('link',{name:'Đăng nhập để vẫy tay',exact:true}).waitFor();
      await page.screenshot({path:path.join(logDir,'team-directory-desktop.png'),fullPage:true});
      const applicantPage=await applicant.newPage();applicantPage.on('pageerror',e=>errors.push(e.message));
      await applicantPage.goto(`${base}/arena/leaderboard`);await applicantPage.getByRole('tab',{name:'Team 👋',exact:true}).click();
      await applicantPage.getByRole('button',{name:'Vẫy tay xin vào Wave Pioneers',exact:true}).click();
      await applicantPage.getByText('👋 Đã gửi yêu cầu',{exact:true}).waitFor();
      await applicantPage.getByRole('button',{name:'Hủy yêu cầu vào Wave Pioneers',exact:true}).click();
      await applicantPage.getByRole('button',{name:'Vẫy tay xin vào Wave Pioneers',exact:true}).click();
      await applicantPage.getByText('👋 Đã gửi yêu cầu',{exact:true}).waitFor();
      assert.equal(await applicantPage.locator('body').evaluate(el=>el.scrollWidth<=window.innerWidth),true);
      await applicantPage.screenshot({path:path.join(logDir,'team-wave-mobile.png'),fullPage:true});
      const leaderPage=await leader.newPage();leaderPage.on('pageerror',e=>errors.push(e.message));
      await leaderPage.goto(`${base}/team`);
      const requests=leaderPage.getByRole('region',{name:'Yêu cầu xin vào đội'});
      await requests.getByText('wave_applicant',{exact:true}).first().waitFor();
      await leaderPage.screenshot({path:path.join(logDir,'team-wave-leader.png'),fullPage:true});
      const incoming=(await(await leader.request.get(`${base}/api/team`)).json()).join_requests_received.find(r=>r.status==='pending');
      assert.equal((await outsider.request.post(`${base}/api/team`,{data:{action:'approve_join',request_id:Number(incoming.id)}})).status(),403);
      await requests.getByRole('button',{name:'Chấp nhận wave_applicant',exact:true}).click();
      await leaderPage.getByRole('heading',{name:'Thành viên (2/3)',exact:true}).waitFor();
      await applicantPage.reload();await applicantPage.getByRole('link',{name:'Đội của bạn →',exact:true}).waitFor();
      assert.equal(Number((await(await applicant.request.get(`${base}/api/team`)).json()).team.id),teamId);
      await applicantPage.screenshot({path:path.join(logDir,'team-wave-approved-mobile.png'),fullPage:true});
    }finally{
      await leader.close();await applicant.close();await outsider.close();
      if(teamId)await scoped("SELECT manage_team(1,'archive',jsonb_build_object('team_id',$1::bigint))",[teamId]);
    }
  });
  await check('team creation, invitations, current-scope ownership and admin-only dissolution in Chrome',async()=>{
    await page.setViewportSize({width:1440,height:1000});
    await page.goto(`${base}/team`);await page.waitForURL('**/login?redirect=%2Fteam');
    await fillAuth('beta');await page.getByRole('button',{name:'Đăng nhập',exact:true}).click();
    await page.waitForURL(`${base}/team`);await page.getByRole('heading',{name:'Bạn đang thi đấu cá nhân',exact:true}).waitFor();
    page.on('dialog',dialog=>dialog.accept());
    await page.getByLabel('Tên team',{exact:true}).fill('Team Beta');await page.getByRole('button',{name:'Tạo team',exact:true}).click();
    await page.getByRole('heading',{name:'Thành viên (1/3)',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Rời team',exact:true}).count(),0);
    await page.getByLabel('Hiển thị trạng thái tìm đồng đội trên leaderboard').check();
    await page.getByRole('button',{name:'Lưu thay đổi',exact:true}).click();
    const leaderData=await (await context.request.get(`${base}/api/team`)).json();
    const teamId=Number(leaderData.team.id);
    const own=await(await context.request.get(`${base}/api/arena/agents`)).json();
    assert.equal(own.agents.length,1);assert.equal(Number(own.agents[0].id),2);
    await page.getByLabel('Tìm người chưa có team').fill('gamma');
    await page.getByRole('button',{name:'Mời',exact:true}).click();
    await page.getByText('gamma · Đang chờ',{exact:true}).waitFor();
    await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(logDir,'team-leader.png'),fullPage:true});
    const member=await browser.newContext({viewport:{width:390,height:844}});
    const memberPage=await member.newPage();memberPage.on('dialog',d=>d.accept());memberPage.on('pageerror',e=>errors.push(e.message));
    const login=await member.request.post(`${base}/api/auth/login`,{data:{username:'gamma',password:testPassword}});assert.equal(login.status(),200);
    await memberPage.goto(`${base}/team`);await memberPage.getByRole('button',{name:'Chấp nhận',exact:true}).click();
    await memberPage.getByRole('heading',{name:'Thành viên (2/3)',exact:true}).waitFor();
    const memberOwn=await(await member.request.get(`${base}/api/arena/agents`)).json();
    assert.equal(Number(memberOwn.agents[0].id),2);assert.equal(Number(memberOwn.personal_agents[0].id),5);
    const leaderPrivate=await(await context.request.get(`${base}/api/arena/agents`)).json();assert.equal(leaderPrivate.personal_agents.length,0);
    const standings=await(await member.request.get(`${base}/api/arena/leaderboard`)).json();
    assert.equal(standings.me.kind,'team');assert.equal(Number(standings.me.team_id),teamId);
    assert.equal(standings.leaderboard.filter(e=>e.kind==='team').length,1);
    assert.equal((await(await member.request.get(`${base}/api/arena/leaderboard?tab=calibrating`)).json()).total,0);
    const wrongScope=await member.request.post(`${base}/api/arena/agents`,{data:{agent_name:'Private draft',code:'def agent(observation, configuration): return {}',expected_scope:'user:3'}});
    assert.equal(wrongScope.status(),409);
    const shared=await member.request.post(`${base}/api/arena/agents`,{data:{agent_name:'Shared submission',code:'def agent(observation, configuration): return {}',expected_scope:`team:${teamId}`}});
    assert.equal(shared.status(),200);const sharedAgent=await shared.json();
    const owner=await scoped('SELECT team_id,user_id FROM arena_agents WHERE id=$1',[sharedAgent.agent_id]);
    assert.equal(Number(owner[0].team_id),teamId);assert.equal(Number(owner[0].user_id),3);
    const guestName=(await scoped("SELECT username FROM users WHERE username LIKE 'guest_%' LIMIT 1"))[0].username;
    const guestId=Number((await scoped('SELECT id FROM users WHERE username=$1',[guestName]))[0].id);
    const outsiderAgent=Number((await scoped("INSERT INTO arena_agents(user_id,agent_name,code,status,is_active) VALUES($1,'Outside agent','PRIVATE_SOURCE','active',true) RETURNING id",[guestId]))[0].id);
    const outsider=await browser.newContext();assert.equal((await outsider.request.post(`${base}/api/auth/login`,{data:{username:guestName,password:testPassword}})).status(),200);
    const challengeResponse=await outsider.request.post(`${base}/api/friendly/challenge`,{data:{challenger_agent_id:outsiderAgent,opponent_agent_id:2}});
    assert.equal(challengeResponse.status(),410);
    const requestId=randomUUID();
    const trialResponse=await outsider.request.post(`${base}/api/friendly`,{data:{agent1_id:outsiderAgent,agent2_id:2,request_id:requestId}});
    assert.equal(trialResponse.status(),200);const trial=await trialResponse.json();assert.equal(trial.queued,false);assert.equal(trial.quota.remaining,9);
    const retry=await outsider.request.post(`${base}/api/friendly`,{data:{agent1_id:outsiderAgent,agent2_id:2,request_id:requestId}});
    assert.equal((await retry.json()).friendly_match_id,trial.friendly_match_id);
    assert.equal((await(await member.request.get(`${base}/api/friendly`)).json()).matches.length,0);
    assert.equal((await member.request.get(`${base}/api/friendly/${trial.friendly_match_id}/replay`)).status(),404);
    assert.equal((await fetch(`${base}/api/arena/agents/${outsiderAgent}`)).status,404);
    const outsiderPage=await outsider.newPage();await outsiderPage.goto(`${base}/arena/friendly`);
    await outsiderPage.getByRole('heading',{name:'Thách đấu riêng tư',exact:true}).waitFor();
    await outsiderPage.getByText('Outside agent vs Beta Best',{exact:false}).or(outsiderPage.getByText('Beta Best vs Outside agent',{exact:false})).waitFor();
    await outsiderPage.screenshot({path:path.join(logDir,'private-trials.png'),fullPage:true});
    for(let i=0;i<9;i++)assert.equal((await outsider.request.post(`${base}/api/friendly`,{data:{agent1_id:outsiderAgent,agent2_id:2,request_id:randomUUID()}})).status(),200);
    assert.equal((await outsider.request.post(`${base}/api/friendly`,{data:{agent1_id:outsiderAgent,agent2_id:2,request_id:randomUUID()}})).status(),429);
    const submitCode='def agent(observation, configuration):\n    return {}\n';
    const draftResponse=await outsider.request.post(`${base}/api/arena/agents`,{data:{agent_name:'Private draft',code:submitCode}});
    assert.equal(draftResponse.status(),200);const draft=await draftResponse.json();assert.equal(draft.is_public,false);
    const duplicate=await outsider.request.post(`${base}/api/arena/agents`,{data:{agent_name:'Duplicate',code:'\r\ndef agent(observation, configuration):  \r\n    return {}\r\n'}});
    assert.equal(duplicate.status(),409);assert.equal((await duplicate.json()).agent_id,draft.agent_id);
    assert.equal((await outsider.request.post(`${base}/api/arena/agents/${draft.agent_id}/publish`)).status(),409);
    await scoped("UPDATE arena_agents SET status='active',is_active=true WHERE id=$1",[draft.agent_id]);
    assert.equal((await outsider.request.post(`${base}/api/arena/agents/${draft.agent_id}/publish`)).status(),200);
    assert.equal((await fetch(`${base}/api/arena/agents/${draft.agent_id}`)).status,200);
    checks.push('private trials, offline idempotency, quota, opponent privacy, duplicate code and irreversible publication');
    await outsider.close();
    const forbidden=await member.request.post(`${base}/api/team`,{data:{action:'update',name:'Stolen'}});assert.equal(forbidden.status(),403);
    const founderLeave=await context.request.post(`${base}/api/team`,{data:{action:'leave'}});assert.equal(founderLeave.status(),409);
    const ownArchive=await context.request.post(`${base}/api/team`,{data:{action:'archive',team_id:teamId}});assert.equal(ownArchive.status(),403);
    const list=await(await member.request.get(`${base}/api/arena/agents/all-active`)).json();
    assert.ok(list.agents.find(a=>Number(a.id)===2).can_use);assert.ok(!list.agents.some(a=>Number(a.id)===5));
    const invitation=await context.request.post(`${base}/api/team`,{data:{action:'invite',username:'alpha'}});assert.equal(invitation.status(),200);
    const admin=await browser.newContext();const adminPage=await admin.newPage();adminPage.on('dialog',d=>d.accept());
    assert.equal((await admin.request.post(`${base}/api/auth/login`,{data:{username:'alpha',password:testPassword}})).status(),200);
    const adminInvites=await(await admin.request.get(`${base}/api/team`)).json();
    assert.equal((await admin.request.post(`${base}/api/team`,{data:{action:'accept',invitation_id:Number(adminInvites.received[0].id)}})).status(),200);
    const extra=await context.request.post(`${base}/api/team`,{data:{action:'invite',username:leaderData.user_id===1?'beta':(await scoped("SELECT username FROM users WHERE username LIKE 'guest_%' LIMIT 1"))[0].username}});
    assert.equal(extra.status(),409);
    await memberPage.reload();await memberPage.getByRole('heading',{name:'Thành viên (3/3)',exact:true}).waitFor();
    assert.equal(await memberPage.locator('body').evaluate(el=>el.scrollWidth<=window.innerWidth),true);
    await memberPage.screenshot({path:path.join(logDir,'team-member-mobile.png'),fullPage:true});
    await memberPage.getByRole('button',{name:'Rời team',exact:true}).click();
    await memberPage.getByRole('heading',{name:'Bạn đang thi đấu cá nhân',exact:true}).waitFor();
    const restored=await(await member.request.get(`${base}/api/arena/agents`)).json();assert.equal(Number(restored.agents[0].id),5);assert.ok(!restored.agents.some(a=>Number(a.id)===2));
    await adminPage.goto(`${base}/admin/teams`);await adminPage.getByRole('button',{name:'Giải thể team',exact:true}).click();
    await adminPage.getByText('archived',{exact:false}).waitFor();
    const after=await(await context.request.get(`${base}/api/team`)).json();assert.equal(after.team,null);
    const history=await context.request.get(`${base}/api/rating/matches/1/replay`);assert.equal(history.status(),200);
    const frozen=await scoped('SELECT agent_scope_active(2) AS enabled');assert.equal(frozen[0].enabled,false);
    await member.close();await admin.close();
  });
  assert.deepEqual(errors,[]);
  passed = true;
} finally {
  await browser?.close();
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit',resolve)),pause(5000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit',resolve)); }
  }
  if(offlineBackend)await new Promise(resolve=>offlineBackend.close(resolve));
  if (created) { assert.match(schema,/^ott_lb_e2e_\d+_[a-f0-9]{6}$/); await sql.query(`DROP SCHEMA ${schema} CASCADE`); }
  writeFileSync(path.join(logDir,'report.json'),JSON.stringify({passed,checks,schema,cleanedUp:true},null,2));
  console.log(`Report: ${logDir}/report.json`);
}
