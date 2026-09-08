# OpenCLI browser lifecycle parity

This document records the browser/session lifecycle contract used by this AutoCLI fork after PR #7 (`cfe7b57dc9448d056861d5d2a3d9f0d4fd453e51`). It is intentionally a parity note, not a separate design proposal.

## Reference rule

AutoCLI is a Rust rewrite of OpenCLI. For browser lifecycle, debugger recovery, and adapter session behavior, current OpenCLI is the behavioral reference. The implementation audited for this port was `jackwener/OpenCLI @ 8271afc67e8504bda94c147f446ee29775d08274`.

When behavior differs:

1. Check the current OpenCLI implementation first.
2. Port the applicable behavior into Rust/this extension.
3. Do not add a fork-specific lifecycle mechanism for a problem OpenCLI does not solve; wait for upstream behavior instead.

The older `nashsu/AutoCLI` upstream did not contain the newer OpenCLI lifecycle changes used here, so this fork ports them directly from OpenCLI rather than inventing replacements.

## Session and surface contract

Adapter commands and generic browser commands are different surfaces.

- Adapter surface: `surface = adapter`.
- Browser surface: `surface = browser`.
- Persistent adapter session: `site:<site>`.
- Ephemeral adapter session: `site:<site>:<unique-id>`.
- Adapter commands default to ephemeral unless the adapter explicitly requests persistence.
- Browser automation remains a distinct, longer-lived surface.

The extension keys leases by surface + encoded session so browser and adapter commands cannot accidentally alias the same lease.

## Adapter lease lifecycle

The OpenCLI-parity adapter path is explicit rather than timeout-only:

1. Allocate or reuse the adapter lease for the command session.
2. Run the adapter command.
3. On ephemeral command completion, release the lease explicitly.
4. Detach debugger state safely.
5. If another lease still owns the window, remove the released tab; otherwise navigate the preferred tab to `about:blank` and keep it as a reusable placeholder.

Persistent adapter sessions remain available for adapters that genuinely need long-lived state. REDnote read adapters (`feed`, `search`, `note`, `comments`) use ephemeral sessions in the current built-in set.

## Persisted registry and MV3 recovery

Lease state is not allowed to exist only in service-worker memory.

- Every lease is persisted in `chrome.storage.session`.
- The extension performs top-level initialization on every MV3 worker load, not only `onInstalled` / `onStartup`.
- Startup reconciliation validates recorded tab/window ids, restores live leases, restores idle deadlines, releases expired leases, and persists the reconciled registry.
- `chrome.alarms` carries persisted idle deadlines; `setTimeout` is only a fast path while the worker is alive.
- Tab/window removal listeners remove stale registry entries.

This is required because an MV3 service worker can be evicted and later wake on an unrelated event. A missing in-memory map must not cause `close-window` to pretend success while leaving a debugger target attached.

## Debugger errors and retry boundary

The extension/daemon path uses machine-readable debugger error classes compatible with current OpenCLI behavior:

- `attach_failed`
- `tab_gone`
- `target_navigated`
- `detached_mid_command`
- `cdp_timeout`

Retry policy distinguishes failures that are known to happen before page-side execution from failures whose side effects are ambiguous.

- `attach_failed` and `tab_gone`: one semantic retry with a fresh command id after the short delay used by OpenCLI.
- `target_navigated`: transient at the pipeline layer.
- `detached_mid_command` and `cdp_timeout`: do **not** blindly replay page JavaScript; execution may already have produced side effects.
- Transport retry and semantic retry are separate concerns.
- Attachment cache state is probed before reuse; stale attachments are invalidated.

Do not reintroduce an inner `evaluate` replay loop that can run the same page script twice.

## Local user-adapter shadowing

Runtime adapter discovery can invalidate a lifecycle test without any lifecycle bug.

Built-in adapters are registered first; user YAML adapters under `~/.autocli/adapters/**` are discovered afterward. A user adapter with the same `(site, command)` key can silently replace the built-in command. Generated adapters may also be persisted there.

Before diagnosing a mismatch with OpenCLI/built-in behavior:

1. Inspect `~/.autocli/adapters/<site>/` for matching YAML files.
2. Move stale files outside the entire `~/.autocli/adapters` tree (discovery is recursive), or otherwise make them undiscoverable.
3. Repeat the smoke test using the built-in adapter.

Do not change browser lifecycle code to compensate for behavior produced by a stale shadow adapter.

This mattered during the REDnote validation: local `feed` / `search` adapters still requested `siteSession: persistent`, which made the page remain open and contaminated the cross-lane debugger test. Once those shadows were disabled, built-in REDnote commands released to `about:blank` as expected and the previous cross-lane debugger poisoning did not reproduce.

## REDnote authentication is separate from lifecycle

The lifecycle contract does not attempt to synchronize or clone website authentication across Chrome profiles.

In downstream deployment, the same REDnote account was observed to invalidate the other profile's login when used from two Chrome profiles. Current OpenCLI does not provide cross-profile cookie/session synchronization for this case. The downstream MCP wrapper therefore routes all REDnote tools through one shared Chrome profile/daemon instead of adding a fork-specific AutoCLI auth mechanism.

That routing decision belongs outside AutoCLI core. AutoCLI should keep the OpenCLI adapter/session behavior unchanged.

## Emergency browser recovery

`chrome://restart` can clear an already-stuck shared Chrome debugger state. It is an operational recovery tool, not part of the normal lifecycle design and not a substitute for correct lease release/reconciliation.

After any Chrome restart, verify the extension is connected and run a real browser command. Health endpoints alone do not prove debugger readiness.

## Validation record

The parity port was validated with:

- targeted extension lifecycle/debugger tests (15/15 passing),
- extension build success,
- Windows CI build run `34238812930` (apart from the separately confirmed pre-existing download-test baseline),
- Windows dual-profile smoke using the built-in adapters after stale user shadows were disabled,
- cross-lane sequence where REDnote completed/released and the peer lane's Twitter command succeeded without `Debugger is not attached`.

If a future change regresses these paths, compare it against current OpenCLI before designing a new recovery mechanism.
