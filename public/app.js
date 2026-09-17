async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (res.status === 401) {
    location.href = "/login";
    throw new Error("unauthorized");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, attrs);
  for (const child of children) node.append(child);
  return node;
}

function badge(status) {
  const span = el("span", { className: "badge " + (status || "unknown"), textContent: status || "unknown" });
  return span;
}

function formatUptime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return h + "س " + m + "د";
  if (m) return m + "د " + (s % 60) + "ث";
  return s + "ث";
}

function statTile(label, value, extraClass) {
  const box = el("div", { className: "stat" });
  box.append(el("span", { className: "stat-label", textContent: label }));
  box.append(el("span", { className: "stat-value" + (extraClass ? " " + extraClass : ""), textContent: value }));
  return box;
}

async function loadHealth() {
  const data = await api("/api/health");
  const box = document.getElementById("health-summary");
  box.className = "stat-grid";
  box.innerHTML = "";
  box.append(
    statTile("الحالة", data.ok ? "يعمل" : "متوقف", data.ok ? "ok" : "bad"),
    statTile("جلسات MCP", String(data.mcp?.sessions ?? 0)),
    statTile("مفتاح API", data.apiKeyConfigured ? "مضبوط" : "غير مضبوط", data.apiKeyConfigured ? "ok" : "warn"),
    statTile("مدة التشغيل", formatUptime(data.uptimeSec)),
  );
}

async function loadMe() {
  const me = await api("/api/me");
  document.getElementById("who").textContent = "المستخدم: " + me.username;
}

async function loadSettings() {
  const data = await api("/api/settings");
  document.getElementById("key-mask").textContent = data.apiKeyMasked || "غير مضبوط";
  const box = document.getElementById("settings");
  box.innerHTML = "";
  for (const item of data.items) {
    const wrap = el("div", { className: "field" });
    wrap.append(el("label", { textContent: item.key }));
    const input = el("input", { value: item.value });
    input.dataset.key = item.key;
    wrap.append(input);
    box.append(wrap);
  }
  document.getElementById("mcp-help").textContent =
    "عنوان MCP للعملاء: " + data.mcpUrl + " — أضف ترويسة Authorization: Bearer مع رمز MCP المعروض في ملف .env على السيرفر (MCP_AUTH_TOKEN).";
}

async function loadReposAndModels() {
  const repoSel = document.getElementById("repo");
  const modelSel = document.getElementById("model");
  repoSel.innerHTML = "";
  modelSel.innerHTML = "";
  modelSel.append(el("option", { value: "", textContent: "(الافتراضي)" }));
  try {
    const repos = await api("/api/repos");
    for (const item of repos.items || []) {
      repoSel.append(el("option", { value: item.url, textContent: item.url }));
    }
    if (!repoSel.options.length) {
      repoSel.append(el("option", { value: "", textContent: "لا توجد مستودعات — أضف المفتاح أولًا" }));
    }
  } catch (err) {
    repoSel.append(el("option", { value: "", textContent: err.message }));
  }
  try {
    const models = await api("/api/models");
    for (const item of models.items || []) {
      modelSel.append(el("option", { value: item.id, textContent: item.displayName || item.id }));
    }
  } catch {
    // models optional until API key is set
  }
}

function extLink(href, text) {
  return el("a", { href, target: "_blank", rel: "noopener noreferrer", textContent: text });
}

