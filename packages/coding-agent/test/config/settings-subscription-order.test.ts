import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

describe("auth.subscriptionOrder persistence", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-subscription-order-test-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		AgentStorage.close();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await tempDir?.remove();
	});

	const getConfigPath = () => path.join(agentDir, "config.yml");

	const writeSettings = async (settings: Record<string, unknown>) => {
		await Bun.write(getConfigPath(), YAML.stringify(settings, null, 2));
	};

	const readSubscriptionOrder = async (): Promise<Record<string, unknown> | undefined> => {
		const file = Bun.file(getConfigPath());
		if (!(await file.exists())) return undefined;
		const parsed: unknown = YAML.parse(await file.text());
		if (!parsed || typeof parsed !== "object") return undefined;
		const auth = (parsed as Record<string, unknown>).auth;
		if (!auth || typeof auth !== "object") return undefined;
		return (auth as Record<string, unknown>).subscriptionOrder as Record<string, unknown> | undefined;
	};

	it("preserves another provider's order written by a concurrently running instance", async () => {
		await writeSettings({ modelRoles: { default: "anthropic/claude-sonnet-4-5" } });

		// This process loads its #global snapshot before any order exists.
		const settings = await Settings.init({ cwd: projectDir, agentDir });

		// A second live omp instance saves the Anthropic order afterwards, so
		// this process's in-memory record never sees it (no config watcher).
		await writeSettings({
			modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			auth: { subscriptionOrder: { anthropic: [7, 3] } },
		});

		settings.setSubscriptionOrder("openai-codex", [11, 5]);
		await settings.flush();

		expect(await readSubscriptionOrder()).toEqual({
			anthropic: [7, 3],
			"openai-codex": [11, 5],
		});
		expect(settings.get("auth.subscriptionOrder")).toEqual({
			anthropic: [7, 3],
			"openai-codex": [11, 5],
		});
	});

	it("removes a provider entry when its order is cleared", async () => {
		await writeSettings({
			auth: { subscriptionOrder: { anthropic: [7], "openai-codex": [11] } },
		});
		const settings = await Settings.init({ cwd: projectDir, agentDir });

		settings.setSubscriptionOrder("anthropic", []);
		await settings.flush();

		expect(await readSubscriptionOrder()).toEqual({ "openai-codex": [11] });
		expect(settings.get("auth.subscriptionOrder").anthropic).toBeUndefined();
	});

	it("rejects a provider id that would write through the record prototype", async () => {
		const settings = await Settings.init({ cwd: projectDir, agentDir });

		settings.setSubscriptionOrder("__proto__", [7]);
		await settings.flush();

		const order = settings.get("auth.subscriptionOrder");
		expect(Object.hasOwn(order, "__proto__")).toBe(false);
		expect(Object.getPrototypeOf(order)).toBe(Object.prototype);
		expect(await readSubscriptionOrder()).toBeUndefined();
	});
});
