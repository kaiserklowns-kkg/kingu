// The parts of the Debug Adapter Protocol Kingu uses (microsoft.github.io/debug-adapter-protocol).

export type Request = { seq: number; type: 'request'; command: string; arguments?: any };
export type Response = { seq: number; type: 'response'; request_seq: number; success: boolean; command: string; message?: string; body?: any };
export type Event = { seq: number; type: 'event'; event: string; body?: any };
export type ProtocolMessage = Request | Response | Event;

export type Capabilities = {
	supportsConfigurationDoneRequest?: boolean;
	supportsConditionalBreakpoints?: boolean;
	supportsEvaluateForHovers?: boolean;
	supportsRestartRequest?: boolean;
	supportsTerminateRequest?: boolean;
	exceptionBreakpointFilters?: { filter: string; label: string; default?: boolean }[];
};

export type Source = { name?: string; path?: string; sourceReference?: number };
export type SourceBreakpoint = { line: number; condition?: string };
export type Breakpoint = { id?: number; verified: boolean; message?: string; line?: number; source?: Source };
export type Thread = { id: number; name: string };
export type StackFrame = { id: number; name: string; source?: Source; line: number; column: number; presentationHint?: string };
export type Scope = { name: string; variablesReference: number; expensive: boolean };
export type Variable = { name: string; value: string; type?: string; variablesReference: number; evaluateName?: string };

export type StoppedEvent = { reason: string; description?: string; threadId?: number; allThreadsStopped?: boolean; text?: string };
export type OutputEvent = { category?: string; output: string };

export type RunInTerminalArguments = { kind?: 'integrated' | 'external'; title?: string; cwd: string; args: string[]; env?: Record<string, string | null> };
