---
name: wp-coding-standards
description: >
  Mandatory WordPress coding standards for ThemeGrill plugins and themes: reuse
  existing helpers before writing new code, file/class/function naming, PHPDoc
  and comment limits, PHP 7.4 baseline (allowed and banned syntax), hooks, i18n,
  escaping and sanitization, DB access, template and child-theme rules. Also
  which repo to edit when a product syncs free and pro, the PHPCS gate (run
  PHPCS on the changed PHP files and report every violation before any commit,
  push, or PR), and how commits, changelog entries, and PR templates must be
  written. Use for any PHP work in a WordPress plugin or theme — new classes,
  functions, hooks, AJAX/REST handlers, templates, DB queries — before
  committing or pushing PHP, and when asked "is this WP standard", "fix coding
  standards", "run phpcs", "add docblocks", or "is there already a helper for
  this".
---

# WordPress coding standards

Applies to every ThemeGrill plugin and theme. Baseline: WPCS (`WordPress`
ruleset) + `PHPCompatibility` at `testVersion 7.4-`. Tabs for indent, UTF-8,
LF, no closing `?>` in PHP-only files.

Throughout, `prefix_` / `Prefix` / `text-domain` stand for the project's own
slug. Read the main plugin file header or `style.css` and use the real one —
and do not assume pro differs from free: ColorMag Pro declares
`Text Domain: colormag`, the same as the free theme.

## These rules are mandatory

When this skill is present, it governs every PHP line written or touched. Not a
style suggestion — a gate.

- Apply on every change, including one-line fixes and hotfixes. No "quick patch
  now, clean later".
- Never silence a sniff to make a file pass. `// phpcs:ignore` needs a one-line
  reason and applies to a single line, never a whole file.
- Repo config outranks this document. If `phpcs.xml`, `.editorconfig`, or a
  `CLAUDE.md` in the project says otherwise, follow the repo and say which rule
  differed.
- Surrounding code violating a rule is not permission to violate it. Write new
  code to standard, but do not mass-reformat untouched lines into an unrelated
  diff.
- A rule that cannot be met, met only partly, or that conflicts with a
  requirement: say so plainly in the response. Never skip it silently.
- The security section is exempt from every shortcut in this document.
- No commit, push, or PR before PHPCS runs clean on the changed files, with the
  result reported. See *PHPCS gate*.
- Check the repository layout before editing. A product that syncs free and pro
  takes the change in one repo only. See *Which repository does the change go
  in*.
- A repo PR template is filled in full, every section, exact headings. Commits
  and changelog entries stay to one line. See *Commits, changelog, and pull
  requests*.

## Reuse before you write

The best code is code that already exists. Before adding a line, walk this
ladder and stop at the first rung that holds:

1. **Does it need to exist?** Speculative option, unused filter, "we might need
   this later" method — skip it, say so in one line. Later can add it.
2. **Does WP core already do it?** Core is enormous and tested:
   `wp_parse_args`, `wp_list_pluck`, `wp_list_filter`, `absint`,
   `wp_json_encode`, `wp_remote_get`, `get_transient` / `set_transient`,
   `wp_schedule_event`, `WP_Query`, `WP_List_Table`, `WP_Error`, `wp_mail`,
   `add_settings_field`, `get_post_meta`, `wp_insert_post`, `human_time_diff`,
   `wp_kses_post`. Hand-rolled HTTP, cron, list tables, option pages, or array
   helpers are rejected on sight.
