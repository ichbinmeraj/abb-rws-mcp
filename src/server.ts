import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Context } from './context.js';
import { INSTRUCTIONS } from './instructions.js';
import { PROMPT_DESCRIPTION, PROMPT_NAME, promptText } from './prompt.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';
import { wrap } from './tools/common.js';
import * as events from './tools/eventLog.js';
import * as io from './tools/ioSignals.js';
import * as list from './tools/listControllers.js';
import * as position from './tools/position.js';
import * as execution from './tools/rapidExecution.js';
import * as source from './tools/rapidSource.js';
import * as status from './tools/status.js';
import * as summarize from './tools/summarize.js';

/** The tool names, in the order they are listed. Every one reads; none writes. */
export const TOOL_NAMES = [
  summarize.NAME, list.NAME, status.NAME, position.NAME, io.NAME, events.NAME, execution.NAME, source.NAME,
] as const;

/**
 * The MCP server: 8 read-only tools and 1 prompt. It declares no logging
 * capability and no resources; the instructions and descriptions are fixed text.
 */
export function createServer(ctx: Context): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(summarize.NAME, {
    title: 'Summarize controller', description: summarize.DESCRIPTION,
    inputSchema: summarize.INPUT, outputSchema: summarize.OUTPUT, annotations: summarize.annotations,
  }, wrap(ctx, summarize.NAME, summarize.OUTPUT, args => summarize.summarizeController(ctx, args)));

  server.registerTool(list.NAME, {
    title: 'List controllers', description: list.DESCRIPTION,
    outputSchema: list.OUTPUT, annotations: list.annotations,
  }, wrap(ctx, list.NAME, list.OUTPUT, () => list.listControllers(ctx)));

  server.registerTool(status.NAME, {
    title: 'Controller status', description: status.DESCRIPTION,
    inputSchema: status.INPUT, outputSchema: status.OUTPUT, annotations: status.annotations,
  }, wrap(ctx, status.NAME, status.OUTPUT, args => status.getControllerStatus(ctx, args)));

  server.registerTool(position.NAME, {
    title: 'Robot position', description: position.DESCRIPTION,
    inputSchema: position.INPUT, outputSchema: position.OUTPUT, annotations: position.annotations,
  }, wrap(ctx, position.NAME, position.OUTPUT, args => position.getRobotPosition(ctx, args)));

  server.registerTool(io.NAME, {
    title: 'Read I/O signals', description: io.DESCRIPTION,
    inputSchema: io.INPUT, outputSchema: io.OUTPUT, annotations: io.annotations,
  }, wrap(ctx, io.NAME, io.OUTPUT, args => io.readIoSignals(ctx, args)));

  server.registerTool(events.NAME, {
    title: 'Event log', description: events.DESCRIPTION,
    inputSchema: events.INPUT, outputSchema: events.OUTPUT, annotations: events.annotations,
  }, wrap(ctx, events.NAME, events.OUTPUT, args => events.getEventLog(ctx, args)));

  server.registerTool(execution.NAME, {
    title: 'RAPID execution', description: execution.DESCRIPTION,
    inputSchema: execution.INPUT, outputSchema: execution.OUTPUT, annotations: execution.annotations,
  }, wrap(ctx, execution.NAME, execution.OUTPUT, args => execution.getRapidExecution(ctx, args)));

  server.registerTool(source.NAME, {
    title: 'Read RAPID source', description: source.DESCRIPTION,
    inputSchema: source.INPUT, outputSchema: source.OUTPUT, annotations: source.annotations,
  }, wrap(ctx, source.NAME, source.OUTPUT, args => source.readRapidSource(ctx, args)));

  server.registerPrompt(PROMPT_NAME, {
    title: 'Why did it stop?',
    description: PROMPT_DESCRIPTION,
    argsSchema: { controller: z.string().max(63).optional().describe('The daemon id of the controller (optional when the daemon has one).') },
  }, ({ controller }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: promptText(controller) } }],
  }));

  return server;
}
