#!/usr/bin/env bun
import { executarCli } from "./cli/programa";

void executarCli(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
