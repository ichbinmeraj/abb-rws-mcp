# abb-rws-mcp

A Model Context Protocol (MCP) server that lets an AI assistant read what an ABB robot
controller is doing and why it stopped. It reads only. It reads through
[abb-rws-daemon](https://github.com/ichbinmeraj/abb-rws-daemon) on 127.0.0.1, which holds
the one session per controller over Robot Web Services: RWS 1.0 (IRC5, RobotWare 6) and
RWS 2.0 (OmniCore, RobotWare 7 and 8). This server opens no controller session and never
sees controller credentials.

> **Status:** 0.1.0. Read-only. Tested on 2026-10-25 through abb-rws-daemon 0.1.0
> (snapshot schema 0.14), and on 2026-10-21 through a pre-release build of it (schema
> 0.13), each time on three RobotStudio virtual controllers: RobotWare 6.16.03 (RWS 1.0),
> 7.21.4 and 8.2.1 (RWS 2.0). Every tool and the prompt ran through an MCP client over
> stdio, and every request the server sent the daemon was recorded: reads only, plus one
> sampling request per controller when motion sampling was on. Not yet run against a real
> controller. Changes are listed in [CHANGELOG.md](CHANGELOG.md).

**Read-only.** The server has 8 tools and 1 prompt. Every tool reads. None of them sets a
signal, starts or stops a program, moves a program pointer, loads or edits a module,
switches motors, changes the speed, or requests mastership or write access. There is no
write tool behind a flag either. The server writes no file and starts no process. It calls
only the daemon's read routes; the one request that is not a GET asks the daemon to sample
joint positions for 15 s (see [Motion sampling](#motion-sampling)).

## Requirements

- Node.js 20 or later, on Windows or Linux. macOS follows the Linux paths and is untested.
- [abb-rws-daemon](https://github.com/ichbinmeraj/abb-rws-daemon) 0.1.0 or a later 0.x,
  running on the same PC, with at least one controller added. This server cannot add one.
  It reads snapshot schema 0.13 or a later 0.x. It was tested with 0.14, which
  abb-rws-daemon 0.1.0 serves, and with 0.13, which only pre-release builds of the daemon
  served. It does not read the field 0.14 adds (whether a lock holder is the FlexPendant).
  With a later 0.x it logs one warning that the schema is newer than the ones it was
  tested with, and `list_controllers` says the same.
- An MCP host that runs stdio servers: Claude Desktop, Claude Code, VS Code, Cursor or
  another.

## Setup

Start the daemon first and add your controller there. Then add this server to your MCP
host. Pin the version, as below.

Claude Desktop (`claude_desktop_config.json`) and Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "abb-rws": { "command": "npx", "args": ["-y", "abb-rws-mcp@0.1.0"] }
  }
}
```

VS Code (`.vscode/mcp.json`):

```json
{
  "servers": {
    "abb-rws": { "type": "stdio", "command": "npx", "args": ["-y", "abb-rws-mcp@0.1.0"] }
  }
}
```

Claude Code:

```sh
claude mcp add abb-rws -- npx -y abb-rws-mcp@0.1.0
```

The daemon on another port: add `"env": { "ABB_RWS_MCP_DAEMON_URL": "http://127.0.0.1:7811" }`
to the server entry.

The server finds the daemon's token file where the daemon keeps it. If the daemon runs
with `--token-file`, set the same file for this server (see [Configuration](#configuration)).

The published package is one bundled file with no runtime dependencies, so `npx` fetches
nothing else.

## Tools

| Tool | What it answers | Reaches the controller? |
|---|---|---|
| `summarize_controller` | Start here. The state in one sentence, facts from the snapshot, recent errors and warnings with ABB's recommended actions, the operational messages, and the source line at each program pointer | At most two module reads, failed ones included |
| `list_controllers` | The controllers the daemon knows, and the daemon's own state. Call it first, and when other tools fail | No |
| `get_controller_status` | Controller state, operating mode, speed override, collision detection, RAPID execution, the link, what the daemon can read here, and the access status as the controller reported it | No |
| `get_robot_position` | Joint positions, the TCP pose with Euler angles, whether the arm moves, how close each joint is to its limits | Motion sampling, see below |
| `read_io_signals` | Signals and values from the daemon's signal table, or a signal search | Only for a search |
| `get_event_log` | The controller's event log as the daemon keeps it, filtered by severity, time, category or code | No |
| `get_rapid_execution` | Execution state and the program and motion pointers of each task | No |
| `read_rapid_source` | A module's RAPID source with line numbers: a routine, the lines around a line, or a page | The first read of a module |

The prompt `why_did_it_stop` (a slash command in hosts that show prompts) asks the
assistant to find out what a controller is doing and why it stopped, with a fixed recipe:
summary first, then the problems and their actions, the line at the program pointer, the
signals that line names, the age of every value, and only causes the data shows.

## What the assistant sees

- Every answer starts with a status line: the controller id, virtual or real, the
  RobotWare version, and whether the data is current, DEGRADED, DOWN or a REPLAY.
- Every value comes with its time in UTC and its age ("14:02:11 UTC (3 min 12 s ago)").
- Stale values are returned, labelled STALE, with their time. A controller that is down or
  degraded is not an error.
- Event times are corrected to UTC to about a second, or marked "controller clock, zone
  unknown" when the daemon could not read the controller's clock.
- Controller states and modes come with a one-sentence meaning where ABB's documentation
  describes the value.
- A daemon that replays a recording is refused unless replay is allowed; then every answer
  says REPLAY.
- Each answer has a readable text part and the same data as structured JSON.

## Controller text is data

Event-log messages, RAPID source, signal names and controller names come from the
controller. Anyone who can change the controller's programs or configuration can write that
text. abb-rws-mcp passes it to the assistant marked as controller data, not as instructions:
in the text, inside a block whose markers carry a random value made for that answer, and in
the structured JSON, under `controllerData`. Escape sequences are removed from it, and hidden
characters (control, zero-width, direction and tag characters) are replaced by a visible mark
(U+FFFD). This server has no tool that changes anything, so that text cannot make it act. Other
tools your assistant has can still act. Read what the assistant proposes before you run it.

## Motion sampling

`get_robot_position` asks the daemon to sample joint positions and the pose for 15 s,
unless another program already does. These are controller reads, the ones the daemon
README lists under "Reads on demand": about 8 joint reads a second per mechanical unit and
2 pose reads a second per robot, while the sampling runs. The server asks at most once per
15 s per controller, and never while the link is not live or the controller reports that
it is busy. Turn it off with `--motion-sampling off`; the tool then returns the last sampled
values with their time.

## Signals

The signal table is read from the daemon's memory, with values of unknown age. A search by
device, network or category, or a read with `fresh: true`, is a read-only RWS search request
on the controller (sent as a POST by the daemon, not a GET). A search needs a name prefix of
at least 3 characters or a device, so it does not page through the whole table. This server
limits its own controller reads (searches and module reads): per controller, one at a time,
at most two in a row, then one every 2 s.

## What it cannot see

- ABB documents that the common event log, which the daemon reads, leaves out the RAPID
  build-error log and the internal log. "Why won't my program start" can miss build errors.
- The snapshot has no time for when the program or the controller state last changed. The
  operational events in the log are the only timing evidence.
- The daemon keeps the last 256 event-log messages per controller. Older ones are not
  available.
- RAPID variables, backups, configuration and controller files are not served by the
  daemon yet, so this server cannot read them.

## Configuration

Each option has an environment variable. An option wins over its variable; an empty
variable counts as unset.

| Option | Variable | Default and meaning |
|---|---|---|
| `--daemon-url <url>` | `ABB_RWS_MCP_DAEMON_URL` | `http://127.0.0.1:7810`. Only `http://127.0.0.1:<port>` or `http://localhost:<port>`. `localhost` is a spelling only: the server always connects to 127.0.0.1. Every other host, `[::1]` included, is refused at start. |
| `--token-file <file>` | `ABB_RWS_DAEMON_TOKEN_FILE` | The daemon's own default: `%APPDATA%\abb-rws-daemon\token` on Windows, `$XDG_CONFIG_HOME/abb-rws-daemon/token` or `~/.config/abb-rws-daemon/token` elsewhere. The variable is the one the daemon reads, so setting it once serves both. |
| `--allow-replay` | `ABB_RWS_MCP_ALLOW_REPLAY` | Off. Read a daemon that replays a recording; every answer then says REPLAY. |
| `--motion-sampling <on\|off>` | `ABB_RWS_MCP_MOTION_SAMPLING` | `on`. See [Motion sampling](#motion-sampling). |
| | `ABB_RWS_MCP_LOG` | `warn`. `error`, `warn`, `info` or `debug`. Logs go to stderr only. |

`--help` and `--version` print and exit without contacting anything. A bad value stops the
server at start with one line on stderr.

There is no option for a daemon on another PC: the daemon listens on 127.0.0.1 only, and this
server reads the daemon on the same PC.

## Security notes

- Loopback only. The token is read from the daemon's token file, held in memory, and sent
  only to 127.0.0.1, after the daemon has answered its health check. It is never logged and
  never in a tool result.
- The daemon's token file opens the whole daemon API (adding controllers, discovery scans,
  shutdown) to every program that runs under your account, an assistant's shell tool
  included. This server uses only the read routes; other tools are not bound by that.
- Tool results go to your assistant's model provider. They can include controller and
  system names, the daemon's controller names (which default to the address), and the user
  or PC names of lock holders.
- With web or shell tools in the same session, controller text could ask the assistant to
  send data out. Keep that in mind when you enable such tools.
- While the daemon records, the reads this server causes are in the recording. Every answer
  says when a recording runs.
- Logs go to stderr, which hosts often keep on disk. At the default level they carry codes,
  ids, route templates, counts and durations, not controller text. The `debug` level adds the
  token file's path and the message of an internal error.

Report a security issue privately, as [SECURITY.md](SECURITY.md) says.

## What it does not do

- No writes of any kind: no signal set, no RAPID start, stop, program pointer or variable
  write, no module load, no motors, no speed ratio, no mastership or write-access request.
- No motion commands. Agents cannot jog or move the robot.
- No setup: no adding or removing controllers, no discovery, no recording, no replay
  control, no daemon shutdown. You do these with the daemon.
- No controller session and no controller credentials.
- No remote daemon: loopback only.
- No subscription and no stream: an answer is a read at the time of the call.
- No HTTP transport and no listening socket: stdio only.

## Development

```sh
npm ci
npm run build    # type check, then bundle dist/cli.js
npm test         # offline tests against a fake daemon
npm run lint
```

The tests never reach a controller or a daemon.

## Related projects

- [abb-rws-daemon](https://github.com/ichbinmeraj/abb-rws-daemon): one session per controller, served as a typed snapshot over HTTP and WebSocket; this server's only way to a controller
- [abb-rws-client](https://github.com/ichbinmeraj/abb-rws-client): TypeScript RWS client tested on RobotWare 6, 7 and 8
- [abb-rws-ros2](https://github.com/ichbinmeraj/abb-rws-ros2): ROS 2 supervisory bridge
- [abb-rws-vscode](https://github.com/ichbinmeraj/abb-rws-vscode): RAPID Live, VS Code extension for ABB controllers

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). If you redistribute this work, keep
the NOTICE file. The bundled third-party packages and their licences are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Contributions are accepted under the DCO - see [CONTRIBUTING.md](CONTRIBUTING.md).

## Disclaimer

Independent open-source project by [Meraj Safari](https://github.com/ichbinmeraj). ABB is
a trademark of ABB Asea Brown Boveri Ltd. RobotWare, OmniCore, IRC5, RAPID, FlexPendant
and RobotStudio are trademarks of their respective owners. Not affiliated with, endorsed
by, sponsored by or supported by ABB, ABB Robotics or any later owner of these products.
See [TRADEMARKS.md](TRADEMARKS.md).
