import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { SubscriptionOrderSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/subscription-order-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { toSessionPinAccounts } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/session-pin";
import { setKeybindings } from "@oh-my-pi/pi-tui";

const RIGHT = "\x1b[C";
const ENTER = "\n";
const CANCEL = "\x07"; // ctrl+g, remapped to tui.select.cancel below

beforeAll(async () => {
	await initTheme();
});

beforeEach(() => {
	setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "ctrl+g" }));
});

afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
});

function makeAccounts(count: number) {
	return toSessionPinAccounts(
		Array.from({ length: count }, (_, index) => ({
			position: index,
			credentialId: 10 + index,
			email: `user${index}@example.com`,
			active: false,
		})),
	);
}

function createComponent(count = 3) {
	const closes: Array<readonly number[] | undefined> = [];
	const component = new SubscriptionOrderSelectorComponent("Anthropic", makeAccounts(count), order =>
		closes.push(order),
	);
	return { component, closes, rows: () => stripVTControlCharacters(component.renderContent(60).join("\n")) };
}

describe("SubscriptionOrderSelectorComponent", () => {
	it("moves the highlighted account with ←/→ and persists the final order once, on close", () => {
		const { component, closes } = createComponent();

		// Cursor starts on the top account (user0); → moves it one slot down.
		component.handleInput(RIGHT);
		// Again drops user0 to the last position, the cursor following it.
		component.handleInput(RIGHT);
		// At the bottom, → is a no-op.
		component.handleInput(RIGHT);
		expect(closes).toHaveLength(0);

		component.handleInput(ENTER);
		expect(closes).toEqual([[11, 12, 10]]);
	});

	it("renumbers the rows so the visible positions match the persisted priority", () => {
		const { component, closes, rows } = createComponent();
		component.handleInput(RIGHT);

		expect(rows()).toContain(" 1. user1@example.com");
		expect(rows()).toContain(" 2. user0@example.com");
		expect(rows()).toContain(" 3. user2@example.com");

		component.handleInput(ENTER);
		expect(closes[0]).toEqual([11, 10, 12]);
	});

	it("reports no order at all when the user closes without moving anything", () => {
		const confirmed = createComponent();
		confirmed.component.handleInput(ENTER);
		expect(confirmed.closes).toEqual([undefined]);

		const cancelled = createComponent();
		cancelled.component.handleInput(CANCEL);
		expect(cancelled.closes).toEqual([undefined]);
	});

	it("keeps the move on the cancel key, matching the hint and the already-visible reordering", () => {
		const { component, closes } = createComponent();
		component.handleInput(RIGHT);
		component.handleInput(CANCEL);

		expect(closes).toEqual([[11, 10, 12]]);
	});

	it("reorders rather than type-to-filtering when the list overflows the visible window", () => {
		// 12 accounts exceed the 10-row window, where SelectList would otherwise
		// turn printable keys into a fuzzy filter — "z" matches no account, so a
		// live filter would blank the list while ←/→ kept swapping rows nobody
		// can see.
		const { component, closes, rows } = createComponent(12);

		component.handleInput("z");
		expect(rows()).toContain(" 1. user0@example.com");
		expect(rows()).toContain(" 2. user1@example.com");

		component.handleInput(RIGHT);
		component.handleInput(ENTER);
		expect(closes[0]?.slice(0, 3)).toEqual([11, 10, 12]);
	});
});
