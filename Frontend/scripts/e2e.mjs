import { createRequire } from "node:module";
import { splitSql } from './sql-statements.mjs';
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, existsSync, renameSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import tls from "node:tls";
import { pinLookup } from "./e2e-network.mjs";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");
const { neon, neonConfig } = require("@neondatabase/serverless");
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnvConfig(frontend);
const originalUrl = process.env.DATABASE_URL;
if (!originalUrl) throw new Error("DATABASE_URL is missing");
const sql = neon(originalUrl);
const root = path.resolve(frontend, "..");
const statePath = path.join(root, "logs/e2e-state.json");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let neonRoute;

async function selectNeonRoute() {
  const host = new URL(neonConfig.fetchEndpoint(new URL(originalUrl).hostname, 5432)).hostname;
  const addresses = await lookup(host, { all: true });
  const reachable = await Promise.any(addresses.filter(item => item.family === 4).map(item => new Promise((resolve, reject) => {
    const socket = tls.connect({ host: item.address, port: 443, servername: host, rejectUnauthorized: true });
    socket.setTimeout(2500, () => socket.destroy(new Error("TLS route timeout")));
    socket.once("error", reject);
    socket.once("secureConnect", () => { resolve(item.address); socket.end(); });
  })));
  pinLookup(host, reachable);
  neonRoute = { host, address: reachable };
  console.log(`E2E Neon TLS route: ${host} via ${reachable}`);
}

function routeEnv() {
  return { OTT_E2E_NEON_HOST: neonRoute.host, OTT_E2E_NEON_ADDRESS: neonRoute.address,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${path.join(frontend, "scripts/e2e-network.mjs")}`.trim() };
}

async function retry(fn, label) {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); } catch (error) {
      if (attempt >= 5 || !/fetch failed|connect|timeout/i.test(error.message)) throw error;
      console.log(`${label}: retry ${attempt}/5`);
      await sleep(attempt * 1000);
    }
  }
}

function readEnv(file) {
  return Object.fromEntries(readFileSync(file, "utf8").split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) return [];
    return [[match[1], match[2].replace(/^(["'])(.*)\1$/, "$2")]];
  }));
}

async function inspect() {
  console.log("Proxy environment:", { HTTPS_PROXY: Boolean(process.env.HTTPS_PROXY), HTTP_PROXY: Boolean(process.env.HTTP_PROXY), NODE_USE_ENV_PROXY: Boolean(process.env.NODE_USE_ENV_PROXY) });
  const host = new URL(originalUrl).hostname;
  const endpoint = neonConfig.fetchEndpoint(host, 5432);
  console.log("Neon HTTP endpoint:", endpoint);
  try { console.log("Neon HTTP DNS:", await lookup(new URL(endpoint).hostname)); }
  catch (error) { console.log("Neon HTTP DNS failed:", error.code); }
  try { console.log("Neon DNS:", await lookup(host)); }
  catch (error) { console.log("Neon DNS failed:", error.code); }
  const identity = await retry(() => sql`SELECT current_database() AS database, current_schema() AS schema, version()`, "Neon identity");
  const columns = await retry(() => sql`SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN ('users','arena_agents','rated_matches','friendly_matches','rating_scheduler_state')
    ORDER BY table_name, ordinal_position`, "Neon schema");
  const tables = {};
  for (const row of columns) (tables[row.table_name] ??= []).push(row.column_name);
  const backend = readEnv(path.join(frontend, "../backend/.env"));
  const redis = await fetch(backend.UPSTASH_REDIS_REST_URL, {
    method: "POST", headers: { Authorization: `Bearer ${backend.UPSTASH_REDIS_REST_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(["PING"]), signal: AbortSignal.timeout(10000),
  });
  const redisBody = await redis.json();
  console.log(JSON.stringify({ database: identity[0].database, schema: identity[0].schema, tables,
    redis: redisBody.result }, null, 2));
  const schema = `ott_e2e_probe_${Date.now()}`;
  const [, scope] = await retry(() => sql.transaction(txn => [
    txn`SELECT set_config('search_path', ${schema}, true)`,
    txn`SELECT current_setting('search_path') AS search_path`,
  ]), "Neon isolation");
  if (scope[0].search_path !== schema) throw new Error("Database does not honor isolated search_path");
  console.log("Isolated database search_path supported");
}

