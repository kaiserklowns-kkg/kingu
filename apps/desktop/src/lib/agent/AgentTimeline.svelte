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
		class: klass = ''
	}: {
		run: TimelineRun | undefined;
		onanswer?: (request: PermissionRequest, decision: Decision, message?: string, answers?: Record<string, string>) => void;
		empty?: Snippet;
		class?: string;
	} = $props();
</script>

<ChatList {run} {onanswer} {empty} class={klass} />
