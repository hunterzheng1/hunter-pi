export class LfOnlyNdjsonDecoder {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #maximumBytes: number;
  #buffer = "";
  #capturedBytes = 0;
  #finished = false;

  public constructor(maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
      throw new Error("NDJSON capture limit must be a positive safe integer");
    }
    this.#maximumBytes = maximumBytes;
  }

  public push(chunk: Uint8Array): Record<string, unknown>[] {
    if (this.#finished) {
      throw new Error("cannot append to a finished NDJSON stream");
    }
    this.#capturedBytes += chunk.byteLength;
    if (this.#capturedBytes > this.#maximumBytes) {
      throw new Error("NDJSON stream exceeded its bounded capture limit");
    }
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    return this.#drainCompleteLines();
  }

  public finish(): Record<string, unknown>[] {
    if (this.#finished) {
      throw new Error("NDJSON stream was already finished");
    }
    this.#finished = true;
    this.#buffer += this.#decoder.decode();
    const records = this.#drainCompleteLines();
    if (this.#buffer.length > 0) {
      throw new Error("NDJSON stream ended with an unterminated record");
    }
    return records;
  }

  #drainCompleteLines(): Record<string, unknown>[] {
    const records: Record<string, unknown>[] = [];
    let lineFeed = this.#buffer.indexOf("\n");
    while (lineFeed >= 0) {
      let line = this.#buffer.slice(0, lineFeed);
      this.#buffer = this.#buffer.slice(lineFeed + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      records.push(this.#parseRecord(line));
      lineFeed = this.#buffer.indexOf("\n");
    }
    return records;
  }

  #parseRecord(line: string): Record<string, unknown> {
    if (line.length === 0) {
      throw new Error("NDJSON stream contained an empty record");
    }
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("NDJSON record must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  }
}
