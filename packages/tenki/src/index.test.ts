import { describe, expect, it } from "bun:test";
import type { CreateRequest } from "@sandbox-benchmarks/driver";
import { isDriverError, isRetryableDriverCreate, sandboxRef } from "@sandbox-benchmarks/driver";
import { driverFromComputeSpec } from "@sandbox-benchmarks/driver/computesdk";
import { TARGET_SPEC } from "@sandbox-benchmarks/schema/target-spec";
import type { CreateOptions, ExecResult, SessionState } from "@tenkicloud/sandbox";
import { RateLimitedError, SessionNotFoundError, UnauthorizedError } from "@tenkicloud/sandbox";
import type { TenkiClient, TenkiSessionHandle, TenkiSpecOptions } from "./index.ts";
import tenkiDriver, {
	TENKI_CREATE_BUDGET,
	TENKI_EXECUTION,
	TENKI_PROVENANCE,
	TENKI_READINESS,
	TENKI_RECOVERY_NAME_PREFIX,
	TENKI_SANDBOX_ID,
	TENKI_SESSION_LIFETIME_MS,
	tenkiObservation,
	tenkiSpec,
} from "./index.ts";

const context = {
	env: { TENKI_API_KEY: "tk_test-key" },
	artifact: { kind: "none" as const },
	resolvedArtifact: { kind: "none" as const },
};

const request: CreateRequest = {
	spec: TARGET_SPEC,
	artifact: { kind: "none" },
	deadlineMs: 300_000,
};

const SESSION_ID = "01a08baf-3d3c-7a59-bf98-417556e037c5";
const encoder = new TextEncoder();

function execResult(exitCode = 0, stdout = ""): ExecResult {
	return {
		sessionId: SESSION_ID,
		command: "bash",
		args: [],
		status: exitCode === 0 ? "SUCCEEDED" : "FAILED",
		exitCode,
		durationMs: 1,
		outputs: [],
		stdout: encoder.encode(stdout),
		stderr: new Uint8Array(),
	};
}

interface FakeAccount {
	readonly client: TenkiClient;
	readonly created: CreateOptions[];
	readonly commands: string[][];
	readonly closed: string[];
	readonly extended: number[];
	readonly sessions: Map<string, FakeSession>;
}

interface FakeSession extends TenkiSessionHandle {
	state: SessionState;
	timeoutAt: Date;
}

function fakeAccount(
	seams: {
		readonly create?: (options: CreateOptions) => Promise<void>;
		/** Allocate, then hold the response back for this long. */
		readonly stallMs?: number;
		readonly exec?: (argv: readonly string[]) => ExecResult;
		readonly afterClose?: SessionState;
		readonly reported?: Partial<Pick<FakeSession, "cpuCores" | "memoryMb" | "diskSizeGb">>;
		/** The server's create-time lifetime cap; extend() lifts it unless `extendCapped`. */
		readonly capMs?: number;
		readonly extendCapped?: boolean;
		readonly seed?: ReadonlyArray<{ id: string; name: string; state: SessionState }>;
	} = {},
): FakeAccount {
	const created: CreateOptions[] = [];
	const commands: string[][] = [];
	const closed: string[] = [];
	const extended: number[] = [];
	const sessions = new Map<string, FakeSession>();
	const session = (id: string, name: string, state: SessionState): FakeSession => {
		const handle: FakeSession = {
			id,
			name,
			state,
			cpuCores: 4,
			memoryMb: 8192,
			diskSizeGb: 40,
			timeoutAt: new Date(Date.now() + (seams.capMs ?? TENKI_SESSION_LIFETIME_MS + 60_000)),
			...seams.reported,
			exec: async (command) => {
				const argv = Array.isArray(command) ? [...command] : [command];
				commands.push(argv);
				return seams.exec?.(argv) ?? execResult();
			},
			close: async () => {
				closed.push(id);
				handle.state = seams.afterClose ?? "TERMINATED";
			},
			waitReady: async () => {
				handle.state = "RUNNING";
			},
			extend: async (additionalMs) => {
				extended.push(additionalMs);
				if (!seams.extendCapped) {
					handle.timeoutAt = new Date(handle.timeoutAt.getTime() + additionalMs);
				}
			},
		};
		sessions.set(id, handle);
		return handle;
	};
	for (const row of seams.seed ?? []) session(row.id, row.name, row.state);
	const client: TenkiClient = {
		create: async (options) => {
			created.push(options);
			await seams.create?.(options);
			const allocated = session(SESSION_ID, options.name ?? "", "CREATING");
			if (seams.stallMs !== undefined) await Bun.sleep(seams.stallMs);
			return allocated;
		},
		get: async (id) => {
			const found = sessions.get(id);
			if (found === undefined) throw new SessionNotFoundError(`session ${id} not found`);
			return found;
		},
		list: async () => [...sessions.values()].filter((row) => row.state !== "TERMINATED"),
	};
	return { client, created, commands, closed, extended, sessions };
}

