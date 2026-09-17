export class IntelError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "IntelError";
    this.code = code;
    this.retryable = Boolean(extra.retryable);
    this.repository = extra.repository || "";
    this.path = extra.path || "";
    this.status = extra.status || (code === "NOT_FOUND" ? 404 : code === "FORBIDDEN" ? 403 : 400);
    Object.assign(this, extra);
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        repository: this.repository || undefined,
        path: this.path || undefined,
        retryable: this.retryable,
      },
    };
  }
}

export function wrapIntelError(err, extra = {}) {
  if (err instanceof IntelError) {
    if (extra.repository && !err.repository) err.repository = extra.repository;
    if (extra.path && !err.path) err.path = extra.path;
    return err;
  }
  const code = err.code || (err.status === 404 ? "NOT_FOUND" : err.status === 403 ? "GITHUB_FORBIDDEN" : "INTEL_ERROR");
  return new IntelError(code, err.message || "intel error", {
    retryable: err.retryable,
    status: err.status,
    ...extra,
  });
}
