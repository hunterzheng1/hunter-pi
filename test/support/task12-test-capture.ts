import {
  createTestPilotEvidenceCapture,
  type TrustedPilotEvidenceCapture,
} from "../../packages/pilot/src/capture.js";
import type { PilotEvidence } from "@hunter-pi/pilot";

export function testPilotEvidenceCapture(evidence: PilotEvidence): TrustedPilotEvidenceCapture {
  return createTestPilotEvidenceCapture(evidence);
}
