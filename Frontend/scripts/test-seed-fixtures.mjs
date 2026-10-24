// Legal, deterministic move selectors with distinct tie-breaking and distance metrics.
export function seedUsers(passwordHashes) {
  if (passwordHashes.length !== 10) throw new Error('Exactly ten password hashes required');
  return passwordHashes.map((password_hash, index) => ({ ordinal: index + 1,
    username: index === 0 ? 'admin' : `test${String(index).padStart(2, '0')}`,
    password_hash, is_admin: index === 0 }));
}

export function seedAgents(users) {
  return users.flatMap((user, index) => [1, 2].map(version => {
    const seed = index * 2 + version;
    const code = `# Fresh test fixture ${seed}: ${version === 1 ? 'diagonal advance' : 'balanced advance'}
SEED = ${seed}
def agent(observation, configuration):
    moves = observation['valid_moves']
    if not moves:
        return None
    target = (8, 8) if observation['current_player'] == 1 else (0, 0)
    def rank(move):
        dx = abs(move['to_col'] - target[0])
        dy = abs(move['to_row'] - target[1])
        distance = ${version === 1 ? 'max(dx, dy)' : 'dx + dy'}
        tie = (move['from_col'] * 17 + move['from_row'] * 13 + move['to_col'] * 7 + move['to_row'] * 3 + SEED * (move['to_col'] + 2 * move['to_row'])) % 97
        return (distance, -int(move.get('is_capture', False)), tie)
    return min(moves, key=rank)
`;
    return { username: user.username, agent_name: `${user.username} ${version === 1 ? 'Diagonal' : 'Balanced'} v${version}`,
      version, description: `Fresh test bot ${seed}; legal-move selection, deterministic tie-breaking.`, code };
  }));
}
