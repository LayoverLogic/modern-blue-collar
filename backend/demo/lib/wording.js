/**
 * demo/lib/wording.js — country wording checks for demo data (B3 item 11b).
 *
 *   wordingProblems(text, country) → ['"outlets" (US wording)', ...]
 *
 * An Irish demo must not show American trade words ("outlets", "furnace",
 * "main floor", "faucet", feet / gallons…), and a US demo must not show Irish
 * ones ("consumer unit", "Eircode", "hot press"…). Used by demo:check
 * (db.wording) and by the fixture tests in tests/whitelabel.test.js.
 */
'use strict';

const US_ONLY = [
  [/\boutlets?\b/i, 'outlet'], [/\bmain floor\b/i, 'main floor'], [/\bfurnaces?\b/i, 'furnace'],
  [/\bfaucets?\b/i, 'faucet'], [/\bgfci\b/i, 'GFCI'], [/\bpanel upgrade\b/i, 'panel upgrade'],
  [/\b(breaker|main|electrical) panel\b/i, 'panel (consumer unit)'], [/\bsub-?panels?\b/i, 'subpanel'],
  [/\baluminum\b/i, 'aluminum'], [/\bdrywall\b/i, 'drywall'], [/\bgallons?\b/i, 'gallon'],
  [/\b\d+(\.\d+)?\s?(ft|feet|foot|sq\.? ?ft)\b/i, 'feet'], [/\bwater heaters?\b/i, 'water heater'],
  [/\bgarbage disposal\b/i, 'garbage disposal'], [/\bzip code\b/i, 'ZIP code'], [/\b(120|240)\s?v\b/i, '120/240V'],
  [/\bback ?yard\b/i, 'backyard'], [/\bHVAC\b/, 'HVAC'], [/\bA\/C\b|\bAC (unit|install|repair)\b/, 'A/C'],
  [/\blicensed electrician\b/i, 'licensed'], [/\btune-?up\b/i, 'tune-up'], [/\bcondo\b/i, 'condo'],
  [/\bduct ?work\b/i, 'ductwork'], [/\bthermostat wire\b/i, 'thermostat wire'], [/\bcrawl ?space\b/i, 'crawlspace'],
  [/\bfahrenheit|°F\b/i, '°F'], [/\bpermit pulled\b/i, 'permit'],
];
const IE_ONLY = [
  [/\bconsumer unit\b/i, 'consumer unit'], [/\beircode\b/i, 'Eircode'], [/\bhot press\b/i, 'hot press'],
  [/\bfuse board\b/i, 'fuse board'], [/\bRCBO\b/, 'RCBO'], [/\bSafe Electric\b/i, 'Safe Electric'],
  [/\bimmersion\b/i, 'immersion'], [/\bSEAI\b/, 'SEAI'], [/\bgarda\b/i, 'garda'],
];

function wordingProblems(text, country) {
  if (!text) return [];
  const list = String(country).toUpperCase() === 'IE' ? US_ONLY : IE_ONLY;
  const label = String(country).toUpperCase() === 'IE' ? 'US wording' : 'Irish wording';
  return list.filter(([re]) => re.test(text)).map(([, w]) => `"${w}" (${label})`);
}

module.exports = { wordingProblems, US_ONLY, IE_ONLY };
