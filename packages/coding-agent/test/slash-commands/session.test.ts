import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { OAuthAccountSummary } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	ACP_BUILTIN_SLASH_COMMANDS,
	executeAcpBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

function createRuntimeHarness(options?: {
	handleSessionCommand?: InteractiveModeContext["handleSessionCommand"];
	handleSessionDeleteCommand?: InteractiveModeContext["handleSessionDeleteCommand"];
	showSessionPinSelector?: InteractiveModeContext["showSessionPinSelector"];
}) {
	const setText = vi.fn();
	const handleSessionCommand =
		options?.handleSessionCommand ??
		vi.fn(async () => {
			return;
		});
	const handleSessionDeleteCommand =
		options?.handleSessionDeleteCommand ??
		vi.fn(async () => {
			return;
		});
	const showSessionPinSelector =
		options?.showSessionPinSelector ??
		vi.fn(async () => {
			return;
		});

	return {
		setText,
		handleSessionCommand,
		handleSessionDeleteCommand,
		showSessionPinSelector,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				handleSessionCommand,
				handleSessionDeleteCommand,
				showSessionPinSelector,
			} as InteractiveModeContext,
		},
	};
}

describe("/session slash command", () => {
	it("awaits session info before resolving the default command", async () => {
		const deferred = Promise.withResolvers<void>();
		const handleSessionCommand = vi.fn(() => deferred.promise);
		const harness = createRuntimeHarness({ handleSessionCommand });

		let settled = false;
		const execution = executeBuiltinSlashCommand("/session", harness.runtime).then(result => {
			settled = true;
			return result;
		});

		await Promise.resolve();

		expect(handleSessionCommand).toHaveBeenCalledTimes(1);
		expect(harness.handleSessionDeleteCommand).not.toHaveBeenCalled();
		expect(harness.setText).not.toHaveBeenCalled();
		expect(settled).toBe(false);

		deferred.resolve();

		expect(await execution).toBe(true);
		expect(settled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("awaits the session account picker", async () => {
		const deferred = Promise.withResolvers<void>();
		const showSessionPinSelector = vi.fn(() => deferred.promise);
		const harness = createRuntimeHarness({ showSessionPinSelector });
		let settled = false;
		const execution = executeBuiltinSlashCommand("/session pin", harness.runtime).then(result => {
			settled = true;
			return result;
		});

		await Promise.resolve();
		expect(showSessionPinSelector).toHaveBeenCalledTimes(1);
		expect(harness.setText).not.toHaveBeenCalled();
		expect(settled).toBe(false);

		deferred.resolve();
		expect(await execution).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("propagates session info failures through executeBuiltinSlashCommand", async () => {
		const infoError = new Error("info failed");
		const handleSessionCommand = vi.fn(async () => {
			throw infoError;
		});
		const harness = createRuntimeHarness({ handleSessionCommand });

		await expect(executeBuiltinSlashCommand("/session info", harness.runtime)).rejects.toBe(infoError);
		expect(handleSessionCommand).toHaveBeenCalledTimes(1);
		expect(harness.handleSessionDeleteCommand).not.toHaveBeenCalled();
		expect(harness.setText).not.toHaveBeenCalled();
	});

	it("awaits session deletion before resolving the builtin command", async () => {
		const deferred = Promise.withResolvers<void>();
		const handleSessionDeleteCommand = vi.fn(() => deferred.promise);
		const harness = createRuntimeHarness({ handleSessionDeleteCommand });

		let settled = false;
		const execution = executeBuiltinSlashCommand("/session delete", harness.runtime).then(result => {
			settled = true;
			return result;
		});

		await Promise.resolve();

		expect(handleSessionDeleteCommand).toHaveBeenCalledTimes(1);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(settled).toBe(false);

		deferred.resolve();

		expect(await execution).toBe(true);
		expect(settled).toBe(true);
	});

	it("propagates session deletion failures through executeBuiltinSlashCommand", async () => {
		const deleteError = new Error("delete failed");
		const handleSessionDeleteCommand = vi.fn(async () => {
			throw deleteError;
		});
		const harness = createRuntimeHarness({ handleSessionDeleteCommand });

		await expect(executeBuiltinSlashCommand("/session delete", harness.runtime)).rejects.toBe(deleteError);
		expect(handleSessionDeleteCommand).toHaveBeenCalledTimes(1);
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});

/**
 * `/session order` parses positions itself before touching the session, so the
 * harness only needs the two session calls it makes plus a text sink. Both
 * dispatch paths share `handleSessionOrderCommand`; the TUI runtime drives the
 * `<positions>` form and the ACP runtime the bare listing form (bare `/session
 * order` opens the overlay in the TUI instead).
 */
function createOrderHarness(accounts: readonly Partial<OAuthAccountSummary>[]) {
	const lines: string[] = [];
	const setCurrentProviderSubscriptionOrder = vi.fn((_ids: readonly number[]) => "test-provider");
	const listCurrentProviderOAuthAccounts = vi.fn(async () => ({
		// Unknown to getOAuthProviders(), so the rendered provider name is this id.
		provider: "test-provider",
		accounts: accounts.map((account, index) => ({
			position: index,
			credentialId: 100 + index,
			active: false,
			...account,
		})) as OAuthAccountSummary[],
	}));
	const session = {
		listCurrentProviderOAuthAccounts,
		setCurrentProviderSubscriptionOrder,
	} as unknown as AgentSession;

	return {
		setCurrentProviderSubscriptionOrder,
		text: () => lines.join("\n"),
		runtime: {
			ctx: {
				editor: { setText: vi.fn() } as unknown as InteractiveModeContext["editor"],
				showStatus: (message: string) => lines.push(message),
				statusLine: { invalidate: vi.fn() } as unknown as InteractiveModeContext["statusLine"],
				ui: { requestRender: vi.fn() } as unknown as InteractiveModeContext["ui"],
				session,
			} as unknown as InteractiveModeContext,
		},
		acpRuntime: {
			session,
			output: (message: string) => {
				lines.push(message);
			},
		} as unknown as SlashCommandRuntime,
	};
}

const THREE_ACCOUNTS = [{ email: "a@example.com" }, { email: "b@example.com" }, { email: "c@example.com" }];

describe("/session order", () => {
	it.each([
		["1.5", "fractional"],
		["NaN", "non-numeric"],
		["Infinity", "infinite"],
		["-1", "negative"],
		["0", "below the first position"],
		["4", "past the last position"],
	])("rejects %s (%s) without touching the stored order", async token => {
		const harness = createOrderHarness(THREE_ACCOUNTS);

		await executeBuiltinSlashCommand(`/session order ${token}`, harness.runtime);

		expect(harness.text()).toBe(`Invalid position "${token}". Use numbers 1-3.`);
		expect(harness.setCurrentProviderSubscriptionOrder).not.toHaveBeenCalled();
	});

	it("rejects the whole list when a later token is invalid", async () => {
		const harness = createOrderHarness(THREE_ACCOUNTS);

		await executeBuiltinSlashCommand("/session order 2 9", harness.runtime);

		expect(harness.text()).toBe('Invalid position "9". Use numbers 1-3.');
		expect(harness.setCurrentProviderSubscriptionOrder).not.toHaveBeenCalled();
	});

	it("accepts comma- and space-padded positions and appends the unlisted accounts", async () => {
		const harness = createOrderHarness(THREE_ACCOUNTS);

		await executeBuiltinSlashCommand("/session order  2 , 3 ", harness.runtime);

		expect(harness.setCurrentProviderSubscriptionOrder).toHaveBeenCalledWith([101, 102, 100]);
		expect(harness.text()).toBe("Saved test-provider account priority order.");
	});

	it("absorbs a repeated position instead of duplicating its credential id", async () => {
		const harness = createOrderHarness(THREE_ACCOUNTS);

		await executeBuiltinSlashCommand("/session order 3 3 1", harness.runtime);

		expect(harness.setCurrentProviderSubscriptionOrder).toHaveBeenCalledWith([102, 100, 101]);
	});

	it("lists the current order with 1-based numbering when given no positions", async () => {
		const harness = createOrderHarness(THREE_ACCOUNTS);

		await executeAcpBuiltinSlashCommand("/session order", harness.acpRuntime);

		expect(harness.text()).toContain("1. a@example.com");
		expect(harness.text()).toContain("2. b@example.com");
		expect(harness.text()).toContain("3. c@example.com");
		expect(harness.setCurrentProviderSubscriptionOrder).not.toHaveBeenCalled();
	});

	it("advertises the positions argument to ACP clients", () => {
		const advertised = ACP_BUILTIN_SLASH_COMMANDS.find(command => command.name === "session");
		expect(advertised?.input?.hint).toBe("[info|delete|pin [account]|order [positions]]");
	});
});
