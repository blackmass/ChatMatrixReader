"""Options window (right-click on the main window)."""
import ctypes
import sys
import subprocess
import json
import re
import logging
import os
import threading
import time
import tkinter as tk
from ctypes import wintypes
from tkinter import colorchooser, ttk, messagebox

import config
import plat
import glossary
import hotkeys
import logsetup
import updatecheck
import usage
import version
import translator
import credits
import i18n
from i18n import tr
from translator import TRANSLATOR_LABELS, LANGS

PAD = {"padx": 6, "pady": 3}


def _open_file(path):
    """Open a file with its default program (Windows: startfile; macOS: open)."""
    if sys.platform == "darwin":
        subprocess.Popen(["open", path])
    else:
        os.startfile(path)


class _Fold(ttk.Frame):
    """A titled section that folds in and out when its title is clicked. Used like a LabelFrame: put the widgets
    into the object itself and pack() it (the frame around it and the title come with pack)."""

    def __init__(self, parent, title):
        self.title = title
        self.opened = True
        self.box = ttk.LabelFrame(parent)
        self.head = ttk.Label(self.box, cursor="hand2")
        self.box.configure(labelwidget=self.head)
        self.head.bind("<Button-1>", lambda e: self.set_open(not self.opened))
        # A frame with no child keeps whatever size it had (Tk stops resizing it), so a folded box would stay full size
        # and, when folded before it was ever shown, would be 1 pixel high with no visible title. This thin child
        # keeps the box resizing itself.
        ttk.Frame(self.box, height=2).pack(side="bottom", fill="x")
        super().__init__(self.box)
        self._show_title()

    def _show_title(self):
        self.head.configure(text=("\u25be " if self.opened else "\u25b8 ") + self.title)

    def pack(self, **kw):
        self.box.pack(**kw)
        ttk.Frame.pack(self, fill="both", expand=True)

    def set_open(self, opened):
        if opened == self.opened:
            return
        self.opened = opened
        if opened:
            ttk.Frame.pack(self, fill="both", expand=True)
        else:
            self.pack_forget()
        self._show_title()


