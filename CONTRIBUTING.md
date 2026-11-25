# Contributing to Founder's Lens

## Branches

Keep one checkout. `main` is the stable release and public portfolio reference.
`staging` is the integration branch and the source of automated staging API releases.

Fetch before branching. Start feature and integration fixes from `origin/staging`.
Start stable-only fixes and repository documentation changes from the relevant target.

```sh
git fetch --prune origin
git switch -c feature/idea-management origin/staging
git push -u origin feature/idea-management
```

Use temporary names beginning with `feature/`, `fix/`, `docs/`, `refactor/`, or
`chore/`. Keep each branch focused on one change. GitHub deletes merged PR branches.
After merging, fetch with pruning and delete the local topic branch once its work is
integrated. Keep tags and immutable release records for deployments.

## Commits and pull requests

Use conventional commit subjects such as `fix(api): preserve the idea version on retry`.
Explain the change and its validation in the PR. Require CI and resolved review
conversations before merging. The repository supports solo development with zero
required approving reviews. Direct pushes, forced updates and deletion of the
permanent branches are blocked.

Send normal product changes to `staging`. Main requires the build/test and
secret/dependency checks. Staging also requires the API image smoke and vulnerability
check. Use disposable resources for tests that write data. Keep credentials and
private environment files outside Git.

## Releases

A qualifying merge into `staging` runs the protected release job when promotion is
enabled. It publishes a commit-tagged image, deploys its immutable digest to the
staging API, and checks the deployed service. The Windows signer must be publishing
fresh authority decisions for readiness. The public demo is managed separately.

Prepare a stable release PR into `main` only after reviewing the complete diff.
Promote focused commits if staging also contains work that is still under review.
Record the staging commit, CI run and deployed digest for relevant release changes.
A merge into `main` runs CI and leaves the staging and public-demo services alone.
