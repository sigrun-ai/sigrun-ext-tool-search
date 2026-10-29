# @sigrun/ext-tool-search

The tool-search extension for sigrun (pi-durable): the `tool_search`
tool — BM25 search over DEFERRED tool metadata that loads the matches
into the model-offered set — installed via upstream's
`createToolSearchExtension` (`@earendil-works/pi-durable/tool-search`),
verbatim, plus one sigrun addition: the companion `tool_search_notice`
section (the same warn-if-not-offered channel as sigrun-ext-codemode's
`codemode_notice`).

The sigrun extension-package contract: the default export is a factory
taking no arguments, returning `{ extension }`.

## What the factory does

Returns upstream's `tool-search` extension — name `"tool-search"`, the
`tool_search` tool named exactly, `callers: ["model"]`, `replay:
"safe"` — spread with one additional section (below). Upstream ships
the BM25 ranker inside pi-durable itself (`dist/search.js`), so there
is no separate ranker dependency (rev-3 ruling: sigrun-tool-ranker
DROPPED). The extension is stateless; the wiring has no lifecycle to
close.

## The load mechanism (verified against pi-durable 1.2.0)

Deferred tools — sigrun-ext-mcp's `exposure: "deferred"` servers, i.e.
MCP tools registered `deferred: true` — sit in `agent.deferred`:
model-callable, NOT model-offered. `tool_search` ranks them (BM25 over
name, description, and parameter-schema text; `DEFAULT_TOOL_SEARCH_
LIMIT` 8) and returns `control: { addTools: <names> }`, which the
harness applies to the conversation's `pi.agent.modelTools` (`add`).

Replacement semantics — what the write means:

- **The offered set, next call.** The next request's offered set
  (`agent.tools`) includes the loaded names. The run CONTINUES after
  the tool round (the generation hands over within the same
  submission), so search → load → invoke is one turn.
- **Per branch, durable.** The write is on the conversation's
  `pi.agent` document, so the loaded set stays offered on that branch —
  across later entries, forks (copied as-of the fork entry), and
  compactions. A different branch that never searched sees nothing.
- **Deferred until offered.** `agent.deferred` is computed — "deferred
  tools the model may call and is not offered YET" — so loading a tool
  removes it from the deferred set; the still-unloaded siblings remain
  search candidates. Nothing is unregistered.
- **Empty is not error.** A query matching nothing (or no deferred
  tools at all) returns `details: { loaded: [] }` with the text
  "No matching tools found." and NO control — never an error, and the
  offered set does not grow.

On the transcript, a load appears as a `pi.system` entry whose
`toolsAdded` lists the loaded tool — the prompt-cache DIFF against the
previous request, so the FIRST request's `toolsAdded` names
`tool_search` itself; that first entry is not a load.

## The warn-if-not-offered section

Upstream's `tool_search` description tells the model to "always use
tool_search" for tool discovery — a model whose Settings → default
tools excluded `tool_search` would be pointed at a tool it cannot call,
and every `exposure: "deferred"` MCP server would be unreachable from
the model entirely. When the extension is installed yet the tool is not
model-offered in a request, the companion `tool_search_notice` section
renders:

> deferred tools are searchable but the tool_search tool is not
> offered; enable it via Settings → default tools

When the tool is offered the section renders NOTHING (returns
`undefined`; no tag is written). Installation is read from
`agent.extensions[*].tools` — NOT `agent.callable`, which holds only
tools-callable tools and never sees `tool_search` (`callers: ["model"]`)
— the same trap the codemode notice caught in Task 5; the mechanism
(companion section, keyed to the exact not-offered condition,
registered on the one extension this package installs) mirrors
sigrun-ext-codemode's choice for review consistency.

## Package replacement semantics (slice 4)

Replace this package by not installing it and installing yours: the
surface is one tool named exactly `tool_search` (plus the companion
`tool_search_notice` section), so a per-name replacement is trivial —
uninstall ours, install the replacement under the same tool name. Do NOT
co-install: pi-durable resolves cross-extension duplicate tool names
last-selected-wins, so a co-installed replacement silently shadows the
original. Sigrun's extension loader now makes the shadowing visible at
boot (it `console.warn`s once per duplicate tool name, naming the
extensions and the last-wins resolution), but the warning changes nothing:
last-wins stands. Replace, don't co-install.

(Not to be confused with "Replacement semantics — what the write means"
above: that section is about the `modelTools` write this package performs;
this one is about replacing this package itself.)

## Dependencies

- `@earendil-works/pi-durable` (peer, `1.3.0 || 1.4.0`): the extension
  itself and the deferred/modelTools machinery.
- `@sigrun/ext-mcp` (devDependency, `file:../sigrun-ext-mcp` until
  Task 8 publishes it; then `0.1.0`): NOT used
  by the shipped code — only by the test suite, which drives deferred
  tools through the REAL mcp extension (Task 4's verified
  `exposure: "deferred"` config shape) so the e2e covers exactly the
  machinery that produces deferred tools in prod. Per Ruling Z the
  sigrun tree does not pin these repos (Task 8 wires the image).

## Development

```sh
npm install && npm test   # vitest run
npm run typecheck
npm run build
```

The suite opens a REAL pi-durable harness (registry + faux provider)
with both extensions installed against a copied stub MCP server
(`test/stub-mcp-server.mjs`, sigrun-ext-mcp's idiom).