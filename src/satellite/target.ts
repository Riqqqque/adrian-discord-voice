// Is a pc_ call for the PC, or for something in the house? Only the person's
// own words decide: the model can't write them.
//
// Their words are cut into orders: a verb (with its "off", "down" or "up")
// and what it acts on, which is everything after it up to a break, the next
// verb, a conjunction before a verb, or the start of a new clause ("I", "is",
// "que"). So "turn off the fourth purple lamp" acts on a lamp whatever the
// words in between, and in "pause I gotta open the door" the pause acts on
// nothing. Each thing acted on is sorted: the PC or something on it, a house
// thing, a pronoun ("it" after "close the garage" is the garage), nothing, or
// something unknown. With no thing after it, an order takes the one right
// before it ("the lights need to be turned off").
//
// A call goes ahead when one of the orders that could mean it acts on the
// PC, something playing on it, or nothing. It's refused when all of those
// act on a house thing, or when there are none and some order is about the
// house. lock and screen_off ask first when it's unclear (an unknown thing,
// "it" after a house thing). Calling a power-down off, looking something up
// and putting a window back are never refused.

const strip = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '');

/** What an order does. */
type Cls = 'off' | 'on' | 'up' | 'down' | 'set' | 'mute' | 'media' | 'stop' | 'lock' | 'unlock' | 'lockup' | 'open' | 'close' | 'search' | 'sleep' | 'restart' | 'shutdown' | 'other';

/** Verbs, by the particle that follows them ('' for none). */
const VERBS: Record<string, Partial<Record<string, Cls>>> = {
  turn: { off: 'off', out: 'off', on: 'on', up: 'up', down: 'down', '': 'other' },
  switch: { off: 'off', on: 'on', '': 'other' },
  flip: { off: 'off', on: 'on', '': 'other' },
  click: { off: 'off', on: 'on', '': 'other' },
  shut: { down: 'shutdown', off: 'off', '': 'close' },
  power: { off: 'shutdown', down: 'shutdown', on: 'on', up: 'on', '': 'other' },
  cut: { off: 'off', '': 'off' },
  kill: { '': 'off' },
  knock: { off: 'off', down: 'down', '': 'other' },
  crank: { up: 'up', down: 'down', '': 'up' },
  bump: { up: 'up', down: 'down', '': 'up' },
  dial: { up: 'up', down: 'down', '': 'other' },
  jack: { up: 'up', '': 'other' },
  pump: { up: 'up', '': 'other' },
  bring: { up: 'search', down: 'down', '': 'other' },
  pull: { up: 'search', '': 'other' },
  look: { up: 'search', '': 'other' },
  lock: { up: 'lockup', '': 'lock' },
  unlock: { '': 'unlock' },
  put: { on: 'media', '': 'other' },
  throw: { on: 'media', '': 'other' },
  go: { off: 'off', back: 'media', '': 'other' },
  hold: { on: 'media', up: 'media', '': 'other' },
  hang: { on: 'media', '': 'other' },
  wait: { '': 'media' },
  set: { '': 'set' },
  open: { up: 'open', '': 'open' },
  close: { '': 'close' },
  start: { '': 'on' },
  run: { '': 'on' },
  pause: { '': 'media' },
  unpause: { '': 'media' },
  play: { '': 'media' },
  replay: { '': 'media' },
  resume: { '': 'media' },
  skip: { '': 'media' },
  next: { '': 'media' },
  previous: { '': 'media' },
  rewind: { '': 'media' },
  stop: { '': 'stop' },
  mute: { '': 'mute' },
  unmute: { '': 'mute' },
  silence: { '': 'mute' },
  lower: { '': 'down' },
  quieter: { '': 'down' },
  softer: { '': 'down' },
  dim: { '': 'down' },
  raise: { '': 'up' },
  louder: { '': 'up' },
  boost: { '': 'up' },
  brighten: { '': 'up' },
  restart: { '': 'restart' },
  reboot: { '': 'restart' },
  sleep: { '': 'sleep' },
  suspend: { '': 'sleep' },
  hibernate: { '': 'sleep' },
  shutdown: { '': 'shutdown' },
  search: { '': 'search' },
  find: { '': 'search' },
  google: { '': 'search' },
  show: { '': 'search' },
  visit: { '': 'search' },
  browse: { '': 'search' },
  load: { '': 'search' },
  watch: { '': 'search' },
  // Spanish.
  apaga: { '': 'off' },
  apague: { '': 'off' },
  apagar: { '': 'off' },
  apagues: { '': 'off' },
  enciende: { '': 'on' },
  encienda: { '': 'on' },
  encender: { '': 'on' },
  prende: { '': 'on' },
  prenda: { '': 'on' },
  prender: { '': 'on' },
  sube: { '': 'up' },
  suba: { '': 'up' },
  subir: { '': 'up' },
  baja: { '': 'down' },
  baje: { '': 'down' },
  bajar: { '': 'down' },
  silencia: { '': 'mute' },
  silencie: { '': 'mute' },
  silenciar: { '': 'mute' },
  mutea: { '': 'mute' },
  pausa: { '': 'media' },
  pausar: { '': 'media' },
  reanuda: { '': 'media' },
  reanudar: { '': 'media' },
  reproduce: { '': 'media' },
  siguiente: { '': 'media' },
  anterior: { '': 'media' },
  pon: { '': 'media' },
  ponga: { '': 'media' },
  poner: { '': 'media' },
  para: { '': 'stop' },
  parar: { '': 'stop' },
  deten: { '': 'stop' },
  detener: { '': 'stop' },
  bloquea: { '': 'lock' },
  bloquear: { '': 'lock' },
  bloquee: { '': 'lock' },
  desbloquea: { '': 'unlock' },
  abre: { '': 'open' },
  abra: { '': 'open' },
  abrir: { '': 'open' },
  cierra: { '': 'close' },
  cierre: { '': 'close' },
  cerrar: { '': 'close' },
  reinicia: { '': 'restart' },
  reinicie: { '': 'restart' },
  reiniciar: { '': 'restart' },
  suspende: { '': 'sleep' },
  suspender: { '': 'sleep' },
  duerme: { '': 'sleep' },
  dormir: { '': 'sleep' },
  busca: { '': 'search' },
  buscar: { '': 'search' },
  // A little French.
  eteins: { '': 'off' },
  eteindre: { '': 'off' },
  eteignez: { '': 'off' },
  allume: { '': 'on' },
  allumer: { '': 'on' },
  allumez: { '': 'on' },
  ferme: { '': 'close' },
  fermer: { '': 'close' },
  fermez: { '': 'close' },
  ouvre: { '': 'open' },
  ouvrir: { '': 'open' },
  ouvrez: { '': 'open' },
  verrouille: { '': 'lock' },
  verrouiller: { '': 'lock' },
  baisse: { '': 'down' },
  baisser: { '': 'down' },
  monte: { '': 'up' },
  monter: { '': 'up' },
};
/** Other verbs: they end the words an order acts on, and start an order of their own that no pc_ call stands for. */
for (const v of 'get hit make have want give grab take keep leave check fetch carry answer call text tell ask see come feed walk clean wash cook order buy pick drop move use try help bring send let finish fix grab pass hand listen wake'.split(' '))
  VERBS[v] ??= { '': 'other' };

