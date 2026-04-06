import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit
import UserNotifications
import Vision

struct RouteRecord: Decodable {
  struct Decision: Decodable {
    let effort: String
    let planEffort: String?
    let promptSnippet: String?
    let source: String?
  }

  let timestamp: String?
  let updatedAt: String?
  let cwd: String?
  let phase: String?
  let prompt: String?
  let decision: Decision?
  let lastDecision: Decision?
}

struct PreviewState {
  let timestamp: Date
  let prompt: String
  let effort: String?
  let source: String
  let pathLabel: String
  let phase: String
}

struct CodexWindowTarget {
  let windowID: CGWindowID
  let windowBounds: CGRect
  let cropRect: CGRect
}

struct ClassifierRecord: Decodable {
  let effort: String
  let source: String?
}

struct RouterControlRecord: Decodable {
  let routerEnabled: Bool?
  let updatedAt: String?
  let source: String?
}

final class RouteMenubarController: NSObject, NSApplicationDelegate {
  private static let previewDefaultsKey = "codexReasoningRouter.previewEnabled"
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let menu = NSMenu()
  private var timer: Timer?
  private var watchedPaths: [String] = []
  private let cliPath: String
  private let controlPath: String
  private let workspaceRoot: String
  private var lastSignature = ""
  private var promptTitleItem: NSMenuItem!
  private var effortItem: NSMenuItem!
  private var sourceItem: NSMenuItem!
  private var pathItem: NSMenuItem!
  private var routerToggleItem: NSMenuItem!
  private var previewState: PreviewState?
  private var previewPromptFingerprint = ""
  private var lastSendTrigger = Date.distantPast
  private var eventTap: CFMachPort?
  private var eventSource: CFRunLoopSource?
  private var previewToggleItem: NSMenuItem!
  private var previewEnabled = true

  init(paths: [String], cliPath: String) {
    self.watchedPaths = paths
    self.cliPath = cliPath
    self.controlPath = "\(NSHomeDirectory())/.codex/state/codex-reasoning-router-control.json"
    self.workspaceRoot = Self.resolveWorkspaceRoot(from: paths)
    super.init()
    self.previewEnabled = UserDefaults.standard.object(forKey: Self.previewDefaultsKey) as? Bool ?? true
  }

