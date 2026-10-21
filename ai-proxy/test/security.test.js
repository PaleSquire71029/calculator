import test from "node:test";
import assert from "node:assert/strict";
import worker, { AdminSettingsStore } from "../src/index.js";
import { normalizeApiBaseUrl, readJsonLimited, readResponseTextLimited } from "../src/admin.js";

class MemoryStorage {
  constructor() { this.values = new Map(); this.alarm = null; }
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { return this.values.delete(key); }
  async list({ prefix = "" } = {}) {
    const result = new Map();
    for (const [key, value] of this.values) if (key.startsWith(prefix)) result.set(key, value);
    return result;
  }
  async transaction(callback) { return callback(this); }
  async getAlarm() { return this.alarm; }
  async setAlarm(timestamp) { this.alarm = timestamp; }
}

function fakeEnvironment(extra = {}) {
  const storage = new MemoryStorage();
  const env = {
    ADMIN_PASSWORD: "unit-test-admin-password-at-least-16",
    ADMIN_SESSION_SECRET: "unit-test-session-secret-with-high-entropy",
    ADMIN_ENCRYPTION_KEY: "unit-test-independent-encryption-secret",
    AI_BASE_URL: "https://api.example-provider.com/v1",
    AI_MODEL: "example-model",
    ALLOWED_ORIGINS: "https://c.zhixing.us.ci",
    ...extra
  };
  const durableObject = new AdminSettingsStore({ storage }, env);
  const stub = { fetch: (input, init) => durableObject.fetch(input instanceof Request ? input : new Request(input, init)) };
  env.ADMIN_STORE = { idFromName: () => "settings-v1", get: () => stub };
  return { env, storage, durableObject };
}

function jsonRequest(url, body, headers = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

async function loginAdmin(env, ip = "203.0.113.180") {
  const response = await worker.fetch(jsonRequest("https://worker.test/admin/login", {
    password: env.ADMIN_PASSWORD
  }, { Origin: "https://c.zhixing.us.ci", "CF-Connecting-IP": ip }), env);
  assert.equal(response.status, 200, "admin login should succeed in tests");
  return (await response.json()).token;
}

test("normalizes OpenAI-compatible API roots and removes endpoint suffixes", () => {
  assert.equal(
    normalizeApiBaseUrl("https://api.a6api.com/v1/chat/completions"),
    "https://api.a6api.com/v1"
  );
  assert.equal(normalizeApiBaseUrl("https://api.a6api.com"), "https://api.a6api.com/v1");
  assert.equal(normalizeApiBaseUrl("https://api.a6api.com/models"), "https://api.a6api.com/v1");
  assert.equal(normalizeApiBaseUrl("https://api.example-provider.com/v1/?key=ignored#fragment"),
    "https://api.example-provider.com/v1");
});

test("rejects insecure, credential-bearing, literal-IP, internal, and custom-port upstream URLs", () => {
  const invalid = [
    "http://api.example.com/v1",
    "https://user:pass@api.example.com/v1",
    "https://127.0.0.1/v1",
    "https://127.1/v1",
    "https://2130706433/v1",
    "https://192.168.1.10/v1",
    "https://[::1]/v1",
    "https://localhost/v1",
    "https://service.internal/v1",
    "https://api.example.com:8443/v1"
  ];
  for (const value of invalid) assert.throws(() => normalizeApiBaseUrl(value), value);
});

test("single login issues two separate product-scoped admin sessions", async () => {
  const { env } = fakeEnvironment();
  const origin = "https://c.zhixing.us.ci";
  const response = await worker.fetch(jsonRequest("https://worker.test/admin/login/all?app=learning", {
    password: env.ADMIN_PASSWORD
  }, { Origin: origin, "CF-Connecting-IP": "203.0.113.199" }), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.tokens["zhixing-ai"]);
  assert.ok(body.tokens.learning);
  assert.ok(body.tokens.cloud, "unified login should issue a cloud-admin-scoped token");
  assert.notEqual(body.tokens["zhixing-ai"], body.tokens.learning);
  assert.notEqual(body.tokens.cloud, body.tokens.learning);
  assert.ok(body.expiresIn > 0);

  const cloudScoped = await worker.fetch(new Request("https://worker.test/admin/cloud/overview", {
    headers: { Origin: origin, Authorization: "Bearer " + body.tokens.cloud, "CF-Connecting-IP": "203.0.113.199" }
  }), env);
  assert.equal(cloudScoped.status, 503, "cloud token should pass role verification and reach the missing Supabase configuration check");

  const denied = await worker.fetch(new Request("https://worker.test/admin/defaults?app=learning", {
    headers: { Origin: origin, Authorization: "Bearer " + body.tokens["zhixing-ai"] }
  }), env);
  assert.equal(denied.status, 401, "A token for Zhixing AI must not access learning settings");

  const allowed = await worker.fetch(new Request("https://worker.test/admin/defaults?app=learning", {
    headers: { Origin: origin, Authorization: "Bearer " + body.tokens.learning }
  }), env);
  assert.equal(allowed.status, 200);
});

test("limits JSON bodies even when Content-Length is absent or misleading", async () => {
  const valid = await readJsonLimited(jsonRequest("https://worker.test/api", { ok: true }), 32);
  assert.deepEqual(valid.data, { ok: true });

  const streamedTooLarge = await readJsonLimited(
    jsonRequest("https://worker.test/api", { value: "x".repeat(128) }),
    32
  );
  assert.equal(streamedTooLarge.status, 413);

  const misleadingLength = new Request("https://worker.test/api", {
    method: "POST",
    headers: { "Content-Length": "5000" },
    body: "{}"
  });
  assert.equal((await readJsonLimited(misleadingLength, 100)).status, 413);
});

test("rejects JSON null, arrays, and malformed JSON as non-object requests", async () => {
  for (const raw of ["null", "[]", "{"]) {
    const request = new Request("https://worker.test/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw
    });
    const parsed = await readJsonLimited(request, 100);
    assert.equal(parsed.status, 400);
    assert.equal(typeof parsed.error, "string");
  }
});

