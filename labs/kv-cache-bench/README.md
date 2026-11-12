# kv-cache-bench: why 1,000 people get AI answers faster with a KV cache

In our simulation of 1,000 people asking one AI at once, the median wait for the first token was:

| Setup | Median wait for the first token |
|---|---|
| One request at a time, no KV cache | 7.5 minutes |
| KV cache plus continuous batching | 14 seconds |

In the single-answer test on this tiny model, generating with the KV cache off took 14.5 times as long as with it on (567.1 ms vs 39.2 ms median).

## Run it

```sh
node --version   # Node 22 or newer
node run.mjs     # about 10 seconds, standard library only; prints the results, writes chart.svg and ttft.csv
                 # results.json holds our reference run; chart.svg shows time to first token
```

A small simulated model shows the shape of the effect, not the speed of any real service.

How it works, settings and limits: [METHOD.md](METHOD.md). Your numbers will differ a little by machine (timings are measured).

Full article: https://systemdesignsimple.com/1000-people-ask-ai-at-once/

From System Design Simple, system design explained simply with our own labs.

License: MIT.
