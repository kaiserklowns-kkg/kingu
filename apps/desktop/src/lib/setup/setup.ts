export type SetupStatus = 'ok' | 'warn' | 'fail';

export type SetupCheck = {
	id: string;
	status: SetupStatus;
	detail?: string;
	found?: string[];
};

export type SetupReport = {
	os: string;
	arch: string;
	checks: SetupCheck[];
};

export type Readiness = 'loading' | 'ready' | 'warn' | 'blocked';

export function failures(report: SetupReport | null): SetupCheck[] {
	return report?.checks.filter((c) => c.status === 'fail') ?? [];
}

export function warnings(report: SetupReport | null): SetupCheck[] {
	return report?.checks.filter((c) => c.status === 'warn') ?? [];
}

export function readiness(report: SetupReport | null): Readiness {
	if (!report) return 'loading';
	if (failures(report).length) return 'blocked';
	if (warnings(report).length) return 'warn';
	return 'ready';
}
