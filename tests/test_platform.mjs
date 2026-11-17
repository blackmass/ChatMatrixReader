// Which system the program runs on: a page outside the program (the tests) counts as Windows. (The macOS note of the voice tab is in the browser test.)
import { check } from './helpers.mjs';
const { OS, isMac } = await import('../app/platform.js');
check(OS === 'windows' && isMac === false, 'a page outside the program is "windows"');
