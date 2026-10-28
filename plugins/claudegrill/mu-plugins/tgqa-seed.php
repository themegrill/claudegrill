<?php
/**
 * Put a site into a named state over HTTP, on any engine: options and cron.
 *
 * Why this exists
 * ---------------
 * Some of a product's behaviour only happens in a state a click cannot reach: a
 * gateway configured in test mode with a webhook secret, a renewal that is due
 * today, a retry job that runs once a day. A spec for it has two jobs mixed
 * together — getting the site INTO that state, and asserting what the product
 * then does. Only the second is the point. Without a way to do the first, the
 * spec cannot be written, and a PR touching that code has nothing to point at
 * but the `qa-waived` label.
 *
 * Playground has no shell and no real cron, so `wp option update` and
 * `wp cron event run` are not available there. HTTP is the one channel every
 * engine has, which is the same reason `tgqa-theme-mod.php` exists. This file is
 * its generalisation: any option, and a named cron hook run synchronously.
 *
 * Contract
 * --------
 *   GET  /?tgqa_seed=<token>&op=options&keys=a,b -> {"options":{"a":…,"b":"__tgqa_absent__"}}
 *   POST /?tgqa_seed=<token>&op=options  body: JSON object
 *                                                -> {"previous":{…},"applied":[…]}
 *   POST /?tgqa_seed=<token>&op=cron     body: {"hook":"…","args":[…]}
 *                                                -> {"hook":…,"callbacks":n,"ran":true,…}
 *
 * `previous` tells "was absent" from "was null" with a sentinel, so a restore puts
 * the site back exactly as found. Posting the sentinel as a value DELETES the
 * option, which is what makes the restore exact: `get_option()` returns its
 * default only when the row is missing.
 *
 * What it refuses, and why
 * ------------------------
 * - A hook that is not a scheduled cron event, or that has no callback: running
 *   an `init` or `wp_login` hook through here is not a cron test, and a hook with
 *   nothing attached "runs" successfully while exercising nothing — a green that
 *   means nothing.
 * - The options that would take the site away from the harness (`siteurl`,
 *   `home`, `active_plugins`, `template`, `stylesheet`).
 *
 * Runs on `wp_loaded`, late, so the product has already registered its cron
 * handlers and scheduled its events. At `init` priority 1 a product that
 * schedules on `init` would not yet look scheduled.
 *
 * @package claudegrill
 */

defined( 'ABSPATH' ) || exit;

const TGQA_SEED_ABSENT = '__tgqa_absent__';

add_action( 'wp_loaded', 'tgqa_seed_maybe_respond', 999 );

/**
 * Answer `?tgqa_seed=<token>` and stop.
 *
 * @return void
 */
