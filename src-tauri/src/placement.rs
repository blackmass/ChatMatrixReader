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

/// The send box for a window (top t, bottom b, left l), as wide as it, `gap` away from it. `mode`: "below" / "above" = always there; anything else ("auto"):
/// under the window, and above it when under it the box would be cut off (the edge of the screen, the taskbar). Whatever is chosen, the box is kept inside the
/// monitor (area); only a window as high as the screen leaves no room and the box then overlaps it.
pub fn send_box(area: Area, mode: &str, l: i32, t: i32, b: i32, w: i32, h: i32, gap: i32) -> (i32, i32) {
    let below = b + gap;
    let above = t - gap - h;
    let y = match mode {
        "below" => below,
        "above" => above,
        _ => {
            if below + h <= area.y + area.h { below } else if above >= area.y { above } else if area.y + area.h - below > above - area.y { below } else { above }
        }
    };
    inside(area, l, y, w, h)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAIN: Area = Area { x: 0, y: 0, w: 1920, h: 1040 };           // (a taskbar of 40 at the bottom is not in the area)
    const UPPER: Area = Area { x: 0, y: -1040, w: 1920, h: 1040 };       // a second monitor above the main one
    const RIGHT: Area = Area { x: 1920, y: 0, w: 1920, h: 1080 };

    #[test]
    fn the_send_box_is_under_the_window_when_there_is_room() {
        assert_eq!(send_box(MAIN, "auto", 100, 400, 700, 600, 46, 2), (100, 702));
    }

    #[test]
    fn the_send_box_goes_above_a_window_at_the_bottom_of_the_screen() {
        // the window ends at the bottom of the usable area (the taskbar is below): under it would be cut off
        assert_eq!(send_box(MAIN, "auto", 100, 700, 1040, 600, 46, 2), (100, 652));
        // under it there are only 20 pixels: still not enough
        assert_eq!(send_box(MAIN, "auto", 100, 700, 1020, 600, 46, 2), (100, 652));
        // exactly enough room under it: stays under it
        assert_eq!(send_box(MAIN, "auto", 100, 700, 992, 600, 46, 2), (100, 994));
    }

    #[test]
    fn the_send_box_uses_the_monitor_of_the_window_and_stays_in_it() {
        // a window at the bottom of the upper monitor: above it, not under it on the main monitor
        let (x, y) = send_box(UPPER, "auto", 100, -400, 0, 600, 46, 2);
        assert!(y + 46 <= UPPER.y + UPPER.h && y >= UPPER.y, "{y}");
        assert_eq!(x, 100);
        // a window that sticks out to the right: the box is moved in
        assert_eq!(send_box(MAIN, "auto", 1700, 400, 700, 600, 46, 2).0, 1320);
    }

    #[test]
    fn a_window_as_high_as_the_screen_leaves_no_room_and_the_box_stays_on_the_screen() {
        let (_, y) = send_box(MAIN, "auto", 0, 0, 1040, 600, 46, 2);
        assert!(y >= MAIN.y && y + 46 <= MAIN.y + MAIN.h, "{y}");
    }

    #[test]
    fn the_send_box_can_be_told_where_to_be() {
        assert_eq!(send_box(MAIN, "above", 100, 400, 700, 600, 46, 2), (100, 352));        // above although there is room under
        assert_eq!(send_box(MAIN, "below", 100, 400, 700, 600, 46, 2), (100, 702));
        // "below" at the bottom of the screen is kept on the screen (it then overlaps the window), "above" at the top of it likewise
        let (_, y) = send_box(MAIN, "below", 100, 700, 1040, 600, 46, 2);
        assert_eq!(y, 994);
        let (_, y) = send_box(MAIN, "above", 100, 10, 300, 600, 46, 2);
        assert_eq!(y, 0);
        assert_eq!(send_box(MAIN, "something else", 100, 400, 700, 600, 46, 2), (100, 702));       // an unknown word is "auto"
    }

}
