/**
 * The tool-search notice section (sigrun-ext-tool-search): the same
 * warn-if-not-offered channel, mechanism, and wording shape as
 * sigrun-ext-codemode's `codemode_notice` (Task 5; consistency across both
 * repos is a review criterion).
 *
 * When the extension is installed but the `tool_search` TOOL is not
 * model-offered in a request (Settings → default tools removes it via
 * `pi.agent.modelTools`), the model would otherwise be told by
 * `tool_search`'s own description to "always use tool_search" for tool
 * discovery while having no way to call it — and sigrun-ext-mcp's
 * `exposure: "deferred"` servers would be unreachable from the model
 * entirely. The companion `tool_search_notice` section renders the enable
 * notice; when the tool IS offered it renders NOTHING (returns
 * `undefined`, so no tag is written), which de-duplicates by construction.
 *
 * Mechanism choice (mirroring Task 5's, documented there and in both
 * READMEs): a companion section rather than a `wrapSection("tool-search", …)`
 * — upstream's tool-search extension ships NO section at all (verified:
 * `createToolSearchExtension()` registers only the tool), so the companion
 * is the only shape that can carry the notice, and it keys the notice to
 * the not-offered condition exactly, leaving the upstream extension
 * untouched. The companion section is registered on the same extension
 * object this package installs (upstream's spread + our section), so the
 * pair always travels together.
 *
 * The installation read is `agent.extensions[*].tools` — NOT
 * `agent.callable`: that set holds only tools-callable tools, and
 * `tool_search` registers `callers: ["model"]` (the same trap the codemode
 * notice caught in Task 5; TOOLS_SEARCH_TOOL_NAME is imported from
 * upstream so the name never drifts).
 */

import {
	TOOL_SEARCH_TOOL_NAME,
	createToolSearchExtension,
} from "@earendil-works/pi-durable/tool-search";
import {
	defineExtension,
	type Extension,
	type PromptInput,
} from "@earendil-works/pi-durable";

/** Our companion section's key. */
export const TOOL_SEARCH_NOTICE_SECTION_KEY = "tool_search_notice";

/** The enable notice, the codemode notice's wording shape. */
export const TOOL_SEARCH_NOT_OFFERED_NOTICE =
	"deferred tools are searchable but the tool_search tool is not offered; " +
	"enable it via Settings → default tools";

/**
 * The companion section render: the notice ONLY when the tool_search tool
 * is installed (one of the selected extensions registers it) yet not
 * model-offered in this request (`agent.tools` is the offered set);
 * `undefined` otherwise (offered, or not installed — nothing to warn
 * about).
 */
export function renderToolSearchNotice(
	input: PromptInput,
): string | undefined {
	const installed = input.agent.extensions.some((extension) =>
		(extension.tools ?? []).some(
			(tool) => tool.name === TOOL_SEARCH_TOOL_NAME,
		),
	);
	if (!installed) return undefined; // not installed: no lie to correct
	const offered = input.agent.tools.some(
		(tool) => tool.name === TOOL_SEARCH_TOOL_NAME,
	);
	return offered ? undefined : TOOL_SEARCH_NOT_OFFERED_NOTICE;
}

/**
 * The sigrun tool-search extension: upstream's `tool-search` extension
 * (the `tool_search` tool) plus the companion notice section.
 */
export function addToolSearchNotice(
	upstream: ReturnType<typeof createToolSearchExtension>,
): Extension {
	return defineExtension({
		...upstream,
		sections: [
			{
				key: TOOL_SEARCH_NOTICE_SECTION_KEY,
				render: renderToolSearchNotice,
			},
		],
	});
}