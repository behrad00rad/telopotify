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
  private let manager = TDLibClientManager()
  private var client: TDLibClient?
  private var state = "starting"
  private var listeners = false

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

  private func finish(_ result: [String: Any], resolve: RCTPromiseResolveBlock,
                      reject: RCTPromiseRejectBlock) {
    if result["@type"] as? String == "error" {
      reject("telegram", result["message"] as? String ?? "Telegram error", nil)
    } else { resolve(result) }
  }
}
