export type ThreadLayout = "flat" | "tree";
export type ThreadTreeSort = "best" | "top" | "new" | "old" | "controversial";

export interface ThreadTreePost {
  id: string;
  no: number;
  createdAt: string;
  replyToPostId?: string | null;
  voteSummary?: { up: number; down: number; score: number };
}

export interface ThreadTreeRow<T> {
  post: T;
  depth: number;
  childCount: number;
}

function compare<T extends ThreadTreePost>(sort: ThreadTreeSort) {
  return (left: T, right: T) => {
    const l = left.voteSummary ?? { up: 0, down: 0, score: 0 };
    const r = right.voteSummary ?? { up: 0, down: 0, score: 0 };
    if (sort === "new") return right.createdAt.localeCompare(left.createdAt) || right.no - left.no;
    if (sort === "old") return left.createdAt.localeCompare(right.createdAt) || left.no - right.no;
    if (sort === "top") return r.score - l.score || r.up - l.up || left.no - right.no;
    if (sort === "controversial") {
      const leftBalance = Math.min(l.up, l.down);
      const rightBalance = Math.min(r.up, r.down);
      return rightBalance - leftBalance || (r.up + r.down) - (l.up + l.down) || left.no - right.no;
    }
    const leftConfidence = (l.score * Math.log2(l.up + l.down + 2)) + Math.min(l.up, 12) - Math.min(l.down, 8);
    const rightConfidence = (r.score * Math.log2(r.up + r.down + 2)) + Math.min(r.up, 12) - Math.min(r.down, 8);
    return rightConfidence - leftConfidence || r.score - l.score || left.no - right.no;
  };
}

export function buildThreadTreeRows<T extends ThreadTreePost>(posts: readonly T[], sort: ThreadTreeSort): ThreadTreeRow<T>[] {
  if (!posts.length) return [];
  const root = [...posts].sort((a, b) => a.no - b.no)[0];
  const known = new Set(posts.map((post) => post.id));
  const children = new Map<string, T[]>();
  for (const post of posts) {
    if (post.id === root.id) continue;
    const parentId = post.replyToPostId && known.has(post.replyToPostId) ? post.replyToPostId : root.id;
    const siblings = children.get(parentId) ?? [];
    siblings.push(post);
    children.set(parentId, siblings);
  }
  for (const siblings of children.values()) siblings.sort(compare(sort));

  const rows: ThreadTreeRow<T>[] = [{ post: root, depth: 0, childCount: children.get(root.id)?.length ?? 0 }];
  const visited = new Set([root.id]);
  const visit = (parentId: string, depth: number) => {
    for (const post of children.get(parentId) ?? []) {
      if (visited.has(post.id)) continue;
      visited.add(post.id);
      rows.push({ post, depth, childCount: children.get(post.id)?.length ?? 0 });
      visit(post.id, depth + 1);
    }
  };
  visit(root.id, 1);
  return rows;
}

export function normalizeThreadLayout(value: string | undefined, fallback: ThreadLayout): ThreadLayout {
  return value === "tree" || value === "flat" ? value : fallback;
}

export function normalizeThreadTreeSort(value: string | undefined): ThreadTreeSort {
  return value === "top" || value === "new" || value === "old" || value === "controversial" ? value : "best";
}