3. **Does this project already have it?** This is the rung that gets skipped and
   it is the most common defect in review. Find the helpers layer and read it
   before writing:
   - plugin: `core-functions.php` or `includes/core-functions.php`,
     `includes/prefix-core-functions.php`, `includes/Functions/CoreFunctions.php`,
     `includes/functions-*.php`, `includes/helpers.php`,
     `includes/class-*-helper.php`, `src/Helpers/`, `src/Traits/`
   - theme: `functions.php`, `inc/`, `includes/`, `template-functions.php`,
     `template-tags.php`. ColorMag's shape is `inc/` with `inc/core/`,
     `inc/customizer/`, `builder-template-tags.php` and `class-colormag-*.php`.
   - the file is named differently in every project — find it, do not guess:

   ```bash
   ls includes/*function* includes/*helper* inc/*function* inc/*template* src/Helpers 2>/dev/null
   ```

   `composer.json` `autoload.files` and the `require`s at the top of the main
   plugin file or `functions.php` also list them — that is the definitive answer
   for which function files load on every request.

   - then grep the helper layer and the service/repository classes together:

   ```bash
   grep -rn "function prefix_.*sanitize" includes/ inc/ src/
   ```

4. **Does an already-installed dependency solve it?** Check `composer.json` and
   `package.json`. ThemeGrill products already pull `themegrill/themegrill-sdk`
   — read it before writing anything that looks like SDK work. Never add a
   dependency for what ten lines do.
5. **Can it be one line?** Then one line.
6. **Only then** write the minimum code that works.

### Where new shared code goes

If the logic is needed in more than one place, it belongs in the existing
core-functions or helpers file — **extend that file, do not create a new one**.
A new file is justified only when no existing one covers the domain at all, and
then it copies that project's naming (`prefix-core-functions.php` next to
`prefix-order-functions.php`) and is loaded the same way the others are: added
to the same `require` block or to `autoload.files`.

- put it beside its neighbours: a formatting helper goes in the formatting
  helper file, not a fresh `utils.php`
- keep the same prefix, the same signature style, the same return shape as the
  helpers around it
- one purpose per function; if it needs a `$type` argument to switch behaviour,
  it is two functions
- global helper functions are wrapped so a child theme or another plugin can
  override them:

```php
if ( ! function_exists( 'prefix_get_order_total' ) ) {
	/**
	 * Get an order total in store currency.
	 *
	 * @since 1.4.0
	 *
	 * @param int $order_id Order post ID.
	 * @return float Total, 0.0 when the order is missing.
	 */
	function prefix_get_order_total( $order_id ) {
		return (float) get_post_meta( absint( $order_id ), '_prefix_total', true );
	}
}
```

### Corollaries

- A new DB table needs a real reason. Post meta, user meta, term meta, or an
  option covers most cases and comes with caching for free.
- No interface with one implementation, no factory for one product, no config
  constant for a value that never changes, no abstract class with one child.
- Fixing a bug: grep every caller first. One guard in the shared function beats
  a guard in each caller, and patching only the reported path leaves the sibling
  callers broken.
- Deleting beats adding. A refactor that removes more than it adds is probably
  right.

The ladder shortens the solution, never the reading — trace the real flow first,
then pick a rung. It never removes nonce checks, capability checks,
sanitization, escaping, error handling that prevents data loss, accessibility,
or anything explicitly asked for.

## Which repository does the change go in

Some ThemeGrill products ship as one repo. Others split free and pro into two
and sync shared files from free into pro. Never assume either shape — check,
then write to exactly one repo.

### Detect it first

```bash
ls .github/workflows/ 2>/dev/null && grep -rlniE "sync|repo-file-sync|repository_dispatch" .github/workflows/
```

A hit means read the workflow. **Do not assume a particular sync action.**
ColorMag Pro does not use `BetaHuhn/repo-file-sync-action`; it uses a
hand-rolled `sync-from-free.yml` that fires on a `repository_dispatch` of type
`free-theme-updated`, checks the listed paths out of the free repo, and opens a
`sync/free-<branch>-<timestamp>` PR against the matching pro branch.

**The path list usually lives in the FREE repo, not the one you are standing
in.** ColorMag Pro's workflow reads it with
`git show free/$BRANCH:.github/sync-file-list.yml`, so looking for that file
locally in the pro checkout finds nothing. Read it from the source:

```bash
git show origin/develop:.github/sync-file-list.yml    # in the FREE checkout
```

