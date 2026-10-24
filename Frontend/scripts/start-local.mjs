import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync, readFileSync, readlinkSync, writeFileSync, mkdirSync, openSync, closeSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(frontend, "..");
require("@next/env").loadEnvConfig(frontend);
const { neon } = require("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const readEnv = file => Object.fromEntries(readFileSync(file, "utf8").split(/\r?\n/).flatMap(line => {
  const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  return match ? [[match[1], match[2].replace(/^(["'])(.*)\1$/, "$2")]] : [];
}));
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OTT_E2E_")));
const logDir = path.join(root, "logs");
const statePath = path.join(logDir, "local-stack.json");
const urls = { frontend: "http://127.0.0.1:3000", backend: "http://127.0.0.1:8000" };

async function waitFor(label, fn) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { const result = await fn(); if (result) return result; } catch (error) { lastError = error; }
    await sleep(1000);
  }
  throw new Error(`${label} did not become ready${lastError ? ` (${lastError.name})` : ""}`);
}

async function check(state) {
  for (const service of state.processes) {
    const env = Object.fromEntries(readFileSync(`/proc/${service.pid}/environ`, "utf8").split("\0").map(entry => {
      const split = entry.indexOf("="); return [entry.slice(0, split), entry.slice(split + 1)];
    }));
    assert.equal(env.DATABASE_SCHEMA ?? "", "");
    assert.equal(env.REDIS_KEY_PREFIX ?? "", "");
    assert.equal(env.OTT_E2E_RUN_ID, undefined);
    if (service.name === "frontend") assert.equal(env.DATABASE_URL, process.env.DATABASE_URL);
  }
  const db = await waitFor("default database", async () => (await sql`SELECT current_database() AS database, current_schema() AS schema`)[0]);
  assert.equal(db.schema, "public");
  const health = await waitFor("backend Redis health", async () => {
    const r = await fetch(`${urls.backend}/health`, { signal: AbortSignal.timeout(5000) });
    const body = await r.json(); return r.ok && body.redis_connected && body;
  });
  await waitFor("frontend database query", async () => {
    const r = await fetch(`${urls.frontend}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: `local_healthcheck_${Date.now()}`, password: "healthcheck-no-account" }), signal: AbortSignal.timeout(15000) });
    return r.status === 401;
  });
  const worker = state.processes.find(service => service.name === "worker");
  const workers = await waitFor("normal worker heartbeat", async () => {
    const r = await fetch(`${urls.backend}/workers/status`, { signal: AbortSignal.timeout(5000) });
    const body = await r.json();
    return body.workers?.some(item => item.worker_id === worker.workerId) && body;
  });
  console.log(JSON.stringify({ database: db.database, schema: db.schema, redisKeyPrefix: "", redisConnected: health.redis_connected,
    frontend: urls.frontend, backend: urls.backend, workerOnline: true, workerId: worker.workerId,
    queueDepth: workers.queue_depth, totalWorkers: workers.total_workers, processes: state.processes }, null, 2));
}

try {
  assert.ok(!process.argv.includes("--force") || process.argv.includes("--stop"), "--force requires --stop");
  if (process.argv.includes("--stop")) {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    // Validate every target before touching any process. Never stop an E2E stack.
    const live = state.processes.filter(service => existsSync(`/proc/${service.pid}/cmdline`));
    for (const service of live) {
      const env = readFileSync(`/proc/${service.pid}/environ`, "utf8").split("\0");
      assert.ok(!env.some(value => value.startsWith("OTT_E2E_RUN_ID=")));
      assert.ok(env.includes("DATABASE_SCHEMA="));
      assert.ok(env.includes("REDIS_KEY_PREFIX="));
      const cwd = readlinkSync(`/proc/${service.pid}/cwd`);
      assert.equal(cwd, service.name === "frontend" ? frontend : path.join(root, service.name === "worker" ? "worker_image" : service.name));
      const command = readFileSync(`/proc/${service.pid}/cmdline`, "utf8");
      assert.ok(command.includes({ worker: "main.py", backend: "uvicorn", frontend: "next" }[service.name]));
    }
    if (!process.argv.includes("--force")) {
      const status = await (await fetch(`${urls.backend}/workers/status`)).json();
      const worker = state.processes.find(service => service.name === "worker");
      const snapshot = status.workers?.find(item => item.worker_id === worker.workerId);
      assert.ok(snapshot ? snapshot.active_jobs === 0 : !live.some(service => service.name === "worker"),
        "Wait for local worker jobs to finish before stopping services, or explicitly pass --stop --force.");
    }
    for (const name of ["worker", "frontend", "backend"]) {
      const service = live.find(item => item.name === name);
      if (!service) continue;
      process.kill(service.pid, "SIGTERM");
      await waitFor(`${name} shutdown`, async () => {
        try {
          const stat = readFileSync(`/proc/${service.pid}/stat`, "utf8");
          return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
        } catch (error) { if (error.code === "ENOENT") return true; throw error; }
      });
      console.log(`Stopped owned local ${name} PID ${service.pid}`);
    }
    state.stoppedAt = new Date().toISOString();
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  } else if (process.argv.includes("--check")) await check(JSON.parse(readFileSync(statePath, "utf8")));
  else {
    for (const url of Object.values(urls)) {
      try { await fetch(url, { signal: AbortSignal.timeout(1000) }); throw new Error(`Port in use: ${url}`); }
      catch (error) { if (error.message.startsWith("Port in use")) throw error; }
    }
    mkdirSync(logDir, { recursive: true });
    const state = { startedAt: new Date().toISOString(), ...urls, schema: "public", redisKeyPrefix: "", processes: [] };
    function launch(name, command, args, cwd, env, workerId) {
      const fd = openSync(path.join(logDir, `${name}.log`), "a", 0o600);
      const child = spawn(command, args, { cwd, detached: true, stdio: ["ignore", fd, fd],
        env: { ...baseEnv, ...env, DATABASE_SCHEMA: "", REDIS_KEY_PREFIX: "" } });
      child.on("error", error => console.error(`${name}: ${error.message}`));
      child.unref(); closeSync(fd);
      state.processes.push({ name, pid: child.pid, ...(workerId ? { workerId } : {}) });
      writeFileSync(path.join(logDir, `${name}.pid`), `${child.pid}\n`);
      writeFileSync(statePath, JSON.stringify(state, null, 2));
    }
    launch("backend", "python3", ["-B", "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000"],
      path.join(root, "backend"), readEnv(path.join(root, "backend/.env")));
    launch("frontend", "node", ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3000"], frontend,
      { BACKEND_URL: urls.backend, NEXT_PUBLIC_BACKEND_URL: urls.backend });
    await waitFor("backend", async () => (await fetch(`${urls.backend}/health`)).ok);
    const workerEnv = readEnv(path.join(root, "worker_image/.env"));
    const identity = spawnSync('python3', ['-B', '-c', 'import json, main, supervisor; print(json.dumps(supervisor.identity()))'], {
      cwd: path.join(root, 'worker_image'), env: { ...baseEnv, ...workerEnv }, encoding: 'utf8',
    });
    if (identity.status !== 0) throw new Error('Cannot determine worker identity');
    const workerId = JSON.parse(identity.stdout).worker_id;
    launch("worker", "python3", ["-B", "main.py"], path.join(root, "worker_image"), {
      ...workerEnv, BACKEND_URL: urls.backend, FRONTEND_URL: urls.frontend, PYTHONUNBUFFERED: "1",
    }, workerId);
    await check(state);
  }
} catch (error) {
  console.error(`Local stack: ${error.name}: ${error.message.replaceAll(process.env.DATABASE_URL, "[database]")}`);
  process.exitCode = 1;
}
