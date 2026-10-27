/**
 * Shared test harness: opens a REAL pi-durable Harness (registry + faux
 * provider) with the sigrun-ext-tool-search extension AND the sigrun-ext-mcp
 * extension (the deferred-exposure config producer) installed against a
 * temp config — the same shape as sigrun-ext-mcp's and sigrun-ext-codemode's
 * harness tests, no sigrun-core dependency.
 *
 * The MCP wiring is the real sigrun-ext-mcp factory, so the deferred tools
 * in these tests are produced by exactly the machinery that produces them
 * in prod — the e2e is over Task 4's verified `exposure: "deferred"` shape,
 * not a hand-rolled deferred registration.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	createRegistry,
	Harness,
	type ModelRef,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { MCP_CONFIG_ENV, createMcpExtension, type McpWiring } from "@sigrun/ext-mcp";
import type { SigrunHost } from "@sigrun/ext-mcp";
import { createToolSearchWiring } from "../src/index.js";

/** The acting user these fixtures run as. Shared catalog tools fail closed
 * for an unidentified caller, so the MCP extension needs a host that names
 * one (its access check reads host.identity.actingUser). */
const TEST_USER = "synthetic-user";

/** A minimal structural sigrun host: enough for the MCP extension's shared
 * catalog path (identity + per-user settings). Shared servers connect
 * directly, so services.connect is never reached here. */
function createTestHost(): SigrunHost {
	const settings = new Map<string, Record<string, unknown>>();
	return {
		tools: { setUserTools: () => undefined },
		services: {
			connect: () => {
				throw new Error("services.connect is not used by shared servers");
			},
		},
		stores: {
			user: (user) => ({
				secrets: {
					get: async () => undefined,
					set: async () => undefined,
					delete: async () => undefined,
				},
				settings: {
					get: async () => ({ ...(settings.get(user) ?? {}) }),
					set: async (value) => {
						settings.set(user, { ...value });
					},
				},
				paths: { data: "/tmp/data", state: "/tmp/state", cache: "/tmp/cache" },
			}),
		},
		identity: { actingUser: async () => TEST_USER },
	};
}

/** Configure the factories' config store via the env override. */
export function stubConfigPath(dir: string): string {
	return join(dir, "mcp.json");
}

export async function writeConfig(
	path: string,
	servers: Record<string, unknown>,
): Promise<void> {
	// Catalog servers default to per-user credentials; these fixtures
	// exercise the system-child (shared) shape, so declare it explicitly.
	const shared = Object.fromEntries(
		Object.entries(servers).map(([name, server]) => [
			name,
			{
				credentials: "shared",
				sharedAuthority: "Synthetic shared test authority",
				...(server as Record<string, unknown>),
			},
		]),
	);
	await writeFile(path, JSON.stringify({ servers: shared }), "utf8");
}

export interface OpenedHarness {
	readonly harness: Harness;
	readonly defaultModel: ModelRef;
	readonly mcpWiring: McpWiring;
	readonly registry: ReturnType<typeof createRegistry>;
}

/**
 * Open a real pi-durable harness with the tool-search extension AND the
 * MCP extension (which reads the same env override) installed.
 */
export async function openToolSearchHarness(
	dir: string,
	responses: Parameters<
		ReturnType<typeof fauxProvider>["setResponses"]
	>[0] = [fauxAssistantMessage("no tools needed")],
): Promise<OpenedHarness> {
	const prior = process.env[MCP_CONFIG_ENV];
	process.env[MCP_CONFIG_ENV] = stubConfigPath(dir);
	let mcpWiring: McpWiring;
	try {
		mcpWiring = createMcpExtension(createTestHost());
	} finally {
		if (prior === undefined) delete process.env[MCP_CONFIG_ENV];
		else process.env[MCP_CONFIG_ENV] = prior;
	}
	await mcpWiring.ready; // deferred tools present before the registry snapshot read

	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses(responses);
	const models = createModels();
	models.setProvider(faux.provider);
	const defaultModel: ModelRef = { provider: "faux", modelId: "m" };

	const registry = createRegistry();
	registry.install(createToolSearchWiring().extension);
	registry.install(mcpWiring.extension);

	const harness = await Harness.open(
		await openNodeSqliteStorage(join(dir, "sigrun.db")),
		{ models, registry },
		BACKGROUND_CONTEXT,
	);
	harness.resume();
	return { harness, defaultModel, mcpWiring, registry };
}

/** Fresh temp dir; the test body receives it and must clean up. */
export async function tempDir(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

export async function cleanupDir(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true });
}

/** Close an opened harness; safe in test finally blocks. */
export async function closeOpened(opened: OpenedHarness): Promise<void> {
	await opened.harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
	opened.mcpWiring.close();
}