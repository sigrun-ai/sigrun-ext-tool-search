# Task 6 report — sigrun-ext-tool-search

STATUS: complete. Repo created (`git init -b main`, local only, no
remote — mirrors the codemode repo). All plan steps done: the factory
(upstream's extension verbatim + the notice section), the e2e suite
(plan step 1's list verbatim), README with the replacement semantics.

## Commits (main)

- `798c15d` skeleton + factory + e2e: upstream createToolSearchExtension
  + tool_search_notice companion section; deferred-tools suite
  (includes package.json/tsconfigs/.gitignore/harness/stub server)
- README + task-6 report (this report's sibling)

## Test one-liner

`npm test`: 1 file, 7 tests, all green — registration shape
(`tool_search` model-callable, in agent.tools, NOT deferred; companion
notice silent when offered), `tool_search("echo")` loads the stub tool
(details.loaded + "Loaded 1 tool" + pi.system toolsAdded + live
agent.tools growth + agent.deferred narrowing to the unloaded sibling),
the next model call invokes `stub/echo` directly in the same run
("hello, sigruNN", load entry precedes the invocation entry), the
loaded set survives a fork at a later entry (fork's agent.tools holds
it; fork's direct echo call resolves), nothing-deferred → empty
result not error (`loaded: []`, "No matching tools found", no
toolsAdded for any deferred name), no-match query → empty result not
error (offered set does not grow), notice channel (removed via
modelTools → notice renders; re-offered → silent). typecheck + build
green.

## Mechanism verified from pi-durable 1.2.0 BEFORE the assertions

Read `dist/tool-search/tool-search.js` first as briefed:

1. The tool's name in the model-offered space: `tool_search`
   (TOOL_SEARCH_TOOL_NAME), `callers: ["model"]`, `replay: "safe"` — so
   it lands in `agent.tools`, never `agent.callable`, never
   `agent.deferred` (it must not be its own search candidate).
2. What it appends: `control: { addTools: <names> }` on a hit. The
   harness's `finishToolRound` (generation.js) collects it and calls
   `addTools(tx, conversationId, added)` (agent.js), which appends to
   the conversation's `pi.agent.modelTools` `add` — a per-branch,
   durable write (forks copy the doc as-of their entry; compactions
   keep it). The run then CONTINUES within the same submission
   (`handOver`), so the "next model call" is the same turn's
   continuation, not a new submission.
3. `DEFAULT_TOOL_SEARCH_LIMIT = 8`; ranking is BM25 (k1 1.2, b 0.75,
   naive stem, stop-word list) over name + name-with-spaces +
   description + recursive parameter-schema text. A miss returns
   `"No matching tools found."` with NO control and
   `details: { loaded: [] }` — empty, never an error.

Two facts the first red run corrected (fail-first doing its job):

- **`agent.deferred` is COMPUTED** — "deferred tools the model may call
  and is not offered YET" — so a loaded tool LEAVES the set (the
  registry registration stays). Asserted: post-load deferred set is
  `["stub/add"]`, the unloaded sibling.
- **`pi.system.toolsAdded` is a prompt-cache DIFF** against the
  previous request, so the FIRST request records `tool_search` itself —
  asserting "a toolsAdded entry exists" is vacuous. A load is a
  toolsAdded entry naming the deferred tool AFTER the tool result.
- The first draft also expected the load to land in a NEW submission's
  transcript (`submit` → "next model call") — wrong: the generation
  continues the same run, and a second queued submission settled
  `unanswered` (faux responses consumed by the first run's
  continuation). The search→load→invoke sequence is ONE turn.

## The notice section (Task 5 consistency)

Same companion-section mechanism as `codemode_notice`, same wording
shape: key `tool_search_notice`, install read from
`agent.extensions[*].tools` (NOT `agent.callable` — `tool_search`
registers `callers: ["model"]`, the same trap), offer read from
`agent.tools`, renders `undefined` when offered (de-dup by
construction). Note: upstream's tool-search extension ships NO section
at all, so the companion is the only shape that could carry the notice
(the wrap choice Task 5 documented does not apply — nothing to wrap);
the companion keys the notice to the exact not-offered condition,
leaving upstream's extension untouched. Tested by the offered/removed/
re-offered matrix.

## Integration

`sigrun-ext-mcp` is a devDependency via `file:../sigrun-ext-mcp` (a
link in the lockfile) — TEST-ONLY, driving Task 4's verified
`exposure: "deferred"` config shape through the REAL mcp extension
rather than a hand-rolled deferred registration. Per Ruling Z, the
sigrun tree gained NO pins from this task; Task 8 wires the image.

## Concerns / for the controller

1. **The notice's deferred-tools premise:** when `tool_search` is
   model-removed, the notice fires — but the model-removed state also
   means deferred tools are unreachable from the model ENTIRELY (they
   are only loadable through tool_search). The notice's wording
   ("deferred tools are searchable but…") states the consequence
   correctly; no action needed, recorded for the spec.
2. **`file:../sigrun-ext-mcp` is a sibling-path pin**: the suite
   requires the two repos checked out side by side (`~/repos/`). This
   matches how the working tree already references these repos (the
   extension repos' own dev setups), and the mcp repo has no remote
   tag for the sigrun git-pin convention to use — if Task 8 wants an
   installable artifact, both repos need packaging treatment there.
3. **BM25 is upstream's copy** (pi-durable `dist/search.js`), not a
   shared ranker package — rev-3's DROPPED ruling held; nothing to
   reconcile.
4. Minor: `npm install` warns about the `prepare` scripts not running
   under the install-scripts policy — `sigrun-ext-mcp`'s `prepare`
   (`npm run build`) is skipped, so its `dist` must exist; it does
   (built in its own repo). Worth knowing if the image build relies on
   fresh installs.