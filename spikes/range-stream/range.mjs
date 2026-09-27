export function parseRange(header, size) {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid file size');
  if (!header) return { status: 200, start: 0, end: size - 1 };
  if (size === 0) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;

  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
    if (start >= size || end < start) return null;
    end = Math.min(end, size - 1);
  }
  return { status: 206, start, end };
}
