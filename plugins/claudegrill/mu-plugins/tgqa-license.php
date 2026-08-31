<?php
/**
 * Plugin Name: ThemeGrill QA — licence seeder
 * Description: Puts a pro licence where WordPress can see it, for automated QA only.
 *
 * THIS FILE LIVES IN claudegrill AND MUST NEVER ENTER A PRODUCT REPOSITORY.
 * `boot-wp.mjs` mounts it into the disposable site's `wp-content/mu-plugins/`.
 * A CI guard fails the build if `tgqa-` appears in any product's release zip,
 * because a licence seeder shipped to a customer is a licence seeder pointed at
 * a customer's site.
 *
 * Configuration comes from `tgqa-license.json`, written next to this file by
 * `license.mjs seed` at mode 0600 — NOT from constants in wp-config.php.
 * Constants there surface in `wp config list`, in Site Health, in debug dumps,
 * and in any plugin that prints its environment; a file that only PHP reads does
 * not.
 *
 * @package ThemeGrill_QA
 */

defined( 'ABSPATH' ) || exit;

/**
 * Three hooks, and the reason there are three.
 *
 * `plugins_loaded` is the obvious place and it is WRONG for half the catalogue.
 * ColorMag Pro is delivered as a standalone THEME, and a theme's `functions.php`
 * — where `FS_ThemeGrill::init()` lives — does not run until `setup_theme`,
 * which fires AFTER `plugins_loaded`. Hooking only there produced exactly one
 * symptom on a real boot: `pro gate unavailable: FS_ThemeGrill not loaded`, with
 * the pro theme correctly active and the licence never attempted.
 *
 * So: try at each point where the product might just have become available, and
 * stop at the first one that works. `init` is the last chance, and the only one
 * that is allowed to conclude "not attempted" — concluding it earlier would
 * report a failure for a product that had simply not loaded yet.
 *
 * `init` at priority 0 so it lands before tgqa-probe.php answers at priority 1;
 * otherwise the probe reports the state from before this ran.
 */
add_action( 'plugins_loaded', 'tgqa_license_apply', 99 );
add_action( 'after_setup_theme', 'tgqa_license_apply', 99 );
add_action( 'init', 'tgqa_license_apply_final', 0 );

/**
 * Last chance. Whatever state we are in at `init` is the state we report.
 */
function tgqa_license_apply_final() {
	tgqa_license_apply( true );
}

/**
 * Read the config and put the licence where the product looks for it.
 *
 * @param bool $final True on the last hook, where "the product never loaded" is
 *                    a conclusion rather than a reason to wait.
 */
function tgqa_license_apply( $final = false ) {
	static $done = false;

	if ( $done ) {
		return;
	}

	$config = tgqa_license_config();

	if ( null === $config ) {
		$done = true;
		return; // No config mounted: this is a free-version run. Nothing to do.
	}

	if ( empty( $config['attempted'] ) ) {
		$done = true;
		tgqa_license_log( $config, 'not attempted', isset( $config['reason'] ) ? $config['reason'] : 'no reason given' );
		return;
	}

	$provider = isset( $config['provider'] ) ? $config['provider'] : '';

	switch ( $provider ) {
		case 'edd':
			// Pure option writes; nothing to wait for.
			$state = tgqa_license_apply_edd( $config );
			break;

		case 'freemius':
			$fs = tgqa_license_freemius_instance( $config );

			if ( ! $fs ) {
				if ( ! $final ) {
					return; // The product may load on a later hook. Try again then.
				}
				$done = true;
				tgqa_license_log(
					$config,
					'not attempted',
					'the product never exposed its Freemius instance — is the pro code mounted and active?'
				);
				return;
			}

			$state = tgqa_license_apply_freemius( $config, $fs );
			break;

		default:
			$done = true;
			tgqa_license_log( $config, 'not attempted', sprintf( 'no handler for provider "%s"', $provider ) );
			return;
	}

	$done = true;
	tgqa_license_log( $config, $state, tgqa_license_verify( $config ) );
}

/**
 * EDD: write the options the product reads. No HTTP call.
 *
 * `license.mjs seed` already talked to the store, once, before the site booted,
 * and put the store's own response in the config. Repeating that call here would
 * make a 60-spec run into 60 store requests — which is both rude and the thing
 * most likely to turn a slow store into a suite-wide timeout.
 *
 * The transient below is what makes the one-request-per-run promise hold even
 * when the product decides to re-check on its own: the product's own code
 * (`ur_get_license_plan()`, `evf_get_license_plan()`) reads its plan transient
 * first and only calls the store when that is empty.
 *
 * @param array $config Seeded configuration.
 * @return string Resolved state.
 */
