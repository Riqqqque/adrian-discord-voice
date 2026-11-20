// The house guard's test table: what someone said, a pc_ call the model might
// make for it, and what has to happen. Labelled by hand, before the guard was
// written. Used by pc-guard.test.ts.
//   go:  it reaches the PC. sleep, restart and shutdown ask their own question
//        first, which is how they always go, so the question counts as go.
//   no:  refused as a house order; nothing reaches the PC, and no power
//        question either (a yes to it would do it).
//   ask: not clear it's the PC: lock and screen_off ask "...the PC?" first.
//        A refusal is fine too; reaching the PC is not.

import type { Tool, ToolContext } from '../src/core/interfaces.js';

export type Want = 'go' | 'no' | 'ask';
export type Call = readonly [name: string, args: Record<string, unknown>];
export interface Case {
  said: string;
  call: Call;
  want: Want;
  cat: string;
}

export const LOCK: Call = ['pc_system', { action: 'lock' }];
export const SO: Call = ['pc_system', { action: 'screen_off' }];
export const SLEEP: Call = ['pc_system', { action: 'sleep' }];
export const RESTART: Call = ['pc_system', { action: 'restart' }];
export const SHUTDOWN: Call = ['pc_system', { action: 'shutdown' }];
export const CANCEL: Call = ['pc_system', { action: 'cancel_shutdown' }];
export const PAUSE: Call = ['pc_media', { action: 'pause' }];
export const PLAY: Call = ['pc_media', { action: 'play' }];
export const NEXT: Call = ['pc_media', { action: 'next' }];
export const PREV: Call = ['pc_media', { action: 'previous' }];
export const STOP: Call = ['pc_media', { action: 'stop' }];
export const STATUS: Call = ['pc_media', { action: 'status' }];
export const DOWN: Call = ['pc_volume', { action: 'down' }];
export const DOWN_PLAYING: Call = ['pc_volume', { action: 'down', playing: true }];
export const DOWN_DISCORD: Call = ['pc_volume', { action: 'down', app: 'discord' }];
export const UP: Call = ['pc_volume', { action: 'up' }];
export const UP_PLAYING: Call = ['pc_volume', { action: 'up', playing: true }];
export const SET20: Call = ['pc_volume', { action: 'set', level: 20 }];
export const MUTE: Call = ['pc_volume', { action: 'mute' }];
export const MUTE_PLAYING: Call = ['pc_volume', { action: 'mute', playing: true }];
export const MUTE_DISCORD: Call = ['pc_volume', { action: 'mute', app: 'discord' }];
export const UNMUTE: Call = ['pc_volume', { action: 'unmute' }];
export const GET: Call = ['pc_volume', { action: 'get' }];
export const URL: Call = ['pc_open', { url: 'https://www.example.com' }];
export const BACK: Call = ['pc_windows', { action: 'back' }];
export const search = (q: string): Call => ['pc_open', { search: q }];
export const youtube = (q: string): Call => ['pc_open', { youtube: q }];
export const openApp = (n: string): Call => ['pc_apps', { action: 'open', name: n }];
export const closeApp = (n: string): Call => ['pc_apps', { action: 'close', name: n }];

const rows = (cat: string, want: Want | undefined, list: [string, Call, Want?][]): Case[] =>
  list.map(([said, call, w]) => ({ said, call, want: w ?? want!, cat }));

