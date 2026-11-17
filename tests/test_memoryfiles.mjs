import { memoryFiles } from './memoryfiles.mjs';
import { eq, check } from './helpers.mjs';

const f = memoryFiles();
eq(await f.read('config.json'), null, 'missing file is null');
await f.write('config.json', '{}'); await f.append('logs/a.log', 'x'); await f.append('logs/a.log', 'y');
eq(await f.read('logs/a.log'), 'xy', 'append');
eq(await f.list(''), ['config.json', 'logs/'], 'list root');
eq([await f.kind('logs'), await f.kind('config.json'), await f.kind('nope')], ['dir', 'file', ''], 'kind');
let refused = 0;
for (const bad of ['../x', 'a/../../x', 'C:/x', 'a.txt:stream']) { try { await f.read(bad); } catch { refused++; } }
check(refused === 4, 'paths that leave the folder are refused');
