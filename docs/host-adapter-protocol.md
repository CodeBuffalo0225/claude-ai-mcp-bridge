# Host Adapter Protocol — the CEP→UXP seam

Updated: 2026-07-05

Everything above `src/bridge/adapters/` (AdobeBridge facade, MCP servers,
recipes, color grader, sound engineer) is transport-agnostic. A host adapter
carries JSON frames between Node and the app; how commands execute inside the
app (ExtendScript today, UXP DOM tomorrow) is invisible above the seam.

## Wire frames

```
request:   { "id": 42, "command": "timeline.addClip", "params": { ... } }
response:  { "id": 42, "result": { ... } }     on success
           { "id": 42, "error": "message" }    on failure
event:     { "event": "NAME", "data": { ... } }            (host → Node broadcast)
host cmd:  { "id": 7, "command": "ANALYZE_STYLE_DIR", "params": { ... } }  (host → Node)
```

`id` correlates request↔response. Host-initiated commands reuse the same shape
in the opposite direction; Node replies with `{ id, result }` / `{ id, event, data }`.

## Internal commands every host implementation must serve

| Command | Reply | Purpose |
|---|---|---|
| `_ping` | `{ pong, app, port, scriptReady, jsxVersion, handlerCount }` | instant liveness |
| `_status` | `{ app, appId, port, scriptReady, commandsExecuted, errors }` | panel stats |
| `_info` | `{ jsxVersion, app, appVersion, handlers[], handlerCount }` | THE preflight handshake — which build is live |
| `_reloadJsx` | `{ reloaded, jsxVersion, handlers[] }` | hot-reload the script layer without app restart |
| `_jobStatus` | `{ jobId, done, result?/error? }` | poll an async job |
| `_eval` | `{ evalResult }` | raw script escape hatch |

**Async jobs:** any command sent with `params._async: true` must be answered
IMMEDIATELY with `{ id, result: { jobId, async: true, command } }`; the host
runs the command and stores the outcome for `_jobStatus` polls (one-shot: the
result is deleted once collected). This is how long ops beat request timeouts.

**Never simulate.** If the transport is down, `send()` tries one on-demand
reconnect, then throws. No mock responses, ever (hard rule #1).

## Implementations

- **`cep-ws-adapter.js` (active):** CEP panel runs a WS *server* inside the
  app (Premiere 8081 / AE 8082); Node connects as client. Panel executes
  commands via `evalScript → executeCommand()` in the ExtendScript engine
  (`premiere-bridge.jsx` / `ae-bridge.jsx`).
- **`uxp-adapter.js` (skeleton):** UXP plugins can't host WS servers, so the
  direction inverts — Node listens on 8081/8082, the UXP plugin dials out.
  Same frames, same internal commands, same handler names ("timeline.addClip",
  "edit.speedRamp", …), so every MCP tool works unchanged. Full build guide in
  the file header.

## Switching adapters

Per app, no code changes above the seam:

```
BRIDGE_ADAPTER_PREMIERE=uxp        # env var, or
new AdobeBridge({ adapters: { premiere: 'uxp' } })
```

Default is `cep` for both apps.
