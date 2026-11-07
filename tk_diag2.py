"""macOS window test, part 2: remove the leftover title bar and check the menu bar item.   Run:  .venv/bin/python tk_diag2.py
~40 seconds. Look at the screen and tell me what you saw."""
import sys
import tkinter as tk

root = tk.Tk()
root.title("CM-DIAG2")
root.geometry("520x160+300+200")
root.configure(bg="#1e1f22")
var = tk.StringVar(value="starting ...")
tk.Label(root, text="TOP-LEFT MARK ▶", fg="yellow", bg="#1e1f22", anchor="nw").place(x=0, y=0)
tk.Label(root, textvariable=var, fg="white", bg="#1e1f22", font=("Helvetica", 15), justify="left").pack(fill="both", expand=True, pady=(22, 0))
print("Tk", root.tk.call("info", "patchlevel"))
results = []


def note(name, ok, extra=""):
    line = f"[{'OK ' if ok else 'FAIL'}] {name} {extra}"
    results.append(line)
    print(line)


def nswindow():
    import AppKit
    for w in AppKit.NSApp.windows():
        if str(w.title()) == "CM-DIAG2":
            return w
    return None


def step1():
    var.set("1/3  no title bar\n(the grey strip on top should become invisible;\nthe yellow mark must stay readable)")
    try:
        import AppKit
        w = nswindow()
        print("   style mask before:", int(w.styleMask()), "| frame:", w.frame())
        mask = (AppKit.NSWindowStyleMaskTitled | AppKit.NSWindowStyleMaskFullSizeContentView
                | AppKit.NSWindowStyleMaskResizable)
        w.setStyleMask_(mask)
        w.setTitlebarAppearsTransparent_(True)
        w.setTitleVisibility_(AppKit.NSWindowTitleHidden)
        for b in (AppKit.NSWindowCloseButton, AppKit.NSWindowMiniaturizeButton, AppKit.NSWindowZoomButton):
            btn = w.standardWindowButton_(b)
            if btn is not None:
                btn.setHidden_(True)
        w.setMovableByWindowBackground_(False)
        print("   style mask after:", int(w.styleMask()), "| frame:", w.frame())
        note("title bar hidden (transparent + no buttons)", True)
    except Exception as e:
        note("title bar hidden", False, repr(e))
    root.after(9000, step2)


def step2():
    var.set("2/3  fully borderless style (mask 0)\n(no strip at all; may not accept keyboard)")
    try:
        import AppKit
        w = nswindow()
        w.setStyleMask_(AppKit.NSWindowStyleMaskBorderless)
        note("borderless style mask", True, f"-> {int(w.styleMask())}  canBecomeKey={w.canBecomeKeyWindow()}")
    except Exception as e:
        note("borderless style mask", False, repr(e))
    root.after(9000, step3)


class _Keep:
    pass


def step3():
    var.set("3/3  menu bar item: look at the TOP of the screen\nfor a small \"CM\" (next to the clock/wifi icons)")
    try:
        import AppKit
        import objc
        bar = AppKit.NSStatusBar.systemStatusBar()
        item = bar.statusItemWithLength_(AppKit.NSVariableStatusItemLength)
        item.setVisible_(True)
        btn = item.button()
        btn.setTitle_("CM")
        menu = AppKit.NSMenu.alloc().init()
        menu.addItemWithTitle_action_keyEquivalent_("(test menu item)", None, "")
        item.setMenu_(menu)
        root._item = item
        win = btn.window()
        fr = win.frame() if win is not None else None
        note("menu bar item created", True, f"visible={item.isVisible()} button window frame={fr}")
        screen = AppKit.NSScreen.mainScreen().frame()
        print("   main screen frame:", screen)
    except Exception as e:
        note("menu bar item", False, repr(e))
    root.after(14000, finish)


def finish():
    print("\n--- summary ---")
    print("\n".join(results))
    print("Done. Paste everything above and tell me what you saw (title strip? yellow mark? menu bar 'CM'?).")
    root.destroy()


root.after(1500, step1)
root.mainloop()
