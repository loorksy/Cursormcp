import { loadEnvFile, ensureDirs, seedDefaultSettings, log } from "./lib.js";

loadEnvFile();
ensureDirs();
seedDefaultSettings();

const { ensureMemoryTables } = await import("./memory.js");
ensureMemoryTables();
const { registerDefaultProcessors } = await import("./processors.js");
const { startEventLoop } = await import("./events.js");
const { startPolling } = await import("./polling.js");

registerDefaultProcessors();
startEventLoop();
startPolling();
log("info", "worker_started", {});
