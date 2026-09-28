export type QueueState = {
  trackIds: string[];
  currentIndex: number;
  repeat: 'off' | 'all' | 'one';
};

export function createQueue(trackIds: string[], startId?: string): QueueState {
  const unique = [...new Set(trackIds)];
  return {
    trackIds: unique,
    currentIndex: startId ? Math.max(0, unique.indexOf(startId)) : 0,
    repeat: 'off',
  };
}

export function currentTrackId(queue: QueueState): string | null {
  return queue.trackIds[queue.currentIndex] ?? null;
}

export function nextTrack(queue: QueueState, automatic = false): QueueState {
  if (!queue.trackIds.length) return queue;
  if (automatic && queue.repeat === 'one') return queue;
  const next = queue.currentIndex + 1;
  if (next < queue.trackIds.length) return { ...queue, currentIndex: next };
  return queue.repeat === 'all' ? { ...queue, currentIndex: 0 } : queue;
}

export function advanceAfterEnd(queue: QueueState): QueueState | null {
  if (!queue.trackIds.length) return null;
  const next = nextTrack(queue, true);
  return next === queue && queue.repeat === 'off' ? null : next;
}

export function stepPlayableQueue(queue: QueueState, available: Set<string>,
  direction: 'next' | 'previous', automatic = false): QueueState | null {
  if (automatic && queue.repeat === 'one' && available.has(currentTrackId(queue) ?? '')) return queue;
  let cursor = queue;
  for (let count = 0; count < queue.trackIds.length; count++) {
    const next = direction === 'next' ? nextTrack(cursor, false) : previousTrack(cursor);
    if (next === cursor) return automatic ? null : queue;
    if (available.has(currentTrackId(next) ?? '')) return next;
    cursor = next;
  }
  return automatic ? null : queue;
}

export function previousTrack(queue: QueueState): QueueState {
  if (!queue.trackIds.length) return queue;
  if (queue.currentIndex > 0) return { ...queue, currentIndex: queue.currentIndex - 1 };
  return queue.repeat === 'all' ? { ...queue, currentIndex: queue.trackIds.length - 1 } : queue;
}

export function removeFromQueue(queue: QueueState, trackId: string): QueueState {
  const index = queue.trackIds.indexOf(trackId);
  if (index < 0) return queue;
  const trackIds = queue.trackIds.filter(id => id !== trackId);
  const currentIndex = trackIds.length === 0 ? 0 :
    index < queue.currentIndex ? queue.currentIndex - 1 :
    Math.min(queue.currentIndex, trackIds.length - 1);
  return { ...queue, trackIds, currentIndex };
}

export function addToQueue(queue: QueueState, trackId: string): QueueState {
  return queue.trackIds.includes(trackId) ? queue :
    { ...queue, trackIds: [...queue.trackIds, trackId] };
}

export function playNextInQueue(queue: QueueState, trackId: string): QueueState {
  const currentId = currentTrackId(queue);
  if (currentId === trackId) return queue;
  const trackIds = queue.trackIds.filter(id => id !== trackId);
  const nextIndex = currentId ? trackIds.indexOf(currentId) + 1 : 0;
  trackIds.splice(nextIndex, 0, trackId);
  return { ...queue, trackIds, currentIndex: currentId ? trackIds.indexOf(currentId) : 0 };
}

export function moveQueueTrack(queue: QueueState, trackId: string, direction: -1 | 1): QueueState {
  const index = queue.trackIds.indexOf(trackId);
  const destination = index + direction;
  if (index < 0 || destination < 0 || destination >= queue.trackIds.length) return queue;
  const currentId = currentTrackId(queue);
  const trackIds = [...queue.trackIds];
  [trackIds[index], trackIds[destination]] = [trackIds[destination], trackIds[index]];
  return { ...queue, trackIds, currentIndex: currentId ? trackIds.indexOf(currentId) : 0 };
}

export function moveQueueTrackTo(queue: QueueState, trackId: string, destination: number): QueueState {
  const index = queue.trackIds.indexOf(trackId);
  if (index < 0 || !Number.isFinite(destination)) return queue;
  const target = Math.max(0, Math.min(queue.trackIds.length - 1, Math.round(destination)));
  if (index === target) return queue;
  const currentId = currentTrackId(queue);
  const trackIds = [...queue.trackIds];
  trackIds.splice(index, 1);
  trackIds.splice(target, 0, trackId);
  return { ...queue, trackIds, currentIndex: currentId ? trackIds.indexOf(currentId) : 0 };
}

export function shuffleUpcoming(queue: QueueState, random = Math.random): QueueState {
  const start = Math.min(queue.trackIds.length, queue.currentIndex + 1);
  const upcoming = queue.trackIds.slice(start);
  for (let index = upcoming.length - 1; index > 0; index--) {
    const other = Math.min(index, Math.floor(random() * (index + 1)));
    [upcoming[index], upcoming[other]] = [upcoming[other], upcoming[index]];
  }
  return { ...queue, trackIds: [...queue.trackIds.slice(0, start), ...upcoming] };
}
