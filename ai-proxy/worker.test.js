import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import worker, { AdminSettingsStore } from "./src/index.js";

const origin = "https://c.zhixing.us.ci";
function createStoreBinding() {
  const values = new Map();
  let alarm = null;
  const storage = {
    get: async key => values.get(key),
    put: async (key, value) => values.set(key, structuredClone(value)),
    delete: async key => values.delete(key),
    list: async ({ prefix = "" } = {}) => new Map([...values].filter(([key]) => key.startsWith(prefix))),
    transaction: async callback => callback(storage),
    getAlarm: async () => alarm,
    setAlarm: async value => { alarm = value; }
  };
  const store = new AdminSettingsStore({ storage }, {});
  const stub = { fetch: (input, init) => store.fetch(input instanceof Request ? input : new Request(input, init)) };
  return { idFromName: () => "worker-tests", get: () => stub };
}
function testEnv(overrides = {}) {
  return {
    AI_API_KEY: "test-key",
    AI_BASE_URL: "https://api.example.com/v1",
    AI_MODEL: "vision-model",
    ALLOWED_ORIGINS: origin,
    ...overrides,
    ADMIN_STORE: overrides.ADMIN_STORE || createStoreBinding()
  };
}
const env = testEnv();
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

test("admin login requires an explicitly configured password", async () => {
  const response = await worker.fetch(new Request("https://worker.example.test/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": origin, "CF-Connecting-IP": "198.51.100.70" },
    body: JSON.stringify({ password: "guess" })
  }), testEnv({ ALLOWED_ORIGINS: origin }));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /ADMIN_PASSWORD/);
});