export const CASES: Case[] = [
  // H1: a house order with any words between the verb and the thing.
  ...rows('house, any words between', 'no', [
    ['turn off the ceiling fan', SO],
    ['turn off the desk lamp', SO],
    ['turn off the office light', SO],
    ['turn off the christmas lights', SO],
    ['turn off the dining room lights', SO],
    ['turn off every light', SO],
    ['turn off that light', SO],
    ['turn off your lights', SO],
    ['turn off the big tv', SO],
    ["turn off the kids' lights", SO],
    ["turn off mom's lamp", SO],
    ['turn off all the lights', SO],
    ['turn off all the lights downstairs', SO],
    ['turn off the two lamps in the den', SO],
    ['switch off the bathroom fan', SO],
    ['shut off the hallway lights', SO],
    ['kill the porch lights', SO],
    ['turn the christmas tree lights off', SO],
    ['turn the big lamp in the corner off', SO],
    ['turn off the lights in five minutes', SO],
    ['can you turn off the lamp by the couch', SO],
    ['would you mind turning off the bedroom light', SO],
    ['turn off the lights please', SO],
    ['turn the light off', SO],
    ['turn the office lights off', SO],
    ['power off the tv', SHUTDOWN],
    ['turn off the tv in the guest room', SHUTDOWN],
    ['shut down the office tv', SHUTDOWN],
    ['turn off the xbox', SHUTDOWN],
    ['put the house to sleep', SLEEP],
    ['put the tv to sleep', SLEEP],
    ['restart the router', RESTART],
    ['reboot the wifi router', RESTART],
    ['lock the office door', LOCK],
    ['lock the patio door', LOCK],
    ['lock three doors', LOCK],
    ['lock the 2 doors', LOCK],
    ['lock the sliding glass door', LOCK],
    ['lock my car', LOCK],
    ['lock the back gate', LOCK],
    ['lock all the doors', LOCK],
    ['lock every door in the house', LOCK],
    ["lock the kids' bedroom door", LOCK],
    ['lock both of the front doors', LOCK],
    ['could you lock the door to the basement', LOCK],
    ['please lock up the house', LOCK],
    ['lock up for the night', LOCK],
    ['make sure the house is locked up', LOCK],
    ['lock the shed', LOCK],
    ['lock the screen door', LOCK],
    ['lock the front door', LOCK],
    ['shut the garage', SHUTDOWN],
    ['close the garage door', SHUTDOWN],
    ['hit the lights', SO],
    ['get the lights', SO],
    ['lights out', SO],
    ['lights off please', SO],
    ['lights—off', SO],
    ['the tv off please', SO],
    ['turn off the coffee maker', SO],
    ['turn off the kettle', SO],
    ['turn off the fireplace', SO],
    ['turn the dishwasher off', SO],
    ['turn off the tvs', SO],
    ['kill the lights', SO],
    ['turn off the TV', SO],
  ]),
  // House AV and climate orders that a volume or media call could take.
  ...rows('house AV and climate', 'no', [
    ['turn down the office tv', DOWN],
    ['turn down the new tv', DOWN],
    ['turn the bedroom tv down', DOWN],
    ['turn the tv volume down', DOWN],
    ["turn the tv down, it's too loud", DOWN],
    ['mute the sound on the tv', MUTE],
    ['pause the tv, this is boring', PAUSE],
    ['mute the living room tv', MUTE],
    ['pause the big tv', PAUSE],
    ['turn up the volume on the tv', UP],
    ["turn the tv's volume up", UP],
    ['mute the soundbar', MUTE],
    ['pause the roku', PAUSE],
    ['skip this on the tv', NEXT],
    ['resume the show on the tv', PLAY],
    ['turn up the kitchen speaker', UP],
    ['turn down the sonos', DOWN],
    ['turn the heat down', DOWN],
    ['turn the a/c down to 68', DOWN],
    ['can you turn the a/c down', DOWN],
    ['turn the ac up a bit', UP],
    ['turn down the upstairs thermostat', DOWN],
    ['set the thermostat to seventy', SET20],
    ['turn the lights down', DOWN],
    ['pause the music on the tv', PAUSE],
    ['stop the roomba', STOP],
    ['pause the washing machine', PAUSE],
    ['turn on the tv and turn it up', UP],
    ['pause the tv and mute it', MUTE],
    ['turn the tv down a bit', DOWN],
    ['mute the tv', MUTE],
    ['pause the tv', PAUSE],
    ['turn the tv down', DOWN],
    ['unmute the tv', UNMUTE],
    ['turn the tv volume down', DOWN_PLAYING],
    ['mute the bedroom tv', MUTE],
    ['pause the bedroom tv', PAUSE],
    ['turn the heat up', UP],
  ]),
  // H2: a house clause next to another order never makes that order the PC's.
  ...rows('mixed clauses', undefined, [
    ['turn off the lights and lock the office door', LOCK, 'no'],
    ['pause the music and lock the office door', LOCK, 'no'],
    ['pause the music and lock the office door', PAUSE, 'go'],
    ['turn off the lights and lock the side entrance', LOCK, 'ask'],
    ['turn off the lights and lock the windows', LOCK, 'ask'],
    ['turn off the lights and lock the shed', LOCK, 'no'],
    ['lock it and turn off the lights', LOCK, 'go'],
    ['turn off the lights and lock it', LOCK, 'ask'],
    ['close the garage and lock it', LOCK, 'ask'],
    ['lock my pc and the front door', LOCK, 'go'],
    ['lock the front door and my computer', LOCK, 'go'],
    ['lock the door and my computer', LOCK, 'go'],
    ['lock the front door and the pc', LOCK, 'go'],
    ['lock the door and lock my computer', LOCK, 'go'],
    ['turn off the tv and the screens', SO, 'go'],
    ['turn off the lights and the monitor', SO, 'go'],
    ['turn the lights off, turn the screen off', SO, 'go'],
    ['turn off the tv and turn off the display', SO, 'go'],
    ['turn off the lights and turn off my monitors', SO, 'go'],
    ['turn off the lights and turn off the tv', SO, 'no'],
    ['turn off the lights, the tv and the fan', SO, 'no'],
    ['turn off the lights and lock up', LOCK, 'no'],
    ['lock up and turn off the lights', LOCK, 'no'],
    ['lock up, then lock it', LOCK, 'go'],
    ['shut the door and shut down', SHUTDOWN, 'go'],
    ['shut the door and shutdown', SHUTDOWN, 'go'],
    ['close the garage and restart', RESTART, 'go'],
    ['turn off the lights then go to sleep', SLEEP, 'go'],
    ['turn off the lights and sleep mode', SLEEP, 'go'],
    ['lock the doors and put it to sleep', SLEEP, 'go'],
    ['shut the blinds and power it off', SHUTDOWN, 'go'],
    ['turn the tv off and shut it down', SHUTDOWN, 'ask'],
    ['open the garage door and skip this', NEXT, 'go'],
    ['open the garage door and next song', NEXT, 'go'],
    ['close the blinds and go back a song', PREV, 'go'],
    ['turn off the fan and turn me down', DOWN, 'go'],
    ['turn off the lights and lower discord', DOWN_DISCORD, 'go'],
    ['turn off the lights and turn discord down', DOWN_DISCORD, 'go'],
    ['turn off the lights and turn the game down', DOWN, 'go'],
    ['lock the door and mute discord', MUTE_DISCORD, 'go'],
    ['close the garage and make it quieter', DOWN, 'go'],
    ['turn off the lights and resume', PLAY, 'go'],
    ['turn down my music and turn off the lights', DOWN_PLAYING, 'go'],
    ['turn down my music and turn off the lights', SO, 'no'],
    ['turn off the lights and mute the tv', MUTE, 'no'],
    ['skip this song and turn off the tv', NEXT, 'go'],
    ['skip this song and turn off the tv', SO, 'no'],
    ['turn off the porch light and lock my pc', LOCK, 'go'],
    ['turn off the lights and the computer', SHUTDOWN, 'go'],
    ['mute the tv and pause my music', PAUSE, 'go'],
    ['mute the tv and pause my music', MUTE, 'no'],
    ['pause the tv and mute', MUTE, 'no'],
    ['mute the tv and pause', PAUSE, 'no'],
    ['open youtube and turn off the lights', youtube('lofi'), 'go'],
    ['open youtube and turn off the lights', SO, 'no'],
    ['shut down my computer, then lock the front door', SHUTDOWN, 'go'],
    ['shut down my computer, then lock the front door', LOCK, 'no'],
    ['restart my pc and turn on the porch light', RESTART, 'go'],
    ['put my computer to sleep and turn off the lamp', SLEEP, 'go'],
    ['put my computer to sleep and turn off the lamp', SO, 'no'],
    ['turn off the lights and lock', LOCK, 'ask'],
    ["lock the front door, it's late", LOCK, 'no'],
    ['turn off my pc and turn off the lights', SHUTDOWN, 'go'],
    ['turn off my pc and turn off the lights', SO, 'go'],
    ['lock the door and switch off', SHUTDOWN, 'ask'],
  ]),
  // No punctuation, or a dash, colon or newline instead.
  ...rows('no punctuation', undefined, [
    ['pause I gotta open the door', PAUSE, 'go'],
    ['pause — I gotta open the door', PAUSE, 'go'],
    ['pause: gotta open the door', PAUSE, 'go'],
    ['pause - gotta get the door', PAUSE, 'go'],
    ["pause someone's at the door", PAUSE, 'go'],
    ['mute my mom is at the front door', MUTE, 'go'],
    ['pause the doorbell just rang', PAUSE, 'go'],
    ['stop the pizza guy is at the gate', STOP, 'go'],
    ['pause my mom is at the front door', PAUSE, 'go'],
    ['hold on pause I need to grab the door', PAUSE, 'go'],
    ['pause the music someone is at the door', PAUSE, 'go'],
    ['mute I have to answer the door', MUTE, 'go'],
    ['skip this one and lock the back door', NEXT, 'go'],
    ['skip this one and lock the back door', LOCK, 'no'],
    ['turn off the lights lock the door', LOCK, 'no'],
    ['turn off the lights lock my computer', LOCK, 'go'],
    ['lock the door turn off the screen', SO, 'go'],
    ['lock the door turn off the screen', LOCK, 'no'],
    ['pause gotta open the garage', PAUSE, 'go'],
    ['lock my pc im heading out the front door', LOCK, 'go'],
    ['turn the tv off turn my music down', DOWN_PLAYING, 'go'],
    ['turn the tv off turn my music down', SO, 'no'],
    ['pause the doorbell is ringing', PAUSE, 'go'],
    ['stop the dog is barking at the door', STOP, 'go'],
    ['pause because i need to open the door', PAUSE, 'go'],
    ['pause\nI gotta open the door', PAUSE, 'go'],
    ["pause mom's at the door", PAUSE, 'go'],
    ['turn off the lights are too bright', SO, 'no'],
    ['set the volume to 20 the tv is loud', SET20, 'go'],
    ['pause hang on the garage is open', PAUSE, 'go'],
    ['lock im heading out the front door', LOCK, 'ask'],
    ['turn off the lights then lock the door', LOCK, 'no'],
    ['mute\nthe doorbell is ringing', MUTE, 'go'],
  ]),
  // Spanish basics.
  ...rows('spanish', undefined, [
    ['apaga las luces', SO, 'no'],
    ['apaga la luz', SO, 'no'],
    ['apaga la luz de la cocina', SO, 'no'],
    ['apágame las luces', SO, 'no'],
    ['apaga el ventilador del techo', SO, 'no'],
    ['puedes apagar la tele', SO, 'no'],
    ['apaga todas las luces', SO, 'no'],
    ['apaga la lámpara del escritorio', SO, 'no'],
    ['apaga la tele y las luces', SO, 'no'],
    ['apaga el aire', SO, 'no'],
    ['cierra la puerta del garaje', LOCK, 'no'],
    ['cierra con llave la puerta', LOCK, 'no'],
    ['bloquea la puerta de la oficina', LOCK, 'no'],
    ['ponle seguro a la puerta', LOCK, 'no'],
    ['baja el volumen de la tele', DOWN, 'no'],
    ['baja la tele', DOWN, 'no'],
    ['sube la calefacción', UP, 'no'],
    ['sube el aire acondicionado', UP, 'no'],
    ['silencia la tele', MUTE, 'no'],
    ['pausa la tele', PAUSE, 'no'],
    ['prende la tele', PLAY, 'no'],
    ['abre la puerta', URL, 'no'],
    ['abre la puerta del garaje', search('puerta del garaje'), 'no'],
    ['reinicia el router', RESTART, 'no'],
    ['apaga las luces y bloquea la puerta', LOCK, 'no'],
    ['pon acá la música', PLAY, 'go'],
    ['sube acá el volumen', UP, 'go'],
    ['pon la música', PLAY, 'go'],
    ['pausa, tengo que abrir la puerta', PAUSE, 'go'],
    ['pausa que tengo que abrir la puerta', PAUSE, 'go'],
    ['pausa tengo que abrir la puerta', PAUSE, 'go'],
    ['pon pausa, alguien está en la puerta', PAUSE, 'go'],
    ['bloquea la computadora', LOCK, 'go'],
    ['bloquea mi pc', LOCK, 'go'],
    ['apaga la pantalla', SO, 'go'],
    ['apaga las pantallas y las luces', SO, 'go'],
    ['baja la música', DOWN_PLAYING, 'go'],
    ['silencia discord', MUTE_DISCORD, 'go'],
    ['apaga las luces y bloquea la pc', LOCK, 'go'],
    ['reinicia la computadora', RESTART, 'go'],
    ['apaga la compu', SHUTDOWN, 'go'],
    ['siguiente canción y apaga la luz', NEXT, 'go'],
    ['siguiente canción y apaga la luz', SO, 'no'],
    ['cierra la puerta y pon pausa', PAUSE, 'go'],
    ['abre youtube', youtube('lofi'), 'go'],
    ['sube el volumen', UP, 'go'],
  ]),
  // Review S1: a real PC order said next to a house errand.
  ...rows('PC order next to a house errand', 'go', [
    ['pause, gotta open the door', PAUSE],
    ['pause, I need to turn off the stove', PAUSE],
    ['mute, let me open the garage', MUTE],
    ['skip and turn the lights on', NEXT],
    ["lock my pc, I'm heading out the front door", LOCK],
    ['mute, my mom is at the front door', MUTE],
    ['pause the music, my mom is at the front door', PAUSE],
    ['hold on, I gotta open the door', PAUSE],
    ["turn my music down, I'm going to close the garage", DOWN_PLAYING],
    ['turn it down, I have to close the window and the door', DOWN],
    ["lock my computer, I'm going to lock up the house", LOCK],
    ["lock it, I'm leaving, and turn off the lights", LOCK],
    ["screen off, I'm going to turn the lamp on", SO],
    ['turn off my monitors and the lights', SO],
    ['turn off my screen before I turn the tv on', SO],
    ['pause it, the tv is too loud', PAUSE],
    ["pause the video, I'm turning the tv on", PAUSE],
    ['turn the volume up, the heater is loud', UP],
    ['turn up my music, the fan is too loud', UP_PLAYING],
    ["skip this, I'll lock the door later", NEXT],
    ['stop the music, I need to unlock the door for my sister', STOP],
    ["resume, the door's locked", PLAY],
    ["play it again, then I'll turn the lights off", PLAY],
    ["mute discord, I'm going to turn on the tv", MUTE_DISCORD],
    ['pause, the garage door is open', PAUSE],
    ["pause, the dog's at the door", PAUSE],
    ["mute, someone's knocking on the door", MUTE],
    ['hold on pause', PAUSE],
    ['lock my pc then lock the front door', LOCK],
    ['pause and get the door', PAUSE],
    ['mute and close the garage', MUTE],
    ['pause then lock the front door', PAUSE],
    ['lock it, then turn off the porch light', LOCK],
    ['turn off my screen and lock the front door', SO],
    ['lock the screen and the front door', LOCK],
    ['lock it and lock the door', LOCK],
    ['lock the door and mute discord', MUTE_DISCORD],
    ['turn the lights off and resume', PLAY],
    ['shut the garage, mute', MUTE],
    ['shut the garage, quieter', DOWN],
    // A bare "mute" the model takes for a pause, and the other way round.
    ['mute, let me open the garage', PAUSE],
    ['pause, let me lock the door', MUTE],
    ['stop, someone is at the door', MUTE],
  ]),
  // Plain PC orders.
  ...rows('plain PC orders', 'go', [
    ['lock my pc', LOCK],
    ['lock it', LOCK],
    ['lock', LOCK],
    ['lock the computer', LOCK],
    ['lock the screen', LOCK],
    ['lock my screen', LOCK],
    ['lock this thing', LOCK],
    ['turn off my screen', SO],
    ['turn off the screens', SO],
    ['turn off my monitors', SO],
    ['screens off', SO],
    ['turn the monitors off', SO],
    ['kill the screens', SO],
    ['turn the screen off', SO],
    ['turn off the display', SO],
    ['turn it off', SO],
    ['monitors off please', SO],
    ['shut down my computer', SHUTDOWN],
    ['shut it down', SHUTDOWN],
    ['shut down', SHUTDOWN],
    ['restart my pc', RESTART],
    ['reboot', RESTART],
    ['put my computer to sleep', SLEEP],
    ['go to sleep', SLEEP],
    ['sleep mode', SLEEP],
    ['turn off the computer', SHUTDOWN],
    ['power off my pc', SHUTDOWN],
    ['pause', PAUSE],
    ['pause it', PAUSE],
    ['skip this song', NEXT],
    ['next', NEXT],
    ['play', PLAY],
    ['resume', PLAY],
    ['stop the music', STOP],
    ['mute', MUTE],
    ['mute discord', MUTE_DISCORD],
    ['mute the video', MUTE_PLAYING],
    ['turn it down a little', DOWN],
    ['turn down my music', DOWN_PLAYING],
    ['can you turn the music up a bit', UP_PLAYING],
    ['set the volume to 30', SET20],
    ['turn the whole pc volume down', DOWN],
    ['make it louder', UP],
    ['quieter', DOWN],
    ['unmute', UNMUTE],
    ['turn off the music', PAUSE],
    ['kill the music', PAUSE],
    ['lower the game', DOWN],
    ['turn down valorant', DOWN],
    ['turn the stream down', DOWN],
    ['turn down the speakers', DOWN],
    ['go back a song', PREV],
    ['play the next one', NEXT],
    ['mute the tv show', MUTE_PLAYING],
    ['pause the tv series', PAUSE],
    ['pause the video', PAUSE],
    ['turn off my screen', SO],
    ['yes restart it', RESTART],
    ['adrian lock my pc', LOCK],
    ['hey adrian, turn the music down', DOWN_PLAYING],
  ]),
  // pc_open and app names.
  ...rows('open and apps', undefined, [
    ['open the garage door', search('garage door'), 'no'],
    ['open the front door', URL, 'no'],
    ['open the door', URL, 'no'],
    ['open the blinds', openApp('blinds'), 'no'],
    ['open the garage', openApp('garage'), 'no'],
    ['open garage', openApp('garage'), 'no'],
    ['close the blinds', closeApp('blinds'), 'no'],
    ['close it', closeApp('the front door'), 'no'],
    ['open the tv app', openApp('TV'), 'go'],
    ['open the garage app', openApp('garage'), 'go'],
    ['open doordash', openApp('doordash'), 'go'],
    ['open garageband', openApp('garageband'), 'go'],
    ['open the apple tv app', openApp('apple tv'), 'go'],
    ['play the doors on youtube', youtube('the doors'), 'go'],
    ['look up how to fix a garage door', search('how to fix a garage door'), 'go'],
    ['pull up garage door openers on amazon', search('garage door openers amazon'), 'go'],
    ['search for led lights', search('led lights'), 'go'],
    ['find me a new desk lamp on amazon', search('desk lamp amazon'), 'go'],
    ['go to reddit', URL, 'go'],
    ['open youtube', youtube('home'), 'go'],
    ['put on some lofi on youtube', youtube('lofi'), 'go'],
    ['show me smart thermostats on best buy', search('smart thermostats best buy'), 'go'],
    ['open the JEI Mod Drinth page', search('JEI mod modrinth'), 'go'],
    ['google how to reset a thermostat', search('how to reset a thermostat'), 'go'],
  ]),
  // Calling things off, putting things back and looking things up: never refused.
  ...rows('undo and lookups', 'go', [
    ['cancel the shutdown', CANCEL],
    ['stop the shutdown, I need to lock the door', CANCEL],
    ["don't shut down, I meant the tv", CANCEL],
    ['cancel, turn off the tv instead', CANCEL],
    ['wait no, I meant the garage door', CANCEL],
    ['cancel the shutdown and turn the lights back on', CANCEL],
    ['wait, turn the lights back on', CANCEL],
    ['turn off the lights', CANCEL],
    ["what's the volume, the tv is loud", GET],
    ["what's playing on the tv", STATUS],
    ['put it back, the lights are off', BACK],
    ['undo that, the lights are off', BACK],
    ['the lights are off, unmute', UNMUTE],
    ['the door is locked, resume', PLAY],
  ]),
  // Not clear it's the PC: the dangerous ones ask.
  ...rows('unclear', 'ask', [
    ['lock the windows', LOCK],
    ['lock everything', LOCK],
    ['turn everything off', SO],
    ['lock the side entrance', LOCK],
    ['turn off the box', SO],
    ['turn off the thing in the corner', SO],
    ['turn off the computer room lights', SO],
    ['turn off the tv screen', SO],
    ['turn off the sprinkler system', SO],
    ['close the garage. lock it', LOCK],
  ]),
  // The thing before the verb, or no verb at all.
  ...rows('thing before the verb, or no verb', 'no', [
    ['the lights need to be turned off', SO],
    ['I want the front door locked', LOCK],
    ['get the tv turned off', SO],
    ['the office lights, off', SO],
    ['kitchen lights please', SO],
    ['tv volume 20', SET20],
    ['thermostat 70', SET20],
    ['can the lights go off', SO],
    ['the garage door needs closing', SHUTDOWN],
    ['I need the doors locked', LOCK],
    ['have the lights turned off', SO],
    ['make the tv quieter', DOWN],
    ['tv quieter', DOWN],
    ['lights', SO],
    ['front door', LOCK],
    ['the tv is too loud', DOWN],
    ['the porch light is still on', SO],
    ['the garage, can you shut it', SHUTDOWN],
    ['the front door, lock it', LOCK],
    ['las luces, apágalas', SO],
    // Added after review: a thing, a break, then the verb alone.
    ['the lights, turn off', SO],
    ['living room tv, mute', MUTE],
    ['front door. lock.', LOCK],
    ['the garage door — close it', SHUTDOWN],
  ]),
  // Added after review: a house thing and the PC named in one phrase.
  ...rows('a house thing and the PC in one phrase', undefined, [
    ['lock the door by my computer', LOCK, 'ask'],
    ['turn down the tv near my computer', DOWN, 'no'],
    ['turn off the lamp next to my pc', SO, 'ask'],
    ['turn off the light on my desk by the monitor', SO, 'ask'],
    ['baja el volumen de la computadora', DOWN, 'go'],
    ['play this on my pc instead', PLAY, 'go'],
    ['put the game on my pc', PLAY, 'go'],
    ['the music, pause', PAUSE, 'go'],
    ['my screen, turn it off', SO, 'go'],
    ['the lights are off, unmute', UNMUTE, 'go'],
  ]),
  // Added after review: what's on the PC stands only for media calls, and the machine only for pc_system.
  ...rows("the machine, or what's on it", undefined, [
    ['turn off the lights and the music', SO, 'no'],
    ['turn off the lights and turn off the music', SO, 'no'],
    ['turn off the music and the lights', SO, 'no'],
    ['turn off the tv and spotify', SHUTDOWN, 'no'],
    ['lock the door and discord', LOCK, 'no'],
    ['turn off the fan and the game', SLEEP, 'no'],
    ['turn off my screen and the tv', MUTE, 'no'],
    ['turn off the monitor and the tv', PAUSE, 'no'],
    ['turn off the music', PAUSE, 'go'],
    ['turn off the music', SO, 'go'],
    ['turn off the lights and the monitor', SO, 'go'],
    ['turn off the lights and the music', PAUSE, 'go'],
    ['turn the whole pc volume down and the tv off', DOWN, 'go'],
    ['play this on my pc and turn off the tv', PLAY, 'go'],
    ['turn down the T.V.', DOWN, 'no'],
    ['turn the A.C. down', DOWN, 'no'],
    ['turn off the T.V.', SO, 'no'],
  ]),
  // Review 6 probe rows not elsewhere, and a little French.
  ...rows('probe rows and French', undefined, [
    ['turn on the porch light and wake the pc', LOCK, 'no'],
    ['open the door app', openApp('door'), 'go'],
    ['éteins la lumière', SO, 'no'],
    ['ferme la porte du garage', LOCK, 'no'],
    ['verrouille la porte', LOCK, 'no'],
    ['baisse la télé', DOWN, 'no'],
    ['éteins les lumières et le ventilateur', SO, 'no'],
  ]),
  // Possessives and "'s" for "is".
  ...rows("possessives and 's", undefined, [
    ["turn off mom's lamp", SO, 'no'],
    ["pause mom's at the door", PAUSE, 'go'],
    ["turn the tv's volume up", UP, 'no'],
    ["mute, the baby's sleeping", MUTE, 'go'],
    ["lock my brother's door", LOCK, 'no'],
    ["pause, my brother's at the door", PAUSE, 'go'],
    ["turn off sam's lights", SO, 'no'],
    ["skip it, sam's at the gate", NEXT, 'go'],
    ["lock dad's car", LOCK, 'no'],
    ["mute the tv, dad's asleep", MUTE, 'no'],
    ["mute, dad's asleep", MUTE, 'go'],
    ["pause the dog's at the door", PAUSE, 'go'],
    ["turn down the kids' tv", DOWN, 'no'],
  ]),
  // Written after the guard, labelled before running it: the first run missed
  // "turn off the one in the kitchen" and "...whatever's on in the living room".
  ...rows('held out (written after the guard; first run 59/61)', 'no', [
    ['switch the hall light off', SO], ['can you kill the lamp next to my bed', SO], ['turn off the light over the sink', SO], ['shut the porch light off', SO],
    ['turn the overhead lights off please', SO], ['lock the deadbolt', LOCK], ['lock up the garage', LOCK], ['lock the car doors', LOCK], ['secure the front door', LOCK],
    ['turn down the living room speakers', DOWN], ['mute the echo', MUTE], ['pause the movie on the tv', PAUSE], ['turn the tv in the basement down', DOWN],
    ['drop the thermostat to 65', SET20], ['turn off the lights in the kids room', SO], ['apaga la luz del baño', SO], ['cierra el garaje', LOCK], ['baja las persianas', DOWN],
    ['apaga el televisor', SO], ['turn off both bedside lamps', SO], ['turn off the string lights on the porch', SO], ['unplug the kettle', SO], ['stop the dishwasher', STOP],
    ['pause the dryer', PAUSE], ['shut off the water heater', SO], ['turn the tv off in 10 minutes', SO], ['open the door for the pizza guy', URL], ['shut down the tv in the den', SHUTDOWN],
  ]),
  ...rows('held out (written after the guard; first run 59/61)', 'go', [
    ['lock this computer', LOCK], ['turn my screens off for now', SO], ['put the pc to sleep', SLEEP], ["mute spotify, the doorbell's ringing", MUTE],
    ['pause the song, gotta grab the door', PAUSE], ['lower the music a bit, my roommate is sleeping', DOWN_PLAYING], ["skip, I'll get the lights later", NEXT],
    ['turn the volume down so I can hear the doorbell', DOWN], ['pause while I check the door', PAUSE], ['lock my computer before I go lock the garage', LOCK],
    ['can you mute discord real quick, the tv is loud', MUTE_DISCORD], ['pause this, the garage door just opened', PAUSE], ["turn it up, I can't hear over the fan", UP],
    ['turn off my monitor so I can sleep', SO], ['silencia, alguien tocó la puerta', MUTE], ['pausa la canción, voy a abrir la puerta', PAUSE],
    ['baja el volumen de spotify', DOWN], ['turn down the youtube video, the heater is loud', DOWN], ['next song then turn off the lights', NEXT],
    ['stop the video and close the garage', STOP], ['mute the game and lock the back door', MUTE], ['lock my pc and then go lock the front door', LOCK],
    ["pause I think someone's at the door", PAUSE], ['pause my show the doorbell rang', PAUSE], ['look up the front door camera', search('front door camera')],
    ['show me the garage camera', search('garage camera')], ['turn discord down and the lights off', DOWN_DISCORD],
  ]),
  ...rows('held out (written after the guard; first run 59/61)', 'ask', [
    ['turn off the fan and lock it', LOCK], ['lock the front', LOCK], ['turn off the one in the kitchen', SO], ['turn off everything downstairs', SO],
    ['lock every door and window', LOCK], ["turn off whatever's on in the living room", SO],
  ]),
  // A second batch, also labelled before running: the first run missed
  // "turn off the lights, all of them" and refused "pause, the garage".
  ...rows('held out 2 (written after the first; first run 39/41)', 'no', [
    ['yo turn off the lights', SO], ['could ya switch off the garage light', SO], ['turn the porch and the kitchen lights off', SO], ['turn off the lights, all of them', SO],
    ['please turn the big tv in the living room down a little', DOWN], ['lights in the hallway off', SO], ['lock the doors, the garage and the gate', LOCK],
    ['garage door, close it', SHUTDOWN], ['tv off', SO], ['tv down', DOWN], ['volume down on the tv', DOWN], ['mute tv', MUTE], ['apaga todo en la sala', SO],
    ['baja un poco la tele', DOWN], ['cerrá la puerta', LOCK], ['turn off the tele', SO], ['can you turn the heating off for the night', SO],
    ['the front door needs locking', LOCK], ['make the lights dimmer', DOWN], ['close the garage door behind me', SHUTDOWN],
  ]),
  ...rows('held out 2 (written after the first; first run 39/41)', 'go', [
    ['yo pause', PAUSE], ['pause it real quick, my dog is barking at the door', PAUSE], ['lock up my pc', LOCK], ['mute everything, the door', MUTE],
    ['next, then lock the door', NEXT], ['lock the computer then the front door', LOCK], ['turn my volume down cause the tv is on', DOWN],
    ["shush, someone's at the door", MUTE], ['pause the stream, gotta let the dog out', PAUSE], ['stop playing, I need to answer the door', STOP],
    ['turn off my second monitor and the lamp', SO], ['mute my mic, the tv is loud', MUTE], ['turn it down a notch, the fan is loud', DOWN],
    ['pon pausa que tocan la puerta', PAUSE], ['bájale a la música', DOWN], ['silencia el juego', MUTE], ['lock my pc i have to go lock the shed', LOCK], ['pause, the garage', PAUSE],
  ]),
  ...rows('held out 2 (written after the first; first run 39/41)', 'ask', [['turn off the lights and the thing', SO], ['lock em', LOCK], ['turn off the speakers in the kitchen', SO]]),
];

