// The page the shell loads with no window when it wakes Ajé and no page is open: the store, telemetry
// and the workflow over the same bridge, then one wake-up of web/core/jobs.js, which ends in done and
// lets the shell close the page. It imports nothing from web/ui.
import { connect } from "./bridge.js";
import { loadConfig } from "./config.js";
import { idbBackend } from "./core/idb.js";
import { wake } from "./core/jobs.js";
import { openStore } from "./core/store.js";
import { openTelemetry } from "./core/telemetry.js";
import { createWorkflow } from "./core/workflow.js";

// The shell passes the time this wake-up was asked for.
const at = Number(new URLSearchParams(location.search).get("at")) || null;
const bridge = await connect();
try {
  const config = await loadConfig();
  const store = await openStore(idbBackend("state"));
  const fetch = (url, init) => globalThis.fetch(url, init);
  const telemetry = await openTelemetry({ config, store, backend: idbBackend("telemetry"), fetch, userAgent: navigator.userAgent });
  const workflow = createWorkflow({ bridge, store, telemetry });
  // Sends ready: the shell hands over the SMS it queued and pushes new ones here while the page lives.
  bridge.onSms((sms) => workflow.handleSms(sms).catch(() => {}));
  await wake({ bridge, store, telemetry, config, fetch }, at);
} catch {
  // Without a store there is nothing to run or schedule; the next opening of the app asks again.
  await bridge.done();
}
