(function () {
  let projects = [];
  let current = null;
  let full = null;
  let activeTab = "tasks";

  function msg(text, ok) {
    const el = document.getElementById("memory-msg");
    el.className = ok ? "ok" : "flash";
    el.textContent = text || "";
  }

  function projectId() {
    return Number(document.getElementById("memory-project").value || 0);
  }

  async function loadProjects() {
    const data = await api("/api/memory/projects");
    projects = data.items || [];
    const sel = document.getElementById("memory-project");
    const prev = sel.value;
    sel.innerHTML = "";
    if (!projects.length) {
      sel.append(el("option", { value: "", textContent: "لا مشاريع بعد" }));
      current = null;
      full = null;
      render();
      return;
    }
    for (const p of projects) {
      sel.append(el("option", { value: String(p.id), textContent: p.name }));
    }
    sel.value = prev && [...sel.options].some((o) => o.value === prev) ? prev : String(projects[0].id);
    await loadFull();
  }

  async function loadFull() {
    const id = projectId();
    if (!id) return;
    full = await api("/api/memory/projects/" + id);
    current = full.project;
    render();
  }

  function section(title, children) {
    const box = el("div", {});
    box.append(el("h2", { textContent: title }));
    for (const child of children) box.append(child);
    return box;
  }

  function empty(text) {
    return el("p", { className: "muted", textContent: text });
  }

  function reasonPrompt(label) {
    const value = window.prompt(label || "السبب");
    return value ? value.trim() : "";
  }

  function taskCard(task, proposed) {
    const box = el("div", { className: "note-box" });
    box.append(
      el("div", {}, [
        badge(task.status),
        el("strong", { textContent: " " + task.title }),
      ]),
    );
    if (task.description) box.append(el("p", { textContent: task.description }));
    if (task.evidence) box.append(el("p", { className: "muted", textContent: "الدليل: " + task.evidence }));
    if (task.auto_check_note) box.append(el("p", { className: "muted", textContent: task.auto_check_note }));
    if (task.review_notes) box.append(el("p", { className: "muted", textContent: "ملاحظات: " + task.review_notes }));
    box.append(el("p", { className: "muted", textContent: "مقترح من: " + (task.proposed_by || "—") }));
    if (proposed) {
      const row = el("p", { className: "row" });
      const confirmBtn = el("button", { textContent: "تأكيد" });
      const rejectBtn = el("button", { className: "danger", textContent: "رفض" });
      const fixBtn = el("button", { className: "secondary", textContent: "طلب إصلاح" });
      confirmBtn.addEventListener("click", () => act("/api/memory/tasks/" + task.id + "/confirm", {}));
      rejectBtn.addEventListener("click", () => {
        const reason = reasonPrompt("سبب الرفض");
        if (!reason) return;
        act("/api/memory/tasks/" + task.id + "/reject", { reason });
      });
      fixBtn.addEventListener("click", () => {
        const reason = reasonPrompt("سبب طلب الإصلاح");
        if (!reason) return;
        act("/api/memory/tasks/" + task.id + "/request-fix", { reason });
      });
      row.append(confirmBtn, rejectBtn, fixBtn);
      box.append(row);
    }
    return box;
  }

  async function act(path, body) {
    msg("");
    try {
      await api(path, { method: "POST", body: JSON.stringify(body || {}) });
      msg("تم.", true);
      await loadFull();
    } catch (err) {
      msg(err.message);
    }
  }

  function renderTasks() {
    const verified = full?.verified?.tasks || [];
    const draft = full?.draft?.tasks || [];
    const proposed = draft.filter((t) => t.status === "done_proposed");
    const other = draft.filter((t) => t.status !== "done_proposed");
    const wrap = el("div", {});
    wrap.append(section("معتمدة", verified.length ? verified.map((t) => taskCard(t, false)) : [empty("لا مهام معتمدة بعد.")]));
    wrap.append(
      section(
        "مقترحة بانتظار تأكيدك",
        proposed.length ? proposed.map((t) => taskCard(t, true)) : [empty("لا مقترحات بانتظار التأكيد.")],
      ),
    );
    wrap.append(section("مسودات أخرى", other.length ? other.map((t) => taskCard(t, false)) : [empty("لا مسودات أخرى.")]));
    return wrap;
  }

  function renderErrors() {
    const open = full?.errors?.open || [];
    const resolved = full?.errors?.resolved || [];
    const wrap = el("div", {});
    wrap.append(
      section(
        "مفتوحة",
        open.length
          ? open.map((e) =>
              el("div", { className: "note-box" }, [
                el("strong", { textContent: e.title }),
                el("p", { textContent: e.description || "" }),
                el("p", { className: "muted", textContent: e.root_cause || "" }),
              ]),
            )
          : [empty("لا أخطاء مفتوحة.")],
      ),
    );
    wrap.append(
      section(
        "محلولة",
        resolved.length
          ? resolved.map((e) =>
              el("div", { className: "note-box" }, [
                el("strong", { textContent: e.title }),
                el("p", { className: "muted", textContent: e.resolution_notes || "" }),
              ]),
            )
          : [empty("لا أخطاء محلولة.")],
      ),
    );
    return wrap;
  }

  function renderPlans() {
    const verified = full?.verified?.plan_prompts || [];
    const draft = full?.draft?.plan_prompts || [];
    const wrap = el("div", {});
    wrap.append(
      section(
        "معتمدة",
        verified.length
          ? verified.map((p) =>
              el("div", { className: "note-box" }, [
                el("p", { className: "muted", textContent: "v" + p.version_number + " — " + p.created_at }),
                el("pre", { className: "capsule", textContent: p.prompt_text }),
              ]),
            )
          : [empty("لا خطط معتمدة.")],
      ),
    );
    wrap.append(
      section(
        "مسودة",
        draft.length
          ? draft.map((p) => {
              const box = el("div", { className: "note-box" });
              box.append(
                el("p", { className: "muted", textContent: "v" + p.version_number + " — " + p.created_at }),
                el("pre", { className: "capsule", textContent: p.prompt_text }),
              );
              const btn = el("button", { textContent: "اعتماد" });
              btn.addEventListener("click", () => act("/api/memory/plan-prompts/" + p.id + "/verify", {}));
              box.append(btn);
              return box;
            })
          : [empty("لا مسودات خطة.")],
      ),
    );
    return wrap;
  }

  function renderNotes(kind) {
    const verified = full?.verified?.[kind] || [];
    const draft = full?.draft?.[kind] || [];
    const path = kind === "ui_ux_notes" ? "/api/memory/ui-ux/" : "/api/memory/ux-notes/";
    const wrap = el("div", {});
    wrap.append(
      section(
        "معتمدة",
        verified.length
          ? verified.map((n) =>
              el("div", { className: "note-box" }, [
                el("strong", { textContent: n.category || n.flow_name || "" }),
                el("p", { textContent: n.notes || n.description || "" }),
              ]),
            )
          : [empty("لا ملاحظات معتمدة.")],
      ),
    );
    wrap.append(
      section(
        "مسودة — بانتظار اعتمادك",
        draft.length
          ? draft.map((n) => {
              const box = el("div", { className: "note-box" });
              box.append(
                el("strong", { textContent: n.category || n.flow_name || "" }),
                el("p", { textContent: n.notes || n.description || "" }),
              );
              const btn = el("button", { textContent: "اعتماد" });
              btn.addEventListener("click", () => act(path + n.id + "/verify", {}));
              box.append(btn);
              return box;
            })
          : [empty("لا مسودات.")],
      ),
    );
    return wrap;
  }

  function renderRules() {
    const rules = full?.verified?.rules || [];
    if (!rules.length) return empty("لا قواعد معتمدة.");
    const wrap = el("div", {});
    for (const r of rules) {
      wrap.append(
        el("div", { className: "note-box" }, [
          badge("approved"),
          el("p", { textContent: r.rule_text }),
        ]),
      );
    }
    return wrap;
  }

  function renderSuggestions() {
    const items = (full?.draft?.rules_suggestions || []).filter((s) => s.status === "pending");
    if (!items.length) return empty("لا اقتراحات بانتظار موافقتك.");
    const wrap = el("div", {});
    for (const s of items) {
      const box = el("div", { className: "note-box" });
      box.append(el("p", { textContent: s.suggested_rule_text }));
      box.append(el("p", { className: "muted", textContent: (s.suggested_by || "") + " — " + (s.reason || "") }));
      const row = el("p", { className: "row" });
      const accept = el("button", { textContent: "قبول" });
      const reject = el("button", { className: "danger", textContent: "رفض" });
      accept.addEventListener("click", () => act("/api/memory/rules-suggestions/" + s.id + "/accept", {}));
      reject.addEventListener("click", () => {
        const reason = reasonPrompt("سبب الرفض") || "مرفوض";
        act("/api/memory/rules-suggestions/" + s.id + "/reject", { reason });
      });
      row.append(accept, reject);
      box.append(row);
      wrap.append(box);
    }
    return wrap;
  }

  function renderPrs() {
    const items = full?.pr_links || [];
    if (!items.length) return empty("لا روابط PR.");
    const wrap = el("div", {});
    for (const p of items) {
      wrap.append(
        el("div", { className: "note-box" }, [
          el("a", { href: p.pr_url, target: "_blank", textContent: p.pr_url }),
          el("p", { textContent: p.comment || "" }),
          el("p", { className: "muted", textContent: p.auto_check_note || p.branch_name || "" }),
        ]),
      );
    }
    return wrap;
  }

  function renderAudit() {
    const items = full?.audit_log || [];
    if (!items.length) return empty("لا سجل بعد.");
    const table = el("table", {});
    const body = el("tbody", {});
    table.append(
      el("thead", {}, [
        el("tr", {}, [
          el("th", { textContent: "الوقت" }),
          el("th", { textContent: "المنفّذ" }),
          el("th", { textContent: "الإجراء" }),
          el("th", { textContent: "التفاصيل" }),
        ]),
      ]),
      body,
    );
    for (const a of items) {
      body.append(
        el("tr", {}, [
          el("td", { textContent: a.created_at }),
          el("td", { textContent: a.actor }),
          el("td", { textContent: a.action_type }),
          el("td", { textContent: a.action_details }),
        ]),
      );
    }
    return el("div", {}, [
      el("p", { className: "muted", textContent: "للعرض فقط. لا يمكن تعديل هذا السجل أو حذفه." }),
      table,
    ]);
  }

  function render() {
    const panel = document.getElementById("memory-panel");
    panel.innerHTML = "";
    if (!full) {
      panel.append(empty("اختر مشروعًا."));
      return;
    }
    const capsule = el("p", { className: "muted", textContent: current?.description || "" });
    panel.append(capsule);
    const views = {
      tasks: renderTasks,
      errors: renderErrors,
      plan: renderPlans,
      uiux: () => renderNotes("ui_ux_notes"),
      ux: () => renderNotes("ux_notes"),
      rules: renderRules,
      suggestions: renderSuggestions,
      prs: renderPrs,
      audit: renderAudit,
    };
    panel.append((views[activeTab] || renderTasks)());
  }

  document.getElementById("memory-tabs").addEventListener("click", (ev) => {
    const btn = ev.target.closest(".tab");
    if (!btn) return;
    activeTab = btn.dataset.tab;
    for (const t of document.querySelectorAll("#memory-tabs .tab")) t.classList.toggle("active", t === btn);
    render();
  });

  document.getElementById("memory-project").addEventListener("change", () => loadFull().catch((err) => msg(err.message)));
  document.getElementById("memory-refresh").addEventListener("click", () => loadProjects().catch((err) => msg(err.message)));
  document.getElementById("memory-create").addEventListener("click", async () => {
    msg("");
    try {
      const created = await api("/api/memory/projects", {
        method: "POST",
        body: JSON.stringify({
          name: document.getElementById("memory-new-name").value,
          repo_url: document.getElementById("memory-new-repo").value,
          description: document.getElementById("memory-new-desc").value,
        }),
      });
      document.getElementById("memory-new-name").value = "";
      document.getElementById("memory-new-repo").value = "";
      document.getElementById("memory-new-desc").value = "";
      msg("تم إنشاء المشروع.", true);
      await loadProjects();
      document.getElementById("memory-project").value = String(created.id);
      await loadFull();
    } catch (err) {
      msg(err.message);
    }
  });

  loadProjects().catch((err) => msg(err.message));
})();