/** Every order in these is about the house: nothing a pc_ call does may reach the PC. */
export const HOUSE_ONLY = [
  'turn off the ceiling fan',
  'turn off the lights',
  'turn the living room lights off',
  'lock the office door',
  'lock the front door',
  'lock three doors',
  'can you lock the doors',
  'make sure the house is locked up',
  'lock up for the night',
  'shut the garage',
  'close the garage door',
  'open the garage',
  'open the front door',
  'turn off the TV',
  'turn down the office tv',
  'mute the tv',
  'pause the tv',
  'shut off the tv in the living room',
  'turn the heat down',
  'set the thermostat to seventy',
  'turn off the christmas lights',
  'turn off every light',
  'turn off the lights and lock the office door',
  'turn off the lights and turn off the tv',
  'turn the tv volume down',
  'mute the sound on the tv',
  'kill the lights',
  'lights off please',
  'hit the lights',
  'apaga las luces',
  'cierra la puerta del garaje',
  'baja el volumen de la tele',
  'apágame las luces',
  'restart the router',
  'put the house to sleep',
  'the lights need to be turned off',
  'kitchen lights please',
  'lock the back gate and close the garage',
  'turn off the tv, the lights and the fan',
  'turn the a/c down to 68',
  'unlock the front door',
  'turn on the porch light',
  'close the blinds',
  'stop the roomba',
  'turn the tv off then lock the back door',
];

