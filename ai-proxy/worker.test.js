import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import worker from "./src/index.js";

const origin = "https://c.zhixing.us.ci";
const env = {
  AI_API_KEY: "test-key",
  AI_BASE_URL: "https://api.example.test/v1",
  AI_MODEL: "vision-model",
  ALLOWED_ORIGINS: origin
};
function req(body, ip = "198.51.100.10", requestOrigin = origin) {
  return new Request("https://worker.example.test/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": requestOrigin,
      "CF-Connecting-IP": ip
    },
    body: JSON.stringify(body)
  });
}
const userMessage = { role: "user", content: "解方程 x+2=5" };

test("health endpoint does not expose secret values", async () => {
  const response = await worker.fetch(new Request("https://worker.example.test/health", { headers: { Origin: origin } }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, configured: true, model: "vision-model" });
});

test("rejects unapproved origins", async () => {
  const response = await worker.fetch(req({ mode: "solve", messages: [userMessage] }, "198.51.100.11", "https://evil.example"), env);
  assert.equal(response.status, 403);
});

test("reports missing backend configuration without calling provider", async () => {
  const response = await worker.fetch(req({ mode: "solve", messages: [userMessage] }, "198.51.100.12"), { ALLOWED_ORIGINS: origin });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /尚未配置/);
});

test("rejects malformed image data", async () => {
  const response = await worker.fetch(req({
    mode: "solve",
    messages: [{ role: "user", content: [
      { type: "text", text: "识别图片" },
      { type: "image_url", image_url: { url: "https://example.test/image.png" } }
    ] }]
  }, "198.51.100.13"), env);
  assert.equal(response.status, 400);
});

test("forwards a valid request to the OpenAI-compatible endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let calledUrl = "";
  let sentBody;
  globalThis.fetch = async (url, init) => {
    calledUrl = String(url);
    assert.equal(init.headers.Authorization, "Bearer test-key");
    sentBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      model: "vision-model",
      choices: [{ message: { content: "由 x+2=5 得 x=3。" } }],
      usage: { total_tokens: 20 }
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const response = await worker.fetch(req({ mode: "solve", messages: [userMessage] }, "198.51.100.14"), env);
    assert.equal(response.status, 200);
    assert.equal(calledUrl, "https://api.example.test/v1/chat/completions");
    assert.equal(sentBody.model, "vision-model");
    assert.equal(sentBody.messages[0].role, "system");
    assert.match((await response.json()).answer, /x=3/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AI frontend inline JavaScript parses without syntax errors", () => {
  const html = readFileSync(new URL("../ai.html", import.meta.url), "utf8");
  const start = html.lastIndexOf("<script>");
  const end = html.lastIndexOf("</script>");
  assert.ok(start >= 0 && end > start, "inline script must exist");
  assert.doesNotThrow(() => new Script(html.slice(start + 8, end)));
});