function tgqa_license_apply_edd( $config ) {
	$key = isset( $config['key'] ) ? $config['key'] : '';

	if ( '' === $key || empty( $config['option_key'] ) ) {
		return 'not attempted';
	}

	update_option( $config['option_key'], $key );

	$response = isset( $config['response'] ) ? $config['response'] : null;

	if ( ! empty( $config['option_status'] ) && null !== $response ) {
		// User Registration stores the WHOLE decoded activation response under
		// `user-registration_license_active`, not a status string — confirmed at
		// includes/class-ur-plugin-updater.php:358. Writing 'valid' there would
		// produce an option the product cannot read.
		update_option( $config['option_status'], (object) $response );
	}

	if ( ! empty( $config['transient_plan'] ) && null !== $response && ! empty( $response['item_name'] ) ) {
		// Seed the product's own plan transient so its first read is a cache hit
		// and no spec triggers a store round trip. Shape copied from the
		// products: the decoded response plus a lower-cased `item_plan`.
		$plan             = (object) $response;
		$plan->item_plan  = trim(
			str_ireplace(
				array( 'lifetime', '-lifetime', 'user registration', 'everest forms' ),
				'',
				strtolower( $response['item_name'] )
			)
		);
		set_transient( $config['transient_plan'], $plan, WEEK_IN_SECONDS );
	}

	return isset( $config['status'] ) && 'valid' === $config['status'] ? 'valid' : 'invalid';
}

/**
 * Freemius: hand the key to the product's own activation entry point.
 *
 * Deliberately narrow. We call the accessor the product exposes — recorded in
 * `licenses.json` from reading the product source — and let the SDK do the
 * opt-in handshake. We do not touch `fs_accounts`, `FS_Storage`, or anything
 * else inside Freemius: those are internals that change between SDK versions,
 * and a site that LOOKS licensed because we forged its storage is the worst
 * possible outcome for a QA harness.
 *
 * @param array  $config Seeded configuration.
 * @param object $fs     The product's own Freemius instance.
 * @return string Resolved state.
 */
function tgqa_license_apply_freemius( $config, $fs ) {
	if ( method_exists( $fs, 'can_use_premium_code' ) && $fs->can_use_premium_code() ) {
		return 'valid'; // Already activated — Playground reuses site directories.
	}

	$key = isset( $config['key'] ) ? $config['key'] : '';

	if ( '' === $key || ! method_exists( $fs, 'opt_in' ) ) {
		return 'not attempted';
	}

	try {
		// Signature from the vendored SDK 2.13.1, class-freemius.php:17102.
		// `$redirect = false` matters: the default redirects, and a redirect
		// from inside `plugins_loaded` on a CLI or REST request is a hang.
		$fs->opt_in( false, false, false, $key, false, false, false, null, array(), false );
	} catch ( Exception $e ) {
		// Never let a Freemius-side failure fatal the site. The run must still
		// reach the point where the @pro gate reports "licence not active",
		// which is a far more legible failure than a white screen.
		return 'invalid';
	}

	return ( method_exists( $fs, 'can_use_premium_code' ) && $fs->can_use_premium_code() ) ? 'valid' : 'invalid';
}

/**
 * The product's Freemius instance, via the accessor it publishes.
 *
 * `accessor` is a `Class::method` pair from `licenses.json`, validated against a
 * strict pattern before use. It is configuration read from a file, so it is
 * treated as untrusted input even though we wrote it.
 *
 * @param array $config Seeded configuration.
 * @return object|null
 */
function tgqa_license_freemius_instance( $config ) {
	$accessor = isset( $config['accessor'] ) ? (string) $config['accessor'] : '';
	$accessor = rtrim( trim( $accessor ), '()' );

	if ( ! preg_match( '/^([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)$/', $accessor, $m ) ) {
		return null;
	}

	if ( ! class_exists( $m[1] ) || ! method_exists( $m[1], $m[2] ) ) {
		return null;
	}

	$fs = call_user_func( array( $m[1], $m[2] ) );

	return is_object( $fs ) ? $fs : null;
}

/**
 * Evaluate the product's own pro gate, so the log line reports what the PRODUCT
 * believes rather than what we hope we achieved.
 *
 * Only the two shapes the registry actually contains are honoured, matched
 * against fixed patterns. A general `eval()` of a string from a config file is
 * exactly the hole a QA tool should not open, even in a disposable site.
 *
 * @param array $config Seeded configuration.
 * @return string
 */
