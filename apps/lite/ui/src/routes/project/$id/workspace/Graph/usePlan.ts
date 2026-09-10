import {
	headInfoQueryOptions,
	olderTargetCommitsInfiniteQueryOptions,
	workspaceTargetCommitsQueryOptions,
} from "#ui/api/queries.ts";
import { projectSlice } from "#ui/projects/state.ts";
import { useAppDispatch, useAppSelector } from "#ui/store.ts";
import type { Stack, Worktree } from "@gitbutler/but-sdk";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { layout, MORE_COMMITS, type Plan } from "./layout.ts";

const noWorktrees: ReadonlyArray<Worktree> = [];

/** The stacks graph as its host computes it once: the plan, the cards in its order, the linked worktrees, and the target line. */
export type Graph = ReturnType<typeof usePlan>;

/** The stacks graph's plan and the cards in its order. Called once per host, which hands it to the stacks. */
export const usePlan = (projectId: string) => {
	const dispatch = useAppDispatch();
	const { data: headInfo } = useQuery(headInfoQueryOptions(projectId));
	const { data: listing } = useQuery(workspaceTargetCommitsQueryOptions(projectId));
	const folds = useAppSelector((state) =>
		projectSlice.selectors.selectGraphFolds(state, projectId),
	);
	const listOrder = useMemo(() => headInfo?.stacks ?? [], [headInfo]);
	const target = headInfo?.target ?? null;
	const worktrees = headInfo?.worktrees ?? noWorktrees;
	const olderFrom = listing?.commits.at(-1)?.commit.id ?? "";
	const {
		data: olderData,
		fetchNextPage,
		hasNextPage,
		isFetching,
		isError,
	} = useInfiniteQuery({
		...olderTargetCommitsInfiniteQueryOptions(projectId, olderFrom),
		enabled: folds.historyExpanded && olderFrom !== "",
	});
	const olderPages = useMemo(
		() => olderData?.pages.flatMap((page) => page.commits) ?? [],
		[olderData],
	);
	// Keep the plan stable: the rails re-measure whenever its identity changes.
	const plan: Plan = useMemo(
		() => layout(listOrder, target, listing, folds, worktrees, olderPages),
		[listOrder, target, listing, folds, worktrees, olderPages],
	);
	const stacks: Array<Stack> = useMemo(
		() =>
			plan.order.flatMap((index) => {
				const stack = listOrder[index];
				return stack === undefined ? [] : [stack];
			}),
		[plan, listOrder],
	);
	const showMoreHistory = async () => {
		if (isFetching) return;
		if (plan.historyHidden < MORE_COMMITS && (olderData === undefined || hasNextPage)) {
			const result = await fetchNextPage();
			if (result.isError) return;
		}
		dispatch(projectSlice.actions.showMoreGraphHistory({ projectId }));
	};
	return {
		plan,
		stacks,
		worktrees,
		listing,
		showMoreHistory,
		historyMore: isFetching
			? ("loading" as const)
			: isError
				? ("failed" as const)
				: plan.historyHidden > 0 || hasNextPage
					? ("idle" as const)
					: ("hidden" as const),
	};
};
