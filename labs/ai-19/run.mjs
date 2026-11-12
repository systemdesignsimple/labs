// AI #19 lab: a tiny LLM gateway that routes each prompt to a small or a big model.
// Node.js 22 ESM, standard library only. No network, no files, no child processes.
// Everything except the routing-time measurement is deterministic.

// ---------------------------------------------------------------------------
// Assumptions (edit these and re-run). This is an ILLUSTRATIVE cost model:
// prices are assumed tiers (not an attributed, dated price sheet), input
// tokens are estimated as chars/4 and output tokens are assumed per label.
// Nothing here is a measured bill or a counted token.
// ---------------------------------------------------------------------------
const PRICES = {
  // USD per 1,000,000 tokens. Assumed illustrative tiers, not one vendor's prices.
  small: { in: 0.15, out: 0.6 },
  big: { in: 3.0, out: 15.0 },
};
const OUTPUT_TOKENS = { easy: 60, hard: 500 }; // assumed reply length per label
const LATENCY = {
  // first-token delay (ms) + generation speed (tokens per second), assumed
  small: { firstMs: 250, tokPerSec: 150 },
  big: { firstMs: 700, tokPerSec: 50 },
};
// Hypothetical escalation model. It uses the ground-truth label to decide which
// prompts can fail, assumes easy prompts on small never fail, assumes the big
// model always succeeds and ignores the checker's own cost and latency.
const P_SMALL_FAILS_HARD = 0.6; // assumed: small model gets a hard prompt wrong
const P_FAILURE_DETECTED = 0.8; // assumed: a checker notices and escalates to big
const BIG_SCORE = 2; // route to big when score >= this
const LONG_CHARS = 280; // long message adds 1 point
const TIMING_REPS = 2000; // routing-time measurement: 60 prompts x this

// ---------------------------------------------------------------------------
// The prompt set: 60 everyday prompts, hand-labelled easy or hard.
// ---------------------------------------------------------------------------
const E = (text) => ({ text, label: "easy" });
const H = (text) => ({ text, label: "hard" });

