import { BACKEND } from "$lib/backend";
import { PROJECTS_SERVICE } from "$lib/project/projectsService";
import { PTY_SERVICE } from "$lib/terminal/terminalService";
import { inject } from "@gitbutler/core/context";

/** POSIX single-quoting: branch names may legally contain `;`, `$`, `&`, etc. */
function shellQuote(value: string): string {
	const escaped = value.replaceAll("'", String.raw`'\''`);
	return `'${escaped}'`;
}

/** Resumes the branch's Claude session, or starts one named after the branch. */
function claudeCommand(branchName: string): string {
	const name = shellQuote(branchName);
	return `claude --resume ${name} || claude --name ${name}`;
}

/**
 * Shows the lane's terminal inside `container`, spawning it on first use.
 * Unmounting only detaches the screen; the shell and its scrollback live on in `PtyService`.
 */
export function useTerminal(params: {
	projectId: () => string;
	laneId: () => string;
	/** The lane's top branch; scrollback is saved per branch, so it survives unapply and re-apply. */
	branchName: () => string | undefined;
	container: () => HTMLElement | undefined;
}) {
	const ptyService = inject(PTY_SERVICE);
	const projectsService = inject(PROJECTS_SERVICE);
	// PowerShell quotes differently; only auto-start Claude on POSIX shells.
	const autoStartClaude = inject(BACKEND).platformName !== "windows";

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
			// Read after the await so a branch rename doesn't re-run this effect.
			const branchName = params.branchName();
			const { term, fit } = await ptyService.session(laneId, {
				cwd: project.path,
				historyKey: branchName ? `${projectId}/${branchName}` : undefined,
				startupCommand: branchName && autoStartClaude ? claudeCommand(branchName) : undefined,
			});
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
