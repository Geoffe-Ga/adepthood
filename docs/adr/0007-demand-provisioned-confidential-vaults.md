# ADR 0007: Confidential vaults are provisioned on demand, not at signup

- **Status:** Accepted
- **Date:** 2026-09-06
- **Issues:** [#2575](https://github.com/Geoffe-Ga/adepthood/issues/2575),
  [creek-vault#1724](https://github.com/Geoffe-Ga/Creek-Vault/issues/1724)
- **Amends:** [ADR 0002](0002-intimate-content-local-routing.md) Decision 1
  and [ADR 0005](0005-operator-side-ontologization.md) Decision 4 by fixing
  the confidential vault's lifecycle and cost posture. It does not weaken
  their custody, routing, or privacy boundaries.
- **Upstream counterpart:** Creek Vault
  [Creek-Vault ADR-0013](https://github.com/Geoffe-Ga/Creek-Vault/blob/main/creek-tools/docs/architecture/ADR/0013-demand-provisioned-vault-lifecycle.md)

## Context

ADR 0002 ratified one isolated Creek Vault deployment per user: disposable
compute attached to a durable encrypted volume, with user-held keys released
only to attested confidential compute. ADR 0005 later ratified the launch floor
while that infrastructure is absent: operator-side ontologization for OPEN and
PERSONAL material, with INTIMATE material structurally excluded.

Issue #2575 incorrectly joined that privacy architecture to account creation.
It asked Adepthood to provision a vault during every signup even though the
North Star calls the journal a "wide, low door", key setup is deliberately
irrecoverable without the user's passphrase or one-time recovery key, and an
idle per-user allocation has a real recurring cost. Asynchrony protects signup
latency; it does not remove the storage bill or make an unsolicited key
ceremony consensual.

The architectural boundary and the lifecycle question are separate. A
per-user execution boundary remains the safest fit because Creek is
single-user by design and its `/v1` contract carries no tenant identifier.
That does not imply a permanently running VM, nor a VM for an account that has
never asked for the confidential capability.

## Decision 1 — Signup never waits for, performs, or requires vault provisioning

Account creation succeeds using the shipped operator-side OPEN/PERSONAL corpus
floor. A provisioning outage cannot delay or roll back signup, entitlement
grant, social identity linking, or the first journal save.

Adepthood offers the confidential vault as an optional, surfaced privacy
capability. Provisioning begins only after the authenticated user explicitly
activates it and completes its key ceremony. Activation may be invited when it
is useful, but it follows the North Star's invitation rules: it is
one-tap-declinable, non-nagging, and never presented as a prerequisite for
using the journal or course.

This means "Day 1 corpus" and "confidential vault" are intentionally different
products until the confidential path is ready. OPEN/PERSONAL content may use
the operator-side floor under ADR 0005 and its consent record. INTIMATE remains
skip-only until Decision 6's complete path ships.

## Decision 2 — Provisioning is an asynchronous Creek-owned control plane

Adepthood is a consumer of provisioning, not the cloud orchestrator. It sends
an authenticated, idempotent activation request to a small control-plane
service owned with Creek Vault. The service returns a durable job handle
immediately. Adepthood polls or receives a callback and records progress for the
user without holding an HTTP request or database transaction open.

The control plane owns provider credentials, image rollout, volume creation,
machine lifecycle, credential minting, and cleanup. Adepthood never receives a
cloud-provider credential. The completed job performs a one-time internal
handoff of the vault URL and per-consumer credential into `UserVaultConfig`,
whose existing encrypted-at-rest and never-return rules continue to apply.
Neither value may appear in a job payload visible to the frontend, a log line,
an exception, or analytics.

Retries with the same activation id are idempotent. Concurrent activations for
one account resolve to one allocation. Terminal failure is explicit and
retryable; it degrades to the operator-side floor and never costs the user's
writing.

## Decision 3 — One isolated, scale-to-zero execution environment per activated user

The first implementation uses one provider application and one Creek Machine
per activated account, because that preserves Creek's single-user invariant
without inventing tenancy inside the vault. The Machine has no dedicated IPv4;
the shared control plane performs authenticated dynamic routing.

The reference deployment is Fly.io in a North American region:

- one `shared-cpu-1x` Machine with 1 GB RAM;
- a 1 GB root filesystem;
- a 5 GB encrypted persistent volume;
- zero minimum running Machines;
- start on authenticated demand; and
- application-owned exit after work drains.

Application-owned exit is normative for asynchronous workers. Proxy autostop
alone may see the initiating HTTP request finish while background work is still
running and stop the Machine underneath that work. The worker must drain its
queue, persist the result, and exit itself. Cold starts are an accepted trade
for the MVP; suspend may be evaluated only after correctness under clock and
memory restoration is tested.

The provider and sizes are replaceable implementation choices. The isolation,
durable-volume, scale-to-zero, and control-plane boundaries are the decision.

## Decision 4 — Key ceremony happens at activation

Activation creates the user-held key material described by ADR 0002 and Creek
ADR-0005: a passphrase-derived wrapping key plus a recovery key shown exactly
once. Signup asks for neither. Provisioning does not create a usable plaintext
vault and promise to secure it later; the encrypted volume is initialized only
as part of the completed ceremony.

The operator never stores the passphrase, recovery key, or an unwrapped volume
master key. Losing both recovery factors remains unrecoverable by design. The
activation UX must say so before the user commits, allow cancellation, and
offer an export/download step for the recovery key without silently placing it
in operator-controlled storage.

## Decision 5 — The cost floor belongs only to activated vaults

At the reference configuration and Fly.io's published 2026-09-06 prices, the
per-user monthly estimate is:

```text
$0.75                         5 GB persistent volume
+ $0.15 * stopped_fraction   1 GB stopped root filesystem
+ $0.0082 * running_hours    1 GB shared-cpu-1x compute
+ egress + snapshots above the provider allowance
```

That is approximately $0.90 for an allocation that remains stopped, $0.94 at
ten active minutes per day, $1.14 at one active hour per day, $1.86 at four
active hours per day, and $6.67 when always running. The shared 256 MB control
plane is approximately $2.02 per month before traffic. Prices are planning
inputs, not protocol constants; the implementation must expose actual fleet
costs and alerts from provider billing rather than encode these dollar values.

No account that has not activated a vault may incur a per-user Machine or
volume charge. Capacity reservations may be purchased only after measured
usage makes their non-rollover commitment cheaper than on-demand billing.

## Decision 6 — A VM alone is not the intimate-content privacy guarantee

An ordinary cloud VM is isolated from other customers but still operated by
the cloud provider and Adepthood's infrastructure operator. It does not make
INTIMATE plaintext operator-blind. The full promise requires, together:

1. the user-held key and no operator escrow;
2. client-side ciphertext transit through Adepthood;
3. remote attestation of the measured Creek image;
4. key release only into that attested enclave; and
5. confidential inference for any model that sees INTIMATE plaintext.

Until every item ships and is exercised end to end, INTIMATE content stays on
the existing skip-only path. Provisioning an ordinary Fly Machine must never
flip that gate or change user-facing copy to imply otherwise.

## Decision 7 — Revisit the physical hosting shape, not the privacy invariant

Review the one-app/one-Machine reference design when either condition first
occurs:

- 500 activated vaults, so operational cardinality is real rather than
  hypothetical;
- 1,000 provisioned volumes;
- confidential-compute availability materially changes; or
- the rolling three-month vault fleet cost exceeds its approved budget.

A later design may pool attested execution capacity. It must preserve a
distinct encrypted volume and user-held key per account, attested key release,
no cross-user plaintext state, auditable deletion, and the same externally
observable single-user Creek contract. "Pooled compute" may not become
"shared readable corpus" by implementation convenience.

## Consequences

- Signup stays aligned with the Gift Economy and the North Star's low-friction
  journal floor.
- The recurring storage floor scales with activated private vaults rather than
  registrations, while compute follows actual use.
- The operator must build and run a new control plane, lifecycle reconciliation,
  billing alarms, and orphan cleanup.
- Cold starts and asynchronous readiness are user-visible and need honest
  progress/error states.
- Full private Higher-Self behavior remains unavailable for INTIMATE material
  until the attested path ships; the architecture does not paper over that gap.
