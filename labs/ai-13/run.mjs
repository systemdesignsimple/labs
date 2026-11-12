// ai-13 lab: simulated metadata-driven tool discovery. One fixed client, three in-process apps.
// Node.js 22 ESM, standard library only. No network, no child processes, no files written.
// Everything runs in-process: JSON-RPC messages are serialized to JSON strings and back, using a
// hand-written subset of MCP message shapes (initialize, notifications/initialized, tools/list,
// tools/call). This is not the official SDK and does not test interoperability with real MCP servers.

import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const SEED = 1313;
const PROTOCOL = '2025-06-18';
const HANDSHAKE_REPS = 50;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Transport: an in-memory pipe. Every message is JSON.stringify'd and parsed,
// so nothing is shared by reference between client and server.
// ---------------------------------------------------------------------------
function makePipe() {
  // transcript keeps every wire message (direction + JSON string) so the handshake can be printed.
  const stats = { toServer: 0, toClient: 0, clientMessages: 0, serverMessages: 0, transcript: [] };
  const clientEnd = { onmessage: null };
  const serverEnd = { onmessage: null };
  clientEnd.send = (msg) => {
    const s = JSON.stringify(msg); stats.toServer += s.length; stats.clientMessages++;
    stats.transcript.push({ dir: 'client -> server', s });
    queueMicrotask(() => serverEnd.onmessage(JSON.parse(s)));
  };
  serverEnd.send = (msg) => {
    const s = JSON.stringify(msg); stats.toClient += s.length; stats.serverMessages++;
    stats.transcript.push({ dir: 'server -> client', s });
    queueMicrotask(() => clientEnd.onmessage(JSON.parse(s)));
  };
  return { clientEnd, serverEnd, stats };
}

