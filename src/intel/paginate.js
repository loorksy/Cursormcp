export function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

export function decodeCursor(cursor) {
  if (!cursor) return { o: 0 };
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    const o = Number(parsed.o) || 0;
    return { ...parsed, o: o < 0 ? 0 : o };
  } catch {
    return { o: 0 };
  }
}

export function paginate(items, { limit, cursor, max } = {}) {
  const size = Math.min(Math.max(1, Number(limit) || 100), max || 500);
  const { o } = decodeCursor(cursor);
  const slice = items.slice(o, o + size);
  const next = o + size;
  const has_more = next < items.length;
  return {
    items: slice,
    has_more,
    next_cursor: has_more ? encodeCursor({ o: next }) : null,
    total: items.length,
    offset: o,
    limit: size,
  };
}

export function clipBytes(text, maxBytes) {
  const buf = Buffer.from(String(text), "utf8");
  if (buf.length <= maxBytes) return { text: String(text), truncated: false, bytes: buf.length };
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return { text: buf.slice(0, end).toString("utf8"), truncated: true, bytes: buf.length };
}

export function numbered(content, lineStart = 1, lineEnd = Infinity) {
  const lines = String(content).split("\n");
  const start = Math.max(1, lineStart);
  const end = Math.min(lines.length, lineEnd === Infinity ? lines.length : lineEnd);
  const slice = lines.slice(start - 1, end);
  return {
    lines: slice.map((text, i) => ({ number: start + i, text })),
    line_start: start,
    line_end: end,
    total_lines: lines.length,
  };
}

export const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "pdf", "zip", "gz", "tgz", "bz2", "xz", "7z",
  "woff", "woff2", "eot", "ttf", "otf", "mp3", "mp4", "webm", "wav", "exe", "dll", "so",
  "dylib", "class", "jar", "wasm", "bin", "dat", "sqlite", "db", "lock",
]);

export const GENERATED_DIR = new Set([
  "node_modules", ".git", ".venv", "venv", "dist", "build", "coverage", "vendor",
  "__pycache__", ".next", "out", "target", ".turbo", ".cache", "logs",
]);

export function extOf(path) {
  const base = String(path).split("/").pop() || "";
  const i = base.lastIndexOf(".");
  return i >= 0 ? base.slice(i + 1).toLowerCase() : "";
}

export function languageOf(path) {
  const map = {
    js: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "tsx", jsx: "jsx",
    py: "python", go: "go", rs: "rust", java: "java", rb: "ruby",
    php: "php", cs: "csharp", kt: "kotlin", swift: "swift",
    md: "markdown", json: "json", yml: "yaml", yaml: "yaml",
    html: "html", css: "css", scss: "scss", sql: "sql", sh: "shell",
    dockerfile: "dockerfile", toml: "toml", xml: "xml",
  };
  const base = String(path).split("/").pop() || "";
  if (/^Dockerfile/i.test(base)) return "dockerfile";
  return map[extOf(path)] || "";
}

export function isProbablyBinary(path, buf) {
  if (BINARY_EXT.has(extOf(path))) return true;
  if (!buf) return false;
  const slice = Buffer.isBuffer(buf) ? buf.subarray(0, 8000) : Buffer.from(String(buf).slice(0, 8000));
  if (slice.includes(0)) return true;
  let weird = 0;
  for (const b of slice) {
    if (b < 7 || (b > 13 && b < 32)) weird += 1;
  }
  return slice.length > 32 && weird / slice.length > 0.3;
}

export function looksGeneratedPath(path) {
  const parts = String(path).split("/");
  return parts.some((p) => GENERATED_DIR.has(p));
}

export function safeRelPath(path) {
  const n = String(path || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!n || n.includes("\0") || n.split("/").includes("..") || n === ".." || n.startsWith("../")) {
    const err = new Error("path traversal rejected");
    err.code = "PATH_TRAVERSAL";
    throw err;
  }
  return n;
}
