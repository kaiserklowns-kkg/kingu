// The parts of the Debug Adapter Protocol Kingu uses (microsoft.github.io/debug-adapter-protocol).

export type Request = { seq: number; type: 'request'; command: string; arguments?: any };
export type Response = { seq: number; type: 'response'; request_seq: number; success: boolean; command: string; message?: string; body?: any };
export type Event = { seq: number; type: 'event'; event: string; body?: any };
export type ProtocolMessage = Request | Response | Event;

/** DAP ExceptionBreakpointsFilter. */
export type ExceptionFilter = { filter: string; label: string; description?: string; default?: boolean; supportsCondition?: boolean; conditionDescription?: string };

export type Capabilities = {
	supportsConfigurationDoneRequest?: boolean;
	supportsFunctionBreakpoints?: boolean;
	supportsConditionalBreakpoints?: boolean;
	supportsHitConditionalBreakpoints?: boolean;
	supportsEvaluateForHovers?: boolean;
	exceptionBreakpointFilters?: ExceptionFilter[];
	supportsStepBack?: boolean;
	supportsSetVariable?: boolean;
	supportsRestartFrame?: boolean;
	supportsGotoTargetsRequest?: boolean;
	supportsCompletionsRequest?: boolean;
	completionTriggerCharacters?: string[];
	supportsRestartRequest?: boolean;
	supportsExceptionOptions?: boolean;
	supportsExceptionFilterOptions?: boolean;
	supportsTerminateRequest?: boolean;
	supportsDataBreakpoints?: boolean;
	supportsLogPoints?: boolean;
	supportsBreakpointLocationsRequest?: boolean;
	supportsClipboardContext?: boolean;
};

export type Source = { name?: string; path?: string; sourceReference?: number; presentationHint?: string };
export type SourceBreakpoint = { line: number; column?: number; condition?: string; hitCondition?: string; logMessage?: string };
export type FunctionBreakpoint = { name: string; condition?: string; hitCondition?: string };
export type DataBreakpoint = { dataId: string; accessType?: DataAccessType; condition?: string; hitCondition?: string };
export type DataAccessType = 'read' | 'write' | 'readWrite';
export type DataBreakpointInfo = { dataId: string | null; description: string; accessTypes?: DataAccessType[]; canPersist?: boolean };
export type Breakpoint = { id?: number; verified: boolean; message?: string; line?: number; source?: Source };
export type Thread = { id: number; name: string };
export type StackFrame = { id: number; name: string; source?: Source; line: number; column: number; presentationHint?: string; canRestart?: boolean };
export type Scope = { name: string; variablesReference: number; expensive: boolean };
export type Variable = { name: string; value: string; type?: string; variablesReference: number; evaluateName?: string; presentationHint?: { kind?: string; attributes?: string[]; visibility?: string; lazy?: boolean } };
export type CompletionItem = { label: string; text?: string; sortText?: string; type?: string; start?: number; length?: number };
export type GotoTarget = { id: number; label: string; line: number; column?: number };

export type StoppedEvent = { reason: string; description?: string; threadId?: number; allThreadsStopped?: boolean; text?: string; hitBreakpointIds?: number[] };
export type OutputEvent = { category?: string; output: string };

export type RunInTerminalArguments = { kind?: 'integrated' | 'external'; title?: string; cwd: string; args: string[]; env?: Record<string, string | null> };
/** The `startDebugging` reverse request (js-debug's child sessions). */
export type StartDebuggingArguments = { request: 'launch' | 'attach'; configuration: Record<string, unknown> };
