import { beforeEach, describe, expect, it, vi } from "vitest";
const { session, backend } = vi.hoisted(() => ({ session: vi.fn(), backend: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSession: session }));
vi.mock("@/lib/backend", () => ({ backendFetch: backend }));
import { GET } from "@/app/api/admin/workers/route";
import { PATCH } from "@/app/api/admin/workers/[id]/route";
const params = Promise.resolve({ id: "a".repeat(32) });
const request = (body: unknown) => new Request("http://localhost/api/admin/workers/id", { method: "PATCH", body: JSON.stringify(body) });
beforeEach(() => {
  vi.clearAllMocks();
  session.mockResolvedValue({ id: 7, username: "admin", is_admin: true });
  backend.mockResolvedValue({ ok: true, status: 200, data: { workers: [], queue_depth: 0 } });
});
describe("worker admin API", () => {
  it.each([null, { id: 1, username: "user", is_admin: false }])("rejects non-admin access", async user => {
    session.mockResolvedValue(user);
    expect((await GET()).status).toBe(403);
    expect((await PATCH(request({ revision: 1, action: "start" }), { params })).status).toBe(403);
    expect(backend).not.toHaveBeenCalled();
  });
  it("lists workers without cached responses", async () => {
    expect((await GET()).status).toBe(200);
    expect(backend).toHaveBeenCalledWith("/workers/admin", expect.objectContaining({ cache: "no-store" }));
  });
  it.each([null, [], {}, { revision: 1, max_concurrent: 0 }, { revision: 1, max_concurrent: 65 },
    { revision: 1, max_concurrent: true }, { revision: 1, max_concurrent: 1.5 },
    { revision: 1, action: "kill-host" }, { revision: 1, action: "start", updated_by: "spoofed" }])("rejects malformed controls: %j", async body => {
    expect((await PATCH(request(body), { params })).status).toBe(400);
    expect(backend).not.toHaveBeenCalled();
  });
  it("attributes configuration changes to the signed-in admin", async () => {
    expect((await PATCH(request({ revision: 3, max_concurrent: 2 }), { params })).status).toBe(200);
    expect(JSON.parse(backend.mock.calls[0][1].body)).toEqual({ revision: 3, max_concurrent: 2, updated_by: "7:admin" });
  });
  it("returns a readable conflict without claiming success", async () => {
    backend.mockResolvedValue({ ok: false, status: 409, error: "conflict" });
    const response = await PATCH(request({ revision: 1, action: "stop", stop_mode: "immediate" }), { params });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("thay đổi");
  });
  it("reports backend disconnection", async () => {
    backend.mockResolvedValue({ ok: false, status: 0, error: "offline", isOffline: true });
    expect((await GET()).status).toBe(503);
  });
});
