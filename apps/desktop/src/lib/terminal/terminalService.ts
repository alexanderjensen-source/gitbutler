import { InjectionToken } from "@gitbutler/core/context";
import type { IBackend } from "$lib/backend";

export const PTY_SERVICE = new InjectionToken<PtyService>("PtyService");

/** Wraps the backend PTY commands; output/exit events are scoped per terminal ID. */
export class PtyService {
	/** Lane ID → running terminal ID. In-memory only: IDs don't survive an app restart. */
	private readonly laneTerminals = new Map<string, string>();

	constructor(private readonly backend: IBackend) {}

	async getOrSpawn(
		laneId: string,
		params: { cwd: string; cols: number; rows: number },
	): Promise<string> {
		const existing = this.laneTerminals.get(laneId);
		if (existing) return existing;
		const terminalId = await this.backend.invoke<string>("spawn_terminal", params);
		this.laneTerminals.set(laneId, terminalId);
		return terminalId;
	}

	/** Drops the mapping only if it still points at `terminalId`, so a late exit can't evict a restarted shell. */
	forgetLane(laneId: string, terminalId: string) {
		if (this.laneTerminals.get(laneId) === terminalId) this.laneTerminals.delete(laneId);
	}

	async killLane(laneId: string): Promise<void> {
		const terminalId = this.laneTerminals.get(laneId);
		if (!terminalId) return;
		this.laneTerminals.delete(laneId);
		await this.kill(terminalId);
	}

	async write(terminalId: string, data: string): Promise<void> {
		await this.backend.invoke("write_to_terminal", { terminalId, data });
	}

	async resize(terminalId: string, cols: number, rows: number): Promise<void> {
		await this.backend.invoke("resize_terminal", { terminalId, cols, rows });
	}

	async kill(terminalId: string): Promise<void> {
		await this.backend.invoke("kill_terminal", { terminalId });
	}

	onOutput(terminalId: string, callback: (data: string) => void) {
		return this.backend.listen<{ data: string }>(`terminal://${terminalId}/output`, (event) =>
			callback(event.payload.data),
		);
	}

	onExit(terminalId: string, callback: () => void) {
		return this.backend.listen(`terminal://${terminalId}/exit`, () => callback());
	}
}
