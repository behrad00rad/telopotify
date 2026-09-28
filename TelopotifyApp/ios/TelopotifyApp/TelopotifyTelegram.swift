import Foundation
import React
import TDLibKit

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

  override init() {
    super.init()
    Self.active = self
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
      "from_message_id": Int64(cursor) ?? 0, "offset": cursor.isEmpty ? 0 : 1,
      "limit": 100, "only_local": false,
    ]) { result in
      guard let messages = result["messages"] as? [[String: Any]] else {
        reject("telegram", result["message"] as? String ?? "Could not read channel", nil)
        return
      }
      let tracks: [[String: Any]] = messages.compactMap { message in
        guard let id = message["id"] as? NSNumber,
              let content = message["content"] as? [String: Any],
              content["@type"] as? String == "messageAudio",
              let audio = content["audio"] as? [String: Any],
              let file = audio["audio"] as? [String: Any],
              let fileId = file["id"] as? NSNumber else { return nil }
        let fileName = audio["file_name"] as? String ?? ""
        let title = audio["title"] as? String ?? ""
        return [
          "messageId": id.stringValue, "fileId": fileId.intValue,
          "title": title.isEmpty ? fileName : title,
          "artist": audio["performer"] as? String ?? "",
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
