import type { RepoRow } from "../../services/repos.js";
import { Octicon, TimeAgo } from "./layout.js";

export function RepoListItem({ repo, showOwner = false }: { repo: RepoRow; showOwner?: boolean }) {
  return (
    <div class="Box-row">
      <h3 class="f4 text-normal mb-1">
        <a class="text-bold" href={`/${repo.owner}/${repo.name}`}>
          {showOwner ? `${repo.owner}/` : ""}
          {repo.name}
        </a>
        <span class="Label Label--secondary ml-2 v-align-middle">{repo.isPrivate ? "Private" : "Public"}</span>
      </h3>
      {repo.description && <p class="color-fg-muted mb-2">{repo.description}</p>}
      <div class="f6 color-fg-muted">
        <span class="mr-3"><Octicon name="star" class="mr-1" />{repo.stars}</span>
        Created <TimeAgo ts={repo.createdAt} />
      </div>
    </div>
  );
}
