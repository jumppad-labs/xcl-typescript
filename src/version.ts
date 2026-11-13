/**
 * The engine version this package was built for: the xcl tag pinned in
 * xcl-ref.txt. The package and the engine are versioned separately; a release
 * writes this from the pin, and the client refuses an engine reporting any
 * other version.
 *
 * Outside a release it holds a development value, which `make engine` stamps
 * on the engine it builds, so a development engine always passes the version
 * check.
 */
export const ENGINE_VERSION = "v0.0.0-dev";

/** The package's own version. A release writes it from the xcl-typescript tag. */
export const PACKAGE_VERSION = "0.0.0-dev";
