/** This server's name and version, as it reports them at `initialize` and to `--version`. */
export const SERVER_NAME = 'abb-rws-mcp';
export const SERVER_VERSION = '0.1.0';

/**
 * The daemon schema this release was tested against: 0.14, which abb-rws-daemon
 * 0.1.0 serves. A later 0.x is accepted with a warning.
 */
export const SCHEMA_TESTED = { major: 0, minor: 14 } as const;

/**
 * The oldest daemon schema this server reads: 0.13, which only pre-release builds
 * of abb-rws-daemon 0.1.0 served. This server was tested with it too, and 0.14 adds
 * only a field it does not read, so 0.13 reads without a warning.
 */
export const SCHEMA_OLDEST = { major: 0, minor: 13 } as const;

declare const __SDK_VERSION__: string | undefined;

/** The MCP SDK version the bundle was built with ('unknown' when run from source). */
export const SDK_VERSION: string = typeof __SDK_VERSION__ === 'string' ? __SDK_VERSION__ : 'unknown';
