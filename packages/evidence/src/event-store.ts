import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import { fingerprintSchema, runIdSchema, schemaVersionSchema } from "@hunter-pi/domain";
import {
  workflowEventAppendReceiptSchema,
  workflowEventAppendRequestSchema,
  workflowEventSchema,
  type WorkflowEvent,
  type WorkflowEventAppendReceipt,
  type WorkflowEventAppendRequest,
  type WorkflowEventStore,
} from "@hunter-pi/workflow-kernel";

import { writeImmutableAtomically, type AtomicWriteFaultInjector } from "./atomic-write.js";
import { DurableStoreError, isErrnoException, storeErrorFrom } from "./errors.js";
import { canonicalJson, sha256Fingerprint } from "./serialization.js";
import { LocalStorageController } from "./storage-policy.js";

const segmentPayloadSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    runId: runIdSchema,
    startCursor: z.number().int().positive(),
    endCursor: z.number().int().positive(),
    previousSegmentHash: fingerprintSchema.nullable(),
    events: z.array(workflowEventSchema).min(1),
  })
  .superRefine((segment, context) => {
    if (
      segment.events[0]?.cursor !== segment.startCursor ||
      segment.events.at(-1)?.cursor !== segment.endCursor ||
      segment.endCursor - segment.startCursor + 1 !== segment.events.length ||
      segment.events.some((event, index) => event.cursor !== segment.startCursor + index)
    ) {
      context.addIssue({ code: "custom", message: "segment cursors must be contiguous" });
    }
  });

const eventSegmentSchema = segmentPayloadSchema.safeExtend({
  segmentHash: fingerprintSchema,
});
type EventSegment = z.infer<typeof eventSegmentSchema>;

interface EventStreamState {
  readonly events: readonly WorkflowEvent[];
  readonly segments: readonly EventSegment[];
  readonly lastSegmentHash: EventSegment["segmentHash"] | null;
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function eventRunId(event: WorkflowEvent) {
  switch (event.type) {
    case "RUN_CREATED":
      return event.run.runId;
    case "ATTEMPT_STARTED":
      return event.attempt.runId;
    case "OBSERVATION_RECORDED":
      return event.observation.runId;
    case "VERIFICATION_RECORDED":
      return event.receipt.runId;
    case "HUMAN_RECEIPT_RECORDED":
      return event.receipt.runId;
    case "REVIEW_RECEIPT_RECORDED":
      return event.receipt.runId;
    case "CHECKPOINT_RECORDED":
      return event.checkpoint.runId;
  }
}

function segmentPayload(segment: EventSegment | z.infer<typeof segmentPayloadSchema>) {
  return {
    schemaVersion: segment.schemaVersion,
    runId: segment.runId,
    startCursor: segment.startCursor,
    endCursor: segment.endCursor,
    previousSegmentHash: segment.previousSegmentHash,
    events: segment.events,
  };
}

function segmentFilename(segment: EventSegment): string {
  const start = segment.startCursor.toString().padStart(12, "0");
  const end = segment.endCursor.toString().padStart(12, "0");
  return `${start}-${end}-${segment.segmentHash.slice("sha256:".length)}.json`;
}

function sameEvents(left: readonly WorkflowEvent[], right: readonly WorkflowEvent[]): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export interface FileWorkflowEventStoreOptions {
  readonly stateRoot: string;
  readonly storage?: LocalStorageController;
  readonly faultInjector?: AtomicWriteFaultInjector;
  readonly now?: () => string;
}

export class FileWorkflowEventStore implements WorkflowEventStore {
  readonly #stateRoot: string;
  readonly #storage: LocalStorageController;
  readonly #faultInjector: AtomicWriteFaultInjector | undefined;
  readonly #now: () => string;

  public constructor(options: FileWorkflowEventStoreOptions) {
    this.#stateRoot = resolve(options.stateRoot);
    this.#storage = options.storage ?? new LocalStorageController({ stateRoot: this.#stateRoot });
    this.#faultInjector = options.faultInjector;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  public async assertMutatingRunAllowed(): Promise<void> {
    await this.#storage.assertMutatingRunAllowed();
  }