function driver(client: TenkiClient, seams: TenkiSpecOptions = {}) {
	return driverFromComputeSpec(
		"tenki",
		tenkiSpec(context, {
			client,
			cleanupRetryMs: 0,
			terminatePollMs: 0,
			recoveryAbsenceConfirmationMs: 1,
			...seams,
		}),
		context.resolvedArtifact,
		[context.env.TENKI_API_KEY],
	);
}

describe("tenki module policy", () => {
	it("declares provenance, readiness, shell detach, and the create budget", () => {
		expect(tenkiDriver.id).toBe("tenki");
		expect(tenkiDriver.provenance).toEqual(TENKI_PROVENANCE);
		expect(tenkiDriver.readiness).toEqual(TENKI_READINESS);
		expect(tenkiDriver.execution).toEqual(TENKI_EXECUTION);
		expect(tenkiDriver.createBudget).toEqual(TENKI_CREATE_BUDGET);
		expect(TENKI_SANDBOX_ID.allows(SESSION_ID)).toBe(true);
		expect(TENKI_SANDBOX_ID.allows("bx_23456789")).toBe(false);
	});

	it("maps observations: TERMINATED is absent, paused and shutdown are terminal", () => {
		expect(tenkiObservation("RUNNING")).toEqual({ state: "running" });
		expect(tenkiObservation("CREATING")).toEqual({ state: "running" });
		expect(tenkiObservation("PAUSED")).toEqual({ state: "terminal" });
		expect(tenkiObservation("USER_SHUTDOWN")).toEqual({ state: "terminal" });
		expect(tenkiObservation("TERMINATING")).toEqual({ state: "terminal" });
		expect(tenkiObservation("TERMINATED")).toEqual({ state: "absent" });
	});
});

describe("tenki create", () => {
	it("requests the exact target size with a recovery name and waits for RUNNING", async () => {
		const account = fakeAccount();
		const session = await driver(account.client).create(request);
		expect(session.sandboxRef).toEqual(sandboxRef("tenki", SESSION_ID));
		expect(account.created).toHaveLength(1);
		const [options] = account.created;
		expect(options).toMatchObject({
			cpuCores: 4,
			memoryMb: 8192,
			diskSizeGb: 40,
			maxDurationMs: TENKI_SESSION_LIFETIME_MS,
			sticky: false,
			waitReady: false,
		});
		expect(options?.name).toMatch(new RegExp(`^${TENKI_RECOVERY_NAME_PREFIX}-[0-9a-f-]{36}$`));
		expect(account.sessions.get(SESSION_ID)?.state).toBe("RUNNING");
		expect(account.commands).toEqual([]);
	});

	it("extends a lifetime the create capped, without touching an uncapped one", async () => {
		const capped = fakeAccount({ capMs: 2 * 60 * 60_000 });
		await driver(capped.client).create(request);
		expect(capped.extended).toHaveLength(1);
		expect(capped.extended[0]).toBeGreaterThan(59 * 60_000);
		expect(capped.extended[0]).toBeLessThanOrEqual(60 * 60_000 + 1_000);

		const uncapped = fakeAccount();
		await driver(uncapped.client).create(request);
		expect(uncapped.extended).toEqual([]);
	});

	it("terminates a session whose lifetime cannot be extended", async () => {
		const account = fakeAccount({ capMs: 2 * 60 * 60_000, extendCapped: true });
		await expect(driver(account.client).create(request)).rejects.toThrow();
		expect(account.closed).toEqual([SESSION_ID]);
	});

	it("runs every command through bash -c and decodes its output", async () => {
		const account = fakeAccount({
			exec: (argv) => execResult(argv[2] === "exit 3" ? 3 : 0, `ran ${argv[2]}`),
		});
		const session = await driver(account.client).create(request);
		const ok = await session.exec("echo hi | tr a-z A-Z");
		expect(account.commands.at(-1)).toEqual(["bash", "-c", "echo hi | tr a-z A-Z"]);
		expect(ok.exit).toEqual({ kind: "exited", code: 0 });
		expect(ok.stdout).toBe("ran echo hi | tr a-z A-Z");
		expect((await session.exec("exit 3")).exit).toEqual({ kind: "exited", code: 3 });
	});

	it("refuses an artifact ref before calling the control plane", async () => {
		const account = fakeAccount();
		await expect(
			driver(account.client).create({
				...request,
				artifact: { kind: "image", ref: "registry.example/toolchain:1" },
			} as CreateRequest),
		).rejects.toThrow();
		expect(account.created).toHaveLength(0);
	});

	it("terminates a session that reports less than the request", async () => {
		const account = fakeAccount({ reported: { memoryMb: 4096 } });
		await expect(driver(account.client).create(request)).rejects.toThrow();
		expect(account.closed).toEqual([SESSION_ID]);
	});

	it("surfaces a rate-limit refusal as a retryable create failure with nothing to reconcile", async () => {
		const account = fakeAccount({
			create: async () => {
				throw new RateLimitedError("rate limit exceeded");
			},
		});
		const error = await driver(account.client)
			.create(request)
			.catch((caught: unknown) => caught);
		expect(isDriverError(error) && error.code).toBe("create-failed");
		expect(isRetryableDriverCreate(error)).toBe(true);
		expect(account.closed).toEqual([]);
	});

	it("reconciles a create whose response never arrives by terminating the named session", async () => {
		const account = fakeAccount({ stallMs: 1_000 });
		await expect(driver(account.client, { controlTimeoutMs: 5 }).create(request)).rejects.toThrow();
		expect(account.closed).toEqual([SESSION_ID]);
		expect(account.sessions.get(SESSION_ID)?.state).toBe("TERMINATED");
	});
});

