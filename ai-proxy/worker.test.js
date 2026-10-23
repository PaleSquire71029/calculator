import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { createHash } from "node:crypto";
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

test("admin keeps Zhixing AI settings isolated from the learning and calculator profile", async () => {
  const isolatedEnv = testEnv({ ADMIN_PASSWORD: "test-admin-password" });
  const loginFor = async (app, ip) => worker.fetch(new Request("https://worker.example.test/admin/login?app=" + app, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, "CF-Connecting-IP": ip },
    body: JSON.stringify({ password: "test-admin-password" })
  }), isolatedEnv);
  const [zhixingLogin, learningLogin] = await Promise.all([
    loginFor("zhixing-ai", "198.51.100.93"),
    loginFor("learning", "198.51.100.94")
  ]);
  assert.equal(zhixingLogin.status, 200);
  assert.equal(learningLogin.status, 200);
  const zhixingToken = (await zhixingLogin.json()).token;
  const learningToken = (await learningLogin.json()).token;
  const headersFor = token => ({ Origin: origin, Authorization: "Bearer " + token, "Content-Type": "application/json" });
  const zhixingHeaders = headersFor(zhixingToken);
  const learningHeaders = headersFor(learningToken);

  const crossScope = await worker.fetch(new Request("https://worker.example.test/admin/settings?app=learning", {
    headers: zhixingHeaders
  }), isolatedEnv);
  assert.equal(crossScope.status, 401, "a Zhixing AI session must not access the learning profile");

  const learningDefaultsResponse = await worker.fetch(new Request("https://worker.example.test/admin/defaults?app=learning", { headers: learningHeaders }), isolatedEnv);
  assert.equal(learningDefaultsResponse.status, 200);
  const learningPrompts = await learningDefaultsResponse.json();
  const seedLegacy = await worker.fetch(new Request("https://worker.example.test/admin/settings?app=learning", {
    method: "PUT",
    headers: learningHeaders,
    body: JSON.stringify({
      apiBaseUrl: "https://api.example.com/v1",
      model: "legacy-shared-model",
      temperature: 0.3,
      maxTokens: 256,
      prompts: learningPrompts,
      apiKey: ""
    })
  }), isolatedEnv);
  assert.equal(seedLegacy.status, 200);

  const defaultsResponse = await worker.fetch(new Request("https://worker.example.test/admin/defaults?app=zhixing-ai", { headers: zhixingHeaders }), isolatedEnv);
  assert.equal(defaultsResponse.status, 200);
  const prompts = await defaultsResponse.json();
  assert.match(prompts.chat.general, /知行AI助手/);
  assert.doesNotMatch(prompts.chat.general, /多学科学习助手/);
  const inherited = await worker.fetch(new Request("https://worker.example.test/admin/settings?app=zhixing-ai", { headers: zhixingHeaders }), isolatedEnv);
  assert.equal(inherited.status, 200);
  assert.equal((await inherited.json()).model, "legacy-shared-model");
  const save = await worker.fetch(new Request("https://worker.example.test/admin/settings?app=zhixing-ai", {
    method: "PUT",
    headers: zhixingHeaders,
    body: JSON.stringify({
      apiBaseUrl: "https://api.example.com/v1",
      model: "zhixing-only-model",
      temperature: 0.5,
      maxTokens: 128,
      prompts,
      apiKey: ""
    })
  }), isolatedEnv);
  assert.equal(save.status, 200);
  const zhixingSettings = await worker.fetch(new Request("https://worker.example.test/admin/settings?app=zhixing-ai", { headers: zhixingHeaders }), isolatedEnv);
  const learningSettings = await worker.fetch(new Request("https://worker.example.test/admin/settings?app=learning", { headers: learningHeaders }), isolatedEnv);
  assert.equal(zhixingSettings.status, 200);
  assert.equal(learningSettings.status, 200);
  assert.equal((await zhixingSettings.json()).model, "zhixing-only-model");
  assert.equal((await learningSettings.json()).model, "legacy-shared-model");
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
  assert.deepEqual(await response.json(), { ok: true, configured: true, model: "vision-model", app: "learning" });
});