// ---------------------------------------------------------------------------
// Shared server helper: the part an MCP SDK gives you for free.
// ---------------------------------------------------------------------------
function serveMcp(end, info, tools) {
  end.onmessage = (msg) => {
    if (msg.id === undefined) return;
    const reply = (result) => end.send({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => end.send({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
    if (msg.method === 'initialize') {
      return reply({ protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: info });
    }
    if (msg.method === 'tools/list') {
      return reply({ tools: tools.map(({ handler, ...t }) => t) });
    }
    if (msg.method === 'tools/call') {
      const t = tools.find((x) => x.name === msg.params.name);
      if (!t) return fail(-32602, `Unknown tool: ${msg.params.name}`);
      try {
        reply({ content: [{ type: 'text', text: String(t.handler(msg.params.arguments ?? {})) }], isError: false });
      } catch (e) {
        reply({ content: [{ type: 'text', text: e.message }], isError: true });
      }
      return;
    }
    fail(-32601, `Method not found: ${msg.method}`);
  };
}

// ---------------------------------------------------------------------------
// App 1: notes. This is the per-app MCP server code (the adapter).
// ---------------------------------------------------------------------------
function notesApp() {
  const notes = [
    { title: 'groceries', body: 'buy milk and eggs' },
    { title: 'dentist', body: 'appointment on friday at 10am' },
    { title: 'ideas', body: 'video about caching and queues' },
    { title: 'wifi', body: 'router password is on the sticker' },
  ];
  const text = (description) => ({ type: 'string', description });
  return {
    info: { name: 'notes-app', version: '1.0.0' },
    tools: [
      {
        name: 'create_note',
        description: 'Create, make and save a new note with a title and body text. Use it to write down, jot, remember, record or keep something for later.',
        inputSchema: { type: 'object', properties: { title: text('Short title of the note'), body: text('Full text of the note') }, required: ['title', 'body'], additionalProperties: false },
        handler: ({ title, body }) => {
          notes.push({ title, body });
          return `Saved "${title}". You now have ${notes.length} notes.`;
        },
      },
      {
        name: 'search_notes',
        description: 'Search every note for a word or phrase and return the notes that match. Use it to find, look up, recall or check what was written about a topic.',
        inputSchema: { type: 'object', properties: { query: text('Word or phrase to look for') }, required: ['query'], additionalProperties: false },
        handler: ({ query }) => {
          const q = query.toLowerCase();
          const hits = notes.filter((n) => `${n.title} ${n.body}`.toLowerCase().includes(q));
          return hits.length ? hits.map((n) => `${n.title}: ${n.body}`).join('\n') : 'No notes match.';
        },
      },
      {
        name: 'list_notes',
        description: 'List the titles of all notes. Use it to show, see, browse or count every note.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: () => notes.map((n) => n.title).join(', '),
      },
      {
        name: 'delete_note',
        description: 'Delete one note by its exact title. Use it to remove, erase, trash or get rid of a note.',
        inputSchema: { type: 'object', properties: { title: text('Exact title of the note') }, required: ['title'], additionalProperties: false },
        handler: ({ title }) => {
          const i = notes.findIndex((n) => n.title === title);
          if (i < 0) throw new Error(`No note titled "${title}"`);
          notes.splice(i, 1);
          return `Deleted "${title}". ${notes.length} notes left.`;
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// App 2: to-do list.
// ---------------------------------------------------------------------------
function todoApp() {
  const tasks = [
    { text: 'pay rent', done: false },
    { text: 'call mom', done: false },
    { text: 'fix bike', done: false },
    { text: 'water plants', done: true },
    { text: 'book flights', done: false },
  ];
  const open = () => tasks.filter((t) => !t.done);
  const item = { type: 'object', properties: { text: { type: 'string', description: 'Text of the item' } }, required: ['text'], additionalProperties: false };
  return {
    info: { name: 'todo-app', version: '1.0.0' },
    tools: [
      {
        name: 'add_task',
        description: 'Add a new item to the to-do list. Use it to put something on the list, plan it, or remind yourself to do it later.',
        inputSchema: item,
        handler: ({ text }) => {
          tasks.push({ text, done: false });
          return `Added "${text}". ${open().length} open.`;
        },
      },
      {
        name: 'complete_task',
        description: 'Mark an open item as done by its text. Use it when something is finished, completed or ticked off.',
        inputSchema: item,
        handler: ({ text }) => {
          const t = open().find((x) => x.text === text);
          if (!t) throw new Error(`No open item "${text}"`);
          t.done = true;
          return `Done: "${text}". ${open().length} left.`;
        },
      },
      {
        name: 'list_tasks',
        description: 'List the items that are still open. Use it to show what is left, pending or remaining.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: () => open().map((t) => t.text).join(', ') || 'Nothing left to do.',
      },
      {
        name: 'delete_task',
        description: 'Delete an item from the list without completing it. Use it to remove, drop or cancel an item.',
        inputSchema: item,
        handler: ({ text }) => {
          const i = tasks.findIndex((x) => x.text === text);
          if (i < 0) throw new Error(`No item "${text}"`);
          tasks.splice(i, 1);
          return `Removed "${text}".`;
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// App 3: unit converter.
// ---------------------------------------------------------------------------
function converterApp() {
  const round = (x) => Math.round(x * 100) / 100;
  const LENGTH = { km: 1000, m: 1, cm: 0.01, mile: 1609.344, foot: 0.3048, inch: 0.0254 };
  const WEIGHT = { kg: 1000, g: 1, pound: 453.59237, ounce: 28.349523125 };
  const TO_C = { celsius: (v) => v, fahrenheit: (v) => ((v - 32) * 5) / 9, kelvin: (v) => v - 273.15 };
  const FROM_C = { celsius: (c) => c, fahrenheit: (c) => (c * 9) / 5 + 32, kelvin: (c) => c + 273.15 };
  const schema = (units) => ({
    type: 'object',
    properties: {
      value: { type: 'number', description: 'The amount to change' },
      from: { type: 'string', enum: units, description: 'Unit the value starts in' },
      to: { type: 'string', enum: units, description: 'Target unit for the result' },
    },
    required: ['value', 'from', 'to'],
    additionalProperties: false,
  });
  return {
    info: { name: 'converter-app', version: '1.0.0' },
    tools: [
      {
        name: 'convert_length',
        description: 'Convert a distance or length from one unit to another: kilometres, metres, centimetres, miles, feet or inches. Use it for how far, how long or how tall.',
        inputSchema: schema(Object.keys(LENGTH)),
        handler: ({ value, from, to }) => `${value} ${from} = ${round((value * LENGTH[from]) / LENGTH[to])} ${to}`,
      },
      {
        name: 'convert_weight',
        description: 'Convert a weight or mass from one unit to another: kilograms, grams, pounds or ounces. Use it for how heavy something is.',
        inputSchema: schema(Object.keys(WEIGHT)),
        handler: ({ value, from, to }) => `${value} ${from} = ${round((value * WEIGHT[from]) / WEIGHT[to])} ${to}`,
      },
      {
        name: 'convert_temperature',
        description: 'Convert a temperature between Celsius, Fahrenheit and Kelvin. Use it for how hot or cold something is.',
        inputSchema: schema(Object.keys(TO_C)),
        handler: ({ value, from, to }) => `${value} ${from} = ${round(FROM_C[to](TO_C[from](value)))} ${to}`,
      },
    ],
  };
}

// ===========================================================================
// THE CLIENT. This block is fixed. Its source is hashed before and after
// each app is connected. It knows MCP, not any app.
// ===========================================================================
class McpClient {
  constructor(end) {
    this.end = end;
    this.nextId = 1;
    this.pending = new Map();
    end.onmessage = (m) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
      else p.resolve(m.result);
    };
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.end.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  notify(method, params) {
    this.end.send({ jsonrpc: '2.0', method, params });
  }
  async connect() {
    const init = await this.request('initialize', {
      protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'lab-client', version: '1.0.0' },
    });
    this.notify('notifications/initialized', {});
    const list = await this.request('tools/list', {});
    this.serverInfo = init.serverInfo;
    this.tools = list.tools;
    return this.tools;
  }
  call(name, args) {
    return this.request('tools/call', { name, arguments: args });
  }
}

// The simulated model: picks a tool and fills arguments using ONLY what
// tools/list returned (name, description, inputSchema) plus general word knowledge.
const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'my', 'me', 'i', 'is', 'it', 'its', 'what', 'how', 'and', 'or',
  'for', 'in', 'on', 'please', 'can', 'you', 'that', 'this', 'with', 'about', 'all', 'do', 'does', 'did', 'be', 'are',
  'am', 'was', 'by', 'at', 'from', 'as', 'not', 'any', 'have', 'has', 'there', 'whether', 'one', 'use', 'many', 'much',
  'when', 'into', 'im', 'dont', 'will', 'your', 'yourself', 'something', 'thing', 'so', 'if', 'than', 'then']);

function words(text) {
  return text.toLowerCase().replace(/'/g, '').split(/[^a-z0-9]+/).filter(Boolean);
}
function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}
function bag(text) {
  return new Set(words(text).filter((w) => w.length > 1 && !STOP.has(w)).map(stem));
}
function enumValues(schema) {
  const out = new Set();
  for (const p of Object.values(schema.properties ?? {})) for (const v of p.enum ?? []) out.add(v);
  return out;
}

function chooseTool(request, tools, rand, knowledge) {
  const plain = request.replace(/"[^"]*"/g, ' ');
  const q = bag(plain);
  const raw = words(plain).map((w) => knowledge.alias[w] ?? w);
  let best = null;
  let bestScore = -Infinity;
  for (const t of tools) {
    const nameBag = bag(t.name.replace(/_/g, ' '));
    const descBag = bag(t.description);
    let s = 0;
    for (const w of q) {
      if (nameBag.has(w)) s += 2;
      if (descBag.has(w)) s += 1;
    }
    const ev = enumValues(t.inputSchema);
    for (const v of new Set(raw)) if (ev.has(v)) s += 1;
    const total = s + rand() * 0.9;
    if (total > bestScore) { bestScore = total; best = t.name; }
  }
  return best;
}

function extractArgs(request, schema, knowledge) {
  const props = schema.properties ?? {};
  const quoted = [...request.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  const plain = request.replace(/"[^"]*"/g, ' ');
  const nums = [...plain.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  const raw = words(plain.replace(/-?\d+(?:\.\d+)?/g, ' '));
  const mentions = raw.map((w, i) => ({
    v: knowledge.alias[w] ?? w,
    targetCue: i > 0 && ['to', 'into', 'in', 'many'].includes(raw[i - 1]),
    used: false,
  }));
  const args = {};
  const enumKeys = [];
  for (const [key, p] of Object.entries(props)) {
    if (p.enum) enumKeys.push(key);
    else if (p.type === 'number' && nums.length) args[key] = nums.shift();
    else if (p.type === 'string' && quoted.length) args[key] = quoted.shift();
  }
  const isTarget = (key) => key === 'to' || /\b(target|into|result)\b/i.test(props[key].description ?? '');
  const ordered = [...enumKeys.filter(isTarget), ...enumKeys.filter((k) => !isTarget(k))];
  for (const key of ordered) {
    const cands = mentions.filter((m) => !m.used && props[key].enum.includes(m.v));
    const pick = isTarget(key)
      ? cands.find((m) => m.targetCue)
      : cands.find((m) => !m.targetCue) ?? cands[0];
    if (pick) { pick.used = true; args[key] = pick.v; }
  }
  return args;
}

function validateArgs(args, schema) {
  const props = schema.properties ?? {};
  const errs = [];
  for (const k of schema.required ?? []) if (!(k in args)) errs.push(`missing ${k}`);
  for (const [k, v] of Object.entries(args)) {
    const p = props[k];
    if (!p) { if (schema.additionalProperties === false) errs.push(`unexpected ${k}`); continue; }
    if (p.type === 'number' && !(typeof v === 'number' && Number.isFinite(v))) errs.push(`${k} not a number`);
    if (p.type === 'string' && (typeof v !== 'string' || !v.length)) errs.push(`${k} not a string`);
    if (p.enum && !p.enum.includes(v)) errs.push(`${k} not allowed`);
  }
  return { ok: errs.length === 0, errs };
}
// ===========================================================================
// END OF CLIENT
// ===========================================================================

// General world knowledge the model brings from training (unit spellings).
// It is not client code and is not tied to any server; it only maps words
// like "lbs" to a canonical unit word. It is listed in the README as a limit.
const KNOWLEDGE = { alias: {} };
for (const [canon, list] of Object.entries({
  km: ['km', 'kilometer', 'kilometers', 'kilometre', 'kilometres'],
  m: ['m', 'meter', 'meters', 'metre', 'metres'],
  cm: ['cm', 'centimeter', 'centimeters', 'centimetre', 'centimetres'],
  mile: ['mile', 'miles', 'mi'],
  foot: ['foot', 'feet', 'ft'],
  inch: ['inch', 'inches'],
  kg: ['kg', 'kilo', 'kilos', 'kilogram', 'kilograms'],
  g: ['g', 'gram', 'grams'],
  pound: ['pound', 'pounds', 'lb', 'lbs'],
  ounce: ['ounce', 'ounces', 'oz'],
  celsius: ['celsius', 'c', 'centigrade'],
  fahrenheit: ['fahrenheit', 'f'],
  kelvin: ['kelvin', 'k'],
})) for (const w of list) KNOWLEDGE.alias[w] = canon;

// What the hash covers: the client class, the simulated model's functions, the seeded
// random number generator it uses for tie breaks, and every constant they read
// (STOP, KNOWLEDGE, PROTOCOL, SEED). It does NOT cover the transport (makePipe),
// the harness (connectTo, runSet) or the app servers. Equal hashes mean "this selected
// source text did not change"; they do not count lines changed.
const CLIENT_FUNCTIONS = [McpClient, words, stem, bag, enumValues, chooseTool, extractArgs, validateArgs, mulberry32];
function clientSource() {
  return CLIENT_FUNCTIONS.map((f) => f.toString()).join('\n')
    + JSON.stringify({ STOP: [...STOP], KNOWLEDGE, PROTOCOL, SEED });
}
const clientHash = () => createHash('sha256').update(clientSource()).digest('hex');
// The app-word scan looks at the client and model code plus STOP, not at KNOWLEDGE,
// because KNOWLEDGE is unit spellings (general knowledge) and would match on purpose.
const clientCodeForScan = () => CLIENT_FUNCTIONS.map((f) => f.toString()).join('\n') + JSON.stringify([...STOP]);

// ---------------------------------------------------------------------------
// The 60 requests, fixed before the run. gold = the call a careful human would make.
// Some are ambiguous on purpose (marked amb) so misses have somewhere to show up.
// ---------------------------------------------------------------------------
const R = (text, tool, args, amb = false) => ({ text, gold: { tool, args }, amb });
const REQUESTS = {
  notes: [
    R('Write down "parking" with the text "level 3, spot 42"', 'create_note', { title: 'parking', body: 'level 3, spot 42' }),
    R('Jot this down as "book idea": "a story told by a cache"', 'create_note', { title: 'book idea', body: 'a story told by a cache' }),
    R('Save a note called "gym" that says "legs on monday"', 'create_note', { title: 'gym', body: 'legs on monday' }),
    R('Remember this: "wifi guest" is "guest123"', 'create_note', { title: 'wifi guest', body: 'guest123' }),
    R('Keep a note for later, "flight" says "NH 852 at 9pm"', 'create_note', { title: 'flight', body: 'NH 852 at 9pm' }),
    R('Find my notes about "dentist"', 'search_notes', { query: 'dentist' }),
    R('What did I write about "caching"?', 'search_notes', { query: 'caching' }, true),
    R('Look up "milk" in my notes', 'search_notes', { query: 'milk' }),
    R('Check whether any note mentions "router"', 'search_notes', { query: 'router' }),
    R('Show me all my notes', 'list_notes', {}),
    R('How many notes do I have?', 'list_notes', {}, true),
    R('Count my notes', 'list_notes', {}),
    R('Browse every note title', 'list_notes', {}),
    R('Delete the note "ideas"', 'delete_note', { title: 'ideas' }),
    R('Erase "groceries"', 'delete_note', { title: 'groceries' }),
    R('Get rid of the "wifi" note', 'delete_note', { title: 'wifi' }),
    R('Trash the note titled "dentist"', 'delete_note', { title: 'dentist' }),
    R('I don\'t need "groceries" anymore', 'delete_note', { title: 'groceries' }, true),
    R('Recall what I noted about "friday"', 'search_notes', { query: 'friday' }),
    R('Make a note "stamps" with "buy stamps at the post office"', 'create_note', { title: 'stamps', body: 'buy stamps at the post office' }),
  ],
  todo: [
    R('Add "buy milk" to my list', 'add_task', { text: 'buy milk' }),
    R('Put "renew passport" on my plate', 'add_task', { text: 'renew passport' }),
    R('Remind me to "email the landlord"', 'add_task', { text: 'email the landlord' }),
    R('Plan "dentist checkup" for next week', 'add_task', { text: 'dentist checkup' }),
    R('I need to "buy a birthday gift"', 'add_task', { text: 'buy a birthday gift' }, true),
    R('Mark "pay rent" as done', 'complete_task', { text: 'pay rent' }),
    R('I finished "fix bike"', 'complete_task', { text: 'fix bike' }),
    R('Tick off "call mom"', 'complete_task', { text: 'call mom' }),
    R('"book flights" is completed', 'complete_task', { text: 'book flights' }),
    R('Done with "pay rent"', 'complete_task', { text: 'pay rent' }),
    R('What is left on my list?', 'list_tasks', {}),
    R('Show my pending tasks', 'list_tasks', {}),
    R('What do I still have to do?', 'list_tasks', {}),
    R('List everything remaining', 'list_tasks', {}),
    R('Drop "fix bike", I am not doing it', 'delete_task', { text: 'fix bike' }),
    R('Cancel "book flights"', 'delete_task', { text: 'book flights' }),
    R('Remove "call mom"', 'delete_task', { text: 'call mom' }),
    R('Delete the task "pay rent"', 'delete_task', { text: 'pay rent' }),
    R('Get rid of "call mom", I already did it', 'complete_task', { text: 'call mom' }, true),
    R('Forget about "fix bike"', 'delete_task', { text: 'fix bike' }, true),
  ],
  converter: [
    R('Convert 5 km to miles', 'convert_length', { value: 5, from: 'km', to: 'mile' }),
    R('How many feet is 3 meters?', 'convert_length', { value: 3, from: 'm', to: 'foot' }),
    R('How far is 10 miles in kilometres?', 'convert_length', { value: 10, from: 'mile', to: 'km' }),
    R('Turn 180 cm into inches', 'convert_length', { value: 180, from: 'cm', to: 'inch' }),
    R('How tall is 6 feet in cm?', 'convert_length', { value: 6, from: 'foot', to: 'cm' }),
    R('Convert 2 kg to pounds', 'convert_weight', { value: 2, from: 'kg', to: 'pound' }),
    R('How heavy is 16 ounces in grams?', 'convert_weight', { value: 16, from: 'ounce', to: 'g' }),
    R('How many grams are in 1 pound?', 'convert_weight', { value: 1, from: 'pound', to: 'g' }),
    R('What is 500 g in kg?', 'convert_weight', { value: 500, from: 'g', to: 'kg' }),
    R('Change 70 kg to lbs', 'convert_weight', { value: 70, from: 'kg', to: 'pound' }),
    R('Convert 100 F to C', 'convert_temperature', { value: 100, from: 'fahrenheit', to: 'celsius' }),
    R('How hot is 30 celsius in fahrenheit?', 'convert_temperature', { value: 30, from: 'celsius', to: 'fahrenheit' }),
    R('What is -40 fahrenheit in celsius?', 'convert_temperature', { value: -40, from: 'fahrenheit', to: 'celsius' }),
    R('Is 300 kelvin cold?', 'convert_temperature', { value: 300, from: 'kelvin', to: 'celsius' }, true),
    R('How long is a marathon in miles?', 'convert_length', { value: 42.195, from: 'km', to: 'mile' }, true),
    R('Convert 1 mile to feet', 'convert_length', { value: 1, from: 'mile', to: 'foot' }),
    R('Weigh 250 grams in ounces', 'convert_weight', { value: 250, from: 'g', to: 'ounce' }),
    R('Convert 20 degrees to fahrenheit', 'convert_temperature', { value: 20, from: 'celsius', to: 'fahrenheit' }, true),
    R('Convert 0.5 km to m', 'convert_length', { value: 0.5, from: 'km', to: 'm' }),
    R('How much is 3 pounds in kg?', 'convert_weight', { value: 3, from: 'pound', to: 'kg' }),
  ],
};

const APPS = { notes: notesApp, todo: todoApp, converter: converterApp };

// Same handlers, same tool names, same input schemas (property descriptions included).
// Only each tool's top-level description text is made vague.
function vagueify(app) {
  return {
    ...app,
    tools: app.tools.map((t) => ({ ...t, description: 'Works with an item.' })),
  };
}

async function connectTo(factory, transform = (x) => x) {
  const app = transform(factory());
  const pipe = makePipe();
  serveMcp(pipe.serverEnd, app.info, app.tools);
  const client = new McpClient(pipe.clientEnd);
  const tools = await client.connect();
  return { client, tools, pipe };
}

function nonBlankLines(fn) {
  return fn.toString().split('\n').filter((l) => l.trim().length).length;
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (n, d) => Math.round((1000 * n) / d) / 10;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function runSet(appName, transform, salt) {
  const rows = [];
  const factory = APPS[appName];
  for (const [i, req] of REQUESTS[appName].entries()) {
    const live = await connectTo(factory, transform);
    const rand = mulberry32(SEED + salt + i * 7919);
    const pick = chooseTool(req.text, live.tools, rand, KNOWLEDGE);
    const tool = live.tools.find((t) => t.name === pick);
    const args = extractArgs(req.text, tool.inputSchema, KNOWLEDGE);
    const check = validateArgs(args, tool.inputSchema);
    const result = check.ok ? await live.client.call(pick, args) : null;
    const goldConn = await connectTo(factory);
    const goldResult = await goldConn.client.call(req.gold.tool, req.gold.args);
    const rightTool = pick === req.gold.tool;
    const validArgs = rightTool && check.ok;
    const rightResult = validArgs && result !== null && same(result, goldResult);
    rows.push({ i: i + 1, text: req.text, amb: req.amb, pick, gold: req.gold.tool, args, errs: check.errs, rightTool, validArgs, rightResult });
  }
  return rows;
}

const t0 = performance.now();
const hashes = [{ when: 'before any app', hash: clientHash() }];
const perApp = {};

for (const appName of Object.keys(APPS)) {
  // Handshake + discovery timing (median of repeated fresh connections).
  const times = [];
  let first = null;
  for (let r = 0; r < HANDSHAKE_REPS; r++) {
    const start = performance.now();
    const conn = await connectTo(APPS[appName]);
    times.push(performance.now() - start);
    if (!first) first = conn;
  }
  const rows = await runSet(appName, undefined, 0);
  hashes.push({ when: `after ${appName}`, hash: clientHash() });
  perApp[appName] = {
    server: first.client.serverInfo.name,
    tools: first.tools.map((t) => t.name),
    connectMs: median(times),
    handshakeBytes: first.pipe.stats.toServer + first.pipe.stats.toClient,
    clientMessages: first.pipe.stats.clientMessages,
    serverMessages: first.pipe.stats.serverMessages,
    transcript: [...first.pipe.stats.transcript],
    serverLines: nonBlankLines(APPS[appName]),
    rows,
  };
}

const vagueRows = await runSet('todo', vagueify, 0);
hashes.push({ when: 'after vague to-do rerun', hash: clientHash() });

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const allRows = Object.values(perApp).flatMap((a) => a.rows);
const count = (rows, k) => rows.filter((r) => r[k]).length;
const hashSame = hashes.every((h) => h.hash === hashes[0].hash);
const appWordPattern = /\b(notes?|tasks?|to-?do|convert\w*|celsius|fahrenheit|kelvin|km|kg|pounds?|miles?)\b/gi;
const appWordsInClient = (clientCodeForScan().match(appWordPattern) ?? []).length;
const helperLines = nonBlankLines(serveMcp);
const printMisses = (rows) => {
  for (const r of rows.filter((x) => !x.rightResult)) {
    const why = !r.rightTool ? `picked ${r.pick}, wanted ${r.gold}` : r.errs.length ? `args: ${r.errs.join(', ')}` : 'result differs';
    console.log(`  miss #${r.i}${r.amb ? ' (ambiguous)' : ''}: ${r.text}  ->  ${why}`);
  }
};

console.log('ai-13 lab: simulated metadata-driven tool discovery, one fixed client, three in-process apps');
console.log(`hashed client source = ${CLIENT_FUNCTIONS.map((f) => f.name).join(', ')} + STOP, KNOWLEDGE, PROTOCOL, SEED`);
console.log(`selected-source sha256 (first 16): ${hashes.map((h) => `${h.when}=${h.hash.slice(0, 16)}`).join(' | ')}`);
console.log(`selected-source hash identical throughout: ${hashSame} · app words in client code: ${appWordsInClient}`);
console.log(`shared server helper (hand-written stand-in for an SDK): ${helperLines} lines`);
for (const [name, a] of Object.entries(perApp)) {
  const n = a.rows.length;
  console.log(`\n[${name}] server=${a.server} lines=${a.serverLines} tools=${a.tools.join(',')}`);
  console.log(`  captured handshake + discovery (${a.clientMessages} client messages, ${a.serverMessages} server responses, ${a.clientMessages + a.serverMessages} wire messages, ${a.handshakeBytes} bytes):`);
  for (const m of a.transcript) console.log(`    ${m.dir}: ${m.s}`);
  console.log(`  in-process connect + discovery latency: median ${a.connectMs.toFixed(3)} ms over ${HANDSHAKE_REPS} runs (includes app construction)`);
  console.log(`  right tool ${count(a.rows, 'rightTool')}/${n} · valid args ${count(a.rows, 'validArgs')}/${n} · right result ${count(a.rows, 'rightResult')}/${n}`);
  printMisses(a.rows);
}
const todoGood = count(perApp.todo.rows, 'rightTool');
const todoVague = count(vagueRows, 'rightTool');
console.log(`\n[vague tool descriptions on to-do, schemas unchanged] right tool ${todoVague}/20 (was ${todoGood}/20) · right result ${count(vagueRows, 'rightResult')}/20`);
printMisses(vagueRows);
const elapsed = performance.now() - t0;
console.log(`total run time ${elapsed.toFixed(0)} ms`);

const lines = Object.values(perApp).map((a) => a.serverLines);
const toolPct = pct(count(allRows, 'rightTool'), allRows.length);
const metrics = [
  { name: 'selected_client_source_hash_changes', value: hashes.filter((h) => h.hash !== hashes[0].hash).length, unit: `of ${hashes.length - 1} checkpoints` },
  { name: 'app_words_in_client_code', value: appWordsInClient, unit: 'matches' },
  { name: 'apps_connected', value: Object.keys(perApp).length, unit: 'apps' },
  { name: 'tools_discovered', value: Object.values(perApp).reduce((s, a) => s + a.tools.length, 0), unit: 'tools' },
  { name: 'server_lines_notes', value: perApp.notes.serverLines, unit: 'lines' },
  { name: 'server_lines_todo', value: perApp.todo.serverLines, unit: 'lines' },
  { name: 'server_lines_converter', value: perApp.converter.serverLines, unit: 'lines' },
  { name: 'shared_helper_lines', value: helperLines, unit: 'lines' },
  { name: 'handshake_client_messages', value: perApp.notes.clientMessages, unit: 'messages per app' },
  { name: 'handshake_wire_messages', value: perApp.notes.clientMessages + perApp.notes.serverMessages, unit: 'messages per app' },
  { name: 'inprocess_connect_discovery_latency_median', value: Math.round(median(Object.values(perApp).map((a) => a.connectMs)) * 1000) / 1000, unit: 'ms (in-process, not setup effort)' },
  { name: 'right_tool', value: toolPct, unit: '% of 60' },
  { name: 'valid_args', value: pct(count(allRows, 'validArgs'), allRows.length), unit: '% of 60' },
  { name: 'right_result', value: pct(count(allRows, 'rightResult'), allRows.length), unit: '% of 60' },
  { name: 'todo_right_tool_clear_descriptions', value: pct(todoGood, 20), unit: '% of 20' },
  { name: 'todo_right_tool_vague_descriptions', value: pct(todoVague, 20), unit: '% of 20' },
  { name: 'run_time', value: Math.round(elapsed), unit: 'ms' },
];
const conclusion = `In this simulation of metadata-driven tool discovery, ${hashSame ? 'the hash of the selected client source stayed identical' : 'the hash of the selected client source changed'} across 3 in-process apps that each needed its own ${Math.min(...lines)} to ${Math.max(...lines)} line server, a keyword-matching stand-in model picked the right tool on ${toolPct}% of 60 hand-written requests, and vaguer tool descriptions alone moved to-do tool choice from ${pct(todoGood, 20)}% to ${pct(todoVague, 20)}%.`;
const setup = `in-process JSON-RPC subset with MCP message shapes (protocol string ${PROTOCOL}, not the official SDK, no real MCP interoperability tested), 3 apps (4+4+3 tools), 60 fixed requests (20 per app, ${allRows.filter((r) => r.amb).length} marked ambiguous), deterministic keyword-matching model (not an LLM) reading only tools/list, seed ${SEED}, ${HANDSHAKE_REPS} connections per app for latency, vague rerun on to-do changing only tool descriptions`;

console.log('RESULT ' + JSON.stringify({ metrics, conclusion, setup }));
