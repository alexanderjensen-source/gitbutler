import { BACKEND } from "$lib/backend";
import { PROJECTS_SERVICE } from "$lib/project/projectsService";
import { PTY_SERVICE } from "$lib/terminal/terminalService";
import { inject } from "@gitbutler/core/context";

/** One shell, one history, one Claude session per branch. */
export function sessionKey(projectId: string, branchName: string): string {
	return `${projectId}/${branchName}`;
}

/** POSIX single-quoting: branch names may legally contain `;`, `$`, `&`, etc. */
function shellQuote(value: string): string {
	const escaped = value.replaceAll("'", String.raw`'\''`);
	return `'${escaped}'`;
}

/**
 * Resumes the branch's Claude session if one with that name exists, otherwise starts one
 * named after the branch. The existence check is a non-interactive `--resume`, which fails
 * fast with "does not match any session title" when there's no such session.
 */
function claudeCommand(branchName: string): string {
	const name = shellQuote(branchName);
	const noSuchSession = `claude -p --resume ${name} </dev/null 2>&1 | grep -q 'does not match any session'`;
	return `if ${noSuchSession}; then claude --name ${name}; else claude --resume ${name}; fi`;
}

/**
 * Shows the lane's terminal inside `container`, spawning it on first use.
 * Unmounting only detaches the screen; the shell and its scrollback live on in `PtyService`.
 */
export function useTerminal(params: {
	projectId: () => string;
	/** The branch whose shell this shows; each branch in a stack gets its own. */
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
		const projectId = params.projectId();
		const branchName = params.branchName();
		void generation;
		if (!container || !branchName) return;
		const branch: string = branchName;

		let disposed = false;
		let detach: (() => void) | undefined;

		async function attach(target: HTMLElement) {
			const project = await projectsService.fetchProject(projectId);
			if (disposed || !project) return;
			const { term, fit } = await ptyService.session(sessionKey(projectId, branch), {
				cwd: project.path,
				startupCommand: autoStartClaude ? claudeCommand(branch) : undefined,
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
			await ptyService.kill(sessionKey(params.projectId(), params.branchName() ?? ""));
			generation++;
		},
		async close() {
			await ptyService.kill(sessionKey(params.projectId(), params.branchName() ?? ""));
		},
	};
}
