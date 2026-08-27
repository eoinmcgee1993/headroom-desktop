# AGENTS.md - headroom-desktop

Canonical agent guidance for this repo lives in [CLAUDE.md](CLAUDE.md) (same
directory). Read it before changing code; it holds the project invariants
(testing rules, persistence rules, wheel-bump rules, styling/token rules,
formatting). This file only adds the quickstart every agent needs.

## What this is

Tauri desktop app (Rust backend in `src-tauri/src/`, React/TS frontend in
`src/`) that routes Claude Code / Codex / OpenCode through a local
token-optimization proxy. See README.md for architecture and the proxy
topology (ports 6767/6768).

## Commands

```bash
npm install && npm run tauri dev            # run the app
cargo test --manifest-path src-tauri/Cargo.toml --lib <filter>   # Rust tests
cargo check --manifest-path src-tauri/Cargo.toml                 # cross-module changes
npx tsc --noEmit                            # frontend types
npx vitest run                              # frontend tests
./scripts/check-colors.sh                   # CSS token gate (CI-enforced)
./scripts/check-no-console.sh               # console.log gate (CI-enforced)
```

## Large files warning

`tool_manager.rs` (~12k lines), `state.rs` (~9k), `lib.rs` (~7.3k),
`client_adapters.rs` (~5k), and `src/App.tsx` (~7.7k) are too big to read
whole. Locate symbols with `grep -n`, then read only the region you edit.

