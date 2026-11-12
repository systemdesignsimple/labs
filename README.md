# System Design Simple labs

The code behind the tests in the articles on [systemdesignsimple.com](https://systemdesignsimple.com). Each folder is one lab: the script, its saved output, and a README that says what it does and what it does not prove.

Most labs are simulations or local tests that run on your own machine with Node.js 22 or Python 3, offline and with no API keys. The security labs are read-only checks of your own setup: they report versions and settings and never attack anything. Two of them go online: node-brotli-check-lab downloads a Node.js release and its checksums from nodejs.org, and password-leak-check-lab sends only the first 5 characters of a SHA-1 hash to the Pwned Passwords range API.

Run one: `cd labs/<name>` and follow its README (usually `node run.mjs` or `python3 <name>.py`).

| Lab | Article |
|---|---|
| [`labs/failover-lab`](labs/failover-lab) | [Server failover: active-passive vs active-active](https://systemdesignsimple.com/main-server-dies-at-3am/) |
| [`labs/kv-cache-bench`](labs/kv-cache-bench) | [1,000 people ask AI at once. Who gets an answer first? KV cache and continuous batching](https://systemdesignsimple.com/1000-people-ask-ai-at-once/) |
| [`labs/ai-2`](labs/ai-2) | [Streaming AI replies: why text arrives before completion](https://systemdesignsimple.com/why-ai-starts-answering-before-done/) |
| [`labs/ai-3`](labs/ai-3) | [Context window: why a long AI chat forgets your name](https://systemdesignsimple.com/my-chat-forgot-my-name/) |
| [`labs/ai-4`](labs/ai-4) | [RAG retrieval: how AI finds one line in 100 pages](https://systemdesignsimple.com/how-ai-finds-one-line-in-100-pages/) |
| [`labs/ai-5`](labs/ai-5) | [AI can't see a clock. So how did it tell me the time?](https://systemdesignsimple.com/how-ai-tells-the-time-with-no-clock/) |
| [`labs/ai-6`](labs/ai-6) | [Prompt injection: why the AI obeyed a hidden line](https://systemdesignsimple.com/why-the-ai-obeyed-a-hidden-line/) |
| [`labs/ai-7`](labs/ai-7) | [AI agent tokens: why history makes total input grow](https://systemdesignsimple.com/why-an-ai-agent-re-sends-its-history/) |
| [`labs/ai-8`](labs/ai-8) | [AI agent permissions: would an agent delete my files?](https://systemdesignsimple.com/would-an-ai-agent-delete-my-files/) |
| [`labs/ai-9`](labs/ai-9) | [Did the AI leak my fake password? Secrets in AI prompts](https://systemdesignsimple.com/did-the-ai-leak-my-fake-password/) |
| [`labs/ai-10`](labs/ai-10) | [AI citation checks: the link opened, but the quote was missing](https://systemdesignsimple.com/ai-source-quote-wasnt-there/) |
| [`labs/ai-11`](labs/ai-11) | [Embeddings explained: why a search for car finds vehicle](https://systemdesignsimple.com/why-search-for-car-finds-vehicle/) |
| [`labs/ai-12`](labs/ai-12) | [HNSW vector search: how a photo search skipped 96% of 20,000 vectors](https://systemdesignsimple.com/how-search-skips-96-percent-of-vectors/)<br>[How recommendation systems work: retrieval and ranking](https://systemdesignsimple.com/how-ai-picks-what-to-watch/) |
| [`labs/ai-13`](labs/ai-13) | [MCP tool discovery: 3 new apps, 0 changes to the client code](https://systemdesignsimple.com/how-ai-learns-new-apps-tool-discovery/) |
| [`labs/ai-14`](labs/ai-14) | [Move 1 button: why a computer-use agent checks after every click](https://systemdesignsimple.com/move-one-button-can-ai-finish-the-task/) |
| [`labs/ai-15`](labs/ai-15) | [I interrupted the AI. Why did it keep talking? Voice AI barge-in explained](https://systemdesignsimple.com/i-interrupted-the-ai-why-did-it-keep-talking/) |
| [`labs/ai-17`](labs/ai-17) | [Same question 10 times, different answers. Which one passes? AI evals and guardrails](https://systemdesignsimple.com/same-question-ten-answers-which-passes/) |
| [`labs/ai-18`](labs/ai-18) | [1,000 people ask AI at once. Who gets an answer first? KV cache and continuous batching](https://systemdesignsimple.com/1000-people-ask-ai-at-once/) |
| [`labs/ai-19`](labs/ai-19) | [\"Hello\" went to a small AI, maths went to a big one. Who decided? Model routing in an LLM gateway](https://systemdesignsimple.com/who-decides-which-ai-answers-your-message/) |
| [`labs/ai-20`](labs/ai-20) | [Semantic cache: can AI safely reuse a similar answer?](https://systemdesignsimple.com/two-questions-look-alike-can-ai-reuse-the-answer/) |
| [`labs/ai-21`](labs/ai-21) | [Why does AI say \"too many requests\" after one message?](https://systemdesignsimple.com/why-ai-says-too-many-requests-after-one-message/) |
| [`labs/multi-tenancy`](labs/multi-tenancy) | [Multi-tenancy: pool vs silo, tenant context, and noisy neighbor limits](https://systemdesignsimple.com/one-app-many-restaurants-multi-tenancy/) |
| [`labs/sd-3`](labs/sd-3) | [Design Instagram's feed: system design in five steps](https://systemdesignsimple.com/design-instagram-feed/) |
| [`labs/sd-7`](labs/sd-7) | [The cable to Asia breaks. Your bank must choose: correct balance or an answer](https://systemdesignsimple.com/cable-to-asia-breaks/) |
| [`labs/sd-8`](labs/sd-8) | [Eventual consistency: stale likes and safe withdrawals](https://systemdesignsimple.com/like-count-wrong-balance-never/) |
| [`labs/sd-9`](labs/sd-9) | [99.9% uptime: 8.76 hours of downtime per year](https://systemdesignsimple.com/three-nines-8-hours-down/) |
| [`labs/sd-10`](labs/sd-10) | [Series vs parallel availability: two servers in a row](https://systemdesignsimple.com/two-servers-in-a-row/) |
| [`labs/sd-11`](labs/sd-11) | [Server failover: active-passive vs active-active](https://systemdesignsimple.com/main-server-dies-at-3am/) |
| [`labs/sd-12`](labs/sd-12) | [One database writes, ten read: primary and read replicas](https://systemdesignsimple.com/one-database-writes-ten-read/) |
| [`labs/sd-13`](labs/sd-13) | [What happens when you type google.com? DNS in depth](https://systemdesignsimple.com/you-type-google-com-100-ms/) |
| [`labs/sd-14`](labs/sd-14) | [CDN push vs pull: why Netflix doesn't buffer in Kathmandu](https://systemdesignsimple.com/why-netflix-doesnt-buffer-in-kathmandu/) |
| [`labs/sd-15`](labs/sd-15) | [Load balancer vs reverse proxy: one door, two jobs](https://systemdesignsimple.com/load-balancer-vs-reverse-proxy/) |
| [`labs/sd-16`](labs/sd-16) | [Load balancing algorithms: which server gets your request?](https://systemdesignsimple.com/which-server-gets-your-request/) |
| [`labs/sd-17`](labs/sd-17) | [Layer 4 vs Layer 7 Load Balancer: Internals and Trade-offs](https://systemdesignsimple.com/layer-4-vs-layer-7-load-balancer/) |
| [`labs/sd-18`](labs/sd-18) | [Vertical vs horizontal scaling: one server or eight?](https://systemdesignsimple.com/vertical-vs-horizontal-scaling/) |
| [`labs/sd-19`](labs/sd-19) | [Monolith vs microservices: fault isolation and its cost](https://systemdesignsimple.com/monolith-vs-microservices/) |
| [`labs/sd-20`](labs/sd-20) | [Service discovery: how 500 services find each other](https://systemdesignsimple.com/service-discovery/) |
| [`labs/sd-21`](labs/sd-21) | [SQL vs NoSQL: choose the data shape first](https://systemdesignsimple.com/sql-or-nosql-wrong-question/) |
| [`labs/sd-60`](labs/sd-60) | [Login anomaly detection: why our 3 a.m. alarm was mostly wrong](https://systemdesignsimple.com/login-anomaly-detection-3am-rule/) |
| [`labs/sd-61`](labs/sd-61) | [Publish/subscribe: why 2 ms jobs waited 31 seconds behind one slow service](https://systemdesignsimple.com/publish-subscribe-one-slow-service/) |
| [`labs/security/apt-signature-lab`](labs/security/apt-signature-lab) | [How apt proves a package is genuine, and how to check and fix CVE-2026-109518](https://systemdesignsimple.com/apt-package-signature-flaw-check-and-fix/) |
| [`labs/security/node-brotli-check-lab`](labs/security/node-brotli-check-lab) | [How to check and fix the Node.js Brotli decoder flaw (CVE-2026-111497) in the process that serves traffic](https://systemdesignsimple.com/nodejs-brotli-rce-check-and-fix/) |
| [`labs/security/nodejs-security-lab`](labs/security/nodejs-security-lab) | [Node.js security: 4 common vulnerabilities we reproduced and fixed](https://systemdesignsimple.com/nodejs-security-common-vulnerabilities/) |
| [`labs/security/openssh-auth-check-lab`](labs/security/openssh-auth-check-lab) | [Alpine and musl sshd without PAM: check for the OpenSSH 10.6p2 password bypass and fix it](https://systemdesignsimple.com/openssh-long-password-auth-bypass-check/) |
| [`labs/security/password-leak-check-lab`](labs/security/password-leak-check-lab) | [How a leaked password check works without sending the full password](https://systemdesignsimple.com/is-my-password-leaked-how-the-check-works/) |
| [`labs/security/python-security-lab`](labs/security/python-security-lab) | [Python security: 4 common vulnerabilities we reproduced and fixed](https://systemdesignsimple.com/python-security-common-vulnerabilities/) |
| [`labs/security/rails-upload-lab`](labs/security/rails-upload-lab) | [How to check Rails image uploads and lock down ImageMagick (GHSA-f3w6-w445-fwh9)](https://systemdesignsimple.com/rails-imagemagick-upload-flaw-check-and-fix/) |
| [`labs/security/sql-injection-lab`](labs/security/sql-injection-lab) | [What is SQL injection and how to prevent it: bound parameters, tested in a PHP lab](https://systemdesignsimple.com/what-is-sql-injection-and-how-to-prevent-it/) |
| [`labs/security/wordpress-upgrade-check-lab`](labs/security/wordpress-upgrade-check-lab) | [How to check WordPress for CVE-2026-119977: the version, the auto-update blockers and the upgrade folder](https://systemdesignsimple.com/wordpress-core-upgrade-flaw-check-and-fix/) |
| [`labs/security/php2shell-check-lab`](labs/security/php2shell-check-lab) | [How to check the PHP build your web server runs and fix CVE-2026-109618 and CVE-2026-109619](https://systemdesignsimple.com/php-rce-php2shell-check-and-fix/) |
| [`labs/thousand-agents-push-one-repo`](labs/thousand-agents-push-one-repo) | [How thousands of writers update one repository: objects first, refs last](https://systemdesignsimple.com/thousand-agents-push-one-repo/) |

Licence: MIT. Numbers in the articles come from the saved output files here; a rerun on other hardware gives different timings.
