# Context engine

Pipeline:

Repository → allowlist → resolve SHA → tree → drop generated/binary → language inventory → bounded search/chunk → import/route scan → architecture map → snapshot/audit JSON.

Chunking is pagination (`limit`/`cursor`/`max_bytes`), not embeddings. The model walks the repo with tools instead of ingesting it in one payload.

Architecture heuristics (evidence in file paths and line matches):

- Entrypoints: `package.json`, `src/server.js`, `Dockerfile`, `main.py`, …
- Layers: paths matching route/controller, service/orchestr, schema/memory, worker/poll, tests
- HTTP routes: `app.get/post/...` in scanned `src/` JS
- Dependencies: `package.json` keys

Memory (governed SQLite) is attached to snapshot/audit as a **separate** section and is never treated as file contents.
