<script lang="ts">
	import Resizer from "$components/shared/Resizer.svelte";
	import { getStackContext } from "$lib/stacks/stackController.svelte";
	import { useTerminal } from "$lib/terminal/useTerminal.svelte";
	import { Button } from "@gitbutler/ui-svelte";
	import "@xterm/xterm/css/xterm.css";

	const { branchName }: { branchName: string | undefined } = $props();

	const controller = getStackContext();

	let panelEl = $state<HTMLDivElement>();
	let terminalEl = $state<HTMLDivElement>();

	const terminal = useTerminal({
		projectId: () => controller.projectId,
		laneId: () => controller.laneId,
		branchName: () => branchName,
		container: () => terminalEl,
	});
</script>

<div class="stack-terminal" bind:this={panelEl}>
	<div class="stack-terminal__header">
		<span class="text-12 text-semibold">Terminal</span>
		<div class="stack-terminal__actions">
			<Button
				kind="ghost"
				icon="refresh"
				size="tag"
				tooltip="Restart shell"
				onclick={terminal.restart}
			/>
			<Button
				kind="ghost"
				icon="cross"
				size="tag"
				tooltip="Close terminal"
				onclick={async () => {
					controller.toggleTerminal();
					await terminal.close();
				}}
			/>
		</div>
	</div>
	<div class="stack-terminal__body" bind:this={terminalEl}></div>

	{#if panelEl}
		<Resizer
			viewport={panelEl}
			direction="up"
			persistId="ui-stack-terminal-height"
			defaultValue={16}
			minHeight={8}
			maxHeight={48}
		/>
	{/if}
</div>

<style lang="postcss">
	.stack-terminal {
		display: flex;
		position: relative;
		flex-shrink: 0;
		flex-direction: column;
		height: 16rem;
		margin: 0 12px 12px;
		overflow: hidden;
		border: 1px solid var(--border-2);
		border-radius: var(--radius-m);
		background-color: var(--bg-1);
	}

	.stack-terminal__header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 4px 4px 4px 10px;
		border-bottom: 1px solid var(--border-2);
		color: var(--text-2);
	}

	.stack-terminal__actions {
		display: flex;
		gap: 2px;
	}

	.stack-terminal__body {
		flex: 1;
		min-height: 0;
		padding: 4px 0 0 8px;
	}
</style>
