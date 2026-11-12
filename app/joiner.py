"""Puts the pieces of a long chat message together again (see PROTOCOL.md, "long messages").

The addon cuts a message of more than 255 bytes into consecutive lines of the same channel and speaker, with consecutive ids:
    \\5 at the end of a piece     the message goes on in the next line
    \\5 at the start of a piece   this line continues the one before
    \\6<code> at the start         the same, and the piece starts inside the link marker with this code
                                  (the piece before closed that marker with \\3 right before its \\5)
Joiner.feed() takes the lines in the order they were read and gives back the lines to show; a message that is still being
collected is held back. It is closed with an ellipsis as soon as the next line is not its continuation, or when nothing
follows within TIMEOUT seconds (flush_due()). A continuation without its start (the first pieces were lost) is shown
with a leading ellipsis.
"""
import dataclasses

CONT, CONT_IN = "\x05", "\x06"
ELLIPSIS = "…"
TIMEOUT = 1.0                      # seconds to wait for the next piece


def _closed(body):
    """The text, with a link marker that is still open closed."""
    return body + "\x03" if body.count("\x02") > body.count("\x03") else body


class Joiner:
    def __init__(self, timeout=TIMEOUT):
        self.timeout = timeout
        self.line = None           # the message being collected (a Line whose text is what was read so far)
        self.last_id = 0
        self.deadline = 0.0

    # -------------------------------------------------------------- helpers
    def _finish(self, with_ellipsis):
        line, self.line = self.line, None
        if with_ellipsis:
            line = dataclasses.replace(line, text=_closed(line.text) + ELLIPSIS)
        return line

    def pending(self):
        return self.line is not None

    # -------------------------------------------------------------- API
    def feed(self, line, now):
        text = line.text
        lead = None                                   # None, "" (plain continuation) or the link code
        if text.startswith(CONT_IN) and len(text) >= 2:
            lead, text = text[1], text[2:]
        elif text.startswith(CONT):
            lead, text = "", text[1:]
        goes_on = text.endswith(CONT)
        if goes_on:
            text = text[:-1]
        out = []
        if self.line is not None:
            nxt = self.last_id % 65535 + 1
            if lead is not None and line.channel == self.line.channel and line.sender == self.line.sender and line.id == nxt:
                body = self.line.text
                if lead and body.endswith("\x03"):    # the piece before closed the marker: it goes on, so take the close back
                    body = body[:-1]
                self.line = dataclasses.replace(self.line, text=body + text)
                self.last_id = line.id
                if goes_on:
                    self.deadline = now + self.timeout
                    return out
                return [self._finish(False)]
            out.append(self._finish(True))            # not the continuation: the message ended here
        if lead is not None:                          # a continuation whose start was lost
            text = ELLIPSIS + ("\x02" + lead if lead else "") + text
        line = dataclasses.replace(line, text=text)
        if goes_on:
            self.line, self.last_id, self.deadline = line, line.id, now + self.timeout
            return out
        out.append(line)
        return out

    def flush_due(self, now, force=False):
        """Nothing came after the last piece for a while (or the reader stops): close the message."""
        if self.line is not None and (force or now >= self.deadline):
            return [self._finish(True)]
        return []