/** The pc_ calls a house order could be taken for. */
export const GUARDED: Call[] = [
  LOCK, SO, SLEEP, RESTART, SHUTDOWN,
  UP, DOWN, DOWN_PLAYING, SET20, MUTE, UNMUTE,
  PAUSE, PLAY, NEXT, PREV, STOP, ['pc_media', { action: 'play_pause' }],
  URL, search('the thing'), youtube('the thing'),
];

/** H1 as a class: any verb frame, any words in front of any house thing. */
export function generatedHouse(): Case[] {
  const frames: [string, Call, string[]][] = [
    ['turn off {d} {m} {t}', SO, ['lights', 'lamp', 'fan', 'tv', 'heater']],
    ['turn {d} {m} {t} off', SO, ['lights', 'lamp', 'tv']],
    ['switch off {d} {m} {t}', SHUTDOWN, ['tv', 'lights', 'fan']],
    ['lock {d} {m} {t}', LOCK, ['door', 'gate', 'garage door', 'car', 'doors']],
    ['turn down {d} {m} {t}', DOWN, ['tv', 'heat', 'soundbar', 'fan']],
    ['turn {d} {m} {t} down', DOWN_PLAYING, ['tv', 'stereo']],
    ['mute {d} {m} {t}', MUTE, ['tv', 'soundbar']],
    ['pause {d} {m} {t}', PAUSE, ['tv', 'roku']],
    ['shut down {d} {m} {t}', SHUTDOWN, ['tv', 'router']],
    ['open {d} {m} {t}', URL, ['garage door', 'gate', 'blinds']],
    ['apaga {d} {m} {t}', SO, ['luces', 'lámpara', 'tele', 'ventilador']],
  ];
  const dets = ['the', 'my', 'our', 'every', 'all the', 'both', 'that', 'those', 'your'];
  const mods = ['', 'zorblat', 'fourth purple', "kids'", "mom's", 'upstairs', 'big old', '2', 'office', 'christmas', 'new'];
  const out: Case[] = [];
  for (const [frame, call, things] of frames)
    for (const t of things)
      for (const d of frame.startsWith('apaga') ? ['la', 'las', 'el', 'mi'] : dets)
        for (const m of mods)
          out.push({ said: frame.replace('{d}', d).replace('{m}', m).replace('{t}', t).replace(/\s+/g, ' ').trim(), call, want: 'no', cat: 'generated: house, any modifier' });
  return out;
}

