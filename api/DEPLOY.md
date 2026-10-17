# Deploying the API to Freestyle

Live: **https://divergent-api.style.dev** (VM slug `divergent`, port 8000). All data is simulated.

## One-time setup (done)
```bash
npx -y freestyle@latest login                       # browser auth; a card must be on file to create VMs
npx -y freestyle@latest vm create --slug divergent --display-name "Divergent API"
```
VM user is `ubuntu` (home `/home/ubuntu`), Python 3.12, passwordless sudo.

## Deploy / redeploy (run from repo root)
```bash
tar --exclude='__pycache__' --exclude='.pytest_cache' -cf /tmp/app.tar api sim analysis planning requirements.txt
npx -y freestyle@latest vm scp /tmp/app.tar divergent:/home/ubuntu/app.tar
npx -y freestyle@latest vm exec divergent --timeout-ms 300000 -- bash -lc \
  'mkdir -p ~/app && cd ~/app && tar xf ../app.tar 2>/dev/null; \
   [ -d .venv ] || python3 -m venv .venv; .venv/bin/pip install -q -r requirements.txt; \
   sudo systemctl restart divergent-api'
```
Never ship `.env` or `.venv`. Set `LLM_API_KEY` for `/explain` on the VM with a systemd drop-in
(`sudo systemctl edit divergent-api`, add `[Service]` + `Environment=LLM_API_KEY=...`); without it, explain uses a template.

## Service (done once)
`/etc/systemd/system/divergent-api.service` runs `uvicorn api.main:app --host 0.0.0.0 --port 8000` as `ubuntu`
with `Restart=always`, enabled at boot, so it comes back after pause/start.

## Public URL
```bash
npx -y freestyle@latest tls create --domain divergent-api.style.dev --from public --to vm=divergent,port=8000
npx -y freestyle@latest tls list --vm divergent        # inspect / delete with `tls delete <id>`
```
Neil: `VITE_API_URL=https://divergent-api.style.dev`

## Check
```bash
curl https://divergent-api.style.dev/health
curl https://divergent-api.style.dev/scenarios
```
Logs: `npx -y freestyle@latest vm exec divergent -- sudo journalctl -u divergent-api -n 50 --no-pager`

## Pause / start
```bash
npx -y freestyle@latest vm pause divergent
npx -y freestyle@latest vm start divergent
```
