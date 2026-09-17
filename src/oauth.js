import { randomBytes, randomUUID } from "node:crypto";
import {
  createOAuthMetadata,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { InvalidRequestError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { getDb, log, parseCookie, validSession, verifyPassword } from "./lib.js";

const PENDING_TTL_MS = 15 * 60 * 1000;
const ACCESS_TTL_SEC = 60 * 60 * 12;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function publicBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || "https://mcp.lork.cloud").replace(/\/$/, "");
}

function ensureOAuthTables() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id TEXT PRIMARY KEY,
      client_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      token TEXT PRIMARY KEY,
      refresh_token TEXT UNIQUE,
      client_id TEXT NOT NULL,
      scopes TEXT NOT NULL DEFAULT 'mcp:tools',
      resource TEXT,
      expires_at INTEGER NOT NULL,
      refresh_expires_at INTEGER NOT NULL
    );
  `);
}

class SqliteClientsStore {
  async getClient(clientId) {
    const row = getDb().prepare("SELECT client_json FROM oauth_clients WHERE client_id = ?").get(clientId);
    return row ? JSON.parse(row.client_json) : undefined;
  }

  async registerClient(clientMetadata) {
    getDb()
      .prepare(
        `INSERT INTO oauth_clients (client_id, client_json, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(client_id) DO UPDATE SET client_json = excluded.client_json`,
      )
      .run(clientMetadata.client_id, JSON.stringify(clientMetadata), new Date().toISOString());
    return clientMetadata;
  }
}

export class BridgeOAuthProvider {
  constructor() {
    ensureOAuthTables();
    this.clientsStore = new SqliteClientsStore();
    this.pending = new Map();
    this.codes = new Map();
  }

  async authorize(client, params, res) {
    const sid = parseCookie(res.req?.headers?.cookie, "bridge_sid");
    if (validSession(sid)) {
      this.redirectWithCode(res, client, params);
      return;
    }
    const pendingId = randomUUID();
    this.pending.set(pendingId, { client, params, createdAt: Date.now() });
    res.redirect(`/oauth/login?pending=${pendingId}`);
  }

  redirectWithCode(res, client, params) {
    if (!client.redirect_uris?.includes(params.redirectUri)) {
      throw new InvalidRequestError("Unregistered redirect_uri");
    }
    const code = randomUUID();
    this.codes.set(code, { client, params, createdAt: Date.now() });
    const target = new URL(params.redirectUri);
    target.searchParams.set("code", code);
    if (params.state !== undefined) target.searchParams.set("state", params.state);
    res.redirect(target.toString());
  }

  completePendingLogin(pendingId, res) {
    const pending = this.pending.get(pendingId);
    if (!pending) throw new InvalidRequestError("انتهت صلاحية جلسة الدخول.");
    if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
      this.pending.delete(pendingId);
      throw new InvalidRequestError("انتهت صلاحية جلسة الدخول.");
    }
    this.pending.delete(pendingId);
    this.redirectWithCode(res, pending.client, pending.params);
  }

  async challengeForAuthorizationCode(_client, authorizationCode) {
    const data = this.codes.get(authorizationCode);
    if (!data) throw new Error("Invalid authorization code");
    return data.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client, authorizationCode) {
    const data = this.codes.get(authorizationCode);
    if (!data) throw new Error("Invalid authorization code");
    if (data.client.client_id !== client.client_id) {
      throw new Error("Authorization code was not issued to this client");
    }
    this.codes.delete(authorizationCode);
    return this.issueTokens(client.client_id, data.params.scopes, data.params.resource);
  }

  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    const row = getDb().prepare("SELECT * FROM oauth_tokens WHERE refresh_token = ?").get(refreshToken);
    if (!row || row.refresh_expires_at < Date.now()) throw new Error("Invalid or expired refresh token");
    if (row.client_id !== client.client_id) throw new Error("Refresh token was not issued to this client");
    getDb().prepare("DELETE FROM oauth_tokens WHERE refresh_token = ?").run(refreshToken);
    return this.issueTokens(
      client.client_id,
      scopes && scopes.length ? scopes : String(row.scopes).split(" ").filter(Boolean),
      resource || (row.resource ? new URL(row.resource) : undefined),
    );
  }

  issueTokens(clientId, scopes, resource) {
    const scopeList = scopes && scopes.length ? scopes : ["mcp:tools"];
    const access = randomBytes(32).toString("hex");
    const refresh = randomBytes(32).toString("hex");
    const expiresAt = Date.now() + ACCESS_TTL_SEC * 1000;
    getDb()
      .prepare(
        `INSERT INTO oauth_tokens (token, refresh_token, client_id, scopes, resource, expires_at, refresh_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        access,
        refresh,
        clientId,
        scopeList.join(" "),
        resource?.href || "",
        expiresAt,
        Date.now() + REFRESH_TTL_MS,
      );
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SEC,
      refresh_token: refresh,
      scope: scopeList.join(" "),
    };
  }

  async verifyAccessToken(token) {
    const row = getDb().prepare("SELECT * FROM oauth_tokens WHERE token = ?").get(token);
    if (!row || row.expires_at < Date.now()) throw new Error("Invalid or expired token");
    return {
      token,
      clientId: row.client_id,
      scopes: String(row.scopes || "mcp:tools").split(" ").filter(Boolean),
      expiresAt: Math.floor(row.expires_at / 1000),
      resource: row.resource || undefined,
    };
  }
}

