/**
 * @claudegrill/core — shared spec helpers for every ThemeGrill product.
 *
 * Read CONVENTIONS.md before writing a spec against this. In particular:
 * select on markup we own, seed state rather than clicking through it, tag every
 * fixture, and write the negative test first.
 */

module.exports = {
	...require("./wp-cli"),
	...require("./fixtures"),
	...require("./theme"),
};
