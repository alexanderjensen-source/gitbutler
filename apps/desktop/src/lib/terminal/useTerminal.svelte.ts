import { PROJECTS_SERVICE } from "$lib/project/projectsService";
import { PTY_SERVICE } from "$lib/terminal/terminalService";
import { inject } from "@gitbutler/core/context";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

/**
 * Attaches an xterm.js view to the lane's shell session, spawning one on first use.
 * Unmounting only detaches the view; the shell keeps running until killed.
 */
export function useTerminal(params: {
	projectId: () => string;
	laneId: () => string;
	container: () => HTMLElement | undefined;
}) {
	const ptyService = inject(PTY_SERVICE);
	const projectsService = inject(PROJECTS_SERVICE);

	let generation = $state(0);

	$effect(() => {
		const container = params.container();
		const laneId = params.laneId();
		const projectId = params.projectId();
		void generation;
		if (!container) return;

		const term = new Terminal({ cursorBlink: true, fontSize: 12 });
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(container);
		fit.fit();

		let disposed = false;
		const cleanups: (() => unknown)[] = [];

		async function attach() {
			const project = await projectsService.fetchProject(projectId);
			if (disposed || !project) return;
			const terminalId = await ptyService.getOrSpawn(laneId, {
				cwd: project.path,
				cols: term.cols,
				rows: term.rows,
			});
			if (disposed) return;

			cleanups.push(
				ptyService.onOutput(terminalId, (data) => term.write(data)),
				ptyService.onExit(terminalId, () => {
					ptyService.forgetLane(laneId, terminalId);
					term.write("\r\n[process exited]\r\n");
				}),
			);
			const input = term.onData((data) => ptyService.write(terminalId, data));
			const resize = term.onResize(({ cols, rows }) => ptyService.resize(terminalId, cols, rows));
			cleanups.push(
				() => input.dispose(),
				() => resize.dispose(),
			);
			await ptyService.resize(terminalId, term.cols, term.rows);
		}
		attach().catch((error: unknown) => {
			const message = error instanceof Error ? error.message : JSON.stringify(error);
			term.write(`\r\n[failed to start shell: ${message}]\r\n`);
		});

		const observer = new ResizeObserver(() => fit.fit());
		observer.observe(container);

		return () => {
			disposed = true;
			observer.disconnect();
			for (const cleanup of cleanups) cleanup();
			term.dispose();
		};
	});

	return {
		async restart() {
			await ptyService.killLane(params.laneId());
			generation++;
		},
	};
}
