---
status: accepted
reviewed_at: 2026-08-04
reviewer: codex
upstream_project: pi-silent-gui
upstream_repository: https://github.com/IIwate/pi-silent-gui
upstream_revision: 8edf70993d41c2fd62e8278fce7ad82f151955b1
upstream_path: src/backend/desktop.py; src/backend/job.py; src/backend/process.py
license: MIT / Copyright (c) 2026 IIwate
hunter_paths:
  - packages/execution/src/windows-job-helper-source.ts
  - packages/execution/src/windows-job-driver.ts
release_scope: NOT_SHIPPED
---

Hunter Pi inspected the upstream Python `ctypes` implementation as an architectural cross-check for three Windows invariants: create the target with `PROC_THREAD_ATTRIBUTE_JOB_LIST`, set `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, and retain a process identity stronger than a bare PID. No Python source, private-desktop behavior, elevation/token flow, GUI behavior, or package runtime dependency was copied into Hunter Pi.

The Hunter implementation was independently written in C#, PowerShell, and TypeScript against Microsoft Win32 documentation for [`UpdateProcThreadAttribute`](https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute), [`CreateJobObjectW`](https://learn.microsoft.com/windows/win32/api/jobapi2/nf-jobapi2-createjobobjectw), [`QueryInformationJobObject`](https://learn.microsoft.com/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject), and Job Object limit flags. It adds a private NDJSON control protocol, explicit environment blocks, restricted inherited handles, stdout/stderr draining, timeout/cancel reconciliation, and portable fingerprint-only receipts. The upstream code remains a research reference rather than a linked, vendored, or shipped component.

The referenced revision is MIT-licensed and compatible with Hunter Pi's MIT repository license. This record preserves the review trail; it does not claim upstream endorsement, Windows safety outside the exact Task 7 tests, or publication readiness.
