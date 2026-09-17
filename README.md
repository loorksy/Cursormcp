# MCP Cursor Bridge

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
