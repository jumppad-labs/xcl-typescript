/**
 * The engine version this package was built for. A release writes it from the
 * xcl tag in xcl-ref.txt.
 *
 * Outside a release it holds a development value, which `make engine` stamps
 * on the engine it builds, so a development engine always passes the version
 * check.
 */
export const ENGINE_VERSION = "v0.0.0-dev";

/** The package's own version. A release writes it from the same tag. */
export const PACKAGE_VERSION = "0.0.0-dev";
