/**
 * Tagged fixtures with a teardown that actually removes everything.
 *
 * Every row created here carries FIXTURE_META, so `cleanupFixtures` can remove
 * exactly what the suite made without guessing and without resetting the whole
 * site. That matters because untagged fixtures leak between specs: a spec that
 * picks "the first published post" behaves differently depending on what an
 * earlier spec left behind, which is how a suite comes to pass alone and fail in
 * sequence.
 */

const { evalPhp, php } = require("./wp-cli");

const FIXTURE_META = "_tgqa_fixture";

/**
 * Creates a published post, optionally in a category.
 *
 * @param {Object} requestUtils Playwright request utils.
 * @param {Object} attrs        {title, content, category, type, status}
 * @return {Promise<number>} Post id.
 */
async function createPost(requestUtils, attrs = {}) {
	const {
		title = "QA fixture post",
		content = "<!-- wp:paragraph --><p>Fixture body.</p><!-- /wp:paragraph -->",
		category = null,
		type = "post",
		status = "publish",
	} = attrs;

	const out = await evalPhp(
		requestUtils,
		`
		$id = wp_insert_post( array(
			'post_title'   => '${php(title)}',
			'post_content' => '${php(content)}',
			'post_type'    => '${php(type)}',
			'post_status'  => '${php(status)}',
		) );
		if ( is_wp_error( $id ) || ! $id ) { echo '0'; return; }
		update_post_meta( $id, '${FIXTURE_META}', '1' );
		${category ? `
		$term = term_exists( '${php(category)}', 'category' );
		if ( ! $term ) { $term = wp_insert_term( '${php(category)}', 'category' ); }
		if ( ! is_wp_error( $term ) ) {
			wp_set_post_categories( $id, array( (int) $term['term_id'] ) );
			update_term_meta( (int) $term['term_id'], '${FIXTURE_META}', '1' );
		}` : ""}
		echo $id;
		`,
	);

	const id = Number(out);

	if (!id) {
		throw new Error(`createPost failed for "${title}" — CLI returned: ${out}`);
	}

	return id;
}

/**
 * Creates a user with a role. Idempotent: returns the existing id if present, so
 * a spec re-run against a dirty site does not fail on "username exists".
 *
 * @param {Object} requestUtils Playwright request utils.
 * @param {string} login        Username.
 * @param {string} role        Role slug. Falls back to subscriber if the role
 *                              does not exist (a pro-only role on a free build).
 * @param {string} password     Password.
 * @return {Promise<number>} User id.
 */
async function createUser(requestUtils, login, role = "subscriber", password = "Password123!") {
	const out = await evalPhp(
		requestUtils,
		`
		$existing = get_user_by( 'login', '${php(login)}' );
		if ( $existing ) { echo $existing->ID; return; }
		$id = wp_create_user( '${php(login)}', '${php(password)}', '${php(login)}@example.test' );
		if ( is_wp_error( $id ) ) { echo '0'; return; }
		$u = new WP_User( $id );
		$u->set_role( get_role( '${php(role)}' ) ? '${php(role)}' : 'subscriber' );
		update_user_meta( $id, '${FIXTURE_META}', '1' );
		echo $id;
		`,
	);

	const id = Number(out);

	if (!id) {
		throw new Error(`createUser failed for "${login}" — CLI returned: ${out}`);
	}

	return id;
}

/**
 * Logs in as a fixture user by driving the login form.
 *
 * Deliberately the real form rather than a cookie injection: this is the one
 * place where using the actual flow costs nothing and catches login regressions
 * for free.
 *
 * @param {Object} page  Playwright page.
 * @param {string} login Username.
 * @param {string} password Password.
 * @return {Promise<void>}
 */
async function loginAs(page, login, password = "Password123!") {
	await page.goto("/wp-login.php?loggedout=true");
	await page.fill("#user_login", login);
	await page.fill("#user_pass", password);
	await page.click("#wp-submit");
	await page.waitForLoadState("domcontentloaded");
}

/**
 * Removes everything the suite created.
 *
 * Order matters: custom child tables before their parents, then posts, terms and
 * users. A teardown that misses one table leaves orphan rows that a later count
 * assertion trips over — which presents as a flaky test, not as a dirty database.
 *
 * @param {Object}   requestUtils Playwright request utils.
 * @param {string[]} tables       Unprefixed custom table names, children first.
 * @return {Promise<Object>} Counts of what was removed.
 */
async function cleanupFixtures(requestUtils, tables = []) {
	const truncates = tables
		.map(
			(t) =>
				`$wpdb->query( "DELETE FROM {$wpdb->prefix}${t.replace(/[^a-z0-9_]/gi, "")}" );`,
		)
		.join(" ");

	const out = await evalPhp(
		requestUtils,
		`
		global $wpdb;
		${truncates}

		$removed = array( 'posts' => 0, 'users' => 0, 'terms' => 0 );

		$posts = get_posts( array(
			'post_type'   => 'any',
			'post_status' => 'any',
			'numberposts' => -1,
			'fields'      => 'ids',
			'meta_key'    => '${FIXTURE_META}',
		) );
		foreach ( $posts as $id ) { wp_delete_post( $id, true ); ++$removed['posts']; }

		$users = get_users( array( 'meta_key' => '${FIXTURE_META}', 'fields' => 'ID' ) );
		if ( $users ) { require_once ABSPATH . 'wp-admin/includes/user.php'; }
		foreach ( $users as $id ) { wp_delete_user( $id ); ++$removed['users']; }

		$terms = get_terms( array(
			'taxonomy'   => 'category',
			'hide_empty' => false,
			'fields'     => 'ids',
			'meta_query' => array( array( 'key' => '${FIXTURE_META}' ) ),
		) );
		if ( ! is_wp_error( $terms ) ) {
			foreach ( $terms as $id ) { wp_delete_term( $id, 'category' ); ++$removed['terms']; }
		}

		echo wp_json_encode( $removed );
		`,
	);

	try {
		return JSON.parse(out);
	} catch {
		throw new Error(`cleanupFixtures did not report cleanly — CLI returned: ${out}`);
	}
}

module.exports = {
	FIXTURE_META,
	createPost,
	createUser,
	loginAs,
	cleanupFixtures,
};
