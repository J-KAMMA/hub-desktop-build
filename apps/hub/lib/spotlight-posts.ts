interface SpotlightPost {
  id: string;
  no: number;
  engagement: { score: number };
  spotlightScore?: number;
  voteSummary?: { score: number };
  knowledge?: { role?: string; freshness?: string; sources?: Array<{ kind?: string }> };
  deletedAt?: string;
  moderatedAt?: string;
  viewerMuted?: boolean;
  viewerBlocked?: boolean;
}

export function explainSpotlightScore(post: SpotlightPost, bestAnswerPostId?: string) {
  const vote = post.spotlightScore ?? post.voteSummary?.score ?? 0;
  const sources = post.knowledge?.sources ?? [];
  const sourceBonus = Math.min(3, sources.reduce((total, source) => total + (source.kind === "primary" ? 2 : source.kind === "news" ? 1 : 0), 0));
  const correctionBonus = post.knowledge?.role === "correction" ? 2 : 0;
  const freshnessPenalty = post.knowledge?.freshness === "outdated" ? -4 : post.knowledge?.freshness === "possibly_outdated" ? -1 : 0;
  const bestAnswerBonus = post.id === bestAnswerPostId ? 5 : 0;
  return { total: vote + sourceBonus + correctionBonus + freshnessPenalty + bestAnswerBonus, vote, sourceBonus, correctionBonus, freshnessPenalty, bestAnswerBonus };
}

export const SPOTLIGHT_SCORE_THRESHOLD = 3;
export const SPOTLIGHT_REPLY_LIMIT = 20;

function isVisible(post: SpotlightPost) {
  return !post.deletedAt && !post.moderatedAt && !post.viewerMuted && !post.viewerBlocked;
}

export function selectSpotlightPosts<T extends SpotlightPost>(posts: readonly T[], bestAnswerPostId?: string): T[] {
  const first = posts.find((post) => post.no === 1);
  const replies = posts
    .filter((post) => post.no > 1 && isVisible(post))
    .filter((post) => post.id === bestAnswerPostId || explainSpotlightScore(post, bestAnswerPostId).total >= SPOTLIGHT_SCORE_THRESHOLD || (post.knowledge?.role === "counterpoint" && ((post.voteSummary as {up?:number;down?:number}|undefined)?.up ?? 0) + ((post.voteSummary as {up?:number;down?:number}|undefined)?.down ?? 0) >= 3))
    .sort((left, right) => {
      if (left.id === bestAnswerPostId) return -1;
      if (right.id === bestAnswerPostId) return 1;
      return explainSpotlightScore(right, bestAnswerPostId).total - explainSpotlightScore(left, bestAnswerPostId).total || left.no - right.no;
    })
    .slice(0, SPOTLIGHT_REPLY_LIMIT);
  const selectedIds = new Set(replies.map((post) => post.id));
  return posts
    .filter((post) => post === first || selectedIds.has(post.id))
    .slice()
    .sort((left, right) => left.no - right.no);
}
