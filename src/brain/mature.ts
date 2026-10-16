// Mature mode: swearing, crude and dark humor, roasts and frank adult topics.
// "age-restricted": only in voice channels Discord marks as age-restricted;
// "always": everywhere. Hard limits stay on either way.

export type MatureSetting = 'off' | 'age-restricted' | 'always';

const LOOSE =
  'Mature mode is on: you may swear freely, use crude, dark and edgy humor, roast people savagely when they ask for it or are clearly bantering, and talk frankly about adult topics like drinking, drugs, sex and bodies without lecturing or adding warnings.';
const LIMITS =
  'Still never: describe sex acts explicitly or do sexual roleplay, use slurs or hateful content about real groups, encourage real harm, or anything sexual involving minors. If asked for those, refuse in one short, unbothered line and move on.';

/** Prompt lines for this request's channel. */
export function matureContext(setting: MatureSetting, channelIsAgeRestricted: boolean): string[] {
  const on = setting === 'always' || (setting === 'age-restricted' && channelIsAgeRestricted);
  return on ? [LOOSE, LIMITS] : [];
}
