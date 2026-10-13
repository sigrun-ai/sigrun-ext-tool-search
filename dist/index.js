/**
 * sigrun-ext-tool-search: the tool-search factory (the loader contract).
 *
 * The sigrun extension-package contract (sigrun's src/harness/loader.ts):
 * the default export is a FACTORY TAKING NO ARGUMENTS, returning
 * `{ extension }`. The loader calls it synchronously at boot, before
 * `Harness.open` reads the registry.
 *
 * What the factory returns is UPSTREAM'S tool-search extension, VERBATIM:
 * `createToolSearchExtension()` from `@earendil-works/pi-durable/tool-search`
 * (name "tool-search", the `tool_search` tool named exactly, with
 * `callers: ["model"]` and `replay: "safe"`), plus one sigrun addition —
 * the companion `tool_search_notice` section (src/extension.ts), the same
 * mechanism and the same wording channel as sigrun-ext-codemode's
 * `codemode_notice` (Task 5; consistency across both repos is a review
 * criterion). Upstream ships BM25 ranking inside pi-durable itself, so
 * there is no separate ranker dependency (rev-3 ruling: sigrun-tool-ranker
 * DROPPED).
 *
 * Deferred-tool lifecycle (verified against pi-durable 1.2.0
 * `dist/tool-search/tool-search.js` + `dist/harness/agent.js`): tools
 * registered `deferred: true` (sigrun-ext-mcp's `exposure: "deferred"`)
 * sit in `agent.deferred` — model-callable, NOT model-offered — until
 * `tool_search` matches them (BM25 over name/description/parameter text,
 * `DEFAULT_TOOL_SEARCH_LIMIT` 8) and returns
 * `control: { addTools: <names> }`. The harness applies that to the
 * conversation's `pi.agent.modelTools` (its `add`), so the NEXT request
 * offers the loaded tools, and the write is on the conversation document —
 * the loaded set travels the branch, forks included. A query matching
 * nothing returns an EMPTY result ("No matching tools found."), never an
 * error.
 */
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { addToolSearchNotice } from "./extension.js";
/**
 * The tool-search factory (the loader contract: no arguments). Upstream's
 * extension is stateless (the search reads `agent.deferred` at execution
 * time; ranking is pure), so one wiring has no lifecycle to close.
 */
export function createToolSearchWiring() {
    return { extension: addToolSearchNotice(createToolSearchExtension()) };
}
/**
 * The sigrun extension-package contract: the default export is a factory
 * taking no arguments, returning `{ extension }`.
 */
export default createToolSearchWiring;
export { TOOL_SEARCH_NOTICE_SECTION_KEY, TOOL_SEARCH_NOT_OFFERED_NOTICE, renderToolSearchNotice, } from "./extension.js";
