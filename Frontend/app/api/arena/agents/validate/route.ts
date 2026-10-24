import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import {sql} from '@/lib/db';
import {agentCodeIdentity} from '@/lib/agent-code';

export const runtime = "nodejs";

/**
 * POST /api/arena/agents/validate
 *
 * Quick client-side validation: kiểm tra code có hàm agent() không.
 * Agent sẽ được validate thực sự qua self-play khi submit (rated_matches validation).
 * Tournament backend validate-agent đã bị loại bỏ.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Chưa đăng nhập." }, { status: 401 });

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ." }, { status: 400 });
  }
  if(!body||typeof body!=='object')return NextResponse.json({error:'Dữ liệu không hợp lệ.'},{status:400});
  const { code } = body as Record<string, unknown>;
  if (typeof code !== "string" || code.trim().length < 10)
    return NextResponse.json({ error: "Code quá ngắn." }, { status: 400 });

  // Kiểm tra cú pháp cơ bản
  if (!code.includes("def agent(")) {
    return NextResponse.json({
      valid: false,
      error: "Code phải có hàm `def agent(observation, configuration):`",
    });
  }
  if (code.includes("import os") || code.includes("import sys") || code.includes("__import__")) {
    return NextResponse.json({
      valid: false,
      error: "Code không được dùng os, sys hoặc __import__.",
    });
  }
  if (code.length > 65536) {
    return NextResponse.json({ valid: false, error: "Code quá dài (tối đa 64KB)." });
  }

  try{
    const identity=agentCodeIdentity(code);
    const duplicate=await sql`SELECT id FROM arena_agents WHERE code_fingerprint=${identity.fingerprint} AND normalized_code=${identity.normalized}
      AND ((current_team(${session.id}) IS NULL AND team_id IS NULL AND user_id=${session.id}) OR team_id=current_team(${session.id}))
      ORDER BY (status='active') DESC,id LIMIT 1`;
    if(duplicate.length)return NextResponse.json({valid:false,code:'DUPLICATE_CODE',agent_id:duplicate[0].id,error:`Code trùng với agent #${duplicate[0].id} trong cá nhân/team này.`});
    return NextResponse.json({valid:true,message:'Kiểm tra sơ bộ đạt. Self-play vẫn được thực hiện sau khi nộp.'});
  }catch{return NextResponse.json({error:'Không kiểm tra được code trùng. Hãy thử lại.'},{status:503});}
}