> **Known gap, ColorMag, verified 2026-08-31.** `.github/sync-file-list.yml` is
> absent from both `master` and `develop` in the free repo, and nothing there
> dispatches `free-theme-updated`. So the sync does not currently run. Until it
> does, treat the two repos as independent and say so — do not tell anyone a
> sync PR is coming when nothing will open one.

### Rules when a sync exists

Sync is one-directional. The source repo owns every path in that list; the
copies in the target repo are generated output.

- **File lives inside a synced path** — edit it in the **source repo only**.
  Editing the copy in the target repo loses the change on the next sync, or
  turns the sync PR into a conflict.
- **File exists only in the target repo** (pro-only feature, or an excluded
  path) — edit it in the **target repo only**.
- **Deciding between them:** look for the file in the source repo first. It
  exists there, that is where you edit. It does not, the file is target-owned.
- **Never apply the same change to both repos.** That is the single most common
  mistake with this setup: it produces a duplicate commit that collides with the
  sync PR.
- **New file inside a synced directory** — create it in the source repo. It
  reaches the target through sync, not through you.
- **New file that must stay target-only** — put it outside every synced path, or
  the next sync will overwrite or clobber it.
- A shared file that needs different behaviour per edition takes a runtime check
  or a hook in the shared code, not two divergent copies.
- After pushing to the trigger branch, the sync opens a PR on the target repo.
  Say so, and say it still needs review and merge — the change is not live on
  the target until then.

State which repo you wrote to, and why, in the response. If the file exists in
neither repo and the edition is genuinely ambiguous, ask before writing.

## PHP version: 7.4 minimum

Declare it and mean it: `Requires PHP: 7.4` in the plugin header or `style.css`,
and `"php": ">=7.4"` in `composer.json`. Anything above 7.4 is a fatal error on
supported hosts, so it is banned outright. (ColorMag and ColorMag Pro both
declare 7.4.)

Allowed (7.4 and earlier):

- typed properties: `protected string $table;`
- arrow functions: `fn( $x ) => $x->id`
- null coalescing assignment: `$args['id'] ??= 0;`
- spread in array literals, numeric literal separators (`1_000`)
- `?:`, `??`, nullable types `?int`, return types `void` / `iterable`

Banned (8.0+):

- union / intersection types (`int|string`), `mixed`, `never`
- constructor property promotion
- named arguments
- `match ( … )`
- nullsafe operator `?->`
- attributes `#[Foo]`
- `str_contains`, `str_starts_with`, `str_ends_with`, `array_is_list` — use
  `false !== strpos( … )`, `0 === strpos( … )`, `substr( … )`
- enums, `readonly`, first-class callable syntax `foo(...)`

Also assume no Composer autoloader in themes unless the theme ships one — themes
commonly `require` files from `functions.php` instead.

## Layout

Match whichever layout the project already uses. Do not introduce a second one.

**Procedural / classic WP layout:**

- file: `includes/class-prefix-form-handler.php`; abstract:
  `abstract-prefix-form.php`; functions: `includes/functions-prefix-core.php`
- class: `Prefix_Form_Handler` — prefix, underscores, capitalized words
- global function: `prefix_get_form_data()` — snake_case with prefix, wrapped in
  `function_exists`

**PSR-4 layout** (plugin `src/`, or a theme that ships an autoloader):

- file: `Admin/Services/CouponService.php` — StudlyCase, one class per file,
  filename identical to class name
- namespace mirrors the `composer.json` autoload map, e.g.
  `Prefix\Feature\Admin\Services`
- class `CouponService`, methods `snake_case()` — WP convention wins over PSR
- `use` imports at the top; no leading-slash FQCN inline

**Theme layout:**

- `functions.php` is a loader, not a codebase. It sets up theme support and
  `require`s from `inc/`. Anything past ~150 lines moves into `inc/`.
- template files follow the template hierarchy; shared markup goes through
  `get_template_part( 'template-parts/content', get_post_type() )`
