use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use zellij_tile::prelude::*;

use crate::state::NotificationType;
use crate::State;

// Provide FFI stub so tests can link on native target. Also counts calls so tests
// can assert the plugin issued a rename (rename_tab routes through this stub).
static HOST_COMMAND_CALLS: AtomicUsize = AtomicUsize::new(0);
#[no_mangle]
pub extern "C" fn host_run_plugin_command() {
    HOST_COMMAND_CALLS.fetch_add(1, Ordering::SeqCst);
}

fn make_tab(position: usize, name: &str, active: bool) -> TabInfo {
    TabInfo {
        position,
        name: name.to_string(),
        active,
        ..Default::default()
    }
}

fn make_pane(id: u32, is_plugin: bool, is_focused: bool) -> PaneInfo {
    PaneInfo {
        id,
        is_plugin,
        is_focused,
        ..Default::default()
    }
}

fn make_manifest(tab_panes: Vec<(usize, Vec<PaneInfo>)>) -> PaneManifest {
    let mut panes = HashMap::new();
    for (pos, p) in tab_panes {
        panes.insert(pos, p);
    }
    PaneManifest { panes }
}

fn add_notification(state: &mut State, pane_id: u32, ntype: NotificationType) {
    let mut set = HashSet::new();
    set.insert(ntype);
    state.notification_state.insert(pane_id, set);
}

#[test]
fn test_strip_icons() {
    let state = State::default();
    assert_eq!(state.strip_icons("Tab 1 ⏳"), "Tab 1");
    assert_eq!(state.strip_icons("Tab 1 ✅"), "Tab 1");
    assert_eq!(state.strip_icons("Tab 1 ⏳ ⏳"), "Tab 1");
    assert_eq!(state.strip_icons("Tab 1"), "Tab 1");
    assert_eq!(state.strip_icons(""), "");
}

#[test]
fn test_tab_name_has_icon() {
    let state = State::default();
    assert!(state.tab_name_has_icon("Tab 1 ⏳"));
    assert!(state.tab_name_has_icon("Tab 1 ✅"));
    assert!(!state.tab_name_has_icon("Tab 1"));
    assert!(!state.tab_name_has_icon("⏳ Tab 1")); // icon not at end
}

#[test]
fn test_clean_stale_notifications_removes_old_pane_ids() {
    let mut state = State::default();
    add_notification(&mut state, 99, NotificationType::Waiting);
    state.panes = make_manifest(vec![(0, vec![make_pane(1, false, true)])]);

    assert!(state.clean_stale_notifications());
    assert!(state.notification_state.is_empty());
}

#[test]
fn test_clean_stale_skipped_when_panes_empty() {
    let mut state = State::default();
    add_notification(&mut state, 99, NotificationType::Waiting);

    assert!(!state.clean_stale_notifications());
    assert!(!state.notification_state.is_empty());
}

#[test]
fn test_get_tab_notification_state_skips_plugin_panes() {
    let mut state = State::default();
    state.panes = make_manifest(vec![
        (0, vec![
            make_pane(1, true, false),  // plugin pane
            make_pane(2, false, true),  // terminal pane
        ]),
    ]);
    add_notification(&mut state, 1, NotificationType::Waiting);

    assert_eq!(state.get_tab_notification_state(0), None);

    add_notification(&mut state, 2, NotificationType::Completed);
    assert_eq!(state.get_tab_notification_state(0), Some(NotificationType::Completed));
}

#[test]
fn test_check_and_clear_focus() {
    let mut state = State::default();
    // Tab name must have icon for focus-clear to proceed (reorder safety)
    state.tabs = vec![make_tab(0, "Tab 1 ⏳", true)];
    state.panes = make_manifest(vec![
        (0, vec![make_pane(5, false, true)]),
    ]);
    add_notification(&mut state, 5, NotificationType::Waiting);

    assert!(state.check_and_clear_focus());
    assert!(state.notification_state.is_empty());
}

