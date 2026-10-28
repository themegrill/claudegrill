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
 *   POST /?tgqa_seed=<token>&op=rows     body: {"action":"insert","table":"t","row":{…}}
 *                                                -> {"id":n}
 *                                         or   {"action":"select","table":"t","where":{…}}
 *                                                -> {"rows":[…]}
 *                                         or   {"action":"delete","table":"t","where":{…}}
 *                                                -> {"deleted":n}
 *   POST /?tgqa_seed=<token>&op=stubs    body: {"set":[{"via":"stripe","method":"GET",
 *                                          "path":"/v1/events/evt_1","status":200,"body":{…}}]}
 *                                         or   {"clear":true}
 *   GET  /?tgqa_seed=<token>&op=stubs                -> {"stubs":[…],"calls":[…]}
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
 * - A table the product did not declare. `rows` is not a SQL endpoint: it takes
 *   unprefixed table names from `seed_tables` in the product's suite.json (staged
 *   beside this file as `tgqa-seed.json`), checks every column against the real
 *   table, and takes equality conditions only. With no declaration it refuses.
 * - An enum value the column does not allow. SQLite accepts any string in an ENUM
 *   column where MySQL refuses it — measured on Playground — so a seed that
 *   passes here could still be state production would never hold. The check
 *   below is what keeps the two engines honest.
 * - A delete with no condition.
 * - An outbound Stripe call nobody stubbed. While any stub is registered, the
 *   Stripe SDK talks to this file and never to the network; a request with no
 *   matching stub gets an error response and is logged as unmatched, so a spec
 *   cannot reach api.stripe.com by accident and a missing stub is a named
 *   failure instead of a timeout.
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

	if ( 'rows' === $op ) {
		'POST' === $method ? tgqa_seed_rows() : tgqa_seed_fail( 405, 'rows takes POST' );
	}

	if ( 'stubs' === $op ) {
		'POST' === $method ? tgqa_seed_stubs_write() : tgqa_seed_stubs_read();
	}

	tgqa_seed_fail( 400, 'unknown op — expected options, cron, rows or stubs' );
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

/**
 * The tables the product declared seedable, unprefixed.
 *
 * @return string[]
 */
function tgqa_seed_tables() {
	$file = __DIR__ . '/tgqa-seed.json';
	if ( ! is_readable( $file ) ) {
		return array();
	}
	$cfg = json_decode( (string) file_get_contents( $file ), true ); // phpcs:ignore WordPress.WP.AlternativeFunctions

	return is_array( $cfg ) && isset( $cfg['tables'] ) && is_array( $cfg['tables'] ) ? array_map( 'strval', $cfg['tables'] ) : array();
}

/**
 * Resolve a declared table to its prefixed name and its real columns.
 *
 * @param string $table Unprefixed name from the request.
 * @return array{0:string,1:array<string,string>} Prefixed name, and column => SQL type.
 */
function tgqa_seed_table( $table ) {
	global $wpdb;

	if ( ! in_array( $table, tgqa_seed_tables(), true ) ) {
		tgqa_seed_fail( 403, "table {$table} is not declared in seed_tables of the product's suite.json" );
	}

	$name = $wpdb->prefix . $table;
	$cols = array();
	foreach ( (array) $wpdb->get_results( "SHOW COLUMNS FROM `{$name}`", ARRAY_A ) as $c ) { // phpcs:ignore WordPress.DB.DirectDatabaseQuery,WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		$cols[ $c['Field'] ] = (string) $c['Type'];
	}
	if ( empty( $cols ) ) {
		tgqa_seed_fail( 409, "table {$name} does not exist on this site — has the product created it (module enabled)?" );
	}

	return array( $name, $cols );
}

/**
 * Refuse a column the table does not have, or an enum value its column forbids.
 *
 * @param array $data Column => value.
 * @param array $cols Column => SQL type.
 * @return void
 */
function tgqa_seed_check_columns( array $data, array $cols ) {
	foreach ( $data as $col => $value ) {
		if ( ! isset( $cols[ $col ] ) ) {
			tgqa_seed_fail( 400, "unknown column {$col}" );
		}
		if ( preg_match( "/^enum\\((.*)\\)$/i", $cols[ $col ], $m ) && null !== $value ) {
			preg_match_all( "/'((?:[^']|'')*)'/", $m[1], $allowed );
			$allowed = array_map( static function ( $v ) { return str_replace( "''", "'", $v ); }, $allowed[1] );
			if ( ! in_array( (string) $value, $allowed, true ) ) {
				tgqa_seed_fail( 400, "{$value} is not a value of enum column {$col} (" . implode( ', ', $allowed ) . ') — MySQL would refuse it' );
			}
		}
	}
}