- theme setup on `after_setup_theme`, assets on `wp_enqueue_scripts`
- child-theme safety: pluggable functions in `function_exists` wrappers, hooks
  over hard-coded markup
- **site functionality does not belong in a theme.** Post types, taxonomies,
  shortcodes, and business logic go in a plugin, so switching themes does not
  destroy the site.

Layering, where the project has services: controller / AJAX handler → service →
repository. No `$wpdb` and no raw SQL in a controller or service — queries live
in a repository.

## PHPDoc and comments

PHPDoc blocks: yes, on files, classes, methods, functions, and hooks. Prose: no.
A docblock is a signature summary, not an essay.

File header on every new file:

```php
<?php
/**
 * Coupon service.
 *
 * @package Prefix\Feature
 */
```

```php
/**
 * Apply a coupon to an order.
 *
 * @since 1.4.0
 *
 * @param string $coupon   Coupon code.
 * @param int    $order_id Order post ID.
 * @return array Response payload with status, message, data keys.
 */
public function apply( string $coupon, int $order_id ): array {
```

Docblock rules:

- summary is one line, ends with a period, says what it does — not how
- `@param` aligned in a column: type, name, description
- `@since` on new public API, actions, and filters — a real version number
- omit `@return void`; `@throws` required when the method throws
- no `@author`, no `@category` on new files
- no multi-paragraph description. If the behaviour truly needs three paragraphs,
  the method is doing too much — split it.

Inline comment rules:

- one line, maximum. No comment blocks inside a method body.
- explain *why*, never *what*. `// Gateway rounds half-up, WP rounds half-even.`
  earns its line. `// Loop through the orders.` does not.
- if the code needs a comment to be readable, rename the variable or extract a
  method first; keep the comment only if the *why* survives that
- allowed without argument: `// phpcs:ignore …` with a reason, `// TODO:` with a
  ticket ID
- commented-out code is deleted, not shipped. Git remembers it.

Hook docblocks are mandatory — a hook is public contract:

```php
/**
 * Filters the cart total before checkout.
 *
 * @since 1.4.0
 *
 * @param float $total    Total in store currency.
 * @param int   $order_id Order post ID.
 */
$total = apply_filters( 'prefix_checkout_total', $total, $order_id );
```

## Naming

| Thing | Form | Example |
| --- | --- | --- |
| Function | `prefix_snake_case` | `prefix_get_form_data()` |
| Method | `snake_case` | `set_coupon_response()` |
| Property / variable | `$snake_case` | `$order_id` |
| Constant | `PREFIX_UPPER` | `PREFIX_PLUGIN_FILE` |
| Hook | `prefix_object_event` | `prefix_order_created` |
| Option / meta | `prefix_key`, private meta `_prefix_key` | `prefix_settings` |
| DB table | `{$wpdb->prefix}prefix_thing` | `wp_prefix_orders` |
| CSS class | `prefix-block__element` | `prefix-card__title` |

Every global symbol carries the prefix, no exceptions — a plugin or theme shares
one PHP namespace with forty others.

## Syntax conventions

- `array()` for construction, not `[]`; short syntax only in files that already
  use it. Index access is `$a['k']` always.
- Yoda conditions against a literal: `if ( 'draft' === $status )`
- strict comparison by default: `===`, `!==`, `in_array( $x, $y, true )`
- spaces inside parens and brackets: `foo( $bar['baz'] )`
- one blank line between methods; no blank line after an opening `{`
- early return over nested `if`; no `else` after a `return`
- align `=` across consecutive assignments — WPCS enforces this and it is the
  most frequent auto-fixable violation:

```php
$order_id = 0;
$title    = '';
$status   = 'draft';
```

- one file holds function declarations **or** one OO structure, never both
  (`Universal.Files.SeparateFunctionsFromOO`). Helpers go in the core-functions
  file, classes go in their own file.
- a class file is named after its class: `class-prefix-coupon-service.php` for
  `Prefix_Coupon_Service` (`WordPress.Files.FileName`)

