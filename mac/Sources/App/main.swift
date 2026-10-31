import AppKit
import UniformTypeIdentifiers
import WebKit

// PeerShare for Mac: the web app in a window, plus a "PeerShare" entry in the
// system share menu (the Share extension hands files over through a
// peershare:// link). Shared files stay on disk; the page reads them in blocks.

let home = URL(string: ProcessInfo.processInfo.environment["PEERSHARE_URL"] ?? "https://share.usame.link/")!
let extensionID = "link.usame.peershare.share"

func isHome(_ url: URL) -> Bool {
  url.scheme == home.scheme && url.host == home.host && url.port == home.port
}

// Files handed to the page, by random id. Only ids the page was given can be read.
final class SharedFiles {
  private var files: [String: URL] = [:]
  private let queue = DispatchQueue(label: "peershare.files")

  func add(_ urls: [URL]) -> [[String: Any]] {
    var out: [[String: Any]] = []
    for url in urls {
      guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
            values.isRegularFile == true else { continue }
      let id = UUID().uuidString
      queue.sync { files[id] = url }
      out.append([
        "id": id,
        "name": url.lastPathComponent,
        "size": values.fileSize ?? 0,
        "type": UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "",
      ])
    }
    return out
  }

  func read(id: String, start: UInt64, end: UInt64, done: @escaping (String?) -> Void) {
    queue.async {
      guard let url = self.files[id], end >= start, end - start <= 8 << 20,
            let handle = try? FileHandle(forReadingFrom: url) else { return done(nil) }
      defer { try? handle.close() }
      do {
        try handle.seek(toOffset: start)
        let data = try handle.read(upToCount: Int(end - start)) ?? Data()
        done(data.base64EncodedString())
      } catch {
        done(nil)
      }
    }
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate,
  WKUIDelegate, WKScriptMessageHandlerWithReply, WKDownloadDelegate {
  var window: NSWindow!
  var webView: WKWebView!
  let files = SharedFiles()
  var pending: [String: Any]?
  var pageReady = false
  var busy = false
  var activity: NSObjectProtocol?
  // Keeps App Nap away, so offers are answered while the app sits in the background.
  let ready = ProcessInfo.processInfo.beginActivity(options: .userInitiatedAllowingIdleSystemSleep, reason: "Ready to receive")
  var quitConfirmed = false
  var unseen = 0
  var titleObserver: NSKeyValueObservation?
  var downloads: [ObjectIdentifier: URL] = [:]

  func applicationWillFinishLaunching(_ notification: Notification) {
    NSApp.mainMenu = makeMenu()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    let config = WKWebViewConfiguration()
    config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "peershare")
    config.applicationNameForUserAgent = "PeerShareMac/1"
    // People send files while the window is in the background or covered, so
    // don't let WebKit slow the page down then (these switches have no public API).
    for key in ["hiddenPageDOMTimerThrottlingEnabled", "pageVisibilityBasedProcessSuppressionEnabled"]
    where config.preferences.responds(to: NSSelectorFromString("_set\(key.prefix(1).uppercased())\(key.dropFirst()):")) {
      config.preferences.setValue(false, forKey: key)
    }
    webView = WKWebView(frame: .zero, configuration: config)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.allowsBackForwardNavigationGestures = false
    if #available(macOS 13.3, *) {
      #if DEBUG
      webView.isInspectable = true
      #endif
    }
    titleObserver = webView.observe(\.title) { [weak self] view, _ in self?.titleChanged(view.title ?? "") }

    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 460, height: 760),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.title = "PeerShare"
    // A plain strip in the page's own background color; the page shows the name.
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    window.backgroundColor = NSColor(name: nil) { appearance in
      appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        ? NSColor(srgbRed: 0x0f / 255, green: 0x0f / 255, blue: 0x14 / 255, alpha: 1)
        : NSColor(srgbRed: 0xf5 / 255, green: 0xf5 / 255, blue: 0xfa / 255, alpha: 1)
    }
    window.minSize = NSSize(width: 360, height: 480)
    window.contentView = webView
    window.delegate = self
    window.center()
    window.setFrameAutosaveName("PeerShare")
    window.makeKeyAndOrderFront(nil)
    webView.load(URLRequest(url: home))
    NSApp.activate(ignoringOtherApps: true)

