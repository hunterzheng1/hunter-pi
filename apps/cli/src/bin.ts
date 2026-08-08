#!/usr/bin/env node

import {
  PI_PACKAGE_INSTALL_WORKER_ARGUMENT,
  runPiPackageInstallWorkerPayload,
} from "@hunter-pi/pi-host";

import { runHpiCli } from "./cli.js";

const arguments_ = process.argv.slice(2);
process.exitCode =
  arguments_[0] === PI_PACKAGE_INSTALL_WORKER_ARGUMENT
    ? await runPiPackageInstallWorkerPayload(arguments_[1])
    : await runHpiCli(arguments_);
