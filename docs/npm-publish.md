# Publishing `pi-provider-gd` to npm

How to ship a new release. Registry: <https://www.npmjs.com/package/pi-provider-gd>.
Account `peeloo` has **2FA on writes** with a **WebAuthn security key** (no TOTP app), so the
publish step is interactive — plan for it (see step 4).

---

## 1. Pre-flight

```bash
cd pi-provider-gd
git status                 # must be clean
npm install                # undici + pi-powerline-footer are needed by tests/type-check
npm test                   # node --test  → all green
npx tsc --noEmit -p tsconfig.json
npm pack --dry-run         # eyeball the file list (18 files) + shasum
```

The suite is hermetic (global `fetch` is stubbed), so it is safe to run anywhere.
CI (`.github/workflows/ci.yml`) runs the same three commands on push.

Do **not** publish with a red test suite or a type error: the tarball ships `src/`,
`extensions/`, `prompts/`, `scripts/` as-is — there is no build step.

## 2. Choose the version

| change since last release | bump |
| --- | --- |
| new commands / tools / behavior | `minor` |
| fixes only | `patch` |
| breaking provider or config change | `major` |

```bash
npm version minor --no-git-tag-version     # or patch / major
node -p "require('./package.json').version"
```

## 3. Commit + tag the release

```bash
git add -A
git commit -m "chore: release v$(node -p "require('./package.json').version")"
git tag "$(node -p "require('./package.json').version")"
```

The registry records `gitHead`, so the tag must point at the exact commit you publish.

## 4. Publish (interactive: security key)

```bash
npm publish
```

npm prints a one-time URL and opens a browser tab:

```
Authenticate your account at:
https://www.npmjs.com/auth/cli/<session-uuid>
Press ENTER to open in the browser...
```

Log in → the page asks for the **security key** → **touch the key**. npm polls the
session and the publish completes on its own. Then verify (step 5).

On a 2FA-via-security-key account npm may also print `Your package is being processed and
may take a few minutes to become available.` — that is the normal path, not a warning.
Wait for `+ pi-provider-gd@X.Y.Z`; that is the completion signal, and step 5 tells you how
long the registry takes to show it.

### If you are not at a keyboard-in-terminal (publishing from an agent/tool shell)

`npm publish` needs a **TTY** (without one it skips the web flow and dies with
`EOTP`), and its stdin must **not hit EOF** or the process is torn down mid-auth.
Run it detached in its own session and give it a never-ending stdin:

```bash
cat > /tmp/gd-publish.sh <<'EOF'
#!/bin/bash
cd /home/alx/code/pi-provider-gd || exit 1
tail -f /dev/null | script -qefc 'npm publish' /tmp/pub.typescript
EOF
chmod +x /tmp/gd-publish.sh
rm -f /tmp/pub.log /tmp/pub.typescript
setsid nohup /tmp/gd-publish.sh > /tmp/pub.log 2>&1 < /dev/null &
sleep 15
grep -ao 'https://www.npmjs.com/auth/cli/[a-f0-9-]*' /tmp/pub.log | tail -1
```

Surface that URL to the human, have them touch the key, then poll
`pgrep -f "npm publish"` / `tail /tmp/pub.log` until it exits.
Sessions expire (a stale URL answers **404**); re-run to get a fresh one.

## 5. Verify on the registry

```bash
npm view pi-provider-gd --json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['dist-tags'], list(d['versions']))"
npm view pi-provider-gd@X.Y.Z gitHead dist.shasum
npm pack pi-provider-gd@X.Y.Z --prefer-online    # in an empty dir; shasum must match step 1
```

- `dist-tags.latest` must be the new version.
- `dist.shasum` must equal the `shasum` printed by `npm pack --dry-run` before publishing.
- `--prefer-online` matters: right after a publish the local npm cache can answer
  `E404 notarget` for a version that is already live.

### Do not verify against npmjs.com

The **registry** (`registry.npmjs.org`) is the source of truth, and it is the only thing
this checklist may consult. The **website** (npmjs.com package page, search index) is a
cached view that lags the registry by minutes and sometimes much longer, so a 1.1.0-looking
page after a 1.2.0 publish is *not* evidence of a failed publish. A publish is confirmed by
`curl -s https://registry.npmjs.org/<pkg> | python3 -m json.tool` showing the version in
`versions` plus a `time` entry — not by reloading the browser tab.

**A publish is done when `npm publish` says `+ pkg@X.Y.Z` (exit 0).** That line is printed
*after* the registry accepted the upload. Everything after it — the version appearing in the
packument, `dist-tags` moving, the website updating — is propagation, and it is not yours to
fix. Measured on 1.2.0: `+ pkg@1.2.0` at 13:27, version + `latest` in the packument at 13:31
(~4-5 min). Do not re-run `npm publish` in that window; see the `E409` rows below for what
that buys you.

## 6. Push the release

```bash
git push origin main --tags
```

## Troubleshooting

| symptom | cause | fix |
| --- | --- | --- |
| `EOTP This operation requires a one-time password` | no TTY, so npm could not start the web flow | re-run inside a pty (step 4) |
| auth URL answers `404 not found` | session expired or already used | re-run `npm publish`, use the new URL |
| `E409 Conflict — Cannot publish over previously staged version "X.Y.Z"` (npm 11) | the version is **already on the registry**, still in its post-publish processing window; npm 11 words it as "staged", npm 12 as "previously published" | **do not bump, do not retry.** This message is *evidence the publish succeeded.* Confirm with `curl -s https://registry.npmjs.org/<pkg> \| python3 -m json.tool`; it lands as `latest` within ~5 min. Only bump if the version is still absent **and** `time` has not advanced. |
| `You cannot publish over the previously published versions: "X.Y.Z"` (npm 12) | same condition, different wording | same: verify, wait, do not bump |
| `npm stage list` → `No staged packages found` / `/-/stage` returns `{"items":[]}` while `npm publish` still answers `E409` | expected — the post-publish processing record is not a *staged draft*, so it is invisible to the stage API | not a signal either way. Trust the packument: absent version + `E409` = still processing, so wait |
| `npm pack pkg@X.Y.Z` → `notarget` right after publishing | stale local cache | retry with `--prefer-online` |
| `Cannot find package 'undici'` in `npm test` | deps not installed | `npm install` |
| publishing got the wrong content in | — | fix forward: patch-bump and publish; `npm unpublish <pkg>@<ver>` is only allowed within 72h and breaks anyone who pinned it |

## Checklist

- [ ] clean tree, `npm install`, `npm test` green, `npx tsc --noEmit` clean
- [ ] `npm pack --dry-run` file list looks right; note the shasum
- [ ] version bumped; `chore: release vX.Y.Z` commit + tag
- [ ] `npm publish` completed via security key (`+ pi-provider-gd@X.Y.Z`, exit 0)
- [ ] registry `latest` + shasum verified **after** propagation (~5 min), not against the
      npmjs.com page
- [ ] `git push origin main --tags`
