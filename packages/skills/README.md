# @braingate/skills

Hard project/scope/role permission boundary for BrainGate skills. A project skill is physically loaded only from `projects/<project_id>/<skill_id>/SKILL.md`; global skills must opt into `safeGlobal`.

Skills are capabilities, not authorities: a manifest can request network or worktree-write access, but it can never broaden the task execution profile.
