#!/usr/bin/env node

import { runHpiCli } from "./cli.js";

process.exitCode = await runHpiCli(process.argv.slice(2));