/** And the other way: a PC order, then a house errand, joined any way. */
export function generatedPcThenErrand(): Case[] {
  const orders: [string, Call][] = [
    ['pause', PAUSE],
    ['mute', MUTE],
    ['skip', NEXT],
    ['stop', STOP],
    ['lock my pc', LOCK],
    ['turn my music down', DOWN_PLAYING],
    ['pause the music', PAUSE],
    ['turn off my screen', SO],
    ['pausa', PAUSE],
  ];
  const tails = [
    'I gotta open the door',
    "someone's at the door",
    'my mom is at the front door',
    'the doorbell just rang',
    'I need to turn off the stove',
    'let me lock the back door',
    'the pizza guy is at the gate',
    'I have to close the garage',
    'gotta get the door',
    'the tv is too loud',
    "I'm turning the lights off",
  ];
  const joins = [', ', ' ', ' — ', ': ', '. ', '\n', ' because ', ' and '];
  const bare = new Set(['pause', 'mute', 'skip', 'stop', 'pausa']);
  const out: Case[] = [];
  for (const [o, call] of orders)
    for (const t of tails)
      for (const j of joins) {
        // "mute the doorbell just rang", "pause the tv is too loud": with no
        // break, a bare verb right before "the <thing>" may well be an order
        // on it. Not labelled either way here.
        if (bare.has(o) && (j === ' ' || j === ' and ') && t.startsWith('the ')) continue;
        out.push({ said: `${o}${j}${t}`, call, want: 'go', cat: 'generated: PC order, then a house errand' });
      }
  return out;
}

