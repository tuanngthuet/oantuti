"use client";

import { useEffect,useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { python } from "@codemirror/lang-python";
import { oneDark } from "@codemirror/theme-one-dark";
import Navbar from "@/components/Navbar";
import { authLink } from '@/lib/auth-navigation';

const CodeMirror = dynamic(() => import("@uiw/react-codemirror"), { ssr: false });

const AGENT_TEMPLATE = `import random

def agent(observation, configuration):
    """
    Agent thi đấu OTTv2 Arena.

    observation:
      - valid_moves: list[{from_col, from_row, to_col, to_row, is_capture}]
      - board: list[81] → None hoặc {player: 1|2, type: "ROCK"|"PAPER"|"SCISSORS"}
      - current_player: 1 hoặc 2
      - piece_counts: {"1": {ROCK:n,...}, "2": {...}}
      - move_count: int

    Trả về: {from_col, from_row, to_col, to_row} hoặc None
    """
    moves = observation.get("valid_moves", [])
    if not moves:
        return None
    move = random.choice(moves)
    return {"from_col": move["from_col"], "from_row": move["from_row"],
            "to_col": move["to_col"], "to_row": move["to_row"]}
`;

type AgentInfo = {
  id: number;
  agent_name: string;
  description: string;
  code: string;
  version: number;
  status: string;
  validation_error: string | null;
  is_active: boolean;
  is_public: boolean;
  elo: number;
  wins: number;
  losses: number;
  draws: number;
  submitted_at: string;
};

const STATUS_BADGE: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700 border-emerald-300",
  pending: "bg-slate-100 text-slate-700 border-slate-300",
  validating: "bg-amber-50 text-amber-700 border-amber-300",
  rejected: "bg-rose-50 text-rose-700 border-rose-300",
};

