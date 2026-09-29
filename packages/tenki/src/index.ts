// tenki is a native SDK module over @tenkicloud/sandbox. Session fields are parsed once through the
// schema below; shared driver-kit utilities own polling, request validation, and session mechanics.
//
// Four SDK facts shape this module:
// - `exec(string)` sends the string as argv[0] with no shell, so every command runs as `bash -c`.
// - Control-plane calls take no AbortSignal and the client sets no deadline, so each is bounded here.
// - A process lives only as long as its Run stream, so the durable route is the kit's double-forked
//   shell detach (which Tenki documents for background work), never a held-open native stream.
// - TerminateSession only marks the session TERMINATING; teardown is proven by observing TERMINATED
//   (or not-found), never by the terminate call returning.

import { randomUUID } from "node:crypto";
import type { CreateRequest, DriverContext, SandboxObservation } from "@sandbox-benchmarks/driver";
import { DriverError, isDriverError, pollUntilReady } from "@sandbox-benchmarks/driver";
import type {
	ComputeSdkCreatedRequestVerification,
	ComputeSdkCreateRequestCoverage,
} from "@sandbox-benchmarks/driver/computesdk";
import { computeSdkSpec, defineComputeSdkDriver } from "@sandbox-benchmarks/driver/computesdk";
import { matchesAnyCause } from "@sandbox-benchmarks/driver/errors";
import { nativeSdkCompute } from "@sandbox-benchmarks/driver/native";
import type { CreateOptions, ListOptions, Session } from "@tenkicloud/sandbox";
import {
	CapacityUnavailableError,
	InvalidAuthTokenError,
	InvalidResourceConfigError,
	MissingAuthTokenError,
	PermissionDeniedError,
	QuotaExceededError,
	RateLimitedError,
	SandboxError,
	SessionNotFoundError,
	TenkiSandbox,
	UnauthorizedError,
} from "@tenkicloud/sandbox";
import { type } from "arktype";
import { TENKI_PROVENANCE } from "./provenance.ts";

export { TENKI_PROVENANCE };

export const TENKI_API_BASE = "https://api.tenki.cloud";
export const TENKI_SANDBOX_ID = type(
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
);
export const TENKI_RECOVERY_NAME_PREFIX = "sandbox-benchmarks";
/**
 * Above the longest suite: a non-sticky session is auto-paused at its max duration. Create caps the
 * request at the workspace limit (MAX_DURATION_CAPPED, 2h measured), but extend() lifts it, so the
 * post-create hook extends any shortfall.
 */
export const TENKI_SESSION_LIFETIME_MS = 3 * 60 * 60_000;
export const TENKI_CONTROL_TIMEOUT_MS = 30_000;
export const TENKI_READY_TIMEOUT_MS = 5 * 60_000;
export const TENKI_CLEANUP_ATTEMPTS = 5;
export const TENKI_CLEANUP_RETRY_MS = 2_000;
/** Inside the harness's 60 s destroy timeout. */
export const TENKI_TERMINATE_CONFIRM_MS = 40_000;
export const TENKI_TERMINATE_POLL_MS = 1_000;
export const TENKI_INVENTORY_TIMEOUT_MS = 5 * 60_000;
export const TENKI_READINESS = { startup: "create-returns-ready" } as const;
export const TENKI_EXECUTION = { syncCapMs: 60_000, durable: "shell-detach" } as const;
export const TENKI_CREATE_CEILING_MS =
	TENKI_CONTROL_TIMEOUT_MS + // create
	TENKI_READY_TIMEOUT_MS +
	TENKI_CLEANUP_ATTEMPTS * TENKI_CONTROL_TIMEOUT_MS +
	(TENKI_CLEANUP_ATTEMPTS - 1) * TENKI_CLEANUP_RETRY_MS +
	TENKI_TERMINATE_CONFIRM_MS;
export const TENKI_CREATE_BUDGET = {
	owner: "harness",
	timeoutMs: TENKI_CREATE_CEILING_MS,
} as const;

