import AppKit
import Foundation

struct RouteRecord: Decodable {
  struct Decision: Decodable {
    let effort: String
    let planEffort: String?
    let promptSnippet: String?
    let source: String?
  }

  let timestamp: String?
  let cwd: String?
  let prompt: String?
  let decision: Decision
}

final class RouteMenubarController: NSObject, NSApplicationDelegate {
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let menu = NSMenu()
  private var timer: Timer?
  private var watchedPaths: [String] = []
  private var lastSignature = ""
  private var promptTitleItem: NSMenuItem!
  private var effortItem: NSMenuItem!
  private var sourceItem: NSMenuItem!
  private var pathItem: NSMenuItem!

  init(paths: [String]) {
    self.watchedPaths = paths
    super.init()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)

    if let button = statusItem.button {
      button.title = "CRR --"
      button.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .semibold)
      button.toolTip = "Codex reasoning route"
    }

    promptTitleItem = NSMenuItem(title: "Waiting for route…", action: nil, keyEquivalent: "")
    promptTitleItem.isEnabled = false
    effortItem = NSMenuItem(title: "Effort: --", action: nil, keyEquivalent: "")
    effortItem.isEnabled = false
    sourceItem = NSMenuItem(title: "Source: --", action: nil, keyEquivalent: "")
    sourceItem.isEnabled = false
    pathItem = NSMenuItem(title: "State file: --", action: nil, keyEquivalent: "")
    pathItem.isEnabled = false

    menu.addItem(promptTitleItem)
    menu.addItem(NSMenuItem.separator())
    menu.addItem(effortItem)
    menu.addItem(sourceItem)
    menu.addItem(pathItem)
    menu.addItem(NSMenuItem.separator())

    let refreshItem = NSMenuItem(title: "Refresh", action: #selector(refreshNow), keyEquivalent: "r")
    refreshItem.target = self
    menu.addItem(refreshItem)

    let quitItem = NSMenuItem(title: "Quit", action: #selector(quitApp), keyEquivalent: "q")
    quitItem.target = self
    menu.addItem(quitItem)

    statusItem.menu = menu

    refreshNow()
    timer = Timer.scheduledTimer(timeInterval: 0.7, target: self, selector: #selector(refreshNow), userInfo: nil, repeats: true)
  }

  @objc private func refreshNow() {
    guard let best = latestRouteFile() else {
      setFallbackTitle()
      return
    }

    do {
      let data = try Data(contentsOf: URL(fileURLWithPath: best.path))
      let record = try JSONDecoder().decode(RouteRecord.self, from: data)
      let signature = "\(best.path)|\(best.modified.timeIntervalSince1970)"

      let effort = record.decision.effort.uppercased()
      let source = record.decision.source ?? "unknown"
      let prompt = record.decision.promptSnippet ?? record.prompt ?? "No prompt"
      let cwd = record.cwd ?? URL(fileURLWithPath: best.path).deletingLastPathComponent().path

      if let button = statusItem.button {
        button.title = "CRR \(effort)"
        button.toolTip = prompt
      }

      promptTitleItem.title = truncate("Prompt: \(prompt)", max: 72)
      effortItem.title = "Effort: \(record.decision.effort)"
      sourceItem.title = "Source: \(source)"
      pathItem.title = truncate("State file: \(cwd)", max: 72)

      if signature != lastSignature {
        lastSignature = signature
        showNotification(effort: record.decision.effort, prompt: prompt)
      }
    } catch {
      setFallbackTitle()
    }
  }

  private func latestRouteFile() -> (path: String, modified: Date)? {
    var candidates: [(String, Date)] = []

    for path in watchedPaths {
      let expanded = NSString(string: path).expandingTildeInPath
      if let attrs = try? FileManager.default.attributesOfItem(atPath: expanded),
         let modified = attrs[.modificationDate] as? Date {
        candidates.append((expanded, modified))
      }
    }

    return candidates.max(by: { $0.1 < $1.1 })
  }

  private func setFallbackTitle() {
    if let button = statusItem.button {
      button.title = "CRR --"
      button.toolTip = "Waiting for codex-reasoning-router route data"
    }
    promptTitleItem.title = "Waiting for route…"
    effortItem.title = "Effort: --"
    sourceItem.title = "Source: --"
    pathItem.title = "State file: --"
  }

  private func truncate(_ value: String, max: Int) -> String {
    if value.count <= max {
      return value
    }
    let index = value.index(value.startIndex, offsetBy: max - 1)
    return "\(value[..<index])…"
  }

  private func showNotification(effort: String, prompt: String) {
    let notification = NSUserNotification()
    notification.title = "Codex route: \(effort)"
    notification.informativeText = truncate(prompt, max: 120)
    NSUserNotificationCenter.default.deliver(notification)
  }

  @objc private func quitApp() {
    NSApp.terminate(nil)
  }
}

let arguments = Array(CommandLine.arguments.dropFirst())
var paths: [String] = []
var index = 0

while index < arguments.count {
  let arg = arguments[index]
  if arg == "--path", index + 1 < arguments.count {
    paths.append(arguments[index + 1])
    index += 2
    continue
  }
  index += 1
}

if paths.isEmpty {
  let cwd = FileManager.default.currentDirectoryPath
  paths = [
    "\(cwd)/.codex/state/codex-reasoning-router-last-route.json",
    "\(NSHomeDirectory())/.codex/state/codex-reasoning-router-last-route.json"
  ]
}

let app = NSApplication.shared
let delegate = RouteMenubarController(paths: paths)
app.delegate = delegate
app.run()
