import AppKit
import UniformTypeIdentifiers

// The "PeerShare" entry in the share menu. It collects what was shared and
// hands it to the PeerShare app through a peershare:// link, then gets out of
// the way: picking the person happens in the app.
@objc(ShareViewController)
final class ShareViewController: NSViewController {
  private enum Shared { case path(String), text(String) }

  override var nibName: NSNib.Name? { nil }

  override func loadView() {
    view = NSView(frame: NSRect(x: 0, y: 0, width: 1, height: 1))
    preferredContentSize = view.frame.size
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    Self.removeOldCopies()
    // Plain text arrives as the item's text, with nothing attached.
    var sources: [Any] = []
    for item in extensionContext?.inputItems as? [NSExtensionItem] ?? [] {
      if let attachments = item.attachments, !attachments.isEmpty {
        sources += attachments
      } else if let text = item.attributedContentText?.string, !text.isEmpty {
        sources.append(text)
      }
    }
    var slots = [Shared?](repeating: nil, count: sources.count)
    let lock = NSLock()
    let group = DispatchGroup()
    for (i, source) in sources.enumerated() {
      if let text = source as? String {
        slots[i] = .text(text)
        continue
      }
      group.enter()
      Self.load(source as! NSItemProvider) { shared in
        lock.lock()
        slots[i] = shared
        lock.unlock()
        group.leave()
      }
    }
    group.notify(queue: .main) { [weak self] in self?.finish(slots.compactMap { $0 }) }
  }

  private static func load(_ provider: NSItemProvider, done: @escaping (Shared?) -> Void) {
    if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
      provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier) { item, _ in
        done(url(from: item).map { .path($0.path) })
      }
    } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
      provider.loadItem(forTypeIdentifier: UTType.url.identifier) { item, _ in
        done(url(from: item).map { .text($0.absoluteString) })
      }
    } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
      provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) { item, _ in
        if let s = item as? String { return done(.text(s)) }
        if let s = item as? NSAttributedString { return done(.text(s.string)) }
        if let d = item as? Data, let s = String(data: d, encoding: .utf8) { return done(.text(s)) }
        done(nil)
      }
    } else if let type = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.preferredFilenameExtension != nil }) {
      // Data without a file behind it (a photo, a clipping): keep a copy.
      provider.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
        guard let url else { return done(nil) }
        let uti = UTType(type)
        var name = provider.suggestedName ?? (uti?.conforms(to: .image) == true ? "Image" : "File")
        let ext = url.pathExtension.isEmpty ? uti?.preferredFilenameExtension ?? "" : url.pathExtension
        if URL(fileURLWithPath: name).pathExtension.isEmpty, !ext.isEmpty { name += ".\(ext)" }
        done(keep(name: name) { try FileManager.default.copyItem(at: url, to: $0) })
      }
    } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
      // An image object with no file type of its own (it arrives archived): save it as PNG.
      provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
        guard let data,
              let image = NSImage(data: data) ?? (try? NSKeyedUnarchiver.unarchivedObject(ofClass: NSImage.self, from: data)),
              let tiff = image.tiffRepresentation,
              let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return done(nil) }
        done(keep(name: "\(provider.suggestedName ?? "Image").png") { try png.write(to: $0) })
      }
    } else {
      done(nil)
    }
  }

  // Writes a copy into a folder of its own, so names never clash.
  private static func keep(name: String, write: (URL) throws -> Void) -> Shared? {
    let folder = copies.appendingPathComponent(UUID().uuidString, isDirectory: true)
    let copy = folder.appendingPathComponent(name.replacingOccurrences(of: "/", with: "_"))
    do {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      try write(copy)
      return .path(copy.path)
    } catch {
      return nil
    }
  }

  private static let copies = FileManager.default.temporaryDirectory.appendingPathComponent("Shared", isDirectory: true)

  // The app reads copies while sending; a day later they can go.
  private static func removeOldCopies() {
    let fm = FileManager.default
    let old = Date().addingTimeInterval(-24 * 60 * 60)
    for dir in (try? fm.contentsOfDirectory(at: copies, includingPropertiesForKeys: [.creationDateKey])) ?? [] {
      if let created = try? dir.resourceValues(forKeys: [.creationDateKey]).creationDate, created < old {
        try? fm.removeItem(at: dir)
      }
    }
  }

  private static func url(from item: NSSecureCoding?) -> URL? {
    if let url = item as? URL { return url }
    if let data = item as? Data { return URL(dataRepresentation: data, relativeTo: nil) }
    if let s = item as? String { return URL(string: s) }
    return nil
  }

  private func finish(_ shared: [Shared]) {
    var paths: [String] = []
    var texts: [String] = []
    for s in shared {
      switch s {
      case .path(let p): paths.append(p)
      case .text(let t): texts.append(t)
      }
    }
    let json: [String: Any] = ["paths": paths, "text": texts.joined(separator: "\n")]
    guard !shared.isEmpty,
          let data = try? JSONSerialization.data(withJSONObject: json),
          var link = URLComponents(string: "peershare://share") else {
      extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
      return
    }
    link.queryItems = [URLQueryItem(name: "d", value: data.base64EncodedString())]
    if let url = link.url { NSWorkspace.shared.open(url) }
    extensionContext?.completeRequest(returningItems: nil)
  }
}
