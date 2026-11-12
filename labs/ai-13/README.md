# Lab ai-13: 3 apps, 0 code changes. How did my AI learn to use them?

Topic: MCP (Model Context Protocol).

## The question

In a simulation of metadata-driven tool discovery, can one fixed client find and use three new apps only
from what each app describes about itself (tool names, descriptions, input schemas), with the selected
client source unchanged? And how much does tool choice depend on the description text?

What this lab does **not** answer:

- whether a real MCP client works with real MCP servers (no interoperability is tested),
- how accurate a real language model would be (the "model" here is a keyword matcher),
- how the official MCP SDK behaves (it is not used),
- how much effort it takes to build, deploy or set up an app adapter (not measured).

## How to run

```
node run.mjs
```

Node.js 22 or newer. No npm install, no network, no child processes, no files written. It finishes in well
under a second on a laptop and ends with one `RESULT {...}` line.

## What the lab does

1. **One fixed client.** `McpClient` plus the simulated model's code (`words`, `stem`, `bag`, `enumValues`,
   `chooseTool`, `extractArgs`, `validateArgs`), the seeded random number generator it uses for tie breaks
   (`mulberry32`) and the constants they read (`STOP`, `KNOWLEDGE`, `PROTOCOL`, `SEED`) form the hashed
   client source. It is SHA-256 hashed before any app is connected, after each app, and after the last
   rerun. Not hashed: the in-memory transport (`makePipe`), the test harness and the app servers. The lab
   also scans the client code and `STOP` (not `KNOWLEDGE`, which holds unit spellings on purpose) for app
   words ("note", "task", "convert", unit names) to show the client has no per-app branches.
2. **Three small in-process servers.** A notes app (4 tools), a to-do list (4 tools) and a unit converter
   (3 tools). Each one is a plain function that returns its tool names, descriptions, JSON input schemas and
   handlers. A shared hand-written helper, `serveMcp`, answers `initialize`, `tools/list` and `tools/call`.
   The lab counts the non-blank lines of each server and of the helper.
3. **Handshake and discovery.** For each app the client sends 3 messages: `initialize` (request),
   `notifications/initialized` (notification, no reply) and `tools/list` (request). The server sends
   2 responses, so one handshake is 5 wire messages. Every message is turned into a JSON string and parsed
   back, so nothing is shared by reference. The full captured transcript is printed for each app,
   including server info, every tool description and every input schema. The lab also times 50 fresh
   in-process connections per app and reports the median.
4. **60 fixed requests.** 20 plain-language requests per app, written before the run, each with a "gold"
   answer (the tool and arguments a careful person would choose). 9 of them are marked ambiguous on purpose
   ("I don't need groceries anymore", "Is 300 kelvin cold?"). For each request the model sees only what
   `tools/list` returned. The lab records:
   - right tool: did it pick the gold tool?
   - valid args: right tool, and the arguments pass the tool's own input schema?
   - right result: does the real call return exactly what the gold call returns on a fresh copy of the app?
5. **Vague descriptions.** The to-do server is rerun with the same tool names, the same input schemas
   (property descriptions included) and the same handlers. Only each tool's top-level description is
   replaced with "Works with an item." This isolates how much the tool description drives tool choice in
   this simulated model.

## What it shows

- **Where the code lives.** The selected client source hash stays the same for all three apps. That means
  the hashed client text did not change; it is not a count of lines changed, and it does not cover the
  transport or harness. Each app still needs its own small server (tens of lines). The honest framing is
  "the client stayed the same, one small adapter per app", not "no code at all".
- **Discovery is a short exchange.** One handshake is 3 client messages and 2 server responses (5 on the
  wire) and a few kilobytes of JSON, printed in full. In-process connect plus discovery takes a small
  fraction of a millisecond. That number includes building the app object; it is not setup effort.
- **The simulated model learns an app from its metadata.** The tool name, description and input schema are
  all it knows about an app. With clear descriptions tool choice is high but not perfect, and the misses
  land on vague wording. With vague tool descriptions, to-do tool choice drops, because only requests that
  repeat a tool name word ("add", "list", "delete") still find the right tool.
- **Right tool is not the same as right answer.** Some misses pick the right tool but cannot fill the
  arguments ("Convert 20 degrees to fahrenheit" never says degrees of what), so the schema check stops
  the call.

The script prints every miss with the reason, for the three baseline runs and for the vague rerun, so the
video can show real failures, not only the score.

## Limits (read before quoting numbers)

- **This is a simulation.** It shows the shape of the effect, not production numbers.
- **Not MCP interoperability.** The servers and client are a minimal hand-written subset of the JSON-RPC
  message shapes MCP uses (protocol version string `2025-06-18`), connected in-process. Nothing here shows
  that the client would work with real MCP servers, or that these servers would work with real clients.
- **Not the official SDK.** The lab rules allow only the Node standard library, so the MCP SDK is not used.
  The lab makes no claim about how many lines an SDK-based server would take.
- **The model is not an LLM.** It is a deterministic keyword matcher: it scores each tool by word overlap
  with the tool's name and description plus matches on schema enum values, and breaks ties with a seeded
  random number. Its accuracy says nothing about real model accuracy, in either direction. Only the
  direction of the vague-description effect inside this simulation is the point.
- **The model has some world knowledge.** A small table (`KNOWLEDGE`) maps unit spellings ("lbs", "feet",
  "F") to unit words. It stands in for what a trained model already knows and contains no tool names. It
  is included in the hash but excluded from the app-word scan. Say so if the video mentions the hash.
- **Setup effort is not measured.** The timing is in-process connect plus discovery latency only. It leaves
  out writing the adapter, deploying it, starting a process, stdio or HTTP transport, and model inference.
  The timing is the only number that changes a little between runs; everything else is fixed by seed 1313.
- **Small, hand-written request set.** 60 requests written by us, including ambiguous ones on purpose.
  Different wording would give different percentages.
- **"Right result"** compares against a gold call on a fresh copy of the same app. It checks that the call
  matched what a careful person would do, not that the app itself is bug free.
