# Local dev loop — no Docker (`deploy/local-native/`)

Runs the whole Hydropark stack locally **without Docker**: MongoDB (single-node
replica set) + the Java backend + the Angular/Tauri client with **real
inference**. This is the recipe proven on the demo-readiness push.

> This is deliberately separate from **`deploy/local/`**, which is the
> **Docker-compose** path (`up.ps1` → `docker compose up`). Use that if you have
> Docker working and only need the backend. Use **this** directory to run the
> full stack (including the desktop client) on a machine where the Mongo
> installer/Compass and Docker are troublesome.

## One command

```powershell
# from anywhere:
powershell -File deploy\local-native\dev-up.ps1
```

That opens three windows — **hp-mongo**, **hp-backend**, **hp-client** — gating
between them (mongo primary → backend `/v1/catalog` → client). First
real-inference build takes a couple of minutes. Stop with `dev-down.ps1` or by
closing the windows.

`-SkipClient` brings up mongo + backend only (e.g. to run `capture_preview`
yourself, or drive the client by hand).

## Or run the pieces yourself (three terminals)

```powershell
powershell -File deploy\local-native\mongo.ps1      # 1. mongod --replSet rs0 (foreground)
powershell -File deploy\local-native\backend.ps1    # 2. mvn spring-boot:run (local profile, foreground)
powershell -File deploy\local-native\client.ps1     # 3. ng serve + cargo run --bin hydropark
```

Each blocks in its terminal; Ctrl-C to stop.

## What each script does

| Script | Does |
|---|---|
| `mongo.ps1` | Starts the **ZIP** `mongod --replSet rs0` against `<repo>/.mongo-rs0`, initiates rs0 on first run. The backend's multi-doc transactions **require** a replica set. |
| `backend.ps1` | Loads (or generates) `deploy/.env.generated` signing keys, sets `MONGODB_URI` + `HP_PACKAGE_SIGNING_ENABLED`, runs the **`local`** Spring profile with `--hydropark.seed.publish-packages=true` (seeds the catalog + publishes the 10 signed `.hpskill`). |
| `client.ps1` | Ensures Angular is on `:4200`, sets `LIBCLANG_PATH`/CMake/(vcvars)/`HYDROPARK_PACKAGE_SIGNING_KEYS`/`HYDROPARK_MODEL_PATH`, runs `cargo run --bin hydropark` (real inference). |
| `dev-up.ps1` | Orchestrates all three in gated order, each in its own window. |
| `dev-down.ps1` | Shuts down mongo + the app; close the backend/client windows for the rest. |

## Prerequisites (and how to override paths)

Every machine-specific path is auto-detected but overridable via an env var
before you run (see `_env.ps1`):

- **MongoDB** — the **ZIP** distribution (not the MSI: its installer hangs on
  Compass, and it registers an auto-start `MongoDB` service that grabs `:27017`
  as a **non**-replica-set standalone). If you installed the MSI, disable that
  service once, elevated: `Stop-Service MongoDB; Set-Service MongoDB -StartupType Manual`.
  Override: `$env:HP_MONGOD_BIN`. `mongosh` must be on PATH.
- **JDK + Maven** on PATH (backend).
- **Rust real-inference toolchain**: `LIBCLANG_PATH` (`$env:HP_LIBCLANG_PATH`),
  CMake (`$env:HP_CMAKE_BIN`), MSVC build tools (`$env:HP_VCVARS` — vcvars64.bat).
- **Node** on PATH (Angular).
- **Base model** GGUF at `client/models/qwen2.5-3b-instruct-q4_k_m.gguf` or
  `$env:HYDROPARK_MODEL_PATH`.

## Notes

- `.mongo-rs0/` and `deploy/.env.generated` are git-ignored (local state / dev
  secrets). Nothing here writes anything tracked.
- `deploy/.env.generated` is created on first run via
  `deploy/scripts/generate-keys.ps1` (ES256 license + RSA access + Ed25519
  package keys; uses openssl if present, else a Java fallback).
- PowerShell 5.1 compatible (no `&&`/`||`/ternary).
