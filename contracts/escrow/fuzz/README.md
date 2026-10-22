# Escrow fuzzing (CT-27)

Coverage-guided fuzzing of `contracts/escrow` with [`cargo-fuzz`](https://github.com/rust-fuzz/cargo-fuzz).

The `escrow_ops` target runs random sequences of deposit, release, refund, timeout refund,
dispute, resolve, auto-release and stream operations with arbitrary actors and ledger timestamps,
using `soroban-sdk` testutils. After every step it asserts:

1. **Token conservation** — the sum of all holders' balances never changes (CT-02).
2. **Settled escrows are final** — a `Released`/`Refunded` escrow never changes status.
3. **Admin-only config** — admin setters called without admin auth fail and `get_config()` is unchanged.

## Run locally

```sh
rustup toolchain install nightly
cargo install cargo-fuzz
cd contracts/escrow
cargo +nightly fuzz run escrow_ops -- -max_total_time=600
```

Crashes are written to `fuzz/artifacts/escrow_ops/`. Reproduce one with:

```sh
cargo +nightly fuzz run escrow_ops fuzz/artifacts/escrow_ops/<crash-file>
```

The corpus lives in `fuzz/corpus/escrow_ops/` (git-ignored). CI runs the target for 10 minutes
nightly (`.github/workflows/contract-fuzz.yml`) and uploads any crashes as artifacts.

> The target needs `contracts/escrow` to compile — blocked on CT-01–CT-03.