    enableShareExtension()
  }

  // Turn the share menu entry on, so it shows up without a trip to Settings.
  func enableShareExtension() {
    let key = "shareExtensionEnabled"
    guard !UserDefaults.standard.bool(forKey: key) else { return }
    DispatchQueue.global().async {
      let task = Process()
      task.executableURL = URL(fileURLWithPath: "/usr/bin/pluginkit")
      task.arguments = ["-e", "use", "-i", extensionID]
      if (try? task.run()) != nil {
        task.waitUntilExit()
        if task.terminationStatus == 0 { UserDefaults.standard.set(true, forKey: key) }
      }
    }
  }

  // MARK: Handing things to the page

  func application(_ application: NSApplication, open urls: [URL]) {
    var paths: [URL] = []
    var text = ""
    for url in urls {
      if url.isFileURL {
        paths.append(url)
      } else if url.scheme == "peershare", let share = Self.decodeShare(url) {
        paths += share.paths
        if !share.text.isEmpty { text = text.isEmpty ? share.text : "\(text)\n\(share.text)" }
      }
    }
    let described = files.add(paths)
    if described.isEmpty && text.isEmpty {
      if !paths.isEmpty { alert("PeerShare can send files, not folders.") }
      return
    }
    deliver(["files": described, "text": text])
  }

  static func decodeShare(_ url: URL) -> (paths: [URL], text: String)? {
    guard let d = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "d" })?.value,
          let data = Data(base64Encoded: d),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    let paths = (json["paths"] as? [String] ?? []).map { URL(fileURLWithPath: $0) }
    return (paths, json["text"] as? String ?? "")
  }

  func deliver(_ share: [String: Any]) {
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    guard pageReady else { pending = share; return }
    webView.callAsyncJavaScript(
      "window.peershareMac && window.peershareMac.share(s)", arguments: ["s": share], in: nil, in: .page)
  }

  // MARK: Messages from the page

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                             replyHandler: @escaping (Any?, String?) -> Void) {
    let origin = message.frameInfo.securityOrigin
    guard message.frameInfo.isMainFrame, origin.protocol == home.scheme, origin.host == home.host,
          let body = message.body as? [String: Any], let t = body["t"] as? String else {
      return replyHandler(nil, "Not allowed")
    }
    switch t {
    case "ready":
      pageReady = true
      replyHandler(pending, nil)
      pending = nil
    case "read":
      guard let id = body["id"] as? String, let start = body["start"] as? NSNumber, let end = body["end"] as? NSNumber else {
        return replyHandler(nil, "Bad read")
      }
      files.read(id: id, start: start.uint64Value, end: end.uint64Value) { b64 in
        DispatchQueue.main.async { b64 == nil ? replyHandler(nil, "Can’t read the file") : replyHandler(b64, nil) }
      }
    case "busy":
      setBusy(body["on"] as? Bool ?? false)
      replyHandler(nil, nil)
    #if DEBUG
    case "log":
      debugLog(body["text"] as? String ?? "")
      replyHandler(nil, nil)
    #endif
    default:
      replyHandler(nil, "Unknown message")
    }
  }

  // Keep the Mac awake while a transfer runs.
  func setBusy(_ on: Bool) {
    busy = on
    if on, activity == nil {
      activity = ProcessInfo.processInfo.beginActivity(
        options: [.userInitiated, .idleSystemSleepDisabled], reason: "Transfer in progress")
    } else if !on, let a = activity {
      ProcessInfo.processInfo.endActivity(a)
      activity = nil
    }
  }

  // The page counts unseen arrivals in its title, "(2) PeerShare".
  func titleChanged(_ title: String) {
    let count = title.range(of: #"^\((\d+)\)"#, options: .regularExpression)
      .flatMap { Int(title[$0].dropFirst().dropLast()) } ?? 0
    NSApp.dockTile.badgeLabel = count > 0 ? String(count) : nil
    if count > unseen { NSApp.requestUserAttention(.informationalRequest) }
    unseen = count
  }

  // MARK: Navigation, links, file pickers, downloads

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
               preferences: WKWebpagePreferences,
               decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void) {
    if action.shouldPerformDownload { return decisionHandler(.download, preferences) }
    if let url = action.request.url, action.targetFrame?.isMainFrame != false,
       !isHome(url), !["blob", "about", "data"].contains(url.scheme ?? "") {
      NSWorkspace.shared.open(url)
      return decisionHandler(.cancel, preferences)
    }
    decisionHandler(.allow, preferences)
  }

  func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
               decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    decisionHandler(response.canShowMIMEType ? .allow : .download)
  }

  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    pageReady = false
    setBusy(false)
  }

  #if DEBUG
  // Test hooks: PEERSHARE_INJECT is a script run after each page load; the
  // page writes lines to PEERSHARE_LOG with {t:'log', text}, and logging
  // "snapshot:<path>" saves a PNG of the page.
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    guard let path = ProcessInfo.processInfo.environment["PEERSHARE_INJECT"],
          let script = try? String(contentsOfFile: path, encoding: .utf8) else { return }
    webView.evaluateJavaScript(script)
  }

  func debugLog(_ text: String) {
    if text.hasPrefix("snapshot:") {
      let path = String(text.dropFirst("snapshot:".count))
      webView.takeSnapshot(with: nil) { image, _ in
        guard let tiff = image?.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return }
        try? png.write(to: URL(fileURLWithPath: path))
      }
    }
    guard let path = ProcessInfo.processInfo.environment["PEERSHARE_LOG"] else { return }
    let line = Data("\(Date().timeIntervalSince1970) \(text)\n".utf8)
    if let h = FileHandle(forWritingAtPath: path) {
      h.seekToEndOfFile()
      h.write(line)
      try? h.close()
    } else {
      try? line.write(to: URL(fileURLWithPath: path))
    }
  }
  #endif

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { showOffline(error) }
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    showOffline(error)
  }

  func showOffline(_ error: Error) {
    if (error as NSError).code == NSURLErrorCancelled { return }
    let html = """
      <meta name="color-scheme" content="dark light"><body style="font:15px -apple-system;display:grid;place-items:center;height:90vh;text-align:center">
      <div><p>PeerShare can’t reach the internet.</p><p><a href="\(home.absoluteString)">Try again</a></p></div>
      """
    webView.loadHTMLString(html, baseURL: nil)
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

  // Links that open a new window go to the default browser.
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
               for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if action.shouldPerformDownload {
      webView.startDownload(using: action.request) { $0.delegate = self }
    } else if let url = action.request.url {
      NSWorkspace.shared.open(url)
    }
    return nil
  }

  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.canChooseDirectories = false
    panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
  }

  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
    download.delegate = self
  }

  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
    download.delegate = self
  }

  func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                completionHandler: @escaping (URL?) -> Void) {
    let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
    let name = suggestedFilename.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
    let url = Self.unique(folder.appendingPathComponent(name.isEmpty ? "file" : name))
    downloads[ObjectIdentifier(download)] = url
    completionHandler(url)
  }

  func downloadDidFinish(_ download: WKDownload) {
    guard let url = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
    // Makes the Downloads stack in the Dock bounce, like a browser download.
    DistributedNotificationCenter.default().post(name: .init("com.apple.DownloadFileFinished"), object: url.path)
  }

  func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    downloads.removeValue(forKey: ObjectIdentifier(download))
    alert("Couldn’t save the file: \(error.localizedDescription)")
  }

  static func unique(_ url: URL) -> URL {
    let fm = FileManager.default
    guard fm.fileExists(atPath: url.path) else { return url }
    let base = url.deletingPathExtension().lastPathComponent
    let ext = url.pathExtension
    for i in 2... {
      let name = ext.isEmpty ? "\(base) \(i)" : "\(base) \(i).\(ext)"
      let candidate = url.deletingLastPathComponent().appendingPathComponent(name)
      if !fm.fileExists(atPath: candidate.path) { return candidate }
    }
    return url
  }

  // MARK: Closing

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

  func windowShouldClose(_ sender: NSWindow) -> Bool { confirmStop() }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    confirmStop() ? .terminateNow : .terminateCancel
  }

  func confirmStop() -> Bool {
    if !busy || quitConfirmed { return true }
    let a = NSAlert()
    a.messageText = "A transfer is still running"
    a.informativeText = "Quitting PeerShare stops it."
    a.addButton(withTitle: "Keep Going")
    a.addButton(withTitle: "Quit")
    quitConfirmed = a.runModal() == .alertSecondButtonReturn
    return quitConfirmed
  }

  func alert(_ text: String) {
    let a = NSAlert()
    a.messageText = text
    a.runModal()
  }

  // MARK: Menu

  @objc func reload() { webView.load(URLRequest(url: home)) }

  func makeMenu() -> NSMenu {
    let main = NSMenu()
    func submenu(_ title: String, _ items: [NSMenuItem]) {
      let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      item.submenu = NSMenu(title: title)
      items.forEach { item.submenu!.addItem($0) }
      main.addItem(item)
    }
    func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
      let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
      i.keyEquivalentModifierMask = mods
      return i
    }
    submenu("PeerShare", [
      item("About PeerShare", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
      .separator(),
      item("Hide PeerShare", #selector(NSApplication.hide(_:)), "h"),
      item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
      item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
      .separator(),
      item("Quit PeerShare", #selector(NSApplication.terminate(_:)), "q"),
    ])
    submenu("Edit", [
      item("Undo", Selector(("undo:")), "z"),
      item("Redo", Selector(("redo:")), "z", [.command, .shift]),
      .separator(),
      item("Cut", #selector(NSText.cut(_:)), "x"),
      item("Copy", #selector(NSText.copy(_:)), "c"),
      item("Paste", #selector(NSText.paste(_:)), "v"),
      item("Select All", #selector(NSText.selectAll(_:)), "a"),
    ])
    submenu("View", [item("Reload", #selector(reload), "r")])
    submenu("Window", [
      item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
      item("Zoom", #selector(NSWindow.performZoom(_:))),
      item("Close", #selector(NSWindow.performClose(_:)), "w"),
    ])
    return main
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
