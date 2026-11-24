// The program version. Change it here (and only here) when a release is made; tag the GitHub release with the same number.
export const VERSION = '3.2.1';
export const PRERELEASE = '';                                  // '' for a release; 'dev' / 'beta.1' while 3.0 is being built
export const MAJOR = Number(VERSION.split('.')[0]);               // this line of versions only looks for releases of its own major version (3.x)
export const DISPLAY = VERSION + (PRERELEASE ? '-' + PRERELEASE : '');
export const REPO = 'blackmass/ChatMatrixReader';
export const RELEASES_URL = `https://github.com/${REPO}/releases`;                 // opened in the browser (fixed, never taken from the server)
export const LATEST_API = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
