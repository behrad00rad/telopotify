import AVFoundation
import MediaPlayer
import React

// The player lives in iOS rather than JavaScript so locking the phone does not
// suspend the current song.
@objc(TelopotifyAudio)
final class TelopotifyAudio: NSObject {
  private struct QueueTrack {
    let messageId: String
    let fileId: Int
    let fileSize: Int64
    let mimeType: String
    let title: String
    let artist: String

    init?(_ value: [String: Any]) {
      guard let messageId = value["messageId"] as? String,
            let fileId = value["fileId"] as? NSNumber,
            let fileSize = value["fileSize"] as? NSNumber,
            fileId.intValue > 0, fileSize.int64Value > 0 else { return nil }
      self.messageId = messageId
      self.fileId = fileId.intValue
      self.fileSize = fileSize.int64Value
      self.mimeType = value["mimeType"] as? String ?? "audio/mpeg"
      self.title = value["title"] as? String ?? "Untitled"
      self.artist = value["artist"] as? String ?? ""
    }
  }

  private let player = AVPlayer()
  private var queue: [QueueTrack] = []
  private var queueIndex = -1
  private var title = ""
  private var artist = ""
  private var desiredRate: Float = 1
  private var ended = false
  private var errorMessage: String?
  private var endObserver: NSObjectProtocol?
  private var interruptionObserver: NSObjectProtocol?
  private var shouldResumeAfterInterruption = false
  private var streamLoader: TelegramStreamLoader?

  @objc static func requiresMainQueueSetup() -> Bool { true }

  override init() {
    super.init()
    let commands = MPRemoteCommandCenter.shared()
    commands.playCommand.addTarget { [weak self] _ in
      DispatchQueue.main.async { self?.resumeOnMain() }
      return .success
    }
    commands.pauseCommand.addTarget { [weak self] _ in
      DispatchQueue.main.async { self?.pauseOnMain() }
      return .success
    }
    commands.changePlaybackPositionCommand.addTarget { [weak self] event in
      guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
      DispatchQueue.main.async { self?.seekOnMain(event.positionTime) }
      return .success
    }
    commands.nextTrackCommand.addTarget { [weak self] _ in
      DispatchQueue.main.async { self?.nextOnMain() }
      return .success
    }
    commands.previousTrackCommand.addTarget { [weak self] _ in
      DispatchQueue.main.async { self?.previousOnMain() }
      return .success
    }
    commands.nextTrackCommand.isEnabled = false
    commands.previousTrackCommand.isEnabled = false

    interruptionObserver = NotificationCenter.default.addObserver(
      forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
    ) { [weak self] notification in
      self?.handleInterruption(notification)
    }
  }

  deinit {
    if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
    if let interruptionObserver { NotificationCenter.default.removeObserver(interruptionObserver) }
  }

  @objc(play:title:artist:)
  func play(_ rawURL: String, title: String, artist: String) {
    DispatchQueue.main.async {
      guard let url = URL(string: rawURL),
            url.isFileURL || url.scheme == "https" ||
              (url.scheme == "http" && ["127.0.0.1", "localhost"].contains(url.host ?? "")) else {
        self.errorMessage = "Invalid audio source"
        return
      }
      do {
        try AVAudioSession.sharedInstance().setActive(true)
      } catch {
        self.errorMessage = "Audio session is unavailable: \(error.localizedDescription)"
        return
      }
      if let endObserver = self.endObserver { NotificationCenter.default.removeObserver(endObserver) }
      self.queue = []
      self.queueIndex = -1
      self.updateQueueCommands()
      self.streamLoader = nil
      self.title = title
      self.artist = artist
      self.ended = false
      self.errorMessage = nil
      let item = AVPlayerItem(url: url)
      self.endObserver = NotificationCenter.default.addObserver(
        forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
      ) { [weak self] _ in
        self?.ended = true
        self?.updateNowPlaying()
      }
      self.player.replaceCurrentItem(with: item)
      self.resumeOnMain()
    }
  }

