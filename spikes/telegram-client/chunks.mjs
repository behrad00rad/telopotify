export const CHUNK_BYTES = 512 * 1024;

export async function* readTelegramRange(client, message, start, length, signal) {
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length < 0) {
    throw new Error('Invalid byte range');
  }
  if (length === 0) return;

  const alignedStart = Math.floor(start / CHUNK_BYTES) * CHUNK_BYTES;
  let downloadedPosition = alignedStart;
  let yielded = 0;
  for await (const chunk of client.iterDownload(message, {
    offset: alignedStart,
    limit: length + (start - alignedStart),
    requestSize: CHUNK_BYTES,
    signal,
  })) {
    const startInChunk = Math.max(0, start - downloadedPosition);
    const part = chunk.subarray(startInChunk, startInChunk + length - yielded);
    if (part.length) {
      yielded += part.length;
      yield part;
    }
    downloadedPosition += chunk.length;
    if (yielded >= length) return;
  }
}

const TRANSIENT_NETWORK_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);

export function isStaleFileReference(error) {
  const description = `${error?.errorMessage ?? ''} ${error?.message ?? ''}`;
  return /FILE_REFERENCE_(?:EXPIRED|INVALID)|FILEREF_UPGRADE_NEEDED/i.test(description);
}

export async function fetchTelegramChunk(client, message, start, length, signal) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error('Request cancelled');
    try {
      const parts = [];
      let received = 0;
      for await (const part of readTelegramRange(client, message, start, length, signal)) {
        parts.push(part);
        received += part.length;
      }
      if (received !== length) throw new Error(`Incomplete Telegram chunk: ${received}/${length} bytes`);
      return Buffer.concat(parts, length);
    } catch (error) {
      if (attempt === 2 || !TRANSIENT_NETWORK_ERRORS.has(error.code) || signal?.aborted) throw error;
      await new Promise(resolve => setTimeout(resolve, 300 * 2 ** attempt));
    }
  }
}
