export const RANKING_MINIMUM_GAMES = 10;
export type RankedAgent = {
  id: number; user_id: number; username: string; agent_name: string;
  version: number; status: string; is_active: boolean; elo: number;
  wins: number; losses: number; draws: number; valid_games: number;
  submitted_at: string; last_finished_at: string | null;
  team_id?: number | null; team_name?: string; recruiting?: boolean; scope_active?: boolean;
  members?: {id:number;username:string}[];
};
export function compareAgents(a: RankedAgent, b: RankedAgent) {
  return Number(b.elo) - Number(a.elo) || Number(b.wins) - Number(a.wins)
    || new Date(a.submitted_at).getTime() - new Date(b.submitted_at).getTime() || Number(a.id) - Number(b.id);
}
export function buildStandings(agents: RankedAgent[]) {
  const groups = new Map<string, RankedAgent[]>();
  const approvedCounts = new Map<string, number>();
  for (const agent of agents) {
    const id=agent.team_id?`team:${agent.team_id}`:`user:${agent.user_id}`;
    if (agent.status === 'active') approvedCounts.set(id, (approvedCounts.get(id) ?? 0) + 1);
    if (agent.status !== 'active' || !agent.is_active || agent.scope_active===false) continue;
    groups.set(id, [...(groups.get(id) ?? []), agent]);
  }
  const entries = [...groups.entries()].map(([participant_key, list]) => {
    const eligible = list.filter(a => Number(a.valid_games) >= RANKING_MINIMUM_GAMES).sort(compareAgents);
    const agent = eligible[0] ?? [...list].sort(compareAgents)[0];
    return { user_id:Number(agent.user_id), participant_key,team_id:agent.team_id??null,kind:agent.team_id?'team':'individual',
      username:agent.team_name??agent.username,members:agent.members??[],recruiting:agent.recruiting??false,agent,eligible:eligible.length>0,active_agents:list.length,
      approved_agents:approvedCounts.get(participant_key)??0,rank:null as number|null };
  }).sort((a, b) => compareAgents(a.agent, b.agent));
  let rank = 0;
  return entries.map(entry => ({ ...entry, rank: entry.eligible ? ++rank : null }));
}
export function positivePage(value: string | null) {
  const page = Number(value ?? 1);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}
export function matchResult(match: { status: string; is_infra_error: boolean; outcome: string | null; agent1_id: number }, agentId: number) {
  if (match.is_infra_error || match.status === 'error') return 'error';
  if (match.status !== 'finished') return match.status;
  if (match.outcome === 'draw') return 'draw';
  if (!match.outcome) return 'unknown';
  return (match.outcome === 'agent1') === (Number(match.agent1_id) === agentId) ? 'win' : 'loss';
}