export default function ArenaSubmitPage() {
  const [agentName, setAgentName] = useState("");
  const [isPublic,setIsPublic]=useState(false);
  const [description, setDescription] = useState("");
  const [code, setCode] = useState(AGENT_TEMPLATE);
  const [validating, setValidating] = useState(false);
  const [validResult, setValidResult] = useState<{ valid: boolean; error?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [scopeName,setScopeName]=useState('Đang kiểm tra tư cách…');
  const [expectedScope,setExpectedScope]=useState<string|null>(null);
  const [personal,setPersonal]=useState<AgentInfo[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [nextVersion, setNextVersion] = useState<number | null>(null);
  const router = useRouter();
  useEffect(()=>{const controller=new AbortController();fetch('/api/team',{signal:controller.signal}).then(async r=>{if(!r.ok)throw new Error();return r.json();}).then(d=>{setScopeName(d.team?`Team: ${d.team.name}`:'Cá nhân');setExpectedScope(d.team?`team:${d.team.id}`:`user:${d.user_id}`);}).catch(()=>{});return()=>controller.abort();},[]);

  async function handleValidate() {
    setValidating(true);
    setValidResult(null);
    try {
      const res = await fetch("/api/arena/agents/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = (await res.json()) as { valid: boolean; error?: string };
      setValidResult(data);
    } catch {
      setValidResult({ valid: false, error: "Không thể kết nối backend." });
    } finally {
      setValidating(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if(!expectedScope){setMessage('Chưa xác định được tư cách nộp bài. Hãy tải lại trang.');return;}
    setMessage("");
    setSuccess(false);
    setSubmitting(true);
    try {
      const res = await fetch("/api/arena/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_name: agentName, description, code,expected_scope:expectedScope,is_public:isPublic }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        agent_id?: number;
        agent_name?: string;
        version?: number;
        error?: string;
      };
      if (!res.ok) {
        if (res.status === 401) {
          router.replace(authLink('login', window.location.pathname + window.location.search));
          return;
        }
        setMessage((data.error ?? "Có lỗi xảy ra.")+(data.agent_id?` Agent đã nộp: #${data.agent_id}. Xem trong lịch sử bên dưới.`:''));
        return;
      }
      setSuccess(true);
      setMessage(`✅ Agent "${data.agent_name}" v${data.version} đã nộp và đang tự kiểm tra.`);
      setAgentName("");
      setDescription("");
      setCode(AGENT_TEMPLATE);
      setValidResult(null);
      setAgents(null);
    } catch {
      setMessage("Không thể kết nối máy chủ.");
    } finally {
      setSubmitting(false);
    }
  }

  async function loadAgents() {
    setLoadingAgents(true);
    try {
      const res = await fetch("/api/arena/agents");
      if (res.status === 401) {
        router.replace(authLink('login', window.location.pathname + window.location.search));
        return;
      }
      const data = (await res.json()) as { agents?: AgentInfo[];team?:{name:string}|null;personal_agents?:AgentInfo[];scope?:string };
      if(data.scope)setExpectedScope(data.scope);
      setScopeName(data.team?`Team: ${data.team.name}`:'Cá nhân');setPersonal(data.personal_agents??[]);
      if (data.agents) {
        setAgents(data.agents);
        const maxVer = Math.max(0, ...data.agents.map((a) => a.version));
        setNextVersion(maxVer + 1);
      }
    } finally {
      setLoadingAgents(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#F5F0ED] text-[#1a1e29]">
      {/* Header đồng bộ */}
      <Navbar />

      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Tiêu đề trang */}
        <div className="mb-4 border-b border-[#ded8d3] pb-4">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-extrabold tracking-tight text-[#1a1e29] sm:text-4xl">
              🤖 Nộp Agent AI
            </h1>
            <span className="rounded-none border border-[#253B80] bg-[#253B80]/10 px-3 py-0.5 text-xs font-bold text-[#253B80]">
              Arena OTTv2
            </span>
          </div>
        </div>

        {/* Box Tư cách nộp bài ở bên dưới tiêu đề trang */}
        <p className="mb-4 border border-[#ded8d3] bg-white p-3 text-sm">
          Tư cách nộp bài: <strong>{scopeName}</strong>. Agent nộp cho team là tài sản chung của đội.
        </p>

        {!!personal.length && (
          <section className="mb-5 border border-amber-200 bg-white p-4">
            <h2 className="font-bold">Agent cá nhân giữ riêng · Tạm ngừng rating</h2>
            <p className="my-2 text-xs text-slate-500">
              Không tính vào team; chỉ bạn được xem code. Tham gia lại khi bạn trở về cá nhân, nếu agent vẫn hợp lệ.
            </p>
            {personal.map((a) => (
              <details key={a.id} className="border-t py-2">
                <summary>
                  {a.agent_name} · v{a.version} · {a.elo} điểm
                </summary>
                <textarea
                  aria-label={`Code cá nhân ${a.agent_name}`}
                  className="mt-2 h-48 w-full border p-2 font-mono text-xs"
                  value={a.code}
                  readOnly
                />
              </details>
            ))}
          </section>
        )}

        {/* Yêu cầu: Khung thẳng chứa cả Quy tắc Agent và Quy tắc OTTv2Arena */}
        <div className="mb-8 rounded-none border border-[#ded8d3] bg-white p-5 shadow-sm space-y-4">
          <div>
            <p className="mb-2 text-sm font-bold text-[#1a1e29]">📖 Quy tắc Agent</p>
            <ul className="space-y-1.5 text-xs text-slate-600">
              <li>• Bàn cờ 9×9. Quân: ✊ ROCK &gt; ✌️ SCISSORS, ✋ PAPER &gt; ✊ ROCK, ✌️ SCISSORS &gt; ✋ PAPER</li>
              <li>• P1 (Xanh) thắng khi chiếm ô i9 hoặc ăn hết 1 loại quân đối thủ. P2 ngược lại (chiếm a1).</li>
              <li>• Hàm <code className="bg-stone-100 px-1 py-0.5 font-mono text-[#253B80] font-bold">def agent(observation, configuration)</code> là bắt buộc.</li>
              <li>• Chạy trong Python sandbox với giới hạn CPU, thời gian thực và bộ nhớ theo cấu hình worker. Code tối đa 65,536 ký tự.</li>
            </ul>
          </div>

          <div className="border-t border-[#ded8d3] pt-3">
            <p className="mb-2 text-sm font-bold text-[#1a1e29]">📖 Quy tắc OTTv2Arena</p>
            <ul className="space-y-1.5 text-xs text-slate-600">
              <li>• Agent luôn tự kiểm tra bằng self-play tối đa 60 nước.</li>
              <li>• Hết giới hạn hoặc hòa lặp thế cờ mà không lỗi vẫn được duyệt.</li>
              <li>• Chỉ agent public hợp lệ mới tham gia rating; agent riêng tư dùng để thách đấu.</li>
            </ul>
          </div>
        </div>

        {/* Form nộp: Khung thẳng */}
        <form onSubmit={handleSubmit} className="rounded-none border border-[#ded8d3] bg-white p-6 shadow-md sm:p-8">
          <div className="space-y-5">
            <label className="block text-sm font-bold text-[#1a1e29]">
              Tên agent
              {nextVersion && <span className="ml-2 font-mono text-xs text-slate-500 font-normal">(sẽ là v{nextVersion})</span>}
              <input
                className="mt-2 w-full rounded-none border border-[#ded8d3] bg-white px-4 py-3 text-sm text-[#1a1e29] outline-none transition placeholder:text-slate-400 focus:border-[#253B80] focus:ring-1 focus:ring-[#253B80]"
                type="text"
                required
                maxLength={100}
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                placeholder="vd: MinimaxBot_v2"
              />
            </label>

            <label className="block text-sm font-bold text-[#1a1e29]">
              Mô tả chiến thuật <span className="text-xs font-normal text-slate-500">(không bắt buộc)</span>
              <input
                className="mt-2 w-full rounded-none border border-[#ded8d3] bg-white px-4 py-3 text-sm text-[#1a1e29] outline-none transition placeholder:text-slate-400 focus:border-[#253B80] focus:ring-1 focus:ring-[#253B80]"
                type="text"
                maxLength={200}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Mô tả thuật toán hoặc ý tưởng..."
              />
            </label>

            <div className="text-sm font-bold text-[#1a1e29]">
              <div className="mb-2 flex items-center justify-between">
                <span>Code agent (Python)</span>
                <span className="font-mono text-xs font-normal text-slate-500">
                  {code.length.toLocaleString()} / 65,536 ký tự
                </span>
              </div>
              <div className="overflow-hidden rounded-none border border-[#ded8d3]">
                <CodeMirror
                  value={code}
                  height="400px"
                  extensions={[python()]}
                  theme={oneDark}
                  onChange={(val) => {
                    setCode(val);
                    setValidResult(null);
                  }}
                  basicSetup={{
                    lineNumbers: true,
                    syntaxHighlighting: true,
                    autocompletion: true,
                    bracketMatching: true,
                    indentOnInput: true,
                  }}
                />
              </div>
            </div>

            {/* Validate button */}
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <button
                type="button"
                onClick={handleValidate}
                disabled={validating || code.trim().length < 10}
                className="cursor-pointer rounded-none border border-[#253B80] bg-white px-4 py-2.5 text-xs font-bold text-[#253B80] transition hover:bg-[#253B80]/5 disabled:opacity-50"
              >
                {validating ? "⏳ Đang kiểm tra..." : "🔍 Kiểm tra tính hợp lệ"}
              </button>
              {validResult && (
                <div
                  className={`rounded-none border px-3.5 py-2 text-xs font-bold ${
                    validResult.valid
                      ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                      : "border-rose-300 bg-rose-50 text-rose-700"
                  }`}
                >
                  {validResult.valid ? "✅ Agent hợp lệ và sẵn sàng nộp" : `❌ ${validResult.error}`}
                </div>
              )}
            </div>

            <label className="block border bg-white p-4 text-sm"><input type="checkbox" checked={isPublic} onChange={e=>setIsPublic(e.target.checked)}/> Public agent để tham gia rating
              <span className="mt-2 block text-slate-500">Mặc định riêng tư. Public không công khai mã nguồn và không thể chuyển lại riêng tư. Agent riêng tư hợp lệ có thể public sau trong lịch sử.</span></label>
            {message && (
              <p
                role="alert"
                className={`rounded-none border px-4 py-3 text-sm font-bold ${
                  success
                    ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                    : "border-rose-300 bg-rose-50 text-rose-800"
                }`}
              >
                {message}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting || code.trim().length === 0}
              className="w-full cursor-pointer rounded-none bg-[#253B80] px-4 py-3.5 font-bold text-white transition hover:bg-[#1d2e66] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Đang nộp agent..." : "🚀 Nộp agent vào Arena"}
            </button>
          </div>
        </form>

        {/* Lịch sử agent: Khung thẳng */}
        <div className="mt-12">
          <div className="mb-4 flex items-center justify-between border-b border-[#ded8d3] pb-3">
            <h2 className="text-xl font-bold text-[#1a1e29]">Lịch sử agent của tôi</h2>
            <button
              onClick={loadAgents}
              disabled={loadingAgents}
              className="cursor-pointer rounded-none border border-[#ded8d3] bg-white px-4 py-2 text-xs font-bold text-slate-700 transition hover:border-[#253B80] disabled:opacity-50"
            >
              {loadingAgents ? "Đang tải..." : "Tải lịch sử"}
            </button>
          </div>

          {agents === null && !loadingAgents && (
            <p className="text-sm text-slate-500">Nhấn &quot;Tải lịch sử&quot; để xem các phiên bản agent đã nộp.</p>
          )}
          {agents !== null && agents.length === 0 && (
            <p className="text-sm text-slate-500">Bạn chưa nộp agent nào.</p>
          )}
          {agents !== null && agents.length > 0 && (
            <div className="space-y-3">
              {agents.map((a) => (
                <div
                  key={a.id}
                  className={`rounded-none border p-4 shadow-sm bg-white ${
                    a.is_active ? "border-[#253B80]" : "border-[#ded8d3]"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/arena/agents/${a.id}`}
                          className="font-bold text-base text-[#253B80] hover:underline"
                        >
                          {a.agent_name}
                        </Link>
                        <span className="font-mono text-xs text-slate-500">v{a.version}</span>
                        <span className="border px-2 py-1 text-xs">{a.is_public?'Public · rating':'Riêng tư · thách đấu'}</span>
                        {!a.is_public&&a.status==='active'&&a.is_active&&<button className="border px-2 py-1 text-xs text-blue-700" onClick={async()=>{
                          if(!window.confirm('Public agent để tham gia rating? Không thể chuyển lại riêng tư; mã nguồn vẫn được giữ kín.'))return;
                          try{const r=await fetch(`/api/arena/agents/${a.id}/publish`,{method:'POST'});const d=await r.json();if(!r.ok)throw Error(d.error);await loadAgents();}catch(e){setMessage(e instanceof Error?e.message:'Không thể public agent.');}
                        }}>Public để rating</button>}
                        <span
                          className={`rounded-none border px-2 py-0.5 text-xs font-bold ${
                            STATUS_BADGE[a.status] ?? "bg-slate-100 text-slate-700 border-slate-300"
                          }`}
                        >
                          {a.status}
                        </span>
                        {a.is_active && (
                          <span className="rounded-none border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-bold text-emerald-700">
                            Active
                          </span>
                        )}
                      </div>
                      {a.validation_error && (
                        <p className="mt-1 text-xs font-bold text-rose-700">❌ {a.validation_error}</p>
                      )}
                      {a.description && <p className="mt-1 text-xs text-slate-600">{a.description}</p>}
                      <div className="mt-2 flex flex-wrap gap-4 text-xs font-mono text-slate-600">
                        <span>
                          Rating: <span className="font-bold text-[#253B80]">{a.elo}</span>
                        </span>
                        <span className="font-bold text-emerald-700">W:{a.wins}</span>
                        <span className="font-bold text-rose-700">L:{a.losses}</span>
                        <span className="text-slate-700">D:{a.draws}</span>
                        <span className="font-sans text-slate-500">
                          {new Date(a.submitted_at).toLocaleDateString("vi-VN")}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={() => setExpandedId(expandedId === a.id ? null : a.id)}
                      className="cursor-pointer shrink-0 rounded-none border border-[#ded8d3] bg-white px-3 py-1.5 text-xs font-bold text-slate-700 transition hover:border-[#253B80]"
                    >
                      {expandedId === a.id ? "Ẩn code" : "Xem code"}
                    </button>
                  </div>
                  {expandedId === a.id && (
                    <div className="mt-4 overflow-hidden rounded-none border border-[#ded8d3]">
                      <CodeMirror
                        value={a.code ?? ""}
                        extensions={[python()]}
                        theme={oneDark}
                        editable={false}
                        basicSetup={{ lineNumbers: true, syntaxHighlighting: true }}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
