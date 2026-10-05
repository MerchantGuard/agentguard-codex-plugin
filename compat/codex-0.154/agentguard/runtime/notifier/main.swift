import AppKit
import UserNotifications

// AgentGuard notifier. A small macOS app the plugin builds from this file on the person's own Mac
// (runtime/notifier/build.cjs), because only an app bundle can post a notification with its own
// icon and buttons. It does one thing: show one AgentGuard STOP notification, and when a button is
// pressed write that choice to the state file the plugin passed in. It makes no network request
// and reads nothing but its own arguments.
//
//   agentguard-notifier --title T --subtitle S --body B --state /path/notify-state.json
//
// Launched by macOS for a button press, it has no arguments: it handles the press and quits.
final class Delegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    let args = CommandLine.arguments
    func value(_ flag: String) -> String? {
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        // The first action shows as a button; macOS puts the rest under Options.
        let actions = [("mute10", "Mute 10 minutes"), ("mute5", "Mute 5 minutes"), ("mute30", "Mute 30 minutes"), ("mute60", "Mute 1 hour")]
            .map { UNNotificationAction(identifier: $0.0, title: $0.1, options: []) }
            + [UNNotificationAction(identifier: "off", title: "Turn off AgentGuard alerts", options: [.destructive])]
        center.setNotificationCategories([UNNotificationCategory(identifier: "agentguard.stop", actions: actions, intentIdentifiers: [], options: [])])
        guard let title = value("--title") else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 15) { NSApp.terminate(nil) }
            return
        }
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { DispatchQueue.main.async { NSApp.terminate(nil) }; return }
            let content = UNMutableNotificationContent()
            content.title = title
            if let subtitle = self.value("--subtitle") { content.subtitle = subtitle }
            content.body = self.value("--body") ?? ""
            content.categoryIdentifier = "agentguard.stop"
            content.threadIdentifier = "agentguard"
            content.sound = .default
            content.userInfo = ["state": self.value("--state") ?? ""]
            // One identifier: a new STOP replaces the last notification instead of stacking another.
            let request = UNNotificationRequest(identifier: "agentguard-stop", content: content, trigger: nil)
            center.add(request) { _ in
                // Stay briefly so an immediate press is handled here; macOS relaunches the app for later ones.
                DispatchQueue.main.asyncAfter(deadline: .now() + 120) { NSApp.terminate(nil) }
            }
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let state = response.notification.request.content.userInfo["state"] as? String ?? ""
        let now = Date().timeIntervalSince1970
        let minutes: [String: Double] = ["mute5": 5, "mute10": 10, "mute30": 30, "mute60": 60]
        var choice: [String: Any]? = nil
        if let m = minutes[response.actionIdentifier] { choice = ["muteUntil": now + m * 60, "chosenAt": now] }
        if response.actionIdentifier == "off" { choice = ["off": true, "chosenAt": now] }
        if let choice = choice, !state.isEmpty {
            // Keep the plugin's own fields (lastShownAt, skipped) and add the choice.
            var merged: [String: Any] = [:]
            if let data = FileManager.default.contents(atPath: state),
               let existing = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { merged = existing }
            for (k, v) in choice { merged[k] = v }
            if let data = try? JSONSerialization.data(withJSONObject: merged) {
                try? data.write(to: URL(fileURLWithPath: state), options: .atomic)
            }
        }
        completionHandler()
        DispatchQueue.main.async { NSApp.terminate(nil) }
    }
}

let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.run()
