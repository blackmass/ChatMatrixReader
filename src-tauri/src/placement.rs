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

/// The rectangle (x, y, w, h) moved, if need be, until it lies inside `area` (when it is bigger than the area, it sits at the top left).
fn inside(area: Area, x: i32, y: i32, w: i32, h: i32) -> (i32, i32) {
    (x.min(area.x + area.w - w).max(area.x), y.min(area.y + area.h - h).max(area.y))
}

/// Is the rectangle wholly on the usable part of the screens, all the monitors together? Points along its top and its bottom side are looked at (the areas of monitors that stand beside each other have no
/// gap between them, so a box that lies over both is on the screens).
fn on_screens(areas: &[Area], x: i32, y: i32, w: i32, h: i32) -> bool {
    let at = |px: i32, py: i32| areas.iter().any(|a| px >= a.x && px < a.x + a.w && py >= a.y && py < a.y + a.h);
    (0..=8).all(|i| { let px = x + (w - 1) * i / 8; at(px, y) && at(px, y + h - 1) })
}

/// The send box for a window (top t, bottom b, left l; `bar`: the height of its bar, above t), as wide as it, `gap` away from it. It stays at the left of the window exactly (it is the window's: it has no
/// edge of its own to stop at). `mode`: "below" / "above" = always there; anything else ("auto"): under the window, else above it, else ON it, at its top, over its bar (the window is as high as the screen:
/// full screen, half of the screen; the newest lines are at the bottom of a window, they stay in view). A place is "there" when the box lies wholly on the screens (all the monitors together, without the task
/// bar): so it follows the window over the border of two monitors without stopping. What is not on the screens is brought into `home`, the monitor of the window.
pub fn send_box(areas: &[Area], home: Area, mode: &str, l: i32, t: i32, b: i32, w: i32, h: i32, gap: i32, bar: i32) -> (i32, i32) {
    let below = b + gap;
    let above = t - gap - h;
    let y = match mode {
        "below" => below,
        "above" => above,
        _ => {
            if on_screens(areas, l, below, w, h) { below } else if on_screens(areas, l, above, w, h) { above } else { t - bar }
        }
    };
    if on_screens(areas, l, y, w, h) { (l, y) } else { inside(home, l, y, w, h) }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAIN: Area = Area { x: 0, y: 0, w: 1920, h: 1040 };           // (a taskbar of 40 at the bottom is not in the area)
    const UPPER: Area = Area { x: 0, y: -1040, w: 1920, h: 1040 };       // a second monitor above the main one
    const RIGHT: Area = Area { x: 1920, y: 0, w: 1920, h: 1080 };
    const BAR: i32 = 22;

    fn one(mode: &str, l: i32, t: i32, b: i32, w: i32) -> (i32, i32) { send_box(&[MAIN], MAIN, mode, l, t, b, w, 46, 2, BAR) }

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
    fn the_send_box_follows_the_window_over_the_border_of_two_monitors() {
        let areas = [MAIN, RIGHT];
        // a window that sticks out to the right onto the next monitor: the box stays at its left edge, as wide as it, over both
        assert_eq!(send_box(&areas, MAIN, "auto", 1700, 400, 700, 600, 46, 2, BAR), (1700, 702));
        // the window is on the monitor above: under it is the main monitor, that is on the screens as well
        let areas = [UPPER, MAIN];
        assert_eq!(send_box(&areas, UPPER, "auto", 100, -400, -20, 600, 46, 2, BAR), (100, -18));
        // a window beside the main monitor at the bottom: above it
        assert_eq!(send_box(&[MAIN, RIGHT], RIGHT, "auto", 2000, 900, 1080, 600, 46, 2, BAR), (2000, 852));
    }

    #[test]
    fn a_window_as_high_as_the_screen_gets_the_box_on_it_at_the_top() {
        // no room under it, none above it: on the window, over its bar (the bar is the 22 above the text area)
        assert_eq!(one("auto", 0, 22, 1040, 600), (0, 0));
        assert_eq!(one("auto", 300, 200, 1040, 600).1, 152);                       // (a window that is low on the screen but has room above it: above it, as before)
        // half of the screen (left half, full height): the same
        assert_eq!(send_box(&[MAIN, RIGHT], MAIN, "auto", 0, 22, 1040, 960, 46, 2, BAR), (0, 0));
        // never off the screen: a window whose top is at the top of the screen with its bar above it (flipped bar): brought in
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

    #[test]
    fn what_is_off_every_screen_is_brought_into_the_monitor_of_the_window() {
        // a window far off to the left: the box is brought in
        let (x, _) = one("auto", -2000, 400, 700, 600);
        assert_eq!(x, 0);
        // no screens known: nothing moves it out of the monitor given
        let (x, y) = send_box(&[], MAIN, "auto", 100, 400, 700, 600, 46, 2, BAR);
        assert!(x >= 0 && y >= 0);
    }

}
