/**
 * End-to-end tests (the testable line, plan Task 6 step 1's list
 * verbatim): a stub MCP server with `exposure: "deferred"` connected
 * (Task 4's verified config shape, driven through the REAL
 * sigrun-ext-mcp extension) + the tool-search extension installed; the
 * model calls `tool_search("echo")`, the stub tool loads, and the next
 * model call invokes the loaded tool directly. Runs a REAL pi-durable
 * Harness (registry + faux provider), mirroring sigrun-ext-mcp's and
 * sigrun-ext-codemode's test idiom — no sigrun-core dependency.
 *
 * Verified against pi-durable 1.2.0 (`dist/tool-search/tool-search.js`,
 * `dist/harness/agent.js`, `dist/harness/generation.js`) BEFORE the
 * assertions were finalized:
 *   - The tool: name `tool_search` (TOOL_SEARCH_TOOL_NAME),
 *     `callers: ["model"]`, `replay: "safe"`; DEFAULT_TOOL_SEARCH_LIMIT 8.
 *   - execute ranks `agent.deferred` (BM25 over name/description/schema
 *     text) and returns `control: { addTools: <names> }` on a hit; the
 *     harness applies it to `pi.agent.modelTools`'s `add` (agent.js
 *     `addTools`), so the NEXT request's offered set (`agent.tools`)
 *     includes the loaded names. A miss returns plain text ("No matching
 *     tools found.") with NO control — empty result, never an error. The
 *     result's `details` is `{ loaded: [...] }` in BOTH cases (an empty
 *     `loaded` array on a miss).
 *   - `agent.deferred` is COMPUTED: "deferred tools the model may call and
 *     is not offered YET" — loading a tool moves it into the offered set,
 *     so it leaves `agent.deferred` (the still-unloaded sibling stays).
 *   - The run CONTINUES after the tool round (`finishToolRound` hands the
 *     generation over in the same run), so the "next model call" is the
 *     continuation of the SAME submission — the whole search→load→invoke
 *     sequence is one turn. The load is visible on the transcript as a
 *     `pi.system` entry with `toolsAdded: [{name: "stub/echo", …}]`
 *     BETWEEN the tool_search result and the next assistant entry.
 *   - Each request's `pi.system` entry carries `toolsAdded` — the
 *     prompt-cache DIFF against the previous request, so the FIRST request
 *     records `tool_search` itself; a load is a `toolsAdded` entry listing
 *     the deferred tool's name after the tool result.
 *   - The `modelTools` write is on the conversation's `pi.agent` document,
 *     which a fork copies as-of its fork entry, so the loaded set
 *     survives forks at later entries.
 */

import { expect, test } from "vitest";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
	cleanupDir,
	closeOpened,
	openToolSearchHarness,
	stubConfigPath,
	tempDir,
	writeConfig,
} from "./harness.js";
import type { Agent, Harness } from "@earendil-works/pi-durable";
import type { PromptInput } from "@earendil-works/pi-durable";
import {
	TOOL_SEARCH_NOTICE_SECTION_KEY,
	TOOL_SEARCH_NOT_OFFERED_NOTICE,
} from "../src/extension.js";

const STUB_SERVER = join(import.meta.dirname, "stub-mcp-server.mjs");

/** The deferred stub server entry (Task 4's config shape). */
function deferredStub(): { command: string; args: string[]; exposure: string } {
	return { command: process.execPath, args: [STUB_SERVER], exposure: "deferred" };
}

/** Sorted tool-name set of an agent tool list. */
function namesOf(tools: readonly { readonly name: string }[]): string[] {
	return tools.map((tool) => tool.name).sort();
}

/** Render one companion notice section for a conversation's agent. */
async function renderNotice(
	harness: Harness,
	conversationId: Awaited<ReturnType<Harness["root"]>>["id"],
	agent: Agent,
): Promise<string | undefined> {
	const section = agent.sections.find(
		(candidate) => candidate.key === TOOL_SEARCH_NOTICE_SECTION_KEY,
	);
	if (section === undefined) return "section-missing";
	const input = {
		conversationId,
		agent,
		env: undefined,
		shown: {},
		read: undefined as never,
	} satisfies PromptInput;
	return await Promise.resolve(section.render(input, BACKGROUND_CONTEXT));
}

type Root = Awaited<ReturnType<Harness["root"]>>;

/** The names in a `pi.system` entry's `toolsAdded`, or undefined. */
function toolsAddedOf(entry: unknown): string[] | undefined {
	for (const message of (entry as { model?: unknown[] }).model ?? []) {
		const added = (message as { toolsAdded?: { name: string }[] }).toolsAdded;
		if (added !== undefined) return added.map((tool) => tool.name);
	}
	return undefined;
}

