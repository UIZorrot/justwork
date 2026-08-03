import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("database event polling backs off while idle and frontend polling is only a recovery net", async () => {
  const backend = await readFile("backend/app/main.py", "utf8");
  const workbench = await readFile("src/pages/workbench/backend-workbench.ts", "utf8");

  assert.match(backend, /def _next_event_poll_delay/);
  assert.match(backend, /WORKSPACE_EVENT_POLL_MAX_SECONDS = 3\.0/);
  assert.match(backend, /COLLAB_EVENT_POLL_MAX_SECONDS = 2\.0/);
  assert.match(backend, /had_events = bool\(events\)/);
  assert.doesNotMatch(backend, /await asyncio\.sleep\(0\.2\)/);
  assert.doesNotMatch(backend, /await asyncio\.sleep\(0\.15\)/);
  assert.match(workbench, /REMOTE_WORKSPACE_POLL_MS = 60_000/);
  assert.match(workbench, /quotaLastPulledAt/);
});
