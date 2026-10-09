import { InjectionToken } from "@gitbutler/core/context";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/xterm";
import type { IBackend } from "$lib/backend";
import type { DiskStore } from "$lib/backend/backend";

export const PTY_SERVICE = new InjectionToken<PtyService>("PtyService");

const HISTORY_FILE = "terminal-history.json";
const HISTORY_LINES = 1000;
const SAVE_INTERVAL_MS = 2000;
const RESTORED_MARKER = "\x1b[2m— restored from previous session —\x1b[0m\r\n";

export type LaneTerminal = {
	terminalId: string;
	term: Terminal;
	fit: FitAddon;
	/** Tells the shell the screen's current size; call after fitting, since a resize event only fires on change. */
	syncSize: () => Promise<void>;
	/** Runs the startup command, once. Call after the first fit so it starts at the real size. */
	start: () => Promise<void>;
	/** Saves history, then tears down the screen and its listeners (not the shell). */
	dispose: () => Promise<void>;
};

/**
 * Owns one shell + xterm screen per lane. Both outlive the component that shows them,
 * so folding a lane or hiding the panel keeps the session intact. Scrollback is also
 * saved to disk under `historyKey`, and replayed above a fresh shell after an app restart.
 */
export class PtyService {
	/** `projectId/branchName` → session. In-memory only: shells don't survive an app restart. */
	private readonly sessions = new Map<string, Promise<LaneTerminal>>();
	private historyStore: Promise<DiskStore> | undefined;

	constructor(private readonly backend: IBackend) {}

	session(key: string, params: { cwd: string; startupCommand?: string }): Promise<LaneTerminal> {
		let session = this.sessions.get(key);
		if (!session) {
			session = this.spawn({ ...params, historyKey: key });
			this.sessions.set(key, session);
			session.catch(() => this.sessions.delete(key));
		}
		return session;
	}

	async kill(key: string): Promise<void> {
		const session = this.sessions.get(key);
		if (!session) return;
		this.sessions.delete(key);
		const { terminalId, dispose } = await session;
		await dispose();
		// The shell may already have exited on its own, in which case the backend no longer knows it.
		await this.backend.invoke("kill_terminal", { terminalId }).catch(() => {});
	}

	private history(): Promise<DiskStore> {
		this.historyStore ??= this.backend.loadDiskStore(HISTORY_FILE);
		return this.historyStore;
	}

	private async spawn({
		cwd,
		historyKey,
		startupCommand,
	}: {
		cwd: string;
		historyKey: string;
		/** Typed into the new shell, so the shell remains once the command exits. */
		startupCommand?: string;
	}): Promise<LaneTerminal> {
		const term = new Terminal({ cursorBlink: true, fontSize: 12 });
		const fit = new FitAddon();
		const serializer = new SerializeAddon();
		term.loadAddon(fit);
		term.loadAddon(serializer);

		const saved = await (await this.history()).get<string>(historyKey, undefined);
		if (saved) term.write(`${saved}\r\n${RESTORED_MARKER}`);

		let saveTimer: ReturnType<typeof setTimeout> | undefined;
		const save = async () => {
			clearTimeout(saveTimer);
			saveTimer = undefined;
			// Skip the alternate screen and terminal modes so a restore can't leave the new shell
			// stuck in a full-screen app's display state.
			const snapshot = serializer.serialize({
				scrollback: HISTORY_LINES,
				excludeAltBuffer: true,
				excludeModes: true,
			});
			await (await this.history()).set(historyKey, snapshot);
		};
		// Throttled rather than debounced, so a continuously streaming program still gets saved.
		const scheduleSave = () => {
			if (saveTimer) return;
			saveTimer = setTimeout(() => {
				save().catch((error: unknown) => console.error("Failed to save terminal history", error));
			}, SAVE_INTERVAL_MS);
		};

		const terminalId = await this.backend.invoke<string>("spawn_terminal", {
			cwd,
			cols: term.cols,
			rows: term.rows,
		});

		// The DOM renderer sometimes leaves rows stale after a full-screen UI redraws in place (cursor
		// moves in a choice list); a full repaint, like docking or resizing triggers, clears it.
		let repaintFrame: number | undefined;
		const scheduleRepaint = () => {
			if (repaintFrame !== undefined) return;
			repaintFrame = requestAnimationFrame(() => {
				repaintFrame = undefined;
				if (term.element) term.refresh(0, term.rows - 1);
			});
		};

		const unlistenOutput = this.backend.listen<{ data: string }>(
			`terminal://${terminalId}/output`,
			(event) => {
				term.write(event.payload.data, scheduleRepaint);
				scheduleSave();
			},
		);
		const unlistenExit = this.backend.listen(`terminal://${terminalId}/exit`, async () => {
			term.write("\r\n[process exited]\r\n");
			await save();
		});
		const input = term.onData(
			async (data) => await this.backend.invoke("write_to_terminal", { terminalId, data }),
		);
		// Resizes are chained: concurrent IPC calls can be applied out of order, leaving the PTY
		// at a stale size that disagrees with the screen (output then overprints the last line).
		let resizeQueue: Promise<void> = Promise.resolve();
		const syncSize = () => {
			const { cols, rows } = term;
			resizeQueue = resizeQueue
				.then(() => this.backend.invoke<void>("resize_terminal", { terminalId, cols, rows }))
				.catch((error: unknown) => console.warn("Failed to resize terminal", terminalId, error));
			return resizeQueue;
		};
		const resize = term.onResize(() => void syncSize());

		// Held back until the screen has been fitted: a program that starts at the spawn-time default
		// size and is resized afterwards draws with line counts that no longer match what xterm shows.
		let pendingStartup = startupCommand;
		const start = async () => {
			if (!pendingStartup) return;
			const data = `${pendingStartup}\r`;
			pendingStartup = undefined;
			await this.backend.invoke("write_to_terminal", { terminalId, data });
		};

		return {
			terminalId,
			term,
			fit,
			syncSize,
			start,
			dispose: async () => {
				await save();
				await Promise.all([unlistenOutput(), unlistenExit()]);
				if (repaintFrame !== undefined) cancelAnimationFrame(repaintFrame);
				input.dispose();
				resize.dispose();
				term.dispose();
			},
		};
	}
}