#[test]
fn test_clear_focus_uses_active_tab_not_focused_flag() {
    // Regression: clear-on-focus must key off the ACTIVE TAB, not the is_focused flag.
    // On a tab switch the is_focused flag lags the active-tab change (separate events),
    // so a focused-pane lookup misses and the icon gets stuck in the tab you're in.
    // Here pane 5 is in the active tab but is_focused=false (stale) — it must still clear.
    let mut state = State::default();
    state.tabs = vec![make_tab(0, "Tab 1 ⏳", true)];
    state.panes = make_manifest(vec![(0, vec![make_pane(5, false, false)])]);
    add_notification(&mut state, 5, NotificationType::Waiting);

    assert!(state.check_and_clear_focus());
    assert!(state.notification_state.is_empty());
}

#[test]
fn test_check_and_clear_focus_skips_without_icon() {
    let mut state = State::default();
    // Tab name has no icon — don't clear (protects against reorder race)
    state.tabs = vec![make_tab(0, "Tab 1", true)];
    state.panes = make_manifest(vec![
        (0, vec![make_pane(5, false, true)]),
    ]);
    add_notification(&mut state, 5, NotificationType::Waiting);

    assert!(!state.check_and_clear_focus());
    assert!(!state.notification_state.is_empty());
}

#[test]
fn test_tab_reorder_skips_mismatched_tab_name() {
    let mut state = State::default();

    // Beta at pos 1 has notification, recorded as tab "Beta"
    state.tabs = vec![
        make_tab(0, "Alpha", false),
        make_tab(1, "Beta ⏳", false),
        make_tab(2, "Gamma", true),
    ];
    state.panes = make_manifest(vec![
        (0, vec![make_pane(1, false, false)]),
        (1, vec![make_pane(2, false, false)]),
        (2, vec![make_pane(3, false, true)]),
    ]);
    add_notification(&mut state, 2, NotificationType::Waiting);
    state.notified_tab_names.insert(2, "Beta".to_string());

    // After reorder: pane 2 is now at pos 2 but tab at pos 2 is "Tab #4"
    state.panes = make_manifest(vec![
        (0, vec![make_pane(1, false, false)]),
        (1, vec![make_pane(4, false, false)]),
        (2, vec![make_pane(2, false, false)]),  // Beta's pane at Tab #4's position
        (3, vec![make_pane(3, false, true)]),
    ]);
    state.tabs = vec![
        make_tab(0, "Alpha", false),
        make_tab(1, "Beta ⏳", false),  // stale tab data
        make_tab(2, "Tab #4", true),
        make_tab(3, "Gamma", false),
    ];

    // Pane 2 is at pos 2 but tab is "Tab #4", not "Beta" — should skip
    assert_eq!(state.get_tab_notification_state(2), None);

    // After data stabilizes: pane 2 at pos 2, tab "Beta" at pos 2
    state.tabs = vec![
        make_tab(0, "Alpha", false),
        make_tab(1, "Tab #4", true),
        make_tab(2, "Beta ⏳", false),
        make_tab(3, "Gamma", false),
    ];

    // Now tab name matches — notification should be found
    assert_eq!(state.get_tab_notification_state(2), Some(NotificationType::Waiting));
}

#[test]
fn test_stale_icon_not_stripped_when_notification_expects_tab() {
    let mut state = State::default();

    // "Beta ⏳" at pos 1, notification expects tab "Beta"
    state.tabs = vec![
        make_tab(0, "Alpha", false),
        make_tab(1, "Beta ⏳", false),
    ];
    state.panes = make_manifest(vec![
        (0, vec![make_pane(1, false, false)]),
        (1, vec![make_pane(2, false, false)]),
    ]);
    state.notified_tab_names.insert(2, "Beta".to_string());

    // "Beta ⏳" has icon but notification expects "Beta" — don't strip
    let base = state.strip_icons("Beta ⏳");
    assert!(state.notified_tab_names.values().any(|name| name == &base));
}

