<script lang="ts" module>
	import type { ChatView } from './chatParts';

	export type TimelineRun = ChatView;
</script>

<script lang="ts">
	// An agent run as a chat list (ChatList.svelte), for places without request actions (the ADE
	// task page). Pending permission requests and questions are answerable when `onanswer` is given.
	import type { Snippet } from 'svelte';
	import ChatList from './ChatList.svelte';
	import type { Decision, PermissionRequest } from './events';

	let {
		run,
		onanswer,
		empty,
		checkpoint,
		reverted,
		class: klass = ''
	}: {
		run: TimelineRun | undefined;
		onanswer?: (request: PermissionRequest, decision: Decision, message?: string, answers?: Record<string, string>) => void;
		empty?: Snippet;
		/** A chat's request row action (Restore checkpoint), rendered at each `checkpoint` event. */
		checkpoint?: Snippet<[number]>;
		/** Requests whose file changes were undone by Restore checkpoint: their entries are greyed. */
		reverted?: (request: number) => boolean;
		class?: string;
	} = $props();
</script>

<ChatList {run} {onanswer} {empty} {checkpoint} {reverted} class={klass} />
