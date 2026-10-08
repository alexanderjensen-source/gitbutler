<script lang="ts">
	import Resizer from "$components/shared/Resizer.svelte";
	import FloatingModal from "$lib/floating/FloatingModal.svelte";
	import { getStackContext } from "$lib/stacks/stackController.svelte";
	import { useTerminal } from "$lib/terminal/useTerminal.svelte";
	import { Button } from "@gitbutler/ui-svelte";
	import "@xterm/xterm/css/xterm.css";

	const { branchName: topBranchName }: { branchName: string | undefined } = $props();

	const controller = getStackContext();
	const poppedOut = $derived(controller.isTerminalPoppedOut);
	const branchNames = $derived(controller.branchNames);

	let selectedBranch = $state<string | undefined>();
	const branchName = $derived(selectedBranch ?? topBranchName);

	let panelEl = $state<HTMLDivElement>();
	let headerEl = $state<HTMLDivElement>();
	let terminalEl = $state<HTMLDivElement>();

	// Docking/undocking swaps `terminalEl`; the hook moves the live screen into the new one.
	const terminal = useTerminal({
		projectId: () => controller.projectId,
		branchName: () => branchName,
		container: () => terminalEl,
	});
</script>

{#snippet header()}
	<div class="stack-terminal__header" class:draggable={poppedOut} bind:this={headerEl}>
		{#if branchNames.length > 1}
			<select
				class="text-12 stack-terminal__branch"
				value={branchName}
				onchange={(event) => (selectedBranch = event.currentTarget.value)}
			>
				{#each branchNames as name (name)}
					<option value={name}>{name}</option>
				{/each}
			</select>
		{:else}
			<span class="text-12 text-semibold truncate">
				{poppedOut && branchName ? `Terminal · ${branchName}` : "Terminal"}
			</span>
		{/if}
		<div class="stack-terminal__actions">
			<Button
				kind="ghost"
				icon={poppedOut ? "pop-out-top-left" : "pop-out-bottom-right"}
				size="tag"
				tooltip={poppedOut ? "Dock terminal" : "Pop out terminal"}
				onclick={() => controller.toggleTerminalPopout()}
			/>
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
{/snippet}

{#if poppedOut}
	<FloatingModal
		persistId="floating-terminal-size"
		dragHandleElement={headerEl}
		defaults={{
			snapPosition: "bottom-right",
			width: 720,
			height: 420,
			minWidth: 360,
			minHeight: 200,
		}}
	>
		<div class="stack-terminal popped-out">
			{@render header()}
			<div class="stack-terminal__body" bind:this={terminalEl}></div>
		</div>
	</FloatingModal>
{:else}
	<div class="stack-terminal" bind:this={panelEl}>
		{@render header()}
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
{/if}

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

		&.popped-out {
			flex: 1;
			height: auto;
			margin: 0;
			border: none;
			border-radius: 0;
		}
	}

	.stack-terminal__header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 4px 4px 4px 10px;
		gap: 8px;
		border-bottom: 1px solid var(--border-2);
		color: var(--text-2);

		&.draggable {
			cursor: grab;
		}
	}

	.stack-terminal__branch {
		min-width: 0;
		padding: 2px 4px;
		border: 1px solid var(--border-2);
		border-radius: var(--radius-s);
		background: var(--bg-2);
		color: var(--text-1);
	}

	.stack-terminal__actions {
		display: flex;
		flex-shrink: 0;
		gap: 2px;
	}

	.stack-terminal__body {
		flex: 1;
		min-height: 0;
		padding: 4px 0 0 8px;
	}
</style>
