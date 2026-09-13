#!/usr/bin/env node
// Import order is load-bearing: usage-claim-bootstrap must be evaluated
// before any module that could consume bundle resources (see the module's
// comment and design.md D3).
import "./usage-claim-bootstrap.ts";
import "./sandbox-env-setup.ts";
import "./runtime-setup.ts";
import "../cli.ts";