test("public model picker returns provider model IDs without exposing the API key", async () => {
  const originalFetch = globalThis.fetch;
  const appOrigin = "https://ai.zhixing.us.ci";
  let requestedUrl = "";
  globalThis.fetch = async (url, init) => {
    requestedUrl = String(url);
    assert.equal(init.headers.Authorization, "Bearer test-key");
    return new Response(JSON.stringify({ data: [{ id: "z-model" }, { id: "a-model" }, { id: "z-model" }] }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  };
  try {
    const isolatedEnv = testEnv({ ALLOWED_ORIGINS: origin + "," + appOrigin });
    const response = await worker.fetch(new Request("https://worker.example.test/api/models?app=zhixing-ai", {
      headers: { Origin: appOrigin, "CF-Connecting-IP": "198.51.100.91" }
    }), isolatedEnv);
    assert.equal(response.status, 200);
    assert.equal(requestedUrl, "https://api.example.com/v1/models");
    const body = await response.json();
    assert.deepEqual(body.models, ["a-model", "z-model"]);
    assert.equal(body.app, "zhixing-ai");
    assert.equal(JSON.stringify(body).includes("test-key"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Zhixing AI can pick a model and append a lightweight custom prompt without changing learning prompts", async () => {
  const originalFetch = globalThis.fetch;
  let sentBody;
  globalThis.fetch = async (url, init) => {
    sentBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      model: sentBody.model,
      choices: [{ message: { content: "好的。" } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const isolatedEnv = testEnv();
    const response = await worker.fetch(req({
      app: "zhixing-ai",
      mode: "general",
      model: "custom-model-id",
      systemPrompt: "回答尽量简洁。",
      messages: [userMessage]
    }, "198.51.100.92"), isolatedEnv);
    assert.equal(response.status, 200);
    assert.equal(sentBody.model, "custom-model-id");
    assert.match(sentBody.messages[0].content, /知行AI助手/);
    assert.match(sentBody.messages[0].content, /回答尽量简洁/);
    assert.doesNotMatch(sentBody.messages[0].content, /多学科学习助手/);
    assert.equal((await response.json()).model, "custom-model-id");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects non-JSON chat requests before parsing the body", async () => {
  const response = await worker.fetch(new Request("https://worker.example.test/api/chat", {
    method: "POST",
    headers: { Origin: origin, "CF-Connecting-IP": "198.51.100.177", "Content-Type": "text/plain" },
    body: JSON.stringify({ messages: [userMessage] })
  }), env);
  assert.equal(response.status, 415);
});

test("rejects non-JSON admin mutations before authentication or parsing", async () => {
  const response = await worker.fetch(new Request("https://worker.example.test/admin/login", {
    method: "POST",
    headers: { Origin: origin, "CF-Connecting-IP": "198.51.100.178", "Content-Type": "text/plain" },
    body: "password=guess"
  }), testEnv({ ADMIN_PASSWORD: "long-test-password" }));
  assert.equal(response.status, 415);
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

test("AI analysis generates core first and accepts details only with the shown core", async () => {
  const originalFetch = globalThis.fetch;
  const sentBodies = [];
  globalThis.fetch = async (url, init) => {
    sentBodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({
      model: "vision-model",
      choices: [{ message: { content: "【核心结论】x=2 或 x=3。" } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const context = {
    title: "方程求解",
    view: "equation",
    inputs: "x^2-5x+6=0",
    outputs: "x=2 或 x=3",
    details: "本地计算结果待核验"
  };
  try {
    const core = await worker.fetch(req({
      task: "analysis", action: "analyze", mode: "equation",
      analysisStage: "core", context
    }, "198.51.100.80"), env);
    assert.equal(core.status, 200);
    assert.match(sentBodies[0].messages[0].content, /第一阶段/);
    assert.match(sentBodies[0].messages[0].content, /只允许输出一个章节/);
    assert.match(sentBodies[0].messages[0].content, /不要输出关键信息/);

    const details = await worker.fetch(req({
      task: "analysis", action: "analyze", mode: "equation",
      analysisStage: "details", coreAnswer: "【核心结论】x=2 或 x=3。", context
    }, "198.51.100.81"), env);
    assert.equal(details.status, 200);
    assert.match(sentBodies[1].messages[0].content, /第二阶段/);
    assert.match(sentBodies[1].messages[0].content, /不要重写或重复核心结论/);
    assert.match(sentBodies[1].messages[1].content, /previously_shown_core_conclusion/);
    assert.match(sentBodies[1].messages[1].content, /x=2 或 x=3/);

    const missingCore = await worker.fetch(req({
      task: "analysis", action: "analyze", mode: "equation",
      analysisStage: "details", context
    }, "198.51.100.82"), env);
    assert.equal(missingCore.status, 400);
    assert.match((await missingCore.json()).error, /先有核心结论/);
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
  assert.match(html, /analysisStage:stage/);
  assert.match(html, /function getCoreAnswerText\(/);
  assert.match(html, /function renderAdditionalAnswer\(/);
  assert.match(html, /data-zx-ai-generate-details/);
  assert.match(html, /generate,'','details'/);
  assert.match(html, /panel\.dataset\.zxAiCoreAnswer=getCoreAnswerText/);
  assert.match(html, /用户针对当前计算结果的追问/);
  assert.match(html, /el\.closest\('\.zx-ai-result'\)\|\|el\.type==='hidden'/);
  assert.match(html, /value\.includes\('\:\/\/'\)/);
  assert.doesNotMatch(html, /AI 服务设置|data-zx-ai-proxy|data-zx-ai-save-proxy|AI Worker 地址/);
  assert.doesNotMatch(html, /content\.style\.maxHeight=content\.scrollHeight/);
  assert.match(html, /transition:opacity \.15s ease,transform \.15s/);
  assert.match(html, /new AbortController\(\)/);
  assert.match(html, /requestTimeout=window\.setTimeout/);
  assert.match(html, /id="zx-light-surface-audit"/);
  assert.match(html, /\.zx-chem-keyboard,#chemKeyboard:not\(\[hidden\]\).*?background:rgba\(249,252,255,\.97\)!important/s);
  assert.match(html, /\.function-graph\{background:rgba\(255,255,255,\.94\)!important/);
  assert.match(html, /function setResultCollapsed\(panel,collapsed\)/);
  assert.match(html, /window\.MathJax\.typesetClear\(\[node\]\)/);
  assert.doesNotMatch(html, /if\(node\.querySelector\('mjx-container'\)\)return/);
  assert.match(html, /class="zx-ai-result-content"/);
  assert.match(html, /data-zx-ai-collapsed-preview/);
  assert.match(html, /setResultCollapsed\(panel,panel\.dataset\.collapsed!=='true'\)/);
  assert.match(html, /@keyframes zx-ai-status-spin/);
  assert.match(html, /@keyframes zx-ai-card-in/);
  assert.doesNotMatch(html, /addEventListener\('click',\(\)=>\{panel\.hidden=true;\}\)/);
});

test("AI frontend inline JavaScript parses without syntax errors", () => {
  const html = readFileSync(new URL("../ai.html", import.meta.url), "utf8");
  const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  const lastInline = inlineScripts.at(-1);
  assert.ok(lastInline && lastInline[1], "inline script must exist");
  assert.doesNotThrow(() => new Script(lastInline[1]));
  assert.match(html, /mathTypesetQueue=Promise\.resolve\(\)/);
  assert.match(html, /window\.MathJax\.typesetClear\(\[node\]\)/);
  assert.match(html, /cdnjs\.cloudflare\.com\/ajax\/libs\/mathjax/);
});


test("shared account login asset parses without syntax errors", () => {
  const source = readFileSync(new URL("../assets/account-auth.js", import.meta.url), "utf8");
  assert.doesNotThrow(() => new Script(source));
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
  assert.match(html, /id="zx-admin-layout-analytics"/);
  assert.match(html, /margin-left:calc\(\(100% - 100vw\)\/2\)/);
  assert.match(html, /id="chartTraffic"/);
  assert.match(html, /id="chartStatus"/);
  assert.match(html, /id="chartModes"/);
  assert.match(html, /id="chartTokens"/);
  assert.match(html, /class="analytics-block analytics-overview"/);
  assert.match(html, /chart-line-success/);
  assert.match(html, /svg\.append\(svgElement\("path"/);
  assert.match(html, /\.model-catalog:not\(\[hidden\]\)\{max-height:310px/);
  assert.doesNotMatch(html, /data-panel="records">[\s\S]{0,800}class="analytics-block/);
  assert.match(html, /function renderUsageCharts\(\)/);
  assert.match(html, /item\.usageAvailable===true/);
  assert.match(html, /renderUsageCharts\(\);/);
  assert.match(html, /NotoSansSC-400\.woff2\?v=20261018/);
  assert.match(html, /NotoSansSC-700\.woff2\?v=20261018/);
  assert.match(html, /#modelPicker\{[\s\S]*?height:46px!important;[\s\S]*?max-height:46px!important;[\s\S]*?flex:none!important;/);
  assert.match(html, /\.field \.row:has\(#modelPicker\)[\s\S]*?display:grid!important/);
  assert.match(html, /\.model-catalog-list\{max-height:155px!important\}/);
});




test("admin page CSP only authorizes the current inline script hashes", () => {
  const html = readFileSync(new URL("../ai-admin.html", import.meta.url), "utf8");
  const policy = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert.ok(policy, "admin CSP must be present");
  const csp = policy[1];
  const scriptDirective = csp.split(";").map(value => value.trim()).find(value => value.startsWith("script-src "));
  assert.ok(scriptDirective, "admin CSP must contain script-src");
  assert.doesNotMatch(scriptDirective, /unsafe-inline|unsafe-eval/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-src 'none'/);

  const declaredHashes = [...scriptDirective.matchAll(/'sha256-([^']+)'/g)].map(match => match[1]).sort();
  const actualHashes = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)]
    .map(match => createHash("sha256").update(match[1]).digest("base64")).sort();
  assert.deepEqual(declaredHashes, actualHashes, "CSP hashes must be refreshed whenever an inline script changes");
});

test("admin verification and startup requests always time out instead of hanging", () => {
  const html = readFileSync(new URL("../ai-admin.html", import.meta.url), "utf8");
  assert.match(html, /new AbortController\(\)/);
  assert.match(html, /path === "\/admin\/login" \? 12000 : 15000/);
  assert.match(html, /请求超时/);
  assert.match(html, /正在加载管理配置/);
  assert.match(html, /window\.clearTimeout\(timeoutId\)/);
  assert.match(html, /const \[data, promptDefaults\] = await Promise\.all/);
  assert.match(html, /加载超时，使用备用字体/);

  const adminSource = readFileSync(new URL("./src/admin.js", import.meta.url), "utf8");
  assert.equal((adminSource.match(/signal: AbortSignal\.timeout\(8000\)/g) || []).length, 3);
});


test("API responses set baseline security headers", async () => {
  const response = await worker.fetch(new Request("https://worker.example.test/health", {
    headers: { Origin: origin }
  }), env);
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Content-Security-Policy"), "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  assert.equal(response.headers.get("Permissions-Policy"), "camera=(), microphone=(), geolocation=()");
});

test("changing the admin password invalidates existing sessions even with a separate session secret", async () => {
  const store = createStoreBinding();
  const before = testEnv({
    ADMIN_PASSWORD: "previous-test-admin-password",
    ADMIN_SESSION_SECRET: "a-long-independent-session-secret-for-tests",
    ADMIN_STORE: store
  });
  const login = await worker.fetch(new Request("https://worker.example.test/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, "CF-Connecting-IP": "198.51.100.110" },
    body: JSON.stringify({ password: "previous-test-admin-password" })
  }), before);
  assert.equal(login.status, 200);
  const token = (await login.json()).token;
  const rotated = { ...before, ADMIN_PASSWORD: "new-test-admin-password" };
  const after = await worker.fetch(new Request("https://worker.example.test/admin/settings", {
    headers: { Origin: origin, Authorization: "Bearer " + token }
  }), rotated);
  assert.equal(after.status, 401);
});


test("upstream error messages never echo the configured API key", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { message: "Provider rejected request with key test-key; Authorization: Bearer test-key" }
  }), { status: 500, headers: { "Content-Type": "application/json" } });
  try {
    const response = await worker.fetch(req({ mode: "general", messages: [userMessage] }, "198.51.100.121"), env);
    assert.equal(response.status, 502);
    const body = await response.text();
    assert.doesNotMatch(body, /test-key/);
    assert.match(body, /已隐藏/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public model listing and authenticated admin probes redact upstream credentials", async () => {
  const originalFetch = globalThis.fetch;
  const secret = "test-key";
  const echoed = "Provider echoed " + secret + "; Authorization: Bearer " + secret;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { message: echoed },
    message: echoed
  }), { status: 500, headers: { "Content-Type": "application/json" } });

  try {
    const isolatedEnv = testEnv({
      AI_API_KEY: secret,
      ADMIN_PASSWORD: "test-admin-password",
      ALLOWED_ORIGINS: origin
    });
    const publicModels = await worker.fetch(new Request(
      "https://worker.example.test/api/models?app=learning",
      { headers: { Origin: origin, "CF-Connecting-IP": "198.51.100.122" } }
    ), isolatedEnv);
    assert.equal(publicModels.status, 502);
    const publicBody = await publicModels.text();
    assert.doesNotMatch(publicBody, /test-key/);

    const login = await worker.fetch(new Request("https://worker.example.test/admin/login?app=learning", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "CF-Connecting-IP": "198.51.100.123"
      },
      body: JSON.stringify({ password: "test-admin-password" })
    }), isolatedEnv);
    assert.equal(login.status, 200);
    const token = (await login.json()).token;
    const headers = {
      "Content-Type": "application/json",
      Origin: origin,
      Authorization: "Bearer " + token,
      "CF-Connecting-IP": "198.51.100.123"
    };
    const body = JSON.stringify({
      apiBaseUrl: "https://api.example.com/v1",
      apiKey: secret,
      model: "vision-model"
    });

    for (const route of ["/admin/models?app=learning", "/admin/test?app=learning"]) {
      const response = await worker.fetch(new Request("https://worker.example.test" + route, {
        method: "POST",
        headers,
        body
      }), isolatedEnv);
      assert.equal(response.status, 502, route + " should report a controlled provider error");
      assert.doesNotMatch(await response.text(), /test-key/, route + " must not echo the configured API key");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});



test("cloud history rejects unknown product scopes", async () => {
  const response = await worker.fetch(new Request("https://worker.example.test/api/history/conversations?app=unknown", {
    headers: { Origin: origin, "CF-Connecting-IP": "198.51.100.210" }
  }), testEnv());
  assert.equal(response.status, 400);
});

test("cloud history fails closed until Supabase secrets are configured", async () => {
  const response = await worker.fetch(new Request("https://worker.example.test/api/history/conversations?app=learning", {
    headers: { Origin: origin, "CF-Connecting-IP": "198.51.100.211" }
  }), testEnv());
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /尚未完成后端密钥配置/);
});
