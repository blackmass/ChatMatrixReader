"""The program version. Change it here (and only here) when a release is made; tag the GitHub release with the same number."""
__version__ = "2.0.0"
PRERELEASE = "dev"                                                    # "" for a release; "dev" / "beta.1" while 2.0 is being built
MAJOR = int(__version__.split(".")[0])                               # this line of versions only looks for releases of its own major version (2.x)
DISPLAY = __version__ + ("-" + PRERELEASE if PRERELEASE else "")      # what the window title / About shows
REPO = "blackmass/ChatMatrixReader"
RELEASES_URL = f"https://github.com/{REPO}/releases"                 # opened in the browser (fixed, never taken from the server)
LATEST_API = f"https://api.github.com/repos/{REPO}/releases?per_page=30"      # the list: the newest one of OWN major version is picked
