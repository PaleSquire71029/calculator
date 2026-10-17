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
  const durableObject = new AdminSettingsStore({ storage }, {});
  const stub = { fetch: request => durableObject.fetch(request) };
  const env = {
    ADMIN_PASSWORD: "unit-test-admin-password-at-least-16",
    ADMIN_SESSION_SECRET: "unit-test-session-secret-with-high-entropy",
    ADMIN_ENCRYPTION_KEY: "unit-test-independent-encryption-secret",
    AI_BASE_URL: "https://api.example-provider.com/v1",
    AI_MODEL: "example-model",
    ALLOWED_ORIGINS: "https://c.zhixing.us.ci",
    ADMIN_STORE: { idFromName: () => "settings-v1", get: () => stub },
    ...extra
  };
  return { env, storage, durableObject };
}

function jsonRequest(url, body, headers = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

test("normalizes OpenAI-compatible API roots and removes endpoint suffixes", () => {
  assert.equal(
    normalizeApiBaseUrl("https://api.a6api.com/v1/chat/completions"),
    "https://api.a6api.com/v1"
  );
  assert.equal(normalizeApiBaseUrl("https://api.example-provider.com/v1/?key=ignored#fragment"),
    "https://api.example-provider.com/v1");
});

test("rejects insecure, credential-bearing, literal-IP, internal, and custom-port upstream URLs", () => {
  const invalid = [
    "http://api.example.com/v1",
    "https://user:pass@api.example.com/v1",
    "https://127.0.0.1/v1",
    "https://192.168.1.10/v1",
    "https://[::1]/v1",
    "https://localhost/v1",
    "https://service.internal/v1",
    "https://api.example.com:8443/v1"
  ];
  for (const value of invalid) assert.throws(() => normalizeApiBaseUrl(value), value);
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

test("Durable Object rate limiter persists counters and resets at the window boundary", async () => {
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
