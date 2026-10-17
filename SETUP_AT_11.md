# SETUP_AT_11.md — do this at 11:00, not before

## Diego (first 10 minutes)
1. Create GitHub repo, invite Neil, Leo, Ali.
2. Copy in all docs: `CLAUDE.md AGENTS.md CONTRACT.md PLAN.md README.md SETUP_AT_11.md .env.example .gitignore team/`.
3. `mkdir -p sim api analysis/tests planning/tests fixtures` and add empty `__init__.py` in `sim api analysis planning`.
4. First commit + push: "docs, contract, team briefs". Tell everyone to pull.
5. Freestyle VM up; post the preview URL in the team chat.

## Everyone (after pulling)
1. `cp .env.example .env` and fill keys.
2. Python people (Diego, Leo, Ali): `python -m venv .venv && source .venv/bin/activate && pip install fastapi uvicorn numpy filterpy pydantic pytest`
3. Open your agent in the repo and type only: **"I'm <your name>. Go."** It reads your `team/<NAME>.md` and starts task 1.

## Git rules
- Branches: `diego/*`, `neil/*`, `leo/*`, `ali/*`. Merge to `main` often; pull before you merge.
- Only touch your own folders → almost no merge conflicts.
- Contract changes: ask Diego; update `fixtures/` in the same commit.
- Tag `v-core` at 2:00 PM. Feature freeze 3:30. No code after 4:10.