test("bounds upstream response reads", async () => {
  const response = new Response("x".repeat(128));
  const result = await readResponseTextLimited(response, 32);
  assert.equal(result.error, "上游响应体过大");
});

test("Durable Object rate limiter persists counters and applies separate IP buckets", async () => {
  const storage = new MemoryStorage();
  const store = new AdminSettingsStore({ storage }, {});
  const consume = async key => {
    const response = await store.fetch(jsonRequest("https://admin-store.internal/rate-limit",
      { key, limit: 2, windowMs: 60000 }));
    return response.json();
  };
  assert.equal((await consume("chat:test-ip")).allowed, true);
  assert.equal((await consume("chat:test-ip")).allowed, true);
  assert.equal((await consume("chat:test-ip")).allowed, false);
  assert.equal((await consume("chat:other-ip")).allowed, true);
  assert.ok(await storage.getAlarm());
});

test("admin save encrypts custom API keys at rest and never returns the key", async () => {
  const { env, storage } = fakeEnvironment();
  const origin = "https://c.zhixing.us.ci";
  const loginResponse = await worker.fetch(jsonRequest(
    "https://worker.test/admin/login",
    { password: env.ADMIN_PASSWORD },
    { Origin: origin, "CF-Connecting-IP": "203.0.113.15" }
  ), env);
  assert.equal(loginResponse.status, 200);
  const { token } = await loginResponse.json();
  assert.equal(typeof token, "string");

  const secret = "sk-test-custom-key-that-must-not-be-stored-plaintext";
  const saveResponse = await worker.fetch(new Request("https://worker.test/admin/settings", {
    method: "PUT",
    headers: {
      Origin: origin,
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.15"
    },
    body: JSON.stringify({
      apiBaseUrl: "https://api.example-provider.com/v1",
      model: "example-model",
      apiKey: secret,
      temperature: 0.2,
      maxTokens: 512
    })
  }), env);
  assert.equal(saveResponse.status, 200);
  const saved = await storage.get("adminData");
  assert.equal(saved.settings.apiKeyMode, "custom");
  assert.match(saved.settings.apiKey, /^enc:v1:/);
  assert.equal(saved.settings.apiKey.includes(secret), false);

  const getResponse = await worker.fetch(new Request("https://worker.test/admin/settings", {
    method: "GET",
    headers: { Origin: origin, Authorization: "Bearer " + token }
  }), env);
  assert.equal(getResponse.status, 200);
  const publicSettings = await getResponse.json();
  assert.equal(publicSettings.hasApiKey, true);
  assert.equal(publicSettings.apiKeySource, "custom");
  assert.equal(JSON.stringify(publicSettings).includes(secret), false);
});