  @objc(playTelegram:fileSize:mimeType:title:artist:)
  func playTelegram(_ fileId: NSNumber, fileSize: NSNumber, mimeType: String,
                    title: String, artist: String) {
    DispatchQueue.main.async {
      self.queue = []
      self.queueIndex = -1
      self.updateQueueCommands()
      self.playTelegramOnMain(fileId: fileId.intValue, fileSize: fileSize.int64Value,
                              mimeType: mimeType, title: title, artist: artist)
    }
  }

  @objc(setQueue:startId:)
  func setQueue(_ values: NSArray, startId: String) {
    DispatchQueue.main.async {
      let tracks = values.compactMap { ($0 as? [String: Any]).flatMap(QueueTrack.init) }
      self.queue = tracks
      self.queueIndex = tracks.firstIndex { $0.messageId == startId } ?? -1
      self.updateQueueCommands()
      if self.queueIndex >= 0 { self.playQueueIndexOnMain(self.queueIndex) }
    }
  }

  @objc(appendQueue:)
  func appendQueue(_ values: NSArray) {
    DispatchQueue.main.async {
      let known = Set(self.queue.map(\.messageId))
      self.queue += values.compactMap { ($0 as? [String: Any]).flatMap(QueueTrack.init) }
        .filter { !known.contains($0.messageId) }
      self.updateQueueCommands()
    }
  }

  @objc func next() { DispatchQueue.main.async { self.nextOnMain() } }
  @objc func previous() { DispatchQueue.main.async { self.previousOnMain() } }

  private func updateQueueCommands() {
    let commands = MPRemoteCommandCenter.shared()
    commands.nextTrackCommand.isEnabled = queueIndex >= 0 && queueIndex + 1 < queue.count
    commands.previousTrackCommand.isEnabled = queueIndex > 0
  }

  private func playQueueIndexOnMain(_ index: Int) {
    guard queue.indices.contains(index) else { return }
    queueIndex = index
    updateQueueCommands()
    let track = queue[index]
    playTelegramOnMain(fileId: track.fileId, fileSize: track.fileSize,
                       mimeType: track.mimeType, title: track.title, artist: track.artist)
  }

  private func nextOnMain() {
    if queueIndex + 1 < queue.count { playQueueIndexOnMain(queueIndex + 1) }
  }

  private func previousOnMain() {
    if player.currentTime().seconds > 3 { seekOnMain(0) }
    else if queueIndex > 0 { playQueueIndexOnMain(queueIndex - 1) }
    else { seekOnMain(0) }
  }

  private func playTelegramOnMain(fileId: Int, fileSize: Int64, mimeType: String,
                                  title: String, artist: String) {
    guard fileId > 0, fileSize > 0, TelopotifyTelegram.active != nil else {
      errorMessage = "Telegram audio is unavailable"
      return
    }
    do { try AVAudioSession.sharedInstance().setActive(true) }
    catch {
      errorMessage = "Audio session is unavailable: \(error.localizedDescription)"
      return
    }
    let ext = mimeType.contains("mp4") || mimeType.contains("m4a") ? "m4a" : "mp3"
    guard let url = URL(string: "telopotify-stream://audio/\(fileId).\(ext)") else {
      errorMessage = "Invalid audio source"
      return
    }
    let loader = TelegramStreamLoader(fileId: fileId, fileSize: fileSize, mimeType: mimeType)
    let asset = AVURLAsset(url: url)
    asset.resourceLoader.setDelegate(loader, queue: loader.queue)
    let item = AVPlayerItem(asset: asset)
    if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
    streamLoader = loader
    self.title = title
    self.artist = artist
    ended = false
    errorMessage = nil
    endObserver = NotificationCenter.default.addObserver(
      forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
    ) { [weak self] _ in
      guard let self else { return }
      if self.queueIndex >= 0 && self.queueIndex + 1 < self.queue.count {
        self.nextOnMain()
      } else {
        self.ended = true
        self.updateNowPlaying()
      }
    }
    player.replaceCurrentItem(with: item)
    resumeOnMain()
  }

