# Testing the pro products

Private repos, real licence keys, premium features actually switched on —
locally and in CI. Read [SUITE.md §2b](SUITE.md) for the tags first; this file is
the inventory those tags are built on, plus the setup nobody can guess.

Scope: **ColorMag Pro, Zakra Pro, User Registration Pro, Everest Forms Pro.**
Masteriyo is deliberately out of scope. No Lemon Squeezy product was found in the
catalogue during the inventory, so there is no Lemon Squeezy adapter — adding one
would be one file under `plugins/themegrill-qa/scripts/lib/license/`.

---

## 1. The inventory

Built by reading the pro source on a developer machine, not from documentation.
Where a row is incomplete it says so; nothing here is inferred.

| Product | Pro repo | Provider | Store / id | Key stored | Status stored | Activation entry point |
|---|---|---|---|---|---|---|
| **ColorMag Pro** | `themegrill/colormag-pro` | **Freemius** | id `4212`, slug `colormag`, `pk_414d89e1f7eda2dd7de41050ab418` | Freemius `fs_accounts` | Freemius `fs_accounts` | `FS_ThemeGrill::init()` — `functions.php:420`, wrapping `fs_dynamic_init()` at `functions.php:372` |
| **Zakra Pro** | `themegrill/zakra-pro` | **Freemius** | id `4560`, slug `zakra-pro`, `pk_7147c17354facd275c90c45a6aa66`, bundle `4562` | Freemius `fs_accounts` | Freemius `fs_accounts` | `FS_ZakraTheme::init()` — `inc/class-fs-zakratheme.php:98`, wrapping `fs_dynamic_init()` at `:80` |
| **User Registration Pro** | `wpeverest/user-registration-pro` | **EDD** | `https://wpeverest.com/edd-sl-api/`, **no item_id** | `user-registration_license_key` | `user-registration_license_active` | `UR_Plugin_Updater::activate_license()` — `includes/class-ur-plugin-updater.php:343` → `UR_Updater_Key_API::activate()` at `includes/admin/updater/class-ur-plugin-updater-api.php:101` |
| **Everest Forms Pro** | `wpeverest/everest-forms-pro` | EDD *(inferred)* | **UNKNOWN** | `everest-forms-pro_license_key` | UNKNOWN | UNKNOWN |

### How each product gates a premium feature

This differs per product and is what a `@pro` spec ultimately asserts against.

| Product | Pro check |
|---|---|
| ColorMag Pro | `FS_ThemeGrill::freemius()->can_use_premium_code()` |
| Zakra Pro | `FS_ZakraTheme::freemius()->can_use_premium_code()` |
| User Registration Pro | `false !== ur_get_license_plan()` |
| Everest Forms Pro | `false !== evf_get_license_plan()` |

### Corrections to what was assumed going in

Four, and three of them change the design.

1. **ColorMag Pro is Freemius, not EDD.** The registry example in the brief had
   it on EDD with a `colormag_pro_license_status` option. No such option exists;
   there is a vendored Freemius SDK (2.13.1) at `colormag-pro/freemius/`. Zakra
   Pro is Freemius too. So the catalogue splits **two Freemius, two EDD**, and
   the Freemius half cannot be activated over HTTP at all — activation is an SDK
   opt-in handshake that only happens inside WordPress.

2. **ColorMag Pro is a standalone THEME**, not a companion plugin and not a child
   theme. "Install pro" means "switch theme", and the free and pro themes must
   never be active together. Zakra Pro *is* a companion plugin — to a free
   *theme*, which must stay active alongside it. No single mounting rule covers
   both, which is why `boot-wp.mjs` reads `licenses.json` rather than assuming.

3. **User Registration Pro sends no `item_id`.** The store resolves the product
   from the key alone (`class-ur-plugin-updater-api.php:101-107`), so `item_id`
   is optional in the registry and in the EDD adapter.
   Also: `UR_PRO_ACTIVE` means only "the pro plugin is installed" and says
   nothing about the licence. It is not a pro gate and must not be used as one.

4. **`check_license` omits `error` entirely.** Verified against the real
   wpeverest.com store, and it corrected the adapter:

   ```
   check_license     {"success":false,"license":"invalid","item_id":false,…}
   activate_license  {"success":false,"license":"invalid",…,"error":"missing"}
   ```

   The first implementation keyed its verdict off `error`, so a `check` of a bad
   key came back "unknown" — routing a genuinely invalid licence to the harness
   owner as a suspected store outage. `license` is authoritative; `error` only
   refines the reason when the store sends one.

### Everest Forms Pro — why the row is incomplete

`everest-forms-pro` is not checked out on any machine used to build this, and
`EVF_Updater_Key_API` — which holds the store endpoint — is defined only in the
pro plugin. Everything recorded above is proved from the **free** plugin, which
carries the gate itself: `evf_get_license_plan()`
(`includes/evf-core-functions.php:1624`) reads
`get_option('everest-forms-pro_license_key')` and requires
`is_plugin_active('everest-forms-pro/everest-forms-pro.php')`.

