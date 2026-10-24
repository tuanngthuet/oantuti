import {NextResponse} from 'next/server';
import {finalsQuery} from '@/lib/finals-db';
import {publicAgents} from '@/lib/leaderboard-data';
import {buildStandings} from '@/lib/leaderboard';
export const dynamic='force-dynamic';
export async function GET(){
 try{
  const preview=buildStandings(await publicAgents()).filter(e=>e.eligible).slice(0,16).map(e=>({seed:e.rank,name:e.username,agent_name:e.agent.agent_name,participant_key:e.participant_key,rating:e.agent.elo}));
  let editions;try{editions=await finalsQuery('SELECT id,name,status,created_at,finished_at FROM editions ORDER BY id DESC');}catch(error){if(!['42P01','3F000'].includes((error as {code?:string}).code??''))throw error;return NextResponse.json({editions:[],preview,available:false});}
  return NextResponse.json({editions,preview,available:true});
 }catch{return NextResponse.json({error:'Không thể tải chung kết.'},{status:503});}
}