function loginPage(pending, error) {
  const err = error ? `<p class="flash">${escapeHtml(error)}</p>` : "";
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark" />
  <meta name="theme-color" content="#0b1017" />
  <title>تفويض MCP</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%234aa3ff'/%3E%3C/svg%3E" />
  <link rel="stylesheet" href="/styles.css?v=ui4" />
</head>
<body class="login-page">
  <div class="login-box card">
    <div class="brand login-brand">
      <div class="brand-mark" aria-hidden="true"></div>
      <div>
        <h1>تفويض MCP</h1>
        <p class="muted">الموافقة على اتصال Claude</p>
      </div>
    </div>
    <p class="muted">أدخل نفس بيانات لوحة التحكم للموافقة على اتصال MCP.</p>
    ${err}
    <form method="post" action="/oauth/login">
      <input type="hidden" name="pending" value="${escapeHtml(pending)}" />
      <div class="field">
        <label for="username">اسم المستخدم</label>
        <input id="username" name="username" autocomplete="username" required />
      </div>
      <div class="field">
        <label for="password">كلمة المرور</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
      </div>
      <button type="submit">السماح بالاتصال</button>
    </form>
  </div>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function mountOAuth(app, { timingSafeString }) {
  const issuerUrl = new URL(publicBaseUrl() + "/");
  const resourceServerUrl = new URL(publicBaseUrl() + "/mcp");
  const provider = new BridgeOAuthProvider();

  app.use((req, res, next) => {
    const p = req.path;
    if (p.startsWith("/.well-known/") || p === "/register" || p === "/token" || p === "/authorize") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, mcp-protocol-version",
      );
      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
    }
    next();
  });

  app.get("/oauth/login", (req, res) => {
    const pending = String(req.query.pending || "");
    if (!pending || !provider.pending.has(pending)) {
      res.status(400).type("html").send(loginPage("", "جلسة التفويض غير صالحة أو منتهية."));
      return;
    }
    res.type("html").send(loginPage(pending));
  });

  app.post("/oauth/login", (req, res) => {
    const pending = String(req.body?.pending || "");
    const username = String(req.body?.username || "");
    const password = String(req.body?.password || "");
    const expectedUser = process.env.ADMIN_USERNAME || "admin";
    const expectedHash = process.env.ADMIN_PASSWORD_HASH || "";
    if (!pending || !provider.pending.has(pending)) {
      res.status(400).type("html").send(loginPage(pending, "جلسة التفويض غير صالحة أو منتهية."));
      return;
    }
    const userOk = timingSafeString(username, expectedUser);
    const passOk = verifyPassword(password, expectedHash);
    if (!userOk || !passOk) {
      res.status(401).type("html").send(loginPage(pending, "بيانات الدخول غير صحيحة."));
      return;
    }
    try {
      provider.completePendingLogin(pending, res);
    } catch (err) {
      res.status(400).type("html").send(loginPage(pending, err.message));
    }
  });

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl,
      baseUrl: issuerUrl,
      scopesSupported: ["mcp:tools"],
      resourceName: "MCP Agents Bridge",
      resourceServerUrl,
    }),
  );

  const oauthMetadata = createOAuthMetadata({
    provider,
    issuerUrl,
    baseUrl: issuerUrl,
    scopesSupported: ["mcp:tools"],
  });

  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata,
      resourceServerUrl,
      scopesSupported: ["mcp:tools"],
      resourceName: "MCP Agents Bridge",
    }),
  );

  const protectedResourceDoc = {
    resource: resourceServerUrl.href,
    authorization_servers: [issuerUrl.href],
    scopes_supported: ["mcp:tools"],
    resource_name: "MCP Agents Bridge",
  };
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json(protectedResourceDoc);
  });

  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);
  const oauthBearer = requireBearerAuth({
    verifier: { verifyAccessToken: (token) => provider.verifyAccessToken(token) },
    requiredScopes: [],
    resourceMetadataUrl,
  });

  log("info", "oauth_mounted", {
    issuer: issuerUrl.href,
    resource: resourceServerUrl.href,
    resourceMetadataUrl,
  });

  return { provider, oauthBearer, resourceMetadataUrl };
}
