/**
 * gzip through the platform's CompressionStream, streamed in chunks: for the device snapshot (docs/19 §8), which is
 * compressed before sealing and decompressed after opening. Intermediate chunks are wiped once copied.
 */
import { wipe, type Bytes } from "./bytes.ts";

/** Bytes handed to the stream at a time. */
const CHUNK = 1024 * 1024;

/** Feeds `input` to `stream` in chunks while its output is read; resolves with every output chunk. */
async function pump(
  input: Bytes,
  stream: { readonly writable: WritableStream<BufferSource>; readonly readable: ReadableStream<Uint8Array> },
  onChunk: (chunk: Uint8Array) => void,
): Promise<void> {
  const writer = stream.writable.getWriter();
  const write = (async () => {
    for (let i = 0; i < input.length; i += CHUNK) await writer.write(input.subarray(i, i + CHUNK));
    await writer.close();
  })();
  const reader = stream.readable.getReader();
  const read = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      onChunk(value);
      wipe(value);
    }
  })();
  // Both sides fail together (bad input): wait for both, report the first failure.
  const [written, readOut] = await Promise.allSettled([write, read]);
  if (readOut.status === "rejected") throw readOut.reason;
  if (written.status === "rejected") throw written.reason;
}

export async function gzip(input: Bytes): Promise<Bytes> {
  const parts: Uint8Array[] = [];
  let length = 0;
  await pump(input, new CompressionStream("gzip"), (chunk) => {
    parts.push(chunk.slice());
    length += chunk.length;
  });
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  wipe(...parts);
  return out;
}

/**
 * Decompresses gzip. The output buffer is sized once from the gzip trailer (the output's length mod 2^32), so a big
 * plaintext is not copied again at the end; it grows if the trailer does not match.
 */
export async function gunzip(input: Bytes): Promise<Bytes> {
  const n = input.length;
  const hinted =
    n >= 4 ? (input[n - 4]! | (input[n - 3]! << 8) | (input[n - 2]! << 16) | (input[n - 1]! << 24)) >>> 0 : 0;
  // deflate expands at most about 1032 times: a damaged trailer cannot ask for more than that.
  let out = new Uint8Array(Math.min(hinted, n * 1032));
  let length = 0;
  await pump(input, new DecompressionStream("gzip"), (chunk) => {
    if (length + chunk.length > out.length) {
      const grown = new Uint8Array(Math.max(out.length * 2, length + chunk.length));
      grown.set(out.subarray(0, length));
      wipe(out);
      out = grown;
    }
    out.set(chunk, length);
    length += chunk.length;
  });
  if (length === out.length) return out;
  const exact = out.slice(0, length);
  wipe(out);
  return exact;
}
