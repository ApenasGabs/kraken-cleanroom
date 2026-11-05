#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { CORE_VERSION } from "@cleanroom/core";
import { MCP_SERVER_NAME } from "@cleanroom/mcp-server";

export const CLI_NAME = "cleanroom";
export const CLI_VERSION = CORE_VERSION;

export function formatHelpText(): string {
  return [
    `${CLI_NAME} v${CLI_VERSION} (${MCP_SERVER_NAME})`,
    "",
    "Usage: cleanroom <command> [options]",
    "",
    "Commands:",
    "  init <url>           Generate a cleanroom.yaml manifest with safe defaults",
    "  validate <manifest>  Validate a cleanroom.yaml manifest",
    "  doctor               Check environment and dependencies",
    "",
    "Options:",
    "  -h, --help           Display this help message",
    "  -v, --version        Display CLI version",
  ].join("\n");
}

export function runCli(argv: readonly string[]): number {
  if (argv.includes("-v") || argv.includes("--version")) {
    process.stdout.write(`${CLI_VERSION}\n`);
    return 0;
  }

  process.stdout.write(`${formatHelpText()}\n`);
  return 0;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = runCli(process.argv.slice(2));
}
