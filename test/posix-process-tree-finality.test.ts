import { describe, expect, it } from "vitest";

import {
  linuxSubreaperProcessTreeHelperSource,
  nextLinuxCompleteEmptyScanCount,
} from "../packages/execution/src/posix-process-group-helper-source.js";

describe("Linux process-tree finality", () => {
  it("invalidates an empty candidate when any intervening complete scan is active", () => {
    let completeEmptyScans = 0;

    completeEmptyScans = nextLinuxCompleteEmptyScanCount(completeEmptyScans, "EMPTY");
    expect(completeEmptyScans).toBe(1);

    completeEmptyScans = nextLinuxCompleteEmptyScanCount(completeEmptyScans, "ACTIVE");
    expect(completeEmptyScans).toBe(0);

    completeEmptyScans = nextLinuxCompleteEmptyScanCount(completeEmptyScans, "EMPTY");
    expect(completeEmptyScans).toBe(1);
    expect(completeEmptyScans >= 2).toBe(false);
  });

  it("invalidates an empty candidate at a control boundary", () => {
    const emptyCandidate = nextLinuxCompleteEmptyScanCount(0, "EMPTY");

    expect(nextLinuxCompleteEmptyScanCount(emptyCandidate, "CONTROL_BOUNDARY")).toBe(0);
  });

  it("embeds the tested scan transition in the generated subreaper helper", () => {
    expect(linuxSubreaperProcessTreeHelperSource).toContain("nextLinuxCompleteEmptyScanCount");
  });
});