  public async append(request: WorkflowEventAppendRequest): Promise<WorkflowEventAppendReceipt> {
    const parsed = workflowEventAppendRequestSchema.parse(request);
    const state = await this.#readState(parsed.runId);
    const currentCursor = state.events.at(-1)?.cursor ?? 0;
    const startCursor = parsed.events[0]?.cursor;
    const endCursor = parsed.events.at(-1)?.cursor;
    if (startCursor === undefined || endCursor === undefined) {
      throw new DurableStoreError(
        "CURSOR_CONFLICT",
        "An event append requires at least one event.",
      );
    }

    const replaySegment = state.segments.find(
      (segment) =>
        segment.startCursor === startCursor &&
        segment.endCursor === endCursor &&
        parsed.expectedCursor === segment.startCursor - 1 &&
        sameEvents(segment.events, parsed.events),
    );
    if (replaySegment !== undefined) {
      return this.#receipt(parsed.runId, replaySegment, "NOOP");
    }
    if (parsed.expectedCursor !== currentCursor || startCursor !== currentCursor + 1) {
      throw new DurableStoreError(
        "CURSOR_CONFLICT",
        "The append cursor does not match the last durable workflow event.",
      );
    }
    if (
      parsed.events.some(
        (event, index) =>
          event.cursor !== startCursor + index || eventRunId(event) !== parsed.runId,
      )
    ) {
      throw new DurableStoreError(
        "CURSOR_CONFLICT",
        "The appended events are not contiguous or do not bind the requested Run.",
      );
    }

    const payload = segmentPayloadSchema.parse({
      schemaVersion: "1.0.0",
      runId: parsed.runId,
      startCursor,
      endCursor,
      previousSegmentHash: state.lastSegmentHash,
      events: parsed.events,
    });
    const segment = eventSegmentSchema.parse({
      ...payload,
      segmentHash: sha256Fingerprint(canonicalJson(payload)),
    });
    const directory = this.#runDirectory(parsed.runId);
    try {
      await this.#storage.writeCritical(() =>
        writeImmutableAtomically({
          directory,
          filename: segmentFilename(segment),
          content: `${canonicalJson(segment)}\n`,
          ...(this.#faultInjector === undefined ? {} : { faultInjector: this.#faultInjector }),
        }),
      );
    } catch (error) {
      const durableError = storeErrorFrom(error, "FAULT_INJECTED");
      if (durableError.code === "RESERVE_REQUIRED") {
        throw durableError;
      }
      const afterFailure = await this.#readState(parsed.runId);
      const exactCommit = afterFailure.segments.find(
        (candidate) =>
          candidate.segmentHash === segment.segmentHash &&
          candidate.startCursor === segment.startCursor &&
          candidate.endCursor === segment.endCursor &&
          sameEvents(candidate.events, segment.events),
      );
      if (exactCommit !== undefined) {
        return this.#receipt(parsed.runId, exactCommit, "APPLIED");
      }
      throw durableError;
    }

    const committed = await this.#readState(parsed.runId);
    const committedSegment = committed.segments.find(
      (candidate) => candidate.segmentHash === segment.segmentHash,
    );
    if (committedSegment === undefined) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "The committed event segment could not be replayed after its atomic write.",
      );
    }
    return this.#receipt(parsed.runId, committedSegment, "APPLIED");
  }

  public async read(runId: z.input<typeof runIdSchema>): Promise<readonly WorkflowEvent[]> {
    const parsedRunId = runIdSchema.parse(runId);
    return (await this.#readState(parsedRunId)).events.map((event) =>
      workflowEventSchema.parse(event),
    );
  }

  public async listRunIds(): Promise<readonly z.infer<typeof runIdSchema>[]> {
    const eventsRoot = join(this.#stateRoot, "events");
    try {
      const entries = await readdir(eventsRoot, { withFileTypes: true });
      const parsed = entries.map((entry) => ({
        entry,
        runId: runIdSchema.safeParse(entry.name),
      }));
      if (parsed.some(({ entry, runId }) => !entry.isDirectory() || !runId.success)) {
        throw new DurableStoreError(
          "STORE_CORRUPT",
          "The workflow events root contains an unrecognized committed entry.",
        );
      }
      return parsed
        .map(({ runId }) => {
          if (!runId.success) {
            throw new DurableStoreError("STORE_CORRUPT", "Invalid workflow Run entry.");
          }
          return runId.data;
        })
        .sort();
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return [];
      }
      throw storeErrorFrom(error, "STORE_CORRUPT");
    }
  }

  async #readState(runId: z.infer<typeof runIdSchema>): Promise<EventStreamState> {
    const directory = this.#runDirectory(runId);
    let names: string[];
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      const unexpected = entries.filter(
        (entry) =>
          !entry.name.startsWith(".pending-") && (!entry.isFile() || !entry.name.endsWith(".json")),
      );
      if (unexpected.length > 0) {
        throw new DurableStoreError(
          "STORE_CORRUPT",
          "The workflow event directory contains an unrecognized committed entry.",
        );
      }
      names = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name);
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return { events: [], segments: [], lastSegmentHash: null };
      }
      throw storeErrorFrom(error, "STORE_CORRUPT");
    }

    const segments: EventSegment[] = [];
    for (const name of names) {
      try {
        const text = await readFile(join(directory, name), "utf8");
        const segment = eventSegmentSchema.parse(parseJson(text));
        if (
          segment.segmentHash !== sha256Fingerprint(canonicalJson(segmentPayload(segment))) ||
          name !== segmentFilename(segment) ||
          segment.runId !== runId ||
          segment.events.some((event) => eventRunId(event) !== runId)
        ) {
          throw new DurableStoreError(
            "STORE_CORRUPT",
            "A workflow event segment failed identity or checksum validation.",
          );
        }
        segments.push(segment);
      } catch (error) {
        throw storeErrorFrom(error, "STORE_CORRUPT");
      }
    }
    segments.sort((left, right) => left.startCursor - right.startCursor);

    const events: WorkflowEvent[] = [];
    let expectedCursor = 1;
    let previousSegmentHash: EventSegment["segmentHash"] | null = null;
    for (const segment of segments) {
      if (
        segment.startCursor !== expectedCursor ||
        segment.previousSegmentHash !== previousSegmentHash
      ) {
        throw new DurableStoreError(
          "STORE_CORRUPT",
          "The workflow event stream contains a gap, fork, overlap, or broken hash chain.",
        );
      }
      events.push(...segment.events.map((event) => workflowEventSchema.parse(event)));
      expectedCursor = segment.endCursor + 1;
      previousSegmentHash = segment.segmentHash;
    }
    return { events, segments, lastSegmentHash: previousSegmentHash };
  }

  #runDirectory(runId: z.infer<typeof runIdSchema>): string {
    return join(this.#stateRoot, "events", runId);
  }

  #receipt(
    runId: z.infer<typeof runIdSchema>,
    segment: EventSegment,
    outcome: "APPLIED" | "NOOP",
  ): WorkflowEventAppendReceipt {
    return workflowEventAppendReceiptSchema.parse({
      schemaVersion: "1.0.0",
      runId,
      startCursor: segment.startCursor,
      endCursor: segment.endCursor,
      segmentHash: segment.segmentHash,
      eventCount: segment.events.length,
      outcome,
      observedAt: this.#now(),
    });
  }
}
