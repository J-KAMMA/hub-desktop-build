export const MAX_MUSIC_QUEUE = 200;
export const isPublicMusicTrackId = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id);

/** Source is bounded before deduplication; case aliases preserve the first item. */
export function normalizeMusicQueue(source) {
  if (!Array.isArray(source) || source.length > MAX_MUSIC_QUEUE || !Array.from(source).every(track => track && isPublicMusicTrackId(track.id))) throw Error('music_queue_invalid');
  const seen = new Set();
  return source.flatMap(track => {
    const id = track.id.toLowerCase();
    if (seen.has(id)) return [];
    seen.add(id);
    const item = {id};
    for (const key of ['title','artist','album','artworkUrl']) if (typeof track[key] === 'string') item[key] = track[key];
    if (Number.isFinite(track.durationSeconds) && track.durationSeconds >= 0) item.durationSeconds = track.durationSeconds;
    if (track.playlistStub === true) item.playlistStub = true;
    return [item];
  });
}
export function enqueueMusicQueue(source, track, currentId, placement = 'last') {
  const queue = normalizeMusicQueue(source), item = normalizeMusicQueue([track])[0];
  if (!['last','next'].includes(placement)) throw Error('music_queue_invalid');
  const current = isPublicMusicTrackId(currentId) ? currentId.toLowerCase() : null;
  const existing = queue.findIndex(value => value.id === item.id);
  if (existing >= 0 && (placement === 'last' || current === item.id)) return queue;
  if (existing >= 0) queue.splice(existing, 1);
  if (queue.length >= MAX_MUSIC_QUEUE) throw Error('music_queue_full');
  if (placement === 'last') queue.push(item);
  else queue.splice(queue.findIndex(value => value.id === current) + 1, 0, item);
  return queue;
}
export function removeMusicQueue(source, id) {
  if (!isPublicMusicTrackId(id)) throw Error('music_queue_invalid');
  return normalizeMusicQueue(source).filter(track => track.id !== id.toLowerCase());
}
/** Unknown/current outside the switched queue: next starts at first, previous is unavailable. */
export function adjacentMusicQueueTrack(queue, currentId, direction) {
  if (![1,-1].includes(direction)) return null;
  const current = isPublicMusicTrackId(currentId) ? currentId.toLowerCase() : null;
  const index = queue.findIndex(track => track.id === current);
  return direction === -1 && index <= 0 ? null : queue[index + direction] ?? null;
}