function tgqa_seed_maybe_respond() {
	if ( ! isset( $_GET['tgqa_seed'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		return;
	}

	$expected = tgqa_seed_token();
	$given    = sanitize_text_field( wp_unslash( $_GET['tgqa_seed'] ) ); // phpcs:ignore WordPress.Security.NonceVerification.Recommended

	// A constant-time compare, and a refusal when no token was staged at all —
	// an empty expected token must never match an empty supplied one.
	if ( '' === $expected || ! hash_equals( $expected, $given ) ) {
		tgqa_seed_fail( 403, 'bad seed token' );
	}

	$op     = isset( $_GET['op'] ) ? sanitize_key( wp_unslash( $_GET['op'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
	$method = isset( $_SERVER['REQUEST_METHOD'] ) ? $_SERVER['REQUEST_METHOD'] : 'GET';

	if ( 'options' === $op ) {
		'POST' === $method ? tgqa_seed_options_write() : tgqa_seed_options_read();
	}

	if ( 'cron' === $op ) {
		'POST' === $method ? tgqa_seed_cron_run() : tgqa_seed_fail( 405, 'cron takes POST' );
	}

	tgqa_seed_fail( 400, 'unknown op — expected options or cron' );
}

/** The staged token. Shared with tgqa-probe.php so one install covers every endpoint. */
function tgqa_seed_token() {
	if ( function_exists( 'tgqa_probe_token' ) ) {
		return tgqa_probe_token();
	}
	$file = __DIR__ . '/tgqa-probe.token';

	return is_readable( $file ) ? trim( (string) file_get_contents( $file ) ) : ''; // phpcs:ignore WordPress.WP.AlternativeFunctions
}

/**
 * End the request with an error body.
 *
 * @param int    $status  HTTP status.
 * @param string $message What went wrong.
 * @return void
 */
function tgqa_seed_fail( $status, $message ) {
	status_header( $status );
	wp_send_json( array( 'error' => $message ), $status );
}

/**
 * The decoded JSON body, or a 400.
 *
 * @return array
 */
function tgqa_seed_body() {
	$in = json_decode( (string) file_get_contents( 'php://input' ), true ); // phpcs:ignore WordPress.WP.AlternativeFunctions
	if ( ! is_array( $in ) ) {
		tgqa_seed_fail( 400, 'body must be a JSON object' );
	}

	return $in;
}

/**
 * Report the named options. Naming none is refused: dumping `wp_options` is not
 * a thing a spec needs, and it would put every secret on the site in a log.
 *
 * @return void
 */
function tgqa_seed_options_read() {
	$raw  = isset( $_GET['keys'] ) ? sanitize_text_field( wp_unslash( $_GET['keys'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
	$keys = array_filter( array_map( 'trim', explode( ',', $raw ) ) );

	if ( empty( $keys ) ) {
		tgqa_seed_fail( 400, 'name the options to read with keys=a,b' );
	}

	$options = array();
	foreach ( $keys as $k ) {
		$options[ $k ] = get_option( $k, TGQA_SEED_ABSENT );
	}

	wp_send_json( array( 'options' => $options ) );
}

/**
 * Apply the posted options, answering with what was there before.
 *
 * @return void
 */
function tgqa_seed_options_write() {
	$in       = tgqa_seed_body();
	$denied   = array( 'siteurl', 'home', 'active_plugins', 'template', 'stylesheet' );
	$previous = array();

	foreach ( array_keys( $in ) as $key ) {
		if ( in_array( (string) $key, $denied, true ) ) {
			tgqa_seed_fail( 403, "option {$key} is not seedable — it would take the site away from the harness" );
		}
	}

	foreach ( $in as $key => $value ) {
		$key              = (string) $key;
		$previous[ $key ] = get_option( $key, TGQA_SEED_ABSENT );

		if ( TGQA_SEED_ABSENT === $value ) {
			delete_option( $key );
			continue;
		}
		update_option( $key, $value );
	}

	wp_send_json(
		array(
			'previous' => $previous,
			'applied'  => array_keys( $in ),
		)
	);
}

/**
 * Run one scheduled cron hook now, in this request.
 *
 * Reports how many callbacks it ran and whether any threw, rather than only that
 * the request came back: the caller needs to tell "the handler ran and did
 * nothing" from "nothing was attached".
 *
 * @return void
 */
function tgqa_seed_cron_run() {
	$in   = tgqa_seed_body();
	$hook = isset( $in['hook'] ) ? (string) $in['hook'] : '';
	$args = isset( $in['args'] ) && is_array( $in['args'] ) ? array_values( $in['args'] ) : array();

	if ( '' === $hook ) {
		tgqa_seed_fail( 400, 'body needs {"hook":"…"}' );
	}

	$scheduled = false;
	foreach ( (array) _get_cron_array() as $events ) {
		if ( isset( $events[ $hook ] ) ) {
			$scheduled = true;
			break;
		}
	}
	if ( ! $scheduled ) {
		tgqa_seed_fail( 409, "{$hook} is not a scheduled cron event on this site — is the product active, and its module enabled?" );
	}

	$callbacks = 0;
	if ( isset( $GLOBALS['wp_filter'][ $hook ] ) ) {
		foreach ( $GLOBALS['wp_filter'][ $hook ]->callbacks as $at_priority ) {
			$callbacks += count( $at_priority );
		}
	}
	if ( 0 === $callbacks ) {
		tgqa_seed_fail( 409, "{$hook} is scheduled but has no callback attached, so running it would test nothing" );
	}

	$errors = array();
	$start  = microtime( true );
	ob_start();
	try {
		do_action_ref_array( $hook, $args );
	} catch ( \Throwable $e ) {
		$errors[] = get_class( $e ) . ': ' . $e->getMessage();
	}
	$output = (string) ob_get_clean();

	wp_send_json(
		array(
			'hook'        => $hook,
			'callbacks'   => $callbacks,
			'ran'         => empty( $errors ),
			'errors'      => $errors,
			'output'      => substr( $output, 0, 2000 ),
			'duration_ms' => (int) round( ( microtime( true ) - $start ) * 1000 ),
		)
	);
}
