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

/// A tip or a menu of size (w, h) for the point (px, py). (gx, gy): the distance to the point, to the right and below it (a menu: 0, 0: its corner is at the
/// point). Without room on the right it goes to the left of the point, without room below it above the point (the same distances), and it is then kept inside.
pub fn at_point(area: Area, px: i32, py: i32, w: i32, h: i32, gx: i32, gy: i32) -> (i32, i32) {
    let mut x = px + gx;
    if x + w > area.x + area.w {
        x = px - gx - w;
    }
    let mut y = py + gy;
    if y + h > area.y + area.h {
        y = py - gy - h;
    }
    inside(area, x, y, w, h)
}

/// A tip about something that has a rectangle (l, t, r, b), a widget: centred above it, `gap` away; without room above (in THIS monitor) below it.
pub fn above_anchor(area: Area, l: i32, t: i32, r: i32, b: i32, w: i32, h: i32, gap: i32) -> (i32, i32) {
    let x = (l + r) / 2 - w / 2;
    let mut y = t - gap - h;
    if y < area.y {
        y = b + gap;
    }
    inside(area, x, y, w, h)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAIN: Area = Area { x: 0, y: 0, w: 1920, h: 1040 };           // (a taskbar of 40 at the bottom is not in the area)
    const UPPER: Area = Area { x: 0, y: -1040, w: 1920, h: 1040 };       // a second monitor above the main one
    const RIGHT: Area = Area { x: 1920, y: 0, w: 1920, h: 1080 };

    #[test]
    fn a_tip_goes_right_and_below_the_cursor() {
        assert_eq!(at_point(MAIN, 500, 400, 200, 80, 12, 16), (512, 416));
    }

    #[test]
    fn no_room_on_the_right_or_below_flips_it() {
        assert_eq!(at_point(MAIN, 1800, 400, 200, 80, 12, 16), (1588, 416));          // left of the cursor
        assert_eq!(at_point(MAIN, 500, 1000, 200, 80, 12, 16), (512, 904));           // above the cursor
        assert_eq!(at_point(MAIN, 1800, 1000, 200, 80, 12, 16), (1588, 904));         // both
    }

    #[test]
    fn a_menu_has_its_corner_at_the_cursor_and_flips_like_a_tip() {
        assert_eq!(at_point(MAIN, 100, 100, 150, 160, 0, 0), (100, 100));
        assert_eq!(at_point(MAIN, 1900, 1000, 150, 160, 0, 0), (1750, 840));
    }

    #[test]
    fn it_never_leaves_the_area() {
        let (x, y) = at_point(MAIN, 5, 5, 3000, 2000, 12, 16);                         // bigger than the monitor: at its top left
        assert_eq!((x, y), (0, 0));
        let (x, y) = at_point(RIGHT, 1925, 1075, 300, 100, 12, 16);                    // a monitor that does not start at 0
        assert!(x >= RIGHT.x && x + 300 <= RIGHT.x + RIGHT.w && y >= RIGHT.y && y + 100 <= RIGHT.y + RIGHT.h, "{x} {y}");
    }

    #[test]
    fn the_tip_of_a_widget_at_the_top_of_the_main_monitor_does_not_go_to_the_monitor_above() {
        // the widget is at the very top of the main monitor; the area is the main monitor: there is no room above: below the widget
        let (x, y) = above_anchor(MAIN, 900, 4, 1000, 24, 160, 40, 6);
        assert_eq!((x, y), (870, 30));
        // with room above it is above, centred
        assert_eq!(above_anchor(MAIN, 900, 500, 1000, 520, 160, 40, 6), (870, 454));
        // the monitor above is a different area: a widget there gets its tip there
        let (_, y) = above_anchor(UPPER, 900, -1030, 1000, -1010, 160, 40, 6);
        assert!(y >= UPPER.y, "{y}");
    }

    #[test]
    fn the_tip_of_a_widget_at_the_edge_is_moved_in() {
        assert_eq!(above_anchor(MAIN, 0, 500, 40, 520, 160, 40, 6).0, 0);
        assert_eq!(above_anchor(MAIN, 1880, 500, 1920, 520, 160, 40, 6).0, 1760);
        assert!(above_anchor(MAIN, 900, 1010, 1000, 1030, 160, 40, 6).1 + 40 <= MAIN.y + MAIN.h);
    }
}
