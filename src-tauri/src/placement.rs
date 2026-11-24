//! Where a menu or a tooltip is put on a screen. Numbers only (no Tauri in here), so it can be tested alone: `rustc --test --edition 2021 placement.rs`.
//!
//! `area` is the usable part (without the taskbar) of the ONE monitor the thing belongs to: the monitor of the cursor, or of the middle of the
//! widget the tip is about. Nothing ever leaves it, so a tip about something on the main monitor never shows up on the monitor above or beside it.
//! The rules are the ones the game uses: right of and below the cursor; no room on the right: left of it; no room below: above it.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// The send box for a window (top t, bottom b, left l; `bar`: the height of its bar, above t), as wide as it, `gap` away from it. It is at the left of the window exactly: it is the window's, it has no edge of its
/// own to stop at (a window that is half on another monitor has its box half on it too). Up and down it stays in `home`, the usable part of the monitor of the window. `mode`: "below" / "above" = always there;
/// anything else ("auto"): under the window, else above it, else ON it, at its top over its bar (a window as high as the monitor: the newest lines are at the bottom of a window, they stay in view).
pub fn send_box(home: Area, mode: &str, l: i32, t: i32, b: i32, w: i32, h: i32, gap: i32, bar: i32) -> (i32, i32) {
    let below = b + gap;
    let above = t - gap - h;
    let y = match mode {
        "below" => below,
        "above" => above,
        _ => {
            if below + h <= home.y + home.h { below } else if above >= home.y { above } else { t - bar }
        }
    };
    let _ = w;
    (l, y.min(home.y + home.h - h).max(home.y))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAIN: Area = Area { x: 0, y: 0, w: 1920, h: 1040 };           // (a taskbar of 40 at the bottom is not in the area)
    const UPPER: Area = Area { x: 0, y: -1040, w: 1920, h: 1040 };       // a second monitor above the main one
    const BAR: i32 = 22;

    fn one(mode: &str, l: i32, t: i32, b: i32, w: i32) -> (i32, i32) { send_box(MAIN, mode, l, t, b, w, 46, 2, BAR) }

    #[test]
    fn the_send_box_is_under_the_window_when_there_is_room() {
        assert_eq!(one("auto", 100, 400, 700, 600), (100, 702));
    }

    #[test]
    fn the_send_box_goes_above_a_window_at_the_bottom_of_the_screen() {
        // the window ends at the bottom of the usable area (the taskbar is below): under it would be cut off
        assert_eq!(one("auto", 100, 700, 1040, 600), (100, 652));
        // under it there are only 20 pixels: still not enough
        assert_eq!(one("auto", 100, 700, 1020, 600), (100, 652));
        // exactly enough room under it: stays under it
        assert_eq!(one("auto", 100, 700, 992, 600), (100, 994));
    }

    #[test]
    fn the_send_box_stays_at_the_left_of_its_window_wherever_that_is() {
        // a window that sticks out to the right (or to the left) of the monitor: the box is at its left edge all the same
        assert_eq!(one("auto", 1700, 400, 700, 600), (1700, 702));
        assert_eq!(one("auto", -300, 400, 700, 600), (-300, 702));
        // a window on the monitor above: the box is in that monitor
        let (x, y) = send_box(UPPER, "auto", 100, -400, -20, 600, 46, 2, BAR);
        assert!(y >= UPPER.y && y + 46 <= UPPER.y + UPPER.h && x == 100, "{x} {y}");
    }

    #[test]
    fn a_window_as_high_as_the_screen_gets_the_box_on_it_at_the_top() {
        // no room under it, none above it: on the window, over its bar (the bar is the 22 above the text area)
        assert_eq!(one("auto", 0, 22, 1040, 600), (0, 0));
        // half of the screen (left half, full height): the same
        assert_eq!(one("auto", 0, 22, 1040, 960), (0, 0));
        // a window that is low on the screen but has room above it: above it
        assert_eq!(one("auto", 300, 200, 1040, 600).1, 152);
        // never off the screen: a window whose top is at the top of the screen (a flipped bar): brought in
        let (_, y) = one("auto", 0, 0, 1040, 600);
        assert!(y >= MAIN.y && y + 46 <= MAIN.y + MAIN.h, "{y}");
    }

    #[test]
    fn the_send_box_can_be_told_where_to_be() {
        assert_eq!(one("above", 100, 400, 700, 600), (100, 352));        // above although there is room under
        assert_eq!(one("below", 100, 400, 700, 600), (100, 702));
        // "below" at the bottom of the screen is kept on the screen (it then overlaps the window), "above" at the top of it likewise
        assert_eq!(one("below", 100, 700, 1040, 600).1, 994);
        assert_eq!(one("above", 100, 10, 300, 600).1, 0);
        assert_eq!(one("something else", 100, 400, 700, 600), (100, 702));       // an unknown word is "auto"
    }
}
