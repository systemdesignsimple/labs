# ai-9 supporting notes

Material moved out of the article "Did the AI leak my fake password?" when it was cut to the short format
(2026-11-07). The runnable redactor is `redact.mjs` in this folder (`node labs/ai-9/redact.mjs`). Numbers marked
assumed are assumptions, not measurements.

## Answer counts against the assumed chances

Each run is a Bernoulli trial, so the variance of a count over 10 runs is 10 x p x (1 - p).

```text
password  expected = 10 x (0.1 + 0.8 + 0.6 + 0.3) = 18      observed 22
          variance = 10 x (0.09 + 0.16 + 0.24 + 0.21) = 7.0  sd = 2.65   (22 - 18) / 2.65 = 1.5 sd
phone     expected = 10 x (0.2 + 0.1 + 0.4 + 0.3) = 10      observed 13
          variance = 10 x (0.16 + 0.09 + 0.24 + 0.21) = 7.0  sd = 2.65   (13 - 10) / 2.65 = 1.1 sd
```

Both are within normal noise for 40 trials. The what-i-need phone count (6 of 10 at an assumed 0.3) is the luckiest
cell: 3 expected, sd = sqrt(10 x 0.3 x 0.7) = 1.45, about 2.1 sd above. Another seed prints different answer counts
and identical prompt and log counts.

## A gateway path with limits and numbers

Nginx terminates TLS and enforces size, time and concurrency limits; a small redaction service on `127.0.0.1`
parses and redacts; an egress firewall lets only that service reach the provider.

```nginx
# http context
log_format ai_meta '$time_iso8601 $request_id $request_method $uri $status '
                   '$request_length $bytes_sent $request_time $upstream_response_time';
limit_conn_zone $server_name zone=ai_conn:1m;

server {
    listen 443 ssl;
    access_log /var/log/nginx/ai_gateway.log ai_meta;  # no $request (query string), no $request_body
    limit_conn ai_conn 200;          # in-flight cap; over it: 503 (default limit_conn_status)
    client_max_body_size    256k;    # bigger bodies: 413, never proxied
    client_body_buffer_size 256k;    # accepted bodies stay in memory, never in a temp file
    client_body_timeout     10s;     # max gap between two body reads: 408
    location /v1/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_request_buffering on;  # the default: read the whole body before proxying
        proxy_read_timeout 120s;     # max gap between two upstream reads, not a total
    }
}
```