const PROMPTS = [
  E("Hello!"),
  E("hi there, how are you?"),
  E("Good morning"),
  E("Thanks, that helped a lot."),
  E("What is the capital of Japan?"),
  E("How many days are in a week?"),
  E("Translate 'thank you' into Spanish."),
  E("Rewrite this to sound more polite: send me the file now."),
  E("Fix the spelling: I recieved your mesage yesterday."),
  E("Give me a synonym for happy."),
  E("What does CPU stand for?"),
  E("Summarise in one line: The meeting moved from Monday to Tuesday because the room was booked."),
  E("Is it safe to eat raw carrots?"),
  E("Suggest a name for a grey cat."),
  E("What time zone is Tokyo in?"),
  E("Make this shorter: I just wanted to quickly reach out and check in to see if you had a chance to look at my email."),
  E("Who wrote Romeo and Juliet?"),
  E("What is 2 + 2?"), // edge case: easy, but has a maths symbol
  E("Write a birthday message for my friend."),
  E("How do you say good night in French?"),
  E("Turn this into a bullet list: eggs, milk, bread, rice."),
  E("What colour do you get mixing blue and yellow?"),
  E("Is a tomato a fruit?"),
  E("Give me three ideas for a weekend walk."),
  E("Explain what Wi-Fi is in one sentence."),
  E("What's the opposite of ancient?"),
  E("Can you make this sound friendlier: Meeting cancelled."),
  E("Recommend a simple breakfast."),
  E("What year did the first iPhone come out?"),
  E("Correct the grammar: she don't like coffee."),
  // edge case: long but simple, and it happens to say "step by step"
  E(
    "Hi, I wrote a thank-you note for my neighbours who looked after our dog while we were away last week. " +
      "They fed her, walked her twice a day and even sent us photos every evening, which was really kind. " +
      "Here is my note: thanks for helping with the dog, we owe you one. Please go through it step by step " +
      "and make each sentence a bit warmer, but keep it short and simple.",
  ),
  E("What is the plural of mouse?"),
  E("Define the word 'latency'."),
  E("Say hello to my team in a fun way."),
  E("Which is bigger, a cat or an elephant?"),
  E("What's a good title for a photo of a sunset?"),
  E("Remind me what HTML stands for."),
  E("Convert this to title case: the quick brown fox"),
  E("How do I pronounce 'quinoa'?"),
  E("Write one line to say I will be late today."),
  E("Ok great, bye!"),
  E("My order number is 48213, can you write a short message asking where it is?"),

  H("Solve for x: 3x + 7 = 2x - 5, and show each step."),
  H("A train leaves at 14:20 going 80 km/h and another leaves at 15:05 going 110 km/h on the same track. When does the second one catch up? Explain step by step."),
  H("```js\nconst a = ['1','2','3'].map(parseInt)\nconsole.log(a)\n```\nWhy does this print [1, NaN, NaN]?"),
  H("Debug this: my Python loop never ends when I remove items from the list while iterating over it."),
  H("Prove that the square root of 2 is irrational."),
  H("Design a URL shortener that handles 10,000 writes per second and explain the trade-offs."),
  H("Write a SQL query that returns the top 3 customers by total spend for each month."),
  H("What is the probability of getting at least two sixes in five dice rolls?"),
  H("Compare optimistic and pessimistic locking and say when each one breaks."),
  H("Write a regex that matches valid IPv4 addresses only."),
  // edge case: short tricky riddle, no maths symbols
  H("A bat and a ball cost 1.10 together. The bat costs 1.00 more than the ball. How much is the ball?"),
  // edge case: short logic puzzle
  H("If all bloops are razzies and all razzies are lazzies, are all bloops lazzies? Why?"),
  H("Refactor this so it does not hit the database inside the loop: ```for u in users: db.get(u.id)```"),
  H("Calculate the monthly payment on a 200000 loan at 5% interest over 30 years."),
  H("Plan a migration from one database to another with zero downtime."),
  H("Explain why my React component renders twice and how to stop it."),
  // edge case: short, looks trivial, models often miscount
  H("How many times does the letter r appear in 'strawberry raspberry'?"),
  H("Read this stack trace and tell me the root cause: TypeError: Cannot read properties of undefined (reading 'map') at List.render (List.jsx:14)"),
];

