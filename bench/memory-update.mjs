// Automatic memory keeping notes true, with the real model: contradictions
// rewrite the old note, chatter changes nothing, other people's news never
// touches the speaker's notes, and notes they asked for survive.
//   node bench/memory-update.mjs <secrets.env> [runs]
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { readSecrets } from '../dist/config.js';
import { AutoMemory } from '../dist/features/automemory.js';
import { UserNotes } from '../dist/features/notes.js';

const s = readSecrets(process.argv[2]);
const runs = Number(process.argv[3] ?? 3);
const llm = new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: s.get('ANTHROPIC_API_KEY'), effort: 'low' });
const log = { debug() {}, info() {}, warn: console.log, error: console.log };

const CASES = [
  {
    name: 'quit a game',
    notes: [['plays Valorant', 'learned'], ['birthday is March 3', 'told'], ['has a dog named Biscuit', 'learned']],
    said: ['I quit Valorant last week, it was making me so mad. Been playing Deadlock instead.'],
    want: (n) => !n.includes('plays Valorant') && n.includes('birthday is March 3') && n.includes('has a dog named Biscuit'),
  },
  {
    name: 'chatter changes nothing',
    notes: [['plays Valorant', 'learned'], ['birthday is March 3', 'told'], ['has a dog named Biscuit', 'learned']],
    said: ['what do you think about the new Dune movie?', 'yeah the sound design was crazy'],
    want: (n) => n.includes('plays Valorant') && n.includes('birthday is March 3') && n.includes('has a dog named Biscuit'),
  },
  {
    name: 'moved (a note they asked for)',
    notes: [['lives in Ohio', 'told'], ['works at a pizza place', 'learned']],
    said: ['we finally moved to Chicago last weekend, the drive was brutal'],
    want: (n) => !n.includes('lives in Ohio') && n.some((x) => /chicago/i.test(x)) && n.includes('works at a pizza place'),
  },
  {
    name: 'plan called off',
    notes: [['flying to Cancun on Friday', 'learned'], ['allergic to peanuts', 'told']],
    said: ['the Cancun trip got cancelled, the airline messed everything up'],
    want: (n) => !n.includes('flying to Cancun on Friday') && n.includes('allergic to peanuts'),
  },
  {
    name: "someone else's news",
    notes: [['plays Valorant', 'learned'], ['has a dog named Biscuit', 'learned']],
    said: ['my brother quit Valorant, he says it is dead', 'my friend just got a dog too, it is so loud'],
    want: (n) => n.includes('plays Valorant') && n.includes('has a dog named Biscuit'),
  },
  {
    // A judgment call: the note may have been wrong all along. Reported, not required.
    name: "(judgment) a friend's dog has that name",
    notes: [['has a dog named Biscuit', 'learned']],
    said: ["my friend's dog Biscuit is so loud"],
    want: () => true,
  },
  {
    name: 'a told note that sounds related survives',
    notes: [['birthday is March 3', 'told'], ['allergic to peanuts', 'told']],
    said: ["honestly I don't even like birthdays anymore", 'I had a peanut-free granola bar for lunch'],
    want: (n) => n.includes('birthday is March 3') && n.includes('allergic to peanuts'),
  },
];

let pass = 0;
let total = 0;
for (const c of CASES) {
  for (let r = 0; r < runs; r++) {
    const notes = new UserNotes(undefined);
    for (const [t, src] of c.notes) notes.add('a', t, src);
    const sessions = new SessionMemory(16, 3_600_000);
    for (const line of c.said) {
      sessions.append('a', { role: 'user', content: line });
      sessions.append('a', { role: 'assistant', content: 'Got it.' });
    }
    await new AutoMemory(llm, notes, sessions, log, () => {}, 1).learn('a', 'Sean');
    const after = notes.of('a');
    const ok = c.want(after);
    total++;
    if (ok) pass++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name}: ${JSON.stringify(after)}`);
  }
}
console.log(`\n${pass}/${total} passed`);