/** English verb forms back to the verb ("turning", "locked", "shuts"). */
const FORMS = new Map<string, string>();
for (const v of Object.keys(VERBS)) {
  if (!/^[a-z]+$/.test(v) || v.endsWith('a') || v.endsWith('r')) continue;
  const last = v.at(-1)!;
  const stem = v.endsWith('e') ? v.slice(0, -1) : v;
  for (const f of [`${v}s`, `${v}es`, `${stem}ed`, `${stem}ing`, `${v}${last}ing`, `${v}${last}ed`]) if (!VERBS[f]) FORMS.set(f, v);
}
for (const [f, v] of [['goes', 'go'], ['going', 'go'], ['went', 'go'], ['shut', 'shut'], ['cut', 'cut'], ['set', 'set'], ['put', 'put'], ['turnin', 'turn']] as const) FORMS.set(f, v);
const verbOf = (w: string) => (VERBS[w] ? w : FORMS.get(w));

const PARTICLES = new Set(['off', 'on', 'up', 'down', 'out', 'back']);
const DETS = new Set(
  'the a an my our your his her their every each all both some any whole other another la las el los mi mis tu tus su sus un una unos unas todo toda todos todas nuestro nuestra nuestros nuestras ese esa esos esas este estos estas aquel aquella le les des du ma mon mes'.split(' '),
);
/** Words that are a pronoun alone and a determiner before a noun. */
const DEMONSTRATIVE = new Set(['this', 'that', 'these', 'those', 'esta', 'esto', 'eso']);
const PREPS = new Set('in on at of for from by near with to into onto inside over under behind beside next across around through de del en a al con por sobre desde hasta junto'.split(' '));
/** A new clause starts here: its subject, or a word that joins one on. */
const SUBJECTS = new Set(
  'i we he she they you someone somebody everyone everybody nobody there who because cause cuz coz cos since while when if before after until till unless whether que porque alguien nadie yo hay'.split(' '),
);
/** Helpers and "is": a new clause, and the words before may be its subject. */
const AUX = new Set(
  "is are was were am be been being 's do does did not can could will would should must might may gotta gonna wanna need needs needed have has had let lets lemme just already still esta estan es son estoy voy va vamos tengo tiene tienes puedes puede podrias quiero necesito".split(' '),
);
const CONJ = new Set('and or then but also plus so & y e o u luego despues pero tambien entonces'.split(' '));
/** Words that change nothing about what an order acts on. */
const FILLER = new Set('please now again right real quick quickly too as well bit little lot notch tad touch more aca aqui ahi alla porfa porfavor favor ahora poquito poco mas mismo already'.split(' '));
const NUMBERS = /^(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|percent|uno|dos|tres|cuatro|cinco)$/;