const POWER = new Set(['sleep', 'restart', 'shutdown']);
export type Outcome = 'go' | 'no' | 'ask' | 'other';

/** Run one call through a fresh set of pc_ tools with a stub PC: what happened. */
export async function outcome(pcTools: (d: never) => Tool[], said: string, [name, args]: Call): Promise<{ out: Outcome; result: string }> {
  let reached = 0;
  const pc = { version: '0.17.1', action: async () => (reached++, { ok: true, result: 'Done.' }) };
  const tools = pcTools({ pcFor: () => pc } as never);
  const ctx: ToolContext = { userId: 'u1', speaker: 'Alex', said, turn: 1, channelId: 'sat:x' };
  const r = await tools.find((t) => t.spec.name === name)!.run(structuredClone(args), AbortSignal.timeout(1000), ctx);
  const result = typeof r === 'string' ? r : r.text;
  if (reached) return { out: 'go', result };
  if (/^Didn't happen: .*in the house/.test(result)) return { out: 'no', result };
  if (/\?$/.test(result)) return { out: 'ask', result };
  return { out: 'other', result };
}

const power = (c: Call) => c[0] === 'pc_system' && POWER.has(String(c[1].action));

/** Did it do what the row wants? */
export function passes(c: Case, out: Outcome): boolean {
  if (c.want === 'go') return out === 'go' || (out === 'ask' && power(c.call));
  if (c.want === 'ask') return out === 'ask' || out === 'no';
  return out === 'no';
}

/** A house order reached the PC, or got a power question a yes would act on. */
export const wrongPc = (c: Case, out: Outcome) => c.want !== 'go' && (out === 'go' || (out === 'ask' && c.want === 'no' && power(c.call)));
/** A real PC order refused. */
export const falseRefusal = (c: Case, out: Outcome) => c.want === 'go' && out === 'no';

/** Every row: the hand table, both generated ones, and each house-only line against every guarded call. */
export function allCases(): Case[] {
  return [
    ...CASES,
    ...generatedHouse(),
    ...generatedPcThenErrand(),
    ...HOUSE_ONLY.flatMap((said) => GUARDED.map((call) => ({ said, call, want: 'no' as const, cat: 'house-only line, every guarded call' }))),
  ];
}