async function loadAgents() {
  const body = document.getElementById("agents");
  body.innerHTML = "";
  try {
    const data = await api("/api/agents");
    if (!data.items?.length) {
      body.append(el("p", { className: "muted empty", textContent: "لا توجد agents بعد." }));
      return;
    }
    for (const agent of data.items) {
      const card = el("article", { className: "item-card" });
      const title = el("div", { className: "min-0" });
      title.append(
        el("strong", { textContent: agent.name || agent.id }),
        el("div", { className: "muted mono", textContent: agent.id }),
      );
      const top = el("div", { className: "item-top" });
      top.append(title, badge(agent.status));
      card.append(top);

      const meta = el("div", { className: "item-meta" });
      if (agent.prUrl) meta.append(extLink(agent.prUrl, "فتح PR"));
      if (agent.branch) meta.append(el("span", { className: "muted mono", textContent: agent.branch }));
      if (agent.url) meta.append(extLink(agent.url, "فتح في Cursor"));
      if (meta.childNodes.length) card.append(meta);

      const follow = el("div", { className: "follow-row" });
      const input = el("input", { placeholder: "تعليمات لاحقة..." });
      const btn = el("button", { className: "secondary", type: "button", textContent: "إرسال" });
      btn.addEventListener("click", async () => {
        if (!input.value.trim()) return;
        btn.disabled = true;
        try {
          await api("/api/agents/" + encodeURIComponent(agent.id) + "/followup", {
            method: "POST",
            body: JSON.stringify({ prompt: input.value.trim() }),
          });
          input.value = "";
          await loadAgents();
        } catch (err) {
          alert(err.message);
        } finally {
          btn.disabled = false;
        }
      });
      follow.append(input, btn);
      card.append(follow);
      body.append(card);
    }
  } catch (err) {
    body.append(el("p", { className: "flash", textContent: err.message }));
  }
}

document.getElementById("save-key").addEventListener("click", async () => {
  const msg = document.getElementById("key-msg");
  msg.textContent = "";
  try {
    const data = await api("/api/settings/api-key", {
      method: "PUT",
      body: JSON.stringify({ apiKey: document.getElementById("api-key").value }),
    });
    document.getElementById("api-key").value = "";
    document.getElementById("key-mask").textContent = data.masked;
    msg.className = "ok";
    msg.textContent = "تم الحفظ.";
    await loadHealth();
    await loadReposAndModels();
  } catch (err) {
    msg.className = "flash";
    msg.textContent = err.message;
  }
});

document.getElementById("launch").addEventListener("click", async () => {
  const msg = document.getElementById("launch-msg");
  msg.textContent = "";
  try {
    const data = await api("/api/agents", {
      method: "POST",
      body: JSON.stringify({
        repository: document.getElementById("repo").value,
        prompt: document.getElementById("prompt").value,
        model: document.getElementById("model").value || undefined,
      }),
    });
    document.getElementById("prompt").value = "";
    msg.className = "ok";
    if (data.modelFallback) {
      msg.textContent = "تم الإطلاق مع الإشعار. النموذج المختار غير متاح مع مسار الـ webhook، فاستُخدم الافتراضي.";
    } else if (data.webhookAttached) {
      msg.textContent = "تم الإطلاق. سيُرسل إشعار تيليجرام عند الانتهاء أو الفشل.";
    } else {
      msg.textContent = "تم الإطلاق.";
    }
    await loadAgents();
  } catch (err) {
    msg.className = "flash";
    msg.textContent = err.message;
  }
});

document.getElementById("save-settings").addEventListener("click", async () => {
  const msg = document.getElementById("settings-msg");
  const settings = [...document.querySelectorAll("#settings input")].map((input) => ({
    key: input.dataset.key,
    value: input.value,
  }));
  const newKey = document.getElementById("new-key").value.trim();
  const newValue = document.getElementById("new-value").value;
  if (newKey) settings.push({ key: newKey, value: newValue });
  try {
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ settings }) });
    document.getElementById("new-key").value = "";
    document.getElementById("new-value").value = "";
    msg.className = "ok";
    msg.textContent = "تم الحفظ.";
    await loadSettings();
  } catch (err) {
    msg.className = "flash";
    msg.textContent = err.message;
  }
});

document.getElementById("refresh").addEventListener("click", () => loadAgents());
document.getElementById("logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  location.href = "/login";
});

