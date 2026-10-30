interface SearchableThreadPost {
  no: number;
  displayName: string;
  body: string;
  authorHandle?: string;
  createdAt?: string;
  voteSummary?: { score: number };
  knowledge?: { role?: string; sources?: Array<{ url: string }> };
}

export interface ThreadPostSearchFilters { author?: string; minScore?: number; role?: string; hasSource?: boolean; from?: string; to?: string; }

interface SearchableThread {
  title: string;
  boardTitle: string;
  searchText: string;
}

function normalizeSearchText(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("ja-JP");
}

export function searchThreadPosts<T extends SearchableThreadPost>(posts: T[], query: string): T[] {
  const terms = normalizeSearchText(query).trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return posts;

  return posts.filter((post) => {
    const searchable = normalizeSearchText([
      String(post.no),
      `#${post.no}`,
      post.displayName,
      post.authorHandle ?? "",
      post.body
    ].join(" "));
    return terms.every((term) => searchable.includes(term));
  });
}

export function filterThreadPosts<T extends SearchableThreadPost>(posts: T[], query: string, filters: ThreadPostSearchFilters = {}): T[] {
  const author = normalizeSearchText(filters.author ?? "").trim();
  const from = filters.from ? Date.parse(filters.from) : Number.NaN;
  const to = filters.to ? Date.parse(`${filters.to}T23:59:59.999`) : Number.NaN;
  return searchThreadPosts(posts, query).filter((post) => {
    const identity = normalizeSearchText(`${post.displayName} ${post.authorHandle ?? ""}`);
    const timestamp = post.createdAt ? Date.parse(post.createdAt) : Number.NaN;
    if (author && !identity.includes(author)) return false;
    if (filters.minScore != null && (post.voteSummary?.score ?? 0) < filters.minScore) return false;
    if (filters.role && filters.role !== "all" && post.knowledge?.role !== filters.role) return false;
    if (filters.hasSource && !post.knowledge?.sources?.length) return false;
    if (!Number.isNaN(from) && (Number.isNaN(timestamp) || timestamp < from)) return false;
    if (!Number.isNaN(to) && (Number.isNaN(timestamp) || timestamp > to)) return false;
    return true;
  });
}

export function searchThreads<T extends SearchableThread>(threads: T[], query: string): T[] {
  const terms = normalizeSearchText(query).trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return threads;

  return threads.filter((thread) => {
    const searchable = normalizeSearchText(`${thread.title} ${thread.boardTitle} ${thread.searchText}`);
    return terms.every((term) => searchable.includes(term));
  });
}
