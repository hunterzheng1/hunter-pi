import { describe, expect, it } from "vitest";

import { LfOnlyNdjsonDecoder } from "@hunter-pi/pi-host";

describe("Pi LF-only NDJSON decoder", () => {
  it("keeps U+2028 and U+2029 inside JSON strings while decoding split UTF-8 chunks", () => {
    const decoder = new LfOnlyNdjsonDecoder(1024);
    const bytes = Buffer.from(
      `${JSON.stringify({ id: "first", value: "line\u2028separator\u2029value" })}\r\n${JSON.stringify({ id: "second", value: "中文" })}\n`,
      "utf8",
    );

    const records = [
      ...decoder.push(bytes.subarray(0, 17)),
      ...decoder.push(bytes.subarray(17, bytes.length - 2)),
      ...decoder.push(bytes.subarray(bytes.length - 2)),
      ...decoder.finish(),
    ];

    expect(records).toEqual([
      { id: "first", value: "line\u2028separator\u2029value" },
      { id: "second", value: "中文" },
    ]);
  });

  it("fails closed on malformed, unterminated, or oversized records", () => {
    expect(() => new LfOnlyNdjsonDecoder(32).push(Buffer.from("not-json\n"))).toThrow();

    const unterminated = new LfOnlyNdjsonDecoder(32);
    unterminated.push(Buffer.from('{"id":"missing-lf"}'));
    expect(() => unterminated.finish()).toThrow(/unterminated/iu);

    expect(() => new LfOnlyNdjsonDecoder(8).push(Buffer.from('{"value":"too large"}\n'))).toThrow(
      /limit/iu,
    );
  });
});