test("caps streamed AI analysis output and sends a parseable error event", async () => {
  const { env } = fakeEnvironment({ AI_API_KEY: "worker-test-key" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
      controller.close();
    }
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });

  try {
    const response = await worker.fetch(jsonRequest(
      "https://worker.test/api/chat",
      {
        task: "analysis",
        action: "analyze",
        mode: "basic",
        stream: true,
        context: { title: "stream size test" }
      },
      { Origin: "https://c.zhixing.us.ci", "CF-Connecting-IP": "198.51.100.55" }
    ), env);
    assert.equal(response.status, 200);
    const streamText = await response.text();
    assert.match(streamText, /模型流式输出超过 4 MB 安全上限/);
    assert.ok(streamText.includes("data: [DONE]"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("re-wraps a key encrypted with the fallback secret when the preferred key is added", async () => {
  const { env, storage } = fakeEnvironment({ ADMIN_ENCRYPTION_KEY: undefined });
  const origin = "https://c.zhixing.us.ci";
  const loginResponse = await worker.fetch(jsonRequest(
    "https://worker.test/admin/login",
    { password: env.ADMIN_PASSWORD },
    { Origin: origin, "CF-Connecting-IP": "203.0.113.17" }
  ), env);
  const { token } = await loginResponse.json();
  const customKey = "sk-rotating-key-that-stays-encrypted";
  const saveResponse = await worker.fetch(new Request("https://worker.test/admin/settings", {
    method: "PUT",
    headers: {
      Origin: origin,
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.17"
    },
    body: JSON.stringify({
      apiBaseUrl: "https://api.example-provider.com/v1",
      model: "example-model",
      apiKey: customKey,
      temperature: 0.2,
      maxTokens: 512
    })
  }), env);
  assert.equal(saveResponse.status, 200);
  const encryptedWithFallback = (await storage.get("adminData")).settings.apiKey;

  env.ADMIN_ENCRYPTION_KEY = "new-independent-key-after-upgrade";
  const getResponse = await worker.fetch(new Request("https://worker.test/admin/settings", {
    method: "GET",
    headers: { Origin: origin, Authorization: "Bearer " + token }
  }), env);
  assert.equal(getResponse.status, 200);
  const encryptedWithPreferredKey = (await storage.get("adminData")).settings.apiKey;
  assert.match(encryptedWithPreferredKey, /^enc:v1:/);
  assert.notEqual(encryptedWithPreferredKey, encryptedWithFallback);
  assert.equal(encryptedWithPreferredKey.includes(customKey), false);
});

test("migrates a legacy plaintext custom API key during a normal config read", async () => {
  const { env, storage } = fakeEnvironment();
  const legacyKey = "sk-legacy-key-that-was-previously-plaintext";
  await storage.put("adminData", {
    settings: {
      apiKey: legacyKey,
      apiKeyMode: "custom",
      apiBaseUrl: "https://api.example-provider.com/v1",
      model: "example-model",
      temperature: 0.2,
      maxTokens: 512,
      prompts: {}
    }
  });

  const response = await worker.fetch(new Request("https://worker.test/health"), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).configured, true);

  const migrated = await storage.get("adminData");
  assert.match(migrated.settings.apiKey, /^enc:v1:/);
  assert.equal(migrated.settings.apiKey.includes(legacyKey), false);
});

test("rate-limits invalid admin tokens before repeated HMAC verification", async () => {
  const { env } = fakeEnvironment();
  const url = "https://worker.test/admin/defaults";
  let lastResponse;
  for (let i = 0; i < 121; i++) {
    lastResponse = await worker.fetch(new Request(url, {
      method: "GET",
      headers: {
        Origin: "https://c.zhixing.us.ci",
        Authorization: "Bearer eyJyb2xlIjoiYWRtaW4ifQ.invalid-signature",
        "CF-Connecting-IP": "198.51.100.91"
      }
    }), env);
    if (i < 120) assert.equal(lastResponse.status, 401);
  }
  assert.equal(lastResponse.status, 429);
  assert.ok(Number(lastResponse.headers.get("Retry-After")) > 0);
});

test("authenticated stats reset clears counters and recent metadata only", async () => {
  const { env, storage } = fakeEnvironment();
  await storage.put("adminData", {
    settings: { apiKey: "", apiKeyMode: "worker", apiBaseUrl: "https://api.example-provider.com/v1", model: "example-model" },
    stats: { totalRequests: 12, failedRequests: 3, promptTokens: 500, completionTokens: 200, recent: [{ at: "2026-01-01T00:00:00.000Z", mode: "general", ok: false, status: 502, model: "example-model" }] }
  });
  const origin = "https://c.zhixing.us.ci";
  const login = await worker.fetch(jsonRequest("https://worker.test/admin/login", { password: env.ADMIN_PASSWORD }, {
    Origin: origin, "CF-Connecting-IP": "198.51.100.61"
  }), env);
  assert.equal(login.status, 200);
  const { token } = await login.json();
  const response = await worker.fetch(jsonRequest("https://worker.test/admin/stats/reset", { confirm: "RESET_STATS" }, {
    Origin: origin, Authorization: "Bearer " + token, "CF-Connecting-IP": "198.51.100.61"
  }), env);
  assert.equal(response.status, 200);
  const data = await storage.get("adminData");
  assert.equal(data.stats.totalRequests, 0);
  assert.equal(data.stats.failedRequests, 0);
  assert.equal(data.stats.promptTokens, 0);
  assert.equal(data.stats.completionTokens, 0);
  assert.equal(data.stats.totalTokens, 0);
  assert.deepEqual(data.stats.recent, []);
  assert.equal(data.settings.model, "example-model");
  assert.ok(data.stats.resetAt);
});

test("fails closed when persistent rate-limit storage is not bound", async () => {
  const response = await worker.fetch(new Request("https://worker.test/api/chat", {
    method: "POST",
    headers: {
      Origin: "https://c.zhixing.us.ci",
      "Content-Type": "application/json",
      "CF-Connecting-IP": "198.51.100.46"
    },
    body: JSON.stringify({ mode: "general", messages: [{ role: "user", content: "test" }] })
  }), {
    ADMIN_PASSWORD: "unit-test-admin-password-at-least-16",
    AI_API_KEY: "worker-test-key",
    AI_BASE_URL: "https://api.example-provider.com/v1",
    AI_MODEL: "example-model",
    ALLOWED_ORIGINS: "https://c.zhixing.us.ci"
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /限流存储/);
});

test("API endpoint returns 400, not 500, for JSON null", async () => {
  const { env } = fakeEnvironment();
  const response = await worker.fetch(new Request("https://worker.test/api/chat", {
    method: "POST",
    headers: {
      Origin: "https://c.zhixing.us.ci",
      "Content-Type": "application/json",
      "CF-Connecting-IP": "198.51.100.44"
    },
    body: "null"
  }), env);
  assert.equal(response.status, 400);
});

test("admin can reveal the saved API token only through an explicit authenticated action", async () => {
  const { env } = fakeEnvironment({ AI_API_KEY: "sk-worker-secret-token-for-tests" });
  const token = await loginAdmin(env, "203.0.113.181");
  const response = await worker.fetch(jsonRequest("https://worker.test/admin/key/reveal", {
    confirm: "REVEAL_KEY"
  }, {
    Origin: "https://c.zhixing.us.ci",
    Authorization: "Bearer " + token,
    "CF-Connecting-IP": "203.0.113.181"
  }), env);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.apiKey, "sk-worker-secret-token-for-tests");
  assert.equal(payload.source, "worker");
});

test("model list endpoint accepts nested compatible response formats", async () => {
  const { env } = fakeEnvironment({ AI_API_KEY: "sk-model-list-test" });
  const token = await loginAdmin(env, "203.0.113.182");
  const originalFetch = globalThis.fetch;
  let upstreamUrl = "";
  let upstreamRedirect = "";
  globalThis.fetch = async (url, init) => {
    upstreamUrl = String(url);
    upstreamRedirect = init?.redirect || "";
    return new Response(JSON.stringify({
      success: true,
      data: { models: [{ id: "model-alpha" }, { model: "model-beta" }] }
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const response = await worker.fetch(jsonRequest("https://worker.test/admin/models", {
      apiBaseUrl: "https://api.example-provider.com/v1"
    }, {
      Origin: "https://c.zhixing.us.ci",
      Authorization: "Bearer " + token,
      "CF-Connecting-IP": "203.0.113.182"
    }), env);
    assert.equal(response.status, 200);
    assert.equal(upstreamUrl, "https://api.example-provider.com/v1/models");
    assert.equal(upstreamRedirect, "manual");
    assert.deepEqual((await response.json()).models, ["model-alpha", "model-beta"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("model list rejects redirects without following or disclosing credentials", async () => {
  const { env } = fakeEnvironment({ AI_API_KEY: "sk-redirect-token" });
  const token = await loginAdmin(env, "203.0.113.184");
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url, init) => {
    requested.push({ url: String(url), redirect: init?.redirect, authorization: init?.headers?.Authorization });
    return new Response("", { status: 302, headers: { Location: "https://redirect.example/collect" } });
  };
  try {
    const response = await worker.fetch(jsonRequest("https://worker.test/admin/models", {
      apiBaseUrl: "https://api.example-provider.com/v1", apiKey: "sk-redirect-token"
    }, {
      Origin: "https://c.zhixing.us.ci",
      Authorization: "Bearer " + token,
      "CF-Connecting-IP": "203.0.113.184"
    }), env);
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /重定向/);
    assert.equal(requested.length, 1);
    assert.equal(requested[0].redirect, "manual");
    assert.equal(requested[0].url, "https://api.example-provider.com/v1/models");
    assert.equal(requested[0].authorization, "Bearer sk-redirect-token");
  } finally { globalThis.fetch = originalFetch; }
});

test("A6API balance combines hard USD limit and token usage units", async () => {
  const { env } = fakeEnvironment({ AI_API_KEY: "sk-balance-token", AI_BASE_URL: "https://api.a6api.com/v1" });
  const token = await loginAdmin(env, "203.0.113.183");
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    requested.push({ target, authorization: init?.headers?.Authorization, redirect: init?.redirect });
    if (target === "https://api.a6api.com/dashboard/billing/subscription") {
      return new Response(JSON.stringify({ data: { hard_limit_usd: 10 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (target === "https://api.a6api.com/api/usage/token/") {
      return new Response(JSON.stringify({ success: true, data: {
        name: "test-token", total_granted: 100, total_used: 25, total_available: 75, unlimited_quota: false, expires_at: 0
      }}), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error("unexpected upstream url: " + target);
  };
  try {
    const response = await worker.fetch(jsonRequest("https://worker.test/admin/balance", { apiBaseUrl: "https://api.a6api.com" }, {
      Origin: "https://c.zhixing.us.ci", Authorization: "Bearer " + token, "CF-Connecting-IP": "203.0.113.183"
    }), env);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.provider, "A6API");
    assert.equal(payload.hardLimitUsd, 10);
    assert.equal(payload.totalGranted, 100);
    assert.equal(payload.totalUsed, 25);
    assert.equal(payload.totalAvailable, 75);
    assert.equal(payload.usedUsd, 2.5);
    assert.equal(payload.availableUsd, 7.5);
    assert.equal(payload.currencySymbol, "$");
    assert.ok(requested.every(row => row.authorization === "Bearer sk-balance-token"));
    assert.ok(requested.every(row => row.redirect === "manual"));
    assert.deepEqual(requested.map(row => row.target).sort(), [
      "https://api.a6api.com/api/usage/token/",
      "https://api.a6api.com/dashboard/billing/subscription"
    ]);
  } finally { globalThis.fetch = originalFetch; }
});

test("provider-aware balance lookup supports DeepSeek, OpenRouter, and SiliconFlow canonical billing endpoints", async () => {
  const originalFetch = globalThis.fetch;
  const cases = [
    {
      provider: "DeepSeek",
      base: "https://api.deepseek.com",
      endpoint: "https://api.deepseek.com/user/balance",
      response: { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" }] },
      check: payload => {
        assert.equal(payload.provider, "DeepSeek");
        assert.equal(payload.currencies[0].totalBalance, 110);
        assert.equal(payload.currencies[0].grantedBalance, 10);
        assert.equal(payload.currencies[0].toppedUpBalance, 100);
      }
    },
    {
      provider: "OpenRouter",
      base: "https://openrouter.ai/api/v1",
      endpoint: "https://openrouter.ai/api/v1/credits",
      response: { data: { total_credits: 100.5, total_usage: 25.75 } },
      check: payload => {
        assert.equal(payload.provider, "OpenRouter");
        assert.equal(payload.totalCredits, 100.5);
        assert.equal(payload.totalUsage, 25.75);
        assert.equal(payload.remainingCredits, 74.75);
      }
    },
    {
      provider: "SiliconFlow",
      base: "https://api.siliconflow.cn/v1",
      endpoint: "https://api.siliconflow.cn/v1/user/info",
      response: { status: true, data: { balance: "0.88", chargeBalance: "88.00", totalBalance: "88.88", status: "normal" } },
      check: payload => {
        assert.equal(payload.provider, "SiliconFlow");
        assert.equal(payload.balance, 0.88);
        assert.equal(payload.chargeBalance, 88);
        assert.equal(payload.totalBalance, 88.88);
      }
    }
  ];
  try {
    for (const [i, item] of cases.entries()) {
      const { env } = fakeEnvironment({ AI_API_KEY: "sk-provider-balance-token" });
      const token = await loginAdmin(env, "203.0.113." + (190 + i));
      let requestCount = 0;
      globalThis.fetch = async (input, init = {}) => {
        requestCount++;
        assert.equal(String(input), item.endpoint);
        assert.equal(new Headers(init.headers || {}).get("Authorization"), "Bearer sk-provider-balance-token");
        assert.equal(init.redirect, "manual", "balance lookup must not follow redirects with credentials");
        return new Response(JSON.stringify(item.response), { status: 200, headers: { "Content-Type": "application/json" } });
      };
      const response = await worker.fetch(jsonRequest("https://worker.test/admin/balance", {
        apiBaseUrl: item.base
      }, {
        Origin: "https://c.zhixing.us.ci",
        Authorization: "Bearer " + token,
        "CF-Connecting-IP": "203.0.113." + (190 + i)
      }), env);
      assert.equal(response.status, 200, item.provider + " balance query should succeed");
      item.check(await response.json());
      assert.equal(requestCount, 1);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("A6API balance never sends credentials to a noncanonical host", async () => {
  const { env } = fakeEnvironment({ AI_API_KEY: "sk-balance-token" });
  const token = await loginAdmin(env, "203.0.113.185");
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("should not be called"); };
  try {
    const response = await worker.fetch(jsonRequest("https://worker.test/admin/balance", { apiBaseUrl: "https://api.a6api.example/v1" }, {
      Origin: "https://c.zhixing.us.ci", Authorization: "Bearer " + token, "CF-Connecting-IP": "203.0.113.185"
    }), env);
    assert.equal(response.status, 400);
    assert.equal(called, false);
  } finally { globalThis.fetch = originalFetch; }
});

test("streamed analysis requests usage and adds token counts to statistics and recent records", async () => {
  const { env } = fakeEnvironment({ AI_API_KEY: "worker-stream-test-key" });
  const originalFetch = globalThis.fetch;
  let upstreamBody;
  const sse = [
    "data: " + JSON.stringify({ choices: [{ delta: { content: "答案" } }] }) + "\n\n",
    "data: " + JSON.stringify({ choices: [], usage: { prompt_tokens: 31, completion_tokens: 9, total_tokens: 40 } }) + "\n\n",
    "data: [DONE]\n\n"
  ].join("");
  globalThis.fetch = async (_url, init) => {
    upstreamBody = JSON.parse(init.body);
    return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  try {
    const response = await worker.fetch(jsonRequest("https://worker.test/api/chat", {
      task: "analysis",
      action: "extend",
      mode: "equation",
      stream: true,
      context: { title: "方程求解", inputs: "x^2-5x+6=0", outputs: "x=2 或 x=3" }
    }, { Origin: "https://c.zhixing.us.ci", "CF-Connecting-IP": "203.0.113.184" }), env);
    assert.equal(response.status, 200);
    await response.text();
    assert.deepEqual(upstreamBody.stream_options, { include_usage: true });
    const token = await loginAdmin(env, "203.0.113.184");
    const settings = await worker.fetch(new Request("https://worker.test/admin/settings", {
      headers: { Origin: "https://c.zhixing.us.ci", Authorization: "Bearer " + token }
    }), env);
    assert.equal(settings.status, 200);
    const stats = (await settings.json()).stats;
    assert.equal(stats.promptTokens, 31);
    assert.equal(stats.completionTokens, 9);
    assert.equal(stats.totalTokens, 40);
    assert.equal(stats.recent[0].promptTokens, 31);
    assert.equal(stats.recent[0].completionTokens, 9);
    assert.equal(stats.recent[0].totalTokens, 40);
    assert.equal(stats.recent[0].ip, "203.0.113.184");
    assert.equal(stats.recent[0].origin, "https://c.zhixing.us.ci");
    assert.equal(typeof stats.recent[0].durationMs, "number");
    assert.ok(stats.recent[0].durationMs >= 0);
  } finally { globalThis.fetch = originalFetch; }
});


test("cloud data admin gets a separate scoped session and aggregated overview", async () => {
  const { env } = fakeEnvironment({
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test_key"
  });
  const origin = "https://c.zhixing.us.ci";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.hostname, "project.supabase.co");
    if (url.pathname.includes("/auth/v1/admin/users/123e4567-e89b-42d3-a456-426614174001")) {
      const adminHeaders = new Headers(init.headers || {});
      assert.equal(adminHeaders.get("apikey"), "sb_secret_test_key");
      assert.equal(adminHeaders.get("Authorization"), null, "opaque Supabase secret keys are not JWT bearer tokens");
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(JSON.stringify({
        id: "123e4567-e89b-42d3-a456-426614174001",
        email: "new.user@example.com",
        email_confirmed_at: "2026-10-21T12:00:00.000Z"
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname.endsWith("/auth/v1/admin/users")) {
      const adminHeaders = new Headers(init.headers || {});
      assert.equal(adminHeaders.get("apikey"), "sb_secret_test_key");
      assert.equal(adminHeaders.get("Authorization"), null, "opaque Supabase secret keys are not JWT bearer tokens");
      if (init.method === "POST") {
        const payload = JSON.parse(init.body);
        assert.equal(payload.email, "new.user@example.com");
        assert.equal(payload.email_confirm, true);
        assert.equal(typeof payload.password, "string");
        assert.equal("app_metadata" in payload, false, "registration IP must not be embedded in the user's JWT metadata");
        return new Response(JSON.stringify({
          id: "123e4567-e89b-42d3-a456-426614174001",
          email: payload.email,
          email_confirmed_at: "2026-10-21T12:00:00.000Z",
          created_at: "2026-10-21T12:00:00.000Z",
          last_sign_in_at: null
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ users: [{
        id: "123e4567-e89b-42d3-a456-426614174001",
        email: "new.user@example.com",
        email_confirmed_at: "2026-10-21T12:00:00.000Z",
        created_at: "2026-10-21T12:00:00.000Z",
        last_sign_in_at: null,
        app_metadata: { zx_registration: { ip: "203.0.113.210", city: "Example City", region: "Example Region", country: "US", countryCode: "US", timezone: "America/Los_Angeles", registeredAt: "2026-10-21T12:00:00.000Z", source: "admin-created" } },
        encrypted_password: "must-not-leak"
      }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (init.method === "DELETE" && url.pathname.endsWith("/zx_conversations")) {
      const id = "123e4567-e89b-42d3-a456-426614174000";
      return new Response(JSON.stringify([{ id }]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (init.method === "HEAD") {
      const app = url.searchParams.get("app_id") || "";
      const isMessage = url.pathname.endsWith("/zx_messages");
      const expired = url.searchParams.has("last_activity_at");
      const count = isMessage ? (app.includes("zhixing-ai") ? 8 : 9) :
        expired ? (app.includes("zhixing-ai") ? 1 : 2) :
          (app.includes("zhixing-ai") ? 2 : 3);
      return new Response(null, { status: 200, headers: { "Content-Range": "0-0/" + count } });
    }
    if (url.pathname.endsWith("/zx_conversations") && String(url.searchParams.get("select") || "").startsWith("id,user_id,app_id,title")) {
      assert.equal(url.searchParams.get("app_id"), "in.(zhixing-ai,learning)", "all-product account history must query only the two known apps");
      assert.equal(url.searchParams.get("user_id"), "eq.123e4567-e89b-42d3-a456-426614174088");
      return new Response(JSON.stringify([{
        id: "123e4567-e89b-42d3-a456-426614174099",
        user_id: "123e4567-e89b-42d3-a456-426614174088",
        app_id: "learning",
        title: "Learning conversation",
        created_at: "2026-10-21T10:00:00.000Z",
        updated_at: "2026-10-21T10:00:00.000Z",
        last_activity_at: "2026-10-21T10:00:00.000Z",
        zx_messages: [{ count: 2 }]
      }]), { status: 200, headers: { "Content-Type": "application/json", "Content-Range": "0-0/1" } });
    }
    if (url.pathname.endsWith("/zx_conversations") && url.searchParams.get("select") === "user_id") {
      return new Response(JSON.stringify([
        { user_id: "user-a" }, { user_id: "user-b" }, { user_id: "user-a" }
      ]), { status: 200, headers: { "Content-Type": "application/json", "Content-Range": "0-2/3" } });
    }
    throw new Error("Unexpected mocked Supabase request: " + url.pathname + " " + (init.method || "GET"));
  };
  try {
    const login = await worker.fetch(jsonRequest("https://worker.test/admin/cloud/login", {
      password: env.ADMIN_PASSWORD
    }, { Origin: origin, "CF-Connecting-IP": "203.0.113.210" }), env);
    assert.equal(login.status, 200);
    const { token } = await login.json();
    assert.equal(typeof token, "string");

    const overview = await worker.fetch(new Request("https://worker.test/admin/cloud/overview", {
      headers: { Origin: origin, Authorization: "Bearer " + token, "CF-Connecting-IP": "203.0.113.210" }
    }), env);
    assert.equal(overview.status, 200);
    const data = await overview.json();
    assert.equal(data.totals.conversations, 5);
    assert.equal(data.totals.messages, 17);
    assert.equal(data.totals.expired, 3);
    assert.equal(data.usersInRecentSample, 2);

    const history = await worker.fetch(new Request("https://worker.test/admin/cloud/conversations?app=all&page=1&page_size=20&user_id=123e4567-e89b-42d3-a456-426614174088", {
      headers: { Origin: origin, Authorization: "Bearer " + token, "CF-Connecting-IP": "203.0.113.210" }
    }), env);
    assert.equal(history.status, 200);
    const historyBody = await history.json();
    assert.equal(historyBody.conversations.length, 1);
    assert.equal(historyBody.conversations[0].app_id, "learning");
    assert.equal(historyBody.conversations[0].message_count, 2);

    const accounts = await worker.fetch(new Request("https://worker.test/admin/cloud/accounts?page=1&per_page=20", {
      headers: { Origin: origin, Authorization: "Bearer " + token, "CF-Connecting-IP": "203.0.113.210" }
    }), env);
    assert.equal(accounts.status, 200);
    const accountsBody = await accounts.json();
    assert.equal(accountsBody.users.length, 1);
    assert.equal(accountsBody.users[0].email, "new.user@example.com");
    assert.equal(JSON.stringify(accountsBody).includes("must-not-leak"), false, "Auth internal fields must not be returned");

    const createAccountRequest = jsonRequest("https://worker.test/admin/cloud/accounts", {
      email: "new.user@example.com", password: "safe-initial-password-123", emailOwnershipConfirmed: true
    }, { Origin: origin, Authorization: "Bearer " + token, "CF-Connecting-IP": "203.0.113.210" });
    Object.defineProperty(createAccountRequest, "cf", { value: { city: "Example City", region: "Example Region", country: "US", timezone: "America/Los_Angeles" } });
    const createdAccount = await worker.fetch(createAccountRequest, env);
    assert.equal(createdAccount.status, 201);
    const createdBody = await createdAccount.json();
    assert.equal(createdBody.user.email, "new.user@example.com");
    assert.equal(createdBody.user.registration.ip, "203.0.113.210");
    assert.equal(createdBody.user.registration.city, "Example City");
    assert.equal(createdBody.user.registration.region, "Example Region");
    assert.equal(JSON.stringify(createdBody).includes("safe-initial-password-123"), false, "created user response must not echo password");
    assert.equal(createdBody.auditLogged, true);

    const conversationId = "123e4567-e89b-42d3-a456-426614174000";
    const deletion = await worker.fetch(jsonRequest("https://worker.test/admin/cloud/conversations/delete", {
      app: "zhixing-ai", ids: [conversationId], confirm: "DELETE_SELECTED"
    }, { Origin: origin, Authorization: "Bearer " + token, "CF-Connecting-IP": "203.0.113.210" }), env);
    assert.equal(deletion.status, 200);
    const deletionBody = await deletion.json();
    assert.equal(deletionBody.deleted, 1);
    assert.equal(deletionBody.auditLogged, true);

    const auditResponse = await worker.fetch(new Request("https://worker.test/admin/cloud/audit", {
      headers: { Origin: origin, Authorization: "Bearer " + token, "CF-Connecting-IP": "203.0.113.210" }
    }), env);
    assert.equal(auditResponse.status, 200);
    const audit = await auditResponse.json();
    assert.equal(audit.entries[0].action, "delete_conversation");
    assert.equal(audit.entries[0].app, "zhixing-ai");
    assert.equal(audit.entries[0].affectedCount, 1);
    assert.equal("content" in audit.entries[0], false, "audit entries must not contain message content");

    const deniedSettings = await worker.fetch(new Request("https://worker.test/admin/settings?app=learning", {
      headers: { Origin: origin, Authorization: "Bearer " + token, "CF-Connecting-IP": "203.0.113.210" }
    }), env);
    assert.equal(deniedSettings.status, 401, "cloud-data token must not authorize model/config operations");

    const ordinaryToken = await loginAdmin(env, "203.0.113.211");
    const deniedCloud = await worker.fetch(new Request("https://worker.test/admin/cloud/overview", {
      headers: { Origin: origin, Authorization: "Bearer " + ordinaryToken, "CF-Connecting-IP": "203.0.113.211" }
    }), env);
    assert.equal(deniedCloud.status, 401, "ordinary product admin tokens must not authorize cloud-data operations");

    const wrongEmailDeletion = await worker.fetch(jsonRequest("https://worker.test/admin/cloud/accounts/delete", {
      user_id: "123e4567-e89b-42d3-a456-426614174001", email: "not-the-owner@example.com", confirm: "DELETE_ACCOUNT"
    }, { Origin: origin, Authorization: "Bearer " + token, "CF-Connecting-IP": "203.0.113.210" }), env);
    assert.equal(wrongEmailDeletion.status, 409, "account deletion must match the target account email");
    const accountDeletion = await worker.fetch(jsonRequest("https://worker.test/admin/cloud/accounts/delete", {
      user_id: "123e4567-e89b-42d3-a456-426614174001", email: "new.user@example.com", confirm: "DELETE_ACCOUNT"
    }, { Origin: origin, Authorization: "Bearer " + token, "CF-Connecting-IP": "203.0.113.210" }), env);
    assert.equal(accountDeletion.status, 200);
    const accountDeletionBody = await accountDeletion.json();
    assert.equal(accountDeletionBody.userDeleted, true);
    assert.equal(accountDeletionBody.conversationsDeleted, true);
    assert.equal(accountDeletionBody.deletedConversations, 1);
    assert.equal(accountDeletionBody.registrationDeleted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("end-user sessions are isolated from admin privileges and can only manage their own password", async () => {
  const { env } = fakeEnvironment({
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_key"
  });
  const origin = "https://c.zhixing.us.ci";
  const originalFetch = globalThis.fetch;
  const userId = "123e4567-e89b-42d3-a456-426614174088";
  const user = {
    id: userId,
    email: "self.user@example.com",
    email_confirmed_at: "2026-10-21T12:00:00.000Z",
    created_at: "2026-10-20T12:00:00.000Z",
    last_sign_in_at: null,
    app_metadata: {
      zx_registration: {
        ip: "198.51.100.7",
        city: "Example City",
        region: "Example Region",
        country: "US",
        countryCode: "US",
        timezone: "America/Los_Angeles",
        registeredAt: "2026-10-20T12:00:00.000Z",
        source: "admin-created"
      }
    }
  };
  const validPassword = "Current-user-password-123";
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "project.supabase.co") throw new Error("Unexpected remote host");
    if (url.pathname.endsWith("/auth/v1/token") && url.searchParams.get("grant_type") === "password") {
      const payload = JSON.parse(init.body || "{}");
      if (payload.email !== user.email || payload.password !== validPassword) {
        return new Response(JSON.stringify({ msg: "invalid credentials" }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        access_token: "supabase-user-access-token",
        refresh_token: "supabase-user-refresh-token",
        expires_in: 3600,
        user
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname.endsWith("/auth/v1/user")) {
      const bearer = new Headers(init.headers || {}).get("Authorization") || "";
      if (bearer !== "Bearer supabase-user-access-token") {
        return new Response(JSON.stringify({ msg: "invalid token" }), { status: 401, headers: { "Content-Type": "application/json" } });
      }
      if (init.method === "PUT") {
        const payload = JSON.parse(init.body || "{}");
        assert.equal(payload.password, "New-safe-user-password-456");
        return new Response(JSON.stringify({ id: userId }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify(user), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname.endsWith("/auth/v1/logout")) return new Response(null, { status: 204 });
    throw new Error("Unexpected mocked Auth request: " + url.pathname);
  };
  try {
    const login = await worker.fetch(jsonRequest("https://worker.test/api/account/login", {
      email: user.email, password: validPassword
    }, { Origin: origin, "CF-Connecting-IP": "203.0.113.70" }), env);
    assert.equal(login.status, 200);
    const session = await login.json();
    assert.equal(session.user.id, userId);
    assert.equal(session.user.registration.ip, "198.51.100.7");
    assert.equal(session.user.registration.city, "Example City");
    assert.equal(JSON.stringify(session).includes("SUPABASE_SERVICE_ROLE_KEY"), false);

    const me = await worker.fetch(new Request("https://worker.test/api/account/me?user_id=another-user", {
      headers: { Origin: origin, Authorization: "Bearer supabase-user-access-token" }
    }), env);
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.id, userId, "request user_id must never override the authenticated identity");

    const notAdmin = await worker.fetch(new Request("https://worker.test/admin/cloud/overview", {
      headers: { Origin: origin, Authorization: "Bearer supabase-user-access-token", "CF-Connecting-IP": "203.0.113.70" }
    }), env);
    assert.equal(notAdmin.status, 401, "Supabase user tokens must not authorize admin cloud routes");

    const wrongCurrent = await worker.fetch(jsonRequest("https://worker.test/api/account/password", {
      currentPassword: "not-the-current-password", newPassword: "New-safe-user-password-456"
    }, { Origin: origin, Authorization: "Bearer supabase-user-access-token", "CF-Connecting-IP": "203.0.113.70" }), env);
    assert.equal(wrongCurrent.status, 401, "changing the password requires verifying the current password");

    const changed = await worker.fetch(jsonRequest("https://worker.test/api/account/password", {
      currentPassword: validPassword, newPassword: "New-safe-user-password-456"
    }, { Origin: origin, Authorization: "Bearer supabase-user-access-token", "CF-Connecting-IP": "203.0.113.70" }), env);
    assert.equal(changed.status, 200);
    assert.deepEqual(await changed.json(), { ok: true });

    const adminAsUser = await worker.fetch(new Request("https://worker.test/api/account/me", {
      headers: { Origin: origin, Authorization: "Bearer eyJyb2xlIjoiYWRtaW4ifQ.invalid-signature" }
    }), env);
    assert.equal(adminAsUser.status, 401, "admin tokens are not Supabase user access tokens");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