export const TENKI_REQUEST_COVERAGE = {
	spec: { vcpus: "mapped", memoryGb: "mapped", diskGb: "mapped" },
	artifact: "context",
	deadlineMs: "harness",
	gpu: { model: "unsupported", count: "unsupported" },
	env: "unsupported",
} as const satisfies ComputeSdkCreateRequestCoverage;

// Paused sessions hold a snapshot but no compute, so a foreign one is not capacity this benchmark
// competes with; an owned one is still a leftover to terminate.
const PAUSED_STATES: ReadonlySet<string> = new Set(["PAUSED"]);
const TERMINAL_STATES: ReadonlySet<string> = new Set([
	"PAUSING",
	"PAUSED",
	"USER_SHUTDOWN",
	"TERMINATING",
]);

const tenkiSessionSchema = type({
	id: TENKI_SANDBOX_ID,
	name: "string",
	state: "string >= 1",
	cpuCores: "number >= 0",
	memoryMb: "number >= 0",
	diskSizeGb: "number >= 0",
});
const tenkiCreateOptionsSchema = type({
	name: "string >= 1",
	cpuCores: "number.integer > 0",
	memoryMb: "number.integer > 0",
	"diskSizeGb?": "number.integer > 0",
	maxDurationMs: "number.integer > 0",
	sticky: "false",
	waitReady: "false",
});

export type TenkiSession = typeof tenkiSessionSchema.infer;
export type TenkiCreateOptions = typeof tenkiCreateOptionsSchema.infer & CreateOptions;
export type TenkiSessionHandle = Pick<
	Session,
	| "id"
	| "name"
	| "state"
	| "cpuCores"
	| "memoryMb"
	| "diskSizeGb"
	| "timeoutAt"
	| "exec"
	| "close"
	| "waitReady"
	| "extend"
>;
export interface TenkiClient {
	create(options: CreateOptions): Promise<TenkiSessionHandle>;
	get(sessionId: string): Promise<TenkiSessionHandle>;
	list(options?: ListOptions): Promise<readonly TenkiSessionHandle[]>;
}

export interface TenkiSpecOptions {
	readonly client?: TenkiClient;
	readonly controlTimeoutMs?: number;
	readonly readyTimeoutMs?: number;
	readonly cleanupAttempts?: number;
	readonly cleanupRetryMs?: number;
	readonly terminateConfirmMs?: number;
	readonly terminatePollMs?: number;
	readonly recoveryAbsenceConfirmationMs?: number;
	readonly inventoryTimeoutMs?: number;
}

export class TenkiCallTimeoutError extends Error {
	constructor(
		readonly operation: string,
		readonly timeoutMs: number,
	) {
		super(`tenki ${operation} did not settle within ${timeoutMs}ms`);
		this.name = "TenkiCallTimeoutError";
	}
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return Math.max(1, Math.floor(value ?? fallback));
}

function nonnegativeNumber(value: number | undefined, fallback: number): number {
	return Math.max(0, value ?? fallback);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true },
		);
	});
}

