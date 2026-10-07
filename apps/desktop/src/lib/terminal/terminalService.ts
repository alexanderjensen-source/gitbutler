import { InjectionToken } from "@gitbutler/core/context";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { IBackend } from "$lib/backend";

export const PTY_SERVICE = new InjectionToken<PtyService>("PtyService");

export type LaneTerminal = {
	terminalId: string;
	term: Terminal;
	fit: FitAddon;
	dispose: () => void;
};

/**
 * Owns one shell + xterm screen per lane. Both outlive the component that shows them,
 * so folding a lane or hiding the panel keeps the session and its scrollback intact.
 */
export class PtyService {
	/** Lane ID → session. In-memory only: shells don't survive an app restart. */
	private readonly sessions = new Map<string, Promise<LaneTerminal>>();

	constructor(private readonly backend: IBackend) {}

	session(laneId: string, cwd: string): Promise<LaneTerminal> {
		let session = this.sessions.get(laneId);
		if (!session) {
			session = this.spawn(cwd);
			this.sessions.set(laneId, session);
			session.catch(() => this.sessions.delete(laneId));
		}
		return session;
	}

	async killLane(laneId: string): Promise<void> {
		const session = this.sessions.get(laneId);
		if (!session) return;
		this.sessions.delete(laneId);
		const { terminalId, dispose } = await session;
		dispose();
		// The shell may already have exited on its own, in which case the backend no longer knows it.
		await this.backend.invoke("kill_terminal", { terminalId }).catch(() => {});
	}

	private async spawn(cwd: string): Promise<LaneTerminal> {
		const term = new Terminal({ cursorBlink: true, fontSize: 12 });
		const fit = new FitAddon();
		term.loadAddon(fit);

		const terminalId = await this.backend.invoke<string>("spawn_terminal", {
			cwd,
			cols: term.cols,
			rows: term.rows,
		});

		const unlistenOutput = this.backend.listen<{ data: string }>(
			`terminal://${terminalId}/output`,
			(event) => term.write(event.payload.data),
		);
		const unlistenExit = this.backend.listen(`terminal://${terminalId}/exit`, () =>
			term.write("\r\n[process exited]\r\n"),
		);
		const input = term.onData(
			async (data) => await this.backend.invoke("write_to_terminal", { terminalId, data }),
		);
		const resize = term.onResize(
			async ({ cols, rows }) =>
				await this.backend.invoke("resize_terminal", { terminalId, cols, rows }),
		);

		return {
			terminalId,
			term,
			fit,
			dispose: () => {
				unlistenOutput();
				unlistenExit();
				input.dispose();
				resize.dispose();
				term.dispose();
			},
		};
	}
}