## Security — no shortcuts, ever

Every entry point does all four, in this order:

```php
public function ajax_save() {
	check_ajax_referer( 'prefix_save', 'security' );

	if ( ! current_user_can( 'manage_options' ) ) {
		wp_send_json_error(
			array( 'message' => __( 'Permission denied.', 'text-domain' ) ),
			403
		);
	}

	$order_id = isset( $_POST['order_id'] )
		? absint( wp_unslash( $_POST['order_id'] ) )
		: 0;
	$title    = isset( $_POST['title'] )
		? sanitize_text_field( wp_unslash( $_POST['title'] ) )
		: '';

	wp_send_json_success( array( 'title' => esc_html( $title ) ) );
}
```

1. **Nonce** — `check_ajax_referer()`, `check_admin_referer()`, or
   `wp_verify_nonce()`; `wp_nonce_field()` in the form. REST routes use a real
   `permission_callback`, never `__return_true` on a writing route.
2. **Capability** — a specific capability. Never `is_admin()` (it only tests
   which screen is loading) and never `is_user_logged_in()` alone.
3. **Sanitize on input** — `absint`, `sanitize_text_field`, `sanitize_email`,
   `sanitize_key`, `esc_url_raw`, `wp_kses_post`. `wp_unslash` first on `$_POST`
   / `$_GET` / `$_REQUEST`.
4. **Escape on output, at the point of output** — `esc_html`, `esc_attr`,
   `esc_url`, `esc_textarea`, `wp_kses_post`. Never "escape once upstream and
   trust it downstream". This includes every echo in a template file.

SQL is always prepared, and identifiers are never interpolated from input:

```php
$results = $wpdb->get_results(
	$wpdb->prepare(
		"SELECT * FROM {$wpdb->prefix}prefix_orders WHERE user_id = %d AND status = %s",
		$user_id,
		$status
	)
);
```

`%i` for identifiers requires WP 6.2+. Below that, match a column or table name
against a hardcoded allowlist before interpolating it.

Every direct query trips two WPCS warnings,
`WordPress.DB.DirectDatabaseQuery.DirectQuery` and `.NoCaching`. Clear them
honestly — cache the result, do not silence the sniff:

```php
$results = wp_cache_get( $cache_key, 'prefix_orders' );

if ( false === $results ) {
	$results = $wpdb->get_results( $wpdb->prepare( … ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery -- Custom table, result cached below.
	wp_cache_set( $cache_key, $results, 'prefix_orders' );
}
```

Invalidate the cache in the same class that writes the table.

i18n takes literal strings only:

- `__( 'Coupon required.', 'text-domain' )`
- never `__( $message, … )` or `esc_html__( $message, … )` — a variable defeats
  string extraction, so the string never reaches a translator
- interpolate with `sprintf( __( 'Order %d failed.', 'text-domain' ), $id )`
- plurals with `_n()`, context with `_x()`, escaped variants (`esc_html__`,
  `esc_attr_e`) at output points
- text domain is the product's own slug from its header, hardcoded, never a
  constant or variable — and a pro edition often shares the free one, so read
  the header rather than appending `-pro`

File and capability hygiene: `ABSPATH` guard at the top of every directly
reachable PHP file, `wp_verify_nonce` before any state change, and no
`extract()`, `eval()`, or unserializing untrusted input.

## Hooks

- register in one `init_hooks()` on the bootstrap class, or one block in
  `functions.php` / `inc/` for themes; one hook per line
- `add_action( 'init', array( $this, 'register_post_types' ) );`
- state priority explicitly only when it is not 10; state `$accepted_args` when
  it is not 1
- never fire a filter without a computed default value to pass in
- anonymous closures on hooks only when nothing needs to unhook them
- new extension points get a docblock and a readme entry

## Enqueue

Version every asset from the version constant or theme version, never a typed
string, and never `filemtime()` in production:

```php
wp_enqueue_script(
	'prefix-checkout',
	PREFIX_PLUGIN_URL . '/assets/js/checkout.js',
	array( 'jquery' ),
	PREFIX_VERSION,
	true
);
```

Themes use `get_stylesheet_directory_uri()` for child-overridable assets and
`get_template_directory_uri()` for parent-owned ones. Never hardcode
`/wp-content/`. Pass data with `wp_localize_script()` or
`wp_add_inline_script()`, not inline `<script>` in a template.

## PHPCS gate: run it before commit, push, or handoff

Never commit, push, or open a PR with PHP that has not been through PHPCS. This
is the last mandatory step of every PHP change.

**Use the project's own script when it defines one.** ThemeGrill products define
`phpcs` and `phpcbf` in `composer.json` and get their ruleset from
`wpeverest/wpeverest-sniffs`, not from a `phpcs.xml` in the repo — ColorMag and
ColorMag Pro ship no `phpcs.xml` at all. Running `--standard=WordPress` there
checks a **different ruleset than CI and the pre-commit hook use**, so a clean
local run would mean nothing. Check first:

```bash
grep -A3 '"phpcs"' composer.json ; ls phpcs.xml phpcs.xml.dist 2>/dev/null
```

Fix formatting first — `phpcbf` handles alignment, whitespace, and array syntax
on its own:

```bash
composer phpcbf -- $(git diff --name-only --diff-filter=ACMR HEAD -- '*.php')
```

Then check what is left. Only changed files, never the whole repo — a repo-wide
run buries the new violations in pre-existing ones:

```bash
composer phpcs -- $(git diff --name-only --diff-filter=ACMR HEAD -- '*.php')
```

Staged-only, when a commit is already prepared:

```bash
composer phpcs -- $(git diff --cached --name-only --diff-filter=ACMR -- '*.php')
```

No composer script and no ruleset in the project? Say which ruleset you fell
back to, because the answer is then only as good as the guess:

```bash
vendor/bin/phpcs --standard=WordPress --runtime-set testVersion 7.4- path/to/file.php
```

PHPCS not installed? Say so and stop — do not claim the code is clean:

```bash
composer install    # the dev dependencies carry it
```

### Reporting the result

Report the PHPCS outcome in the response, every time, before the user pushes:

- **Clean** — say so, with the file count checked and the ruleset used.
- **Violations in code from this change** — list them as
  `file:line — sniff — message`, quoting the sniff name so the user can judge
  it, then fix them and re-run. Do not push until the re-run is clean.
- **Violations in lines this change did not touch** — say they are pre-existing
  and leave them alone. Never mix an unrelated cleanup into the diff.
- **Warnings that cannot be cleared** (direct DB call, a required
  `phpcs:ignore`) — name each one and the reason it stands, so the user approves
  it rather than discovering it in CI.

Errors block a push. Warnings need a stated reason. "It only warns" is not a
reason.

Many projects run the same sniff in CI on pull requests, scoped to the PHP files
the PR changed. Check `.github/workflows/` — matching that job's ruleset and
file scope locally means the PR comes back green instead of costing a round
trip.

Last pass on the diff: cut every added line no caller needs, every helper that
duplicates a core or project function, every comment restating the code. Ship
the shortest version that still passes.

## Commits, changelog, and pull requests

Commits and changelog entries: short, one line each. PR description and test
steps: as detailed as the change deserves. Those are the two settings, and they
do not swap.

### Commits

One subject line. No body, no bullet list, no paragraph explaining the approach.

- match the repo's existing format — read it before writing one:

```bash
git log --oneline -20
```

- most WordPress projects use a ticket ID plus a type and a phrase:
  `TICKET-123 Fix - Profile picture wiped when saving without the addon active`
- imperative or noun phrase, under ~72 characters, no trailing period
- one logical change per commit; a version bump is its own commit
- never `git commit --no-verify`; a failing hook is a real failure

### Changelog

