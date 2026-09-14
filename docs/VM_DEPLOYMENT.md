# VM Deployment (Oracle Cloud ARM) — status & runbook

## Current status (2026-09-14)

Deployed and running **infrastructure** is complete, but the agy CLI on the VM is
blocked by an Antigravity backend **eligibility check** that Google runs against
datacenter IPs. Browser verification on the same Google account succeeds, but the
CLI check still fails (known backend-side loop; see
https://discuss.ai.google.dev/t/bug-eligibility-check-failed-in-antigravity-cli-v1-1-5-and-ide-despite-active-google-ai-pro-subscription-and-successful-oauth/176002).

## What is already installed on the VM (sa-bogota-1, `ubuntu@`)

| Item | Path |
|---|---|
| agy ARM v1.2.2 | `~/.local/bin/agy` |
| Bot repo (clone) | `~/workspace/antigravity-telegram-bot` (built, `dist/index.js` present) |
| Keyring password | `~/.config/agy-kr-pass` (0600) |
| Login keyring | `~/.local/share/keyrings/login.keyring` (empty until Google unlocks) |
| Keyring tools | `~/tools/gktool.py`, `~/tools/agyprobe.py` |
| Lazy helper | `~/agy-keyring-helper.py` (libsecret save/restore of `service=gemini, username=antigravity` items) |
| Token backup | `~/agy-token-backup.json` (export from Bazzite keyring at 2026-09-14) |
| systemd user unit | `~/.config/systemd/user/antigravity-telegram-bot.service` |
| Bot env | `~/workspace/antigravity-telegram-bot/.env` (token `8848251587:AAEx…` = @Antigravity_OracleMax01_bot) |

## When Google removes the eligibility block

```bash
# On the VM (SSH from Bazzite: ssh -i ~/.ssh/oracle_eva ubuntu@100.115.4.11)
cd ~/workspace/antigravity-telegram-bot
git pull origin main          # pick up the latest fixes (model passthrough, retry/backoff…)
npm ci --silent && npm run build
systemctl --user daemon-reload
systemctl --user restart antigravity-telegram-bot
systemctl --user is-active antigravity-telegram-bot   # expect: active

# Then verify agy auth:
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus
python3 ~/tools/gktool.py unlock-keyring -p "$(cat ~/.config/agy-kr-pass)" \
        -s /run/user/1001/keyring/control
~/.local/bin/agy -p /usage    # should print quota buckets, not an eligibility error
```

## Known infrastructure quirks on this VM

1. **No `rsync`** installed by default (`sudo apt install rsync` if needed).
2. **`iptables`** blocks new ports — open with
   `sudo iptables -I INPUT 5 -p tcp --dport <PORT> -m state --state NEW -j ACCEPT`
   and persist with `sudo sh -c 'iptables-save > /etc/iptables/rules.v4'`.
3. **Bot and gateway must BOTH keep running** — if `systemctl --user` dies on
   boot, use `busctl --user call … RestartUnit ss …` (pitfall in the Hermes
   skills: the guard blocks direct `systemctl … restart hermes-gateway` via
   terminal).
4. Headless gnome-keyring needs the `--daemonize --login` unlock (pass from
   `~/.config/agy-kr-pass`) — `~/start-agy-bot.sh` already handles this before
   exec-ing the bot process.

## Bot id/token used on the VM

- Bot: **@Antigravity_OracleMax01_bot** (id 8848251587)
- Different from Bazzite bot — necessary: two Telegram bot instances using one
  token race for `getUpdates`.