/**
 * Build `col = %s AND …` from an equality map, refusing an empty one.
 *
 * @param array $where Column => value.
 * @param array $cols  Column => SQL type.
 * @return string Prepared fragment.
 */
function tgqa_seed_where( $where, array $cols ) {
	global $wpdb;

	if ( ! is_array( $where ) || empty( $where ) ) {
		tgqa_seed_fail( 400, 'where is required: this endpoint will not touch every row of a table' );
	}
	tgqa_seed_check_columns( $where, $cols );

	$parts = array();
	foreach ( $where as $col => $value ) {
		$parts[] = null === $value ? "`{$col}` IS NULL" : $wpdb->prepare( "`{$col}` = %s", $value ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
	}

	return implode( ' AND ', $parts );
}

/**
 * Insert, select or delete rows in a declared table.
 *
 * @return void
 */
function tgqa_seed_rows() {
	global $wpdb;

	$in     = tgqa_seed_body();
	$action = isset( $in['action'] ) ? (string) $in['action'] : '';
	$table  = isset( $in['table'] ) ? (string) $in['table'] : '';

	list( $name, $cols ) = tgqa_seed_table( $table );

	if ( 'insert' === $action ) {
		$row = isset( $in['row'] ) && is_array( $in['row'] ) ? $in['row'] : array();
		if ( empty( $row ) ) {
			tgqa_seed_fail( 400, 'insert needs a non-empty row' );
		}
		tgqa_seed_check_columns( $row, $cols );

		$wpdb->suppress_errors( true );
		$ok    = $wpdb->insert( $name, $row ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
		$error = $wpdb->last_error;
		$wpdb->suppress_errors( false );

		if ( false === $ok ) {
			// SQLite's driver wraps the real reason in an HTML query trace; MySQL
			// gives a plain sentence. Pull the reason out of either.
			$text = trim( preg_replace( '/\s+/', ' ', wp_strip_all_tags( $error ) ) );
			if ( preg_match( '/SQLSTATE\[[^\]]*\]: [^:]*: \d+ [^.]*?(?= Backtrace| #0|$)/', $text, $m ) ) {
				$text = $m[0];
			}
			tgqa_seed_fail( 409, 'insert refused: ' . substr( $text, 0, 300 ) );
		}
		wp_send_json( array( 'id' => (int) $wpdb->insert_id ) );
	}

	if ( 'select' === $action ) {
		$where = tgqa_seed_where( isset( $in['where'] ) ? $in['where'] : null, $cols );
		wp_send_json( array( 'rows' => $wpdb->get_results( "SELECT * FROM `{$name}` WHERE {$where} LIMIT 200", ARRAY_A ) ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery,WordPress.DB.PreparedSQL.InterpolatedNotPrepared
	}

	if ( 'delete' === $action ) {
		$where = tgqa_seed_where( isset( $in['where'] ) ? $in['where'] : null, $cols );
		wp_send_json( array( 'deleted' => (int) $wpdb->query( "DELETE FROM `{$name}` WHERE {$where}" ) ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery,WordPress.DB.PreparedSQL.InterpolatedNotPrepared
	}

	tgqa_seed_fail( 400, 'rows action must be insert, select or delete' );
}

/*
 * Outbound HTTP stubs.
 *
 * Stored in an option, because the request that registers a stub and the request
 * that needs it (a webhook the spec then POSTs) are different PHP processes.
 * Only the Stripe SDK is covered so far: it talks over its own curl client, which
 * `pre_http_request` never sees, so it is replaced through the SDK's documented
 * `ApiRequestor::setHttpClient()`.
 */

const TGQA_STUBS_OPTION = 'tgqa_http_stubs';
const TGQA_CALLS_OPTION = 'tgqa_http_calls';

add_action( 'init', 'tgqa_seed_install_stripe_client', 20 );
add_action( 'rest_api_init', 'tgqa_seed_install_stripe_client', 1 );
add_action( 'wp_loaded', 'tgqa_seed_install_stripe_client', 1 );
// A REST handler that builds its own service loads the SDK inside the permission
// callback, after every hook above. This one fires after that and before the
// handler runs, which is the last moment a replacement client still matters.
add_filter( 'rest_dispatch_request', 'tgqa_seed_install_stripe_client_filter', 10, 1 );
add_action( 'admin_init', 'tgqa_seed_install_stripe_client', 1 );

/**
 * Replace the Stripe SDK's HTTP client while a Stripe stub is registered.
 *
 * Tried on several hooks because the SDK is loaded by the product, at a time this
 * file does not control; it does nothing until the SDK exists, and only once.
 *
 * @return void
 */
function tgqa_seed_install_stripe_client() {
	static $installed = false;

	if ( $installed || ! interface_exists( '\\Stripe\\HttpClient\\ClientInterface' ) || ! class_exists( '\\Stripe\\ApiRequestor' ) ) {
		return;
	}
	$has_stripe_stub = false;
	foreach ( (array) get_option( TGQA_STUBS_OPTION, array() ) as $stub ) {
		if ( isset( $stub['via'] ) && 'stripe' === $stub['via'] ) {
			$has_stripe_stub = true;
		}
	}
	if ( ! $has_stripe_stub ) {
		return;
	}

	if ( ! class_exists( 'Tgqa_Stripe_Stub_Client', false ) ) {
		class Tgqa_Stripe_Stub_Client implements \Stripe\HttpClient\ClientInterface { // phpcs:ignore
			public function request( $method, $absUrl, $headers, $params, $hasFile, $apiMode = 'v1', $maxNetworkRetries = null ) { // phpcs:ignore
				$path  = (string) wp_parse_url( $absUrl, PHP_URL_PATH );
				$match = null;
				foreach ( (array) get_option( TGQA_STUBS_OPTION, array() ) as $stub ) {
					if ( isset( $stub['via'] ) && 'stripe' === $stub['via']
						&& strtoupper( (string) $stub['method'] ) === strtoupper( $method )
						&& (string) $stub['path'] === $path ) {
						$match = $stub;
						break;
					}
				}

				$calls   = (array) get_option( TGQA_CALLS_OPTION, array() );
				$calls[] = array(
					'via'     => 'stripe',
					'method'  => strtoupper( $method ),
					'path'    => $path,
					'params'  => $params,
					'matched' => null !== $match,
				);
				update_option( TGQA_CALLS_OPTION, array_slice( $calls, -100 ), false );

				if ( null === $match ) {
					return array(
						wp_json_encode( array( 'error' => array( 'type' => 'api_error', 'message' => "tgqa: no stub for {$method} {$path}" ) ) ),
						500,
						array(),
					);
				}

				return array( wp_json_encode( isset( $match['body'] ) ? $match['body'] : new \stdClass() ), (int) ( isset( $match['status'] ) ? $match['status'] : 200 ), array() );
			}
		}
	}

	\Stripe\ApiRequestor::setHttpClient( new Tgqa_Stripe_Stub_Client() );
	$installed = true;
}

/**
 * Filter form of the installer, which must hand its input back untouched.
 *
 * @param mixed $result Passed through.
 * @return mixed
 */
function tgqa_seed_install_stripe_client_filter( $result ) {
	tgqa_seed_install_stripe_client();

	return $result;
}

/**
 * Report the registered stubs and the calls they answered.
 *
 * @return void
 */
function tgqa_seed_stubs_read() {
	wp_send_json(
		array(
			'stubs' => array_values( (array) get_option( TGQA_STUBS_OPTION, array() ) ),
			'calls' => array_values( (array) get_option( TGQA_CALLS_OPTION, array() ) ),
		)
	);
}

/**
 * Replace the registered stubs, or clear them and the call log.
 *
 * @return void
 */
function tgqa_seed_stubs_write() {
	$in = tgqa_seed_body();

	if ( ! empty( $in['clear'] ) ) {
		delete_option( TGQA_STUBS_OPTION );
		delete_option( TGQA_CALLS_OPTION );
		wp_send_json( array( 'cleared' => true ) );
	}

	if ( ! isset( $in['set'] ) || ! is_array( $in['set'] ) ) {
		tgqa_seed_fail( 400, 'body needs {"set":[…]} or {"clear":true}' );
	}

	$stubs = array();
	foreach ( $in['set'] as $stub ) {
		if ( ! is_array( $stub ) || 'stripe' !== ( isset( $stub['via'] ) ? $stub['via'] : '' ) || empty( $stub['method'] ) || empty( $stub['path'] ) ) {
			tgqa_seed_fail( 400, 'each stub needs via=stripe, method and path' );
		}
		$stubs[] = array(
			'via'    => 'stripe',
			'method' => strtoupper( (string) $stub['method'] ),
			'path'   => (string) $stub['path'],
			'status' => isset( $stub['status'] ) ? (int) $stub['status'] : 200,
			'body'   => isset( $stub['body'] ) ? $stub['body'] : new \stdClass(),
		);
	}

	update_option( TGQA_STUBS_OPTION, $stubs, false );
	delete_option( TGQA_CALLS_OPTION );
	wp_send_json( array( 'registered' => count( $stubs ) ) );
}
