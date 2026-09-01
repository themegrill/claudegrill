<?php
/**
 * Read, set and restore theme mods over HTTP, on any engine.
 *
 * Why this exists
 * ---------------
 * A Customizer spec has two jobs mixed together: getting a setting APPLIED, and
 * asserting what the front end then renders. Only the second is usually the
 * point — `grid-columns.spec.ts` cares that four columns render four across, not
 * that the Customizer's React app can save. But applying it through the UI costs
 * a full Customizer load plus a publish round trip, and the fixture pays that
 * TWICE per test because teardown re-opens and republishes to restore. On
 * PHP-WASM that is most of a minute per test, and it is why ColorMag Pro's pro
 * tier needs ~14 minutes for work worth seconds.
 *
 * ColorMag free solves the same problem by shelling out to a `mysql` client to
 * snapshot and restore `theme_mods_<stylesheet>`. That cannot work on a
 * Playground runner — PHP-WASM on SQLite, no mysql binary — which is exactly why
 * pro's fixture went through the Customizer instead. HTTP is the one channel
 * every engine has, so this endpoint gives the fast path back without giving up
 * Playground.
 *
 * It does NOT replace Customizer specs. A spec whose subject IS the Customizer —
 * the `*-three-way` ones, asserting control, preview and front end agree — must
 * keep driving the UI, because that round trip is the thing under test.
 *
 * Contract
 * --------
 *   GET  /?tgqa_theme_mod=<token>&keys=a,b     -> {"mods":{"a":…,"b":…}}
 *   POST /?tgqa_theme_mod=<token>  body: JSON  -> {"previous":{…}} then applied
 *
 * `previous` distinguishes "was absent" from "was null" with a sentinel, so a
 * restore puts the site back exactly as found rather than leaving a row behind
 * that `get_theme_mod()` would then return instead of its default.
 *
 * @package claudegrill
 */

defined( 'ABSPATH' ) || exit;

const TGQA_MOD_ABSENT = '__tgqa_absent__';

add_action( 'init', 'tgqa_theme_mod_maybe_respond', 1 );

/**
 * Answer `?tgqa_theme_mod=<token>` and stop.
 *
 * @return void
 */
function tgqa_theme_mod_maybe_respond() {
	if ( ! isset( $_GET['tgqa_theme_mod'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		return;
	}

	$expected = tgqa_theme_mod_token();
	$given    = sanitize_text_field( wp_unslash( $_GET['tgqa_theme_mod'] ) ); // phpcs:ignore WordPress.Security.NonceVerification.Recommended

	// A constant-time compare, and a refusal when no token was staged at all —
	// an empty expected token must never match an empty supplied one.
	if ( '' === $expected || ! hash_equals( $expected, $given ) ) {
		status_header( 403 );
		wp_send_json( array( 'error' => 'bad theme-mod token' ), 403 );
	}

	if ( 'POST' === ( isset( $_SERVER['REQUEST_METHOD'] ) ? $_SERVER['REQUEST_METHOD'] : 'GET' ) ) {
		tgqa_theme_mod_write();
	}

	tgqa_theme_mod_read();
}

/** The staged token. Shared with tgqa-probe.php so one install covers both. */
function tgqa_theme_mod_token() {
	if ( function_exists( 'tgqa_probe_token' ) ) {
		return tgqa_probe_token();
	}
	$file = __DIR__ . '/tgqa-probe.token';

	return is_readable( $file ) ? trim( (string) file_get_contents( $file ) ) : ''; // phpcs:ignore WordPress.WP.AlternativeFunctions
}

/**
 * Report the requested mods, or every mod when none are named.
 *
 * @return void
 */
function tgqa_theme_mod_read() {
	$keys = array();
	if ( isset( $_GET['keys'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$raw  = sanitize_text_field( wp_unslash( $_GET['keys'] ) ); // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$keys = array_filter( array_map( 'trim', explode( ',', $raw ) ) );
	}

	$all  = (array) get_theme_mods();
	$mods = array();

	if ( empty( $keys ) ) {
		$mods = $all;
	} else {
		foreach ( $keys as $k ) {
			$mods[ $k ] = array_key_exists( $k, $all ) ? $all[ $k ] : TGQA_MOD_ABSENT;
		}
	}

	wp_send_json(
		array(
			'stylesheet' => get_stylesheet(),
			'mods'       => $mods,
		)
	);
}

/**
 * Apply the posted mods, answering with what was there before.
 *
 * A value equal to the absent sentinel REMOVES the mod, which is what makes an
 * exact restore possible: putting a key back as null is not the same as never
 * having had it, because `get_theme_mod()` returns its default only when the key
 * is missing.
 *
 * @return void
 */
function tgqa_theme_mod_write() {
	$body = file_get_contents( 'php://input' ); // phpcs:ignore WordPress.WP.AlternativeFunctions
	$in   = json_decode( (string) $body, true );

	if ( ! is_array( $in ) ) {
		status_header( 400 );
		wp_send_json( array( 'error' => 'body must be a JSON object of mod => value' ), 400 );
	}

	$all      = (array) get_theme_mods();
	$previous = array();

	foreach ( $in as $key => $value ) {
		$key              = (string) $key;
		$previous[ $key ] = array_key_exists( $key, $all ) ? $all[ $key ] : TGQA_MOD_ABSENT;

		if ( TGQA_MOD_ABSENT === $value ) {
			remove_theme_mod( $key );
			continue;
		}
		set_theme_mod( $key, $value );
	}

	wp_send_json(
		array(
			'stylesheet' => get_stylesheet(),
			'previous'   => $previous,
			'applied'    => array_keys( $in ),
		)
	);
}
