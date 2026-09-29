# @sandbox-benchmarks/tenki

Owns the Tenki (https://tenki.cloud) driver implementation, SDK dependencies, and behavioral tests.
The fleet loader selects this package lazily; shared session mechanics live in
`@sandbox-benchmarks/driver`. SDK versions are pinned in the root catalog.

Tenki quirks the driver is built around:

- `Session.exec(string)` sends the string as `argv[0]` with no shell, so every command runs as
  `bash -c <command>`.
- Control-plane calls (`create`, `get`, `list`, `close`) take no `AbortSignal` and the client
  applies no deadline, so each is bounded by the driver.
- A process lives only as long as its Run stream. The durable route is the kit's double-forked
  shell detach, which is the background pattern Tenki documents.
- Create is issued with `waitReady: false` and the recovery name `sandbox-benchmarks-<uuid>`, so a
  lost response still leaves a session findable by name. The wait for `RUNNING` runs in the
  post-create hook, where any failure is torn down by the returned id.
- `close()` (TerminateSession) only marks the session `TERMINATING`, and the teardown runs
  asynchronously. The driver proves teardown by observing `TERMINATED` or not-found.
- A non-sticky session is auto-paused, not terminated, at its max duration. Create caps the
  requested 3 hours at the workspace limit (`MAX_DURATION_CAPPED`, 2 hours measured), but `extend()`
  lifts it, so the post-create hook extends any shortfall and fails the create if it cannot.
- Inventory owns every non-terminated row with the recovery prefix and ignores paused foreign rows
  (they hold no compute). A live foreign session blocks admission, so use a Tenki workspace
  dedicated to the benchmark.

Run `bun run --filter @sandbox-benchmarks/tenki test` or `typecheck` from the repo root.