The EDD *shape* is inferred from `EVF_Updater_Key_API::check/version` call sites
mirroring UR's `UR_Updater_Key_API` exactly — same vendor, same design. The store
host is **not** inferred: `everestforms.net` appears in the free plugin only as
marketing and documentation URLs, never as an API endpoint.

`license.mjs` refuses to act on the row until `store_url` is filled in, and
`check-all` reports it as `unknown` (exit 2), never as valid. An invented URL
would produce a licence layer that silently never activates anything, which is
the exact failure this whole design exists to make impossible.

---

## 2. Activation slots — why there is no reaper and no URL pinning

The keys in use are lifetime keys with unlimited activations, so the usual worry
(every Playground boot is a fresh site; CI exhausts the licence in a day) does
not apply. Two of the four products would have been exempt anyway:

**Freemius excludes localhost**, transcribed from the vendored SDK rather than
remembered — `FS_Site::is_localhost_by_address()`,
`freemius/includes/entities/class-fs-site.php:143`: `127.0.0.1`, `localhost`, and
hosts starting `local.`/`dev.`/`test.`/`stage.`/`staging.` or ending
`.local`/`.test`/`.dev`/`.staging`/`.example`/`.invalid`.

Playground serves on `127.0.0.1`, so **every Playground boot of ColorMag Pro or
Zakra Pro is a localhost install and consumes nothing.** This is why
`boot-wp.mjs` must not rewrite the site URL to something prettier: a mismatched
`WP_HOME` breaks every link in the site, and there is nothing to gain.

`WP_ENVIRONMENT_TYPE = "local"` is defined anyway, in both blueprints. It is not
required for activation; it keeps EDD's `site_count` from filling with thousands
of throwaway CI sites, and it is simply the truth about the environment. It is
**verified, not assumed** — the probe reports `wp_get_environment_type()` back
from inside the booted site and `boot-wp.mjs` warns if it is anything else.

**No reaper exists and none should be built.** It was only ever justified by
exhaustion risk, and a command that deactivates licences in bulk is a liability
sitting in the repo waiting to be pointed at the wrong key.

---

## 3. How it fits together

```
licenses.json          the registry. Structure tracked, keys NEVER.
  ↓  key from TGQA_LICENSE_<SLUG> (env, or a gitignored .env.local)
scripts/license.mjs    owns provider protocol. One line of JSON on stdout.
  ↓  writes tgqa-license.json (mode 0600) into a temp mu-plugins staging dir
scripts/boot-wp.mjs    --with-pro mounts pro; --license stages the seeder
  ↓  a blueprint step COPIES the staged files into wp-content/mu-plugins/
mu-plugins/tgqa-license.php   puts the licence where WordPress can see it
mu-plugins/tgqa-probe.php     reports what the site actually believes
  ↓  boot-wp.mjs reads the probe and prints `probe_url` in its handoff
scripts/run-suite.mjs --pro   verifies through that probe, or refuses to run
```

Two details that are load-bearing:

- **Config comes from a file, not from `wp-config` constants.** Constants there
  surface in `wp config list`, in Site Health, in debug dumps, and in any plugin
  that prints its environment. A 0600 file that only PHP reads does not.
- **The mu-plugins are copied, not mounted.** `wp-content/mu-plugins` already
  holds Playground's own must-use plugins, and mounting a host directory onto
  that path replaces them — a failure that presents as a broken Playground
  rather than as our mount.

### The gap we are knowingly accepting

Real keys cannot produce an **expired**, **invalid**, **disabled** or
`no_activations_left` state. Those are a genuine bug class — what a customer sees
when their licence lapses — and with real-keys-only they stay untested. Mocking
was decided against for now, but the seam is marked: see the
`pre_http_request` comment at the bottom of `mu-plugins/tgqa-license.php`. It
should be one added file, not a refactor.

---

## 4. Setup — the numbered steps nobody can guess

### 4.1 A dedicated QA key per product

**Not the company key.** One that can be revoked and reissued without disturbing
anything a customer or colleague depends on. This is the single cheapest risk
reduction available and it takes five minutes.

An unlimited lifetime key is the worst credential to leak: no activation cap
throttles an attacker, and revoking one means reissuing across every repo and
every developer machine simultaneously. On GitHub Free the key must also be
duplicated into every private repo's secret store, so the exposure surface is N
repos wide before anyone makes a mistake.

### 4.2 Locally

```sh
# In themegrill-qa, gitignored (verified: see .gitignore)
cat > plugins/themegrill-qa/.env.ci <<'EOF'
TGQA_LICENSE_COLORMAG_PRO=...
TGQA_LICENSE_ZAKRA_PRO=...
TGQA_LICENSE_USER_REGISTRATION_PRO=...
TGQA_LICENSE_EVEREST_FORMS_PRO=...
EOF

# Install the pre-commit guard in every repo that holds a key
node plugins/themegrill-qa/scripts/install-git-hook.mjs

# Confirm what we hold
node plugins/themegrill-qa/scripts/license.mjs check-all
```