async function loadTelegram() {
  const data = await api("/api/telegram");
  document.getElementById("tg-token-mask").textContent = data.botTokenMasked || "غير مضبوط";
  document.getElementById("tg-chat-mask").textContent = data.chatIdMasked || "غير مضبوط";
  document.getElementById("tg-enabled").checked = Boolean(data.enabled);
  document.getElementById("tg-webhook-url").value = data.webhookUrl || "";
  document.getElementById("tg-webhook-secret").value = data.webhookSecret || "";
  const body = document.getElementById("tg-log");
  body.innerHTML = "";
  if (!data.recent?.length) {
    body.append(el("tr", {}, [el("td", { colSpan: 4, textContent: "لا إشعارات بعد." })]));
    return;
  }
  for (const row of data.recent) {
    body.append(
      el("tr", {}, [
        el("td", { textContent: row.ts || "" }),
        el("td", { textContent: row.agent_id || "" }),
        el("td", { textContent: row.status || "" }),
        el("td", { textContent: row.sent ? "نعم" : "لا" }),
      ]),
    );
  }
}

document.getElementById("tg-save").addEventListener("click", async () => {
  const msg = document.getElementById("tg-msg");
  msg.textContent = "";
  try {
    const body = { enabled: document.getElementById("tg-enabled").checked };
    const token = document.getElementById("tg-token").value.trim();
    const chatId = document.getElementById("tg-chat").value.trim();
    if (token) body.botToken = token;
    if (chatId) body.chatId = chatId;
    const data = await api("/api/telegram", { method: "PUT", body: JSON.stringify(body) });
    document.getElementById("tg-token").value = "";
    document.getElementById("tg-chat").value = "";
    document.getElementById("tg-token-mask").textContent = data.botTokenMasked || "غير مضبوط";
    msg.className = "ok";
    msg.textContent = "تم الحفظ.";
    await loadTelegram();
  } catch (err) {
    msg.className = "flash";
    msg.textContent = err.message;
  }
});

document.getElementById("tg-test").addEventListener("click", async () => {
  const msg = document.getElementById("tg-msg");
  msg.textContent = "";
  try {
    await api("/api/telegram/test", { method: "POST", body: "{}" });
    msg.className = "ok";
    msg.textContent = "تم إرسال رسالة الاختبار.";
  } catch (err) {
    msg.className = "flash";
    msg.textContent = err.message;
  }
});

async function copyField(id, label) {
  const input = document.getElementById(id);
  const value = input.value;
  const status = document.getElementById("tg-copy-status");
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      input.focus();
      input.select();
      document.execCommand("copy");
    }
    status.className = "ok";
    status.textContent = "تم نسخ " + label + ".";
  } catch {
    input.focus();
    input.select();
    status.className = "flash";
    status.textContent = "تعذر النسخ تلقائيًا. حدّد الحقل وانسخ يدويًا.";
  }
}

document.getElementById("copy-webhook-url").addEventListener("click", () => copyField("tg-webhook-url", "الرابط"));
document.getElementById("copy-webhook-secret").addEventListener("click", () => copyField("tg-webhook-secret", "السر"));

function syncHeaderOffset() {
  const bar = document.querySelector(".topbar");
  if (!bar) return;
  const h = Math.ceil(bar.getBoundingClientRect().height);
  document.documentElement.style.setProperty("--header-h", h + "px");
}

function setupSectionNav() {
  const links = [...document.querySelectorAll(".nav a[href^='#']")];
  const sections = links.map((a) => document.querySelector(a.getAttribute("href"))).filter(Boolean);
  if (!sections.length) return;
  const sync = () => {
    syncHeaderOffset();
    const offset = (document.querySelector(".topbar")?.getBoundingClientRect().height || 64) + 16;
    let current = sections[0];
    for (const sec of sections) {
      if (sec.getBoundingClientRect().top <= offset) current = sec;
    }
    for (const a of links) {
      const on = a.getAttribute("href") === "#" + current.id;
      a.classList.toggle("active", on);
      if (on) a.setAttribute("aria-current", "location");
      else a.removeAttribute("aria-current");
    }
  };
  window.addEventListener("scroll", sync, { passive: true });
  window.addEventListener("resize", syncHeaderOffset);
  sync();
}

setupSectionNav();
Promise.all([loadMe(), loadHealth(), loadSettings(), loadReposAndModels(), loadAgents(), loadTelegram()]).catch(() => {});
