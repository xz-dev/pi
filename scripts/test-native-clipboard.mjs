#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const [helperPath] = process.argv.slice(2);
if (!helperPath) throw new Error("Usage: test-native-clipboard.mjs <native-helper>");
const helper = createRequire(import.meta.url)(resolve(helperPath));
assert.equal(typeof helper.getText, "function", "native getText export missing");
assert.equal(typeof helper.getImage, "function", "native getImage export missing");
// undefined means the native backend was unavailable, not an empty clipboard.
// Run only against the CI desktop or an isolated X11 display; never print data.
const text = await helper.getText();
assert.ok(text === null || typeof text === "string", "native text read unavailable or malformed");
const image = await helper.getImage();
assert.ok(image === null || image instanceof Uint8Array, "native image read unavailable or malformed");
console.log(JSON.stringify({ textRead: true, imageRead: true }));
