// 同時に鳴らすのは1つだけ。再生が始まった側が claim すると、ほかの登録先の pause を呼ぶ。
// 登録先は Hub の曲（audio）、共有の YouTube 枠、右列のブラウザ。1つの pause が落ちても残りは止める。
export function createPlaybackOwner() {
  const pausers = new Map();
  let owner = null;
  return {
    /** 止め方を登録する。返り値で登録を外す（同じ id を登録し直していたら外さない）。 */
    register(id, pause) {
      pausers.set(id, pause);
      return () => { if (pausers.get(id) === pause) pausers.delete(id); };
    },
    /** id が鳴り始めた。自分以外を止める。 */
    claim(id) {
      owner = id;
      for (const [other, pause] of [...pausers]) {
        if (other === id) continue;
        try { pause(); } catch { /* 1つの失敗で残りを止め損ねない */ }
      }
    },
    current: () => owner,
  };
}