#[test]
fn test_stuck_icon_stripped_after_focus_clear() {
    // Regression: a "done" icon added while the pane is focused can get stuck when
    // clear-on-focus removes the notification before the add-rename settles, leaving
    // pending_renames set forever (it's only removed when the tab has no icon). The
    // plugin must issue a strip-rename once it sees an icon with no matching
    // notification, so the icon doesn't linger past the next tab event.
    let mut state = State::default();
    state.tabs = vec![make_tab(0, "Tab 1", true)];
    state.panes = make_manifest(vec![(0, vec![make_pane(5, false, true)])]);
    HOST_COMMAND_CALLS.store(0, Ordering::SeqCst);

    // (1) "done" arrives -> add-rename issued ("Tab 1" -> "Tab 1 ✅")
    add_notification(&mut state, 5, NotificationType::Completed);
    state.update_tab_names();
    assert_eq!(HOST_COMMAND_CALLS.load(Ordering::SeqCst), 1);
    assert!(state.pending_renames.contains(&0));

    // (2) Zellij settles the rename: tab now shows the icon
    state.tabs = vec![make_tab(0, "Tab 1 ✅", true)];

    // (3) User is in the tab -> clear-on-focus removes the notification
    assert!(state.check_and_clear_focus());
    assert!(state.notification_state.is_empty());

    // (4) Re-run: the stale icon must be stripped (exactly one strip-rename issued).
    //     Without the fix, zero renames are issued and pending_renames gets stuck.
    HOST_COMMAND_CALLS.store(0, Ordering::SeqCst);
    state.update_tab_names();
    assert_eq!(
        HOST_COMMAND_CALLS.load(Ordering::SeqCst),
        1,
        "stale icon with no notification should trigger a strip rename"
    );

    // (5) Strip settles -> pending_renames fully cleared, no icon remains
    state.tabs = vec![make_tab(0, "Tab 1", true)];
    state.update_tab_names();
    assert!(!state.pending_renames.contains(&0));
    assert!(!state.tab_name_has_icon(&state.tabs[0].name));
}

#[cfg(test)]
mod radar_tests {
    use crate::radar;
    use crate::state::NotificationType;

    #[test]
    fn parses_radar_pending() {
        let payload = r#"{"pane":{"type":"terminal","id":12},"status":"pending"}"#;
        assert_eq!(radar::parse_radar_payload(payload), Some((12, NotificationType::Waiting)));
    }

    #[test]
    fn parses_radar_error() {
        let payload = r#"{"pane":{"type":"terminal","id":12},"status":"error"}"#;
        assert_eq!(radar::parse_radar_payload(payload), Some((12, NotificationType::Waiting)));
    }

    #[test]
    fn parses_radar_done() {
        let payload = r#"{"pane":{"type":"terminal","id":12},"status":"done"}"#;
        assert_eq!(radar::parse_radar_payload(payload), Some((12, NotificationType::Completed)));
    }

    #[test]
    fn ignores_radar_running() {
        let payload = r#"{"pane":{"type":"terminal","id":12},"status":"running"}"#;
        assert_eq!(radar::parse_radar_payload(payload), None);
    }

    #[test]
    fn ignores_radar_idle() {
        let payload = r#"{"pane":{"type":"terminal","id":12},"status":"idle"}"#;
        assert_eq!(radar::parse_radar_payload(payload), None);
    }

    #[test]
    fn rejects_malformed_json() {
        assert_eq!(radar::parse_radar_payload("not json"), None);
    }

    #[test]
    fn handles_extra_fields() {
        let payload = r#"{"v":1,"source":"cursor","pane":{"type":"terminal","id":7},"status":"pending","repo":"foo","branch":"main","msg":"hello","task":"fix"}"#;
        assert_eq!(radar::parse_radar_payload(payload), Some((7, NotificationType::Waiting)));
    }

    #[test]
    fn handles_missing_pane_defaults_to_zero() {
        let payload = r#"{"status":"done"}"#;
        assert_eq!(radar::parse_radar_payload(payload), Some((0, NotificationType::Completed)));
    }
}
