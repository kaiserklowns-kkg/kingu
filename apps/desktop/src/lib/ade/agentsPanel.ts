// Orca's session-history time: Just now, 5m ago, 3h ago, 2d ago, 4mo ago, 1y ago.
export function sessionAgo(then: number, now: number): string {
	if (!then) return 'Unknown time';
	const s = Math.max(0, now - then) / 1000;
	if (s < 60) return 'Just now';
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
	if (s < 30 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
	if (s < 365 * 86_400) return `${Math.floor(s / (30 * 86_400))}mo ago`;
	return `${Math.floor(s / (365 * 86_400))}y ago`;
}