class OptionsWindow:
    def __init__(self, app):
        self.app = app
        cfg = app.cfg
        self.win = win = tk.Toplevel(app.root)
        win.title(tr("옵션"))
        win.resizable(False, False)

        mp = cfg.get("manual_pos")
        self.v = {
            "translator": tk.StringVar(value=tr(TRANSLATOR_LABELS.get(cfg["translator"], TRANSLATOR_LABELS["none"]))),
            "target_lang": tk.StringVar(value=cfg["target_lang"]),
            "api_url": tk.StringVar(value=cfg["api_url"]),
            "api_model": tk.StringVar(value=cfg["api_model"]),
            "api_key": tk.StringVar(value=cfg["api_key"]),
            "google_api_key": tk.StringVar(value=cfg["google_api_key"]),
            "disable_reasoning": tk.BooleanVar(value=bool(cfg["disable_reasoning"])),
            "reasoning_off_body": tk.StringVar(value=cfg["reasoning_off_body"]),
            "temperature": tk.StringVar(value=str(cfg["temperature"])),
            "timeout": tk.StringVar(value=str(cfg["timeout"])),
            "skip_same_lang": tk.BooleanVar(value=bool(cfg["skip_same_lang"])),
            "skip_regex": tk.StringVar(value=cfg.get("skip_regex", "")),
            "skip_regex_hide": tk.BooleanVar(value=bool(cfg.get("skip_regex_hide", False))),
            "glossary_file": tk.StringVar(value=cfg["glossary_file"]),
            "glossary_google": tk.BooleanVar(value=bool(cfg["glossary_google"])),
            "glossary_style": tk.StringVar(value=tr(glossary.GLOSSARY_STYLES.get(cfg["glossary_style"], glossary.GLOSSARY_STYLES["paren"]))),
            "glossary_info": tk.StringVar(value=""),
            "test_text": tk.StringVar(value="LFM M+ 12 need tank and healer, inv pls"),
            "test_result": tk.StringVar(value=""),
            "bg_opacity": tk.DoubleVar(value=float(cfg["bg_opacity"])),
            "text_opacity": tk.DoubleVar(value=float(cfg["text_opacity"])),
            "topmost": tk.BooleanVar(value=bool(cfg["topmost"])),
            "topmost_wow_only": tk.BooleanVar(value=bool(cfg.get("topmost_wow_only"))),
            "click_through": tk.BooleanVar(value=bool(cfg["click_through"])),
            "hover_clear": tk.BooleanVar(value=bool(cfg.get("hover_clear", False))),
            "blur_experiment": tk.BooleanVar(value=bool(cfg.get("blur_experiment", False))),
            "blur_kind": tk.StringVar(value=tr("진하게 (아크릴)") if int(cfg.get("blur_state", 3)) == 4 else tr("가볍게")),
            "font_size": tk.IntVar(value=int(cfg["font_size"])),
            "check_updates": tk.BooleanVar(value=bool(cfg.get("check_updates", True))),
            "translate_test_start": tk.BooleanVar(value=bool(cfg.get("translate_test_start", True))),
            "latest_text": tk.StringVar(value=""),
            "shadow_on": tk.BooleanVar(value=bool(cfg.get("shadow_on"))),
            "shadow_color": tk.StringVar(value=cfg.get("shadow_color") or "#000000"),
            "shadow_dx": tk.IntVar(value=int(cfg.get("shadow_dx", 1))),
            "shadow_dy": tk.IntVar(value=int(cfg.get("shadow_dy", 1))),
            "font_family": tk.StringVar(value=cfg.get("font_family") if cfg.get("font_family") in app.custom_fonts else tr("기본 글꼴 (맑은 고딕)")),
            "line_spacing": tk.IntVar(value=int(cfg.get("line_spacing", 0))),
            "group_spacing": tk.IntVar(value=int(cfg.get("group_spacing", 4))),
            "swap_trans": tk.BooleanVar(value=bool(cfg.get("swap_trans", False))),
            "trans_font_size": tk.IntVar(value=int(cfg.get("trans_font_size", 0) or 0)),
            "trans_color": tk.StringVar(value=cfg.get("trans_color") or ""),
            "show_time": tk.BooleanVar(value=bool(cfg.get("show_time", True))),
            "channel_detail": tk.BooleanVar(value=bool(cfg.get("channel_detail", False))),
            "class_colors": tk.BooleanVar(value=bool(cfg.get("class_colors", True))),
            "max_lines": tk.IntVar(value=int(cfg["max_lines"])),
            "poll_hz": tk.IntVar(value=int(cfg["poll_hz"])),
            "send_enabled": tk.BooleanVar(value=bool(cfg.get("send_enabled", True))),
            "send_lang": tk.StringVar(value=cfg.get("send_lang") or "English"),
            "send_hotkey": tk.StringVar(value=cfg.get("send_hotkey") or hotkeys.DEFAULT),
            "send_autopaste": tk.BooleanVar(value=bool(cfg.get("send_autopaste", False))),
            "send_show_log": tk.BooleanVar(value=bool(cfg.get("send_show_log", False))),
            "pos_x": tk.StringVar(value=str(mp[0]) if mp else ""),
            "pos_y": tk.StringVar(value=str(mp[1]) if mp else ""),
        }
        self.openai_widgets = []
        self.google_widgets = []
        self.test_widgets = []
        self.folds = {}
        self._fold_mode = None

        row = ttk.Frame(win)
        row.pack(side="bottom", anchor="e", padx=8, pady=(2, 8))     # packed first: always visible, whatever the size
        nb = ttk.Notebook(win)
        nb.pack(side="top", fill="both", expand=True, padx=8, pady=(8, 4))
        self._tab_translate(nb)
        self._tab_window(nb)
        self._tab_capture(nb)
        self._tab_send(nb)
        self._tab_log(nb)
        self._tab_other(nb)
        self.nb = nb
        ttk.Button(row, text=tr("저장"), command=self.save).pack(side="left")
        ttk.Button(row, text=tr("닫기"), command=win.destroy).pack(side="left", padx=6)
        ttk.Button(row, text=tr("프로그램 종료"), command=app.on_close).pack(side="left", padx=(18, 0))
        # keyboard: Ctrl+S saves, Esc closes (for screens where the buttons below do not fit)
        def key_save(e):
            self.save()
            return "break"

        def key_close(e):
            win.destroy()
            return "break"

        win.bind("<Control-s>", key_save)
        win.bind("<Control-S>", key_save)
        win.bind("<Escape>", key_close)
        self.refresh_states()
        self._fit_tabs()
        self._place_beside_main()

    # macOS: a tab taller than the screen scrolls instead of making the window huge
    _scroll_tabs = ()

    def _tab_frame(self, nb, text):
        if sys.platform != "darwin":
            tab = ttk.Frame(nb)
            nb.add(tab, text=text)
            return tab
        outer = ttk.Frame(nb)
        nb.add(outer, text=text)
        canvas = tk.Canvas(outer, highlightthickness=0, borderwidth=0)
        bar = ttk.Scrollbar(outer, orient="vertical", command=canvas.yview)
        canvas.configure(yscrollcommand=bar.set)
        bar.pack(side="right", fill="y")
        canvas.pack(side="left", fill="both", expand=True)
        inner = ttk.Frame(canvas)
        canvas.create_window((0, 0), window=inner, anchor="nw")
        inner.bind("<Configure>", lambda e, c=canvas: c.configure(scrollregion=c.bbox("all")))
        canvas.bind("<Enter>", lambda e, c=canvas: c.bind_all("<MouseWheel>", lambda ev: c.yview_scroll(-1 if ev.delta > 0 else 1, "units")))
        canvas.bind("<Leave>", lambda e, c=canvas: c.unbind_all("<MouseWheel>"))
        self._scroll_tabs = self._scroll_tabs + ((canvas, inner),)
        return inner

    def _fit_tabs(self):
        if not self._scroll_tabs:
            return
        self.win.update_idletasks()
        maxh = max(300, self.win.winfo_screenheight() - 260)
        w = max(i.winfo_reqwidth() for _, i in self._scroll_tabs)
        h = min(max(i.winfo_reqheight() for _, i in self._scroll_tabs), maxh)
        for c, i in self._scroll_tabs:
            c.configure(width=w, height=h)

    # ------------------------------------------------------------------
    def alive(self):
        return self.win.winfo_exists()

    def lift(self):
        self.win.deiconify()
        self.win.lift()
        self.win.focus_force()

    def _mode(self):
        rev = {tr(label): key for key, label in TRANSLATOR_LABELS.items()}
        return rev.get(self.v["translator"].get(), "none")

    # ------------------------------------------------------------------ tabs
    def _tab_translate(self, nb):
        v = self.v
        tab = self._tab_frame(nb, tr("번역"))

        top = ttk.Frame(tab)
        top.pack(fill="x", padx=6, pady=(8, 2))
        ttk.Label(top, text=tr("번역 방식")).grid(row=0, column=0, sticky="w", **PAD)
        cb = ttk.Combobox(top, textvariable=v["translator"], values=[tr(x) for x in TRANSLATOR_LABELS.values()],
                          state="readonly", width=34)
        cb.grid(row=0, column=1, **PAD)
        cb.bind("<<ComboboxSelected>>", lambda e: self.refresh_states())
        ttk.Label(top, text=tr("목표 언어")).grid(row=1, column=0, sticky="w", **PAD)
        ttk.Combobox(top, textvariable=v["target_lang"], values=LANGS, width=34).grid(row=1, column=1, **PAD)
        ttk.Checkbutton(top, text=tr("시작할 때 번역 서버 연결 확인 (아주 짧은 글자 1~2개를 보냅니다)"),
                        variable=v["translate_test_start"]).grid(row=2, column=0, columnspan=2, sticky="w", **PAD)

        # --- OpenAI compatible
        g1 = self.folds["openai"] = _Fold(tab, tr("OpenAI 호환 API (LM Studio 등)"))
        g1.pack(fill="x", padx=8, pady=4)
        ttk.Label(g1, text="API URL").grid(row=0, column=0, sticky="w", **PAD)
        e1 = ttk.Entry(g1, textvariable=v["api_url"], width=44)
        e1.grid(row=0, column=1, columnspan=2, sticky="w", **PAD)
        ttk.Label(g1, text=tr("모델")).grid(row=1, column=0, sticky="w", **PAD)
        self.model_cb = ttk.Combobox(g1, textvariable=v["api_model"], width=34)
        self.model_cb.grid(row=1, column=1, sticky="w", **PAD)
        b1 = ttk.Button(g1, text=tr("목록 불러오기"), command=self.fetch_models)
        b1.grid(row=1, column=2, **PAD)
        ttk.Label(g1, text="API Key").grid(row=2, column=0, sticky="w", **PAD)
        e2 = ttk.Entry(g1, textvariable=v["api_key"], width=44, show="*")
        e2.grid(row=2, column=1, columnspan=2, sticky="w", **PAD)
        ttk.Label(g1, text=tr("온도 / 시간제한(초)")).grid(row=3, column=0, sticky="w", **PAD)
        tt = ttk.Frame(g1)
        tt.grid(row=3, column=1, sticky="w", **PAD)
        s1 = ttk.Spinbox(tt, from_=0.0, to=2.0, increment=0.1, textvariable=v["temperature"], width=6)
        s1.pack(side="left")
        s2 = ttk.Spinbox(tt, from_=2, to=300, textvariable=v["timeout"], width=6)
        s2.pack(side="left", padx=(8, 0))
        c1 = ttk.Checkbutton(g1, text=tr("추론(reasoning) 끄기 - 아래 JSON을 요청에 추가"), variable=v["disable_reasoning"])
        c1.grid(row=4, column=0, columnspan=3, sticky="w", **PAD)
        e5 = ttk.Entry(g1, textvariable=v["reasoning_off_body"], width=62)
        e5.grid(row=5, column=0, columnspan=3, sticky="w", **PAD)
        ttk.Label(g1, text=tr("모델마다 끄는 방법이 다릅니다. 서버가 거부(400)하면 자동으로 빼고 다시 요청합니다.\n"
                              "URL은 http://localhost:1234 처럼 써도 /v1 을 자동으로 붙입니다."),
                  foreground="#666", justify="left").grid(row=6, column=0, columnspan=3, sticky="w", **PAD)
        self.openai_widgets += [e1, self.model_cb, b1, e2, s1, s2, c1, e5]

        # --- Google
        g2 = self.folds["google"] = _Fold(tab, tr("Google 번역"))
        g2.pack(fill="x", padx=8, pady=4)
        ttk.Label(g2, text=tr("API Key (선택)")).grid(row=0, column=0, sticky="w", **PAD)
        e3 = ttk.Entry(g2, textvariable=v["google_api_key"], width=44, show="*")
        e3.grid(row=0, column=1, sticky="w", **PAD)
        ttk.Label(g2, text=tr("비우면 키 없이 쓰는 비공식 무료 방식입니다 (제한되거나 바뀔 수 있음).\n"
                              "Cloud Translation API 키를 넣으면 공식 방식을 사용합니다."),
                  foreground="#666", justify="left").grid(row=1, column=0, columnspan=2, sticky="w", **PAD)
        ttk.Label(g2, text=tr("이번 달 사용량: 약 {used} / {limit}자 (추정값이며 정확하지 않습니다)",
                              used=f"{usage.total():,}", limit=f"{usage.FREE_LIMIT:,}"),
                  foreground="#666").grid(row=2, column=0, columnspan=2, sticky="w", **PAD)
        self.google_widgets += [e3]

        # --- glossary
        gg = self.folds["glossary"] = _Fold(tab, tr("단어장 (Google, AI 공통)"))
        gg.pack(fill="x", padx=8, pady=4)
        ttk.Label(gg, text=tr("파일")).grid(row=0, column=0, sticky="w", **PAD)
        ttk.Entry(gg, textvariable=v["glossary_file"], width=34).grid(row=0, column=1, sticky="w", **PAD)
        gb = ttk.Frame(gg)
        gb.grid(row=0, column=2, sticky="w", **PAD)
        ttk.Button(gb, text=tr("열기"), command=self.open_glossary).pack(side="left")
        ttk.Button(gb, text=tr("항목 수 확인"), command=self.check_glossary).pack(side="left", padx=4)
        gc = ttk.Checkbutton(gg, text=tr("Google 번역에도 단어장 적용"), variable=v["glossary_google"])
        gc.grid(row=1, column=0, columnspan=2, sticky="w", **PAD)
        ttk.Label(gg, text=tr("적용 방식")).grid(row=2, column=0, sticky="w", **PAD)
        gs = ttk.Combobox(gg, textvariable=v["glossary_style"], values=[tr(x) for x in glossary.GLOSSARY_STYLES.values()],
                          state="readonly", width=34)
        gs.grid(row=2, column=1, sticky="w", **PAD)
        ttk.Label(gg, textvariable=v["glossary_info"], foreground="#666").grid(row=3, column=0, columnspan=3, sticky="w", **PAD)
        ttk.Label(gg, text=tr("AI(OpenAI 호환)에는 프롬프트의 {{Glossary.txt}} 자리에 파일 내용이 들어갑니다. 파일은 저장하면 바로 반영됩니다."),
                  foreground="#666").grid(row=4, column=0, columnspan=3, sticky="w", **PAD)
        self.google_widgets += [gc, gs]

        # --- prompt
        g3 = self.folds["prompt"] = _Fold(tab, tr("프롬프트 (OpenAI 호환 API 전용. {target_lang}: 목표 언어, {{파일명}}: 그 파일 내용)"))
        g3.pack(fill="both", padx=8, pady=4)
        holder = ttk.Frame(g3)
        holder.pack(fill="both", padx=6, pady=(4, 2))
        self.prompt = tk.Text(holder, width=66, height=8, wrap="word", font=("Malgun Gothic", 9), undo=True)
        sb = ttk.Scrollbar(holder, orient="vertical", command=self.prompt.yview)
        self.prompt.configure(yscrollcommand=sb.set)
        self.prompt.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")
        self.prompt.insert("1.0", self.app.cfg["prompt"])
        br = ttk.Frame(g3)
        br.pack(anchor="w", padx=6, pady=(0, 4))
        b2 = ttk.Button(br, text=tr("기본 프롬프트로 되돌리기"), command=self.reset_prompt)
        b2.pack(side="left")
        ttk.Label(br, text=tr("약어 설명은 Glossary 아래에 한 줄씩 추가하세요."), foreground="#666").pack(side="left", padx=8)
        self.openai_widgets += [self.prompt, b2]

        # --- common
        ttk.Checkbutton(tab, text=tr("목표 언어와 같은 문장은 번역 생략 (한국어 등 글자로 판별 가능한 경우)"),
                        variable=v["skip_same_lang"]).pack(anchor="w", padx=10, pady=2)
        gx = ttk.Frame(tab)
        gx.pack(fill="x", padx=10, pady=(2, 0))
        ttk.Label(gx, text=tr("번역 제외 패턴 (정규식):")).pack(side="left")
        ttk.Entry(gx, textvariable=v["skip_regex"], width=34).pack(side="left", padx=6)
        ttk.Checkbutton(tab, text=tr("일치하는 문장은 원문도 숨김 (창에 표시하지 않음)"),
                        variable=v["skip_regex_hide"]).pack(anchor="w", padx=10, pady=2)
        ttk.Label(tab, text=tr("비워 두면 사용하지 않습니다. 이 패턴이 한 글자라도 일치하는 문장은 번역하지 않고 원문만 표시합니다. "
                               "(목표 언어를 바꾸면 패턴도 직접 바꿔 주세요.)"),
                  foreground="#666", wraplength=470, justify="left").pack(anchor="w", padx=10)
        ex = ttk.Frame(tab)
        ex.pack(fill="x", padx=10, pady=(0, 4))
        ttk.Label(ex, text=tr("예 (한글이 있는 문장 제외):"), foreground="#666").pack(side="left")
        exe = ttk.Entry(ex, width=20)                          # read-only: the text can be selected and copied
        exe.insert(0, "[가-힣ㄱ-ㅎㅏ-ㅣ]")
        exe.configure(state="readonly")
        exe.pack(side="left", padx=6)

        # --- test
        g4 = ttk.LabelFrame(tab, text=tr("테스트 (저장하지 않아도 지금 입력한 설정으로 시험)"))
        g4.pack(fill="x", padx=8, pady=(4, 8))
        e4 = ttk.Entry(g4, textvariable=v["test_text"], width=52)
        e4.grid(row=0, column=0, **PAD)
        b3 = ttk.Button(g4, text=tr("테스트"), command=self.run_test)
        b3.grid(row=0, column=1, **PAD)
        ttk.Label(g4, textvariable=v["test_result"], wraplength=470, justify="left").grid(
            row=1, column=0, columnspan=2, sticky="w", **PAD)
        self.test_widgets += [e4, b3]

    def _tab_window(self, nb):
        v, cfg, app = self.v, self.app.cfg, self.app
        tab = self._tab_frame(nb, tr("창"))

        ttk.Label(tab, text=tr("투명도")).grid(row=0, column=0, sticky="nw", **PAD)
        sl = ttk.Frame(tab)
        sl.grid(row=0, column=1, sticky="w", **PAD)

        def on_opacity(_=None):
            cfg["bg_opacity"] = round(float(v["bg_opacity"].get()), 2)
            cfg["text_opacity"] = round(float(v["text_opacity"].get()), 2)
            app.apply_opacity()

        ttk.Label(sl, text=tr("배경")).grid(row=0, column=0, sticky="w")
        ttk.Scale(sl, from_=0.05, to=1.0, variable=v["bg_opacity"], command=on_opacity,
                  length=200).grid(row=0, column=1, padx=6, pady=2)
        ttk.Label(sl, text=tr("글자")).grid(row=1, column=0, sticky="w")
        ttk.Scale(sl, from_=0.3, to=1.0, variable=v["text_opacity"], command=on_opacity,
                  length=200).grid(row=1, column=1, padx=6, pady=2)
        ttk.Label(sl, text=tr("두 값이 다르면 창 2개로 합성합니다."), foreground="#666").grid(
            row=2, column=0, columnspan=2, sticky="w")

        def on_topmost():
            if v["topmost"].get():
                v["topmost_wow_only"].set(False)                  # the two modes exclude each other
                cfg["topmost_wow_only"] = False
            cfg["topmost"] = bool(v["topmost"].get())
            app.root.attributes("-topmost", cfg["topmost"])
            app.back.attributes("-topmost", cfg["topmost"])      # the background window must follow
            app._stack_back()

        def on_wow_only():
            on = bool(v["topmost_wow_only"].get())
            cfg["topmost_wow_only"] = on
            if on:
                v["topmost"].set(False)
                cfg["topmost"] = False
                app.root.attributes("-topmost", False)           # the follow loop places it above the game
                app.back.attributes("-topmost", False)
                app._game_hwnd = None
                app._placed_for = None
            config.save(cfg)

        ttk.Checkbutton(tab, text=tr("항상 위에 표시"), variable=v["topmost"],
                        command=on_topmost).grid(row=1, column=0, columnspan=2, sticky="w", **PAD)
        ttk.Checkbutton(tab, text=tr("와우 창 위에만 표시 (다른 프로그램 창에는 가려짐)"), variable=v["topmost_wow_only"],
                        command=on_wow_only).grid(row=6, column=0, columnspan=2, sticky="w", **PAD)

        def on_click_through():
            if v["click_through"].get():
                if not app.hotkey.ok:
                    v["click_through"].set(False)
                    messagebox.showwarning(tr("클릭 통과"), tr("Ctrl+Alt+O 단축키를 등록하지 못해서 켤 수 없습니다.\n"
                                                         "(다시 옵션을 열 방법이 없어지기 때문입니다)"), parent=self.win)
                    return
                if not messagebox.askyesno(
                        tr("클릭 통과"),
                        tr("켜면 평소에는 이 창이 마우스 입력을 받지 않습니다.\n"
                           "Shift를 누른 채로 창 위에 마우스를 올리면 클릭, 드래그 선택(선택하면 자동 복사), 스크롤, 창 이동이 됩니다.\n"
                           "옵션은 Ctrl+Alt+O 로도 열 수 있습니다.\n\n계속할까요?").replace("Ctrl+Alt+O", plat.OPTIONS_KEY), parent=self.win):
                    v["click_through"].set(False)
                    return
            cfg["click_through"] = bool(v["click_through"].get())
            app.set_click_through(cfg["click_through"])
            config.save(cfg)

        ttk.Checkbutton(tab, text=tr("클릭 통과 (마우스 입력이 창 뒤로 전달됨. Shift를 누르고 있는 동안만 조작 가능)"), variable=v["click_through"],
                        command=on_click_through).grid(row=2, column=0, columnspan=2, sticky="w", **PAD)
        ttk.Label(tab, text=tr("글자 크기")).grid(row=3, column=0, sticky="w", **PAD)
        ttk.Spinbox(tab, from_=8, to=32, textvariable=v["font_size"], width=6).grid(row=3, column=1, sticky="w", **PAD)
        ttk.Label(tab, text=tr("최대 보관 줄 수")).grid(row=4, column=0, sticky="w", **PAD)
        ttk.Spinbox(tab, from_=50, to=5000, increment=50, textvariable=v["max_lines"],
                    width=6).grid(row=4, column=1, sticky="w", **PAD)
        ttk.Button(tab, text=tr("화면 지우기"), command=app.clear_text).grid(row=5, column=0, sticky="w", **PAD)
        sp = ttk.Frame(tab)                               # both gaps in one row
        sp.grid(row=7, column=0, columnspan=2, sticky="w", **PAD)
        ttk.Label(sp, text=tr("줄 간격 (원문-번역, 픽셀)")).pack(side="left")
        ttk.Spinbox(sp, from_=0, to=40, textvariable=v["line_spacing"], width=5).pack(side="left", padx=(4, 16))
        ttk.Label(sp, text=tr("묶음 간격 (묶음 사이, 픽셀)")).pack(side="left")
        ttk.Spinbox(sp, from_=0, to=60, textvariable=v["group_spacing"], width=5).pack(side="left", padx=4)
        ttk.Checkbutton(tab, text=tr("번역을 위에, 원문을 아래에 표시 (원문 번역 교체)"), variable=v["swap_trans"]).grid(
            row=16, column=0, columnspan=2, sticky="w", **PAD)
        ttk.Label(tab, text=tr("아래 줄 글자 크기 (0: 위 줄과 같게)")).grid(row=14, column=0, sticky="w", **PAD)
        ttk.Spinbox(tab, from_=0, to=32, textvariable=v["trans_font_size"], width=6).grid(row=14, column=1, sticky="w", **PAD)
        ttk.Label(tab, text=tr("아래 줄 글자 색 (비우면 기본)")).grid(row=15, column=0, sticky="w", **PAD)
        tc = ttk.Frame(tab)
        tc.grid(row=15, column=1, sticky="w", **PAD)
        ttk.Entry(tc, textvariable=v["trans_color"], width=9).pack(side="left")
        ttk.Button(tc, text=tr("색 선택"), command=self.pick_trans_color).pack(side="left", padx=4)
        ttk.Checkbutton(tab, text=tr("채팅 시간 표시"), variable=v["show_time"]).grid(
            row=8, column=0, columnspan=2, sticky="w", **PAD)
        ttk.Checkbutton(tab, text=tr("직업 색상으로 이름 표시"), variable=v["class_colors"]).grid(
            row=11, column=0, columnspan=2, sticky="w", **PAD)
        ttk.Checkbutton(tab, text=tr("채널 코드를 자세히 표시 (문제 확인용)"), variable=v["channel_detail"]).grid(
            row=13, column=0, columnspan=2, sticky="w", **PAD)
        ttk.Label(tab, text=tr("글꼴")).grid(row=9, column=0, sticky="w", **PAD)
        fam = ttk.Frame(tab)
        fam.grid(row=9, column=1, sticky="w", **PAD)
        ttk.Combobox(fam, textvariable=v["font_family"], values=[tr("기본 글꼴 (맑은 고딕)")] + app.custom_fonts,
                     width=26, state="readonly").pack(side="left")
        if not app.custom_fonts:
            ttk.Label(fam, text=tr("fonts 폴더에 ttf/otf 파일을 넣으면 선택할 수 있습니다"), foreground="#666").pack(
                side="left", padx=6)
        sh = ttk.LabelFrame(tab, text=tr("글자 그림자"))
        sh.grid(row=10, column=0, columnspan=2, sticky="we", padx=6, pady=(8, 3))
        ttk.Checkbutton(sh, text=tr("글자 그림자 사용 (배경이 투명할 때 글자가 잘 보이게)"), variable=v["shadow_on"]).grid(
            row=0, column=0, columnspan=6, sticky="w", **PAD)
        ttk.Label(sh, text=tr("색")).grid(row=1, column=0, sticky="w", **PAD)
        ttk.Entry(sh, textvariable=v["shadow_color"], width=9).grid(row=1, column=1, sticky="w", **PAD)
        ttk.Button(sh, text=tr("색 선택"), command=self.pick_shadow_color).grid(row=1, column=2, sticky="w", **PAD)
        ttk.Label(sh, text="X").grid(row=1, column=3, sticky="e", padx=(14, 2))
        ttk.Spinbox(sh, from_=-5, to=5, textvariable=v["shadow_dx"], width=4).grid(row=1, column=4, **PAD)
        ttk.Label(sh, text="Y").grid(row=1, column=5, sticky="e", padx=(8, 2))
        ttk.Spinbox(sh, from_=-5, to=5, textvariable=v["shadow_dy"], width=4).grid(row=1, column=6, **PAD)
        ttk.Label(sh, text=tr("켜면 창이 하나 더 쓰입니다. 문제가 있으면 끄세요."), foreground="#666").grid(
            row=2, column=0, columnspan=7, sticky="w", padx=6)

        ov = ttk.LabelFrame(tab, text=tr("게임 채팅창 위에 겹쳐 쓰기"))
        ov.grid(row=12, column=0, columnspan=2, sticky="we", padx=6, pady=(8, 3))

        def on_overlay():
            cfg["hover_clear"] = bool(v["hover_clear"].get())
            cfg["blur_experiment"] = bool(v["blur_experiment"].get())
            app.apply_opacity()

        ttk.Checkbutton(ov, text=tr("마우스를 올리면 창을 완전히 투명하게 (클릭 통과를 켠 경우만. Shift를 누르면 다시 보임)"),
                        variable=v["hover_clear"], command=on_overlay).grid(row=0, column=0, sticky="w", **PAD)
        if sys.platform == "win32":                       # the blur is not implemented on macOS
            bl = ttk.Frame(ov)
            bl.grid(row=1, column=0, sticky="w")
            ttk.Checkbutton(bl, text=tr("배경 블러 (Windows)"), variable=v["blur_experiment"],
                            command=on_overlay).pack(side="left", padx=6, pady=3)

            def on_blur_kind(_e=None):
                cfg["blur_state"] = 4 if v["blur_kind"].get() == tr("진하게 (아크릴)") else 3
                if cfg.get("blur_experiment"):
                    app.apply_opacity()

            kind = ttk.Combobox(bl, textvariable=v["blur_kind"], values=[tr("가볍게"), tr("진하게 (아크릴)")], width=16,
                                state="readonly")
            kind.pack(side="left", padx=6)
            kind.bind("<<ComboboxSelected>>", on_blur_kind)
            ttk.Label(ov, text=tr("흐림 정도는 시스템이 정해서 바꿀 수 없습니다. '진하게'는 위의 '배경' 투명도로 색 농도를 정하고, "
                                  "'가볍게'는 배경 투명도의 영향을 받지 않습니다. 창을 움직이는 동안은 블러가 잠시 꺼집니다."),
                      foreground="#666", wraplength=440, justify="left").grid(row=2, column=0, sticky="w", padx=6)

    def _tab_capture(self, nb):
        v = self.v
        tab = self._tab_frame(nb, tr("캡처"))
        ttk.Label(tab, text=tr("초당 읽기 횟수")).grid(row=0, column=0, sticky="w", **PAD)
        ttk.Spinbox(tab, from_=5, to=60, textvariable=v["poll_hz"], width=6).grid(row=0, column=1, sticky="w", **PAD)
        ttk.Label(tab, text=tr("수동 좌표 X, Y (비우면 자동 탐색)")).grid(row=1, column=0, sticky="w", **PAD)
        pos = ttk.Frame(tab)
        pos.grid(row=1, column=1, sticky="w", **PAD)
        ttk.Entry(pos, textvariable=v["pos_x"], width=7).pack(side="left")
        ttk.Entry(pos, textvariable=v["pos_y"], width=7).pack(side="left", padx=(4, 0))
        ttk.Button(tab, text=tr("매트릭스 다시 찾기"), command=self.app.worker.research).grid(
            row=2, column=0, sticky="w", **PAD)

    def pick_trans_color(self):
        cur = self.v["trans_color"].get().strip()
        rgb, hexv = colorchooser.askcolor(color=cur if re.fullmatch(r"#[0-9a-fA-F]{6}", cur) else "#7fd6b0",
                                          parent=self.win)
        if hexv:
            self.v["trans_color"].set(hexv)

    def pick_shadow_color(self):
        cur = self.v["shadow_color"].get()
        rgb, hexv = colorchooser.askcolor(color=cur if re.fullmatch(r"#[0-9a-fA-F]{6}", cur) else "#000000",
                                          parent=self.win)
        if hexv:
            self.v["shadow_color"].set(hexv)

    def _tab_send(self, nb):
        tab = self._tab_frame(nb, tr("보내기"))
        v = self.v
        ttk.Checkbutton(tab, text=tr("보내기 번역 사용 (단축키 → 입력줄 → 번역을 클립보드로)"),
                        variable=v["send_enabled"]).grid(row=0, column=0, columnspan=3, sticky="w", **PAD)
        ttk.Label(tab, text=tr("보내는 언어")).grid(row=1, column=0, sticky="w", **PAD)
        ttk.Combobox(tab, textvariable=v["send_lang"], values=LANGS, width=24).grid(row=1, column=1, sticky="w", **PAD)

        ttk.Label(tab, text=tr("단축키")).grid(row=2, column=0, sticky="w", **PAD)
        hk = ttk.Frame(tab)
        hk.grid(row=2, column=1, columnspan=2, sticky="w", **PAD)
        ttk.Entry(hk, textvariable=v["send_hotkey"], width=18, state="readonly").pack(side="left")
        ttk.Button(hk, text=tr("지정"), command=self.capture_hotkey).pack(side="left", padx=(6, 0))
        ttk.Button(hk, text=tr("기본값"), command=lambda: v["send_hotkey"].set(hotkeys.DEFAULT)).pack(side="left", padx=(4, 0))

        ttk.Checkbutton(tab, text=tr("번역 후 자동으로 붙여넣기 (Ctrl+V를 대신 눌러 줍니다)"),
                        variable=v["send_autopaste"]).grid(row=3, column=0, columnspan=3, sticky="w", **PAD)
        ttk.Label(tab, text=tr("꺼 두면 번역 후 와우로 돌아가 Ctrl+V, Enter를 직접 누릅니다. 이 프로그램은 게임에 어떤 입력도 보내지 않습니다."),
                  foreground="#666", wraplength=430, justify="left").grid(row=4, column=0, columnspan=3, sticky="w", padx=22, pady=(0, 6))

        ttk.Checkbutton(tab, text=tr("보낸 번역을 번역창에 표시 (↗ 줄)"),
                        variable=v["send_show_log"]).grid(row=5, column=0, columnspan=3, sticky="w", **PAD)
        ttk.Label(tab, text=tr("보내기 번역 프롬프트")).grid(row=6, column=0, columnspan=2, sticky="w", **PAD)
        self.send_prompt_text = tk.Text(tab, width=62, height=9, wrap="word", font=("Malgun Gothic", 9))
        self.send_prompt_text.grid(row=7, column=0, columnspan=3, sticky="we", padx=6)
        self.send_prompt_text.insert("1.0", self.app.cfg.get("send_prompt") or translator.DEFAULT_SEND_PROMPT)
        ttk.Button(tab, text=tr("기본 프롬프트로"), command=self._reset_send_prompt).grid(row=8, column=0, sticky="w", **PAD)

    def _reset_send_prompt(self):
        self.send_prompt_text.delete("1.0", "end")
        self.send_prompt_text.insert("1.0", translator.DEFAULT_SEND_PROMPT)

    def capture_hotkey(self):
        dlg = tk.Toplevel(self.win)
        dlg.title(tr("단축키 지정"))
        dlg.transient(self.win)
        dlg.resizable(False, False)
        msg = tk.StringVar(value=tr("지정할 키 조합을 누르세요 (Esc: 취소)"))
        ttk.Label(dlg, textvariable=msg, padding=16).pack()
        mods = set()

        def down(e):
            if e.keysym == "Escape":
                dlg.destroy()
                return
            m = hotkeys.mod_of_keysym(e.keysym)
            if m:
                mods.add(m)
                msg.set("+".join(sorted(mods, key=("Ctrl", "Alt", "Shift").index)) + "+")
                return
            key = hotkeys.key_of_keysym(e.keysym)
            if not key:
                msg.set(tr("이 키는 쓸 수 없습니다"))
                return
            combo = "+".join(sorted(mods, key=("Ctrl", "Alt", "Shift").index) + [key])
            try:
                combo = hotkeys.normalize(combo)
            except ValueError:
                msg.set(tr("이 키는 쓸 수 없습니다"))
                return
            self.v["send_hotkey"].set(combo)
            dlg.destroy()

        def up(e):
            m = hotkeys.mod_of_keysym(e.keysym)
            if m:
                mods.discard(m)

        dlg.bind("<KeyPress>", down)
        dlg.bind("<KeyRelease>", up)
        dlg.grab_set()
        dlg.focus_force()

    def _tab_log(self, nb):
        tab = self._tab_frame(nb, tr("로그"))
        holder = ttk.Frame(tab)
        holder.pack(fill="both", expand=True, padx=6, pady=(8, 2))
        self.log_text = tk.Text(holder, width=86, height=26, wrap="none", font=("Consolas", 9), state="disabled")
        sb = ttk.Scrollbar(holder, orient="vertical", command=self.log_text.yview)
        self.log_text.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        self.log_text.pack(side="left", fill="both", expand=True)
        self.log_text.tag_configure("warn", foreground="#b00020")
        bar = ttk.Frame(tab)
        bar.pack(anchor="w", padx=6, pady=(0, 2))
        ttk.Button(bar, text=tr("새로고침"), command=self.refresh_log).pack(side="left")
        ttk.Button(bar, text=tr("모두 복사"), command=self.copy_log).pack(side="left", padx=6)
        ttk.Button(bar, text=tr("로그 파일 열기"), command=self.open_log_file).pack(side="left")
        ttk.Label(tab, text=tr("파일: {path}", path=logsetup.PATH), foreground="#666").pack(anchor="w", padx=8, pady=(0, 6))
        self._log_sig = None
        self.refresh_log()
        self.win.after(1000, self._log_tick)

    def _tab_other(self, nb):
        tab = self._tab_frame(nb, tr("기타"))
        self.other_tab = tab

        gl = ttk.LabelFrame(tab, text=tr("언어"))
        gl.pack(fill="x", padx=8, pady=(10, 4))
        auto_label = tr("자동 (시스템 언어)")
        langs = i18n.available()
        self._lang_items = [(i18n.AUTO, auto_label)] + langs          # (config value, label)
        cur = self.app.cfg.get("language", i18n.AUTO)
        label = next((lb for code, lb in self._lang_items if code.lower() == (cur or "").lower()), auto_label)
        self.v["language"] = tk.StringVar(value=label)
        cb = ttk.Combobox(gl, textvariable=self.v["language"], values=[lb for _, lb in self._lang_items],
                          state="readonly", width=34)
        cb.grid(row=0, column=0, sticky="w", **PAD)
        cb.bind("<<ComboboxSelected>>", self.on_language)
        ttk.Button(gl, text=tr("새로고침"), command=self.reload_languages).grid(row=0, column=1, **PAD)
        ttk.Label(gl, text=tr("현재: {code}   (언어 파일: {folder})", code=i18n.current(), folder=i18n.LOCALE_DIR),
                  foreground="#666", wraplength=520, justify="left").grid(row=1, column=0, columnspan=2, sticky="w", **PAD)
        ttk.Label(gl, text=tr("언어를 바꾸면 옵션창이 다시 열립니다 (저장하지 않은 변경은 사라집니다). "
                              "locale 폴더에 번역 파일(.txt)을 넣으면 목록에 나타납니다."),
                  foreground="#666", wraplength=520, justify="left").grid(row=2, column=0, columnspan=2, sticky="w", **PAD)

        gv = ttk.LabelFrame(tab, text=tr("버전"))
        gv.pack(fill="x", padx=8, pady=4)
        ttk.Label(gv, text=tr("현재 버전")).grid(row=0, column=0, sticky="w", **PAD)
        ttk.Label(gv, text="v" + version.__version__).grid(row=0, column=1, sticky="w", **PAD)
        ttk.Label(gv, text=tr("최신 버전")).grid(row=1, column=0, sticky="w", **PAD)
        self.latest_link = tk.Label(gv, textvariable=self.v["latest_text"], fg="#1a5fd0", cursor="hand2",
                                    font=("Malgun Gothic", 9, "underline"))
        self.latest_link.grid(row=1, column=1, sticky="w", **PAD)
        self.latest_link.bind("<Button-1>", lambda e: self.app.open_releases())
        self.btn_check = ttk.Button(gv, text=tr("업데이트 확인"), command=self.check_update_now)
        self.btn_check.grid(row=1, column=2, padx=10, pady=3)
        ttk.Checkbutton(gv, text=tr("시작할 때 새 버전 확인 (알려 주기만 하고 아무것도 설치하지 않습니다)"),
                        variable=self.v["check_updates"]).grid(row=2, column=0, columnspan=3, sticky="w", **PAD)
        self._show_latest(self.app.latest)

        gc = ttk.LabelFrame(tab, text=tr("정보"))
        gc.pack(fill="both", expand=True, padx=8, pady=4)
        self.credit_box = gc
        self.fill_credits()
        ttk.Label(tab, text=tr("{file} 파일을 고치면 이 목록이 바뀝니다.", file=credits.FILE_NAME),
                  foreground="#666").pack(anchor="w", padx=10, pady=(0, 6))

    def _show_latest(self, tag, err=None):
        cur = version.__version__
        if err:
            text, color = tr("확인하지 못했습니다 ({err})", err=err[:60]), "#b00020"
        elif not tag:
            text, color = tr("아직 확인하지 않았습니다"), "#666666"
        elif updatecheck.is_newer(tag, cur):
            text, color = tr("{tag} - 새 버전이 있습니다 ↗ (눌러서 릴리스 페이지 열기)", tag=tag), "#1a5fd0"
        else:
            text, color = tr("{tag} - 최신입니다 ↗", tag=tag), "#1a5fd0"
        self.v["latest_text"].set(text)
        self.latest_link.configure(fg=color, cursor="hand2" if (tag and not err) else "arrow")
        self.latest_link.unbind("<Button-1>")
        if tag and not err:
            self.latest_link.bind("<Button-1>", lambda e: self.app.open_releases())

    def check_update_now(self):
        self.btn_check.configure(state="disabled")
        self.v["latest_text"].set(tr("확인 중..."))

        def done(tag, err):
            if tag:
                self.app.latest = tag
            if self.alive():
                self.btn_check.configure(state="normal")
                self._show_latest(tag, err)

        self.app.check_update(done)

    def fill_credits(self):
        for w in self.credit_box.winfo_children():
            w.destroy()
        items, err = credits.load()
        if err:
            ttk.Label(self.credit_box, text=err, foreground="#b00020", wraplength=520,
                      justify="left").grid(row=0, column=0, sticky="w", **PAD)
            return
        if not items:
            ttk.Label(self.credit_box, text=tr("(비어 있음)"), foreground="#666").grid(
                row=0, column=0, sticky="w", **PAD)
        for r, (key, val) in enumerate(items):
            ttk.Label(self.credit_box, text=key).grid(row=r, column=0, sticky="nw", **PAD)
            var = tk.StringVar(value=val)
            e = ttk.Entry(self.credit_box, textvariable=var, width=52, state="readonly")   # selectable / copyable
            e._var = var          # keep a reference: a StringVar that is garbage collected shows an empty box
            e.grid(row=r, column=1, sticky="w", **PAD)
            if credits.is_url(val):
                ttk.Button(self.credit_box, text=tr("열기"), width=6,
                           command=lambda u=val: credits.open_url(u)).grid(row=r, column=2, **PAD)

    def reload_languages(self):
        self.on_language()

    def on_language(self, _event=None):
        label = self.v["language"].get()
        code = next((c for c, lb in self._lang_items if lb == label), i18n.AUTO)
        self.app.cfg["language"] = code
        used = i18n.init(code)
        config.save(self.app.cfg)
        logging.getLogger("cmr.options").info("언어 선택: %r -> %s", code or "auto", used)
        tab_index = self.nb.index(self.other_tab)
        # rebuild after this event handler has finished (the combobox that fired it is destroyed)
        self.app.root.after(30, lambda: self.app.reopen_options(select_tab=tab_index))

    def _log_tick(self):
        if not self.alive():
            return
        self.refresh_log()
        self.win.after(1000, self._log_tick)

    def refresh_log(self):
        lines = logsetup.ring.snapshot()
        sig = (len(lines), lines[-1] if lines else "")
        if sig == self._log_sig:
            return
        self._log_sig = sig
        at_bottom = self.log_text.yview()[1] >= 0.999
        self.log_text.configure(state="normal")
        self.log_text.delete("1.0", "end")
        for line in lines:
            bad = " WARNING " in line or " ERROR " in line
            self.log_text.insert("end", line + "\n", "warn" if bad else "")
        self.log_text.configure(state="disabled")
        if at_bottom:
            self.log_text.see("end")

    def copy_log(self):
        self.win.clipboard_clear()
        self.win.clipboard_append("\n".join(logsetup.ring.snapshot()))

    def open_log_file(self):
        try:
            _open_file(logsetup.PATH)
        except OSError as e:
            messagebox.showinfo(tr("로그"), tr("로그 파일을 열 수 없습니다: {e}", e=e), parent=self.win)

    # ------------------------------------------------------------------ states
    @staticmethod
    def _set_enabled(widgets, on):
        for w in widgets:
            if isinstance(w, tk.Text):
                w.configure(state="normal" if on else "disabled", bg="white" if on else "#ececec")
            else:
                w.state(["!disabled"] if on else ["disabled"])

    def refresh_states(self):
        mode = self._mode()
        self._set_enabled(self.openai_widgets, mode == "openai")
        self._set_enabled(self.google_widgets, mode == "google")
        self._set_enabled(self.test_widgets, mode != "none")
        if mode != self._fold_mode:                    # a new translation method: fold away what it does not use
            self._fold_mode = mode
            show = {"openai": ("openai", "prompt", "glossary"), "google": ("google", "glossary")}.get(mode, ())
            for key, fold in self.folds.items():
                fold.set_open(key in show)

    def open_glossary(self):
        name = self.v["glossary_file"].get().strip() or glossary.DEFAULT_NAME
        glossary.ensure_default(name)
        path = glossary.resolve(name)
        try:
            if not os.path.exists(path):
                with open(path, "w", encoding="utf-8") as f:
                    f.write("# 단어 = 뜻   (# 로 시작하는 줄은 주석)\n")   # file content, stays as is
            _open_file(path)
        except OSError as e:
            messagebox.showerror(tr("단어장"), tr("파일을 열 수 없습니다: {e}", e=e), parent=self.win)

    def check_glossary(self):
        name = self.v["glossary_file"].get().strip() or glossary.DEFAULT_NAME
        path = glossary.resolve(name)
        if not os.path.exists(path):
            self.v["glossary_info"].set(tr("파일이 없습니다: {path}", path=path))
            return
        n = len(glossary.entries(name))
        self.v["glossary_info"].set(tr("{n}개 항목을 읽었습니다  ({path})", n=n, path=path))

    def _place_beside_main(self):
        """The chat window may be 'always on top' and would cover an ordinary window: open the options next to it."""
        try:
            w, r = self.win, self.app.root
            w.update_idletasks()
            ow, oh = w.winfo_reqwidth(), w.winfo_reqheight()
            l, t, rt, b = 0, 0, w.winfo_screenwidth(), w.winfo_screenheight()
            try:                                                   # work area of the monitor the chat window is on
                class MI(ctypes.Structure):
                    _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT),
                                ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD)]
                u = ctypes.WinDLL("user32")
                u.GetParent.argtypes = [wintypes.HWND]
                u.GetParent.restype = wintypes.HWND
                u.MonitorFromWindow.argtypes = [wintypes.HWND, wintypes.DWORD]
                u.MonitorFromWindow.restype = wintypes.HANDLE
                u.GetMonitorInfoW.argtypes = [wintypes.HANDLE, ctypes.POINTER(MI)]
                wid = r.winfo_id()
                mi = MI()
                mi.cbSize = ctypes.sizeof(MI)
                if u.GetMonitorInfoW(u.MonitorFromWindow(u.GetParent(wid) or wid, 2), ctypes.byref(mi)):
                    l, t, rt, b = mi.rcWork.left, mi.rcWork.top, mi.rcWork.right, mi.rcWork.bottom
            except Exception:
                pass
            margin = 48                                            # title bar + taskbar slack
            if oh > b - t - margin:                                # taller than the screen: shrink the log view
                try:
                    lines = int(self.log_text.cget("height"))
                    line_h = max(1, self.log_text.winfo_reqheight() // max(1, lines))
                    cut = -(-(oh - (b - t - margin)) // line_h)
                    self.log_text.configure(height=max(8, lines - cut))
                    w.update_idletasks()
                    ow, oh = w.winfo_reqwidth(), w.winfo_reqheight()
                except (tk.TclError, AttributeError):
                    pass
            rx, ry, rw, rh = r.winfo_x(), r.winfo_y(), r.winfo_width(), r.winfo_height()
            gap = 8
            y = max(t, min(ry, b - oh - margin // 2))
            for x in (rx + rw + gap, rx - ow - gap):               # right of the chat window, else left of it
                if x >= l and x + ow <= rt:
                    self._put(x, y, (l, t, rt, b))
                    return
            # no room beside the chat window: centre on the monitor's work area (always fully visible)
            self._put(max(l, l + (rt - l - ow) // 2), t + (b - t - oh - margin) // 2, (l, t, rt, b))
        except tk.TclError:
            pass

    def _put(self, x, y, area):
        """Move the window to (x, y), then use its real outer size (title bar, borders) to keep all of it inside `area`."""
        w = self.win
        l, t, rt, b = area
        w.geometry(f"{x:+d}{y:+d}")                       # "+-1920+0" style also works, but this is the clean form
        w.update_idletasks()
        top = w.winfo_rooty() - w.winfo_y()               # title bar height (+ border)
        bottom = w.winfo_rooty() + w.winfo_height() + 10  # + bottom border / shadow
        dy = 0
        if bottom > b:
            dy = b - bottom
        if w.winfo_y() + dy < t:
            dy = t - w.winfo_y()
        if dy:
            w.geometry(f"{w.winfo_x():+d}{w.winfo_y() + dy:+d}")

    def reset_prompt(self):
        self.prompt.delete("1.0", "end")
        self.prompt.insert("1.0", translator.DEFAULT_PROMPT)

    # ------------------------------------------------------------------ form -> config
    def collect_translation(self):
        v = self.v
        try:
            temp = float(v["temperature"].get())
            timeout = float(v["timeout"].get())
        except (ValueError, tk.TclError):
            raise ValueError(tr("온도와 시간제한은 숫자여야 합니다.")) from None
        try:
            extra = json.loads(v["reasoning_off_body"].get().strip() or translator.DEFAULT_REASONING_OFF)
            if not isinstance(extra, dict):
                raise ValueError
        except ValueError:
            raise ValueError(tr("'추론 끄기용 JSON'이 올바른 { } 형식의 JSON이 아닙니다.")) from None
        skip_regex = v["skip_regex"].get().strip()
        try:
            translator.compile_skip_regex(skip_regex)
        except re.error as e:
            raise ValueError(tr("'번역 제외 패턴'이 올바른 정규식이 아닙니다: {err}", err=e)) from None
        return {
            "disable_reasoning": bool(v["disable_reasoning"].get()),
            "reasoning_off_body": v["reasoning_off_body"].get().strip() or translator.DEFAULT_REASONING_OFF,
            "translator": self._mode(),
            "target_lang": v["target_lang"].get().strip() or "한국어",
            "api_url": v["api_url"].get().strip(),
            "api_model": v["api_model"].get().strip(),
            "api_key": v["api_key"].get(),
            "google_api_key": v["google_api_key"].get().strip(),
            "translate_test_start": bool(v["translate_test_start"].get()),
            "temperature": max(0.0, min(2.0, temp)),
            "timeout": max(2.0, min(300.0, timeout)),
            "skip_same_lang": bool(v["skip_same_lang"].get()),
            "skip_regex": skip_regex,
            "skip_regex_hide": bool(v["skip_regex_hide"].get()),
            "glossary_file": v["glossary_file"].get().strip() or glossary.DEFAULT_NAME,
            "glossary_google": bool(v["glossary_google"].get()),
            "glossary_style": {tr(label): key for key, label in glossary.GLOSSARY_STYLES.items()}.get(
                v["glossary_style"].get(), "paren"),
            "prompt": self.prompt.get("1.0", "end-1c").strip() or translator.DEFAULT_PROMPT,
        }

    def _run_in_thread(self, fn, done):
        """Run fn() off the UI thread; done(result, error) is called back on the UI thread."""
        def work():
            try:
                res, err = fn(), None
            except Exception as e:
                res, err = None, str(e) or e.__class__.__name__
            self.app.q.put(("call", lambda: self.alive() and done(res, err)))
        threading.Thread(target=work, daemon=True).start()

    # ------------------------------------------------------------------ buttons
    def fetch_models(self):
        try:
            tmp = dict(self.app.cfg, **self.collect_translation())
        except ValueError as e:
            messagebox.showerror(tr("옵션"), str(e), parent=self.win)
            return
        self.v["test_result"].set(tr("모델 목록을 불러오는 중..."))

        def done(models, err):
            if err:
                self.v["test_result"].set(tr("모델 목록 실패: {err}", err=err))
                return
            self.model_cb.configure(values=models)
            self.v["test_result"].set(tr("모델 {n}개를 불러왔습니다. 드롭다운에서 고르세요.", n=len(models)))
            if models and not self.v["api_model"].get().strip():
                self.v["api_model"].set(models[0])

        self._run_in_thread(lambda: translator.list_models(tmp), done)

    def run_test(self):
        sample = self.v["test_text"].get().strip()
        if not sample:
            return
        try:
            tmp = dict(self.app.cfg, **self.collect_translation())
        except ValueError as e:
            messagebox.showerror(tr("옵션"), str(e), parent=self.win)
            return
        if tmp["translator"] == "none":
            self.v["test_result"].set(tr("번역 방식을 먼저 선택하세요."))
            return
        self.v["test_result"].set(tr("번역 중..."))
        t0 = time.perf_counter()

        def done(res, err):
            took = time.perf_counter() - t0
            self.v["test_result"].set(tr("실패: {err}", err=err) if err else tr("{res}\n({sec:.2f}초)", res=res, sec=took))

        self._run_in_thread(lambda: translator.translate(tmp, sample), done)

    def save(self):
        app, cfg, v = self.app, self.app.cfg, self.v
        try:
            new = self.collect_translation()
            font_size = max(8, min(32, int(v["font_size"].get())))
            poll_hz = max(5, min(60, int(v["poll_hz"].get())))
            max_lines = max(50, min(5000, int(v["max_lines"].get())))
            line_spacing = max(0, min(40, int(v["line_spacing"].get())))
            group_spacing = max(0, min(60, int(v["group_spacing"].get())))
            trans_size = int(v["trans_font_size"].get())
            trans_size = 0 if trans_size < 8 else min(32, trans_size)
        except (ValueError, tk.TclError) as e:
            messagebox.showerror(tr("옵션"), str(e) if isinstance(e, ValueError) else tr("숫자 값이 올바르지 않습니다."),
                                 parent=self.win)
            return
        try:
            hotkey = hotkeys.normalize(v["send_hotkey"].get())
        except ValueError:
            messagebox.showerror(tr("옵션"), tr("보내기 단축키가 올바르지 않습니다."), parent=self.win)
            return
        trans_color = v["trans_color"].get().strip()
        if trans_color and not re.fullmatch(r"#[0-9a-fA-F]{6}", trans_color):
            messagebox.showerror(tr("옵션"), tr("번역 글자 색은 #RRGGBB 형식이어야 합니다 (예: #7fd6b0)"), parent=self.win)
            return
        shadow_color = v["shadow_color"].get().strip()
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", shadow_color):
            messagebox.showerror(tr("옵션"), tr("그림자 색은 #RRGGBB 형식이어야 합니다 (예: #000000)"), parent=self.win)
            return
        try:
            sdx = max(-5, min(5, int(v["shadow_dx"].get())))
            sdy = max(-5, min(5, int(v["shadow_dy"].get())))
        except (ValueError, tk.TclError):
            messagebox.showerror(tr("옵션"), tr("숫자 값이 올바르지 않습니다."), parent=self.win)
            return
        sprompt = self.send_prompt_text.get("1.0", "end").strip()
        px, py = v["pos_x"].get().strip(), v["pos_y"].get().strip()
        manual = None
        if px and py:
            try:
                manual = [int(px), int(py)]
            except ValueError:
                messagebox.showerror(tr("옵션"), tr("좌표는 정수여야 합니다."), parent=self.win)
                return
        cfg.update(new)
        cfg.update(hover_clear=bool(v["hover_clear"].get()), blur_experiment=bool(v["blur_experiment"].get()),
                   blur_state=4 if v["blur_kind"].get() == tr("진하게 (아크릴)") else 3)
        cfg.update(send_enabled=bool(v["send_enabled"].get()),
                   send_lang=v["send_lang"].get().strip() or "English", send_hotkey=hotkey,
                   send_autopaste=bool(v["send_autopaste"].get()), send_show_log=bool(v["send_show_log"].get()),
                   send_prompt="" if sprompt == translator.DEFAULT_SEND_PROMPT.strip() else sprompt)
        cfg.update(check_updates=bool(v["check_updates"].get()))
        cfg.update(shadow_on=bool(v["shadow_on"].get()), shadow_color=shadow_color, shadow_dx=sdx, shadow_dy=sdy)
        cfg.update(swap_trans=bool(v["swap_trans"].get()), font_family=(v["font_family"].get() if v["font_family"].get() in app.custom_fonts else ""), font_size=font_size, poll_hz=poll_hz, max_lines=max_lines, manual_pos=manual,
                   line_spacing=line_spacing, group_spacing=group_spacing, trans_font_size=trans_size, trans_color=trans_color,
                   show_time=bool(v["show_time"].get()), channel_detail=bool(v["channel_detail"].get()),
                   class_colors=bool(v["class_colors"].get()))
        app.apply_window_settings()
        config.save(cfg)
        app.worker.research()
        logging.getLogger("cmr.options").info(
            "설정 저장 | 번역=%s | 목표=%s | url=%s | 모델=%s | 추론끄기=%s | 배경/글자 투명도=%s/%s",
            cfg["translator"], cfg["target_lang"], cfg["api_url"], cfg["api_model"] or "(기본)",
            cfg["disable_reasoning"], cfg["bg_opacity"], cfg["text_opacity"])
        app.add_system(tr("설정 저장됨 - 번역: {tr_name}, 목표 언어: {lang}",
                         tr_name=tr(TRANSLATOR_LABELS[cfg["translator"]]), lang=cfg["target_lang"]))
        self.win.destroy()
