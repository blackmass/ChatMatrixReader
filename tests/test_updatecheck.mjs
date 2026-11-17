import { parse, fmt, isNewer, fetchLatest } from '../app/core/updatecheck.js';
import { check } from './helpers.mjs';
check(JSON.stringify(parse('v1.2.0')) === '[1,2,0]' && JSON.stringify(parse('1.2')) === '[1,2,0]' && parse('x1') === null && parse('v1.2.3.4') === null, 'version tags');
check(isNewer('v3.0.1', '3.0.0') && !isNewer('v3.0.0', '3.0.0') && !isNewer('v2.9.9', '3.0.0') && !isNewer('junk', '3.0.0') && isNewer('v3.10.0', 'v3.9.0'), 'newer');
const http = rel => ({ json: async () => rel });
check(await fetchLatest(http([{ tag_name: 'v4.0.0' }, { tag_name: 'v3.1.0' }, { tag_name: 'v3.2.0', prerelease: true }, { tag_name: 'v3.0.5', draft: true }, { tag_name: 'v3.0.9' }]), { major: 3 }) === 'v3.1.0', 'newest of the own major, no drafts / pre-releases');
let err = ''; try { await fetchLatest(http([{ tag_name: 'v4.0.0' }]), { major: 3 }); } catch (e) { err = String(e.message); }
check(err.includes('no release'), 'nothing of the own major: an error');
check(fmt([3, 0, 1]) === 'v3.0.1', 'fmt');