/** Things in a house, by kind. What each verb can act on is by kind too. */
const HOUSE = new Map<string, string>();
const kinds: Record<string, string> = {
  av: 'tv tvs television televisions telly tele teles televisor soundbar soundbars stereo roku firestick chromecast projector sonos homepod echo alexa xbox playstation ps4 ps5 nintendo',
  light: 'light lights lamp lamps bulb bulbs chandelier luz luces lampara lamparas foco focos lumiere lumieres lampe lampes',
  climate: 'thermostat thermostats heat heater heaters heating furnace ac aircon fan fans ventilador ventiladores calefaccion termostato aire chauffage ventilateur humidifier dehumidifier purifier fireplace boiler radiator',
  opening: 'door doors deadbolt deadbolts garage gate gates blinds curtains shades shutters puerta puertas porton garaje cochera persiana persianas cortina cortinas porte portes volets',
  place: 'house home car cars truck shed barn mailbox casa carro coche',
  appliance: 'oven ovens stove stovetop dishwasher washer dryer microwave vacuum roomba sprinkler sprinklers kettle coffeemaker toaster fridge freezer iron hottub poolpump horno estufa lavadora secadora lavavajillas microondas aspiradora cafetera nevera refrigerador',
  net: 'router modem wifi extender printer impresora',
  chime: 'doorbell timbre',
  room: 'kitchen bedroom bathroom hallway hall porch patio basement attic office den nursery livingroom diningroom upstairs downstairs yard backyard garden closet laundry cocina sala cuarto habitacion bano recamara comedor jardin oficina pasillo',
};
for (const [kind, words] of Object.entries(kinds)) for (const w of words.split(' ')) HOUSE.set(w, kind);
/** What each kind of order can act on. */
const ACTS_ON: Record<Cls, string> = {
  off: 'av light climate appliance net chime room speaker place',
  on: 'av light climate appliance net chime room speaker place',
  up: 'av light climate speaker',
  down: 'av light climate speaker',
  set: 'av light climate speaker',
  mute: 'av speaker chime',
  media: 'av speaker appliance',
  stop: 'av speaker appliance opening',
  lock: 'opening place',
  unlock: 'opening place',
  lockup: 'opening place',
  open: 'opening place appliance',
  close: 'opening place appliance',
  search: '',
  sleep: 'av net appliance place',
  restart: 'av net appliance place',
  shutdown: 'av net appliance climate light place room speaker',
  other: 'av light climate opening place appliance net chime room speaker',
};

/** The PC itself. */
const PC = new Set('pc pcs computer computers laptop laptops desktop desktops rig workstation tower compu computadora ordenador monitor monitors screen screens display displays pantalla pantallas monitores keyboard mouse webcam'.split(' '));
/** Things on the PC: what plays on it, and apps. */
const MEDIA = new Set(
  'music song songs track tracks video videos movie movies show shows stream streams spotify youtube netflix twitch hulu soundcloud playlist playlists podcast podcasts volume sound sounds audio game games discord chrome browser app apps tab tabs page site website websites channel album artist radio lofi ad ads intro episode appletv speakers speaker musica cancion canciones volumen sonido juego juegos video'.split(' '),
);
/** A thing whose name ends in one of these is an app or a page ("the doorbell app"). */
const APPLIKE = new Set(['app', 'apps', 'website', 'site', 'page', 'tab']);
/** Services: "the doors on youtube" is something to play. */
const SERVICES = new Set(['youtube', 'spotify', 'netflix', 'twitch', 'hulu', 'soundcloud']);
/** "x'll", "x're": the word they stand for. */
const CONTRACTED: Record<string, string> = { "'ll": 'will', "'re": 'are', "'ve": 'have', "'d": 'would', "'m": 'am' };
const PRONOUNS = new Set(['it', 'this', 'that', 'these', 'those', 'them', 'esto', 'eso', 'lo']);
const PEOPLE = new Set(['me', 'us', 'him', 'her', 'everyone', 'everybody', 'myself']);
/** Speakers are the PC's unless a room or a smart speaker is named with them. */
const ROOMY = (words: string[]) => words.some((w) => HOUSE.get(w) === 'room' || HOUSE.get(w) === 'av');

/** After "x's": a sign it means "x is" ("mom's at the door"), not "x's thing" ("mom's lamp"). */
const IS_NEXT = new Set('here there home outside inside back asleep awake up down out gone coming going calling ringing knocking waiting sleeping not so too really still already just gonna about always never on in at by'.split(' '));

