export type GitHubRepositoryTarget = { owner: string; repo: string; fullName: string; href: string };
export type GitHubReadStatus = "ok" | "unavailable" | "rate_limited";
export type GitHubRepositoryItem = { number: number; title: string; href: string };
export type GitHubRepositoryCommit = { oid: string; title: string; href: string };
export type GitHubRepositoryOverview = {
  status: "ok" | "partial" | "unavailable" | "rate_limited";
  repository: { name: string; href: string; description: string; defaultBranch: string; stars: number } | null;
  issues: GitHubRepositoryItem[] | null;
  pullRequests: GitHubRepositoryItem[] | null;
  commits: GitHubRepositoryCommit[] | null;
  categoryStatuses: Record<"issues" | "pullRequests" | "commits", GitHubReadStatus>;
};

// Do not normalize URL paths or strip .git: either can silently change the target.
export function parseGitHubRepositoryInput(input: unknown): GitHubRepositoryTarget | null {
  if (typeof input !== "string" || input.length > 180 || /[\s\u0000-\u001f\u007f-\u009f]/u.test(input)) return null;
  const name = input.startsWith("https://github.com/") ? input.slice(19) : input;
  const parts = name.split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(owner)
    || !/^[a-z\d_.-]{1,100}$/i.test(repo) || repo === "." || repo === "..") return null;
  const canonicalName = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  return { owner: owner.toLowerCase(), repo: repo.toLowerCase(), fullName: canonicalName, href: `https://github.com/${canonicalName}` };
}
