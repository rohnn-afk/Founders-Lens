# Founder's Lens development

Use the primary repository checkout and `integration/consolidated` for active development. Keep `staging` as the deployment branch.

Do not create Git worktrees for this repository unless the user explicitly authorizes one. For isolated builds and tests, use Git archive exports, disposable directories outside the repository, or containers. Prepare release branches from the approved staging baseline so their pull requests contain only the intended changes.
