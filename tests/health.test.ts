import { SELF } from "cloudflare:test";
it("GET /api/health → ok", async () => {
  const res = await SELF.fetch("https://x/api/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
