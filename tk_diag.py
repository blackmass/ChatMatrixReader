"""macOS window test: which window tricks work with this Python / Tk?   Run:   .venv/bin/python tk_diag.py
It opens a small window for about 25 seconds, tries several things one after another and prints what happened.
Look at the screen while it runs and tell me what you SAW (the text in the window tells you what to look at)."""
import sys
import tkinter as tk

print("Python", sys.version.split()[0], "| Tk", tk.TkVersion)

root = tk.Tk()
print("Tk patchlevel:", root.tk.call("info", "patchlevel"), "| windowing system:", root.tk.call("tk", "windowingsystem"))
root.title("CM-DIAG-WINDOW")
root.geometry("460x150+300+200")
var = tk.StringVar(value="starting ...")
lab = tk.Label(root, textvariable=var, fg="white", bg="#1e1f22", font=("Helvetica", 15), justify="left")
lab.pack(fill="both", expand=True)

results = []


def note(name, ok, extra=""):
    line = f"[{'OK ' if ok else 'FAIL'}] {name} {extra}"
    results.append(line)
    print(line)


def nswindow():
    import AppKit
    for w in AppKit.NSApp.windows():
        if str(w.title()) == "CM-DIAG-WINDOW":
            return w
    return None


def step1():
    var.set("1/6  borderless window\n(the title bar should disappear)")
    try:
        root.tk.call("::tk::unsupported::MacWindowStyle", "style", root._w, "plain", "none")
        note("borderless (MacWindowStyle plain none)", True)
    except Exception as e:
        note("borderless (MacWindowStyle)", False, repr(e))
        try:
            root.overrideredirect(True)
            note("borderless (overrideredirect)", True)
        except Exception as e2:
            note("borderless (overrideredirect)", False, repr(e2))
    root.after(4000, step2)


def step2():
    var.set("2/6  transparent background\n(the dark box should vanish, only this text stays)")
    try:
        root.attributes("-transparent", True)
        root.config(bg="systemTransparent")
        lab.config(bg="systemTransparent")
        note("per-pixel transparency (-transparent)", True)
    except Exception as e:
        note("per-pixel transparency", False, repr(e))
    root.after(4000, step3)


def step3():
    var.set("3/6  half see-through (alpha 0.5)\n(the whole window should look faded)")
    try:
        root.attributes("-alpha", 0.5)
        note("alpha", True, f"-> {root.attributes('-alpha')}")
    except Exception as e:
        note("alpha", False, repr(e))
    root.after(4000, step4)


def step4():
    var.set("4/6  always on top: open another app now\n(this text should stay above it)")
    try:
        root.attributes("-alpha", 0.9)
        root.attributes("-topmost", True)
        note("topmost", True, f"-> {root.attributes('-topmost')}")
    except Exception as e:
        note("topmost", False, repr(e))
    try:
        w = nswindow()
        note("find NSWindow by title (pyobjc)", w is not None, f"level={w.level() if w else '-'}")
    except Exception as e:
        note("find NSWindow (pyobjc)", False, repr(e))
    root.after(6000, step5)


def step5():
    var.set("5/6  click-through: click on this text\n(the click should go to the window behind)")
    try:
        w = nswindow()
        w.setIgnoresMouseEvents_(True)
        note("click-through (setIgnoresMouseEvents)", True)
    except Exception as e:
        note("click-through", False, repr(e))
    root.after(6000, step6)


def step6():
    var.set("6/6  menu bar item\n(look at the top right of the screen)")
    try:
        import AppKit
        item = AppKit.NSStatusBar.systemStatusBar().statusItemWithLength_(AppKit.NSVariableStatusItemLength)
        item.button().setTitle_("CM")
        note("menu bar item (NSStatusItem)", True)
        root._item = item
    except Exception as e:
        note("menu bar item", False, repr(e))
    try:
        import AppKit
        ok = AppKit.NSApp.setActivationPolicy_(AppKit.NSApplicationActivationPolicyAccessory)
        note("hide Dock icon (accessory app)", bool(ok))
    except Exception as e:
        note("hide Dock icon", False, repr(e))
    try:
        import Quartz
        wins = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID)
        names = sorted({str(w.get("kCGWindowOwnerName", "")) for w in wins if w.get("kCGWindowOwnerName")})
        wow = [n for n in names if "warcraft" in n.lower() or n.lower().startswith("wow")]
        note("list other apps' windows (for finding WoW)", True, f"WoW-like owners: {wow or 'none open'}; all: {names[:12]}")
    except Exception as e:
        note("list other apps' windows", False, repr(e))
    root.after(5000, finish)


def finish():
    print("\n--- summary ---")
    print("\n".join(results))
    print("Done. Paste everything above and tell me what you saw in each step.")
    root.destroy()


root.after(1500, step1)
root.mainloop()
