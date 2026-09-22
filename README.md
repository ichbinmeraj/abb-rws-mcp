# abb-rws-mcp

MCP (Model Context Protocol) server that gives AI agents safe, controlled access to ABB robot controllers over Robot Web Services: RWS 1.0 (IRC5 / RobotWare 6) and RWS 2.0 (OmniCore / RobotWare 7 and 8).

> **Status: early development.** Nothing to install yet. Watch or star the repo to follow progress.

## What it does

Built on [abb-rws-client](https://github.com/ichbinmeraj/abb-rws-client), it exposes controller data and actions as MCP tools:

- Read-only by default: controller state, joint positions, I/O, RAPID modules, event log
- Write actions (signals, RAPID start/stop, mastership) only when explicitly enabled, with per-action confirmation

## What it does not do

No motion commands. Agents cannot jog or move the robot.

## Related projects

- [abb-rws-client](https://github.com/ichbinmeraj/abb-rws-client): TypeScript RWS client tested on RobotWare 6, 7 and 8
- [abb-rws-ros2](https://github.com/ichbinmeraj/abb-rws-ros2): ROS 2 supervisory bridge
- [abb-rws-conformance](https://github.com/ichbinmeraj/abb-rws-conformance): conformance suite and compatibility matrix
- [abb-rws-vscode](https://github.com/ichbinmeraj/abb-rws-vscode): RAPID Live, VS Code extension for ABB controllers

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). If you redistribute this work, keep the NOTICE file.

## Disclaimer

Independent open-source project by [Meraj Safari](https://github.com/ichbinmeraj). Not affiliated with, endorsed by or sponsored by ABB. ABB, RobotWare, OmniCore, IRC5 and RobotStudio are trademarks of ABB. See [TRADEMARKS.md](TRADEMARKS.md).
