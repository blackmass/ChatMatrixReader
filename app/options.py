"""Options window (right-click on the main window)."""
import ctypes
import sys
import subprocess
import copy
import json
import re
import logging
import os
import threading
import time
import tkinter as tk
from ctypes import wintypes
from tkinter import colorchooser, ttk, messagebox

import childwin
import config
import plat
import resmeter
import voiceinstall as vinst
import glossary
import hotkeys
import logsetup
import updatecheck
import usage
import version
import voice
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

        self.v = {
            "translator": tk.StringVar(value=tr(TRANSLATOR_LABELS.get(cfg["translator"], TRANSLATOR_LABELS["none"]))),
            "target_lang": tk.StringVar(value=cfg["target_lang"]),
            "api_url": tk.StringVar(value=cfg["api_url"]),
            "api_model": tk.StringVar(value=cfg["api_model"]),
            "api_key": tk.StringVar(value=cfg["api_key"]),
            "google_api_key": tk.StringVar(value=cfg["google_api_key"]),
            "custom_preset": tk.StringVar(value=cfg.get("custom_preset") or tr(translator.CUSTOM_PRESET_MANUAL)),
            "custom_key": tk.StringVar(value=cfg.get("custom_key", "")),
            "custom_url": tk.StringVar(value=cfg.get("custom_url", "")),
            "custom_headers": tk.StringVar(value=cfg.get("custom_headers", "{}")),
            "custom_body_type": tk.StringVar(value="form" if cfg.get("custom_body_type") == "form" else "json"),
            "custom_path": tk.StringVar(value=cfg.get("custom_path", "")),
            "custom_note": tk.StringVar(value=""),
            "disable_reasoning": tk.BooleanVar(value=bool(cfg["disable_reasoning"])),
            "reasoning_off_body": tk.StringVar(value=cfg["reasoning_off_body"]),
            "temperature": tk.StringVar(value=str(cfg["temperature"])),
            "timeout": tk.StringVar(value=str(cfg["timeout"])),
            "skip_same_lang": tk.BooleanVar(value=bool(cfg["skip_same_lang"])),
            "skip_regex": tk.StringVar(value=cfg.get("skip_regex", "")),
            "skip_regex_hide": tk.BooleanVar(value=bool(cfg.get("skip_regex_hide", False))),
            "glossary_file": tk.StringVar(value=cfg["glossary_file"]),
            "glossary_google": tk.BooleanVar(value=bool(cfg["glossary_google"])),
            "glossary_mode": tk.StringVar(value=glossary.mode(cfg)),
            "glossary_style": tk.StringVar(value=tr(glossary.GLOSSARY_STYLES.get(cfg["glossary_style"], glossary.GLOSSARY_STYLES["paren"]))),
            "glossary_info": tk.StringVar(value=""),
            "test_text": tk.StringVar(value="LFM M+ 12 need tank and healer, inv pls"),
            "test_result": tk.StringVar(value=""),
            "bg_opacity": tk.DoubleVar(value=float(cfg["bg_opacity"])),
            "text_opacity": tk.DoubleVar(value=float(cfg["text_opacity"])),
            "topmost": tk.BooleanVar(value=bool(cfg["topmost"])),
            "topmost_wow_only": tk.BooleanVar(value=bool(cfg.get("topmost_wow_only"))),
            "click_through": tk.BooleanVar(value=bool(cfg["click_through"])),
            "exit_with_game": tk.BooleanVar(value=bool(cfg.get("exit_with_game"))),
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
            "fade_sec": tk.IntVar(value=int(cfg.get("fade_sec", 0))),
            "poll_hz": tk.IntVar(value=int(cfg["poll_hz"])),
            "full_scan_sec": tk.IntVar(value=int(cfg.get("full_scan_sec", 30))),
            "send_enabled": tk.BooleanVar(value=bool(cfg.get("send_enabled", True))),
            "send_lang": tk.StringVar(value=cfg.get("send_lang") or "English"),
            "send_route": tk.StringVar(value=self._send_route_labels().get(cfg.get("send_route"), self._send_route_labels()[translator.ROUTE_DEFAULT])),
            "send_hotkey": tk.StringVar(value=cfg.get("send_hotkey") or hotkeys.DEFAULT),
            "send_autopaste": tk.BooleanVar(value=bool(cfg.get("send_autopaste", False))),
            "log_request": tk.BooleanVar(value=bool(cfg.get("log_request", False))),
            "send_show_log": tk.BooleanVar(value=bool(cfg.get("send_show_log", False))),
            "voice_enabled": tk.BooleanVar(value=bool(cfg.get("voice_enabled", False))),
            "voice_target": tk.StringVar(value=tr(voice.TARGETS.get(cfg.get("voice_target"), voice.TARGETS["discord"]))),
            "voice_app": tk.StringVar(value=str(cfg.get("voice_app") or "")),
            "voice_lang": tk.StringVar(value=cfg.get("voice_lang") or "auto"),
            "voice_mode": tk.StringVar(value=cfg.get("voice_mode") if cfg.get("voice_mode") in ("sentence", "live") else "sentence"),
            "voice_end_ms": tk.IntVar(value=int(cfg.get("voice_end_ms", 700) or 700)),
            "voice_device": tk.StringVar(value=cfg.get("voice_device") if cfg.get("voice_device") in voice.DEVICES else "auto"),
            "voice_model": tk.StringVar(value=cfg.get("voice_model", "")),
            "voice_max_s": tk.IntVar(value=int(cfg.get("voice_max_s", 12) or 12)),
            "voice_engine": tk.StringVar(value=cfg.get("voice_engine") if cfg.get("voice_engine") in voice.ENGINES else "whisper"),
            "voice_oa_url": tk.StringVar(value=cfg.get("voice_oa_url", "")),
            "voice_oa_key": tk.StringVar(value=cfg.get("voice_oa_key", "")),
            "voice_oa_model": tk.StringVar(value=cfg.get("voice_oa_model", "")),
            "voice_oa_format": tk.StringVar(value=cfg.get("voice_oa_format") if cfg.get("voice_oa_format") in voice.OA_FORMATS else "json"),
            "voice_oa_timeout": tk.IntVar(value=int(cfg.get("voice_oa_timeout", 30) or 30)),
            "voice_check": tk.StringVar(value=""),
            "voice_status": tk.StringVar(value=""),
            "voice_btn": tk.StringVar(value=""),
        }
        self.openai_widgets = []
        self.google_widgets = []
        self.custom_widgets = []
        self.test_widgets = []
        self.folds = {}
        self._fold_mode = None

        row = ttk.Frame(win)
        row.pack(side="bottom", anchor="e", padx=8, pady=(2, 8))     # packed first: always visible, whatever the size
        nb = ttk.Notebook(win)
        nb.pack(side="top", fill="both", expand=True, padx=8, pady=(8, 4))
        self._tab_translate(nb)
        self._tab_channels(nb)
        self._tab_windows(nb)
        self._tab_capture(nb)
        self._tab_send(nb)
        self._tab_voice(nb)
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
        # two columns: left = basics, filters, glossary, test; right = the settings of the translators (they fold by mode)
        left = ttk.Frame(tab)
        left.grid(row=0, column=0, sticky="nsew")
        ttk.Separator(tab, orient="vertical").grid(row=0, column=1, sticky="ns", padx=6, pady=10)
        right = ttk.Frame(tab)
        right.grid(row=0, column=2, sticky="nsew")
        tab.columnconfigure(0, weight=1)
        tab.columnconfigure(2, weight=1)

        top = ttk.Frame(left)
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
        g1 = self.folds["openai"] = _Fold(right, tr("OpenAI 호환 API (LM Studio 등)"))
        ttk.Label(g1, text="API URL").grid(row=0, column=0, sticky="w", **PAD)
        e1 = ttk.Entry(g1, textvariable=v["api_url"], width=40)
        e1.grid(row=0, column=1, columnspan=2, sticky="w", **PAD)
        ttk.Label(g1, text=tr("모델")).grid(row=1, column=0, sticky="w", **PAD)
        self.model_cb = ttk.Combobox(g1, textvariable=v["api_model"], width=34)
        self.model_cb.grid(row=1, column=1, sticky="w", **PAD)
        b1 = ttk.Button(g1, text=tr("목록 불러오기"), command=self.fetch_models)
        b1.grid(row=1, column=2, **PAD)
        ttk.Label(g1, text="API Key").grid(row=2, column=0, sticky="w", **PAD)
        e2 = ttk.Entry(g1, textvariable=v["api_key"], width=40, show="*")
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
        e5 = ttk.Entry(g1, textvariable=v["reasoning_off_body"], width=50)
        e5.grid(row=5, column=0, columnspan=3, sticky="w", **PAD)
        ttk.Label(g1, text=tr("모델마다 끄는 방법이 다릅니다. 서버가 거부(400)하면 자동으로 빼고 다시 요청합니다.\n"
                              "URL은 http://localhost:1234 처럼 써도 /v1 을 자동으로 붙입니다."),
                  foreground="#666", justify="left").grid(row=6, column=0, columnspan=3, sticky="w", **PAD)
        self.openai_widgets += [e1, self.model_cb, b1, e2, s1, s2, c1, e5]

        # --- Google
        g2 = self.folds["google"] = _Fold(right, tr("Google 번역"))
        g2.pack(fill="x", padx=8, pady=4)
        ttk.Label(g2, text=tr("API Key (선택, Basic v2)")).grid(row=0, column=0, sticky="w", **PAD)
        e3 = ttk.Entry(g2, textvariable=v["google_api_key"], width=40, show="*")
        e3.grid(row=0, column=1, sticky="w", **PAD)
        ttk.Label(g2, text=tr("비우면 키 없이 쓰는 비공식 무료 방식입니다 (제한되거나 바뀔 수 있음).\n"
                              "Cloud Translation API(Basic, v2)의 API 키를 넣으면 공식 방식을 사용합니다. 서비스 계정 JSON·v3 키는 쓸 수 없습니다."),
                  foreground="#666", justify="left").grid(row=1, column=0, columnspan=2, sticky="w", **PAD)
        ttk.Label(g2, text=tr("이번 달 사용량: 약 {used} / {limit}자 (추정값이며 정확하지 않습니다)",
                              used=f"{usage.total():,}", limit=f"{usage.FREE_LIMIT:,}"),
                  foreground="#666").grid(row=2, column=0, columnspan=2, sticky="w", **PAD)
        self.google_widgets += [e3]

        # --- custom HTTP (DeepL, Azure, Papago, ... : one request, JSON answer)
        gu = self.folds["custom"] = _Fold(right, tr("사용자 정의 HTTP (DeepL, Azure, Papago, Claude 등)"))
        gu.pack(fill="x", padx=8, pady=4)
        ttk.Label(gu, text=tr("서비스")).grid(row=0, column=0, sticky="w", **PAD)
        pc = ttk.Combobox(gu, textvariable=v["custom_preset"], state="readonly", width=30,
                          values=[tr(translator.CUSTOM_PRESET_MANUAL)] + list(translator.CUSTOM_PRESETS))
        pc.grid(row=0, column=1, sticky="w", **PAD)
        pc.bind("<<ComboboxSelected>>", lambda e: self.apply_custom_preset())
        ttk.Label(gu, text="API Key").grid(row=1, column=0, sticky="w", **PAD)
        uk = ttk.Entry(gu, textvariable=v["custom_key"], width=40, show="*")
        uk.grid(row=1, column=1, sticky="w", **PAD)
        ttk.Label(gu, text=tr("주소")).grid(row=2, column=0, sticky="w", **PAD)
        uu = ttk.Entry(gu, textvariable=v["custom_url"], width=40)
        uu.grid(row=2, column=1, sticky="w", **PAD)
        ttk.Label(gu, text=tr("헤더(JSON)")).grid(row=3, column=0, sticky="w", **PAD)
        uh = ttk.Entry(gu, textvariable=v["custom_headers"], width=40)
        uh.grid(row=3, column=1, sticky="w", **PAD)
        ttk.Label(gu, text=tr("본문 종류")).grid(row=4, column=0, sticky="w", **PAD)
        ub = ttk.Combobox(gu, textvariable=v["custom_body_type"], values=["json", "form"], state="readonly", width=8)
        ub.grid(row=4, column=1, sticky="w", **PAD)
        ttk.Label(gu, text=tr("본문")).grid(row=5, column=0, sticky="nw", **PAD)
        self.custom_body = tk.Text(gu, width=38, height=5, wrap="word", font=("Consolas", 9), undo=True)
        self.custom_body.grid(row=5, column=1, sticky="w", **PAD)
        self.custom_body.insert("1.0", self.app.cfg.get("custom_body", ""))
        ttk.Label(gu, text=tr("번역문 위치")).grid(row=6, column=0, sticky="w", **PAD)
        up = ttk.Entry(gu, textvariable=v["custom_path"], width=40)
        up.grid(row=6, column=1, sticky="w", **PAD)
        ttk.Label(gu, textvariable=v["custom_note"], foreground="#a05a00", wraplength=380, justify="left").grid(
            row=7, column=0, columnspan=2, sticky="w", **PAD)
        ttk.Label(gu, text=tr("자리표시: {text} 원문, {key} API Key, {target}/{TARGET} 목표 언어 코드(ko / KO), "
                              "{system} 프롬프트(AI용), {key1}/{key2} 키를 ':' 로 나눈 앞/뒤. "
                              "번역문 위치는 응답 JSON 의 경로입니다 (예: translations.0.text)."),
                  foreground="#666", wraplength=380, justify="left").grid(row=8, column=0, columnspan=2, sticky="w", **PAD)
        self.custom_widgets += [pc, uk, uu, uh, ub, self.custom_body, up]

        g1.pack(fill="x", padx=8, pady=4)

        # --- glossary
        gg = self.folds["glossary"] = _Fold(left, tr("단어장 (Google, AI 공통)"))
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
        ttk.Label(gg, text=tr("AI에 단어장을 보내는 방식")).grid(row=6, column=0, columnspan=3, sticky="w", **PAD)
        for r, (mode, label) in enumerate((
                ("full", tr("전체: 단어장 전체를 프롬프트에 넣기 (기본)")),
                ("list", tr("선별: 문장에 나온 단어의 항목만 골라 앞에 붙이기 (큰 단어장·작은 모델에 유리)")),
                ("mixed", tr("복합: 뜻이 하나면 단어 뒤 괄호에, 뜻이 여럿이거나 메모가 있으면 앞에 목록으로 (실험)")))):
            ttk.Radiobutton(gg, text=label, value=mode, variable=v["glossary_mode"]).grid(
                row=7 + r, column=0, columnspan=3, sticky="w", padx=(18, 8), pady=1)
        ttk.Label(gg, text=tr("'선별'이나 '복합'을 고르면 프롬프트의 {{Glossary.txt}} 자리에는 내 단어장 대신 짧은 안내가 들어갑니다. "
                              "같은 약어에 뜻이 여럿이면 단어장에 같은 단어를 여러 줄 적으면 됩니다 (예: ATM=현금입출기 / ATM=지금 이 순간)."),
                  foreground="#666", wraplength=420, justify="left").grid(row=10, column=0, columnspan=3, sticky="w", **PAD)
        ttk.Label(gg, text=tr("AI(OpenAI 호환)에는 프롬프트의 {{Glossary.txt}} 자리에 파일 내용이 들어갑니다. 파일은 저장하면 바로 반영됩니다."),
                  foreground="#666").grid(row=4, column=0, columnspan=3, sticky="w", **PAD)
        ttk.Label(gg, text=tr("단어장이나 프롬프트를 바꾸면 AI 번역은 첫 번역이 느려질 수 있습니다 (서버가 새 내용을 읽는 시간). "
                              "'시작할 때 번역 서버 연결 확인'이 켜져 있으면 바뀐 뒤 미리 한 번 보내 두어 줄여 줍니다."),
                  foreground="#666", wraplength=380, justify="left").grid(row=5, column=0, columnspan=3, sticky="w", **PAD)
        self.google_widgets += [gc, gs]

        # --- prompt
        g3 = self.folds["prompt"] = _Fold(right, tr("프롬프트 (OpenAI 호환 API 전용. {target_lang}: 목표 언어, {{파일명}}: 그 파일 내용)"))
        g3.pack(fill="both", padx=8, pady=4)
        holder = ttk.Frame(g3)
        holder.pack(fill="both", padx=6, pady=(4, 2))
        self.prompt = tk.Text(holder, width=54, height=8, wrap="word", font=("Malgun Gothic", 9), undo=True)
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
        self.prompt_note = ttk.Label(g3, foreground="#b45f00", wraplength=420, justify="left")
        self.prompt_note.pack(anchor="w", padx=6, pady=(0, 4))
        self.prompt.bind("<KeyRelease>", lambda e: self._prompt_note_update(), add="+")
        self._prompt_note_update()
        self.openai_widgets += [self.prompt, b2]

        # --- the user's own additional instructions (kept when the default prompt is updated)
        ttk.Separator(g3).pack(fill="x", padx=6, pady=(2, 4))
        ttk.Label(g3, text=tr("추가 지시 (말투·스타일 등. 비워 두면 사용하지 않습니다)"),
                  font=("Malgun Gothic", 9, "bold")).pack(anchor="w", padx=6)
        ttk.Label(g3, text=tr("위의 기본 프롬프트는 그대로 두고, 여기에 적은 내용만 프롬프트 맨 끝에 덧붙입니다. 기본 프롬프트가 업데이트되어도 "
                              "이 칸은 그대로 남습니다. 모델이 더 잘 따르도록 영어로 쓰는 것을 권합니다. 번역이 이상해지면 이 칸을 비워 보세요."),
                  foreground="#666", wraplength=420, justify="left").pack(anchor="w", padx=6, pady=(0, 2))
        self.extra_prompt = tk.Text(g3, width=54, height=3, wrap="word", font=("Malgun Gothic", 9), undo=True)
        self.extra_prompt.pack(fill="x", padx=6, pady=(0, 2))
        self.extra_prompt.insert("1.0", self.app.cfg.get("extra_prompt") or "")
        ttk.Label(g3, text=tr("예시 (영어 문장을 복사해서 위 칸에 붙여 넣으세요):"), foreground="#666").pack(anchor="w", padx=6)
        for desc, english in ((tr("자연스럽게"), "Use a natural, everyday way of speaking, like a native speaker in game chat."),
                              (tr("해적 말투로"), "Always write the translated dialogue in the style of a pirate."),
                              (tr("반말로 짧게"), "Use a casual, informal tone and keep sentences short."),
                              (tr("존댓말로"), "Always use polite, formal speech.")):
            row = ttk.Frame(g3)
            row.pack(fill="x", padx=6, pady=1)
            ttk.Label(row, text=desc, foreground="#666", width=12).pack(side="left")
            ex_e = ttk.Entry(row, width=48)                    # read-only: the text can be selected and copied
            ex_e.insert(0, english)
            ex_e.configure(state="readonly")
            ex_e.pack(side="left", fill="x", expand=True)
        self.openai_widgets += [self.extra_prompt]

        # --- common
        ttk.Checkbutton(left, text=tr("목표 언어와 같은 문장은 번역 생략 (한국어 등 글자로 판별 가능한 경우)"),
                        variable=v["skip_same_lang"]).pack(anchor="w", padx=10, pady=2)
        gx = ttk.Frame(left)
        gx.pack(fill="x", padx=10, pady=(2, 0))
        ttk.Label(gx, text=tr("번역 제외 패턴 (정규식):")).pack(side="left")
        ttk.Entry(gx, textvariable=v["skip_regex"], width=34).pack(side="left", padx=6)
        ttk.Checkbutton(left, text=tr("일치하는 문장은 원문도 숨김 (창에 표시하지 않음)"),
                        variable=v["skip_regex_hide"]).pack(anchor="w", padx=10, pady=2)
        ttk.Label(left, text=tr("비워 두면 사용하지 않습니다. 이 패턴이 한 글자라도 일치하는 문장은 번역하지 않고 원문만 표시합니다. "
                               "(목표 언어를 바꾸면 패턴도 직접 바꿔 주세요.)"),
                  foreground="#666", wraplength=380, justify="left").pack(anchor="w", padx=10)
        ex = ttk.Frame(left)
        ex.pack(fill="x", padx=10, pady=(0, 4))
        ttk.Label(ex, text=tr("예 (한글이 있는 문장 제외):"), foreground="#666").pack(side="left")
        exe = ttk.Entry(ex, width=20)                          # read-only: the text can be selected and copied
        exe.insert(0, "[가-힣ㄱ-ㅎㅏ-ㅣ]")
        exe.configure(state="readonly")
        exe.pack(side="left", padx=6)

        gg.pack(fill="x", padx=8, pady=4)

        # --- test
        g4 = ttk.LabelFrame(left, text=tr("테스트 (저장하지 않아도 지금 입력한 설정으로 시험)"))
        g4.pack(fill="x", padx=8, pady=(4, 8))
        e4 = ttk.Entry(g4, textvariable=v["test_text"], width=40)
        e4.grid(row=0, column=0, **PAD)
        b3 = ttk.Button(g4, text=tr("테스트"), command=self.run_test)
        b3.grid(row=0, column=1, **PAD)
        ttk.Label(g4, textvariable=v["test_result"], wraplength=380, justify="left").grid(
            row=1, column=0, columnspan=2, sticky="w", **PAD)
        self.test_widgets += [e4, b3]

    # ---- translation method per channel (the "channel translation" tab)
    def _route_labels(self):
        return {translator.ROUTE_DEFAULT: tr("기본 번역 (번역 탭 설정대로)"),
                translator.ROUTE_GOOGLE_FREE: tr("구글 번역 (무료, 키 사용 안 함)"),
                translator.ROUTE_GOOGLE: tr("구글 번역 (키 사용, 키가 없으면 무료)"),
                translator.ROUTE_OPENAI: tr("OpenAI 호환 API"),
                translator.ROUTE_CUSTOM: tr("사용자 정의 HTTP"),
                translator.ROUTE_OFF: tr("번역 안 함")}

    def _send_route_labels(self):
        """The sending direction offers the same methods, but 'not translated' makes no sense there."""
        labels = self._route_labels()
        labels.pop(translator.ROUTE_OFF)
        return labels

    def _channel_rows(self, etc=False):
        """(code, label) of every channel row; the lists of the "windows" tab also have a row for everything else."""
        rows = [("S", tr("말하기")), ("Y", tr("외치기")), ("E", tr("감정 표현")),
                ("P", tr("파티")), ("PL", tr("파티장")), ("R", tr("공격대")), ("RL", tr("공격대장")), ("RW", tr("공격대 경보")),
                ("I", tr("인스턴스")), ("IL", tr("인스턴스장")), ("G", tr("길드")), ("O", tr("길드 관리자")),
                ("W", tr("받은 귓속말")), ("B", tr("받은 배틀넷 귓속말")), ("WT", tr("보낸 귓속말")), ("BT", tr("보낸 배틀넷 귓속말")),
                ("CM", tr("커뮤니티"))]
        rows += [(f"C{n}", tr("번호 채널 {n}", n=n)) for n in range(1, 11)]
        rows.append(("!NPC", tr("NPC·보스 대사")))
        rows.append(("!VC", tr("음성 인식 (들은 말)")))
        if etc:
            rows.append((childwin.ETC, tr("그 밖의 줄 (시스템·전리품·경험치 등)")))
        return rows

    # ---- "windows" tab: the main window and the extra windows in one place (list | channels | options of the chosen window)
    def _chan_grid(self, parent, selected, cols=2):
        """Check boxes of every channel row in `parent` (in `cols` vertical columns); returns {code: BooleanVar}."""
        for w in parent.winfo_children():
            w.destroy()
        rows = self._channel_rows(etc=True)
        per = -(-len(rows) // cols)
        out = {}
        for i, (code, label) in enumerate(rows):
            var = tk.BooleanVar(value=code in selected)
            ttk.Checkbutton(parent, text=label, variable=var).grid(row=i % per, column=i // per, sticky="w", padx=(2, 10), pady=0)
            out[code] = var
        return out

    def _win_name(self, i):
        """Name in the list: 0 = the main window, then the extra windows."""
        if i == 0:
            return tr("번역")
        c = self._kw[i - 1]
        name = c.get("name") or (tr("음성 인식") if c["id"] == childwin.VOICE_ID else tr("창 {n}", n=c["id"]))
        return f"{c['id']}  {name}"

    def _kw_modes(self, wid):
        """open_mode -> label, for the window (only the voice window has "while the voice recognition runs")."""
        d = {"always": tr("항상 (프로그램을 켤 때부터)")}
        if wid == childwin.VOICE_ID:
            d["voice"] = tr("음성 인식이 켜져 있는 동안만")
        d["never"] = tr("열지 않음 (우클릭 메뉴에서 열 때만)")
        return d

    def _tab_windows(self, nb):
        app = self.app
        tab = self._tab_frame(nb, tr("창 관리"))
        self._kw = copy.deepcopy(app.cfg.get("child_windows") or [])
        off = set(app.cfg.get("win1_off") or ())
        self._w1_on = {c for c, _l in self._channel_rows(etc=True) if c not in off}     # working copy: channels of the main window
        self._cur = 0                                                                    # shown: 0 = main window, i = self._kw[i - 1]
        self._chan_vars = {}
        # ---- column 0: the windows
        c0 = ttk.Frame(tab)
        c0.grid(row=0, column=0, sticky="nsw", padx=(4, 6), pady=6)
        ttk.Label(c0, text=tr("창"), foreground="#666").pack(anchor="w")
        self._wlist = tk.Listbox(c0, exportselection=False, width=16, height=12, activestyle="none")
        self._wlist.pack(fill="y", expand=True)
        self._wlist.bind("<<ListboxSelect>>", self._win_pick)
        self._win_del = ttk.Button(c0, text=tr("선택한 창 삭제"), command=self._win_delete)
        self._win_del.pack(fill="x", pady=(6, 0))
        # ---- column 1: channels
        ttk.Separator(tab, orient="vertical").grid(row=0, column=1, sticky="ns", pady=10)
        c1 = ttk.Frame(tab)
        c1.grid(row=0, column=2, sticky="nsw", padx=6, pady=6)
        ttk.Label(c1, text=tr("이 창에 표시할 채널"), foreground="#666").pack(anchor="w")
        self._chan_frame = ttk.Frame(c1)
        self._chan_frame.pack(anchor="w", pady=2)
        cb = ttk.Frame(c1)
        cb.pack(anchor="w", pady=(4, 0))
        ttk.Button(cb, text=tr("모두 선택"), command=lambda: [x.set(True) for x in self._chan_vars.values()]).pack(side="left")
        ttk.Button(cb, text=tr("모두 해제"), command=lambda: [x.set(False) for x in self._chan_vars.values()]).pack(side="left", padx=6)
        ttk.Label(c1, text=tr("같은 줄이 여러 창에 함께 나올 수 있습니다. 번역은 한 번만 요청합니다."), foreground="#666",
                  wraplength=250, justify="left").pack(anchor="w", pady=(8, 0))
        # ---- column 2: the options of the chosen window
        ttk.Separator(tab, orient="vertical").grid(row=0, column=3, sticky="ns", pady=10)
        c2 = ttk.Frame(tab)
        c2.grid(row=0, column=4, sticky="nsew", padx=6, pady=6)
        tab.columnconfigure(4, weight=1)
        hdr = ttk.Frame(c2)
        hdr.pack(fill="x", pady=(0, 4))
        ttk.Label(hdr, text=tr("창이 열리는 때")).pack(side="left")
        self._kw_mode = tk.StringVar()
        self._kw_mode_combo = ttk.Combobox(hdr, textvariable=self._kw_mode, state="readonly", width=34)
        self._kw_mode_combo.pack(side="left", padx=6)
        self._page_main = ttk.Frame(c2)
        self._tab_window(self._page_main)                       # the options of the main window (as they were)
        self._page_kid = ttk.Frame(c2)
        self._build_kid_page(self._page_kid)
        self._wrap_notes(self._page_main)                       # the notes break into short lines: the tab must not get wide
        self._wrap_notes(self._page_kid)
        self._win_refresh()
        self._win_show()

    def _wrap_notes(self, frame, width=300):
        for w in frame.winfo_children():
            if isinstance(w, ttk.Label) and str(w.cget("foreground")) == "#666":
                w.configure(wraplength=width, justify="left")
            self._wrap_notes(w, width)

    def _build_kid_page(self, page):
        """The options of an extra window: what exists is switched on, the rest is shown grey (still main window only)."""
        app = self.app
        self._kw_name, self._kw_font, self._kw_size = tk.StringVar(), tk.StringVar(), tk.StringVar()
        self._kw_bgop, self._kw_txop = tk.StringVar(), tk.StringVar()
        self._kw_top, self._kw_wow = tk.BooleanVar(), tk.BooleanVar()
        self._kw_ct, self._kw_hover = tk.BooleanVar(), tk.BooleanVar()
        left, right = ttk.Frame(page), ttk.Frame(page)
        left.grid(row=0, column=0, sticky="nsew")
        ttk.Separator(page, orient="vertical").grid(row=0, column=1, sticky="ns", padx=6, pady=10)
        right.grid(row=0, column=2, sticky="nsew")
        page.columnconfigure(0, weight=1)
        page.columnconfigure(2, weight=1)
        grey = []

        def dis_check(parent, row, text):
            b = ttk.Checkbutton(parent, text=text, state="disabled")
            b.grid(row=row, column=0, sticky="w", **PAD)
            return b

        def dis_spin(parent, row, text):
            f = ttk.Frame(parent)
            f.grid(row=row, column=0, columnspan=2, sticky="w", **PAD)
            ttk.Label(f, text=text, foreground="#999").pack(side="left")
            ttk.Spinbox(f, width=6, state="disabled").pack(side="left", padx=6)
        # ---- left: behaviour (the same options as the main window's left column)
        ttk.Checkbutton(left, text=tr("항상 위에 표시"), variable=self._kw_top,
                        command=lambda: self._kw_wow.set(False) if self._kw_top.get() else None).grid(row=0, column=0, sticky="w", **PAD)
        ttk.Checkbutton(left, text=tr("와우 창 위에만 표시 (다른 창에는 가려짐)"), variable=self._kw_wow,
                        command=lambda: self._kw_top.set(False) if self._kw_wow.get() else None).grid(row=1, column=0, sticky="w", **PAD)
        ttk.Checkbutton(left, text=tr("클릭 통과 (조작 키를 누르는 동안만 조작)"), variable=self._kw_ct).grid(row=2, column=0, sticky="w", **PAD)
        ttk.Checkbutton(left, text=tr("마우스를 올리면 완전히 투명하게 (클릭 통과를 켠 경우만)"), variable=self._kw_hover).grid(
            row=3, column=0, sticky="w", **PAD)
        dis_spin(left, 4, tr("최대 보관 줄 수"))
        dis_check(left, 5, tr("채팅 시간 표시"))
        dis_check(left, 6, tr("직업 색상으로 이름 표시"))
        dis_check(left, 7, tr("채널 코드 자세히 표시 (문제 확인용)"))
        dis_check(left, 8, tr("번역을 위에, 원문을 아래에 표시"))
        dis_spin(left, 9, tr("아래 줄 글자 크기 (0: 위 줄과 같게)"))
        dis_spin(left, 10, tr("(실험) 지난 줄이 사라지는 시간 (초, 0: 사라지지 않음)"))
        ttk.Label(left, text=tr("회색 항목은 아직 창 1에서만 바꿀 수 있습니다. 이 창은 창 1의 설정을 그대로 따릅니다."), foreground="#666",
                  wraplength=300, justify="left").grid(row=11, column=0, sticky="w", padx=6, pady=(6, 0))
        # ---- right: look
        ttk.Label(right, text=tr("이름")).grid(row=0, column=0, sticky="w", **PAD)
        ttk.Entry(right, textvariable=self._kw_name, width=22).grid(row=0, column=1, sticky="w", **PAD)
        ttk.Label(right, text=tr("글꼴")).grid(row=1, column=0, sticky="w", **PAD)
        ttk.Combobox(right, textvariable=self._kw_font, values=[tr("창 1과 같게")] + app.custom_fonts, state="readonly",
                     width=20).grid(row=1, column=1, sticky="w", **PAD)
        ttk.Label(right, text=tr("글자 크기 (0: 창 1과 같게)")).grid(row=2, column=0, sticky="w", **PAD)
        ttk.Spinbox(right, from_=0, to=32, textvariable=self._kw_size, width=6).grid(row=2, column=1, sticky="w", **PAD)
        ttk.Label(right, text=tr("배경 투명도 (%, 낮을수록 투명)")).grid(row=3, column=0, sticky="w", **PAD)
        ttk.Spinbox(right, from_=3, to=100, increment=5, textvariable=self._kw_bgop, width=6).grid(row=3, column=1, sticky="w", **PAD)
        ttk.Label(right, text=tr("글자 투명도 (%, 낮을수록 투명)")).grid(row=4, column=0, sticky="w", **PAD)
        ttk.Spinbox(right, from_=20, to=100, increment=5, textvariable=self._kw_txop, width=6).grid(row=4, column=1, sticky="w", **PAD)
        for r, text in ((5, tr("줄 간격 (원문-번역, 픽셀)")), (6, tr("묶음 간격 (묶음 사이, 픽셀)"))):
            f = ttk.Frame(right)
            f.grid(row=r, column=0, columnspan=2, sticky="w", **PAD)
            ttk.Label(f, text=text, foreground="#999").pack(side="left")
            ttk.Spinbox(f, width=5, state="disabled").pack(side="left", padx=6)
        ttk.Checkbutton(right, text=tr("글자 그림자 사용 (배경이 투명할 때 글자가 잘 보이게)"), state="disabled").grid(
            row=7, column=0, columnspan=2, sticky="w", **PAD)
        if sys.platform == "win32":
            ttk.Checkbutton(right, text=tr("배경 블러 (Windows)"), state="disabled").grid(row=8, column=0, columnspan=2, sticky="w", **PAD)

    # ---- the list and what it shows
    def _win_refresh(self):
        self._wlist.delete(0, "end")
        for i in range(len(self._kw) + 1):
            self._wlist.insert("end", self._win_name(i))
        self._wlist.insert("end", "+  " + tr("새 창"))
        self._wlist.selection_clear(0, "end")
        self._wlist.selection_set(self._cur)

    def _win_show(self):
        """Load the chosen window into the widgets."""
        main = self._cur == 0
        if main:
            self._page_kid.pack_forget()
            self._page_main.pack(fill="both", expand=True)
            modes = {"always": tr("항상 (프로그램을 켤 때부터)")}
            self._kw_mode_combo.configure(values=list(modes.values()), state="disabled")
            self._kw_mode.set(modes["always"])
            selected = self._w1_on
            self._win_del.state(["disabled"])
        else:
            self._page_main.pack_forget()
            self._page_kid.pack(fill="both", expand=True)
            c = self._kw[self._cur - 1]
            modes = self._kw_modes(c["id"])
            self._kw_mode_combo.configure(values=list(modes.values()), state="readonly")
            self._kw_mode.set(modes.get(c["open_mode"], modes["never"]))
            self._kw_name.set(c["name"])
            self._kw_top.set(bool(c.get("topmost", True)))
            self._kw_wow.set(bool(c.get("topmost_wow_only")))
            self._kw_ct.set(bool(c.get("click_through")))
            self._kw_hover.set(bool(c.get("hover_clear")))
            fam = c.get("font_family")
            self._kw_font.set(fam if fam in self.app.custom_fonts else tr("창 1과 같게"))
            self._kw_size.set(str(int(c.get("font_size") or 0)))
            self._kw_bgop.set(str(int(round(float(c.get("bg_opacity", 1.0)) * 100))))
            self._kw_txop.set(str(int(round(float(c.get("text_opacity", 1.0)) * 100))))
            selected = set(c.get("channels") or ())
            self._win_del.state(["disabled"] if c["id"] == childwin.VOICE_ID else ["!disabled"])
        self._chan_vars = self._chan_grid(self._chan_frame, selected)

    def _win_store(self):
        """The widgets of the shown window into the working copy."""
        chosen = {code for code, var in self._chan_vars.items() if var.get()}
        if self._cur == 0:
            self._w1_on = chosen
            return
        c = self._kw[self._cur - 1]
        rev = {v: k for k, v in self._kw_modes(c["id"]).items()}
        c["open_mode"] = rev.get(self._kw_mode.get(), "never")
        c["name"] = self._kw_name.get().strip()[:30]
        c["topmost_wow_only"] = bool(self._kw_wow.get())
        c["topmost"] = bool(self._kw_top.get()) and not c["topmost_wow_only"]
        c["click_through"] = bool(self._kw_ct.get())
        c["hover_clear"] = bool(self._kw_hover.get())
        c["font_family"] = self._kw_font.get() if self._kw_font.get() in self.app.custom_fonts else ""
        try:
            n = int(float(self._kw_size.get()))
        except ValueError:
            n = 0
        c["font_size"] = 0 if n <= 0 else max(8, min(32, n))
        for key, var, lo in (("bg_opacity", self._kw_bgop, 3), ("text_opacity", self._kw_txop, 20)):
            try:
                o = int(float(var.get()))
            except ValueError:
                o = 100
            c[key] = max(lo, min(100, o)) / 100
        c["channels"] = [code for code, _l in self._channel_rows(etc=True) if code in chosen]

    def _win_pick(self, _e=None):
        sel = self._wlist.curselection()
        if not sel:
            return
        i = sel[0]
        if i == self._cur:
            return
        self._win_store()
        if i == len(self._kw) + 1:                               # "+ new window": empty, switched off, no channels
            self._kw.append(childwin.new_conf(childwin.next_id(self._kw)))
            i = len(self._kw)
        self._cur = i
        self._win_refresh()
        self._win_show()

    def _win_delete(self):
        if self._cur == 0:
            return
        c = self._kw[self._cur - 1]
        if c["id"] == childwin.VOICE_ID:
            return
        if not messagebox.askyesno(tr("창 삭제"), tr("'{n}' 창을 삭제할까요? (저장하면 적용됩니다)", n=self._win_name(self._cur)), parent=self.win):
            return
        del self._kw[self._cur - 1]
        self._cur = 0
        self._win_refresh()
        self._win_show()

    def _collect_windows(self):
        """The working copy into the settings. The window objects keep their own settings dicts (and the position the user gave them)."""
        cfg = self.app.cfg
        self._win_store()
        cur = {c["id"]: c for c in cfg.get("child_windows") or []}
        out = []
        for item in self._kw:
            c = cur.get(item["id"]) or childwin.new_conf(item["id"])
            c.update({k: v for k, v in item.items() if k != "geometry"})
            out.append(c)
        cfg["child_windows"] = out
        cfg["win1_off"] = [code for code, _l in self._channel_rows(etc=True) if code not in self._w1_on]
        self.app.kid_override.clear()                   # the choice just made counts, not an earlier hand-made open / close

    def _tab_channels(self, nb):
        tab = self._tab_frame(nb, tr("채널별 번역"))
        labels = self._route_labels()
        by_label = {v: k for k, v in labels.items()}
        saved = self.app.cfg.get("channel_route") or {}
        ttk.Label(tab, text=tr("채널마다 번역 방식을 따로 정할 수 있습니다. 기본은 모두 '번역 탭'에 설정한 방식입니다. "
                               "중요하지 않은 공개 채팅은 '구글 번역 (무료)'로 돌리거나 번역하지 않으면 유료 번역의 사용량을 아낄 수 있습니다. "
                               "'구글 번역 (무료)'는 번역 탭의 구글 설정(단어장 등)을 그대로 쓰되 API 키만 쓰지 않습니다. "
                               "'OpenAI 호환 API'와 '사용자 정의 HTTP'는 각 탭에 입력한 서버·키·프롬프트를 그대로 씁니다 "
                               "(번역 탭에서 고른 방식과 달라도 됩니다)."),
                  foreground="#666", wraplength=620, justify="left").grid(row=0, column=0, columnspan=6, sticky="w", padx=8, pady=(8, 4))
        rows = self._channel_rows()
        self.route_vars = {}
        half = (len(rows) + 1) // 2
        for i, (code, label) in enumerate(rows):
            r, c = 1 + i % half, (i // half) * 3
            try:
                color = self.app.type_color(code)
            except Exception:
                color = "#888888"
            tk.Label(tab, width=2, bg=color, relief="solid", borderwidth=1).grid(row=r, column=c, padx=(8, 4), pady=2)   # the colour of its lines
            ttk.Label(tab, text=label).grid(row=r, column=c + 1, sticky="w", padx=(0, 4), pady=1)
            var = tk.StringVar(value=labels.get(saved.get(code), labels[translator.ROUTE_DEFAULT]))
            self.route_vars[code] = var
            ttk.Combobox(tab, textvariable=var, values=list(labels.values()), state="readonly", width=30).grid(
                row=r, column=c + 2, sticky="w", padx=(0, 10), pady=1)
        last = half + 1
        bar = ttk.Frame(tab)
        bar.grid(row=last, column=0, columnspan=6, sticky="w", padx=8, pady=(8, 2))

        def preset_public():
            for code in ("S", "Y", "C1", "C2", "C3", "C4"):
                self.route_vars[code].set(labels[translator.ROUTE_GOOGLE_FREE])

        def reset_all():
            for var in self.route_vars.values():
                var.set(labels[translator.ROUTE_DEFAULT])
        ttk.Button(bar, text=tr("공개 채널(말하기·외치기·1~4번)을 무료 구글로"), command=preset_public).pack(side="left")
        ttk.Button(bar, text=tr("모두 기본으로"), command=reset_all).pack(side="left", padx=6)
        ttk.Label(tab, text=tr("번호 채널은 게임 채팅창에 보이는 번호 그대로입니다. 보통 1은 일반(공개), 2는 거래, 3은 지역 방어, "
                               "4는 파티 찾기이지만 서버와 지역에 따라 다를 수 있습니다. 저장하면 이후에 들어오는 줄부터 적용됩니다. "
                               "왼쪽의 색 칸은 그 채널 줄의 색입니다 (프로그램을 켠 뒤 게임에서 받은 색, 아직 줄이 없으면 게임 기본색)."),
                  foreground="#666", wraplength=620, justify="left").grid(row=last + 1, column=0, columnspan=6, sticky="w", padx=8, pady=(2, 8))
        self._route_by_label = by_label

    def _send_route_key(self):
        by_label = {v: k for k, v in self._send_route_labels().items()}
        return by_label.get(self.v["send_route"].get(), translator.ROUTE_DEFAULT)

    def _collect_routes(self):
        out = {}
        for code, var in self.route_vars.items():
            key = self._route_by_label.get(var.get(), translator.ROUTE_DEFAULT)
            if key != translator.ROUTE_DEFAULT:
                out[code] = key
        return out

    def _tab_window(self, tab):
        """The options of the main window (window 1), built into `tab` (the "windows" tab shows them next to the list and the channels)."""
        v, cfg, app = self.v, self.app.cfg, self.app
        # two columns: left = what the window does (behaviour, what is shown), right = how it looks
        left = ttk.Frame(tab)
        left.grid(row=0, column=0, sticky="nsew")
        ttk.Separator(tab, orient="vertical").grid(row=0, column=1, sticky="ns", padx=6, pady=10)
        right = ttk.Frame(tab)
        right.grid(row=0, column=2, sticky="nsew")
        tab.columnconfigure(0, weight=1)
        tab.columnconfigure(2, weight=1)

        # ---------------- right: look
        ttk.Label(right, text=tr("투명도")).grid(row=0, column=0, sticky="nw", **PAD)
        sl = ttk.Frame(right)
        sl.grid(row=0, column=1, sticky="w", **PAD)

        def on_opacity(_=None):
            cfg["bg_opacity"] = round(float(v["bg_opacity"].get()), 2)
            cfg["text_opacity"] = round(float(v["text_opacity"].get()), 2)
            app.apply_opacity()

        ttk.Label(sl, text=tr("배경")).grid(row=0, column=0, sticky="w")
        ttk.Scale(sl, from_=0.05, to=1.0, variable=v["bg_opacity"], command=on_opacity,
                  length=110).grid(row=0, column=1, padx=6, pady=2)
        ttk.Label(sl, text=tr("글자")).grid(row=1, column=0, sticky="w")
        ttk.Scale(sl, from_=0.3, to=1.0, variable=v["text_opacity"], command=on_opacity,
                  length=110).grid(row=1, column=1, padx=6, pady=2)
        ttk.Label(sl, text=tr("두 값이 다르면 창 2개로 합성합니다."), foreground="#666").grid(
            row=2, column=0, columnspan=2, sticky="w")


        ttk.Label(right, text=tr("글꼴")).grid(row=1, column=0, sticky="w", **PAD)
        fam = ttk.Frame(right)
        fam.grid(row=1, column=1, sticky="w", **PAD)
        ttk.Combobox(fam, textvariable=v["font_family"], values=[tr("기본 글꼴 (맑은 고딕)")] + app.custom_fonts,
                     width=22, state="readonly").pack(side="left")
        if not app.custom_fonts:
            ttk.Label(right, text=tr("fonts 폴더에 ttf/otf 파일을 넣으면 선택할 수 있습니다"), foreground="#666").grid(
                row=2, column=0, columnspan=2, sticky="w", padx=6)
        ttk.Label(right, text=tr("글자 크기")).grid(row=3, column=0, sticky="w", **PAD)
        ttk.Spinbox(right, from_=8, to=32, textvariable=v["font_size"], width=6).grid(row=3, column=1, sticky="w", **PAD)
        sp = ttk.Frame(right)                               # both gaps in one row
        sp.grid(row=4, column=0, columnspan=2, sticky="w", **PAD)
        ttk.Label(sp, text=tr("줄 간격 (원문-번역, 픽셀)")).pack(side="left")
        ttk.Spinbox(sp, from_=0, to=40, textvariable=v["line_spacing"], width=5).pack(side="left", padx=(4, 12))
        sp2 = ttk.Frame(right)
        sp2.grid(row=5, column=0, columnspan=2, sticky="w", **PAD)
        ttk.Label(sp2, text=tr("묶음 간격 (묶음 사이, 픽셀)")).pack(side="left")
        ttk.Spinbox(sp2, from_=0, to=60, textvariable=v["group_spacing"], width=5).pack(side="left", padx=4)
        sh = ttk.LabelFrame(right, text=tr("글자 그림자"))
        sh.grid(row=6, column=0, columnspan=2, sticky="we", padx=6, pady=(8, 3))
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

        ov = ttk.LabelFrame(right, text=tr("게임 채팅창 위에 겹쳐 쓰기"))
        ov.grid(row=7, column=0, columnspan=2, sticky="we", padx=6, pady=(8, 3))

        def on_overlay():
            cfg["hover_clear"] = bool(v["hover_clear"].get())
            cfg["blur_experiment"] = bool(v["blur_experiment"].get())
            app.apply_opacity()

        hf = ttk.Frame(ov)
        hf.grid(row=0, column=0, sticky="w")
        ttk.Checkbutton(hf, text=tr("마우스를 올리면 창을 완전히 투명하게"),
                        variable=v["hover_clear"], command=on_overlay).pack(anchor="w", **PAD)
        ttk.Label(hf, text=tr("클릭 통과를 켠 경우만. 조작 키를 누르면 다시 보임"), foreground="#666").pack(anchor="w", padx=26)
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


        # ---------------- left: behaviour and what is shown
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

        ttk.Checkbutton(left, text=tr("항상 위에 표시"), variable=v["topmost"],
                        command=on_topmost).grid(row=0, column=0, sticky="w", **PAD)
        ttk.Checkbutton(left, text=tr("와우 창 위에만 표시 (다른 창에는 가려짐)"), variable=v["topmost_wow_only"],
                        command=on_wow_only).grid(row=1, column=0, sticky="w", **PAD)
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
                           "{key}를 누른 채로 창 위에 마우스를 올리면 클릭, 드래그 선택(선택하면 자동 복사), 스크롤, 창 이동이 됩니다.\n"
                           "옵션은 Ctrl+Alt+O 로도 열 수 있습니다.\n\n계속할까요?", key=app.interact_label()).replace("Ctrl+Alt+O", plat.OPTIONS_KEY), parent=self.win):
                    v["click_through"].set(False)
                    return
            cfg["click_through"] = bool(v["click_through"].get())
            app.set_click_through(cfg["click_through"])
            config.save(cfg)

        ttk.Checkbutton(left, text=tr("클릭 통과 (조작 키를 누르는 동안만 조작)"), variable=v["click_through"],
                        command=on_click_through, ).grid(row=2, column=0, sticky="w", **PAD)
        ik = ttk.Frame(left)                              # the keys that lift click-through (macOS: always Shift)
        ik.grid(row=3, column=0, sticky="w", padx=26)
        if sys.platform == "win32":
            ttk.Label(ik, text=tr("조작 키 (모두 누르고 있을 때)")).pack(side="left")

            def on_keys():
                chosen = [k for k in ("Ctrl", "Alt", "Shift") if v["ik_" + k].get()]
                if not chosen:
                    v["ik_Shift"].set(True)                  # at least one: else the window could never be used
                    chosen = ["Shift"]
                    messagebox.showinfo(tr("조작 키"), tr("조작 키는 하나 이상 선택해야 합니다."), parent=self.win)
                cfg["interact_keys"] = chosen
                config.save(cfg)

            for k in ("Shift", "Ctrl", "Alt"):
                v["ik_" + k] = tk.BooleanVar(value=k in app.interact_keys())
                ttk.Checkbutton(ik, text=k, variable=v["ik_" + k], command=on_keys).pack(side="left", padx=(8, 0))
        if sys.platform == "win32":                       # (not built for macOS)
            ttk.Checkbutton(left, text=tr("와우가 종료되면 번역창도 종료 (5초 뒤)"), variable=v["exit_with_game"]).grid(
                row=4, column=0, sticky="w", **PAD)
            ttk.Label(left, text=tr("와우가 실행 중이 아닐 때는 번역창이 항상 맨 위에 보입니다."), foreground="#666").grid(
                row=5, column=0, sticky="w", padx=26)
        ml = ttk.Frame(left)
        ml.grid(row=6, column=0, sticky="w", **PAD)
        ttk.Label(ml, text=tr("최대 보관 줄 수")).pack(side="left")
        ttk.Spinbox(ml, from_=50, to=5000, increment=50, textvariable=v["max_lines"], width=6).pack(side="left", padx=6)
        ttk.Button(ml, text=tr("화면 지우기"), command=app.clear_text).pack(side="left", padx=6)
        ttk.Checkbutton(left, text=tr("채팅 시간 표시"), variable=v["show_time"]).grid(row=7, column=0, sticky="w", **PAD)
        ttk.Checkbutton(left, text=tr("직업 색상으로 이름 표시"), variable=v["class_colors"]).grid(row=8, column=0, sticky="w", **PAD)
        ttk.Checkbutton(left, text=tr("채널 코드 자세히 표시 (문제 확인용)"), variable=v["channel_detail"]).grid(
            row=9, column=0, sticky="w", **PAD)
        ttk.Checkbutton(left, text=tr("번역을 위에, 원문을 아래에 표시"), variable=v["swap_trans"]).grid(
            row=10, column=0, sticky="w", **PAD)
        sw = ttk.Frame(left)
        sw.grid(row=11, column=0, sticky="w", padx=26)
        ttk.Label(sw, text=tr("아래 줄 글자 크기 (0: 위 줄과 같게)")).grid(row=0, column=0, sticky="w", pady=2)
        ttk.Spinbox(sw, from_=0, to=32, textvariable=v["trans_font_size"], width=6).grid(row=0, column=1, sticky="w", padx=6)
        ttk.Label(sw, text=tr("아래 줄 글자 색 (비우면 기본)")).grid(row=1, column=0, sticky="w", pady=2)
        tc = ttk.Frame(sw)
        tc.grid(row=1, column=1, sticky="w", padx=6)
        ttk.Entry(tc, textvariable=v["trans_color"], width=9).pack(side="left")
        ttk.Button(tc, text=tr("색 선택"), command=self.pick_trans_color).pack(side="left", padx=4)
        fd = ttk.Frame(left)
        fd.grid(row=12, column=0, sticky="w", **PAD)
        ttk.Label(fd, text=tr("(실험) 지난 줄이 사라지는 시간 (초, 0: 사라지지 않음)"), wraplength=240, justify="left").pack(side="left")
        ttk.Spinbox(fd, from_=0, to=3600, increment=10, textvariable=v["fade_sec"], width=6).pack(side="left", padx=6)
        ttk.Label(left, text=tr("위로 스크롤하거나 클릭 통과 상호작용 키를 누르고 있으면 모두 다시 보입니다."), foreground="#666").grid(
            row=13, column=0, sticky="w", padx=26)

    def _tab_capture(self, nb):
        v = self.v
        tab = self._tab_frame(nb, tr("캡처"))
        ttk.Label(tab, text=tr("초당 읽기 횟수")).grid(row=0, column=0, sticky="w", **PAD)
        ttk.Spinbox(tab, from_=5, to=60, textvariable=v["poll_hz"], width=6).grid(row=0, column=1, sticky="w", **PAD)
        lp = self.app.cfg.get("last_pos")
        ttk.Label(tab, text=(tr("마지막으로 찾은 위치: {x}, {y}", x=lp[0], y=lp[1]) if lp else tr("마지막으로 찾은 위치: 아직 없음"))
                  ).grid(row=1, column=0, columnspan=3, sticky="w", **PAD)
        ttk.Label(tab, text=tr("전체 탐색 간격 (초)")).grid(row=2, column=0, sticky="w", **PAD)
        ttk.Spinbox(tab, from_=5, to=600, textvariable=v["full_scan_sec"], width=6).grid(row=2, column=1, sticky="w", **PAD)
        ttk.Label(tab, text=tr("매트릭스가 잡히지 않으면 1초마다 마지막으로 찾은 위치를 다시 확인합니다. 그 위치에 없으면 위 간격마다 게임 창 안을 "
                               "훑어 다시 찾습니다 (게임 창을 찾지 못하면 모든 모니터를 훑습니다. 너무 짧게 하면 게임에 부담이 됩니다)."),
                  foreground="#666", wraplength=430, justify="left").grid(row=3, column=0, columnspan=3, sticky="w", padx=22, pady=(0, 6))
        ttk.Button(tab, text=tr("매트릭스 다시 찾기"), command=self.app.worker.research).grid(
            row=4, column=0, sticky="w", **PAD)

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

    ENGINE_LABELS = {"whisper": "Whisper (기본 - 이 PC에서 인식)", "openai": "사용자 정의 (OpenAI 방식 서버)"}

    def _tab_voice(self, nb):
        """Left: what is the same for every recognition method. Right: the method and its own settings (the groups of the methods that
        are not chosen are folded)."""
        v = self.v
        tab = self._tab_frame(nb, tr("음성 인식"))
        left = ttk.Frame(tab)
        left.grid(row=0, column=0, sticky="nw", padx=(0, 8))
        right = ttk.Frame(tab)
        right.grid(row=0, column=1, sticky="nw")
        W = 330                                                                    # wrap length of the notes in one column

        def note(parent, text, color="#666", row=None, **kw):
            lbl = ttk.Label(parent, text=text, foreground=color, wraplength=W, justify="left")
            lbl.grid(row=row, column=0, columnspan=3, sticky="w", padx=22, pady=(0, 6), **kw)
            return lbl

        # ---------------- left: common
        row = 0
        self.voice_notinst_lbl = ttk.Label(left, text=tr("음성 인식 확장이 설치되어 있지 않습니다. 오른쪽 'Whisper' 그룹의 설치하기 버튼으로 설치할 수 있습니다. "
                                                         "(설치하지 않아도 이 프로그램의 다른 기능은 그대로 쓸 수 있습니다.)"),
                                           foreground="#b45f00", wraplength=W + 20, justify="left")
        self.voice_notinst_lbl.grid(row=row, column=0, columnspan=3, sticky="w", **PAD)
        if voice.installed():
            self.voice_notinst_lbl.grid_remove()
        row += 1
        note(left, tr("보이스 채팅의 말을 글자로 바꿔 번역창에 \"(음성)\" 줄로 보여 줍니다."), row=row)
        row += 1
        box = ttk.LabelFrame(left, text=tr("현재 상태"))
        box.grid(row=row, column=0, columnspan=3, sticky="we", padx=6, pady=(2, 6))
        self.voice_lbl = tk.Label(box, textvariable=v["voice_status"], font=("Malgun Gothic", 10, "bold"), anchor="w", width=24,
                                  wraplength=190, justify="left")
        self.voice_lbl.pack(side="left", padx=(10, 6), pady=8)
        ttk.Button(box, textvariable=v["voice_btn"], command=self._voice_button, width=13).pack(side="right", padx=10, pady=8)
        row += 1
        ttk.Checkbutton(left, text=tr("프로그램을 시작할 때 자동으로 켜기"),
                        variable=v["voice_enabled"]).grid(row=row, column=0, columnspan=3, sticky="w", **PAD)
        row += 1
        note(left, tr("이 체크는 프로그램을 시작할 때만 적용됩니다. 지금 켜고 끄는 것은 위의 버튼 (또는 창 제목줄의 스피커 버튼)으로 합니다."), row=row)
        row += 1
        ttk.Label(left, text=tr("프로그램")).grid(row=row, column=0, sticky="w", **PAD)
        tb = ttk.Combobox(left, textvariable=v["voice_target"], values=[tr(t) for t in voice.TARGETS.values()], state="readonly", width=30)
        tb.grid(row=row, column=1, columnspan=2, sticky="w", **PAD)
        tb.bind("<<ComboboxSelected>>", lambda e: self._voice_target_apply())
        row += 1
        self.voice_app_row = ttk.Frame(left)
        self.voice_app_row.grid(row=row, column=0, columnspan=3, sticky="w", padx=22, pady=(0, 4))
        ttk.Entry(self.voice_app_row, textvariable=v["voice_app"], width=24).pack(side="left")
        ttk.Button(self.voice_app_row, text=tr("목록에서 고르기..."), command=self._voice_pick_app).pack(side="left", padx=6)
        row += 1
        self.voice_target_note = note(left, "", row=row)
        row += 1
        ttk.Label(left, text=tr("말하는 언어")).grid(row=row, column=0, sticky="w", **PAD)
        ttk.Combobox(left, textvariable=v["voice_lang"], values=voice.LANGS, width=8).grid(row=row, column=1, sticky="w", **PAD)
        row += 1
        note(left, tr("auto: 문장마다 자동 감지 (정해 두면 더 정확합니다: ko, en ...)"), row=row)
        row += 1
        ttk.Label(left, text=tr("표시 방식")).grid(row=row, column=0, sticky="nw", **PAD)
        mf = ttk.Frame(left)
        mf.grid(row=row, column=1, columnspan=2, sticky="w", **PAD)
        ttk.Radiobutton(mf, text=tr("문장 모드 (끝나면 표시)"), value="sentence", variable=v["voice_mode"]).pack(anchor="w")
        self.voice_live_rb = ttk.Radiobutton(mf, text=tr("실시간 모드 (말하는 중에도 표시)"), value="live", variable=v["voice_mode"])
        self.voice_live_rb.pack(anchor="w")
        row += 1
        self.voice_mode_note = note(left, "", color="#b45f00", row=row)
        row += 1
        note(left, tr("들은 말의 번역 방식(또는 번역 안 함)은 '채널별 번역' 탭의 '음성 인식'에서 고릅니다."), row=row)
        row += 1
        note(left, tr("주의: 번역 방식이 구글이나 AI 서버이면 들은 말의 글자(음성 자체가 아님)가 그 서버로 전송됩니다."), row=row)
        row += 1
        adv = ttk.LabelFrame(left, text=tr("고급"))
        adv.grid(row=row, column=0, columnspan=3, sticky="we", **PAD)
        ttk.Label(adv, text=tr("문장을 끝낼 무음 시간 (ms)")).grid(row=0, column=0, sticky="w", **PAD)
        ttk.Spinbox(adv, from_=300, to=2000, increment=100, textvariable=v["voice_end_ms"], width=7).grid(row=0, column=1, sticky="w", **PAD)
        ttk.Label(adv, text=tr("한 번에 인식할 음성의 최대 길이 (초)")).grid(row=1, column=0, sticky="w", **PAD)
        ttk.Spinbox(adv, from_=3, to=30, increment=1, textvariable=v["voice_max_s"], width=7).grid(row=1, column=1, sticky="w", **PAD)
        ttk.Label(adv, text=tr("쉬지 않고 이보다 길게 말하면 이 길이에서 끊어서 인식합니다. 실시간 표시가 없는 방식에서는 긴 말이 이 단위로 나뉘어 나옵니다."),
                  foreground="#666", wraplength=W, justify="left").grid(row=2, column=0, columnspan=2, sticky="w", padx=6, pady=(0, 4))

        # ---------------- right: the method
        ttk.Label(right, text=tr("인식 방식")).grid(row=0, column=0, sticky="w", **PAD)
        labels = {k: tr(t) for k, t in self.ENGINE_LABELS.items()}
        self._voice_engine_labels = labels
        self.voice_engine_label = tk.StringVar(value=labels[v["voice_engine"].get()])
        eb = ttk.Combobox(right, textvariable=self.voice_engine_label, values=list(labels.values()), state="readonly", width=32)
        eb.grid(row=0, column=1, sticky="w", **PAD)
        eb.bind("<<ComboboxSelected>>", lambda e: self._voice_engine_picked())
        self.voice_privacy = ttk.Label(right, text="", wraplength=W + 60, justify="left")
        self.voice_privacy.grid(row=1, column=0, columnspan=2, sticky="w", padx=6, pady=(0, 6))
        groups = ttk.Frame(right)
        groups.grid(row=2, column=0, columnspan=2, sticky="we")

        self.voice_fold_whisper = _Fold(groups, "Whisper")
        self.voice_fold_whisper.pack(fill="x", padx=4, pady=3)
        g = self.voice_fold_whisper
        # ---- installation (the environment in extensions\\stt\\.venv)
        inst = ttk.Frame(g)
        inst.grid(row=0, column=0, columnspan=2, sticky="we", padx=6, pady=(2, 4))
        self.voice_inst_status = tk.StringVar(value="")
        self.voice_inst_lbl = ttk.Label(inst, textvariable=self.voice_inst_status, font=("Malgun Gothic", 10, "bold"), wraplength=W, justify="left")
        self.voice_inst_lbl.pack(anchor="w")
        self.voice_inst_btns = ttk.Frame(inst)
        self.voice_inst_btns.pack(anchor="w", pady=(4, 2))
        self.voice_inst_note = ttk.Label(inst, text="", foreground="#666", wraplength=W, justify="left")
        self.voice_inst_note.pack(anchor="w")
        self.v["voice_inst_models"] = tk.BooleanVar(value=False)
        self.voice_inst_models_cb = ttk.Checkbutton(inst, text="", variable=self.v["voice_inst_models"])
        self.voice_inst_prog = ttk.Frame(inst)
        self.voice_inst_bar = ttk.Progressbar(self.voice_inst_prog, mode="indeterminate", length=220)
        self.voice_inst_bar.pack(side="left")
        ttk.Button(self.voice_inst_prog, text=tr("취소"), command=self._inst_cancel).pack(side="left", padx=8)
        self.voice_inst_step = tk.StringVar(value="")
        self.voice_inst_step_lbl = ttk.Label(inst, textvariable=self.voice_inst_step, foreground="#555", wraplength=W, justify="left")
        self.voice_inst_result = tk.Label(inst, text="", anchor="w", justify="left", wraplength=W)
        # the job outlives this window (it can be closed while pip works): the running job is kept in the program
        self._inst_events = getattr(self.app, "_voice_inst_events", None) or vinst.Events()
        self.app._voice_inst_events = self._inst_events
        self._inst_job = getattr(self.app, "_voice_inst_job", None)
        self._inst_sizes = {"venv": None, "models": None}
        self._inst_state = None
        ttk.Separator(g).grid(row=1, column=0, columnspan=2, sticky="we", padx=6, pady=4)

        ttk.Label(g, text=tr("계산 장치")).grid(row=2, column=0, sticky="w", **PAD)
        ttk.Combobox(g, textvariable=v["voice_device"], values=voice.DEVICES, state="readonly", width=8).grid(row=2, column=1, sticky="w", **PAD)
        ttk.Label(g, text=tr("auto: 그래픽카드(CUDA)가 되면 사용, 아니면 CPU"), foreground="#666", wraplength=W,
                  justify="left").grid(row=3, column=0, columnspan=2, sticky="w", padx=6)
        ttk.Label(g, text=tr("모델")).grid(row=4, column=0, sticky="w", **PAD)
        ttk.Entry(g, textvariable=v["voice_model"], width=26).grid(row=4, column=1, sticky="w", **PAD)
        ttk.Label(g, text=tr("비워 두면 기본 모델 (large-v3-turbo)"), foreground="#666").grid(row=5, column=0, columnspan=2, sticky="w", padx=6, pady=(0, 4))
        ttk.Separator(g).grid(row=6, column=0, columnspan=2, sticky="we", padx=6, pady=4)
        ttk.Label(g, text=tr("이 음성 인식이 쓰는 컴퓨터 자원")).grid(row=7, column=0, columnspan=2, sticky="w", padx=6)
        self.voice_res = {}
        for i, (key, label) in enumerate((("dev", tr("지금 쓰는 장치")), ("cpu", "CPU"), ("ram", "RAM"), ("gpu", "GPU"), ("vram", "VRAM"))):
            ttk.Label(g, text=label).grid(row=8 + i, column=0, sticky="w", **PAD)
            self.voice_res[key] = ttk.Label(g, text="-", wraplength=W - 80, justify="left")
            self.voice_res[key].grid(row=8 + i, column=1, sticky="w", **PAD)
        ttk.Label(g, text=tr("최근 10초 기준입니다. 말소리가 있을 때만 일하므로 평소 값은 낮고 '최대'가 실제 부하에 가깝습니다. 꺼져 있으면 표시되지 않습니다."),
                  foreground="#666", wraplength=W, justify="left").grid(row=13, column=0, columnspan=2, sticky="w", padx=6, pady=(0, 4))
        self._res_meter = resmeter.ResourceMeter()
        self._res_cpu, self._res_gpu = resmeter.Window(10), resmeter.Window(10)
        self._res_pid, self._res_busy, self._res_result = None, False, None
        self._res_tick()
        self._inst_refresh()
        self._inst_sizes_async()
        self._inst_poll()

        self.voice_fold_openai = _Fold(groups, tr("OpenAI 방식 서버"))
        self.voice_fold_openai.pack(fill="x", padx=4, pady=3)
        g = self.voice_fold_openai
        ttk.Label(g, text=tr("OpenAI의 음성 인식 API(/v1/audio/transcriptions)를 쓰는 서버라면 붙일 수 있습니다 "
                             "(OpenAI, vLLM, LocalAI 등). 문장이 끝날 때마다 그 소리를 서버로 보내 글자를 받습니다."),
                  foreground="#666", wraplength=W, justify="left").grid(row=0, column=0, columnspan=2, sticky="w", padx=6, pady=(0, 4))
        ttk.Label(g, text=tr("주소")).grid(row=1, column=0, sticky="w", **PAD)
        ttk.Entry(g, textvariable=v["voice_oa_url"], width=34).grid(row=1, column=1, sticky="w", **PAD)
        ttk.Label(g, text=tr("예: http://localhost:8000/v1"), foreground="#666").grid(row=2, column=1, sticky="w", padx=6)
        ttk.Label(g, text=tr("API 키")).grid(row=3, column=0, sticky="w", **PAD)
        ttk.Entry(g, textvariable=v["voice_oa_key"], width=34, show="*").grid(row=3, column=1, sticky="w", **PAD)
        ttk.Label(g, text=tr("모델 이름")).grid(row=4, column=0, sticky="w", **PAD)
        ttk.Entry(g, textvariable=v["voice_oa_model"], width=34).grid(row=4, column=1, sticky="w", **PAD)
        ttk.Label(g, text=tr("비워 두면 whisper-1 (서버에 있는 이름을 그대로 적어야 합니다)"), foreground="#666", wraplength=W,
                  justify="left").grid(row=5, column=1, sticky="w", padx=6)
        ttk.Label(g, text=tr("응답 형식")).grid(row=6, column=0, sticky="w", **PAD)
        ttk.Combobox(g, textvariable=v["voice_oa_format"], values=voice.OA_FORMATS, state="readonly", width=14).grid(row=6, column=1, sticky="w", **PAD)
        ttk.Label(g, text=tr("verbose_json: 신뢰도까지 받아 엉뚱한 문장을 더 잘 거릅니다 (서버가 지원할 때)"), foreground="#666", wraplength=W,
                  justify="left").grid(row=7, column=1, sticky="w", padx=6)
        ttk.Label(g, text=tr("제한 시간 (초)")).grid(row=8, column=0, sticky="w", **PAD)
        ttk.Spinbox(g, from_=2, to=300, increment=5, textvariable=v["voice_oa_timeout"], width=7).grid(row=8, column=1, sticky="w", **PAD)
        tf = ttk.Frame(g)
        tf.grid(row=9, column=0, columnspan=2, sticky="w", pady=(6, 4))
        ttk.Button(tf, text=tr("연결 시험"), command=self._voice_check).pack(side="left", padx=6)
        self.voice_check_lbl = tk.Label(tf, textvariable=v["voice_check"], anchor="w", justify="left", wraplength=W - 90)
        self.voice_check_lbl.pack(side="left", padx=6)
        self._voice_check_result = None
        self.voice_privacy_trace = v["voice_oa_url"].trace_add("write", lambda *a: self._voice_engine_apply())
        self._voice_engine_apply()
        self._voice_target_apply()
        self._voice_tick()

    def _voice_target_key(self):
        return {tr(l): k for k, l in voice.TARGETS.items()}.get(self.v["voice_target"].get(), "discord")

    def _voice_target_apply(self):
        """The note under the program choice follows the choice; the name field is only there for 'a program of your own'."""
        key = self._voice_target_key()
        if key == "app":
            self.voice_app_row.grid()
        else:
            self.voice_app_row.grid_remove()
        notes = {
            "discord": tr("Discord의 음성 대화(상대방 목소리)만 인식합니다. Discord 안에서 보는 영상이나 소리는 거릅니다."),
            "discord-all": tr("Discord가 내는 모든 소리를 인식합니다. 음성 대화와 영상 소리가 함께 나오면 섞여서 인식이 나빠집니다."),
            "wow": tr("와우가 내는 소리를 인식합니다. 와우 음성은 아직 시험되지 않았습니다."),
            "system": tr("컴퓨터에서 나는 모든 소리(기본 출력 장치)를 인식합니다. 음악이나 영상이 섞이면 엉뚱한 글자가 나올 수 있습니다."),
            "app": tr("고른 프로그램이 내는 모든 소리를 인식합니다. 이름(예: chrome.exe)은 기억되며, 프로그램이 실행 중이 아니면 "
                      "소리가 날 때까지 기다립니다."),
        }
        self.voice_target_note.configure(text=notes[key] + ("" if key == "system" else " " + tr("듣는 장치는 알아서 찾습니다.")))

    def _voice_pick_app(self):
        """A window with the programs that make sound right now (one row per program); picking one remembers its name."""
        dlg = tk.Toplevel(self.win)
        dlg.title(tr("프로그램 고르기"))
        dlg.transient(self.win)
        dlg.geometry("560x360")
        ttk.Label(dlg, text=tr("지금 소리를 내는 프로그램이 위에 나옵니다. 목록에 없으면 그 프로그램에서 소리를 재생한 채로 '새로고침'을 누르세요."),
                  wraplength=530, justify="left").pack(anchor="w", padx=10, pady=(10, 4))
        cols = ("name", "dev", "state")
        tree = ttk.Treeview(dlg, columns=cols, show="headings", height=10, selectmode="browse")
        for c, t, w in (("name", tr("프로그램"), 150), ("dev", tr("출력 장치"), 260), ("state", tr("상태"), 110)):
            tree.heading(c, text=t)
            tree.column(c, width=w, anchor="w")
        tree.pack(fill="both", expand=True, padx=10, pady=4)
        info = tk.StringVar(value="")
        ttk.Label(dlg, textvariable=info, foreground="#666").pack(anchor="w", padx=10)
        box = {"result": None}

        def pick(_e=None):
            sel = tree.selection()
            if not sel:
                return
            self.v["voice_app"].set(tree.item(sel[0], "values")[0])
            self.v["voice_target"].set(tr(voice.TARGETS["app"]))
            self._voice_target_apply()
            dlg.destroy()

        def fill():
            try:
                if not dlg.winfo_exists():
                    return
                res = box["result"]
                if res is None:
                    dlg.after(150, fill)
                    return
                rows, err = res
                tree.delete(*tree.get_children())
                for r in rows:
                    st = (tr("소리 나는 중") if r.get("peak", 0) > 0.002 else (tr("재생 중 (조용함)") if r.get("active") else tr("대기")))
                    tree.insert("", "end", values=(r["name"], ", ".join(r.get("devices") or []), st))
                info.set(err or (tr("{n}개 프로그램", n=len(rows)) if rows else tr("소리를 내는 프로그램이 없습니다")))
            except tk.TclError:
                pass

        def load():
            info.set(tr("목록을 가져오는 중..."))
            box["result"] = None

            def work():
                box["result"] = voice.list_sessions()
            threading.Thread(target=work, name="voice-sessions", daemon=True).start()
            dlg.after(150, fill)

        tree.bind("<Double-1>", pick)
        bf = ttk.Frame(dlg)
        bf.pack(fill="x", padx=10, pady=8)
        ttk.Button(bf, text=tr("선택"), command=pick).pack(side="left")
        ttk.Button(bf, text=tr("새로고침"), command=load).pack(side="left", padx=6)
        ttk.Button(bf, text=tr("닫기"), command=dlg.destroy).pack(side="right")
        load()

    # ------------------------------------------------------------------ installing / removing Whisper
    def _inst_busy(self):
        return self._inst_job is not None

    def _inst_sizes_async(self):
        def work():
            self._inst_sizes = {"venv": vinst.dir_size(vinst.VENV), "models": vinst.models_size(), "legacy": vinst.legacy_models_size()}
        threading.Thread(target=work, name="voice-sizes", daemon=True).start()

    def _inst_refresh(self):
        """The status line and the buttons follow what is installed (and are off while something is running)."""
        st = vinst.state()
        self._inst_state = st
        busy = self._inst_busy()
        for w in self.voice_inst_btns.winfo_children():
            w.destroy()

        def btn(text, cmd, enabled=True):
            b = ttk.Button(self.voice_inst_btns, text=text, command=cmd)
            b.pack(side="left", padx=(0, 6))
            if busy or not enabled:
                b.state(["disabled"])
        gb = lambda k: f"{vinst.SIZE_GB[k]:g}"
        nv = vinst.has_nvidia()
        note = ""
        if st in ("none", "broken"):
            self.voice_inst_status.set(tr("설치 안 됨 - 소리를 글자로 바꾸는 Whisper를 이 PC에 설치해야 합니다.") if st == "none"
                                       else tr("설치가 끝나지 않은 상태입니다. 다시 설치하세요."))
            btn(tr("CPU용 설치하기 (약 {gb}GB)", gb=gb("cpu")), lambda: self._inst_start("cpu"))
            btn(tr("GPU용 설치하기 (약 {gb}GB)", gb=gb("gpu")), lambda: self._inst_start("gpu"), enabled=nv)
            note = tr("CPU용: 어느 PC에서나 됩니다 (느림). GPU용: NVIDIA 그래픽카드에서 빠릅니다.")
            if not nv:
                note += " " + tr("NVIDIA 그래픽카드를 찾지 못해 GPU용은 쓸 수 없습니다.")
        else:
            size = self._inst_sizes.get("venv")
            what = tr("설치됨 (GPU용)") if st == "gpu" else tr("설치됨 (CPU용)")
            self.voice_inst_status.set(what + (" · " + tr("디스크 {size}", size=vinst.fmt_gb(size)) if size else ""))
            if st == "cpu":
                btn(tr("GPU 지원 추가하기 (약 {gb}GB)", gb=gb("gpu_extra")), lambda: self._inst_start("gpu_extra"), enabled=nv)
                btn(tr("삭제하기 (CPU용)"), self._inst_remove_all)
                if not nv:
                    note = tr("NVIDIA 그래픽카드를 찾지 못해 GPU 지원은 추가할 수 없습니다.")
            else:
                btn(tr("GPU 지원만 삭제하기 (CPU용으로 되돌림)"), self._inst_remove_gpu)
                btn(tr("전체 삭제하기 (GPU용)"), self._inst_remove_all)
        legacy = self._inst_sizes.get("legacy")
        if legacy:
            note = (note + "\n" if note else "") + tr("이전에 받은 모델이 허깅페이스 기본 폴더에 {size} 남아 있습니다 ({path}). 이 프로그램은 그 폴더를 건드리지 않으니, 필요 없으면 직접 지우세요.",
                                                    size=vinst.fmt_gb(legacy), path=vinst.legacy_cache())
        self.voice_inst_note.configure(text=note)
        msize = self._inst_sizes.get("models")
        if st in ("cpu", "gpu") and msize:
            self.voice_inst_models_cb.configure(text=tr("삭제할 때 내려받은 모델 파일도 함께 지우기 ({size})", size=vinst.fmt_gb(msize)))
            if not self.voice_inst_models_cb.winfo_manager():
                self.voice_inst_models_cb.pack(anchor="w")
        elif self.voice_inst_models_cb.winfo_manager():
            self.voice_inst_models_cb.pack_forget()
        for w in (self.voice_inst_prog, self.voice_inst_step_lbl):
            if busy and not w.winfo_manager():
                w.pack(anchor="w", pady=2)
            elif not busy and w.winfo_manager():
                w.pack_forget()
        if busy:
            self.voice_inst_bar.start(12)
        else:
            self.voice_inst_bar.stop()
        if voice.installed():
            self.voice_notinst_lbl.grid_remove()
        else:
            self.voice_notinst_lbl.grid()

    def _inst_begin(self, job, op):
        self._inst_job, self._inst_op = job, op
        self.app._voice_inst_job, self.app._voice_inst_op = job, op
        self.voice_inst_result.pack_forget()
        self.voice_inst_step.set("")
        self._inst_refresh()

    def _inst_start(self, kind):
        if self._inst_busy():
            return
        python, why = vinst.pick_python()
        if not python:
            messagebox.showerror(tr("음성 인식 설치"), why, parent=self.win)
            return
        what = {"cpu": tr("Whisper (CPU용)"), "gpu": tr("Whisper (GPU용)"), "gpu_extra": tr("GPU 지원 (CUDA 라이브러리)")}[kind]
        if not messagebox.askyesno(tr("음성 인식 설치"), tr("{what}를 설치합니다.\n\n내려받을 양: 약 {gb}GB (인터넷 연결 필요)\n모든 파일은 이 폴더 안에만 저장됩니다: {path}\n\n"
                                                           "처음 음성 인식을 켤 때 모델(약 {model}GB)을 한 번 더 내려받아 {models} 에 저장합니다.\n\n설치에 쓸 파이썬: {python}\n\n계속할까요?",
                                                           what=what, python=python, gb=f"{vinst.SIZE_GB[kind]:g}", path=voice.DIR,
                                                           model=f"{vinst.SIZE_GB['model']:g}", models=vinst.MODELS), parent=self.win):
            return
        self.app.voice.stop()
        if vinst.state() == "broken":
            ok, msg = vinst.remove_all()
            if not ok:
                messagebox.showerror(tr("음성 인식 설치"), msg, parent=self.win)
                return
        job = vinst.Job(vinst.plan(kind, python), self._inst_events, clean_on_fail=kind in ("cpu", "gpu"))
        self._inst_begin(job, kind)
        job.start()

    def _inst_remove_gpu(self):
        if self._inst_busy():
            return
        if not messagebox.askyesno(tr("음성 인식 설치"), tr("GPU 지원(CUDA 라이브러리)을 지웁니다. CPU용으로는 계속 쓸 수 있습니다.\n\n계속할까요?"), parent=self.win):
            return
        self.app.voice.stop()
        job = vinst.Job(vinst.remove_gpu_steps(), self._inst_events)
        self._inst_begin(job, "remove_gpu")
        job.start()

    def _inst_remove_all(self):
        if self._inst_busy():
            return
        with_models = bool(self.v["voice_inst_models"].get()) and bool(self._inst_sizes.get("models"))
        models = (tr("모델 파일({size})도 함께 지웁니다.", size=vinst.fmt_gb(self._inst_sizes["models"])) if with_models
                  else tr("내려받은 모델 파일은 그대로 둡니다."))
        if not messagebox.askyesno(tr("음성 인식 설치"), tr("음성 인식(Whisper)을 지웁니다.\n\n지우는 위치: {path}\n{models}\n나중에 다시 설치할 수 있습니다.\n\n계속할까요?",
                                                           path=vinst.VENV, models=models), parent=self.win):
            return
        self.app.voice.stop()
        ev = self._inst_events

        def work():
            ok, msg = vinst.remove_all()
            if ok and with_models:
                ok2, _freed = vinst.remove_models()
                if not ok2:
                    ok, msg = False, tr("모델 파일 일부를 지우지 못했습니다.")
            ev("done", (ok, msg))
        job = type("Job", (), {"cancel": lambda self: None})()                 # nothing to cancel: it is quick
        self._inst_begin(job, "remove_all")
        self.voice_inst_step.set(tr("지우는 중..."))
        threading.Thread(target=work, name="voice-remove", daemon=True).start()

    def _inst_cancel(self):
        if self._inst_job is not None:
            self._inst_job.cancel()

    def _inst_poll(self):
        if not self.alive():
            return
        try:
            for kind, payload in self._inst_events.drain():
                if kind == "step":
                    self.voice_inst_step.set(payload)
                elif kind == "detail":
                    self.voice_inst_step.set(payload)
                elif kind == "done":
                    ok, msg = payload
                    op = getattr(self.app, "_voice_inst_op", "")
                    self._inst_job = self.app._voice_inst_job = None
                    self._inst_sizes = {"venv": None, "models": None}
                    self._inst_sizes_async()
                    if ok:
                        text = (tr("✓ 지웠습니다.") if op in ("remove_gpu", "remove_all")
                                else tr("✓ 설치했습니다. 위의 '지금 켜기'로 시작하세요. 처음에는 모델을 내려받느라 시간이 걸립니다."))
                        self.voice_inst_result.configure(text=text, fg="#2e8b57")
                    else:
                        self.voice_inst_result.configure(text="✗ " + msg, fg="#c0392b")
                    self.voice_inst_result.pack(anchor="w", pady=2)
                    self._inst_refresh()
            if self._inst_sizes.get("venv") is not None and self._inst_state in ("cpu", "gpu") and not self.voice_inst_status.get().count("·"):
                self._inst_refresh()                               # the disk size was just measured
        except tk.TclError:
            return
        self.win.after(300, self._inst_poll)

    def _res_tick(self):
        """Once a second, while this window is open and the Whisper recognition runs: what it costs (the reading is taken in a
        thread, the labels are set here)."""
        if not self.alive():
            if not self._res_busy:
                self._res_meter.close()
            return
        vm = self.app.voice
        pid = vm.proc.pid if (vm.running() and (self.app.cfg.get("voice_engine") or "whisper") == "whisper") else None
        now = time.monotonic()
        res, self._res_result = self._res_result, None
        if pid != self._res_pid:                                     # started, stopped or restarted: start counting anew
            self._res_pid = pid
            self._res_cpu.clear()
            self._res_gpu.clear()
            res = None
            self._res_meter = resmeter.ResourceMeter() if pid else self._res_meter
        dev_text, dev_warn = voice.describe_device(vm.engine_info, pid is not None)
        self.voice_res["dev"].configure(text=dev_text, foreground="#b45f00" if dev_warn else "#000000")
        if pid is None:
            for lbl in self.voice_res.values():
                if lbl is not self.voice_res["dev"]:
                    lbl.configure(text="-")
        else:
            if res is not None:
                self._res_cpu.add(res.cpu, now)
                self._res_gpu.add(res.gpu, now)
                pct = lambda w: (tr("{avg} (최대 {max})", avg=resmeter.fmt_pct(w.avg()), max=resmeter.fmt_pct(w.max()))
                                 if w.avg() is not None else tr("측정할 수 없음"))
                self.voice_res["cpu"].configure(text=pct(self._res_cpu))
                self.voice_res["ram"].configure(text=resmeter.fmt_bytes(res.ram) if res.ram is not None else tr("측정할 수 없음"))
                gpu_t, vram_t = voice.gpu_lines(vm.gpu_info, pct(self._res_gpu) if self._res_gpu.avg() is not None else "", res.vram, time.monotonic())
                self.voice_res["gpu"].configure(text=gpu_t)
                self.voice_res["vram"].configure(text=vram_t)
                if (vm.engine_info or {}).get("device") == "cpu":              # it runs on the processor: the card is not used
                    self.voice_res["gpu"].configure(text=tr("사용 안 함 (CPU로 동작 중)"))
                    self.voice_res["vram"].configure(text=tr("사용 안 함 (CPU로 동작 중)"))
            if not self._res_busy:
                self._res_busy = True
                meter = self._res_meter

                def work():
                    try:
                        self._res_result = meter.sample(pid, {vm.child_pid})
                    finally:
                        self._res_busy = False
                threading.Thread(target=work, name="res-meter", daemon=True).start()
        self.win.after(1000, self._res_tick)

    def _voice_engine_picked(self):
        label = self.voice_engine_label.get()
        for k, t in self._voice_engine_labels.items():
            if t == label:
                self.v["voice_engine"].set(k)
        self._voice_engine_apply()

    def _voice_engine_apply(self):
        """Opens the group of the chosen method and folds the other; the notes that depend on the method follow."""
        v = self.v
        eng = v["voice_engine"].get()
        self.voice_fold_whisper.set_open(eng == "whisper")
        self.voice_fold_openai.set_open(eng == "openai")
        if eng == "openai":
            if v["voice_mode"].get() == "live":
                v["voice_mode"].set("sentence")
            self.voice_live_rb.state(["disabled"])
            self.voice_mode_note.configure(text=tr("이 방식에는 실시간 모드가 없습니다 (문장마다 서버에 한 번씩 요청합니다). "
                                                   "긴 말은 아래 '최대 길이'에서 끊어 인식합니다."))
            url = v["voice_oa_url"].get().strip()
            if not url:
                text, color = tr("서버 주소를 입력하세요."), "#b45f00"
            elif voice.is_local_url(url):
                text, color = tr("이 PC나 같은 네트워크의 서버입니다: 음성이 {host} 로 전송됩니다.", host=voice.url_host(url)), "#555555"
            else:
                text, color = tr("⚠ 외부 서버입니다: 음성이 인터넷을 통해 {host} 로 전송됩니다.", host=voice.url_host(url)), "#c0392b"
            self.voice_privacy.configure(text=text, foreground=color)
        else:
            self.voice_live_rb.state(["!disabled"])
            self.voice_mode_note.configure(text=tr("실시간 모드는 Whisper에서는 권장하지 않습니다. Whisper는 스트리밍 모델이 아니라서 문장을 계속 처음부터 다시 "
                                                   "인식하므로 그래픽카드 부담이 늘고 끝부분 글자가 계속 바뀝니다. 번역은 어느 모드든 문장이 끝난 뒤에 한 번만 합니다."))
            self.voice_privacy.configure(text=tr("이 PC 안에서만 인식합니다 (소리가 밖으로 나가지 않습니다)."), foreground="#2e8b57")

    def _voice_check(self):
        """Connection test: a second of silence goes to the server (in a thread: the answer can take a while)."""
        try:
            cfg = dict(self.app.cfg, **self._collect_voice(), voice_engine="openai")
        except (ValueError, tk.TclError):
            messagebox.showerror(tr("음성 인식"), tr("숫자 값이 올바르지 않습니다."), parent=self.win)
            return
        self.v["voice_check"].set(tr("시험하는 중..."))
        self.voice_check_lbl.configure(fg="#777777")
        self._voice_check_result = None

        def work():
            self._voice_check_result = voice.check_connection(cfg)
        threading.Thread(target=work, name="voice-check", daemon=True).start()

    def _voice_tick(self):
        """Keeps the state and the button of the voice tab current while the options window is open (they follow the real state,
        also when it is switched with the button in the title bar)."""
        if not self.alive():
            return
        model = self.app.vmodel
        state, _bars, code, vals = model.snapshot(time.monotonic())
        if state == "off":
            text, color, btn = tr("○ 꺼져 있음"), "#777777", tr("▶ 지금 켜기")
        elif state == "loading":
            text, color, btn = tr("◐ 준비 중 - 모델을 불러오는 중..."), "#b45f00", tr("■ 지금 끄기")
        elif state == "idle":
            text, color, btn = tr("● 켜짐 - 연결됨 (지금은 소리 없음)"), "#2e8b57", tr("■ 지금 끄기")
        elif state == "active":
            text, color, btn = tr("● 켜짐 - 소리가 들어오는 중"), "#2e8b57", tr("■ 지금 끄기")
        else:
            msg = tr("설치되어 있지 않음") if code == "not_installed" else (voice.explain_error(vals.get("msg") or "") or code)
            text, color, btn = tr("⚠ 오류: {msg}", msg=msg), "#c0392b", tr("▶ 지금 켜기")
        self.v["voice_status"].set(text)
        self.v["voice_btn"].set(btn)
        self.voice_lbl.configure(fg=color)
        res, self._voice_check_result = self._voice_check_result, None
        if res is not None:
            self.v["voice_check"].set(("✓ " if res[0] else "✗ ") + res[1])
            self.voice_check_lbl.configure(fg="#2e8b57" if res[0] else "#c0392b")
        self.win.after(500, self._voice_tick)

    def _voice_button(self):
        """Switch now. What is set in the tab (language, program ...) is used for this start, saved or not; the 'start with the
        program' check is left alone until Save."""
        try:
            vals = self._collect_voice()
        except (ValueError, tk.TclError):
            messagebox.showerror(tr("음성 인식"), tr("숫자 값이 올바르지 않습니다."), parent=self.win)
            return
        vals.pop("voice_enabled", None)
        self.app.cfg.update(vals)
        self.app._voice_toggle()

    def _collect_voice(self):
        v = self.v
        try:
            end_ms = max(300, min(2000, int(v["voice_end_ms"].get())))
        except (ValueError, tk.TclError):
            raise ValueError(tr("숫자 값이 올바르지 않습니다.")) from None
        target = self._voice_target_key()
        app = v["voice_app"].get().strip()
        if app and not app.lower().endswith(".exe"):
            app += ".exe"
        return {"voice_enabled": bool(v["voice_enabled"].get()), "voice_target": target, "voice_app": app,
                "voice_lang": v["voice_lang"].get().strip() or "auto", "voice_mode": v["voice_mode"].get(),
                "voice_end_ms": end_ms,
                "voice_device": v["voice_device"].get(), "voice_model": v["voice_model"].get().strip(),
                "voice_max_s": max(3, min(30, int(v["voice_max_s"].get()))), "voice_engine": v["voice_engine"].get(),
                "voice_oa_url": v["voice_oa_url"].get().strip(), "voice_oa_key": v["voice_oa_key"].get().strip(),
                "voice_oa_model": v["voice_oa_model"].get().strip(), "voice_oa_format": v["voice_oa_format"].get(),
                "voice_oa_timeout": max(2, min(300, int(v["voice_oa_timeout"].get())))}

    def _tab_send(self, nb):
        tab = self._tab_frame(nb, tr("보내기"))
        v = self.v
        ttk.Checkbutton(tab, text=tr("보내기 번역 사용 (단축키 → 입력줄 → 번역을 클립보드로)"),
                        variable=v["send_enabled"]).grid(row=0, column=0, columnspan=3, sticky="w", **PAD)
        ttk.Label(tab, text=tr("보내는 언어")).grid(row=1, column=0, sticky="w", **PAD)
        lr = ttk.Frame(tab)
        lr.grid(row=1, column=1, columnspan=2, sticky="w", **PAD)
        ttk.Combobox(lr, textvariable=v["send_lang"], values=LANGS, width=14).pack(side="left")
        ttk.Label(lr, text=tr("번역 방식")).pack(side="left", padx=(12, 4))
        ttk.Combobox(lr, textvariable=v["send_route"], values=list(self._send_route_labels().values()), state="readonly",
                     width=28).pack(side="left")
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
        self.send_prompt_note = ttk.Label(tab, foreground="#b45f00", wraplength=420, justify="left")
        self.send_prompt_note.grid(row=8, column=1, columnspan=2, sticky="w", **PAD)
        self.send_prompt_text.bind("<KeyRelease>", lambda e: self._send_note_update(), add="+")
        self._send_note_update()

        # --- the user's own additional instructions for what they send (kept when the default prompt is updated)
        ttk.Separator(tab).grid(row=9, column=0, columnspan=3, sticky="we", padx=6, pady=(4, 2))
        ttk.Label(tab, text=tr("추가 지시 (내가 보내는 말의 말투 등. 비워 두면 사용하지 않습니다)"),
                  font=("Malgun Gothic", 9, "bold")).grid(row=10, column=0, columnspan=3, sticky="w", **PAD)
        ttk.Label(tab, text=tr("위의 기본 프롬프트는 그대로 두고, 여기에 적은 내용만 프롬프트 맨 끝에 덧붙입니다. 보내는 번역에만 적용되며 "
                               "받은 채팅의 번역 설정과는 별개입니다. 모델이 더 잘 따르도록 영어로 쓰는 것을 권합니다. "
                               "번역이 이상해지면 이 칸을 비워 보세요."),
                  foreground="#666", wraplength=430, justify="left").grid(row=11, column=0, columnspan=3, sticky="w", padx=6)
        self.send_extra_text = tk.Text(tab, width=62, height=3, wrap="word", font=("Malgun Gothic", 9), undo=True)
        self.send_extra_text.grid(row=12, column=0, columnspan=3, sticky="we", padx=6, pady=(2, 2))
        self.send_extra_text.insert("1.0", self.app.cfg.get("send_extra_prompt") or "")
        ttk.Label(tab, text=tr("예시 (영어 문장을 복사해서 위 칸에 붙여 넣으세요):"), foreground="#666").grid(
            row=13, column=0, columnspan=3, sticky="w", padx=6)
        for i, (desc, english) in enumerate(((tr("자연스럽게"), "Use a natural, American-like way of speaking."),
                                              (tr("존댓말로"), "Write in a polite, formal tone, like talking to a stranger."),
                                              (tr("반말로 짧게"), "Write casually and keep it short."),
                                              (tr("해적 말투로"), "Always write the message in the style of a pirate."))):
            ttk.Label(tab, text=desc, foreground="#666").grid(row=14 + i, column=0, sticky="w", padx=6)
            ex_e = ttk.Entry(tab)                              # read-only: the text can be selected and copied
            ex_e.insert(0, english)
            ex_e.configure(state="readonly")
            ex_e.grid(row=14 + i, column=1, columnspan=2, sticky="we", padx=(0, 6), pady=1)

    def _reset_send_prompt(self):
        self.send_prompt_text.delete("1.0", "end")
        self.send_prompt_text.insert("1.0", translator.DEFAULT_SEND_PROMPT)
        self._send_note_update()

    def _send_note_update(self):
        cur = self.send_prompt_text.get("1.0", "end-1c").strip()
        self.send_prompt_note.configure(text="" if cur in ("", translator.DEFAULT_SEND_PROMPT.strip()) else self._newer_text())

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
        ttk.Checkbutton(tab, text=tr("번역 요청 전문(프롬프트 포함)을 로그에 기록 - 확인용. 켜 두면 로그가 빨리 커집니다"),
                        variable=self.v["log_request"]).pack(anchor="w", padx=8, pady=(0, 2))
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
        self._set_enabled(self.custom_widgets, mode == "custom")
        self._set_enabled(self.test_widgets, mode != "none")
        if mode != self._fold_mode:                    # a new translation method: fold away what it does not use
            self._fold_mode = mode
            show = {"openai": ("openai", "prompt", "glossary"), "google": ("google", "glossary"),
                    "custom": ("custom", "glossary")}.get(mode, ())
            for key, fold in self.folds.items():
                fold.set_open(key in show)

    def apply_custom_preset(self):
        v = self.v
        name = v["custom_preset"].get()
        p = translator.CUSTOM_PRESETS.get(name)
        if not p:                                       # "manual": keep what is typed
            v["custom_note"].set("")
            return
        url, headers, btype, body, path, note = p
        v["custom_url"].set(url)
        v["custom_headers"].set(headers)
        v["custom_body_type"].set(btype)
        self.custom_body.delete("1.0", "end")
        self.custom_body.insert("1.0", body)
        v["custom_path"].set(path)
        v["custom_note"].set(tr(note) if note else "")

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
        self._prompt_note_update()

    @staticmethod
    def _newer_text():
        return tr("지금 프롬프트는 프로그램에 들어 있는 최신 기본 프롬프트와 다릅니다. 기본 프롬프트는 계속 개선되고 있어서, "
                  "직접 고치신 게 아니라면 '기본 프롬프트로 되돌리기'로 최신 버전을 받는 것을 권장합니다.")

    def _prompt_note_update(self):
        """Tell the user when the prompt in the box is not the latest official default (which keeps getting better)."""
        cur = self.prompt.get("1.0", "end-1c").strip()
        self.prompt_note.configure(text="" if cur in ("", translator.DEFAULT_PROMPT.strip()) else self._newer_text())

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
        preset = v["custom_preset"].get()
        custom = {
            "custom_preset": preset if preset in translator.CUSTOM_PRESETS else "",
            "custom_key": v["custom_key"].get().strip(),
            "custom_url": v["custom_url"].get().strip(),
            "custom_headers": v["custom_headers"].get().strip() or "{}",
            "custom_body_type": "form" if v["custom_body_type"].get() == "form" else "json",
            "custom_body": self.custom_body.get("1.0", "end-1c").strip(),
            "custom_path": v["custom_path"].get().strip(),
        }
        routes_now = set(self._collect_routes().values()) | {self._send_route_key()}
        if self._mode() == "custom" or translator.ROUTE_CUSTOM in routes_now:
            translator.custom_check(custom)             # ValueError with a message for the user
        return dict(custom, **{
            "disable_reasoning": bool(v["disable_reasoning"].get()),
            "reasoning_off_body": v["reasoning_off_body"].get().strip() or translator.DEFAULT_REASONING_OFF,
            "translator": self._mode(),
            "target_lang": v["target_lang"].get().strip() or "한국어",
            "api_url": v["api_url"].get().strip(),
            "api_model": v["api_model"].get().strip(),
            "api_key": v["api_key"].get(),
            "google_api_key": v["google_api_key"].get().strip(),
            "translate_test_start": bool(v["translate_test_start"].get()),
            "log_request": bool(v["log_request"].get()),
            "temperature": max(0.0, min(2.0, temp)),
            "timeout": max(2.0, min(300.0, timeout)),
            "skip_same_lang": bool(v["skip_same_lang"].get()),
            "skip_regex": skip_regex,
            "skip_regex_hide": bool(v["skip_regex_hide"].get()),
            "glossary_file": v["glossary_file"].get().strip() or glossary.DEFAULT_NAME,
            "glossary_google": bool(v["glossary_google"].get()),
            "glossary_mode": glossary.mode({"glossary_mode": v["glossary_mode"].get()}),
            "glossary_style": {tr(label): key for key, label in glossary.GLOSSARY_STYLES.items()}.get(
                v["glossary_style"].get(), "paren"),
            "prompt": self.prompt.get("1.0", "end-1c").strip() or translator.DEFAULT_PROMPT,
            "extra_prompt": self.extra_prompt.get("1.0", "end-1c").strip(),
        })

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

    def select_voice(self):
        """Brings the voice recognition tab to the front (a click on the indicator)."""
        try:
            for i, t in enumerate(self.nb.tabs()):
                if self.nb.tab(t, "text") == tr("음성 인식"):
                    self.nb.select(i)
        except tk.TclError:
            pass

    def _apply_voice(self, old, new):
        """Save: a running voice recognition is restarted when a setting of it was changed. Switching on / off is not done here:
        that is the button of this tab / the title bar, and the 'start with the program' check only counts at the next start."""
        vm = self.app.voice
        try:
            if vm.running() and any(old.get(k) != new[k] for k in new if k not in ("voice_translate", "voice_enabled")):
                vm.restart()
        except Exception:
            logging.getLogger("cmr.options").exception("음성 인식 적용 실패")

    def save(self):
        app, cfg, v = self.app, self.app.cfg, self.v
        try:
            new = self.collect_translation()
            font_size = max(8, min(32, int(v["font_size"].get())))
            poll_hz = max(5, min(60, int(v["poll_hz"].get())))
            full_scan = max(5, min(600, int(v["full_scan_sec"].get())))
            max_lines = max(50, min(5000, int(v["max_lines"].get())))
            fade_sec = max(0, min(3600, int(v["fade_sec"].get())))
            line_spacing = max(0, min(40, int(v["line_spacing"].get())))
            group_spacing = max(0, min(60, int(v["group_spacing"].get())))
            trans_size = int(v["trans_font_size"].get())
            trans_size = 0 if trans_size < 8 else min(32, trans_size)
            new_voice = self._collect_voice()
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
        cfg.update(new)
        cfg.update(hover_clear=bool(v["hover_clear"].get()), blur_experiment=bool(v["blur_experiment"].get()),
                   blur_state=4 if v["blur_kind"].get() == tr("진하게 (아크릴)") else 3)
        cfg.update(send_enabled=bool(v["send_enabled"].get()),
                   send_lang=v["send_lang"].get().strip() or "English", send_route=self._send_route_key(), send_hotkey=hotkey,
                   send_autopaste=bool(v["send_autopaste"].get()), send_show_log=bool(v["send_show_log"].get()),
                   send_prompt="" if sprompt == translator.DEFAULT_SEND_PROMPT.strip() else sprompt,
                   send_extra_prompt=self.send_extra_text.get("1.0", "end-1c").strip())
        old_voice = {k: cfg.get(k) for k in new_voice}
        cfg.update(new_voice)
        cfg.update(check_updates=bool(v["check_updates"].get()), channel_route=self._collect_routes())
        cfg.update(shadow_on=bool(v["shadow_on"].get()), shadow_color=shadow_color, shadow_dx=sdx, shadow_dy=sdy)
        cfg.update(exit_with_game=bool(v["exit_with_game"].get()), swap_trans=bool(v["swap_trans"].get()), font_family=(v["font_family"].get() if v["font_family"].get() in app.custom_fonts else ""), font_size=font_size, poll_hz=poll_hz, full_scan_sec=full_scan, max_lines=max_lines, fade_sec=fade_sec,
                   line_spacing=line_spacing, group_spacing=group_spacing, trans_font_size=trans_size, trans_color=trans_color,
                   show_time=bool(v["show_time"].get()), channel_detail=bool(v["channel_detail"].get()),
                   class_colors=bool(v["class_colors"].get()))
        app.apply_window_settings()
        self._collect_windows()
        app.sync_children()
        config.save(cfg)
        self._apply_voice(old_voice, new_voice)
        app.worker.research()
        logging.getLogger("cmr.options").info(
            "설정 저장 | 번역=%s | 목표=%s | url=%s | 모델=%s | 추론끄기=%s | 배경/글자 투명도=%s/%s",
            cfg["translator"], cfg["target_lang"], cfg["api_url"], cfg["api_model"] or "(기본)",
            cfg["disable_reasoning"], cfg["bg_opacity"], cfg["text_opacity"])
        app.add_system(tr("설정 저장됨 - 번역: {tr_name}, 목표 언어: {lang}",
                         tr_name=tr(TRANSLATOR_LABELS[cfg["translator"]]), lang=cfg["target_lang"]))
        self.win.destroy()
