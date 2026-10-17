# CLAUDE.md

## On every session start — do this immediately, without asking
1. If the user hasn't said who they are, ask one question: "Diego, Leo, or Ali?"
2. Open `team/<NAME>.md` (DIEGO.md, LEO.md, or ALI.md) and `CONTRACT.md`.
3. Start the first unchecked task in your team file. When a task is done and its test passes, change `- [ ]` to `- [x]`,
   commit, and move to the next one. Don't wait for confirmation between tasks unless a task says to.

## Ownership — only edit your own folders
| Person | Folders |
|---|---|
| Diego | `sim/`, `api/`, deploy scripts |
| Leo | `analysis/` |
| Ali | `planning/` |
| Neil (Codex) | `web/`, `fixtures/` |

Never edit another person's folder or `CONTRACT.md`. If the contract needs to change, write the proposed change in chat and stop.

## Rules
- Match `CONTRACT.md` exactly, including the Python module interfaces. Modules are pure functions on plain dicts.
- Test your module alone with your own small fake input in `<your_folder>/tests/`. Never block on someone else's code.
- Synthetic data only. Fixed random seeds everywhere.
- Stack: Python 3.11+, FastAPI, uvicorn, NumPy, filterpy, pydantic, pytest. Ask before adding any other dependency.
- Keys come from env (`LLM_API_KEY`). Never hardcode or commit keys.
- Commit small and often on your branch (`diego/*`, `leo/*`, `ali/*`); merge to `main` often; keep `main` runnable.
- If a task takes more than 30 minutes, stop and propose a simpler version.
- Scope is surveillance and decision support only: no weapons, engagement, targeting, or strike code.
  Recon must follow the guardrails in `CONTRACT.md`.

## Commands
- API: `uvicorn api.main:app --reload --port 8000`
- Tests: `python -m pytest <folder>/tests -q`
