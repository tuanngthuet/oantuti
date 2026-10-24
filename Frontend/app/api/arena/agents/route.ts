import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { getSession } from "@/lib/session";
import { dispatchNextRatingTask } from "@/lib/rating-scheduler";
import {teamError} from '@/lib/teams';
import {agentCodeIdentity} from '@/lib/agent-code';

export const runtime = "nodejs";

// POST: nộp agent mới
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Chưa đăng nhập." }, { status: 401 });

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ." }, { status: 400 });
  }
  if (!body || typeof body !== "object")
    return NextResponse.json({ error: "Dữ liệu không hợp lệ." }, { status: 400 });

  const { agent_name, description, code, expected_scope, is_public = false } = body as Record<string, unknown>;
  if(typeof is_public!=='boolean') return NextResponse.json({error:'Lựa chọn public không hợp lệ.'},{status:400});
  if(expected_scope!==undefined && (typeof expected_scope!=='string'||!/^(user|team):[1-9][0-9]*$/.test(expected_scope)))
    return NextResponse.json({error:'Tư cách nộp bài không hợp lệ.'},{status:400});

  if (typeof agent_name !== "string" || agent_name.trim().length === 0)
    return NextResponse.json({ error: "Vui lòng đặt tên agent." }, { status: 400 });
  if (agent_name.trim().length > 100)
    return NextResponse.json({ error: "Tên tối đa 100 ký tự." }, { status: 400 });
  if (typeof code !== "string" || code.trim().length === 0)
    return NextResponse.json({ error: "Vui lòng nhập code agent." }, { status: 400 });
  if (code.length > 65536)
    return NextResponse.json({ error: "Code quá dài (tối đa 65536 ký tự)." }, { status: 400 });
  if (!code.includes("def agent("))
    return NextResponse.json({ error: "Code phải có hàm `def agent(observation, configuration):`." }, { status: 400 });

  const desc = typeof description === "string" ? description.trim().slice(0, 500) : "";

  try {
    const identity=agentCodeIdentity(code);
    const submitted = await sql`SELECT submit_private_agent(${session.id},${agent_name.trim()},${desc},${code},${expected_scope===undefined?null:String(expected_scope)},${is_public},${identity.normalized},${identity.fingerprint}) AS agent`;
    const agent = submitted[0].agent as { id: number; agent_name: string; version: number; submitted_at: string; duplicate?:boolean; agent_id?:number };
    if(agent.duplicate) return NextResponse.json({error:'Code trùng với agent đã nộp trong cá nhân/team này.',code:'DUPLICATE_CODE',agent_id:agent.agent_id},{status:409});
    // The task remains safely scheduled if the worker/backend is temporarily down.
    await dispatchNextRatingTask().catch((error) => console.error("Could not dispatch validation:", error));
    return NextResponse.json({
      ok: true, agent_id: agent.id, agent_name: agent.agent_name, version: agent.version,
      submitted_at: agent.submitted_at, status: "validating", is_public,
    });
  } catch (error) {
    return teamError(error);
  }
}

// GET: shared current-scope code; retained personal code is visible only to its author.
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Chưa đăng nhập." }, { status: 401 });
  try {
    const agents = await sql`
      SELECT a.id,a.agent_name,a.description,a.code,a.version,a.status,a.validation_error,
        a.is_active,a.is_public,a.wins,a.losses,a.draws,a.error_matches,a.rating AS elo,a.submitted_at,a.team_id,u.username AS submitted_by
      FROM arena_agents a JOIN users u ON u.id=a.user_id
      WHERE (a.team_id=current_team(${session.id})) OR (a.team_id IS NULL AND a.user_id=${session.id} AND current_team(${session.id}) IS NULL)
      ORDER BY a.version DESC,a.id DESC
    `;
    const teams=await sql`SELECT id,name FROM teams WHERE id=current_team(${session.id})`;
    const personal=teams.length?await sql`SELECT id,agent_name,code,version,status,rating AS elo,submitted_at
      FROM arena_agents WHERE user_id=${session.id} AND team_id IS NULL ORDER BY version DESC,id DESC`:[];
    return NextResponse.json({agents,team:teams[0]??null,personal_agents:personal,scope:teams.length?`team:${teams[0].id}`:`user:${session.id}`});
  } catch(error) {
    console.error('Fetch scope agents failed',error);
    return NextResponse.json({error:'Không thể tải danh sách agent.'},{status:500});
  }
}
