const SECRET_SUFFIXES = [
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "API_KEY",
  "APIKEY",
  "PRIVATE_KEY",
  "ACCESS_KEY",
  "WEBHOOK_SECRET",
  "DATABASE_URL",
  "DB_URL",
  "DSN",
  "CREDENTIAL",
  "CREDENTIALS",
  "AUTH",
  "JWT",
  "SESSION",
  "APP_SECRET",
  "CLIENT_SECRET",
  "PRIVATE_TOKEN",
];

function secretAssignment(line) {
  const trimmed = line.replace(/^\s*(?:export\s+)?/, "");
  const eq = trimmed.search(/[=:]/);
  if (eq <= 0) return null;
  const key = trimmed.slice(0, eq).trim().toUpperCase();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) return null;
  if (SECRET_SUFFIXES.some((s) => key === s || key.endsWith("_" + s) || key.endsWith(s))) return eq;
  return null;
}

const PATTERNS = [
  { name: "pem", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { name: "github_pat", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g },
  { name: "github_fine", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: "aws", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g },
  { name: "telegram_bot", re: /\b\d{8,12}:AA[A-Za-z0-9_\-]{20,}\b/g },
  { name: "slack", re: /\bxox[baprs]-[A-Za-z0-9\-]{10,}\b/g },
  { name: "bearer", re: /\bBearer\s+[A-Za-z0-9._+\/=-]{16,}\b/gi },
  { name: "conn", re: /\b(?:postgres|mysql|mongodb|redis|amqp):\/\/[^\s'"]+/gi },
];

const ENVISH = /(^|\/)\.env(\.|$)|credentials|\.pem$|\.key$|id_rsa|service-account/i;

export function redactSecrets(text, { path = "" } = {}) {
  if (text == null) return { text: "", redacted: false, kinds: [] };
  let out = String(text);
  const kinds = new Set();
  const aggressive = ENVISH.test(path);

  out = out
    .split("\n")
    .map((line) => {
      const lead = line.match(/^\s*/)?.[0] || "";
      const body = line.slice(lead.length);
      const at = secretAssignment(body);
      if (at != null) {
        kinds.add("env_assignment");
        const sep = body.search(/[=:]/);
        return `${lead}${body.slice(0, sep + 1)}********`;
      }
      if (aggressive && /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*\S+/.test(body) && !body.startsWith("#")) {
        const eq = body.indexOf("=");
        kinds.add("env_file");
        return `${lead}${body.slice(0, eq + 1)}********`;
      }
      return line;
    })
    .join("\n");

  for (const p of PATTERNS) {
    const next = out.replace(p.re, "********");
    if (next !== out) kinds.add(p.name);
    out = next;
  }
  return { text: out, redacted: kinds.size > 0, kinds: [...kinds] };
}

export function redactValue(value, meta = {}) {
  if (typeof value === "string") return redactSecrets(value, meta).text;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, meta));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactValue(v, meta);
    }
    return out;
  }
  return value;
}
