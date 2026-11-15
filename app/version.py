"""The program version. Change it here (and only here) when a release is made; tag the GitHub release with the same number."""
__version__ = "1.8.1"
MAJOR = int(__version__.split(".")[0])                              # this line of versions only looks for releases of its own major version (1.x)
REPO = "blackmass/ChatMatrixReader"
RELEASES_URL = f"https://github.com/{REPO}/releases"                 # opened in the browser (fixed, never taken from the server)
LATEST_API = f"https://api.github.com/repos/{REPO}/releases?per_page=30"      # the list: the newest one of OWN major version is picked
