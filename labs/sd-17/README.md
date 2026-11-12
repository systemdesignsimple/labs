# sd #17 lab: Reading the envelope vs reading the letter

Layer 4 vs layer 7 load balancing.

## The question

When a client sends many requests over one kept-open connection, what does an L7 balancer do
differently from an L4 balancer? And how much extra processing work does the L7 path do per
request, measured on this machine?

## How to run

```
node run.mjs
```

Node.js 22, standard library only. No npm install, no network, no extra files. It usually finishes
in a few seconds (well under 60) and ends with one `RESULT {...}` line.

## What it does

Everything runs inside one Node process. There are no real sockets.

- **Backends A and B** parse the HTTP bytes they receive and count the requests they serve.
- **Clients** write real HTTP/1.1 request bytes (path, Host, User-Agent, Cookie and so on) and cut
  them into random TCP-sized segments, so one segment can hold half a request or several requests.
- **L4 balancer (the envelope):** when a connection opens, it hashes the source IP and port and
  picks a backend. After that it copies every segment through without reading it. One decision per
  connection.
- **L7 balancer (the letter):** it runs an HTTP parser over the stream, finds each request, reads
  its path, picks a backend per request (round robin, except `/images/*` always goes to B), and
  writes a new upstream request with an `X-Forwarded-For` header. One decision per request.

### Part 1: routing (repeats exactly, seed 17)

Three tests, each run through both balancers with the same bytes:

1. 1,000 requests over 1 kept-open connection
2. 1,000 requests over 50 new connections
3. 1,000 requests over 50 connections, about 30% of them `/images/...`, the rest `/api/...`

### Part 2: measured processing time (changes by machine and run)

One seeded stream of 2,000 requests on one connection, cut into the same segments every time, is
pushed through four paths:

| path      | what it does per request                                         |
|-----------|------------------------------------------------------------------|
| `direct`  | backend parses the bytes                                         |
| `L4`      | copy the bytes to the upstream, table lookup, backend parses     |
| `L7parse` | parse the request, pick a backend, copy the original bytes, backend parses |
| `L7full`  | parse, pick, rebuild the request with `X-Forwarded-For`, backend parses   |

Each path gets 40 untimed warmup rounds, then 200 timed rounds. The paths take turns in a rotating
order so none always runs first. Each round gives one number: elapsed `performance.now()` time
divided by 2,000 requests. The lab reports the median and p90 of those 200 numbers.

The L7 cost over L4 is then split into measured parts:

- **parse + route** = `L7parse` minus `L4` (both copy bytes; L7 also reads them and decides)
- **rebuild** = `L7full` minus `L7parse` (writing a new request instead of a plain copy)
- **total proxy overhead** = `L7full` minus `L4`, the sum of the two

## What it shows

- **One kept-open connection:** L4 makes 1 decision, so all 1,000 requests land on one backend
  (1000/0). L7 makes 1,000 decisions and splits them 500/500.
- **Many new connections:** both spread the load fairly evenly, because L4 now gets many
  envelopes to decide on.
- **Path rule:** only L7 sends 100% of `/images` requests to B. L4 never sees the path, so it gets
  about half of them right by chance.
- **Cost of reading the letter:** the L7 path does more processing work per request than L4. The output
  shows how big that gap is in nanoseconds on this machine, and how much of it comes from parsing
  and routing versus rebuilding the request.

## Limits (please read)

- This is a **simulation**. It shows the shape of the effect, not production numbers.
- The routing results come from real code over real HTTP bytes and repeat exactly (seed 17).
- The timing numbers are **real measurements of this JavaScript code on this machine**. They change
  from machine to machine and a little from run to run (JIT, garbage collection, other apps,
  CPU frequency). Small differences, especially the two parts, can come out near zero or even
  negative because of noise. Compare the paths with each other, not with real products.
- The timing is **in-process processing time, not request latency**. There is no network, no waiting
  for a backend, and no response path. A real L7 proxy also reads every response, which is not
  measured here. In a real system, network hops and backend work are usually much bigger than
  these nanoseconds.
- p90 is taken over 200 batch averages of 2,000 requests each. It shows run-to-run spread, not the
  slowest single request.
- Connection setup (TCP and TLS handshakes) is not included. In real life L7 balancers usually end
  TLS too, which costs more than parsing HTTP.
- Real L4 balancers run in the kernel or in hardware and are much faster than any JavaScript proxy.
  Real L7 proxies (written in C, C++ or Rust) are also much faster than this parser.
- HTTP/1.1 GET only, no bodies, no HTTP/2. With HTTP/2 or gRPC, one connection carries even more
  requests, which makes the L4 "one decision per connection" problem bigger.
