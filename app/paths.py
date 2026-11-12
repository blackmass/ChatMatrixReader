"""Where things live (one place, so no module computes its own path).

    <ROOT>/                     what the user sees, edits or what changes while the program runs
        run.bat ... run.command, ChatMatrix Reader.app      launchers
        config.json, chatmatrix.log, usage.json              written by the program
        Glossary.txt, Glossary.sample.txt                    the glossary
        fonts/, locale/                                      the user may add files here
        .venv/                                               created on the first start
        app/                                                 <APP>: the program itself (code and fixed resources)
"""
import os

APP = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(APP)