  @objc func pause() { DispatchQueue.main.async { self.pauseOnMain() } }
  @objc func resume() { DispatchQueue.main.async { self.resumeOnMain() } }
  @objc func stop() {
    DispatchQueue.main.async {
      self.player.pause()
      self.player.replaceCurrentItem(with: nil)
      self.queue = []
      self.queueIndex = -1
      self.updateQueueCommands()
      self.streamLoader = nil
      self.ended = false
      self.errorMessage = nil
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
  }
  @objc func seek(_ seconds: Double) {
    DispatchQueue.main.async { self.seekOnMain(seconds) }
  }
  @objc func setVolume(_ value: Double) {
    DispatchQueue.main.async {
      guard value.isFinite else { return }
      self.player.volume = Float(min(1, max(0, value)))
    }
  }
  @objc func setSpeed(_ value: Double) {
    DispatchQueue.main.async {
      guard value.isFinite, (0.5...2).contains(value) else { return }
      self.desiredRate = Float(value)
      if self.player.rate != 0 { self.player.rate = self.desiredRate }
      self.updateNowPlaying()
    }
  }

  @objc(getSnapshot:rejecter:)
  func getSnapshot(_ resolve: @escaping RCTPromiseResolveBlock,
                   rejecter: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      let item = self.player.currentItem
      let position = self.player.currentTime().seconds
      let duration = item?.duration.seconds ?? 0
      let failure = self.errorMessage ?? item?.error?.localizedDescription ?? self.player.error?.localizedDescription
      let status: String
      if let failure { status = "error: \(failure)" }
      else if self.ended { status = "ended" }
      else if item == nil { status = "stopped" }
      else if item?.status == .unknown { status = "opening" }
      else if self.player.timeControlStatus == .waitingToPlayAtSpecifiedRate { status = "buffering" }
      else if self.player.timeControlStatus == .playing { status = "playing" }
      else { status = "paused" }
      resolve(["status": status,
               "messageId": self.queue.indices.contains(self.queueIndex) ? self.queue[self.queueIndex].messageId : "",
               "title": self.title, "artist": self.artist,
               "queueIndex": self.queueIndex, "queueCount": self.queue.count,
               "position": position.isFinite ? max(0, position) : 0,
               "duration": duration.isFinite ? max(0, duration) : 0])
    }
  }

  private func pauseOnMain() {
    player.pause()
    updateNowPlaying()
  }

  private func resumeOnMain() {
    guard player.currentItem != nil else { return }
    ended = false
    player.play()
    player.rate = desiredRate
    updateNowPlaying()
  }

  private func seekOnMain(_ seconds: Double) {
    guard seconds.isFinite, seconds >= 0, player.currentItem != nil else { return }
    player.seek(to: CMTime(seconds: seconds, preferredTimescale: 600)) { [weak self] _ in
      self?.updateNowPlaying()
    }
  }

  private func updateNowPlaying() {
    guard player.currentItem != nil else { return }
    var info: [String: Any] = [
      MPMediaItemPropertyTitle: title,
      MPMediaItemPropertyArtist: artist,
      MPNowPlayingInfoPropertyPlaybackRate: player.rate,
    ]
    let duration = player.currentItem?.duration.seconds ?? 0
    let position = player.currentTime().seconds
    if duration.isFinite && duration > 0 { info[MPMediaItemPropertyPlaybackDuration] = duration }
    if position.isFinite { info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = max(0, position) }
    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
  }

  private func handleInterruption(_ notification: Notification) {
    guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
    if type == .began {
      shouldResumeAfterInterruption = player.rate != 0
      pauseOnMain()
    } else if type == .ended {
      let options = AVAudioSession.InterruptionOptions(
        rawValue: notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
      if shouldResumeAfterInterruption && options.contains(.shouldResume) {
        try? AVAudioSession.sharedInstance().setActive(true)
        resumeOnMain()
      }
      shouldResumeAfterInterruption = false
    }
  }
}
