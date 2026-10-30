# Changelog

All notable changes to abb-rws-mcp are listed in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, a new minor
version may change tool names, inputs and outputs.

## [0.2.0] - 2026-10-31

Two new tools, a state line per controller, and a note on where a value came from. The
tools still read and nothing else: none of them writes to a controller or to the disk.

### Added

- **`read_rapid_variable`** reads the value of one RAPID data symbol (a VAR, PERS or
  CONST) through abb-rws-daemon 0.1.1 or later. The value comes as RAPID text, the form
  the controller gives it, with no type (`typed: false`). A value longer than 16384
  characters is cut there and says `truncated: true`. When the controller answers with no
  value at all, the tool says the value was not read (`VALUE_NOT_READ`) and never shows
  it as empty. A task or a module the snapshot does not list is answered without a
  request to the controller. With abb-rws-daemon 0.1.0 the tool says the daemon needs an
  update (`DAEMON_TOO_OLD`), and the other tools work as before.
- **`explain_event`** lays out one event from the log, by `code` or by `seq` with its
  `feed`. What the controller says (ABB's title, description, causes, consequences and
  actions) is kept apart from our reading of it: the category, the severity and what it
  means, the time and its age, and the RAPID line the event names, read from the module
  when the event gives a module, a routine and a line. The line's task is the one the
  event names, or, when it names none, the one task that lists the module, and the
  answer says which. Next to it are the events just before and after, 60 s each way by
  default (`aroundS`, up to 600). It always says that the data does not show the cause.
  A `seq` without its `feed` gives `FEED_NEEDED`, and a `feed` whose numbering has since
  started over gives `FEED_CHANGED`, because the daemon numbers its events anew after a
  restart.
- **A state line per controller** in `list_controllers`, such as "motors on, Auto,
  running", and "last known: ..." when the controller's data is not current. A value the
  server does not know reads "not known".
- **`provenance`** on the answers of `explain_event`, `read_rapid_variable` and
  `read_rapid_source`: the daemon's id for the controller, virtual or real, the RobotWare
  version, when the value was read, whether it came from the daemon's snapshot, the
  controller, this server's cache or a recording the daemon replays, and the RWS resource
  the daemon read, as a template.
- **`feed` in `summarize_controller`,** so a seq from its problems can be given to
  `explain_event`.
- **`--mark-codes <file>`** (or `ABB_RWS_MCP_MARK_CODES`): a text file of event codes, one
  per line. Events with a listed code say `marked: true` in `get_event_log`,
  `explain_event` and `summarize_controller`. Without the file every event says
  `marked: null`. The file is read once at start, and a line that is not a code stops the
  server with a message that names the line.

### Changed

- `get_robot_position` waits up to 10 s for the first joint sample on an RWS 1.0
  controller (IRC5), where it waited 6 s. On a RobotWare 6.16 virtual controller the
  first sample took 4.2 to 4.5 s and once ran over 6 s while two other controllers were
  read. RWS 2.0 controllers keep 6 s.
- Tested with snapshot schema 0.15, which abb-rws-daemon 0.1.1 serves, so 0.15 no longer
  logs the warning about a newer schema.

### Tested

- On 2026-10-31, through abb-rws-daemon 0.1.1 (snapshot schema 0.15) on three RobotStudio
  virtual controllers: RobotWare 6.16.03 (IRC5, RWS 1.0), 7.21.4 and 8.2.1 (OmniCore,
  RWS 2.0), one controller per run. Every tool and the prompt ran through an MCP client
  over stdio, and every request the server sent the daemon was recorded: GETs only, and
  with motion sampling on, one sampling request per controller.
- `read_rapid_variable` was compared with the controller's own answer, character for
  character: `tool0` on all three, `reg1` on RobotWare 6, and a PERS string with an inner
  doubled quote and the characters `& < >`, loaded for the run and unloaded after it.
- `explain_event` was compared with the full event from `get_event_log`. A wrong feed, a
  seq the log does not hold and a seq without its feed each gave their own answer.

### Not yet

- Not yet run against a real controller.
- Not yet run on an event that names a RAPID line, because the test controllers had none
  in their newest 100 events. The line rule is covered by the unit tests.

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
