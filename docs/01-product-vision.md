# Product vision

## One-sentence definition

Hunter Pi is designed to become a ready-to-use personal coding Agent distribution that combines Pi's interactive engine and package ecosystem with a Hunter-owned, evidence-driven workflow for planning, implementing, verifying, recovering, and learning from code changes. This is a target definition, not a claim that the product is implemented.

## Problem

Current terminal coding Agents are productive in a single conversation, but a developer still has to reconstruct critical delivery state:

- What exact change was approved?
- Which plan and acceptance checks were used?
- Was a failed attempt overwritten by a later success?
- Did the Agent merely stop, or did independent checks pass?
- Can work resume after a terminal, machine, or model interruption?
- Which plugins altered tool behavior?
- Which lessons are safe to reuse in the next change?

Hunter-Harness demonstrated useful answers, but its current product is a general workflow/distribution system rather than a cohesive daily Agent. Raw Pi is intentionally minimal and expects users to assemble their own workflow. Oh My Pi offers a broad batteries-included fork, but adopting it as a base would make Hunter depend on a second, substantially divergent core.

Hunter Pi fills the gap: one install, one interactive Agent, one coherent workflow, and honest evidence.

## Target user

The first user is a single developer on Windows who:

- works across existing Git repositories;
- uses coding Agents daily;
- wants a polished terminal interaction similar to Pi, Claude Code, or Codex CLI;
- sometimes wants quick, low-ceremony help and sometimes needs a traceable delivery workflow;
- wants to use multiple model providers and standard Pi packages;
- values control, recoverability, and explicit verification more than opaque autonomy.

Team governance, hosted multi-tenant collaboration, and a mobile control plane are outside the first product.

## Value proposition

Hunter Pi should make the reliable path easier than assembling it manually:

1. Install Hunter Pi, review model-provider data egress, and authenticate through the selected provider's normal flow.
2. Open any repository with `hpi`.
3. Choose a Quick Session or describe a Managed Change.
4. Let Hunter Pi plan, execute, test, review, and recover with visible limits.
5. Receive an evidence-backed result that distinguishes success, failure, and uncertainty.

## Product principles

### One product, replaceable engine

The user installs and operates Hunter Pi. Upstream Pi is an engine behind a narrow Host interface, not the owner of Hunter workflow state.

### Workflow depth without ceremony everywhere

Quick Sessions remain conversational. Managed Changes add immutable plans, Attempts, verification, evidence, and recovery only when the user asks for a deliverable outcome.

### Completion requires proof

Agent text, process exit, terminal idle, and UI state are Observations. A Managed Change reaches `READY` only when every required automated Verification passes and every separately declared human gate has an exact Human Receipt. A Human Receipt never converts an unrun or failed automated check into a pass.

### Preserve failure history

Retry and recovery append new Attempts. They never edit a failed Attempt into a successful one.

### Extend before forking

Use public Pi Extension, Pi Package, JSON, RPC, and SDK interfaces first. Forking is an exception justified by reproduced interface blockers.

### Compatible, not blindly permissive

Pi packages should be easy to install. Their source, version, process authority, collisions, Compatibility, Trust, and Isolation remain visible because extensions execute local code. Compatibility evidence is not a security certification.

### Local-first and portable

Canonical workflow state, credentials, and local execution remain on the active device unless an explicit integration says otherwise. Model use is an explicit network integration: prompts and selected repository context may leave the device for the configured provider, subject to that provider's endpoint, retention, and account policy. Hunter Pi must disclose this before first use and never equate local-first with offline or zero data egress. Project configuration and redacted workflow artifacts can move through Git; credentials and live processes cannot.

## Version-one scope

Version one targets:

- a terminal `hpi` command;
- Windows x64 daily use, with Ubuntu CI and compatibility design;
- first-run provider authentication and model selection;
- Quick Session and Managed Change modes;
- a Hunter-owned Workflow Kernel;
- one qualified upstream Pi release;
- Plan → Execute → Verify → Review lifecycle;
- bounded retry and checkpoint recovery;
- isolated Git worktrees for Managed Changes;
- project build/test discovery with explicit overrides;
- redacted Evidence and a human-readable outcome summary;
- standard Pi package installation with separate Compatibility, Trust, and Isolation reporting;
- stable and preview update channels with rollback;
- a downloadable Windows artifact after the npm preview proves the workflow.

## Explicit non-goals

Version one does not include:

- a desktop IDE, Electron application, or mobile application;
- a hosted source-code service;
- team RBAC, organization billing, or multi-tenant state;
- automatic publication, push, merge, deployment, or paid action without an explicit workflow decision;
- guaranteed compatibility with every Pi or OMP plugin;
- automatic adoption of every upstream Pi release;
- an Oh My Pi fork;
- a production-quality alternative Agent engine in parallel with Pi;
- migration of every Hunter-Harness feature.

## Success definition

Hunter Pi reaches **daily-use preview** only when a fresh supported Windows machine can:

1. install the exact release from a published artifact;
2. complete first-run setup without editing source files;
3. acknowledge provider data egress and authenticate without exposing credentials or raw transmitted content to Hunter Evidence;
4. open a real repository and run a Quick Session;
5. complete a Managed Change with one deliberate failed Attempt and one recovery Attempt;
6. independently verify the declared acceptance checks;
7. resume after a forced process interruption from a valid Checkpoint;
8. install at least one representative standard Pi package and report its Compatibility, Trust, and Isolation honestly;
9. update to a qualified release and roll back without losing project state;
10. pass the full local gate and actual Windows/Ubuntu CI for the exact release commit.

Until all ten conditions have dated Evidence, the product remains preview or `NOT_PROVEN`.