/** Drive one full turn and return its settled status + transcript page. */
async function runTurn(
	root: Root,
	content: string,
): Promise<{
	settled: { status: string };
	page: Awaited<ReturnType<Root["entries"]>>["items"];
}> {
	const submission = await root.submit(
		{ type: "input", content },
		BACKGROUND_CONTEXT,
	);
	const settled = await submission.wait(BACKGROUND_CONTEXT);
	await root.waitForIdle(BACKGROUND_CONTEXT);
	const page = await root.entries({}, 50, undefined, BACKGROUND_CONTEXT);
	return { settled, page: page.items };
}

/** One entry's JSON, or "" (the transcript scan helpers below use these). */
const jsonOf = (entry: unknown): string => JSON.stringify(entry ?? null);

/** The result message of the model-issued call to `name`, or undefined. */
function toolResultOf(
	items: readonly unknown[],
	name: string,
): {
	text: string;
	loaded: string[] | undefined;
	isError: boolean;
} | undefined {
	for (const entry of items) {
		const messages = (entry as { model?: unknown[] }).model ?? [];
		for (const message of messages) {
			const candidate = message as {
				role?: string;
				toolName?: string;
				content?: { type: string; text?: string }[];
				isError?: boolean;
				details?: { loaded?: string[] };
			};
			if (candidate.role === "toolResult" && candidate.toolName === name) {
				return {
					text: (candidate.content ?? [])
						.map((block) => block.text ?? "")
						.join("\n"),
					loaded: candidate.details?.loaded,
					isError: candidate.isError ?? false,
				};
			}
		}
	}
	return undefined;
}

test("the tool_search tool registers model-callable, never deferred, and the notice renders per offer", async () => {
	const dir = await tempDir("sigrun-ts-reg-");
	try {
		await writeConfig(stubConfigPath(dir), { stub: deferredStub() });
		const opened = await openToolSearchHarness(dir);
		try {
			// Registered by our extension, named exactly, callers model-only.
			const registered = opened.registry
				.snapshot()
				.tools()
				.find(({ tool }) => tool.name === "tool_search");
			expect(registered).toBeDefined();
			expect(registered!.extension.name).toBe("tool-search");
			expect(registered!.tool.callers).toEqual(["model"]);
			// The upstream tool is offered (in agent.tools), NOT deferred:
			// tool_search itself must never be a search candidate.
			const root = await opened.harness.root(BACKGROUND_CONTEXT, {});
			const agent = await root.agent(BACKGROUND_CONTEXT);
			expect(namesOf(agent.tools)).toContain("tool_search");
			expect(namesOf(agent.deferred)).toEqual(["stub/add", "stub/echo"]);
			expect(namesOf(agent.tools)).not.toContain("stub/echo");
			// The companion notice renders NOTHING when offered.
			expect(await renderNotice(opened.harness, root.id, agent)).toBeUndefined();
		} finally {
			await closeOpened(opened);
		}
	} finally {
		await cleanupDir(dir);
	}
});

