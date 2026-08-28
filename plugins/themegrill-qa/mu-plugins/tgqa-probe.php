<?php
/**
 * Plugin Name: ThemeGrill QA — probe
 * Description: A single endpoint reporting what the booted site actually believes.
 *
 * QA-ONLY, LIKE ITS SIBLING. Mounted into a disposable site by `boot-wp.mjs`;
 * never present in a product repository, never in a release zip.
 *
 * Why this exists: every fact this platform reports about a booted site was
 * previously an assumption. "The blueprint defined WP_ENVIRONMENT_TYPE" and "the
 * licence resolved" were things we had asked for, not things we had observed —
 * and the project's history is mostly the story of that distinction (a green
 * check that meant nothing; a readiness poll that could never have succeeded).
 * This endpoint is how the caller observes instead of assuming.
 *
 * It answers only to a nonce-free token generated per boot, because it reports
 * environment detail and there is no reason for it to answer anyone else.
 *
 * @package ThemeGrill_QA
 */

defined( 'ABSPATH' ) || exit;

// Priority 1, after tgqa-license.php's last-chance attempt at priority 0, so
// the probe reports the state AFTER the licence resolved rather than before it.
add_action( 'init', 'tgqa_probe_maybe_respond', 1 );

/**
 * Answer `?tgqa_probe=<token>` with one JSON object, then stop.
 */
function tgqa_probe_maybe_respond() {
	if ( ! isset( $_GET['tgqa_probe'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		return;
	}

	$expected = tgqa_probe_token();
	$given    = sanitize_text_field( wp_unslash( $_GET['tgqa_probe'] ) ); // phpcs:ignore WordPress.Security.NonceVerification.Recommended

	if ( '' === $expected || ! hash_equals( $expected, $given ) ) {
		status_header( 403 );
		wp_send_json( array( 'error' => 'bad probe token' ), 403 );
	}

	$license = get_option( 'tgqa_license_state', null );

	wp_send_json(
		array(
			// The blueprint's own last step sets this. Until it matches the
			// caller's token, every other field below is a value read while the
			// site was still being built — see boot-wp.mjs's withProSteps().
			'boot_complete'    => get_option( 'tgqa_boot_complete', null ),
			'wp_version'       => get_bloginfo( 'version' ),
			'php_version'      => PHP_VERSION,
			'home_url'         => home_url(),
			'environment_type' => function_exists( 'wp_get_environment_type' ) ? wp_get_environment_type() : null,
			'active_theme'     => get_stylesheet(),
			'active_template'  => get_template(),
			'active_plugins'   => array_values( (array) get_option( 'active_plugins', array() ) ),
			'license'          => $license,
			'pro'              => tgqa_probe_pro_state(),
		)
	);
}

/**
 * The product's own pro gate, evaluated here so the answer is the PRODUCT's
 * opinion rather than ours.
 *
 * Same fixed-pattern matching as the seeder's verifier, and for the same reason:
 * a general `eval()` of a string read from a file is a hole a QA tool has no
 * business opening, disposable site or not.
 *
 * @return array
 */
function tgqa_probe_pro_state() {
	$file = __DIR__ . '/tgqa-license.json';

	if ( ! is_readable( $file ) ) {
		return array( 'checked' => false, 'reason' => 'no licence config mounted' );
	}

	$config = json_decode( (string) file_get_contents( $file ), true ); // phpcs:ignore WordPress.WP.AlternativeFunctions
	$check  = is_array( $config ) && isset( $config['pro_check'] ) ? (string) $config['pro_check'] : '';

	if ( preg_match( '/^([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)\(\)->can_use_premium_code\(\)$/', $check, $m ) ) {
		if ( ! class_exists( $m[1] ) || ! method_exists( $m[1], $m[2] ) ) {
			return array( 'checked' => false, 'reason' => $m[1] . ' not loaded', 'expression' => $check );
		}
		$fs = call_user_func( array( $m[1], $m[2] ) );
		if ( ! is_object( $fs ) || ! method_exists( $fs, 'can_use_premium_code' ) ) {
			return array( 'checked' => false, 'reason' => 'no Freemius instance', 'expression' => $check );
		}
		return array( 'checked' => true, 'active' => (bool) $fs->can_use_premium_code(), 'expression' => $check );
	}

	if ( preg_match( '/^false !== ([a-z_][a-z0-9_]*)\(\)$/', $check, $m ) ) {
		if ( ! function_exists( $m[1] ) ) {
			return array( 'checked' => false, 'reason' => $m[1] . '() not defined', 'expression' => $check );
		}
		$plan = call_user_func( $m[1] );
		return array( 'checked' => true, 'active' => false !== $plan, 'plan' => $plan, 'expression' => $check );
	}

	return array( 'checked' => false, 'reason' => 'no recognised pro_check expression' );
}

/**
 * The per-boot token, written beside this file by `boot-wp.mjs`.
 *
 * @return string
 */
function tgqa_probe_token() {
	$file = __DIR__ . '/tgqa-probe.token';

	return is_readable( $file ) ? trim( (string) file_get_contents( $file ) ) : ''; // phpcs:ignore WordPress.WP.AlternativeFunctions
}
