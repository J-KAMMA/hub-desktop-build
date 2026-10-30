// Hubの曲（Music Workerの公開曲）の再生元を決める。
// Rustの media_audio(origin, trackId) が検証済みのバイトを返せればそれをblob:で鳴らし、
// コマンドが無い・失敗した時は従来の直接URLへ退く（DESIGN 6.6）。
// YouTube等の外部作品はここへ来ない。来ても media_audio は呼ばない。

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 呼び出しの形はここだけ。Rust側の引数名が変わった時はこの1行を直す。
const callMediaAudio = (invoke, origin, trackId) => invoke('media_audio', { origin, trackId });

export function createHubTrackAudio({ invoke, URLApi = URL }) {
  if (typeof invoke !== 'function') throw Error('hub_track_audio_invoke_invalid');
  let objectUrl = null;
  const release = () => {
    if (objectUrl) { URLApi.revokeObjectURL(objectUrl); objectUrl = null; }
  };
  return {
    /** 再生に使うURLを返す。blob:が作れなければdirectUrl。古い呼び出しだと分かれば null。 */
    async resolve({ origin, trackId, directUrl, isCurrent = () => true }) {
      // 直接URLへ退く時も、前のblob:は呼び出し側が src を差し替える直前に不要になるので破棄する。
      const direct = () => { release(); return directUrl; };
      if (typeof trackId !== 'string' || !UUID.test(trackId)) return direct();
      let bytes;
      try { bytes = await callMediaAudio(invoke, origin, trackId); } catch { return isCurrent() ? direct() : null; }
      if (!isCurrent()) return null;
      const size = bytes?.byteLength ?? bytes?.length;
      if (!(size > 0)) return direct();
      const next = URLApi.createObjectURL(new Blob([bytes]));
      if (!isCurrent()) { URLApi.revokeObjectURL(next); return null; }
      release();
      objectUrl = next;
      return next;
    },
    release,
  };
}
