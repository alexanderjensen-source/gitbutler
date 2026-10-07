import { PROJECTS_SERVICE } from "$lib/project/projectsService";
import { PTY_SERVICE } from "$lib/terminal/terminalService";
import { inject } from "@gitbutler/core/context";

/**
 * Shows the lane's terminal inside `container`, spawning it on first use.
 * Unmounting only detaches the screen; the shell and its scrollback live on in `PtyService`.
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

		let disposed = false;
		let detach: (() => void) | undefined;

		async function attach(target: HTMLElement) {
			const project = await projectsService.fetchProject(projectId);
			if (disposed || !project) return;
			const { term, fit } = await ptyService.session(laneId, project.path);
			if (disposed) return;

			// xterm can only `open` once; after that its element is moved between containers.
			if (term.element) target.appendChild(term.element);
			else term.open(target);
			fit.fit();
			term.refresh(0, term.rows - 1);
			term.focus();

			const observer = new ResizeObserver(() => fit.fit());
			observer.observe(target);
			const element = term.element;
			detach = () => {
				observer.disconnect();
				element?.remove();
			};
		}

		attach(container).catch((error: unknown) => {
			const message = error instanceof Error ? error.message : JSON.stringify(error);
			container.textContent = `Failed to start shell: ${message}`;
		});

		return () => {
			disposed = true;
			detach?.();
		};
	});

	return {
		async restart() {
			await ptyService.killLane(params.laneId());
			generation++;
		},
		async close() {
			await ptyService.killLane(params.laneId());
		},
	};
}