function tgqa_license_verify( $config ) {
	$check = isset( $config['pro_check'] ) ? (string) $config['pro_check'] : '';

	if ( preg_match( '/^([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)\(\)->can_use_premium_code\(\)$/', $check, $m ) ) {
		if ( ! class_exists( $m[1] ) || ! method_exists( $m[1], $m[2] ) ) {
			return 'pro gate unavailable: ' . $m[1] . ' not loaded';
		}
		$fs = call_user_func( array( $m[1], $m[2] ) );
		if ( ! is_object( $fs ) || ! method_exists( $fs, 'can_use_premium_code' ) ) {
			return 'pro gate unavailable: no Freemius instance';
		}
		return 'pro gate: ' . ( $fs->can_use_premium_code() ? 'TRUE' : 'FALSE' );
	}

	if ( preg_match( '/^false !== ([a-z_][a-z0-9_]*)\(\)$/', $check, $m ) ) {
		if ( ! function_exists( $m[1] ) ) {
			return 'pro gate unavailable: ' . $m[1] . '() not defined';
		}
		$plan = call_user_func( $m[1] );
		return 'pro gate: ' . ( false !== $plan ? 'TRUE (plan ' . wp_json_encode( $plan ) . ')' : 'FALSE' );
	}

	return 'pro gate not evaluated';
}

/**
 * Where the config lives, and the reason it may legitimately be absent.
 *
 * @return array|null
 */
function tgqa_license_config() {
	$file = __DIR__ . '/tgqa-license.json';

	if ( ! is_readable( $file ) ) {
		return null;
	}

	$data = json_decode( (string) file_get_contents( $file ), true ); // phpcs:ignore WordPress.WP.AlternativeFunctions

	return is_array( $data ) ? $data : null;
}

/**
 * One line, always, key redacted.
 *
 * `run-suite.mjs` greps the debug log for this line and puts it in the report,
 * so a run that silently tested the free version is impossible to mistake for a
 * passing pro run. That is the entire point of logging here rather than
 * trusting the exit code of something upstream.
 *
 * @param array  $config Seeded configuration.
 * @param string $state  valid | invalid | not attempted.
 * @param string $detail Extra context, already key-free.
 */
function tgqa_license_log( $config, $state, $detail = '' ) {
	$line = sprintf(
		'TGQA_LICENSE product=%s provider=%s state=%s key=%s%s',
		isset( $config['product'] ) ? $config['product'] : '(unknown)',
		isset( $config['provider'] ) ? $config['provider'] : '(unknown)',
		$state,
		isset( $config['key_redacted'] ) ? $config['key_redacted'] : '(none)',
		'' !== $detail ? ' detail=' . str_replace( array( "\r", "\n" ), ' ', $detail ) : ''
	);

	error_log( $line ); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log

	// Also readable without the debug log, for engines where it is awkward to
	// reach — the suite's licence gate reads this option.
	update_option(
		'tgqa_license_state',
		array(
			'product'  => isset( $config['product'] ) ? $config['product'] : null,
			'provider' => isset( $config['provider'] ) ? $config['provider'] : null,
			'state'    => $state,
			'detail'   => $detail,
			'at'       => time(),
		),
		false
	);
}

/*
 * ---------------------------------------------------------------------------
 * SEAM: negative licence states.
 * ---------------------------------------------------------------------------
 *
 * Real keys cannot produce `expired`, `disabled`, `invalid` or
 * `no_activations_left`. Those are a genuine bug class — they are what a
 * customer sees when their licence lapses — and with real-keys-only they are
 * untested. Mocking them was deliberately decided against for now.
 *
 * THIS is where it goes when it is built, and it should be one added file
 * rather than a refactor of anything above:
 *
 *   add_filter( 'pre_http_request', function ( $pre, $args, $url ) use ( $config ) {
 *       if ( false === strpos( $url, $config['store_url'] ) ) {
 *           return $pre;
 *       }
 *       return array(
 *           'response' => array( 'code' => 200 ),
 *           'body'     => wp_json_encode( array( 'success' => false, 'license' => 'expired', 'error' => 'expired' ) ),
 *       );
 *   }, 10, 3 );
 *
 * The forced state would come from the same config file — a `force_state` field
 * — so a spec can request it without a code change. Freemius does not go through
 * `pre_http_request` in the same way, so that provider needs its own approach.
 */
