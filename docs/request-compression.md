# Request compression

Pi compresses model uploads to reduce network traffic without changing the JSON,
text or image data the endpoint receives. It is automatic in supported senders;
there is no compression setting to enable.

Using the independent OpenAI provider extension? See its
[compression guide](https://github.com/xz-dev/openai-api-pi-extension/blob/main/docs/request-compression.md)
for host requirements and transport integration.

## Where it applies

| Connection | Mechanism |
| --- | --- |
| Native Responses, Chat Completions, Azure Responses, Anthropic Messages and Codex HTTP | Compress eligible buffered JSON `POST` bodies |
| Node/Bun Responses WebSockets | Negotiate WebSocket `permessage-deflate` |
| OpenAI API plugin | Reuse these host helpers at its final network sender |

This is not a global `fetch` patch. Custom transports own their send path; JSON
parsing and routing must happen before HTTP compression. Already-encoded,
non-JSON, streaming and recognized signed requests bypass the HTTP encoder.
Unprofitable compression sends the original body and does not mark the endpoint
as incompatible.

## See the active algorithm

The default Working indicator appends the actual compression algorithm after the
protocol, separated by one space: `Working(SSE Zstd)`,
`Working(SSE gzip)`, or `Working(WS/continuation DEFLATE)`.
Display names are `Zstd`, `gzip`, `DEFLATE` and `Brotli`; HTTP encoding values
remain `zstd`, `gzip`, `deflate` and `br`.

HTTP reports the final upload encoding after any explicit-refusal fallback, not
the response's encoding or advertised capabilities. WebSockets show `DEFLATE`
only when `permessage-deflate` was negotiated, including reused connections.
Uncompressed requests and transports whose compression cannot be observed keep
the original protocol label. Custom extension working messages remain unchanged.
This describes Pi's connection to its endpoint, not a proxy's upstream hop.

## HTTP: try first, remember refusals

An unknown endpoint starts with `zstd`. The official `api.anthropic.com` host
starts with `gzip`. A successful response does not need to advertise
`Accept-Encoding` before Pi attempts a compressed request.

| Order | Encoding | Level |
| --- | --- | --- |
| 1 | zstd | 3 |
| 2 | gzip | 4 |
| 3 | deflate | 4 |
| 4 | Brotli (`br`) | 4 |
| 5 | identity | Uncompressed |

Only an explicit request-encoding refusal permits an attempt with the next
encoding: a `415` carrying `Accept-Encoding`, or a bounded `400`/`415` diagnostic
that identifies an encoding refusal. A generic JSON error or a media-type-only
`415` is not enough.

Authentication errors, rate limits, server errors, network failures, cancellation
and started responses do not authorize compression-specific replay. Their
ordinary error and retry handling stays in place. An ambiguous rejection is
surfaced rather than risking another inference.

The host remembers a downgrade by endpoint path and credentials in process
memory. It does not retry a rejected encoding later in that process, even if a
wrapper or session is recreated. Nothing is written to settings or session
files; a new process starts with fresh capability state.

## WebSocket: negotiate, do not encode application JSON

WebSocket compression is separate from HTTP `Content-Encoding`. A negotiated
`permessage-deflate` extension compresses frames; application messages remain
Responses JSON, not gzip or zstd blobs.

The shared host policy remembers an endpoint's declined extension for the
credential scope until process exit. This does not change connection recovery,
SSE fallback, checkpoint eligibility or replay boundaries.

## Compression is not context storage

Compression reduces transfer bytes, not model tokens. It does not resize or
re-encode images, remove context, promise a prompt-cache hit or guarantee lower
time to first token.

[Response checkpoints](downstream-changes.md#response-checkpoints) are a different
feature: they can request remote `store: true` and reuse server-side state.
Compression neither enables that policy nor changes its retention rules.

## Compatibility and checks

The first downstream release with these helpers is
[1.3.0-xz.320.1.ge10c8c68](https://github.com/xz-dev/pi/releases/tag/xz-v1.3.0-xz.320.1.ge10c8c68).
An accepting gateway was verified with one synthetic zstd inference POST despite
omitting response `Accept-Encoding`. That is not a guarantee for every provider,
account, proxy or codec. Some gateways return an ambiguous malformed-JSON error
instead of an explicit encoding refusal; Pi preserves that error.

Implementation and regression coverage:

- [HTTP helper](../packages/ai/src/utils/request-compression.ts) and
  [refusal/byte-preservation tests](../packages/ai/test/request-compression.test.ts).
- [WebSocket policy](../packages/ai/src/utils/websocket-compression.ts) and
  [negotiation tests](../packages/ai/test/websocket-compression.test.ts).
- [Native loopback transport tests](../packages/ai/test/request-compression-loopback.test.ts).
- [Plugin integration and host requirements](https://github.com/xz-dev/openai-api-pi-extension/blob/main/docs/request-compression.md).

The implementation lives on
[`patch/request-compression`](https://github.com/xz-dev/pi/tree/patch/request-compression);
root documentation is maintained on `ci` and carried into `main` by Sync.
