import {readFileSync} from 'node:fs';

const searchTemplate = readFileSync(new URL('./demo-search-agent.py', import.meta.url), 'utf8');
const greedyTemplate = readFileSync(new URL('../../backend/agents/greedy_agent.py', import.meta.url), 'utf8');
export const strategies = ['First Move', 'Random Walker', 'Greedy Hunter', 'Tactical Guard', 'Alpha Beta', 'Deep Search'];

export function agentCode(level, seed) {
  if (level === 0) return `SEED = ${seed}\ndef agent(observation, configuration):\n    moves = observation.get('valid_moves', [])\n    return moves[SEED % len(moves)] if moves else None\n`;
  if (level === 1) return `import random\nSEED = ${seed}\ndef agent(observation, configuration):\n    moves = observation.get('valid_moves', [])\n    rng = random.Random(SEED + observation.get('move_count', 0) * 97 + sum((i + 1) * int(p is not None) for i, p in enumerate(observation.get('board', []))))\n    return rng.choice(moves) if moves else None\n`;
  if (level === 2) return `SEED = ${seed}\n` + greedyTemplate.replace('s += 120', 's += 100 + SEED % 41').replace('s += random.random() * 5', 's += (fc * 17 + fr * 13 + tc * 7 + tr * SEED) % 19 / 10');
  return searchTemplate.replace('SEED = 1', `SEED = ${seed}`).replace('LEVEL = 3', `LEVEL = ${level}`);
}

export function demoFixtures(prefix = 'demo') {
  if (!/^[a-z][a-z0-9_]{1,19}$/.test(prefix)) throw Error('Prefix must contain 2–20 lowercase letters/digits/underscores and start with a letter');
  const users = Array.from({length:30}, (_, i) => ({username:`${prefix}${String(i + 1).padStart(2,'0')}`}));
  let offset = 0;
  const teams = [1,2,2,3,3].map((size, i) => {
    const members = users.slice(offset, offset + size).map(u => u.username);
    offset += size;
    return {name:`${prefix} ${['Solo Lab','Binary Bots','Twin Tactics','Trinity AI','Deep Thinkers'][i]}`, members, recruiting:size < 3};
  });
  const agents = users.flatMap((user, i) => Array.from({length:1 + i % 4}, (_, j) => {
    const level = Math.min(5, i % 3 + j), seed = (i + 1) * 101 + j;
    return {username:user.username, agent_name:`${user.username} ${strategies[level]} v${j + 1}`,
      description:`Demo fixture: ${strategies[level]}; variant ${seed}. Real validation required; no fabricated rating.`,
      code:agentCode(level,seed), level, is_public:j === 0 || (i + j) % 3 !== 0};
  }));
  return {users,teams,agents};
}
