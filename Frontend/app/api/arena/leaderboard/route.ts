import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { buildStandings, positivePage, RANKING_MINIMUM_GAMES } from '@/lib/leaderboard';
import { publicAgents } from '@/lib/leaderboard-data';
import { sql } from '@/lib/db';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const page = positivePage(params.get('page'));
  const tab = params.get('tab') === 'calibrating' ? 'calibrating' : 'rankings';
  const search = (params.get('search') ?? '').slice(0, 100).trim().toLocaleLowerCase();
  try {
    const [agents, session] = await Promise.all([publicAgents(), getSession()]);
    const standings = buildStandings(agents);
    const matchingParticipants = new Set(agents.filter(a => a.agent_name.toLocaleLowerCase().includes(search) || a.username.toLocaleLowerCase().includes(search)
      || a.members?.some(m=>m.username.toLocaleLowerCase().includes(search))).map(a => a.team_id?`team:${a.team_id}`:`user:${a.user_id}`));
    const ownTeam=session?(await sql`SELECT current_team(${session.id}) AS id`)[0]?.id:null;
    const ownKey=ownTeam?`team:${ownTeam}`:`user:${session?.id}`;
    const mine = standings.find(e => e.participant_key===ownKey);
    const filtered = standings.filter(e => e.eligible === (tab === 'rankings'))
      .filter(e => !search || e.username.toLocaleLowerCase().includes(search)
        || matchingParticipants.has(e.participant_key));
    return NextResponse.json({ leaderboard: filtered.slice((page - 1) * 20, page * 20),
      page, limit: 20, total: filtered.length, tab, authenticated: !!session, minimum_games: RANKING_MINIMUM_GAMES,
      me: mine ? { ...mine, page: Math.floor(standings.filter(e => e.eligible === mine.eligible).findIndex(e => e.participant_key===mine.participant_key) / 20) + 1 } : null,
      counts: { rankings: standings.filter(e => e.eligible).length, calibrating: standings.filter(e => !e.eligible).length } });
  } catch (error) {
    console.error('Leaderboard failed', error);
    return NextResponse.json({ error: 'Không thể tải bảng xếp hạng.' }, { status: 500 });
  }
}