  private static func resolveWorkspaceRoot(from paths: [String]) -> String {
    for watchedPath in paths {
      let expanded = NSString(string: watchedPath).expandingTildeInPath
      if expanded.hasPrefix("\(NSHomeDirectory())/.codex/state/") {
        continue
      }
      if let range = expanded.range(of: "/.codex/state/") {
        return String(expanded[..<range.lowerBound])
      }
    }

    let cwd = FileManager.default.currentDirectoryPath
    return cwd.isEmpty ? NSHomeDirectory() : cwd
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

    routerToggleItem = NSMenuItem(title: "", action: #selector(toggleRouter), keyEquivalent: "")
    routerToggleItem.target = self
    menu.addItem(routerToggleItem)

    previewToggleItem = NSMenuItem(title: "", action: #selector(togglePreview), keyEquivalent: "")
    previewToggleItem.target = self
    previewToggleItem.state = previewEnabled ? .on : .off
    updatePreviewToggleTitle()
    menu.addItem(previewToggleItem)

    let refreshItem = NSMenuItem(title: "Refresh", action: #selector(refreshNow), keyEquivalent: "r")
    refreshItem.target = self
    menu.addItem(refreshItem)

    let quitItem = NSMenuItem(title: "Quit", action: #selector(quitApp), keyEquivalent: "q")
    quitItem.target = self
    menu.addItem(quitItem)

    statusItem.menu = menu

    installSendMonitor()
    refreshNow()
    timer = Timer.scheduledTimer(timeInterval: 0.15, target: self, selector: #selector(refreshNow), userInfo: nil, repeats: true)
  }

  @objc private func refreshNow() {
    let routerEnabled = isRouterEnabled()
    updateRouterToggleTitle(routerEnabled: routerEnabled)

    if !routerEnabled {
      renderPaused()
      return
    }

    let hookState = latestHookState()
    let chosen = preferredState(hookState: hookState, preview: previewState)

    guard let chosen else {
      render(nil)
      return
    }

    render(chosen)
  }

  private func render(_ state: PreviewState?) {
    guard let state else {
      setFallbackTitle()
      return
    }

    let effortTitle = state.phase == "routing"
      ? "..."
      : (state.effort?.uppercased() ?? "--")

    if let button = statusItem.button {
      button.title = "CRR \(effortTitle)"
      button.toolTip = state.prompt
    }

    promptTitleItem.title = truncate("Prompt: \(state.prompt)", max: 72)
    let effortDetail = state.phase == "routing" ? "routing..." : (state.effort ?? "--")
    effortItem.title = "Effort: \(effortDetail)"
    sourceItem.title = "Source: \(state.source)"
    pathItem.title = truncate("State file: \(state.pathLabel)", max: 72)
  }

  private func renderPaused() {
    if let button = statusItem.button {
      button.title = "CRR OFF"
      button.toolTip = "codex-reasoning-router is paused"
    }
    promptTitleItem.title = "Prompt: router paused"
    effortItem.title = "Effort: off"
    sourceItem.title = "Source: paused"
    pathItem.title = truncate("State file: \(controlPath)", max: 72)
  }

  private func preferredState(hookState: PreviewState?, preview: PreviewState?) -> PreviewState? {
    switch (hookState, preview) {
    case let (.some(hook), .some(preview)):
      let previewIsFresh = Date().timeIntervalSince(preview.timestamp) < 15
      if preview.phase == "routing" && previewIsFresh {
        return preview
      }
      return preview.timestamp >= hook.timestamp ? preview : hook
    case let (.some(hook), .none):
      return hook
    case let (.none, .some(preview)):
      return Date().timeIntervalSince(preview.timestamp) < 15 ? preview : nil
    case (.none, .none):
      return nil
    }
  }

  private func latestHookState() -> PreviewState? {
    guard let best = latestRouteFile() else {
      return nil
    }

    do {
      let data = try Data(contentsOf: URL(fileURLWithPath: best.path))
      let record = try JSONDecoder().decode(RouteRecord.self, from: data)
      let signature = "\(best.path)|\(best.modified.timeIntervalSince1970)"
      let resolvedDecision = record.decision ?? record.lastDecision
      let prompt = resolvedDecision?.promptSnippet ?? record.prompt ?? "No prompt"
      let cwd = record.cwd ?? URL(fileURLWithPath: best.path).deletingLastPathComponent().path
      let phase = record.phase ?? "selected"
      let source = resolvedDecision?.source ?? (phase == "routing" ? "routing" : "unknown")

      if signature != lastSignature {
        lastSignature = signature
        if phase != "routing", let finalEffort = resolvedDecision?.effort {
          showNotification(effort: finalEffort, prompt: prompt)
        }
      }

      return PreviewState(
        timestamp: best.modified,
        prompt: prompt,
        effort: resolvedDecision?.effort,
        source: source,
        pathLabel: cwd,
        phase: phase
      )
    } catch {
      return nil
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

  private func installSendMonitor() {
    let mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
    guard let tap = CGEvent.tapCreate(
      tap: .cgSessionEventTap,
      place: .headInsertEventTap,
      options: .listenOnly,
      eventsOfInterest: mask,
      callback: { _, type, event, userInfo in
        guard type == .keyDown else { return Unmanaged.passUnretained(event) }
        guard let userInfo else { return Unmanaged.passUnretained(event) }
        let controller = Unmanaged<RouteMenubarController>.fromOpaque(userInfo).takeUnretainedValue()
        controller.handleKeyDown(event)
        return Unmanaged.passUnretained(event)
      },
      userInfo: Unmanaged.passUnretained(self).toOpaque()
    ) else {
      sourceItem.title = "Source: input monitor unavailable"
      return
    }

    eventTap = tap
    guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
      sourceItem.title = "Source: input monitor unavailable"
      return
    }
    eventSource = source
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
  }

  private func handleKeyDown(_ event: CGEvent) {
    guard isRouterEnabled() else {
      return
    }
    guard previewEnabled else {
      return
    }
    guard frontmostBundleIdentifier() == "com.openai.codex" else {
      return
    }

    let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
    guard keyCode == 36 || keyCode == 76 else {
      return
    }

    let now = Date()
    guard now.timeIntervalSince(lastSendTrigger) > 0.35 else {
      return
    }
    lastSendTrigger = now

    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      self?.captureAndClassifyVisiblePrompt()
    }
  }

  private func captureAndClassifyVisiblePrompt() {
    guard let prompt = captureVisiblePrompt() else {
      return
    }

    let fingerprint = prompt.lowercased()
    guard fingerprint != previewPromptFingerprint || Date().timeIntervalSince(lastSendTrigger) < 2 else {
      return
    }
    previewPromptFingerprint = fingerprint

    let pending = PreviewState(
      timestamp: Date(),
      prompt: prompt,
      effort: nil,
      source: "screen-send-preview",
      pathLabel: workspaceRoot,
      phase: "routing"
    )
    DispatchQueue.main.async { [weak self] in
      self?.previewState = pending
      self?.refreshNow()
    }

    let result = classifyPrompt(prompt)
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      guard let result else {
        self.previewState = nil
        self.refreshNow()
        return
      }
      self.previewState = PreviewState(
        timestamp: Date(),
        prompt: prompt,
        effort: result.effort,
        source: result.source ?? "screen-send-model",
        pathLabel: self.workspaceRoot,
        phase: "selected"
      )
      self.refreshNow()
    }
  }

  private func classifyPrompt(_ prompt: String) -> ClassifierRecord? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.currentDirectoryURL = URL(fileURLWithPath: workspaceRoot)
    process.arguments = ["node", cliPath, "classify", "--cwd", workspaceRoot, "--prompt", prompt, "--json"]

    let stdout = Pipe()
    let stderr = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr

    do {
      try process.run()
      process.waitUntilExit()
      guard process.terminationStatus == 0 else {
        return nil
      }
      let data = stdout.fileHandleForReading.readDataToEndOfFile()
      return try JSONDecoder().decode(ClassifierRecord.self, from: data)
    } catch {
      return nil
    }
  }

  private func captureVisiblePrompt() -> String? {
    guard let target = composerCaptureTarget() else {
      return nil
    }
    guard let image = capturePromptImage(target) else {
      return nil
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do {
      try handler.perform([request])
    } catch {
      return nil
    }

    let ignoredExact = Set([
      "Ask for follow-up changes"
    ])
    let ignoredContains = [
      "GPT-5.4",
      "High",
      "Low",
      "Medium",
      "Extra High",
      "Local",
      "Default permissions",
      "Upgrade",
      "Add Credits",
      "You're out of Codex messages",
      "Your rate limit resets",
      "Pro today."
    ]

    let observations = request.results ?? []
    let promptLines = observations.compactMap { observation -> (Double, String)? in
      guard let candidate = observation.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines),
            !candidate.isEmpty else {
        return nil
      }
      if observation.boundingBox.origin.y < 0.15 {
        return nil
      }
      if ignoredExact.contains(candidate) {
        return nil
      }
      if ignoredContains.contains(where: { candidate.localizedCaseInsensitiveContains($0) }) {
        return nil
      }
      return (Double(observation.boundingBox.origin.y), candidate)
    }
      .sorted(by: { $0.0 > $1.0 })
      .map(\.1)

    let prompt = promptLines.joined(separator: " ").replacingOccurrences(
      of: "\\s+",
      with: " ",
      options: .regularExpression
    ).trimmingCharacters(in: .whitespacesAndNewlines)

    return prompt.isEmpty ? nil : prompt
  }

  private func capturePromptImage(_ target: CodexWindowTarget) -> CGImage? {
    let semaphore = DispatchSemaphore(value: 0)
    var capturedImage: CGImage?

    SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) {
      shareableContent, error in
      guard error == nil, let shareableContent else {
        semaphore.signal()
        return
      }
      guard let window = shareableContent.windows.first(where: { $0.windowID == target.windowID }) else {
        semaphore.signal()
        return
      }

      let filter = SCContentFilter(desktopIndependentWindow: window)
      let relativeCrop = CGRect(
        x: max(0, target.cropRect.origin.x - target.windowBounds.origin.x),
        y: max(0, target.cropRect.origin.y - target.windowBounds.origin.y),
        width: min(target.cropRect.width, target.windowBounds.width),
        height: min(target.cropRect.height, target.windowBounds.height)
      )

      let configuration = SCStreamConfiguration()
      let pointScale = max(CGFloat(filter.pointPixelScale), 1)
      configuration.sourceRect = relativeCrop
      configuration.width = max(1, Int(relativeCrop.width * pointScale))
      configuration.height = max(1, Int(relativeCrop.height * pointScale))
      configuration.scalesToFit = false
      configuration.showsCursor = false

      SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) { image, captureError in
        if captureError == nil {
          capturedImage = image
        }
        semaphore.signal()
      }
    }

    _ = semaphore.wait(timeout: .now() + 2)
    return capturedImage
  }

  @objc private func togglePreview() {
    previewEnabled.toggle()
    UserDefaults.standard.set(previewEnabled, forKey: Self.previewDefaultsKey)
    previewToggleItem.state = previewEnabled ? .on : .off
    updatePreviewToggleTitle()
    if !previewEnabled,
       previewState?.source == "screen-send-preview" || previewState?.source == "screen-send-model" {
      previewState = nil
      refreshNow()
    }
  }

  private func updatePreviewToggleTitle() {
    previewToggleItem.title = previewEnabled ? "Turn Off Send Preview" : "Turn On Send Preview"
  }

  @objc private func toggleRouter() {
    let subcommand = isRouterEnabled() ? "pause" : "resume"
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["node", cliPath, "control", subcommand, "--json"]
    process.standardOutput = Pipe()
    process.standardError = Pipe()

    do {
      try process.run()
      process.waitUntilExit()
      guard process.terminationStatus == 0 else {
        return
      }
      if subcommand == "pause" {
        previewState = nil
      }
      refreshNow()
    } catch {
      return
    }
  }

  private func updateRouterToggleTitle(routerEnabled: Bool) {
    routerToggleItem.title = routerEnabled ? "Pause Router" : "Resume Router"
  }

  private func isRouterEnabled() -> Bool {
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: controlPath)),
          let record = try? JSONDecoder().decode(RouterControlRecord.self, from: data) else {
      return true
    }
    return record.routerEnabled != false
  }

  private func composerCaptureTarget() -> CodexWindowTarget? {
    let options = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
    let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []

    guard let entry = windows.first(where: { info in
      let owner = info[kCGWindowOwnerName as String] as? String ?? ""
      let title = info[kCGWindowName as String] as? String ?? ""
      let layer = info[kCGWindowLayer as String] as? Int ?? -1
      return layer == 0 && (owner.localizedCaseInsensitiveContains("Codex") || title.localizedCaseInsensitiveContains("Codex"))
    }) else {
      return nil
    }

    guard let bounds = entry[kCGWindowBounds as String] as? [String: CGFloat],
          let x = bounds["X"],
          let y = bounds["Y"],
          let width = bounds["Width"],
          let height = bounds["Height"] else {
      return nil
    }

    let windowIDValue = entry[kCGWindowNumber as String] as? NSNumber
    let windowID = CGWindowID(windowIDValue?.uint32Value ?? 0)
    let windowBounds = CGRect(x: x, y: y, width: width, height: height)
    let cropRect = CGRect(
      x: x + width * 0.22,
      y: y + height * 0.80,
      width: width * 0.76,
      height: height * 0.13
    )

    guard windowID != 0 else {
      return nil
    }

    return CodexWindowTarget(
      windowID: windowID,
      windowBounds: windowBounds,
      cropRect: cropRect
    )
  }

  private func frontmostBundleIdentifier() -> String? {
    NSWorkspace.shared.frontmostApplication?.bundleIdentifier
  }

  private func showNotification(effort: String, prompt: String) {
    let content = UNMutableNotificationContent()
    content.title = "Codex route: \(effort)"
    content.body = truncate(prompt, max: 120)

    let request = UNNotificationRequest(
      identifier: "codex-reasoning-router.route",
      content: content,
      trigger: nil
    )
    UNUserNotificationCenter.current().add(request)
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
    "\(cwd)/.codex/state/codex-reasoning-router-live.json",
    "\(cwd)/.codex/state/codex-reasoning-router-last-route.json",
    "\(cwd)/.codex/state/codex-reasoning-router-active-session.json",
    "\(NSHomeDirectory())/.codex/state/codex-reasoning-router-live.json",
    "\(NSHomeDirectory())/.codex/state/codex-reasoning-router-last-route.json",
    "\(NSHomeDirectory())/.codex/state/codex-reasoning-router-active-session.json"
  ]
}

let scriptPath = URL(fileURLWithPath: CommandLine.arguments[0])
let repoRoot = scriptPath.deletingLastPathComponent().deletingLastPathComponent().path
let cliPath = "\(repoRoot)/bin/codex-reasoning-router.mjs"

let app = NSApplication.shared
let delegate = RouteMenubarController(paths: paths, cliPath: cliPath)
app.delegate = delegate
app.run()
