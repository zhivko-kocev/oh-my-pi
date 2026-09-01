import { Container, type SelectItem, SelectList, type SgrMouseEvent, TruncatedText } from "@oh-my-pi/pi-tui";
import { getSelectListTheme, theme } from "../../modes/theme/theme";
import type { SessionPinAccount } from "../../slash-commands/helpers/session-pin";
import { OverlayPanel } from "./overlay-box";
import { routeSelectListMouseWithTopBorder } from "./select-list-mouse-routing";

const ORDER_SELECTOR_MAX_VISIBLE = 10;
const ORDER_SELECTOR_HINT = "↑/↓ select · ←/→ move · Enter or Esc save";

/**
 * Reorderable list of a provider's OAuth accounts, opened by `/session order`.
 * The top row is the highest-priority (default) account; ←/→ move the
 * highlighted account and the rows shift under the cursor immediately.
 *
 * Enter and Esc both save. There is no preview and no undo affordance to
 * discover, so the overlay has already shown the reordering as done by the time
 * either key is pressed — discarding on Esc would throw away work the user
 * watched happen. The order is handed to `onClose` once, on close, rather than
 * on every keypress, because persisting it re-reads and re-merges the settings
 * layers and an arrow key auto-repeats.
 */
export class SubscriptionOrderSelectorComponent extends OverlayPanel {
	#accounts: SessionPinAccount[];
	#listContainer = new Container();
	#selectList!: SelectList;
	#cursor = 0;
	#moved = false;

	/** `onClose` receives the new credential-id order, or `undefined` if nothing moved. */
	constructor(
		providerName: string,
		accounts: readonly SessionPinAccount[],
		private readonly onClose: (credentialIds: readonly number[] | undefined) => void,
	) {
		super(`Order ${providerName} accounts by priority`);
		this.#accounts = [...accounts];
		this.addChild(this.#listContainer);
		this.addChild(new TruncatedText(theme.fg("muted", ORDER_SELECTOR_HINT), 0, 0));
		this.#rebuild();
	}

	#rebuild(): void {
		this.#listContainer.clear();
		const items: SelectItem[] = this.#accounts.map((account, index) => ({
			value: String(account.credentialId),
			label: `${String(index + 1).padStart(2)}. ${account.label}`,
			description: index === 0 ? "default (highest priority)" : account.active ? "pinned this session" : undefined,
		}));
		this.#selectList = new SelectList(
			items,
			Math.min(Math.max(items.length, 1), ORDER_SELECTOR_MAX_VISIBLE),
			getSelectListTheme(),
			// Type-to-filter would hide rows while ←/→ keeps swapping neighbours in
			// the unfiltered order, so a keystroke could silently move an account
			// the user cannot see. Reordering has nothing to search for anyway.
			{ overflowSearch: false },
		);
		this.#selectList.setSelectedIndex(this.#cursor);
		this.#selectList.onSelectionChange = item => {
			this.#cursor = this.#accounts.findIndex(account => String(account.credentialId) === item.value);
		};
		this.#selectList.onSelect = () => this.#close();
		this.#selectList.onCancel = () => this.#close();
		this.#listContainer.addChild(this.#selectList);
	}

	#close(): void {
		this.onClose(this.#moved ? this.#accounts.map(account => account.credentialId) : undefined);
	}

	#move(delta: -1 | 1): void {
		const from = this.#cursor;
		const to = from + delta;
		if (to < 0 || to >= this.#accounts.length) return;
		const next = [...this.#accounts];
		const moved = next[from]!;
		next[from] = next[to]!;
		next[to] = moved;
		this.#accounts = next;
		this.#cursor = to;
		this.#moved = true;
		this.#rebuild();
	}

	/** Forward navigation and intercept ←/→ to reorder the highlighted account. */
	handleInput(keyData: string): void {
		if (keyData === "\x1b[D" || keyData === "\x1b[C") {
			this.#move(keyData === "\x1b[D" ? -1 : 1);
			return;
		}
		this.#selectList.handleInput(keyData);
	}

	/** Route mouse navigation through the title rows into the account list. */
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		routeSelectListMouseWithTopBorder(this.#selectList, event, line, col);
	}
}