Documented behaviour behind it: [core](https://nginx.org/en/docs/http/ngx_http_core_module.html),
[log](https://nginx.org/en/docs/http/ngx_http_log_module.html), [proxy](https://nginx.org/en/docs/http/ngx_http_proxy_module.html).

1. Body buffering. The default `client_body_buffer_size` is two memory pages (8 KiB on x86-64). A larger body is
   written, whole or in part, to a temporary file: a plaintext prompt on disk. A buffer equal to the 256 KiB cap keeps
   accepted bodies in memory. In HTTP/2 each concurrent request counts as a separate connection for `limit_conn`.
2. Decompression. Nginx does not decompress request bodies, so a gzip request reaches the redactor compressed and a
   regex over deflate bytes finds nothing. Reject any `Content-Encoding` with 415, or inflate with a cap. Deflate
   reaches about 1032:1 at most ([zlib technical details](https://zlib.net/zlib_tech.html)), so 256 KiB can inflate to
   about 256 KiB x 1032 = 264,192 KiB, roughly 258 MiB. Node's zlib `maxOutputLength` fails instead of allocating past
   the cap; set 1 MiB and answer 413.
3. Parsing and schema. `JSON.parse` has no size option, so the byte caps are the parse limit. Its `SyntaxError` message
   can quote input, so return and log a fixed string. Validate against an explicit schema, reject unknown fields and
   part types with 422, and build the outgoing object from the allowed fields only.
4. Redaction before forwarding. Redact decoded strings, serialize the rebuilt object, send only that. A timer cannot
   interrupt a synchronous regex that is backtracking: run the scan in a worker thread and terminate it at the budget,
   or use a linear-time engine such as RE2.
5. Errors fail closed with a status, a fixed code and the request id; nothing from the input is interpolated.
6. Logs carry metadata only.

Capacity, input side only (assumed rows are assumptions):

```text
Peak requests in flight (assumed)        C = 200
Body cap (client_max_body_size)          B = 256 KiB
Nginx input buffers                      C x B = 200 x 256 KiB = 51,200 KiB = 50 MiB
Copies per request in the redactor       k = 4 (assumed): raw Buffer, decoded string,
                                         parsed object, redacted serialized string
Redactor working set                     C x B x k = 50 MiB x 4 = 200 MiB
Same with gzip accepted, 1 MiB cap       C x 1 MiB x k = 200 x 1 MiB x 4 = 800 MiB
Restore maps (assumed 10,000 live        10,000 x 50 values x 200 bytes = 100,000,000 bytes,
sessions, 50 values, 200 bytes each)     about 95 MiB, held until session expiry
```

This excludes response buffers, TLS state and object overhead; replace k with a load-test number.

| Condition | Rejected by | Status | What it usually means |
|---|---|---|---|
| Body over 256 KiB | Nginx | 413 | Long agent histories; trim context |
| Over 10 s between body reads | Nginx | 408 | Slow or stalled client |
| More than 200 in flight | Nginx `limit_conn` | 503 | Load above the assumed capacity |
| Unaccepted encoding, or inflates past 1 MiB | Redactor | 415 or 413 | Compressed bodies or a decompression bomb |
| Invalid JSON | Redactor | 400, fixed code | Client bug |
| Unknown field or part type | Redactor | 422, fixed code | A content type the schema does not cover yet |
| Scan over its time budget | Redactor | 503, nothing forwarded | Pathological input or a backtracking pattern |

## Streaming

- Restore buffer. A placeholder can arrive split across chunks. Tokens have a known maximum length, so holding back
  fewer characters than that, and only while they could still start a token, makes restore correct.
- Detection buffer. Buffer the complete response for these detectors. A streaming implementation must detect
  overlong candidates and reject them before releasing any part of the candidate. Patterns ending in `\S+` have no
  maximum match length, so no fixed holdback is enough. We do not recommend a bounded-match streaming variant until
  its algorithm is demonstrated.

## Placeholders and restore

After the reply arrives, a local map turns placeholders back into values. That map holds every real value, so it
stays in the memory of the process that redacted and never goes into a log, a trace or a prompt. `redact.mjs` has no
expiry: production code must add session expiry, reject operations after expiry and clear the maps when the session
ends.

Each value's class is stored beside it. If a phone placeholder comes back later as `ADMIN_PASSWORD=<PHONE_TAG_2>`,
the redactor resolves it to its entry and promotes the class to SECRET, keeping the spelling so references stay
stable. Restores read the stored class, the destination and who is asking. Personal data can be restored into text
the session owner reads, nothing is restored into a tool call, and the general restore function never returns a
secret. Injected text can ask the model to put a secret placeholder into a URL to an outside host, and an automatic
restore would complete the exfiltration.

Writing a secret back into a file needs a grant. The session keeps each grant record in a private `WeakMap` and gives
the caller an empty frozen handle. The write function deletes the record, then creates one owner-only file with the
`wx` flag at the stored path, so a reused, edited or foreign handle writes nothing.

Before the entropy scan, `withoutIssued` removes the placeholders the session actually issued: their random tag can
score above 4.0 bits per character on some runs. Entropy also flags harmless random strings; a flag does not establish
that a value is a credential.

The session tag is 16 random bytes (`redact.mjs`). It gives collision resistance only. A placeholder the session
issued is visible in the conversation, so it can be copied or replayed; the tag does not authorize a restore.
Restore decisions come from the stored class, the destination policy and the owner check, and secrets are restored
only through a single-use grant held privately by the session. The local write assumes the approved directory and its
parents are writable only by you: the realpath check runs once and does not stop a directory being swapped for a
symlink before the write.

## In an interview

1. Clarify: what data flows in (files, chats, retrieved documents, tool output), which providers, what is logged.
2. Assumptions: users will paste secrets; context is assembled automatically; any detector misses some formats.
3. Structure: scope context first, then a pre-send redactor at the client and an egress gateway, session-stable
   placeholders, a local restore map, response scanning, redacted logs with short retention.
4. Deep dive: detector layers and their blind spots, restore rules per stored class and sink, authorized secret
   writes, placeholder reuse, streaming restore versus streaming detection.
5. Trade-offs: recall vs false positives, client vs gateway, stable vs random tokens.
6. Wrap up: canary hits per sink (target 0), detector recall on a test corpus, required-facts pass rate, time to rotate.

## Practice

- The reply did not contain the password. Why can it still have leaked? It was in the request that was sent.
- Why use one placeholder for both copies of the password? So the model can see they are one value.
- A strict `> 4.0` bits per character entropy test never catches what? Hex-only secrets: log2 16 = 4.0 is the
  maximum. A `>= 4.0` test can match a perfectly balanced hex string.
- Why must restore never expand a secret inside a tool call? Injected text can put the placeholder in a URL to an
  outside host, and an automatic restore would send the real value.
- You redact at the gateway. Two ways plaintext still reaches a log? Body logging before the redaction step, and an
  error handler that attaches the original request.
- How do you know redaction did not break the feature? A required-facts suite with controls that must pass on changed
  facts and fail when the source files are removed.
