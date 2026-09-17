# MCP Cursor Bridge

جسر MCP + لوحة تحكم + منسّق إنتاج لوكلاء [Cursor Cloud Agents](https://cursor.com/docs/cloud-agent/api/endpoints).

الإنتاج: systemd `mcp-cursor-bridge` على `127.0.0.1:18800` خلف https://mcp.lork.cloud

اقرأ بالترتيب: [AUDIT.md](AUDIT.md) → [AUDIT_REPOSITORY_INTELLIGENCE.md](AUDIT_REPOSITORY_INTELLIGENCE.md) → [REPOSITORY_INTELLIGENCE.md](REPOSITORY_INTELLIGENCE.md) → [MCP_TOOLS.md](MCP_TOOLS.md) → [ARCHITECTURE.md](ARCHITECTURE.md) → [DEPLOYMENT.md](DEPLOYMENT.md)

## تشغيل محلي

```bash
cp .env.example .env
npm install
npm test
npm start
```

`GET /health` و `GET /ready` للتأكد أن SQLite والعملية يعملان.

## قيود الـ VPS

لا تلمس docker / nginx العام / postgres / redis / pm2. لا بورتات جديدة. نفس الوحدة `mcp-cursor-bridge` فقط.


جسر MCP بين عملاء مثل Claude ولوحة تحكم ويب وبين [Cursor Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints).

الإنتاج على هذا المستودع يعمل على VPS منفصل:

- المسار: `/opt/mcp-cursor-bridge`
- الخدمة: `mcp-cursor-bridge` (systemd)
- المنفذ الداخلي: `127.0.0.1:18800`
- الواجهة: https://mcp.lork.cloud

## MCP tools

- `create_agent` — إطلاق agent على مستودع GitHub مع prompt
- `get_agent` — الحالة / النتيجة / الفرع / رابط PR
- `followup_agent` — تعليمات لاحقة
- `list_repos` — المستودعات المتاحة
- `list_models` — النماذج المتاحة
- `list_agents` — سرد الـ agents
- أدوات الاستكشاف: `repo_tree`, `repo_file_read`, `repo_search`, `git_diff`, `github_pull_request`, `project_snapshot`, `project_audit` — انظر [MCP_TOOLS.md](MCP_TOOLS.md)

عنوان MCP: `https://mcp.lork.cloud/mcp`

المصادقة لـ Claude.ai Connectors: OAuth (اكتشاف `/.well-known/oauth-*` + تسجيل ديناميكي في `/register` + صفحة `/oauth/login`).

للعملاء اليدويين: `Authorization: Bearer <MCP_AUTH_TOKEN>`

Webhook إشعارات Cursor: `https://mcp.lork.cloud/webhooks/cursor-agent`

زر **إطلاق** في اللوحة (وأداة MCP `create_agent`) يرفق هذا الرابط و`CURSOR_WEBHOOK_SECRET` تلقائيًا عبر Cloud Agents API v0. لا حاجة للصقهما في إعدادات Cursor.com.

## الذاكرة المركزية والحوكمة

دليل عام (بلا بيانات مشاريع): `GET https://mcp.lork.cloud/system-guide`

أدوات MCP إضافية للمشاريع/المهام/القواعد. الإنجاز المعتمد (`done_verified`) وقبول القواعد يتمان فقط من لوحة التحكم.

## التشغيل المحلي

```bash
cp .env.example .env
# املأ APP_SECRET و SESSION_SECRET و ADMIN_PASSWORD_HASH و MCP_AUTH_TOKEN
npm install
npm start
```

توليد hash لكلمة المرور:

```bash
node -e "import { hashPassword } from './src/lib.js'; console.log(hashPassword(process.argv[1]))" 'your-password'
```

## قيود النشر على الـ VPS

لا تلمس وحدات systemd أو حاويات Docker أو عمليات PM2 القائمة. أضف فقط:

- مستخدم النظام `mcpbridge`
- `/opt/mcp-cursor-bridge`
- `/etc/systemd/system/mcp-cursor-bridge.service`
- `/etc/nginx/sites-available/mcp.lork.cloud` (+ symlink في `sites-enabled`)
- شهادة Let’s Encrypt لاسم `mcp.lork.cloud` فقط