test("tool_search(\"echo\") loads the stub tool and grows the model-offered set", async () => {
	const dir = await tempDir("sigrun-ts-load-");
	try {
		await writeConfig(stubConfigPath(dir), { stub: deferredStub() });
		const opened = await openToolSearchHarness(dir, [
			fauxAssistantMessage(
				fauxToolCall("tool_search", { query: "echo greeting" }, { id: "call-1" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done after search"),
		]);
		try {
			const root = await opened.harness.root(BACKGROUND_CONTEXT, {
				agent: { model: opened.defaultModel },
			});
			const { settled, page } = await runTurn(root, "find the echo tool");
			expect(settled.status).toBe("done");
			// 1. tool_search("echo") returns the stub tool.
			const result = toolResultOf(page, "tool_search");
			expect(result).toBeDefined();
			expect(result!.isError).toBe(false);
			expect(result!.loaded).toContain("stub/echo");
			expect(result!.text).toContain("Loaded 1 tool");
			expect(result!.text).toContain("stub/echo");
			// 2. addTools grew the model-offered set: a `pi.system` entry with
			//    toolsAdded records the load on the transcript (the
			//    prompt-cache DIFF — not the first request's tool_search
			//    entry)…
			const loadEntry = page.find(
				(entry) => (toolsAddedOf(entry) ?? []).includes("stub/echo"),
			);
			expect(loadEntry).toBeDefined();
			// …and agent.tools — the LIVE offered set — non-vacuously holds the
			// loaded name now (the write IS the offered set's growth).
			const agent = await root.agent(BACKGROUND_CONTEXT);
			expect(agent.tools.map((tool) => tool.name)).toContain("stub/echo");
			// The loaded tool LEAVES agent.deferred — it is "deferred tools the
			// model is not offered YET" (computed), so the still-unloaded
			// sibling remains alone there.
			expect(namesOf(agent.deferred)).toEqual(["stub/add"]);
		} finally {
			await closeOpened(opened);
		}
	} finally {
		await cleanupDir(dir);
	}
});

test("the NEXT model call invokes the loaded tool directly (offered, not re-searched)", async () => {
	const dir = await tempDir("sigrun-ts-invoke-");
	try {
		await writeConfig(stubConfigPath(dir), { stub: deferredStub() });
		const opened = await openToolSearchHarness(dir, [
			fauxAssistantMessage(
				fauxToolCall("tool_search", { query: "echo greeting" }, { id: "call-1" }),
				{ stopReason: "toolUse" },
			),
			// The next model call, same run (the generation continues after
			// the tool round): the direct stub/echo invocation.
			fauxAssistantMessage(
				fauxToolCall("stub/echo", { name: "sigruNN" }, { id: "call-2" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done after echo"),
		]);
		try {
			const root = await opened.harness.root(BACKGROUND_CONTEXT, {
				agent: { model: opened.defaultModel },
			});
			const { settled, page } = await runTurn(
				root,
				"find the echo tool and greet",
			);
			expect(settled.status).toBe("done");
			// The direct invocation executed through the real MCP bridge.
			const echoResult = toolResultOf(page, "stub/echo");
			expect(echoResult).toBeDefined();
			expect(echoResult!.isError).toBe(false);
			expect(echoResult!.text).toContain("hello, sigruNN");
			// The load PRECEDES the invocation: the `pi.system` toolsAdded
			// entry has a lower entry id than the entry holding the direct
			// stub/echo call's result (entries ascend by id).
			const loadId = page.find(
				(entry) => (toolsAddedOf(entry) ?? []).includes("stub/echo"),
			) as { id: number } | undefined;
			expect(loadId).toBeDefined();
			const invokeId = page.find((entry) =>
				((entry as { kind?: string }).kind === "pi.tool-result" &&
					jsonOf(entry).includes("hello, sigruNN")) as boolean,
			) as { id: number } | undefined;
			expect(invokeId).toBeDefined();
			expect(loadId!.id).toBeLessThan(invokeId!.id);
		} finally {
			await closeOpened(opened);
		}
	} finally {
		await cleanupDir(dir);
	}
});

test("the loaded set survives a fork at a later entry", async () => {
	const dir = await tempDir("sigrun-ts-fork-");
	try {
		await writeConfig(stubConfigPath(dir), { stub: deferredStub() });
		const opened = await openToolSearchHarness(dir, [
			fauxAssistantMessage(
				fauxToolCall("tool_search", { query: "echo greeting" }, { id: "call-1" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("ack"),
			// The fork's turn: its DIRECT echo call proves the fork carried
			// the loaded set as of the fork entry.
			fauxAssistantMessage(
				fauxToolCall("stub/echo", { name: "fromFork" }, { id: "call-2" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("fork done"),
		]);
		try {
			const root = await opened.harness.root(BACKGROUND_CONTEXT, {
				agent: { model: opened.defaultModel },
			});
			const first = await runTurn(root, "find the echo tool");
			expect(first.settled.status).toBe("done");

			// Fork at the newest entry (after the load landed): the fork's
			// pi.agent copy keeps modelTools.add, so stub/echo is offered on
			// the fork branch and its direct call resolves.
			const newest = first.page[0]!;
			const forked = await root.fork(
				newest.id,
				{ ownership: { kind: "ownerless" }, agent: { model: opened.defaultModel } },
				BACKGROUND_CONTEXT,
			);
			const agent = await forked.agent(BACKGROUND_CONTEXT);
			expect(agent.tools.map((tool) => tool.name)).toContain("stub/echo");
			const forkedTurn = await runTurn(forked, "greet in the fork");
			expect(forkedTurn.settled.status).toBe("done");
			const echoResult = toolResultOf(forkedTurn.page, "stub/echo");
			expect(echoResult).toBeDefined();
			expect(echoResult!.text).toContain("hello, fromFork");
		} finally {
			await closeOpened(opened);
		}
	} finally {
		await cleanupDir(dir);
	}
});

test("nothing deferred → tool_search returns an EMPTY result, not an error", async () => {
	const dir = await tempDir("sigrun-ts-empty-");
	try {
		// No MCP servers at all: nothing deferred exists.
		await writeConfig(stubConfigPath(dir), {});
		const opened = await openToolSearchHarness(dir, [
			fauxAssistantMessage(
				fauxToolCall("tool_search", { query: "echo" }, { id: "call-1" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done after empty search"),
		]);
		try {
			const root = await opened.harness.root(BACKGROUND_CONTEXT, {
				agent: { model: opened.defaultModel },
			});
			const agent = await root.agent(BACKGROUND_CONTEXT);
			expect(namesOf(agent.deferred)).toEqual([]);
			const { settled, page } = await runTurn(root, "search for anything");
			expect(settled.status).toBe("done");
			const result = toolResultOf(page, "tool_search");
			expect(result).toBeDefined();
			expect(result!.isError).toBe(false);
			// Upstream always returns details { loaded: [...] }: EMPTY here.
			expect(result!.loaded).toEqual([]);
			expect(result!.text).toContain("No matching tools found");
			// No tools were loaded: no `pi.system` toolsAdded entry beyond the
			// first request's own offering (the diff never names a stub tool).
			const loads = page.filter(
				(entry) => (toolsAddedOf(entry) ?? []).includes("stub/echo") ||
					(toolsAddedOf(entry) ?? []).includes("stub/add"),
			);
			expect(loads).toEqual([]);
		} finally {
			await closeOpened(opened);
		}
	} finally {
		await cleanupDir(dir);
	}
});

test("a deferred server but a query matching nothing → empty result, not an error", async () => {
	const dir = await tempDir("sigrun-ts-nomatch-");
	try {
		await writeConfig(stubConfigPath(dir), { stub: deferredStub() });
		const opened = await openToolSearchHarness(dir, [
			fauxAssistantMessage(
				// No deferred tool text contains "zeppelin".
				fauxToolCall("tool_search", { query: "zeppelin" }, { id: "call-1" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done after empty search"),
		]);
		try {
			const root = await opened.harness.root(BACKGROUND_CONTEXT, {
				agent: { model: opened.defaultModel },
			});
			const agent = await root.agent(BACKGROUND_CONTEXT);
			expect(namesOf(agent.deferred)).toEqual(["stub/add", "stub/echo"]);
			const { settled, page } = await runTurn(root, "search for a zeppelin");
			expect(settled.status).toBe("done");
			const result = toolResultOf(page, "tool_search");
			expect(result).toBeDefined();
			expect(result!.isError).toBe(false);
			expect(result!.loaded).toEqual([]);
			expect(result!.text).toContain("No matching tools found");
			// No tool was loaded: no `pi.system` toolsAdded entry names a
			// deferred tool, and the offered set did not grow.
			const loads = page.filter(
				(entry) => (toolsAddedOf(entry) ?? []).includes("stub/echo") ||
					(toolsAddedOf(entry) ?? []).includes("stub/add"),
			);
			expect(loads).toEqual([]);
			const after = await root.agent(BACKGROUND_CONTEXT);
			expect(namesOf(after.tools)).not.toContain("stub/echo");
		} finally {
			await closeOpened(opened);
		}
	} finally {
		await cleanupDir(dir);
	}
});

test("the notice channel: removed from the offered set → the notice renders", async () => {
	const dir = await tempDir("sigrun-ts-notice-");
	try {
		await writeConfig(stubConfigPath(dir), { stub: deferredStub() });
		const opened = await openToolSearchHarness(dir);
		try {
			const root = await opened.harness.root(BACKGROUND_CONTEXT, {});
			let agent = await root.agent(BACKGROUND_CONTEXT);
			// Offered: no notice.
			expect(agent.tools.map((tool) => tool.name)).toContain("tool_search");
			expect(await renderNotice(opened.harness, root.id, agent)).toBeUndefined();

			// Settings-shaped removal: modelTools removes the tool_search
			// tool (never widens; other callers can still call it).
			const toolSearchTool = agent.tools.find(
				(tool) => tool.name === "tool_search",
			)!;
			await root.configure(
				{ modelTools: { remove: [toolSearchTool] } },
				BACKGROUND_CONTEXT,
			);
			agent = await root.agent(BACKGROUND_CONTEXT);
			expect(agent.tools.map((tool) => tool.name)).not.toContain("tool_search");
			// Still installed (agent.extensions registers it): only the
			// model-offer set narrowed — the exact state the notice targets.
			const notice = await renderNotice(opened.harness, root.id, agent);
			expect(notice).toBe(TOOL_SEARCH_NOT_OFFERED_NOTICE);

			// Re-offering silences the notice again.
			await root.configure(
				{ modelTools: { remove: [] } },
				BACKGROUND_CONTEXT,
			);
			agent = await root.agent(BACKGROUND_CONTEXT);
			expect(agent.tools.map((tool) => tool.name)).toContain("tool_search");
			expect(await renderNotice(opened.harness, root.id, agent)).toBeUndefined();
		} finally {
			await closeOpened(opened);
		}
	} finally {
		await cleanupDir(dir);
	}
});