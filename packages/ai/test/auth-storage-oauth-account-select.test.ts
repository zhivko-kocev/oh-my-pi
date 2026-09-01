import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withOAuthAccess } from "@oh-my-pi/pi-ai/auth-retry";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";

const PROVIDER = "unit-oauth-select";
/**
 * A session id whose credential rotation slot is 2 of 3 (`Bun.hash.xxHash32`
 * modulo the account count), so a rotation-seeded start is observably different
 * from a priority-seeded one.
 */
const SESSION_HASH_SLOT_2 = "order-seed";

function oauthCredential(suffix: string) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `acc-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

/** Durable row id of the stored account carrying `accountId`. */
function credentialIdFor(storage: AuthStorage, accountId: string): number {
	const account = storage.listOAuthAccounts(PROVIDER).find(candidate => candidate.accountId === accountId);
	if (!account) throw new Error(`missing stored account ${accountId}`);
	return account.credentialId;
}

describe("AuthStorage OAuth account selection", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-oauth-select-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	test("listOAuthAccounts reports stored order, positions, and identity without refreshing", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		const refreshSpy = vi.spyOn(oauthUtils, "getOAuthApiKey");
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);

		const accounts = storage.listOAuthAccounts(PROVIDER);

		expect(accounts.map(a => a.position)).toEqual([0, 1, 2]);
		expect(accounts.map(a => a.accountId)).toEqual(["acc-a", "acc-b", "acc-c"]);
		expect(accounts.map(a => a.email)).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
		// Read-only: listing must not refresh any token.
		expect(refreshSpy).not.toHaveBeenCalled();
	});

	test("pinSessionOAuthAccount selects and restores the exact stored account", async () => {
		const storage = authStorage;
		const credentialStore = store;
		if (!storage || !credentialStore) throw new Error("test setup failed");
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		const accounts = storage.listOAuthAccounts(PROVIDER, "session-pin");
		const target = accounts[1];
		if (!target) throw new Error("expected second OAuth account");

		expect(accounts.some(account => account.active)).toBe(false);
		expect(storage.pinSessionOAuthAccount(PROVIDER, "session-pin", -1)).toBe(false);
		expect(storage.pinSessionOAuthAccount(PROVIDER, "session-pin", target.credentialId)).toBe(true);
		expect(storage.getOAuthAccountIdentity(PROVIDER, "session-pin")?.email).toBe("b@example.com");
		expect(
			storage
				.listOAuthAccounts(PROVIDER, "session-pin")
				.filter(account => account.active)
				.map(account => account.email),
		).toEqual(["b@example.com"]);
		expect(
			await withOAuthAccess(storage, PROVIDER, access => Promise.resolve(access.email), {
				sessionId: "session-pin",
			}),
		).toBe("b@example.com");

		const restored = new AuthStorage(credentialStore);
		await restored.reload();
		expect(restored.getOAuthAccountIdentity(PROVIDER, "session-pin")?.email).toBe("b@example.com");
		expect(restored.listOAuthAccounts(PROVIDER, "session-pin").find(account => account.active)?.credentialId).toBe(
			target.credentialId,
		);
	});

	test("getOAuthAccessAt resolves the credential at the requested position and touches only that one", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		const seen: string[] = [];
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			seen.push(credential.access);
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);

		for (const [position, suffix] of [
			[0, "a"],
			[1, "b"],
			[2, "c"],
		] as const) {
			seen.length = 0;
			const result = await storage.getOAuthAccessAt(PROVIDER, position);
			expect(result?.ok).toBe(true);
			if (!result?.ok) throw new Error("expected ok resolution");
			expect(result.accountId).toBe(`acc-${suffix}`);
			expect(result.accessToken).toBe(`access-${suffix}`);
			// Only the targeted credential is resolved — no sibling is touched.
			expect(seen).toEqual([`access-${suffix}`]);
		}
	});

	test("getOAuthAccessByCredentialId refreshes only the durable requested row", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		const seen: string[] = [];
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			seen.push(credential.access);
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		const target = storage.listOAuthAccounts(PROVIDER)[1];
		if (!target) throw new Error("expected second OAuth account");

		const result = await storage.getOAuthAccessByCredentialId(PROVIDER, target.credentialId, { forceRefresh: true });

		expect(result?.ok).toBe(true);
		if (!result?.ok) throw new Error("expected ok resolution");
		expect(result.credentialId).toBe(target.credentialId);
		expect(result.accountId).toBe("acc-b");
		expect(result.accessToken).toBe("access-b");
		expect(seen).toEqual(["access-b"]);
	});

	test("getOAuthAccessByCredentialId does not substitute a sibling on failure", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		const seen: string[] = [];
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			seen.push(credential.access);
			if (credential.accountId === "acc-b") throw new Error("invalid_grant");
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		const target = storage.listOAuthAccounts(PROVIDER)[1];
		if (!target) throw new Error("expected second OAuth account");

		const result = await storage.getOAuthAccessByCredentialId(PROVIDER, target.credentialId);

		expect(result?.ok).toBe(false);
		if (!result || result.ok) throw new Error("expected failed resolution");
		expect(result.credentialId).toBe(target.credentialId);
		expect(result.accountId).toBe("acc-b");
		expect(seen).toEqual(["access-b"]);
	});

	test("getOAuthAccessAt returns undefined for an out-of-range position", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		expect(await storage.getOAuthAccessAt(PROVIDER, 2)).toBeUndefined();
		expect(await storage.getOAuthAccessAt(PROVIDER, -1)).toBeUndefined();
	});

	test("getOAuthAccessAt fails the requested account without touching siblings", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		// The targeted account (acc-b) fails definitively; siblings would refresh fine.
		const seen: string[] = [];
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			seen.push(credential.access);
			if (credential.access === "access-b") throw new Error("invalid_grant");
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);

		const result = await storage.getOAuthAccessAt(PROVIDER, 1);

		expect(result?.ok).toBe(false);
		if (!result || result.ok) throw new Error("expected failed resolution");
		// Reports the requested account, never a sibling's token.
		expect(result.accountId).toBe("acc-b");
		expect("accessToken" in result).toBe(false);
		// Target-only: no sibling credential was refreshed/rotated on the failure path.
		expect(seen).toEqual(["access-b"]);
	});

	test("subscription order resolver reorders account listing", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);

		// Ids must be read before the resolver is installed: reading them through
		// listOAuthAccounts is what the resolver would otherwise recurse into.
		const idC = credentialIdFor(storage, "acc-c");
		const idA = credentialIdFor(storage, "acc-a");
		// Rank c first, a second; b is unranked and must stay after the ranked ones.
		storage.setSubscriptionOrderResolver(provider => (provider === PROVIDER ? [idC, idA] : undefined));
		const ordered = storage.listOAuthAccounts(PROVIDER);
		expect(ordered.map(account => account.accountId)).toEqual(["acc-c", "acc-a", "acc-b"]);
		expect(ordered.map(account => account.position)).toEqual([0, 1, 2]);

		// Clearing the resolver restores stable storage order.
		storage.setSubscriptionOrderResolver(undefined);
		expect(storage.listOAuthAccounts(PROVIDER).map(account => account.accountId)).toEqual([
			"acc-a",
			"acc-b",
			"acc-c",
		]);
	});

	test("subscription order changes which account the top position resolves to", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const idB = credentialIdFor(storage, "acc-b");

		storage.setSubscriptionOrderResolver(() => [idB]);
		const top = await storage.getOAuthAccessAt(PROVIDER, 0);
		expect(top?.ok).toBe(true);
		if (!top?.ok) throw new Error("expected successful resolution");
		expect(top.accountId).toBe("acc-b");
	});

	test("subscription order seeds a fresh session's selection without a ranking strategy", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		const idC = credentialIdFor(storage, "acc-c");

		// Ranking c first makes the priority order [c, a, b]. This session's hash
		// slot is 2 (xxHash32("order-seed") % 3), so a rotation-seeded start would
		// pick the LOWEST-priority entry (acc-b) instead of the user's top choice.
		storage.setSubscriptionOrderResolver(() => [idC]);
		expect((await storage.getOAuthAccess(PROVIDER, SESSION_HASH_SLOT_2))?.accountId).toBe("acc-c");
	});

	test("session rotation still seeds selection when no subscription order is configured", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);

		// Same session, same hash slot 2 — with no user order the rotation decides.
		expect((await storage.getOAuthAccess(PROVIDER, SESSION_HASH_SLOT_2))?.accountId).toBe("acc-c");
	});

	test("a session pin survives a reorder that moves it off the top", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		const targetId = credentialIdFor(storage, "acc-b");
		expect(storage.pinSessionOAuthAccount(PROVIDER, "session-reorder", targetId)).toBe(true);

		// The pin is bookkept against the durable row, not the listing position:
		// reordering acc-b to the bottom must not repoint it at a sibling.
		const order = [credentialIdFor(storage, "acc-c"), credentialIdFor(storage, "acc-a")];
		storage.setSubscriptionOrderResolver(() => order);

		const accounts = storage.listOAuthAccounts(PROVIDER, "session-reorder");
		expect(accounts.map(account => account.accountId)).toEqual(["acc-c", "acc-a", "acc-b"]);
		expect(accounts.find(account => account.active)?.credentialId).toBe(targetId);
		const resolved = await storage.getOAuthAccess(PROVIDER, "session-reorder");
		expect(resolved?.accountId).toBe("acc-b");
		expect(resolved?.accessToken).toBe("access-b");
	});

	test("the pre-sticky default account is the priority-top one, not the first stored", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const idB = credentialIdFor(storage, "acc-b");
		storage.setSubscriptionOrderResolver(() => [idB]);

		// No session has resolved or pinned yet, so every "which account am I on"
		// read must name the same account the listing calls the default.
		expect(storage.listOAuthAccounts(PROVIDER)[0]?.accountId).toBe("acc-b");
		expect(storage.getOAuthAccountId(PROVIDER, "session-unresolved")).toBe("acc-b");
		expect(storage.getOAuthAccountIdentity(PROVIDER, "session-unresolved")?.email).toBe("b@example.com");
	});
});
