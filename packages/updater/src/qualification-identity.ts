import {
  releaseCandidateIdentitySchema,
  releaseCandidateSchema,
  type ReleaseCandidate,
} from "./contracts.js";

export function windowsPortableQualificationCandidateIdentity(candidate: ReleaseCandidate) {
  const { qualification, ...identityInput } = releaseCandidateSchema.parse(candidate);
  void qualification;
  return releaseCandidateIdentitySchema.parse(identityInput);
}
