// The widgets the program has of its own (every page that needs the definitions makes the same registry from this).
import { Registry } from './registry.js';
import { VOICE_WIDGET } from './core_voice.js';

export function defaultRegistry() {
  const r = new Registry();
  r.register(VOICE_WIDGET);
  return r;
}

// the registry of a page that lists the widgets (the options window): one for the page, so that what is registered later (a plugin) shows up in the list
export const registry = defaultRegistry();