// ---------------------------------------------------------------------------
// The gateway: cheap signals only, no model call.
// ---------------------------------------------------------------------------
const MATH_EXPR = /\d+(?:\.\d+)?\s*[-+*/^=×÷]\s*\d+/;
const MATH_WORDS = /\b(solve|calculate|integral|derivative|equation|probability)\b/i;
const CODE_FENCE = /```/;
const CODE_WORDS = /\b(debug|refactor|sql|regex|stack trace|function|compile)\b/i;
const REASON_WORDS = /\b(prove|step by step|explain why|compare|trade-offs?|design|plan)\b/i;

function route(text) {
  let score = 0;
  if (text.length > LONG_CHARS) score += 1;
  if (MATH_EXPR.test(text) || MATH_WORDS.test(text)) score += 2;
  if (CODE_FENCE.test(text) || CODE_WORDS.test(text)) score += 2;
  if (REASON_WORDS.test(text)) score += 2;
  return score >= BIG_SCORE ? "big" : "small";
}

// ---------------------------------------------------------------------------
// Cost and latency helpers
// ---------------------------------------------------------------------------
const inputTokens = (text) => Math.ceil(text.length / 4); // rough chars/4 rule
const cost = (model, tin, tout) => (tin * PRICES[model].in + tout * PRICES[model].out) / 1e6;
const latency = (model, tout) => LATENCY[model].firstMs + (tout / LATENCY[model].tokPerSec) * 1000;

// ---------------------------------------------------------------------------
// Run the 60 prompts through the gateway
// ---------------------------------------------------------------------------
let correct = 0, easyToBig = 0, hardToSmall = 0, toSmall = 0;
let costAllBig = 0, costRouted = 0, costEscalated = 0;
let latAllBig = 0, latRouted = 0, latEscalated = 0;
let expectedWrong = 0, expectedWrongEsc = 0;
const misses = [];

for (const p of PROMPTS) {
  const choice = route(p.text);
  const want = p.label === "hard" ? "big" : "small";
  const tin = inputTokens(p.text);
  const tout = OUTPUT_TOKENS[p.label];

  costAllBig += cost("big", tin, tout);
  latAllBig += latency("big", tout);
  costRouted += cost(choice, tin, tout);
  latRouted += latency(choice, tout);

  if (choice === "small") toSmall++;
  if (choice === want) correct++;
  else if (p.label === "easy") { easyToBig++; misses.push(["easy -> big", p.text]); }
  else { hardToSmall++; misses.push(["hard -> small", p.text]); }

  // Hypothetical escalation (expected values, so no randomness needed). Uses the
  // TRUE label: only label=hard prompts routed small can fail (P_SMALL_FAILS_HARD);
  // an assumed checker catches P_FAILURE_DETECTED of them and re-asks the big model,
  // which is assumed to succeed. Checker cost and latency are not included.
  if (p.label === "hard" && choice === "small") {
    const pEsc = P_SMALL_FAILS_HARD * P_FAILURE_DETECTED;
    expectedWrong += P_SMALL_FAILS_HARD;
    expectedWrongEsc += P_SMALL_FAILS_HARD * (1 - P_FAILURE_DETECTED);
    costEscalated += cost("small", tin, tout) + pEsc * cost("big", tin, tout);
    latEscalated += latency("small", tout) + pEsc * latency("big", tout);
  } else {
    costEscalated += cost(choice, tin, tout);
    latEscalated += latency(choice, tout);
  }
}

// ---------------------------------------------------------------------------
// Measure how long the routing decision itself takes (machine-dependent)
// ---------------------------------------------------------------------------
let sink = 0;
for (let r = 0; r < 200; r++) for (const p of PROMPTS) sink += route(p.text).length; // warm-up
const t0 = process.hrtime.bigint();
for (let r = 0; r < TIMING_REPS; r++) for (const p of PROMPTS) sink += route(p.text).length;
const t1 = process.hrtime.bigint();
const decisions = TIMING_REPS * PROMPTS.length;
const usPerDecision = Number(t1 - t0) / 1000 / decisions;
if (sink === -1) console.log(""); // keep the loop from being optimised away

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const n = PROMPTS.length;
const nEasy = PROMPTS.filter((p) => p.label === "easy").length;
const nHard = n - nEasy;
const per1000 = (x) => (x / n) * 1000;
const r2 = (x) => Math.round(x * 100) / 100;
const r1 = (x) => Math.round(x * 10) / 10;

const accuracy = (correct / n) * 100;
const saving = (1 - costRouted / costAllBig) * 100;
const savingEsc = (1 - costEscalated / costAllBig) * 100;

console.log("AI #19 lab: who picks the model? A simple gateway rule");
console.log(`Prompts: ${n} (${nEasy} easy, ${nHard} hard). Rule: score >= ${BIG_SCORE} goes to big.`);
console.log("");
console.log(`Agrees with label:           ${correct}/${n} (${r1(accuracy)}%)  (label agreement, not answer quality)`);
console.log(`Sent to small model:         ${toSmall}/${n}`);
console.log(`Easy-labelled sent to big:   ${easyToBig}  (pays the big-model price)`);
console.log(`Hard-labelled sent to small: ${hardToSmall}  (hypothetical risk of a bad answer)`);
console.log("");
console.log("Illustrative cost model (assumed prices, chars/4 input, assumed output lengths):");
console.log(`Est. cost per 1000 requests, always big:  $${per1000(costAllBig).toFixed(3)}`);
console.log(`Est. cost per 1000 requests, routed:      $${per1000(costRouted).toFixed(3)}  (${r1(saving)}% less)`);
console.log(`Est. cost per 1000, routed + escalation:  $${per1000(costEscalated).toFixed(3)}  (${r1(savingEsc)}% less, checker cost excluded)`);
console.log(`Est. avg latency, always big:  ${Math.round(latAllBig / n)} ms`);
console.log(`Est. avg latency, routed:      ${Math.round(latRouted / n)} ms`);
console.log(`Hypothetical expected errors per 1000, no escalation:   ${r1(per1000(expectedWrong))}  (assumes p_fail=${P_SMALL_FAILS_HARD})`);
console.log(`Hypothetical expected errors per 1000, with escalation: ${r1(per1000(expectedWrongEsc))}  (assumes p_detect=${P_FAILURE_DETECTED}, big always right)`);
console.log(`Routing decision time (measured): ${r2(usPerDecision)} microseconds per prompt`);
console.log("");
console.log("Disagreements with the label:");
for (const [kind, text] of misses) {
  const short = text.replace(/\s+/g, " ");
  console.log(`  ${kind}: ${short.length > 70 ? short.slice(0, 67) + "..." : short}`);
}
console.log("");

const result = {
  metrics: [
    { name: "label_agreement", value: r1(accuracy), unit: "% of prompts (agreement with hand labels, not answer correctness)" },
    { name: "sent_to_small_model", value: toSmall, unit: "prompts of 60" },
    { name: "easy_labelled_sent_to_big", value: easyToBig, unit: "prompts" },
    { name: "hard_labelled_sent_to_small", value: hardToSmall, unit: "prompts" },
    { name: "cost_always_big", value: r2(per1000(costAllBig)), unit: "USD per 1000 requests (illustrative model)" },
    { name: "cost_routed", value: r2(per1000(costRouted)), unit: "USD per 1000 requests (illustrative model)" },
    { name: "cost_saving", value: r1(saving), unit: "% (illustrative model)" },
    { name: "cost_saving_with_escalation", value: r1(savingEsc), unit: "% (illustrative model, checker cost excluded)" },
    { name: "avg_latency_always_big", value: Math.round(latAllBig / n), unit: "ms (est.)" },
    { name: "avg_latency_routed", value: Math.round(latRouted / n), unit: "ms (est.)" },
    { name: "hypothetical_errors_no_escalation", value: r1(per1000(expectedWrong)), unit: "per 1000 requests (expected, from assumed failure rate)" },
    { name: "hypothetical_errors_with_escalation", value: r1(per1000(expectedWrongEsc)), unit: "per 1000 requests (expected, from assumed detection rate)" },
    { name: "routing_decision_time", value: r2(usPerDecision), unit: "microseconds" },
  ],
  conclusion:
    `On these ${n} hand-labelled prompts, a length-and-keyword rule agreed with the labels ${r1(accuracy)}% of the time, ` +
    `cut cost by ${r1(saving)}% versus always-big under an illustrative price and token model, and took about ${r2(usPerDecision)} microseconds per decision, ` +
    `but it still sent ${hardToSmall} hard-labelled prompts to the small model.`,
  setup:
    `${n} hand-labelled prompts (${nEasy} easy, ${nHard} hard); rule: long>${LONG_CHARS} chars +1, maths/code/reasoning signals +2 each, big if score>=${BIG_SCORE}; ` +
    `prices per 1M tokens small ${PRICES.small.in}/${PRICES.small.out}, big ${PRICES.big.in}/${PRICES.big.out} USD (in/out, assumed illustrative tiers, not dated vendor prices); ` +
    `input tokens = chars/4, output tokens easy ${OUTPUT_TOKENS.easy}, hard ${OUTPUT_TOKENS.hard}; ` +
    `latency small ${LATENCY.small.firstMs}ms+${LATENCY.small.tokPerSec}tok/s, big ${LATENCY.big.firstMs}ms+${LATENCY.big.tokPerSec}tok/s; ` +
    `hypothetical escalation: uses true labels, small fails hard-labelled prompt p=${P_SMALL_FAILS_HARD}, checker detects p=${P_FAILURE_DETECTED}, big always succeeds, checker cost/latency excluded; routing time over ${decisions} decisions`,
};
console.log("RESULT " + JSON.stringify(result));
