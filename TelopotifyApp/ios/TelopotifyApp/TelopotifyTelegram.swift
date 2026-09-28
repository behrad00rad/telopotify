import Foundation
import Network
import React
import TDLibKit
import UIKit

private struct TelegramQuery: TdQuery {
  let body: [String: Any]

  func make(with extra: String?) throws -> Data {
    var payload = body
    if let extra { payload["@extra"] = extra }
    return try JSONSerialization.data(withJSONObject: payload)
  }
}

@objc(TelopotifyTelegram)
final class TelopotifyTelegram: RCTEventEmitter {
  static weak var active: TelopotifyTelegram?
  private let manager = TDLibClientManager()
  private var client: TDLibClient?
  private var state = "starting"
  private var listeners = false
  private let pathMonitor = NWPathMonitor()
  private let pathQueue = DispatchQueue(label: "app.telopotify.network")
  private var foregroundObserver: NSObjectProtocol?

  override init() {
    super.init()
    Self.active = self
    pathMonitor.pathUpdateHandler = { [weak self] _ in self?.refreshNetwork() }
    pathMonitor.start(queue: pathQueue)
    foregroundObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.willEnterForegroundNotification, object: nil, queue: nil
    ) { [weak self] _ in self?.refreshNetwork() }
  }

  deinit {
    pathMonitor.cancel()
    if let foregroundObserver { NotificationCenter.default.removeObserver(foregroundObserver) }
  }

  private func refreshNetwork() {
    guard client != nil else { return }
    request(["@type": "setNetworkType", "type": ["@type": "networkTypeOther"]]) { _ in }
  }

  @objc override static func requiresMainQueueSetup() -> Bool { false }
  override func supportedEvents() -> [String]! { ["telegramState"] }
  override func startObserving() { listeners = true; emitState() }
  override func stopObserving() { listeners = false }

  private func emitState(error: String? = nil) {
    guard listeners else { return }
    var event: [String: String] = ["state": state]
    if let error { event["error"] = error }
    sendEvent(withName: "telegramState", body: event)
  }

  private func handleUpdate(_ data: Data) {
    guard let update = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          update["@type"] as? String == "updateAuthorizationState",
          let auth = update["authorization_state"] as? [String: Any],
          let next = auth["@type"] as? String else { return }
    state = next
    emitState()
    if next == "authorizationStateWaitTdlibParameters" { configure() }
  }

  private func configure() {
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    let root = support.appendingPathComponent("Telegram", isDirectory: true)
    let files = root.appendingPathComponent("Files", isDirectory: true)
    do {
      try FileManager.default.createDirectory(at: files, withIntermediateDirectories: true)
      try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: root.path)
      try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: files.path)
    } catch {
      emitState(error: "Could not prepare Telegram storage: \(error.localizedDescription)")
      return
    }
    // Telegram Desktop's published test credentials. Replace before distribution.
    request([
      "@type": "setTdlibParameters", "api_id": 17349,
      "api_hash": "344583e45741c457fe1862106095a5eb",
      "database_directory": root.path, "files_directory": files.path,
      "database_encryption_key": "", "use_test_dc": false,
      "use_file_database": true, "use_chat_info_database": true,
      "use_message_database": true, "use_secret_chats": false,
      "system_language_code": Locale.current.languageCode ?? "en",
      "device_model": "iPhone", "system_version": ProcessInfo.processInfo.operatingSystemVersionString,
      "application_version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0",
    ]) { [weak self] result in
      if let error = result["message"] as? String { self?.emitState(error: error) }
    }
  }

  private func request(_ body: [String: Any], completion: @escaping ([String: Any]) -> Void) {
    guard let client else { completion(["@type": "error", "message": "Telegram has not started"]); return }
    do {
      try client.send(query: TelegramQuery(body: body)) { data in
        let result = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ??
          ["@type": "error", "message": "Invalid Telegram response"]
        completion(result)
      }
    } catch {
      completion(["@type": "error", "message": error.localizedDescription])
    }
  }

  @objc(start:rejecter:)
  func start(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    if client == nil {
      client = manager.createClient { [weak self] data, _ in self?.handleUpdate(data) }
      refreshNetwork()
    }
    resolve(["state": state])
  }

  @objc(getState:rejecter:)
  func getState(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    resolve(["state": state])
  }

  @objc(sendPhone:resolver:rejecter:)
  func sendPhone(_ phone: String, resolver resolve: @escaping RCTPromiseResolveBlock,
                 rejecter reject: @escaping RCTPromiseRejectBlock) {
    request(["@type": "setAuthenticationPhoneNumber", "phone_number": phone]) { result in
      self.finish(result, resolve: resolve, reject: reject)
    }
  }

  @objc(sendCode:resolver:rejecter:)
  func sendCode(_ code: String, resolver resolve: @escaping RCTPromiseResolveBlock,
                rejecter reject: @escaping RCTPromiseRejectBlock) {
    request(["@type": "checkAuthenticationCode", "code": code]) { result in
      self.finish(result, resolve: resolve, reject: reject)
    }
  }

  @objc(sendPassword:resolver:rejecter:)
  func sendPassword(_ password: String, resolver resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
    request(["@type": "checkAuthenticationPassword", "password": password]) { result in
      self.finish(result, resolve: resolve, reject: reject)
    }
  }

  @objc(listChannels:rejecter:)
  func listChannels(_ resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard state == "authorizationStateReady" else {
      reject("telegram", "Sign in to Telegram first", nil)
      return
    }
    // Loading chat positions populates TDLib's local list without fetching media.
    request(["@type": "loadChats", "limit": 200]) { _ in
      self.request(["@type": "getChats", "limit": 200]) { result in
        guard let ids = result["chat_ids"] as? [NSNumber] else {
          reject("telegram", result["message"] as? String ?? "Could not list chats", nil)
          return
        }
        let group = DispatchGroup()
        let lock = NSLock()
        var channels: [[String: String]] = []
        for id in ids {
          group.enter()
          self.request(["@type": "getChat", "chat_id": id]) { chat in
            defer { group.leave() }
            guard let type = chat["type"] as? [String: Any],
                  type["@type"] as? String == "chatTypeSupergroup",
                  type["is_channel"] as? Bool == true,
                  let title = chat["title"] as? String else { return }
            lock.lock()
            channels.append(["id": id.stringValue, "title": title])
            lock.unlock()
          }
        }
        group.notify(queue: .main) {
          resolve(channels.sorted { $0["title", default: ""] < $1["title", default: ""] })
        }
      }
    }
  }

  @objc(selectChannel:resolver:rejecter:)
  func selectChannel(_ id: String, resolver resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let chatId = Int64(id) else { reject("telegram", "Invalid channel", nil); return }
    request(["@type": "getChat", "chat_id": chatId]) { result in
      guard let type = result["type"] as? [String: Any],
            type["@type"] as? String == "chatTypeSupergroup",
            type["is_channel"] as? Bool == true else {
        reject("telegram", "Channel is unavailable", nil)
        return
      }
      UserDefaults.standard.set(id, forKey: "telopotify.channelId")
      resolve(["id": id, "title": result["title"] as? String ?? "Channel"])
    }
  }

  @objc(getSelectedChannel:rejecter:)
  func getSelectedChannel(_ resolve: RCTPromiseResolveBlock,
                          rejecter reject: RCTPromiseRejectBlock) {
    resolve(UserDefaults.standard.string(forKey: "telopotify.channelId"))
  }

  @objc(getTrackPage:resolver:rejecter:)
  func getTrackPage(_ cursor: String, resolver resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard state == "authorizationStateReady",
          let selected = UserDefaults.standard.string(forKey: "telopotify.channelId"),
          let chatId = Int64(selected) else {
      reject("telegram", "Choose a channel first", nil)
      return
    }
    guard cursor.isEmpty || Int64(cursor) != nil else {
      reject("telegram", "Invalid history cursor", nil)
      return
    }
    request([
      "@type": "getChatHistory", "chat_id": chatId,
      "from_message_id": Int64(cursor) ?? 0, "offset": 0,
      "limit": 100, "only_local": false,
    ]) { result in
      guard let messages = result["messages"] as? [[String: Any]] else {
        reject("telegram", result["message"] as? String ?? "Could not read channel", nil)
        return
      }
      let tracks: [[String: Any]] = messages.filter {
        cursor.isEmpty || ($0["id"] as? NSNumber)?.stringValue != cursor
      }.compactMap { message in
        guard let id = message["id"] as? NSNumber,
              let content = message["content"] as? [String: Any],
              content["@type"] as? String == "messageAudio",
              let audio = content["audio"] as? [String: Any],
              let file = audio["audio"] as? [String: Any],
              let fileId = file["id"] as? NSNumber else { return nil }
        let fileName = audio["file_name"] as? String ?? ""
        let title = audio["title"] as? String ?? ""
        let cover = audio["album_cover_thumbnail"] as? [String: Any]
        let externalCovers = audio["external_album_covers"] as? [[String: Any]] ?? []
        let coverFile = (cover ?? externalCovers.first)?["file"] as? [String: Any]
        let caption = (content["caption"] as? [String: Any])?["text"] as? String ?? ""
        let album = caption.split(separator: "\n").first { $0.lowercased().hasPrefix("album:") }
          .map { String($0.dropFirst(6)).trimmingCharacters(in: .whitespaces) } ?? ""
        return [
          "messageId": id.stringValue, "fileId": fileId.intValue,
          "title": title.isEmpty ? fileName : title,
          "artist": audio["performer"] as? String ?? "",
          "album": album, "coverFileId": (coverFile?["id"] as? NSNumber)?.intValue ?? 0,
          "durationSeconds": audio["duration"] as? Int ?? 0,
          "fileSize": file["size"] as? Int ?? 0,
          "mimeType": audio["mime_type"] as? String ?? "",
        ]
      }
      resolve([
        "tracks": tracks,
        "nextCursor": messages.last.flatMap { ($0["id"] as? NSNumber)?.stringValue } ?? "",
        "hasMore": !messages.isEmpty,
      ])
    }
  }

  private func catalogURL(_ channelId: String) -> URL? {
    guard Int64(channelId) != nil else { return nil }
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return support.appendingPathComponent("Catalog-\(channelId).json")
  }

  @objc(getCatalog:resolver:rejecter:)
  func getCatalog(_ channelId: String, resolver resolve: RCTPromiseResolveBlock,
                  rejecter reject: RCTPromiseRejectBlock) {
    guard let url = catalogURL(channelId) else { reject("catalog", "Invalid channel", nil); return }
    resolve((try? String(contentsOf: url, encoding: .utf8)) ?? "")
  }

  @objc(saveCatalog:value:resolver:rejecter:)
  func saveCatalog(_ channelId: String, value: String, resolver resolve: RCTPromiseResolveBlock,
                   rejecter reject: RCTPromiseRejectBlock) {
    guard let url = catalogURL(channelId), value.utf8.count < 10_000_000,
          (try? JSONSerialization.jsonObject(with: Data(value.utf8))) is [String: Any] else {
      reject("catalog", "Invalid catalog", nil)
      return
    }
    do {
      try Data(value.utf8).write(to: url, options: .atomic)
      resolve(true)
    } catch { reject("catalog", error.localizedDescription, error as NSError) }
  }

  @objc(reconnect:rejecter:)
  func reconnect(_ resolve: @escaping RCTPromiseResolveBlock,
                 rejecter reject: @escaping RCTPromiseRejectBlock) {
    request(["@type": "setNetworkType", "type": ["@type": "networkTypeOther"]]) { result in
      self.finish(result, resolve: resolve, reject: reject)
    }
  }

  @objc(trimCache:rejecter:)
  func trimCache(_ resolve: @escaping RCTPromiseResolveBlock,
                 rejecter reject: @escaping RCTPromiseRejectBlock) {
    request(["@type": "optimizeStorage", "size": 512 * 1024 * 1024,
             "ttl": -1, "count": -1, "immunity_delay": 3600,
             "file_types": [["@type": "fileTypeAudio"]],
             "chat_ids": [], "exclude_chat_ids": [],
             "return_deleted_file_statistics": false, "chat_limit": 0]) { result in
      self.finish(result, resolve: resolve, reject: reject)
    }
  }

  @objc(getArtwork:resolver:rejecter:)
  func getArtwork(_ fileId: NSNumber, resolver resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard fileId.intValue > 0 else { resolve(NSNull()); return }
    request(["@type": "downloadFile", "file_id": fileId.intValue,
             "priority": 16, "offset": 0, "limit": 0, "synchronous": true]) { result in
      guard let local = result["local"] as? [String: Any],
            let path = local["path"] as? String, !path.isEmpty else {
        reject("artwork", result["message"] as? String ?? "Cover unavailable", nil)
        return
      }
      resolve(URL(fileURLWithPath: path).absoluteString)
    }
  }

  @objc(getLibraryState:rejecter:)
  func getLibraryState(_ resolve: RCTPromiseResolveBlock,
                       rejecter reject: RCTPromiseRejectBlock) {
    resolve(UserDefaults.standard.string(forKey: "telopotify.iosLibrary") ?? "{}")
  }

  @objc(saveLibraryState:resolver:rejecter:)
  func saveLibraryState(_ value: String, resolver resolve: RCTPromiseResolveBlock,
                        rejecter reject: RCTPromiseRejectBlock) {
    guard value.utf8.count < 1_000_000,
          (try? JSONSerialization.jsonObject(with: Data(value.utf8))) is [String: Any] else {
      reject("library", "Invalid library state", nil)
      return
    }
    UserDefaults.standard.set(value, forKey: "telopotify.iosLibrary")
    resolve(true)
  }

  // AVAssetResourceLoader asks for one bounded range at a time. TDLib keeps
  // its own sparse file on disk; no audio bytes cross the React Native bridge.
  func downloadRange(fileId: Int, offset: Int64, length: Int,
                     completion: @escaping (Result<Data, Swift.Error>) -> Void) {
    request([
      "@type": "downloadFile", "file_id": fileId, "priority": 32,
      "offset": offset, "limit": length, "synchronous": true,
    ]) { result in
      if result["@type"] as? String == "error" {
        completion(.failure(NSError(domain: "TelopotifyTelegram", code: 1,
          userInfo: [NSLocalizedDescriptionKey: result["message"] as? String ?? "Download failed"])))
        return
      }
      guard let local = result["local"] as? [String: Any],
            let path = local["path"] as? String, !path.isEmpty,
            let downloadOffset = local["download_offset"] as? NSNumber,
            let prefix = local["downloaded_prefix_size"] as? NSNumber,
            (local["is_downloading_completed"] as? Bool == true ||
              (downloadOffset.int64Value <= offset &&
               downloadOffset.int64Value + prefix.int64Value >= offset + Int64(length))) else {
        completion(.failure(NSError(domain: "TelopotifyTelegram", code: 2,
          userInfo: [NSLocalizedDescriptionKey: "Requested audio range is unavailable"])))
        return
      }
      do {
        let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: path))
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(offset))
        let bytes = try handle.read(upToCount: length) ?? Data()
        guard bytes.count == length else {
          throw NSError(domain: "TelopotifyTelegram", code: 3,
                        userInfo: [NSLocalizedDescriptionKey: "Incomplete audio range"])
        }
        completion(.success(bytes))
      } catch { completion(.failure(error)) }
    }
  }

  private func finish(_ result: [String: Any], resolve: RCTPromiseResolveBlock,
                      reject: RCTPromiseRejectBlock) {
    if result["@type"] as? String == "error" {
      reject("telegram", result["message"] as? String ?? "Telegram error", nil)
    } else { resolve(result) }
  }
}