test("admin login issues a signed, expiring session token", async () => {
  const response = await worker.fetch(new Request("https://worker.example.test/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": origin, "CF-Connecting-IP": "198.51.100.71" },
    body: JSON.stringify({ password: "test-admin-password" })
  }), { ...env, ADMIN_PASSWORD: "test-admin-password" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(body.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.ok(body.expiresIn > 0);
});

test("admin settings require a valid bearer session", async () => {
  const response = await worker.fetch(new Request("https://worker.example.test/admin/settings", {
    headers: { "Origin": origin }
  }), { ...env, ADMIN_PASSWORD: "test-admin-password" });
  assert.equal(response.status, 401);
});

test("admin settings durable object persists JSON", async () => {
  const map = new Map();
  const storage = {
    get: async key => map.get(key),
    put: async (key, value) => map.set(key, structuredClone(value))
  };
  const store = new AdminSettingsStore({ storage }, {});
  const config = { settings: { apiBaseUrl: "https://api.example.test/v1", model: "model-a" } };
  const put = await store.fetch(new Request("https://internal/data", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config)
  }));
  assert.equal(put.status, 200);
  const get = await store.fetch(new Request("https://internal/data"));
  assert.deepEqual(await get.json(), config);
});

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
  const response = await worker.fetch(req({ mode: "solve", messages: [userMessage] }, "198.51.100.12"), {
    ALLOWED_ORIGINS: origin,
    ADMIN_STORE: createStoreBinding()
  });
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
    assert.equal(calledUrl, "https://api.example.com/v1/chat/completions");
    assert.equal(sentBody.model, "vision-model");
    assert.equal(sentBody.messages[0].role, "system");
    assert.match((await response.json()).answer, /x=3/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("general chat remains compatible with the AI learning edition", async () => {
  const originalFetch = globalThis.fetch;
  let sentBody;
  globalThis.fetch = async (url, init) => {
    sentBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      model: "vision-model",
      choices: [{ message: { content: "可以，我会按题目条件逐步分析。" } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const response = await worker.fetch(req({ mode: "general", messages: [userMessage] }, "198.51.100.18"), env);
    assert.equal(response.status, 200);
    assert.match(sentBody.messages[0].content, /多学科学习助手/);
    assert.equal(sentBody.messages[1].content, userMessage.content);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("structured AI analysis uses the shared Worker prompt template", async () => {
  const originalFetch = globalThis.fetch;
  let sentBody;
  globalThis.fetch = async (url, init) => {
    sentBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      model: "vision-model",
      choices: [{ message: { content: "【核心结论】x=2 或 x=3。\\n【关键信息】二次方程。\\n【推导与依据】因式分解。\\n【核验与限制】代回成立。\\n【AI扩展能力】可继续讨论参数。 " } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const response = await worker.fetch(req({
      task: "analysis",
      action: "extend",
      mode: "equation",
      context: { title: "方程求解", view: "equation", inputs: "x^2-5x+6=0", outputs: "x=2 或 x=3", details: "本地已完成求解" }
    }, "198.51.100.15"), env);
    assert.equal(response.status, 200);
    assert.match((await response.json()).answer, /核心结论/);
    assert.equal(sentBody.messages[0].role, "system");
    assert.match(sentBody.messages[0].content, /AI扩展能力/);
    assert.match(sentBody.messages[0].content, /增根风险/);
    assert.equal(sentBody.messages[1].role, "user");
    assert.match(sentBody.messages[1].content, /x\^2-5x\+6=0/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("structured AI analysis rejects missing or oversized context", async () => {
  const missing = await worker.fetch(req({
    task: "analysis", action: "analyze", mode: "basic", context: {}
  }, "198.51.100.16"), env);
  assert.equal(missing.status, 400);
  const tooLarge = await worker.fetch(req({
    task: "analysis", action: "analyze", mode: "basic",
    context: { title: "基础计算", inputs: "x".repeat(12001) }
  }, "198.51.100.17"), env);
  assert.equal(tooLarge.status, 400);
});

test("calculator inline AI analysis script parses and chat panel is removed", () => {
  const html = readFileSync(new URL("../ai-calculator.html", import.meta.url), "utf8");
  const opening = '<script id="zx-ai-inline-controller">';
  const start = html.indexOf(opening);
  const end = html.indexOf("</script>", start + opening.length);
  assert.ok(start >= 0 && end > start, "inline calculator AI controller must exist");
  assert.doesNotThrow(() => new Script(html.slice(start + opening.length, end)));
  assert.doesNotMatch(html, /id="zx-ai-panel"|id="zx-ai-launch"|zx-ai-compose/);
  assert.match(html, /data-zx-ai-action/);
  assert.match(html, /data-zx-ai-ask-form/);
  assert.match(html, /用户针对当前计算结果的追问/);
  assert.match(html, /if\(el\.type==='hidden'\|\|el\.disabled\|\|!visible\(el\)\)return;/);
  assert.match(html, /new AbortController\(\)/);
  assert.match(html, /requestTimeout=window\.setTimeout/);
  assert.match(html, /id="zx-light-surface-audit"/);
  assert.match(html, /\.zx-chem-keyboard,#chemKeyboard:not\(\[hidden\]\).*?background:rgba\(249,252,255,\.97\)!important/s);
  assert.match(html, /\.function-graph\{background:rgba\(255,255,255,\.94\)!important/);
});

test("AI frontend inline JavaScript parses without syntax errors", () => {
  const html = readFileSync(new URL("../ai.html", import.meta.url), "utf8");
  const start = html.lastIndexOf("<script>");
  const end = html.lastIndexOf("</script>");
  assert.ok(start >= 0 && end > start, "inline script must exist");
  assert.doesNotThrow(() => new Script(html.slice(start + 8, end)));
});

test("AI admin frontend inline JavaScript parses", () => {
  const html = readFileSync(new URL("../ai-admin.html", import.meta.url), "utf8");
  const start = html.lastIndexOf("<script>");
  const end = html.lastIndexOf("</script>");
  assert.ok(start >= 0 && end > start, "admin inline script must exist");
  assert.doesNotThrow(() => new Script(html.slice(start + 8, end)));
  assert.match(html, /ADMIN_PASSWORD/);
  assert.match(html, /获取模型列表/);
  assert.match(html, /提示词管理/);
  assert.match(html, /id="modelCatalogList"/);
  assert.match(html, /function renderModelCatalog/);
  assert.match(html, /modelSearch/);
});