**Open the changelog file and copy the surrounding lines exactly** — the type
labels, the column padding, and the date format are per-project and PHPCS will
not catch a mismatch. The label vocabulary is not universal: ColorMag's
`changelog.txt` uses `Added` / `Tweak` / `Fix` with an ISO date, like this —

```
= Version 4.2.2 - 2026-08-18 =
* Added    - Typography control for the header builder Button element.
* Tweak    - Minor visual refinements to the Customizer's UI framework.
* Fix      - Search icon clipped when a custom icon size was set.
```

— while other products use `Fix` / `Enhance` / `Feature` / `Dev` and a
`dd/mm/yyyy` date. Read the file; do not carry a format across products.

- one line per change, one sentence, 10 to 15 words, ends with a period
- name the user-visible symptom, not the internal fix: "Fatal error on
  registration when form data is null", not "added null check in
  `prefix_handle_form()`"
- no file names, no class names, no ticket IDs in the entry
- internal refactors that change nothing for the user get no entry
- keep the existing label vocabulary and its alignment; do not invent a label

### Pull requests

If the repo has a template, it is mandatory — not a starting point.

```bash
cat .github/PULL_REQUEST_TEMPLATE.md 2>/dev/null || ls .github/PULL_REQUEST_TEMPLATE/ 2>/dev/null
```

- fill **every** section the template defines, in the template's order, with its
  exact headings. Do not drop sections, reorder them, or add your own.
- tick the checkboxes that are genuinely true, `[x]`. Leave the rest unticked
  rather than ticking them to look complete, and say in the PR why one is
  unticked.
- link the issue in the field the template provides (`Closes #123`)
- **Changes proposed** is the one place to be thorough. Go into detail: what was
  wrong, what the change does, why this approach over the alternative, any
  migration or backward-compatibility note, anything a reviewer would otherwise
  have to reconstruct from the diff. The brevity rule covers commits and
  changelog entries — it does not apply here.
- **How to test** is equally detailed: numbered, concrete steps a reviewer can
  follow without reading the diff. Preconditions first (settings to enable,
  addon active or not, user role, plan state), then each action, then the
  expected result after each one. Cover the failure path and the edge case the
  bug came from, not only the happy path. Note anything that needs a fresh
  install, a cron run, or a cache flush.
- tick exactly one type-of-change box
- the template's **Changelog entry** field at the bottom is filled in the
  changelog file's own format, not free prose:

  ```
  Fix - Duplicate approval email sent after email confirmation.
  ```

  - one entry for the whole PR, prefixed with the same label the changelog file
    uses — pick the one matching the type-of-change box ticked above
  - **10 to 15 words, hard limit.** Over that, it is a description, not a
    changelog entry. Cut the how, keep the what.
  - summarizes the whole PR in one sentence, even when the PR touches six files.
    Two entries only when the PR genuinely ships two unrelated user-visible
    changes — and that usually means it should be two PRs.
  - user-visible symptom, no file names, no class names, no ticket ID
  - it is copied verbatim into the changelog file at release, so it reads as a
    release note, not as a note to the reviewer
- **no template in the repo?** Neither ColorMag nor ColorMag Pro has one today,
  so this is the common case. Then: a short title, a detailed what-and-why
  section, numbered test steps, a linked issue, and a one-line changelog entry
  at the bottom in the same 10-to-15-word form.
- PHPCS result goes in the PR before a reviewer has to ask — see the gate above
- on a split free/pro product, say which repo the PR targets and whether a sync
  PR follows

Screenshots or a short clip for anything visual. Never paste a wall of log
output into a PR body; attach it or quote the decisive lines.

## How this reaches a project

This skill ships inside the **claudegrill** plugin, so every developer has it in
every repo with no per-project install and no copying. It loads when the work is
PHP in a WordPress plugin or theme, and `/claudegrill:write-fix` invokes it
explicitly.

A project that wants it loaded on **every** session, not only when it matches,
adds one line to its own `CLAUDE.md`:

```markdown
All PHP follows the `wp-coding-standards` skill from the claudegrill plugin. Read it before writing or reviewing PHP.
```