/** Phrases first. */
const REWRITES: [RegExp, string][] = [
  [/\b(?:tv|television|tele) (?:shows?|series|episodes?)\b/g, 'show'],
  [/\bapple ?tv\b/g, 'appletv'],
  [/\bfire ?(?:tv|stick)\b/g, 'firestick'],
  [/\bscreen (doors?)\b/g, '$1'],
  [/\bwashing machine\b/g, 'washer'],
  [/\bcoffee ?(?:maker|machine)\b/g, 'coffeemaker'],
  [/\bspace heater\b/g, 'heater'],
  [/\ba\/c\b/g, 'ac'],
  [/\bair[ -]?condition(?:ing|er)\b/g, 'ac'],
  [/\baire acondicionado\b/g, 'ac'],
  [/\bhot tub\b/g, 'hottub'],
  [/\bpool pump\b/g, 'poolpump'],
  [/\bwi-?fi\b/g, 'wifi'],
  [/\bliving ?room\b/g, 'livingroom'],
  [/\bdining ?room\b/g, 'diningroom'],
  [/\bsleep mode\b/g, 'sleep'],
  [/\bshut ?off\b/g, 'shut off'],
  [/\b(?:this|that) (?:thing|one|stuff)\b/g, 'it'],
  [/\bit all\b/g, 'it'],
  [/\bcierra con llave\b/g, 'bloquea'],
  [/\b(?:echa|echale) (?:la )?llave a\b/g, 'bloquea'],
  [/\bponle seguro a\b|\bpon(?:le)? (?:el )?seguro a\b/g, 'bloquea'],
  [/\bpon(?:le|lo|la)? pausa\b/g, 'pausa'],
  [/\b(?:one|a) (?:sec|second|moment|minute)\b/g, 'wait'],
];

/** Spanish verbs with a pronoun on the end: "apágalas" is "apaga" + them. */
function enclitic(w: string): string[] | undefined {
  const m = /^(.+?)(selo|sela|melo|mela|los|las|les|nos|lo|la|le|me|te)$/.exec(w);
  if (!m || VERBS[w] || !VERBS[m[1]!] || !/[aeir]$/.test(m[1]!)) return undefined;
  return /^(?:lo|la|los|las|selo|sela|melo|mela)$/.test(m[2]!) ? [m[1]!, 'lo'] : [m[1]!];
}

const BREAK = '|';

