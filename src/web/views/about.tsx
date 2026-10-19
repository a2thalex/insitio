import type { Analysis } from "../../services/analyze.js";
import type { Release } from "../../services/releases.js";
import type { RepoCtx } from "../repoContext.js";
import { blobUrl, repoUrl } from "../paths.js";
import { Avatar, CsrfField, Octicon } from "./layout.js";

export function AboutSidebar({
  ctx,
  csrf,
  canAdmin,
  branchCount,
  hasReadme,
  analysis,
  topics,
  latest,
  error,
}: {
  ctx: RepoCtx;
  csrf: string;
  canAdmin: boolean;
  branchCount: number;
  hasReadme: boolean;
  analysis: Analysis;
  topics: string[];
  latest: Release | null;
  error?: string;
}) {
  const { repo } = ctx;
  const base = repoUrl(repo.owner, repo.name);
  const top = analysis.contributors.slice(0, 14);
  return (
    <aside class="col-md-3 pl-md-4 mt-4 mt-md-0 flex-shrink-0" aria-label="About">
      <div class="d-flex flex-items-center mb-2">
        <h2 class="f4 flex-auto">About</h2>
        {canAdmin && (
          <details class="details-reset">
            <summary class="btn btn-sm" aria-label="Edit repository details">
              <Octicon name="gear" />
            </summary>
            <form method="post" action={`${base}/about`} class="mt-2">
              <CsrfField csrf={csrf} />
              {error && <div class="flash flash-error mb-2" role="alert">{error}</div>}
              <label class="f6 d-block mb-1" for="about-description">Description</label>
              <input class="form-control input-sm mb-2" id="about-description" name="description" value={repo.description} maxlength={350} />
              <label class="f6 d-block mb-1" for="about-website">Website</label>
              <input class="form-control input-sm mb-2" id="about-website" name="website" value={repo.website} placeholder="https://" />
              <label class="f6 d-block mb-1" for="about-topics">Topics</label>
              <input class="form-control input-sm mb-2" id="about-topics" name="topics" value={topics.join(" ")} aria-describedby="about-topics-hint" />
              <p class="f6 color-fg-muted" id="about-topics-hint">Up to 20, lowercase letters, numbers and hyphens.</p>
              <button class="btn btn-sm btn-primary" type="submit">Save</button>
            </form>
          </details>
        )}
      </div>
      <p class="f4 color-fg-default">{repo.description || <span class="color-fg-muted f5"><em>No description provided.</em></span>}</p>
      {repo.website && (
        <p class="f5"><a href={repo.website} rel="noopener noreferrer"><Octicon name="link" class="mr-1" />{repo.website.replace(/^https?:\/\//, "")}</a></p>
      )}
      {topics.length > 0 && (
        <p class="d-flex flex-wrap" style="gap:4px">
          {topics.map((topic) => (
            <a class="topic-tag" href={`/topics/${topic}`}>{topic}</a>
          ))}
        </p>
      )}
      {analysis.licensePath && (
        <p class="f6">
          <a class="Link--secondary" href={blobUrl(repo.owner, repo.name, repo.defaultBranch, analysis.licensePath)}>
            <Octicon name="law" class="mr-1" />
            {analysis.licenseId || "View license"}
          </a>
        </p>
      )}
      {analysis.languages.length > 0 && (
        <div class="mb-3">
          <div class="lang-bar mb-2" aria-hidden="true">
            {analysis.languages.map((lang) => (
              <span style={`width:${lang.percent}%;background:${lang.color}`} title={`${lang.name} ${lang.percent.toFixed(1)}%`}></span>
            ))}
          </div>
          <ul class="list-style-none f6 d-flex flex-wrap" style="gap:8px">
            {analysis.languages.map((lang) => (
              <li>
                <span class="lang-dot" style={`background:${lang.color}`}></span> {lang.name}{" "}
                <span class="color-fg-muted">{lang.percent >= 1 ? lang.percent.toFixed(1) : "<1"}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <ul class="list-style-none f6 color-fg-muted">
        {hasReadme && <li class="mb-2"><a class="Link--secondary" href="#readme"><Octicon name="book" class="mr-2" />Readme</a></li>}
        <li class="mb-2"><Octicon name="star" class="mr-2" /><strong>{repo.stars}</strong> star{repo.stars === 1 ? "" : "s"}</li>
        <li class="mb-2"><a class="Link--secondary" href={`${base}/watchers`}><Octicon name="eye" class="mr-2" /><strong>{ctx.watchers}</strong> watching</a></li>
        <li class="mb-2"><a class="Link--secondary" href={`${base}/forks`}><Octicon name="repo-forked" class="mr-2" /><strong>{ctx.forks}</strong> fork{ctx.forks === 1 ? "" : "s"}</a></li>
        <li class="mb-2"><a class="Link--secondary" href={repoUrl(repo.owner, repo.name, "branches")}><Octicon name="git-branch" class="mr-2" /><strong>{branchCount}</strong> branch{branchCount === 1 ? "" : "es"}</a></li>
        {latest && (
          <li class="mb-2">
            <a class="Link--secondary" href={repoUrl(repo.owner, repo.name, "releases", "tag", latest.tag)}>
              <Octicon name="tag" class="mr-2" />{latest.title}
            </a>
          </li>
        )}
      </ul>
      {top.length > 0 && (
        <div class="mt-3">
          <h3 class="f6 color-fg-muted mb-2">
            <a class="Link--secondary" href={`${base}/graphs/contributors`}>Contributors</a>
          </h3>
          <ul class="list-style-none d-flex flex-wrap" style="gap:4px">
            {top.map((person) => {
              const username = ctx.userForEmail(person.email);
              const label = username ?? person.name;
              return (
                <li>
                  {username ? (
                    <a href={`/${username}`} title={`${label}, ${person.commits} commits`}><Avatar name={username} size={32} /></a>
                  ) : (
                    <span title={`${person.name} <${person.email}>, ${person.commits} commits`}><Avatar name={person.name} size={32} /></span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </aside>
  );
}
