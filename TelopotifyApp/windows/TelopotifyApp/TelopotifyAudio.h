#pragma once

#include <NativeModules.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Media.Core.h>
#include <winrt/Windows.Media.Playback.h>
#include <chrono>
#include <cmath>
#include <mutex>
#include <string>

namespace winrt::TelopotifyApp {

// Windows-only transport. MediaPlayer handles HTTP range requests to the local bridge.
REACT_MODULE(TelopotifyAudio)
struct TelopotifyAudio {
  REACT_METHOD(play)
  void play(std::string url) noexcept {
    try {
      if (!player) {
        player = Windows::Media::Playback::MediaPlayer();
        player.MediaFailed([this](auto const&, auto const& args) {
          std::scoped_lock lock(errorMutex);
          error = to_string(args.ErrorMessage());
        });
      }
      {
        std::scoped_lock lock(errorMutex);
        error.clear();
      }
      auto uri = Windows::Foundation::Uri(to_hstring(url));
      player.Source(Windows::Media::Core::MediaSource::CreateFromUri(uri));
      player.Play();
    } catch (winrt::hresult_error const& ex) { SetError(to_string(ex.message())); }
    catch (...) { SetError("Could not start playback"); }
  }

  REACT_METHOD(resume)
  void resume() noexcept {
    try { if (player) player.Play(); } catch (...) {}
  }

  REACT_METHOD(pause)
  void pause() noexcept {
    try { if (player) player.Pause(); } catch (...) {}
  }

  REACT_METHOD(stop)
  void stop() noexcept {
    try { if (player) player.Source(nullptr); } catch (...) {}
  }

  REACT_METHOD(seek)
  void seek(double seconds) noexcept {
    try {
      if (player && std::isfinite(seconds) && seconds >= 0) {
        player.PlaybackSession().Position(std::chrono::duration_cast<Windows::Foundation::TimeSpan>(
            std::chrono::milliseconds(static_cast<int64_t>(seconds * 1000))));
      }
    } catch (winrt::hresult_error const& ex) { SetError(to_string(ex.message())); }
    catch (...) { SetError("Could not seek"); }
  }

  REACT_SYNC_METHOD(getStatus)
  std::string getStatus() noexcept {
    {
      std::scoped_lock lock(errorMutex);
      if (!error.empty()) return "error: " + error;
    }
    if (!player) return "stopped";
    try {
      switch (player.PlaybackSession().PlaybackState()) {
        case Windows::Media::Playback::MediaPlaybackState::Opening: return "opening";
        case Windows::Media::Playback::MediaPlaybackState::Buffering: return "buffering";
        case Windows::Media::Playback::MediaPlaybackState::Playing: return "playing";
        case Windows::Media::Playback::MediaPlaybackState::Paused: return "paused";
        default: return "stopped";
      }
    } catch (...) { return "error: Could not read playback status"; }
  }

  REACT_SYNC_METHOD(getPosition)
  double getPosition() noexcept {
    try { return player ? player.PlaybackSession().Position().count() / 10000000.0 : 0; }
    catch (...) { return 0; }
  }

  REACT_SYNC_METHOD(getDuration)
  double getDuration() noexcept {
    try { return player ? player.PlaybackSession().NaturalDuration().count() / 10000000.0 : 0; }
    catch (...) { return 0; }
  }

 private:
  void SetError(std::string message) noexcept {
    std::scoped_lock lock(errorMutex);
    error = std::move(message);
  }
  Windows::Media::Playback::MediaPlayer player{nullptr};
  std::mutex errorMutex;
  std::string error;
};

} // namespace winrt::TelopotifyApp