/** Their words as plain lower-case tokens, with breaks. */
function tokens(said: string): string[] {
  let s = strip(said.toLowerCase()).replace(/[’‘`´]/g, "'");
  // "T.V.", "A.C." are words.
  s = s.replace(/\b(?:[a-z]\.){1,3}[a-z]\b\.?/g, (m) => m.replace(/\./g, ''));
  for (const [re, to] of REWRITES) s = s.replace(re, to);
  const out: string[] = [];
  for (const m of s.matchAll(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*'?|[,.;:!?()[\]{}"…—–]|\s-+\s|\n/gu)) {
    const t = m[0];
    if (!/[\p{L}\p{N}]/u.test(t)) {
      if (out.at(-1) !== BREAK) out.push(BREAK);
      continue;
    }
    const c = /^(.*?)(n't|'ll|'re|'ve|'d|'m|'s|')$/.exec(t);
    if (c && c[1]) {
      const [, x, tail] = c as unknown as [string, string, string];
      if (tail === "n't") out.push(x === 'wo' ? 'will' : x === 'ca' ? 'can' : x, 'not');
      else if (tail === "'s") out.push(...(/^(?:it|that|there|here|what|who|he|she|someone|somebody|everyone|nobody|where|how|let)$/.test(x) ? [x, 'is'] : [x, "'s"]));
      else if (tail === "'") out.push(x);
      else out.push(x, CONTRACTED[tail]!);
      continue;
    }
    if (t === 'im') out.push('i', 'am');
    else out.push(...(enclitic(t) ?? [t]));
  }
  return out;
}

type Sort = 'pc' | 'house' | 'mixed' | 'pronoun' | 'unknown' | 'none';
interface Np {
  words: string[];
  at: number;
  /** After a preposition ("at the door"): where something is, not what's acted on. */
  inPp: boolean;
}
interface Order {
  cls: Cls;
  at: number;
  stretch: number;
  objs: Np[];
  /** "go to sleep": about the person, it takes no thing named before it. */
  alone?: boolean;
}

/** What a PC thing is: the machine itself ("my screen"), something on it ("the music", "discord",
 *  "me" in a call), or both ("the pc volume", "this on my pc"). Each only stands for the calls it fits. */
type On = 'machine' | 'media' | 'both';

/** The PC, a house thing, both, a pronoun, nothing or something unknown, and the house word. */
function sortNp(np: Np): { sort: Sort; thing?: string; on?: On } {
  const words = np.words.filter((w) => !DETS.has(w) && !FILLER.has(w) && !NUMBERS.test(w) && w !== "'s");
  const p = words.findIndex((w) => PREPS.has(w));
  const core = p < 0 ? words : words.slice(0, p);
  const pp = p < 0 ? [] : words.slice(p + 1);
  const houseIn = (ws: string[]) => ws.find((w) => (HOUSE.has(w) && HOUSE.get(w) !== 'room') || ((w === 'speaker' || w === 'speakers') && ROOMY(ws)));
  const onPc = pp.some((w) => PC.has(w));
  const media = core.some((w) => MEDIA.has(w) || PEOPLE.has(w));
  if (pp.some((w) => SERVICES.has(w))) return { sort: 'pc', on: 'media' };
  if (core.length && APPLIKE.has(core.at(-1)!)) return { sort: 'pc', on: 'media' };
  const house = houseIn(core);
  const pc = core.some((w) => PC.has(w));
  // "the computer room lights", "the lamp by my pc": both named, so not clear.
  if (house && (pc || onPc)) return { sort: 'mixed', thing: house };
  if (house) return { sort: 'house', thing: house };
  if (pc) return { sort: 'pc', on: media ? 'both' : 'machine' };
  const room = core.find((w) => HOUSE.get(w) === 'room');
  if (room && core.every((w) => HOUSE.has(w))) return { sort: 'house', thing: room };
  // "the one in the kitchen": a room says where, and that's the house; "the music in the kitchen" stays the PC's.
  const ppHouse = houseIn(pp) ?? pp.find((w) => HOUSE.get(w) === 'room');
  if (media) return ppHouse ? { sort: 'house', thing: ppHouse } : { sort: 'pc', on: onPc ? 'both' : 'media' };
  if (core.length && core.every((w) => PRONOUNS.has(w))) return ppHouse ? { sort: 'house', thing: ppHouse } : onPc ? { sort: 'pc', on: 'both' } : { sort: 'pronoun' };
  // "all of them": the pronoun after "of".
  if (!core.length && pp.length && pp.every((w) => PRONOUNS.has(w))) return { sort: 'pronoun' };
  if (!core.length) return ppHouse ? { sort: 'house', thing: ppHouse } : onPc ? { sort: 'pc', on: 'both' } : { sort: 'none' };
  if (ppHouse) return { sort: 'house', thing: ppHouse };
  if (room) return { sort: 'house', thing: room };
  return onPc ? { sort: 'pc', on: 'both' } : { sort: 'unknown' };
}

/** Can this order act on this house thing? */
const actsOn = (cls: Cls, thing: string) => ACTS_ON[cls].split(' ').includes(HOUSE.get(thing) ?? ((thing === 'speaker' || thing === 'speakers') ? 'speaker' : ''));

interface Parse {
  orders: Order[];
  /** Things named outside any order, and where. */
  free: Np[];
  /** Which stretch (between breaks) each token is in. */
  stretchOf: number[];
  toks: string[];
}

/** Cut their words into orders and loose things. */
function parse(said: string): Parse {
  const toks = tokens(said);
  const stretchOf: number[] = [];
  let st = 0;
  for (const t of toks) {
    if (t === BREAK) st++;
    stretchOf.push(st);
  }
  const at = (i: number) => (i >= 0 && i < toks.length ? toks[i]! : BREAK);
  const isVerb = (i: number): string | undefined => {
    const w = at(i);
    const v = verbOf(w);
    if (!v) return undefined;
    const prev = at(i - 1);
    // "the lock screen", "a play button", "mom's stop": a noun here.
    if (DETS.has(prev) || (prev === "'s" && !copula(i - 1)) || NUMBERS.test(prev) || (DEMONSTRATIVE.has(prev) && prev !== 'esta')) return undefined;
    // "para" starts a clause as a verb; inside one it's "for".
    if (v === 'para' && prev !== BREAK && !CONJ.has(prev) && i > 0) return undefined;
    return v;
  };
  // "x's": "x is" when what follows isn't a noun.
  function copula(i: number): boolean {
    const n = at(i + 1);
    return at(i) === "'s" && (IS_NEXT.has(n) || n === BREAK || /ing$/.test(n) || PREPS.has(n) || !!verbOf(n));
  }
  const kind = (i: number): 'break' | 'verb' | 'subj' | 'aux' | 'conj' | 'det' | 'prep' | 'particle' | 'filler' | 'word' => {
    const w = at(i);
    if (w === BREAK) return 'break';
    if (w === "'s") return copula(i) ? 'aux' : 'filler';
    if (isVerb(i)) return 'verb';
    if (SUBJECTS.has(w)) return 'subj';
    if (w === 'esta') return nounish(i + 1) ? 'det' : 'aux';
    if (AUX.has(w)) return 'aux';
    if (CONJ.has(w)) return 'conj';
    if (DEMONSTRATIVE.has(w)) return nounish(i + 1) ? 'det' : 'word';
    if (DETS.has(w)) return 'det';
    if (PARTICLES.has(w)) return 'particle';
    if (PREPS.has(w)) return 'prep';
    if (FILLER.has(w)) return 'filler';
    return 'word';
  };
  function nounish(i: number): boolean {
    const w = at(i);
    return w !== BREAK && !verbOf(w) && !SUBJECTS.has(w) && !AUX.has(w) && !CONJ.has(w) && !PREPS.has(w) && !PARTICLES.has(w) && !FILLER.has(w) && w !== "'s";
  }

  const orders: Order[] = [];
  const free: Np[] = [];
  const used = new Set<number>();
  /** Things in a list of words: split on "and", "or" and a new "the" after a noun. */
  const nps = (idx: number[]): Np[] => {
    const out: Np[] = [];
    let cur: number[] = [];
    let seenNoun = false;
    const flush = () => {
      if (cur.length) out.push({ words: cur.map((j) => toks[j]!), at: cur[0]!, inPp: PREPS.has(toks[cur[0]!]!) });
      cur = [];
      seenNoun = false;
    };
    for (const j of idx) {
      const k = kind(j);
      if (k === 'conj') {
        flush();
        continue;
      }
      if (k === 'det' && seenNoun && !PREPS.has(toks[cur.at(-1)!]!)) flush();
      cur.push(j);
      if (k === 'word') seenNoun = true;
    }
    flush();
    return out;
  };

  for (let i = 0; i < toks.length; i++) {
    const v = isVerb(i);
    if (v) {
      const verb = VERBS[v]!;
      let j = i + 1;
      let particle = '';
      let cls: Cls | undefined;
      if (PARTICLES.has(at(j)) && verb[at(j)]) particle = at(j++);
      let alone = false;
      if (v === 'go' && at(j) === 'to') {
        alone = at(j + 1) === 'sleep';
        cls = at(j + 1) === 'sleep' ? 'sleep' : 'search';
        j += at(j + 1) === 'sleep' ? 2 : 1;
      }
      // What it acts on: up to a break, a verb, a new clause, or "and" before one.
      const span: number[] = [];
      let byAux = false;
      for (; j < toks.length; j++) {
        const k = kind(j);
        if (k === 'break' || k === 'verb' || k === 'subj') break;
        if (k === 'aux') {
          byAux = true;
          break;
        }
        if (k === 'conj') {
          const n = kind(j + 1);
          if (n === 'verb' || n === 'subj' || n === 'aux' || n === 'break' || n === 'conj') break;
        }
        if (k === 'det' && span.some((s) => kind(s) === 'word') && !PREPS.has(toks[span.at(-1)!]!) && kind(span.at(-1)!) !== 'conj') {
          // A new "the" after a thing: another clause if a verb or "is" follows ("pause the music the tv is loud").
          let n = j + 1;
          while (n < toks.length && !['break', 'verb', 'subj', 'aux'].includes(kind(n)) && !(kind(n) === 'conj' && kind(n + 1) === 'verb')) n++;
          if (n < toks.length && ['verb', 'subj', 'aux'].includes(kind(n))) break;
        }
        span.push(j);
      }
      // "turn the lights off", "shut it down", "turn my music down and the tv up": the particle at the
      // end of a thing, before a preposition, a filler or "and".
      const tail = span.findIndex((s, n) => {
        if (!PARTICLES.has(toks[s]!) || verb[toks[s]!] === undefined) return false;
        const rest = span.slice(n + 1);
        const cut = rest.findIndex((r) => kind(r) === 'conj');
        return (cut < 0 ? rest : rest.slice(0, cut)).every((r) => ['filler', 'prep'].includes(kind(r)) || NUMBERS.test(toks[r]!) || (kind(r) === 'det' && toks[r] === 'a'));
      });
      if (!particle && tail >= 0) {
        particle = toks[span[tail]!]!;
        span.splice(tail, 1);
      }
      // "put it to sleep".
      const sleep = span.findIndex((s, n) => toks[s] === 'to' && toks[span[n + 1] ?? -1] === 'sleep');
      if (sleep >= 0) {
        cls = 'sleep';
        span.splice(sleep, 2);
      }
      cls ??= verb[particle] ?? verb['']!;
      let objs = nps(span.filter((s) => !(PARTICLES.has(toks[s]!) && kind(s) === 'particle' && !PREPS.has(toks[s]!))));
      objs = objs.filter((o) => o.words.some((w) => !FILLER.has(w) && !DETS.has(w) && !PREPS.has(w)));
      // "pause the doorbell just rang": a doorbell can't be paused, so a new clause starts there.
      if (['media', 'stop', 'mute'].includes(cls) && objs[0]) {
        const s = sortNp(objs[0]);
        if (s.sort === 'house' && s.thing && !actsOn(cls, s.thing)) free.push(objs.shift()!);
      }
      // "stop the pizza guy is at the gate": the last thing is what "is" is about.
      if (byAux && objs.length) {
        const s = sortNp(objs.at(-1)!).sort;
        if (s === 'unknown' || s === 'none') free.push(objs.pop()!);
      }
      orders.push({ cls, at: i, stretch: stretchOf[i]!, objs, ...(alone ? { alone } : {}) });
      for (let n = i; n < j; n++) used.add(n);
      i = j - 1;
      continue;
    }
    // "lights off", "the tv off please": a particle on its own after a thing.
    if (kind(i) === 'particle' && ['off', 'on', 'out', 'up', 'down'].includes(at(i)) && (kind(i + 1) === 'break' || kind(i + 1) === 'filler' || kind(i + 1) === 'conj' || i + 1 >= toks.length)) {
      orders.push({ cls: ({ off: 'off', out: 'off', on: 'on', up: 'up', down: 'down' } as const)[at(i) as 'off'], at: i, stretch: stretchOf[i]!, objs: [] });
      used.add(i);
    }
  }
  // Loose things: words outside every order.
  let run: number[] = [];
  const flushRun = () => {
    if (run.length) free.push(...nps(run).filter((o) => o.words.some((w) => !FILLER.has(w) && !DETS.has(w) && !PREPS.has(w))));
    run = [];
  };
  for (let i = 0; i < toks.length; i++) {
    const k = kind(i);
    if (used.has(i) || !['word', 'det', 'prep', 'filler', 'conj'].includes(k)) flushRun();
    else run.push(i);
  }
  flushRun();
  // A stretch that is only things ("..., and the screens") adds to the order before it.
  for (const np of [...free]) {
    const s = stretchOf[np.at]!;
    const inStretch = toks.map((_, n) => n).filter((n) => stretchOf[n] === s && toks[n] !== BREAK);
    const onlyThings = inStretch.every((n) => ['word', 'det', 'prep', 'filler', 'conj'].includes(kind(n)));
    const before = orders.filter((o) => o.stretch === s - 1).at(-1);
    // "pause, the garage": a garage can't be paused, so it isn't what the pause was for.
    const s0 = sortNp(np);
    const unfit = before && ['media', 'stop', 'mute'].includes(before.cls) && s0.sort === 'house' && s0.thing && !actsOn(before.cls, s0.thing);
    if (onlyThings && before && !np.inPp && !unfit) {
      before.objs.push(np);
      free.splice(free.indexOf(np), 1);
    }
  }
  free.sort((a, b) => a.at - b.at);
  return { orders, free, stretchOf, toks };
}

/** Who an order is for: the PC (or nothing named), a house thing, or not clear. */
type Target = { to: 'pc'; on?: On } | { to: 'house'; thing: string } | { to: 'unclear' | 'mixed' | 'unknown'; thing?: string };
const pcOf = (on: On | undefined): Target => (on ? { to: 'pc', on } : { to: 'pc' });

/** Who each thing an order acts on is for (one entry when it acts on nothing named). */
function targetsOf(o: Order, p: Parse): Target[] {
  if (o.cls === 'search') return [{ to: 'pc', on: 'media' }];
  const things = [...p.orders.flatMap((x) => x.objs), ...p.free];
  /** The thing "it" stands for: the nearest one named before. */
  const antecedent = (at: number) =>
    things
      .filter((n) => n.at < at)
      .map((n) => ({ n, s: sortNp(n) }))
      .filter((x) => x.s.sort === 'house' || x.s.sort === 'pc' || x.s.sort === 'mixed')
      .sort((a, b) => b.n.at - a.n.at)[0];
  const resolve = (at: number): Target => {
    const a = antecedent(at);
    if (!a || a.s.sort === 'pc') return pcOf(a?.s.on);
    if (a.s.thing && actsOn(o.cls, a.s.thing)) return { to: 'house', thing: a.s.thing };
    return { to: 'unclear', ...(a.s.thing ? { thing: a.s.thing } : {}) };
  };
  let ts: Target[];
  // A thing that is nothing ("for the night") isn't what it acts on.
  const objs = o.objs.filter((n) => sortNp(n).sort !== 'none');
  if (objs.length) {
    ts = objs.map((n): Target => {
      const s = sortNp(n);
      if (s.sort === 'pronoun') return resolve(n.at);
      if (s.sort === 'house') return { to: 'house', thing: s.thing! };
      if (s.sort === 'mixed' || s.sort === 'unknown') return { to: s.sort, ...(s.thing ? { thing: s.thing } : {}) };
      return pcOf(s.on);
    });
  } else {
    let t: Target;
    // Nothing after it: the thing right before it in the same stretch, if any ("the lights need to be
    // turned off"); a particle alone at the start of one takes the thing before the break ("the office lights, off").
    const first = p.toks.slice(0, o.at).every((w, n) => w === BREAK || p.stretchOf[n]! < o.stretch);
    // Or a stretch of things alone before the break takes it ("the lights, turn off", "front door. lock.").
    const back = first && (isPostfix(o, p) || thingsOnly(p, o.stretch - 1));
    const reach = (n: Np) => p.stretchOf[n.at] === o.stretch || (back && p.stretchOf[n.at] === o.stretch - 1);
    const near = o.alone ? undefined : things.filter((n) => n.at < o.at && reach(n)).sort((a, b) => b.at - a.at)[0];
    const s = near && !near.inPp ? sortNp(near) : undefined;
    if (s?.sort === 'house' && s.thing && actsOn(o.cls, s.thing)) t = { to: 'house', thing: s.thing };
    else if (s?.sort === 'pronoun') t = resolve(near!.at);
    else if (s?.sort === 'pc') t = pcOf(s.on);
    else {
      const house = things.filter((n) => p.stretchOf[n.at] === o.stretch).map(sortNp).find((x) => x.sort === 'house' || x.sort === 'mixed');
      t = house ? { to: 'unclear', ...(house.thing ? { thing: house.thing } : {}) } : { to: 'pc' };
    }
    ts = [t];
  }
  // "Lock up" is the house unless the PC is named.
  if (o.cls === 'lockup' && !o.objs.some((n) => n.words.some((w) => PC.has(w)))) {
    const h = ts.find((x) => x.to === 'house');
    return [{ to: 'house', thing: h?.to === 'house' ? h.thing : 'house' }];
  }
  return ts;
}

/** Only things in this stretch: no verb, no "is", no new clause ("the lights, ..."). */
function thingsOnly(p: Parse, stretch: number): boolean {
  const ws = p.toks.filter((w, n) => p.stretchOf[n] === stretch && w !== BREAK);
  return ws.length > 0 && !p.orders.some((o) => o.stretch === stretch) && !ws.some((w) => AUX.has(w) || SUBJECTS.has(w) || w === "'s");
}

/** An order made of its particle alone ("the office lights, off"). */
function isPostfix(o: Order, p: Parse): boolean {
  return PARTICLES.has(p.toks[o.at]!) && !verbOf(p.toks[o.at]!);
}

/** Orders that could stand for each call. */
const CANDIDATES: Record<string, Cls[]> = {
  'pc_system.lock': ['lock', 'lockup'],
  'pc_system.screen_off': ['off'],
  'pc_system.sleep': ['sleep', 'off'],
  'pc_system.restart': ['restart', 'off', 'on'],
  'pc_system.shutdown': ['shutdown', 'off'],
  pc_volume: ['up', 'down', 'set', 'mute', 'off'],
  pc_media: ['media', 'stop', 'off', 'on'],
  pc_open: ['open', 'search', 'media', 'on'],
};
/** A bare "mute" may be taken for a pause, and a bare "pause" or "stop" for a mute. */
const BARE_TOO: Record<string, Cls[]> = { pc_volume: ['media', 'stop'], pc_media: ['mute'] };
/** Never refused: refusing a call-off lets the power-down happen, and these only look or put back. */
const NEVER = new Set(['pc_system.cancel_shutdown', 'pc_volume.get', 'pc_media.status']);

export type Judged = { go: true } | { go: false; ask: true } | { go: false; ask: false; thing: string };

/** May this pc_ call go ahead on what they said? `ask`: only after their yes (lock, screen_off). */
export function judge(said: string | undefined, name: string, action: string): Judged {
  const key = name === 'pc_system' ? `${name}.${action}` : name;
  const cands = CANDIDATES[key];
  if (!said?.trim() || !cands || NEVER.has(`${name}.${action}`)) return { go: true };
  const p = parse(said);
  const system = name === 'pc_system';
  // The machine stands for pc_system calls, and what's on it for the rest: "turn off the lights
  // and the music" is no screen_off, and "turn off my screen and the tv" no mute.
  const fits = (t: Target) => t.to === 'pc' && (!t.on || t.on === 'both' || t.on === (system ? 'machine' : 'media'));
  let ask = false;
  let thing: string | undefined;
  for (const o of p.orders.filter((x) => cands.includes(x.cls) || (!x.objs.length && BARE_TOO[key]?.includes(x.cls)))) {
    const ts = targetsOf(o, p).filter((t) => t.to !== 'pc' || fits(t));
    if (ts.some((t) => t.to === 'pc')) return { go: true };
    if (ts.some((t) => t.to === 'unclear' || t.to === 'unknown')) {
      if (!system) return { go: true };
      ask = true;
    } else if (ts.some((t) => t.to === 'mixed')) {
      const m = ts.find((t) => t.to === 'mixed');
      if (system) ask = true;
      else thing ??= (m?.to === 'mixed' ? m.thing : undefined) ?? 'house';
    } else {
      const h = ts.find((t) => t.to === 'house');
      if (h?.to === 'house') thing ??= h.thing;
    }
  }
  if (ask) return { go: false, ask: true };
  if (thing) return { go: false, ask: false, thing };
  // No order stands for it: refused if any order there is about the house.
  for (const o of p.orders) {
    const h = targetsOf(o, p).find((t) => t.to === 'house');
    if (h?.to === 'house') return { go: false, ask: false, thing: h.thing };
  }
  // A thing in the house with no verb ("kitchen lights please", "the tv is too loud").
  for (const np of p.free) {
    const s = sortNp(np);
    const clause = p.toks.slice(0, np.at).filter((_, n) => p.stretchOf[n] === p.stretchOf[np.at]);
    if (s.sort === 'house' && !np.inPp && !clause.some((w) => SUBJECTS.has(w))) return { go: false, ask: false, thing: s.thing! };
  }
  return { go: true };
}

/** Is this app name a house thing ("garage", "the front door")? */
export function houseName(name: string): string | undefined {
  const ws = tokens(name).filter((w) => w !== BREAK && !DETS.has(w));
  if (!ws.length || !ws.every((w) => HOUSE.has(w) || ['front', 'back', 'side'].includes(w))) return undefined;
  const t = ws.filter((w) => HOUSE.get(w) !== 'room' && !['front', 'back', 'side'].includes(w));
  return t.length ? ws.join(' ') : undefined;
}

/** Their orders as text, for tests: "off(the lights)=house". */
export function explain(said: string): string[] {
  const p = parse(said);
  return [
    ...p.orders.map((o) => {
      const ts = targetsOf(o, p).map((t) => `${t.to}${'thing' in t && t.thing ? `:${t.thing}` : ''}${'on' in t && t.on ? `:${t.on}` : ''}`);
      return `${o.cls}(${o.objs.map((n) => n.words.join(' ')).join(' + ')})=${ts.join(',')}`;
    }),
    ...p.free.map((n) => `[${n.words.join(' ')}]`),
  ];
}