async function run() {
  if (existsSync(statePath)) {
    const previous = JSON.parse(readFileSync(statePath, "utf8"));
    if (!previous.stopped) throw new Error("An E2E stack is already recorded; inspect logs/e2e-state.json or run with --stop first.");
    renameSync(statePath, path.join(previous.logDir, `stopped-state-${Date.now()}.json`));
  }
  await inspect();
  const runId = `ott_e2e_${Date.now()}`;
  const schema = runId;
  const prefix = `${runId}:`;
  const logDir = path.join(root, "logs", runId);
  mkdirSync(logDir, { recursive: true });
  const backendEnv = readEnv(path.join(root, "backend/.env"));
  const workerEnv = readEnv(path.join(root, "worker_image/.env"));
  const frontendPort = Number(process.env.E2E_FRONTEND_PORT || 3100);
  const backendPort = Number(process.env.E2E_BACKEND_PORT || 8100);
  if (![frontendPort, backendPort].every(port => Number.isInteger(port) && port > 1024 && port < 65536)) throw new Error('Invalid E2E ports');
  const state = { runId, schema, prefix, logDir, buildDir: '.next-e2e', frontend: `http://127.0.0.1:${frontendPort}`, backend: `http://127.0.0.1:${backendPort}`, processes: [] };
  function saveState() { writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 }); }
  const scoped = async (queryText, values = []) => {
    const results = await sql.transaction(txn => [txn`SELECT set_config('search_path', ${schema}, true)`, txn.query(queryText, values)]);
    return results[1];
  };
  // Refuse occupied ports instead of terminating someone else's processes.
  for (const url of [state.frontend, `${state.backend}/health`]) {
    try { await fetch(url, { signal: AbortSignal.timeout(1000) }); throw new Error(`Service already running at ${url}`); }
    catch (error) { if (error.message.startsWith("Service already")) throw error; }
  }
  await retry(() => sql.query(`CREATE SCHEMA ${schema}`), "Create isolated schema");
  saveState();
  const statements = [];
  for (const file of ["database.sql", "arena_schema.sql", "tournament_schema.sql", "trueskill_migration.sql",
    "friendly_challenge_migration.sql", "execution_token_migration.sql", "app_settings_migration.sql", "adaptive_rating_migration.sql", "teams_migration.sql", "team_join_requests_migration.sql", "private_trials_migration.sql"]) {
    statements.push(...splitSql(readFileSync(path.join(frontend, file), "utf8")));
  }
  await sql.transaction(txn => [txn`SELECT set_config('search_path', ${schema}, true)`, ...statements.map(stmt => txn.query(stmt))]);
  assert.equal((await scoped("SELECT current_schema() AS schema"))[0].schema, schema);
  console.log(`Created isolated schema ${schema}; Redis namespace ${prefix}`);

  function launch(name, command, args, cwd, env) {
    const log = path.join(logDir, `${name}.log`);
    const fd = openSync(log, "a", 0o600);
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env, OTT_E2E_RUN_ID: runId },
      detached: true, stdio: ["ignore", fd, fd] });
    child.on("error", error => console.error(`${name} failed: ${error.message}`));
    child.unref();
    closeSync(fd);
    state.processes.push({ name, pid: child.pid, log });
    saveState();
    console.log(`${name}: PID ${child.pid}`);
  }
  launch("backend", "python3", ["-B", "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(backendPort)], path.join(root, "backend"),
    { ...backendEnv, REDIS_KEY_PREFIX: prefix });
  launch("frontend", "node", ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(frontendPort)], frontend,
    { DATABASE_URL: originalUrl, DATABASE_SCHEMA: schema, BACKEND_URL: state.backend, NEXT_PUBLIC_BACKEND_URL: state.backend,
      NEXT_BUILD_DIR: state.buildDir, ...routeEnv() });
  const waitFor = async (label, predicate, timeout = 120000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await sleep(1500);
    }
    throw new Error(`Timed out: ${label}`);
  };
  await waitFor("backend and Redis health", async () => {
    try { const r = await fetch(`${state.backend}/health`); return r.ok && (await r.json()).redis_connected; } catch { return false; }
  });
  await waitFor("frontend ready", async () => {
    try { return (await fetch(`${state.frontend}/login`)).ok; } catch { return false; }
  });
  launch("worker", "python3", ["-B", "main.py"], path.join(root, "worker_image"), { ...workerEnv,
    BACKEND_URL: state.backend, FRONTEND_URL: state.frontend,
    WORKER_ID: `${runId}_worker`, MAX_CONCURRENT: "2", POLL_INTERVAL: "1", PYTHONUNBUFFERED: "1" });
  await waitFor("worker heartbeat", async () => {
    const response = await fetch(`${state.backend}/workers/status`);
    return response.ok && (await response.json()).total_workers > 0;
  });
  const checks = [];
  async function check(name, fn) { await fn(); checks.push(name); console.log(`PASS ${name}`); }
  async function api(route, { method = "GET", body, cookie, headers = {}, expected = 200 } = {}) {
    const response = await fetch(`${state.frontend}${route}`, { method, headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers,
    }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(45000), redirect: "manual" });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    assert.equal(response.status, expected, `${route}: ${response.status} ${typeof data === "string" ? data.slice(0, 120) : JSON.stringify(data)}`);
    return { data, response };
  }
  const credentials = ["one", "two", "bad"].map(suffix => ({ username: `e2e_${Date.now()}_${suffix}`, password: `Test-${randomUUID()}` }));
  writeFileSync(path.join(logDir, "accounts.json"), JSON.stringify(credentials, null, 2), { mode: 0o600 });
  const sessions = [];
  try {
    await check("unauthenticated requests rejected", async () => {
      await api("/api/arena/agents", { expected: 401 });
      await api("/api/rating/dispatch", { method: "POST", expected: 401 });
    });
    await check("register, login, signed cookie and admin access", async () => {
      for (const account of credentials) {
        const registered = await api("/api/auth/register", { method: "POST", body: account });
        assert.ok(registered.response.headers.get("set-cookie")?.includes("HttpOnly"));
      }
      await scoped("UPDATE users SET is_admin = true WHERE username = $1", [credentials[0].username]);
      for (const account of credentials) {
        const login = await api("/api/auth/login", { method: "POST", body: account });
        const cookie = login.response.headers.get("set-cookie")?.split(";")[0];
        assert.ok(cookie);
        const me = await api("/api/auth/me", { cookie });
        assert.equal(me.data.user.username, account.username);
        sessions.push(cookie);
      }
      await api("/api/admin/rating/status", { cookie: sessions[1], expected: 403 });
      await api("/api/admin/rating/rebuild", { method: "POST", cookie: sessions[0] });
    });
    const code = `def agent(observation, configuration):\n    target = (8, 8) if observation['current_player'] == 1 else (0, 0)\n    moves = observation['valid_moves']\n    return min(moves, key=lambda m: (max(abs(m['to_col']-target[0]), abs(m['to_row']-target[1])), -int(m.get('is_capture', False)))) if moves else None\n`;
    const ids = [];
    await check("submit Python agents and execute self-play in the Python sandbox", async () => {
      for (let index = 0; index < 3; index++) {
        const submitted = await api("/api/arena/agents", { method: "POST", cookie: sessions[index], body: {
          agent_name: `E2E ${index}`, is_public:true, code: index === 2 ? "def agent(observation, configuration):\n    raise ValueError('E2E deliberate agent error')" : code,
        } });
        ids.push(Number(submitted.data.agent_id));
      }
      await waitFor("self-play validation", async () => {
        const rows = await scoped("SELECT id, status FROM arena_agents WHERE id = ANY($1::bigint[]) ORDER BY id", [ids]);
        console.log("Validation:", rows.map(row => `${row.id}:${row.status}`).join(" "));
        return rows.length === 3 && rows.every(row => row.status !== "validating");
      }, 480000);
      const agents = await scoped("SELECT status FROM arena_agents WHERE id = ANY($1::bigint[]) ORDER BY id", [ids]);
      assert.deepEqual(agents.map(row => row.status), ["active", "active", "rejected"]);
    });
    let ratingMatch;
    await check("continuous rating, TrueSkill update and persisted replay", async () => {
      ratingMatch = await waitFor("scheduled rating match", async () => (await scoped("SELECT id FROM rated_matches WHERE kind = 'rating' ORDER BY id LIMIT 1"))[0], 120000);
      // Let in-flight work finish, then prevent this test from rating forever.
      await scoped("UPDATE rating_scheduler_state SET enabled = false WHERE id = true");
      await waitFor("rating result", async () => (await scoped("SELECT status FROM rated_matches WHERE id = $1", [ratingMatch.id]))[0].status === "finished", 480000);
      const match = (await scoped("SELECT * FROM rated_matches WHERE id = $1", [ratingMatch.id]))[0];
      assert.equal(match.is_infra_error, false);
      assert.ok(match.agent1_mu_after !== null);
      const replay = await api(`/api/rating/matches/${ratingMatch.id}/replay`, { cookie: sessions[0] });
      assert.equal(replay.data.moves.length, match.total_moves);
      assert.ok(replay.data.moves.length > 0);
      await api(`/arena/replay/rating/${ratingMatch.id}`, { cookie: sessions[0] });
      const counts = await scoped("SELECT wins + losses + draws AS games FROM arena_agents WHERE id = ANY($1::bigint[])", [ids.slice(0, 2)]);
      assert.ok(counts.every(row => Number(row.games) >= 1));
      await api("/api/arena/leaderboard", { cookie: sessions[0] });
    });
    await check("private trial, queue, worker and replay", async () => {
      const trial = await api('/api/friendly', {method:'POST',cookie:sessions[0],body:{agent1_id:ids[0],agent2_id:ids[1],request_id:crypto.randomUUID()}});
      const id=Number(trial.data.friendly_match_id);
      if(!trial.data.queued)await api("/api/friendly/process-pending", { method: "POST", cookie: sessions[0], body: { match_id: id } });
      await waitFor("friendly result", async () => (await scoped("SELECT status FROM friendly_matches WHERE id = $1", [id]))[0].status === "finished", 480000);
      const replay = await api(`/api/friendly/${id}/replay`, { cookie: sessions[0] });
      assert.ok(replay.data.moves.length > 0);
      assert.equal(replay.data.moves.length, replay.data.match.total_moves);
      await api(`/arena/replay/friendly/${id}`, { cookie: sessions[0] });
    });
    await check("frontend pages and system status", async () => {
      for (const route of ["/dashboard", "/arena/submit", "/arena/leaderboard", "/arena/friendly", "/admin/settings"]) {
        await api(route, { cookie: sessions[0] });
      }
      await api("/api/admin/system-status", { cookie: sessions[0] });
      await api("/api/auth/logout", { method: "POST", cookie: sessions[0] });
    });
    await waitFor("all test matches completed", async () => {
      const rows = await scoped("SELECT COUNT(*)::int AS count FROM rated_matches WHERE status IN ('running', 'scheduled')");
      return rows[0].count === 0;
    }, 480000);
    const report = { passed: true, checks, schema, prefix, neonRoute, services: state.processes, frontend: state.frontend, backend: state.backend,
      counts: (await scoped("SELECT (SELECT COUNT(*) FROM users)::int AS users, (SELECT COUNT(*) FROM arena_agents)::int AS agents, (SELECT COUNT(*) FROM rated_matches)::int AS rated_matches, (SELECT COUNT(*) FROM friendly_matches)::int AS friendly_matches"))[0] };
    writeFileSync(path.join(logDir, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await scoped("UPDATE rating_scheduler_state SET enabled = false WHERE id = true");
    console.log(`Stack kept online for inspection. Logs: ${logDir}; stop and remove test artifacts: node scripts/e2e.mjs --stop`);
  }
}

async function stop() {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  if (!/^ott_e2e_\d+$/.test(state.schema) || state.prefix !== `${state.schema}:`) throw new Error("Invalid E2E cleanup scope");
  for (const service of [...state.processes].reverse()) {
    try {
      const env = readFileSync(`/proc/${service.pid}/environ`, "utf8").split("\0");
      if (!env.includes(`OTT_E2E_RUN_ID=${state.runId}`)) throw new Error(`PID ${service.pid} does not belong to this test`);
      process.kill(-service.pid, "SIGTERM");
      console.log(`Stopped ${service.name} PID ${service.pid}`);
    } catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error; }
  }
  const backend = readEnv(path.join(root, "backend/.env"));
  const redisCommand = async command => {
    const response = await fetch(backend.UPSTASH_REDIS_REST_URL, { method: "POST",
      headers: { Authorization: `Bearer ${backend.UPSTASH_REDIS_REST_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(command) });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    return data.result;
  };
  let cursor = "0", removed = 0;
  do {
    const result = await redisCommand(["SCAN", cursor, "MATCH", `${state.prefix}*`, "COUNT", 100]);
    cursor = String(result[0]);
    if (result[1].length) removed += await redisCommand(["DEL", ...result[1]]);
  } while (cursor !== "0");
  for (const schema of state.extraSchemas || []) {
    if (schema !== `${state.schema}_rating`) throw new Error('Invalid extra E2E schema');
    await sql.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }
  await sql.query(`DROP SCHEMA IF EXISTS ${state.schema} CASCADE`);
  // Retain state and logs as a recoverable audit record; subsequent runs can
  // archive the state after confirming cleanup completed.
  state.stopped = true;
  state.removedRedisKeys = removed;
  writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  console.log(`Removed isolated schema ${state.schema} and ${removed} test Redis keys; logs retained.`);
}

async function verify() {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  if (state.stopped || !/^ott_e2e_\d+$/.test(state.schema)) throw new Error("No running E2E stack");
  const scoped = async (queryText, values = []) => (await retry(() => sql.transaction(txn => [
    txn`SELECT set_config('search_path', ${state.schema}, true)`, txn.query(queryText, values),
  ]), "Verification query"))[1];
  if (process.argv.includes("--restart-frontend")) {
    const service = state.processes.find(item => item.name === "frontend");
    const env = readFileSync(`/proc/${service.pid}/environ`, "utf8").split("\0");
    if (!env.includes(`OTT_E2E_RUN_ID=${state.runId}`)) throw new Error("Frontend process ownership mismatch");
    process.kill(-service.pid, "SIGTERM");
    await sleep(1500);
    const fd = openSync(service.log, "a", 0o600);
    const child = spawn("node", ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", new URL(state.frontend).port], {
      cwd: frontend, detached: true, stdio: ["ignore", fd, fd], env: { ...process.env,
        DATABASE_URL: originalUrl, DATABASE_SCHEMA: state.schema, BACKEND_URL: state.backend,
        NEXT_PUBLIC_BACKEND_URL: state.backend, OTT_E2E_RUN_ID: state.runId, NEXT_BUILD_DIR: state.buildDir || '.next', ...routeEnv() },
    });
    child.unref(); closeSync(fd);
    service.pid = child.pid;
    writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    await sleep(2000);
  }
  const checks = [];
  const account = JSON.parse(readFileSync(path.join(state.logDir, "accounts.json"), "utf8"))[0];
  const login = await fetch(`${state.frontend}/api/auth/login`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(account) });
  assert.equal(login.status, 200, "E2E login");
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const json = async (route, options = {}) => {
    const response = await fetch(`${state.frontend}${route}`, { headers: { Cookie: cookie }, ...options });
    assert.equal(response.status, 200, route);
    return response.json();
  };
  assert.equal((await scoped("SELECT current_schema() AS schema"))[0].schema, state.schema);
  checks.push("real Neon schema isolation");
  const health = await (await fetch(`${state.backend}/health`)).json();
  assert.equal(health.redis_connected, true);
  const workers = await (await fetch(`${state.backend}/workers/status`)).json();
  assert.ok(workers.total_workers >= 1);
  checks.push("self-hosted frontend, backend, worker heartbeat and real Redis");
  const validations = await scoped("SELECT a.status, m.status AS match_status, m.is_infra_error FROM rated_matches m JOIN arena_agents a ON a.id = m.agent1_id WHERE m.kind = 'validation' ORDER BY a.id");
  assert.deepEqual(validations.map(row => row.status), ["active", "active", "rejected"]);
  assert.ok(validations.every(row => row.match_status === "finished" && !row.is_infra_error));
  checks.push("Python sandbox self-play accepts valid agents and rejects failing code");
  const ratings = await scoped("SELECT id, status, total_moves, agent1_mu_after, agent2_mu_after, is_infra_error FROM rated_matches WHERE kind = 'rating' ORDER BY id");
  assert.ok(ratings.length >= 1);
  for (const match of ratings) {
    assert.equal(match.status, "finished");
    assert.equal(match.is_infra_error, false);
    assert.ok(match.agent1_mu_after !== null && match.agent2_mu_after !== null);
    const replay = await json(`/api/rating/matches/${match.id}/replay`);
    assert.equal(replay.moves.length, match.total_moves);
    assert.ok(replay.moves.length > 0);
  }
  checks.push("TrueSkill snapshots and full rating replays persisted in Neon");
  const friendly = await scoped("SELECT id, status, total_moves, is_infra_error FROM friendly_matches ORDER BY id");
  assert.ok(friendly.length >= 1);
  for (const match of friendly) {
    assert.equal(match.status, "finished"); assert.equal(match.is_infra_error, false);
    const replay = await json(`/api/friendly/${match.id}/replay`);
    assert.equal(replay.moves.length, match.total_moves); assert.ok(replay.moves.length > 0);
  }
  assert.equal((await scoped("SELECT count(*)::int AS n FROM friendly_challenges WHERE status='pending'"))[0].n,0);
  checks.push("private trial, enqueue, worker and complete replay");
  const before = await scoped("SELECT id, rating, wins, losses, draws FROM arena_agents ORDER BY id");
  for (const payload of [{ event: "finished", rated_match_id: Number(ratings[0].id), execution_token: "e2e-terminal-duplicate", outcome: "draw" }]) {
    const duplicate = await json("/api/rating/match-result", { method: "POST",
      headers: { "Content-Type": "application/json", "X-Worker-Callback-Secret": process.env.WORKER_CALLBACK_SECRET }, body: JSON.stringify(payload) });
    assert.equal(duplicate.duplicate, true);
  }
  assert.deepEqual(await scoped("SELECT id, rating, wins, losses, draws FROM arena_agents ORDER BY id"), before);
  checks.push("duplicate result callback does not alter real persisted ratings");
  for (const route of ["/dashboard", "/arena/submit", "/arena/leaderboard", "/arena/friendly", "/admin/settings",
    `/arena/replay/rating/${ratings[0].id}`, `/arena/replay/friendly/${friendly[0].id}`]) {
    const response = await fetch(`${state.frontend}${route}`, { headers: { Cookie: cookie }, redirect: "manual" });
    assert.equal(response.status, 200, route);
    assert.ok((await response.text()).includes("<!DOCTYPE html>"), route);
  }
  await json("/api/admin/system-status");
  checks.push("authenticated frontend HTML pages and admin system status");
  const pending = (await scoped("SELECT COUNT(*)::int AS count FROM rated_matches WHERE status IN ('scheduled', 'running')"))[0].count;
  assert.equal(pending, 0);
  assert.equal(workers.queue_depth, 0);
  assert.equal((await scoped("SELECT enabled FROM rating_scheduler_state"))[0].enabled, false);
  checks.push("all test jobs completed and scheduler paused");
  const report = { passed: true, verifiedAt: new Date().toISOString(), checks, schema: state.schema, redisPrefix: state.prefix,
    frontend: state.frontend, backend: state.backend, neonRoute, ratings: ratings.map(row => ({ id: row.id, moves: row.total_moves })),
    friendly: friendly.map(row => ({ id: row.id, moves: row.total_moves })), services: state.processes };
  writeFileSync(path.join(state.logDir, "report.json"), JSON.stringify(report, null, 2));
  for (const check of checks) console.log(`PASS ${check}`);
  console.log(`Report: ${path.join(state.logDir, "report.json")}`);
}

try {
  if (process.argv.includes("--network")) {
    const host = new URL(neonConfig.fetchEndpoint(new URL(originalUrl).hostname, 5432)).hostname;
    const addresses = await lookup(host, { all: true });
    for (const address of addresses) {
      const probe = spawnSync("curl", ["-sS", "--max-time", "8", "--resolve", `${host}:443:${address.address}`,
        "-o", "/dev/null", "-w", "%{http_code} %{time_total}", `https://${host}/sql`], { encoding: "utf8" });
      console.log(JSON.stringify({ address: address.address, result: probe.stdout, error: probe.stderr, exitCode: probe.status }));
    }
  }
  else {
    await selectNeonRoute();
    if (process.argv.includes("--stop")) await stop();
    else if (process.argv.includes("--verify")) await verify();
    else if (process.argv.includes("--run")) await run();
    else await inspect();
  }
} catch (error) {
  // Never emit connection strings, request headers or query parameters.
  console.error(`E2E failed: ${error.name}: ${error.message.replaceAll(originalUrl, "[database]")}`);
  for (const detail of [error.cause, error.sourceError, error.sourceError?.cause]) {
    if (detail) console.error("Transport:", detail.code ?? "", String(detail.message ?? detail).replaceAll(originalUrl, "[database]"));
  }
  process.exitCode = 1;
}
