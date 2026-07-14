# Threat Model

## Scope

V2 currently protects a private, single-owner Gateway used by trusted external applications. The bearer token holder is treated as the owner and may submit prompts to every configured repository. Multi-user tenancy, public SaaS exposure, and untrusted repository hosting are out of scope.

## Protected assets

- Gateway bearer token and data-encryption key;
- ChatGPT/Codex authentication state;
- future OpenAI Platform API keys;
- local repository contents and host files;
- prompt, result, and event content stored by the Gateway;
- subscription quota and local CPU, memory, process, and disk capacity.

## Enforced boundaries

- clients select opaque repository IDs, never paths;
- public APIs expose Gateway conversation/job/event IDs only;
- App Server uses private stdio, fixed methods, `approvalPolicy: never`, and read-only sandboxing;
- child environment variables use an allowlist, excluding Gateway and OpenAI secrets;
- a dedicated `CODEX_HOME` prevents accidental inheritance of the owner's normal MCP configuration;
- prompts, results, and event data are authenticated-encrypted at rest;
- idempotency and bounded resources reduce accidental or deliberate quota exhaustion;
- App Server requests for approval or interactive tools are rejected.

## Critical unresolved boundary

Read-only controls mutation; it does not prove that the model's file-reading capabilities are restricted to the selected repository. A malicious prompt or repository instruction could try to read HOME, SSH material, cloud configuration, another repository, or Codex authentication data and place it in the model response.

Production use therefore requires a separately verified execution boundary that limits readable roots, such as a dedicated OS account plus a container, VM, or platform sandbox exposing only the selected repository and the minimum runtime files. The dedicated `CODEX_HOME` authentication mechanism must be tested within that boundary without copying plaintext credentials.

Output filtering is not an acceptable substitute because secrets can be transformed before output.

## Trust expansion rules

Before adding write mode, use a job-specific worktree or copy and return a patch/commit for explicit application. Do not automatically retry write attempts after a crash.

Before adding image or audio, keep Platform API credentials server-side, create capability-specific schemas and budgets, and store binary output as authorized artifacts rather than SQLite blobs.

Before adding multiple users, replace the single-owner token with external identity, per-owner repository policy, quotas, audit retention, revocation, and cryptographic tenant separation.
