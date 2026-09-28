import AVFoundation
import MediaPlayer
import React

// The player lives in iOS rather than JavaScript so locking the phone does not
// suspend the current song. A Telegram-backed AVAsset will be supplied here by
// the direct iOS library client once its TDLib adapter is installed.
@objc(TelopotifyAudio)
final class TelopotifyAudio: NSObject {
  private let player = AVPlayer()
  private var title = ""
  private var artist = ""
  private var desiredRate: Float = 1
  private var ended = false
  private var errorMessage: String?
  private var endObserver: NSObjectProtocol?
  private var interruptionObserver: NSObjectProtocol?
  private var shouldResumeAfterInterruption = false

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

  @objc func pause() { DispatchQueue.main.async { self.pauseOnMain() } }
  @objc func resume() { DispatchQueue.main.async { self.resumeOnMain() } }
  @objc func stop() {
    DispatchQueue.main.async {
      self.player.pause()
      self.player.replaceCurrentItem(with: nil)
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