describe("tenki teardown", () => {
	it("terminates and confirms TERMINATED; a repeat destroy is a no-op", async () => {
		const account = fakeAccount();
		const tenki = driver(account.client);
		const session = await tenki.create(request);
		await session.destroy();
		expect(account.closed).toEqual([SESSION_ID]);
		expect(await tenki.probes?.observe(session.sandboxRef)).toEqual({ state: "absent" });
		await tenki.destroyById?.(session.sandboxRef);
		expect(account.closed).toEqual([SESSION_ID]);
	});

	it("treats an unknown id as already gone", async () => {
		const account = fakeAccount();
		await driver(account.client).destroyById?.(sandboxRef("tenki", SESSION_ID));
		expect(account.closed).toEqual([]);
	});

	it("fails when the session never reaches TERMINATED", async () => {
		const account = fakeAccount({ afterClose: "TERMINATING" });
		const tenki = driver(account.client, { terminateConfirmMs: 20 });
		const session = await tenki.create(request);
		const error = await tenki.destroyById?.(session.sandboxRef).catch((caught: unknown) => caught);
		expect(isDriverError(error) && error.code).toBe("destroy-failed");
	});

	it("does not retry an authentication refusal", async () => {
		const account = fakeAccount({
			seed: [{ id: SESSION_ID, name: "sandbox-benchmarks-x", state: "RUNNING" }],
		});
		let gets = 0;
		const failing: TenkiClient = {
			...account.client,
			get: async () => {
				gets += 1;
				throw new UnauthorizedError("sandbox: unauthorized");
			},
		};
		const error = await driver(failing)
			.destroyById?.(sandboxRef("tenki", SESSION_ID))
			.catch((caught: unknown) => caught);
		expect(isDriverError(error) && error.code).toBe("destroy-failed");
		expect(gets).toBe(1);
		expect(account.closed).toEqual([]);
	});
});

describe("tenki inventory", () => {
	it("owns prefixed rows and counts only live foreign rows", async () => {
		const owned = "01a08849-e8c5-7605-ad22-ec29e3b99680";
		const account = fakeAccount({
			seed: [
				{ id: owned, name: `${TENKI_RECOVERY_NAME_PREFIX}-leftover`, state: "PAUSED" },
				{ id: "01a08849-e8c5-7605-ad22-ec29e3b99681", name: "docs-preview", state: "RUNNING" },
				{ id: "01a08849-e8c5-7605-ad22-ec29e3b99682", name: "parked", state: "PAUSED" },
				{ id: "01a08849-e8c5-7605-ad22-ec29e3b99683", name: "gone", state: "TERMINATED" },
			],
		});
		expect(await driver(account.client).inventory?.list()).toEqual({
			owned: [sandboxRef("tenki", owned)],
			foreignCount: 1,
		});
	});
});
