import AVFoundation
import Foundation
import UniformTypeIdentifiers

// AVPlayer treats this as a byte-addressable asset. Requests are serialized
// because a second TDLib downloadFile offset can cancel the first one.
final class TelegramStreamLoader: NSObject, AVAssetResourceLoaderDelegate {
  let queue = DispatchQueue(label: "app.telopotify.telegram-stream")
  private let fileId: Int
  private let fileSize: Int64
  private let contentType: String
  private var pending: [AVAssetResourceLoadingRequest] = []
  private var active: AVAssetResourceLoadingRequest?
  private var cancelled = Set<ObjectIdentifier>()
  private let chunkSize = 256 * 1024
  private let maxRetries = 30

  init(fileId: Int, fileSize: Int64, mimeType: String) {
    self.fileId = fileId
    self.fileSize = fileSize
    self.contentType = UTType(mimeType: mimeType)?.identifier ?? UTType.mp3.identifier
    super.init()
  }

  func resourceLoader(_ resourceLoader: AVAssetResourceLoader,
                      shouldWaitForLoadingOfRequestedResource request: AVAssetResourceLoadingRequest) -> Bool {
    if let information = request.contentInformationRequest {
      information.contentType = contentType
      information.contentLength = fileSize
      information.isByteRangeAccessSupported = true
    }
    pending.append(request)
    advance()
    return true
  }

  func resourceLoader(_ resourceLoader: AVAssetResourceLoader,
                      didCancel request: AVAssetResourceLoadingRequest) {
    cancelled.insert(ObjectIdentifier(request))
    pending.removeAll { $0 === request }
    if active === request {
      active = nil
      cancelled.remove(ObjectIdentifier(request))
      advance()
    }
  }

  private func advance() {
    guard active == nil, !pending.isEmpty else { return }
    let request = pending.removeFirst()
    if cancelled.remove(ObjectIdentifier(request)) != nil { advance(); return }
    active = request
    guard let data = request.dataRequest else {
      request.finishLoading()
      active = nil
      advance()
      return
    }
    let start = max(0, data.currentOffset > 0 ? data.currentOffset : data.requestedOffset)
    let amount = data.requestsAllDataToEndOfResource
      ? max(0, fileSize - start) : Int64(data.requestedLength)
    serve(request, offset: start, remaining: amount)
  }

  private func serve(_ request: AVAssetResourceLoadingRequest, offset: Int64,
                     remaining: Int64, retries: Int = 0) {
    guard active === request else { return }
    if cancelled.remove(ObjectIdentifier(request)) != nil {
      active = nil
      advance()
      return
    }
    let available = max(0, fileSize - offset)
    let count = Int(min(Int64(chunkSize), min(remaining, available)))
    guard count > 0 else {
      request.finishLoading()
      active = nil
      advance()
      return
    }
    guard let telegram = TelopotifyTelegram.active else {
      fail(request, message: "Telegram is not connected")
      return
    }
    telegram.downloadRange(fileId: fileId, offset: offset, length: count) { [weak self] result in
      self?.queue.async {
        guard let self, self.active === request else { return }
        switch result {
        case .success(let bytes):
          if self.cancelled.contains(ObjectIdentifier(request)) {
            self.cancelled.remove(ObjectIdentifier(request))
            self.active = nil
            self.advance()
            return
          }
          request.dataRequest?.respond(with: bytes)
          self.serve(request, offset: offset + Int64(bytes.count),
                     remaining: remaining - Int64(bytes.count))
        case .failure(let error):
          if retries < self.maxRetries {
            let delay = min(10.0, Double(1 << min(retries, 3)))
            self.queue.asyncAfter(deadline: .now() + delay) { [weak self] in
              self?.serve(request, offset: offset, remaining: remaining, retries: retries + 1)
            }
          } else {
            request.finishLoading(with: error)
            self.active = nil
            self.advance()
          }
        }
      }
    }
  }

  private func fail(_ request: AVAssetResourceLoadingRequest, message: String) {
    request.finishLoading(with: NSError(domain: "TelopotifyStream", code: 1,
      userInfo: [NSLocalizedDescriptionKey: message]))
    active = nil
    advance()
  }
}
