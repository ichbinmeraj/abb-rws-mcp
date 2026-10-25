# Changelog

All notable changes to abb-rws-mcp are listed in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, a new minor
version may change tool names, inputs and outputs.

## [0.1.0] - 2026-10-25

The first release. Its tools only read: none of them writes to a controller or to the disk.
The one request that is not a GET asks the daemon to sample joint positions for 15 s (a
motion watch lease, which the daemon documents as sampling); turn it off with
`--motion-sampling off`.

### Added

- **A stdio MCP server** that reads ABB robot controllers through abb-rws-daemon 0.1.0
  or a later 0.x on 127.0.0.1. It opens no controller session and never sees controller
  credentials. It reads snapshot schema 0.13 or a later 0.x and was tested with 0.14,
  which abb-rws-daemon 0.1.0 serves (0.13 was served only by pre-release builds of the
  daemon). With a later 0.x it logs one warning and `list_controllers` says that the
  schema is newer than the ones this server was tested with.
- **Eight read-only tools:** `summarize_controller` (start here: state, facts, recent
  problems with ABB's recommended actions, operational messages and the source line at the
  program pointer), `list_controllers`, `get_controller_status`, `get_robot_position`
  (joints, pose with Euler angles, moving or not, joint limits), `read_io_signals`,
  `get_event_log`, `get_rapid_execution` and `read_rapid_source`.
- **The prompt `why_did_it_stop`,** with a fixed recipe for the assistant.
- **Labels on every answer:** a status line (virtual or real, RobotWare version, current,
  DEGRADED, DOWN or REPLAY), the time and age of every value, STALE values marked, and
  structured JSON with the same labels.
- **Controller text kept as data:** every string from the controller sits in a block whose
  markers carry a value made for that answer, and under `controllerData` in the JSON, with
  escape sequences removed and hidden characters replaced by a visible mark (U+FFFD).
- **Limits of its own:** one controller read at a time per controller and a small rate,
  at most two module reads per summary (failed ones included), a module cache of 60 s, at
  most one motion sampling request per controller per 15 s, and no request at all while
  idle.
- **Loopback only:** the daemon URL must be 127.0.0.1 or localhost; the token is read from
  the daemon's token file and sent only to 127.0.0.1, after a health check, and never logged.
- **One bundled file** with no runtime dependencies; the bundled packages' licences are in
  THIRD_PARTY_NOTICES.md.

### Tested

- On 2026-10-25, through abb-rws-daemon 0.1.0 (snapshot schema 0.14) on three RobotStudio
  virtual controllers: RobotWare 6.16.03 (IRC5, RWS 1.0), 7.21.4 and 8.2.1 (OmniCore,
  RWS 2.0). Every tool and the prompt ran through an MCP client over stdio, and every
  request the server sent the daemon was recorded: GETs only, and with motion sampling on,
  one sampling request per controller.
- On 2026-10-21, through a pre-release build of abb-rws-daemon 0.1.0 (snapshot schema
  0.13) on three RobotStudio virtual controllers: RobotWare 6.16.03 (IRC5, RWS 1.0),
  7.21.4 and 8.2.1 (OmniCore, RWS 2.0). Every tool and
  the prompt ran through an MCP client over stdio with motion sampling off;
  `get_robot_position` ran again with it on. Every request the server sent the daemon was
  recorded: GETs only, and with motion sampling on, one sampling request per controller.
  Every tool read only.

### Not yet

- Not yet run against a real controller.
