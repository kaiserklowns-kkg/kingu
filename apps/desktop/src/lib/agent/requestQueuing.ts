// What Send does while a turn runs (VS Code's chatQueuePickerActionItem / chatQueueActions):
//   queue   "Add to Queue": sent when the current turn ends
//   steer   "Steer with Message": into the running session now; the agent reads it at its next
//           opportunity (the host pushes it into the SDK's streaming input)
//   stop    "Stop and Send": interrupt the turn, then send
// Enter runs `kingu.chat.requestQueuing.defaultAction` (queue or steer), ⌥Enter the other one.

export type SendHow = 'queue' | 'steer' | 'stop';
export type QueueDefault = 'queue' | 'steer';
export const QUEUE_DEFAULTS: readonly QueueDefault[] = ['queue', 'steer'];

/** The setting's value, falling back to `queue` for anything else. */
export const queueDefault = (v: unknown): QueueDefault => (v === 'steer' ? 'steer' : 'queue');

/** Enter (`alt` false) or ⌥Enter (`alt` true) while a turn runs. */
export const sendHowFor = (def: QueueDefault, alt: boolean): QueueDefault => (alt ? (def === 'queue' ? 'steer' : 'queue') : def);

/** The menu's order, with which key runs each (null: only from the menu). */
export function sendMenu(def: QueueDefault): { how: SendHow; key: 'enter' | 'altEnter' | null }[] {
	return [
		{ how: 'queue', key: def === 'queue' ? 'enter' : 'altEnter' },
		{ how: 'steer', key: def === 'steer' ? 'enter' : 'altEnter' },
		{ how: 'stop', key: null }
	];
}