async function bounded<T>(
	operation: string,
	call: () => Promise<T>,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<T> {
	signal?.throwIfAborted();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let unsubscribe = () => {};
	try {
		return await Promise.race([
			Promise.resolve().then(call),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new TenkiCallTimeoutError(operation, timeoutMs)),
					timeoutMs,
				);
				if (signal !== undefined) {
					const abort = () => reject(signal.reason ?? new Error("tenki operation aborted"));
					signal.addEventListener("abort", abort, { once: true });
					unsubscribe = () => signal.removeEventListener("abort", abort);
				}
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		unsubscribe();
	}
}

export function tenkiSession(handle: TenkiSessionHandle): TenkiSession {
	return tenkiSessionSchema.assert({
		id: handle.id,
		name: handle.name,
		state: handle.state,
		cpuCores: handle.cpuCores,
		memoryMb: handle.memoryMb,
		diskSizeGb: handle.diskSizeGb,
	});
}

export function isTenkiNotFound(error: unknown): boolean {
	return matchesAnyCause(error, (cause) => cause instanceof SessionNotFoundError);
}

/** Refusals the control plane returns before it allocates anything. */
export function isTenkiDefinitiveCreateRejection(error: unknown): boolean {
	return matchesAnyCause(
		error,
		(cause) =>
			cause instanceof UnauthorizedError ||
			cause instanceof PermissionDeniedError ||
			cause instanceof MissingAuthTokenError ||
			cause instanceof InvalidAuthTokenError ||
			cause instanceof InvalidResourceConfigError ||
			cause instanceof QuotaExceededError ||
			cause instanceof CapacityUnavailableError ||
			cause instanceof RateLimitedError,
	);
}

export function isTenkiRetryableCreate(error: unknown): boolean {
	return matchesAnyCause(
		error,
		(cause) => cause instanceof RateLimitedError || cause instanceof CapacityUnavailableError,
	);
}

function isTenkiAuthFailure(error: unknown): boolean {
	return matchesAnyCause(
		error,
		(cause) => cause instanceof UnauthorizedError || cause instanceof PermissionDeniedError,
	);
}

/** TERMINATED is absent: compute is released and the default listing no longer returns it. */
export function tenkiObservation(state: string): SandboxObservation {
	if (state === "TERMINATED") return { state: "absent" };
	if (TERMINAL_STATES.has(state)) return { state: "terminal" };
	return { state: "running" };
}

export function tenkiSpec({ env }: DriverContext<"tenki">, options: TenkiSpecOptions = {}) {
	const controlTimeoutMs = positiveInteger(options.controlTimeoutMs, TENKI_CONTROL_TIMEOUT_MS);
	// Session handles carry the data-plane route and credential; re-fetching one per exec would add
	// a control-plane round trip to every command.
	const handles = new Map<string, TenkiSessionHandle>();
	let cached: TenkiClient | undefined;
	const sdk = (): TenkiClient =>
		(cached ??=
			options.client ??
			new TenkiSandbox({
				apiKey: env.TENKI_API_KEY,
				baseUrl: TENKI_API_BASE,
				warningHandler: (warning) => {
					// Expected on every create; prepareAndVerify extends the lifetime past the cap.
					if (warning.code === "MAX_DURATION_CAPPED") return;
					console.warn(`tenki sandbox warning [${warning.code}]: ${warning.message}`);
				},
			}));

	const getSession = async (sessionId: string, signal?: AbortSignal) => {
		const handle = await bounded(
			`get session ${sessionId}`,
			() => sdk().get(sessionId),
			controlTimeoutMs,
			signal,
		);
		return { handle, session: tenkiSession(handle) };
	};

	const handleFor = async (sessionId: string, signal?: AbortSignal) => {
		const known = handles.get(sessionId);
		if (known !== undefined) return known;
		const { handle } = await getSession(sessionId, signal);
		handles.set(sessionId, handle);
		return handle;
	};

	const execCommand = async (sessionId: string, command: string, signal?: AbortSignal) => {
		signal?.throwIfAborted();
		const handle = await handleFor(sessionId, signal);
		const result = await handle.exec(
			["bash", "-c", command],
			signal === undefined ? {} : { signal },
		);
		const decoder = new TextDecoder();
		return {
			exitCode: result.exitCode,
			stdout: decoder.decode(result.stdout),
			stderr: decoder.decode(result.stderr),
		};
	};

	const listSessions = async (signal?: AbortSignal) => {
		const timeoutMs = positiveInteger(options.inventoryTimeoutMs, TENKI_INVENTORY_TIMEOUT_MS);
		const rows = await bounded("list sessions", () => sdk().list(), timeoutMs, signal);
		const sessions = rows.map(tenkiSession);
		if (new Set(sessions.map((row) => row.id)).size !== sessions.length) {
			throw new Error("tenki inventory returned a duplicate session id");
		}
		return sessions;
	};

	/**
	 * Terminate, then prove it: TerminateSession returns once the session is TERMINATING and the
	 * teardown workflow runs asynchronously. Idempotent: an unknown or TERMINATED id is already gone.
	 */
	const terminate = async (sessionId: string, signal?: AbortSignal): Promise<void> => {
		const attempts = positiveInteger(options.cleanupAttempts, TENKI_CLEANUP_ATTEMPTS);
		for (let attempt = 1; ; attempt++) {
			try {
				const { handle, session } = await getSession(sessionId, signal);
				if (session.state === "TERMINATED") break;
				await bounded(
					`terminate session ${sessionId}`,
					() => handle.close(),
					controlTimeoutMs,
					signal,
				);
				break;
			} catch (error) {
				if (isTenkiNotFound(error)) break;
				if (signal?.aborted || isTenkiAuthFailure(error) || attempt >= attempts) throw error;
				await delay(nonnegativeNumber(options.cleanupRetryMs, TENKI_CLEANUP_RETRY_MS), signal);
			}
		}
		handles.delete(sessionId);
		const deadlineMs = positiveInteger(options.terminateConfirmMs, TENKI_TERMINATE_CONFIRM_MS);
		await pollUntilReady({
			provider: "tenki",
			deadlineMs,
			intervalMs: nonnegativeNumber(options.terminatePollMs, TENKI_TERMINATE_POLL_MS),
			signal,
			poll: async () => {
				try {
					return (await getSession(sessionId, signal)).session.state === "TERMINATED" ? true : null;
				} catch (error) {
					if (isTenkiNotFound(error)) return true;
					throw error;
				}
			},
		}).catch((error: unknown) => {
			if (isDriverError(error) && error.code === "readiness-timeout") {
				throw new Error(
					`tenki session ${sessionId} not TERMINATED ${deadlineMs}ms after terminate`,
					{
						cause: error,
					},
				);
			}
			throw error;
		});
	};

	const prepareAndVerify = async (
		native: TenkiSession,
		request: CreateRequest,
		signal?: AbortSignal,
	): Promise<ComputeSdkCreatedRequestVerification> => {
		const handle = await handleFor(native.id, signal);
		await handle.waitReady(positiveInteger(options.readyTimeoutMs, TENKI_READY_TIMEOUT_MS), signal);
		const lifetimeEnd = Date.now() + TENKI_SESSION_LIFETIME_MS;
		const shortfallMs = lifetimeEnd - handle.timeoutAt.getTime();
		if (shortfallMs > 0) {
			await bounded(
				`extend session ${native.id}`,
				() => handle.extend(shortfallMs),
				controlTimeoutMs,
				signal,
			);
			if (handle.timeoutAt.getTime() < lifetimeEnd) {
				return {
					status: "unsupported",
					detail: `tenki session ${native.id} expires at ${handle.timeoutAt.toISOString()}, before the ${TENKI_SESSION_LIFETIME_MS / 3_600_000}h lifetime`,
				};
			}
		}
		const ready = tenkiSession(handle);
		if (ready.cpuCores < request.spec.vcpus) {
			return {
				status: "unsupported",
				detail: `requested ${request.spec.vcpus} vCPU but the session reports ${ready.cpuCores}`,
			};
		}
		if (ready.memoryMb < request.spec.memoryGb * 1024) {
			return {
				status: "unsupported",
				detail: `requested ${request.spec.memoryGb} GiB but the session reports ${ready.memoryMb} MiB`,
			};
		}
		if (request.spec.diskGb !== undefined && ready.diskSizeGb < request.spec.diskGb) {
			return {
				status: "unsupported",
				detail: `requested ${request.spec.diskGb} GiB disk but the session reports ${ready.diskSizeGb} GiB`,
			};
		}
		return { status: "honored" };
	};

	const compute = nativeSdkCompute(
		async (createOptions: TenkiCreateOptions, operation): Promise<TenkiSession> => {
			try {
				const handle = await bounded(
					"create session",
					() => sdk().create(createOptions),
					controlTimeoutMs,
					operation.signal,
				);
				const session = tenkiSession(handle);
				handles.set(session.id, handle);
				return session;
			} catch (error) {
				if (!(error instanceof SandboxError)) throw error;
				throw new DriverError("create-failed", `tenki create ${error.name}: ${error.message}`, {
					provider: "tenki",
					cause: error,
				});
			}
		},
		(native) => ({
			sandboxId: native.id,
			runCommand: (command, commandOptions) =>
				execCommand(native.id, command, commandOptions?.signal),
			destroy: () => terminate(native.id),
		}),
	);

	return computeSdkSpec(compute, {
		sandboxId: TENKI_SANDBOX_ID,
		createOptions: {
			coverage: TENKI_REQUEST_COVERAGE,
			map: (request, unsupported) => {
				if (request.artifact.kind !== "none") {
					unsupported(
						"tenki boots the vendor's stock sandbox image and cannot take an artifact ref",
					);
				}
				return tenkiCreateOptionsSchema.assert({
					name: `${TENKI_RECOVERY_NAME_PREFIX}-${randomUUID()}`,
					cpuCores: request.spec.vcpus,
					memoryMb: request.spec.memoryGb * 1024,
					...(request.spec.diskGb === undefined ? {} : { diskSizeGb: request.spec.diskGb }),
					maxDurationMs: TENKI_SESSION_LIFETIME_MS,
					sticky: false,
					waitReady: false,
				});
			},
		},
		lifecycle: {
			destroy: (sandbox, ref, operation) =>
				terminate(ref?.id ?? sandbox.getInstance().id, operation.signal),
		},
		createRecovery: {
			absenceConfirmationMs: options.recoveryAbsenceConfirmationMs ?? 2_000,
			maxAttempts: 4,
			// The name is part of the create request, so a lost response still leaves a findable row.
			locator: (createOptions) => ({ kind: "name", value: createOptions.name }),
			isDefinitive: isTenkiDefinitiveCreateRejection,
			isRetryableCreate: isTenkiRetryableCreate,
			cleanup: async (_compute, locator, operation) => {
				const matches = (await listSessions(operation.signal)).filter(
					(row) => row.name === locator.value,
				);
				if (matches.length === 0) return { status: "absent" };
				for (const match of matches) await terminate(match.id, operation.signal);
				return { status: "destroyed" };
			},
		},
		prepareAndVerifyCreatedRequest: (_sandbox, native, request, operation) =>
			prepareAndVerify(native, request, operation.signal),
		hasWorkingFilesystem: false,
		probes: {
			observe: async (_compute, ref) => {
				try {
					return tenkiObservation((await getSession(ref.id)).session.state);
				} catch (error) {
					if (isTenkiNotFound(error)) return { state: "absent" };
					throw error;
				}
			},
			describe: async (_compute, ref) => (await getSession(ref.id)).session,
			list: () => listSessions(),
		},
		inventory: {
			// Terminated sessions are excluded from the listing, so every owned row is a leftover.
			list: async (_compute, operation) => {
				const owned: string[] = [];
				let foreignCount = 0;
				for (const row of await listSessions(operation.signal)) {
					if (row.name.startsWith(`${TENKI_RECOVERY_NAME_PREFIX}-`)) owned.push(row.id);
					else if (!PAUSED_STATES.has(row.state)) foreignCount += 1;
				}
				return { owned, foreignCount };
			},
		},
		destroyById: (_compute, ref, operation) => terminate(ref.id, operation.signal),
	});
}

export default defineComputeSdkDriver("tenki", {
	provenance: TENKI_PROVENANCE,
	readiness: TENKI_READINESS,
	execution: TENKI_EXECUTION,
	createBudget: TENKI_CREATE_BUDGET,
	spec: tenkiSpec,
});