Then, from inside a product checkout:

```sh
node <qa>/scripts/boot-wp.mjs --with-pro colormag-pro --license
node <qa>/scripts/run-suite.mjs --tier fresh --pro --boot
```

### 4.3 A GitHub App, because `GITHUB_TOKEN` cannot do this

`secrets.GITHUB_TOKEN` is scoped to the repository running the workflow and
**cannot check out a different private repository.** It fails with a 404 that
reads exactly like "no such repository", which is the single most time-wasting
error message in this whole setup.

1. Create an org-owned GitHub App. **Contents: read-only.** Nothing else — it has
   no reason to write anything, ever.
2. Install it on the **pro repos only**.
3. Put its id and private key in each calling repo as `TGQA_APP_ID` and
   `TGQA_APP_PRIVATE_KEY`.

### 4.4 Per-repository secrets, because org secrets do not reach private repos

GitHub's documentation is explicit: *"Organization-level secrets and variables
are not accessible by private repositories for GitHub Free."* Every secret must
therefore exist in every repository. Doing that by hand across four products
guarantees drift, and the drift shows up as a workflow that suddenly cannot
licence anything.

```sh
node plugins/themegrill-qa/scripts/sync-secrets.mjs --audit    # what is missing where
node plugins/themegrill-qa/scripts/sync-secrets.mjs --dry-run  # default; names only
node plugins/themegrill-qa/scripts/sync-secrets.mjs --confirm  # actually set them
```

Values go in over **stdin**, never argv — arguments appear in the process list.
`--dry-run` prints names and target repos and never a value, not even redacted.

### 4.5 Reusable-workflow access

**themegrill-qa → Settings → Actions → General → Access →
"Accessible from repositories in the ThemeGrill organization".**

Without it every caller fails with "workflow was not found", which reads like a
typo in the `uses:` path and is not. This is a setting, not a plan restriction —
reusable workflows in a private repo do work on Free.

### 4.6 Add the caller workflow

Copy `.github/workflows/examples/caller-pro-suite.yml` into the **pro** repo as
`.github/workflows/qa-pro.yml` and edit the four product fields.

---

## 5. CI, within 2,000 minutes/month

Private repos are metered on Free (public repos are unlimited), so the schedule
is tiered rather than running everything everywhere.

| Job | Trigger | Repo | Licence |
|---|---|---|---|
| Free suite | every PR | free repo (public — unlimited) | no |
| `free-with-pro` | every PR on the pro repo | pro repo | yes |
| `pro` | every PR on the pro repo | pro repo | yes |
| `unlicensed` | every PR on the pro repo | pro repo | **no, deliberately** |
| Full pro sweep | manual / pre-release | pro repo | yes |

Every job prints its elapsed minutes to the run summary, so consumption is
visible without opening the billing page. **Check consumption against the 2,000
after two weeks.** If pro CI is eating the allowance, move `pro` to
merge-to-main only — but keep `free-with-pro` on every PR, because it is the
only job that catches "installing pro broke a free feature".

`licence not active` is a distinct, **non-retryable** failure. A store outage is
then instantly distinguishable from a product bug, and retrying it just spends
more metered minutes reaching the same store.

---

## 6. Safety rules. Non-negotiable.

- **A dedicated QA key per product**, never the company key. See 4.1.
- **Never `pull_request_target` in any workflow that touches a licence.** It runs
  with secrets available against fork-supplied code — the textbook
  secret-exfiltration hole. Plain `pull_request` is correct: forks get no
  secrets.
- **Fork PRs skip with a stated reason**, do not fail, and never fall through to
  silently testing the free version. The gate job says which secret is missing
  and links the audit command.
- **No licence key in any tracked file** — not specs, configs, workflows,
  blueprints, fixtures or test names. `.env.local` and `.env.ci` are gitignored;
  `scan-secrets.mjs` refuses a commit that carries one and the same scan runs in
  CI, where it cannot be bypassed with `--no-verify`.
- **Keys are redacted in every log path, error paths included** — that is where
  keys actually leak, not on the happy path anyone reviewed. Every job that holds
  a key registers it with `::add-mask::` as its FIRST step, so an accidental
  `set -x` is scrubbed by the runner rather than by anyone's discipline.
- **The mu-plugins never enter a product repo.** `scan-secrets.mjs --zip` fails
  if `tgqa-` appears in a release artefact. A licence seeder shipped to a customer
  is a licence seeder pointed at a customer's site.
- **Never commit a `.freemius` directory or Freemius install state** — it holds
  install ids tied to the account. Gitignored and scanned for.
- **The GitHub App is Contents: read-only**, installed only on the pro repos.
