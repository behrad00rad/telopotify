#pragma once

#include <NativeModules.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Media.Core.h>
#include <winrt/Windows.Media.Playback.h>
#include <winrt/Windows.Media.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <mutex>
#include <string>

namespace winrt::TelopotifyApp {

// Windows-only transport. MediaPlayer handles HTTP range requests to the local bridge.
REACT_MODULE(TelopotifyAudio)
struct TelopotifyAudio {
  REACT_METHOD(play)
  void play(std::string url, std::string title, std::string artist) noexcept {
    try {
      if (!player) {
        player = Windows::Media::Playback::MediaPlayer();
        player.MediaFailed([this](auto const&, auto const& args) {
          std::scoped_lock lock(errorMutex);
          error = to_string(args.ErrorMessage());
        });
        player.MediaEnded([this](auto const&, auto const&) { ended.store(true); });
        player.MediaOpened([this](auto const&, auto const&) {
          try { player.PlaybackSession().PlaybackRate(desiredSpeed.load()); } catch (...) {}
        });
        player.Volume(desiredVolume);
        auto commands = player.CommandManager();
        commands.NextBehavior().EnablingRule(Windows::Media::Playback::MediaCommandEnablingRule::Always);
        commands.PreviousBehavior().EnablingRule(Windows::Media::Playback::MediaCommandEnablingRule::Always);
        commands.NextReceived([this](auto const&, auto const& args) {
          args.Handled(true);
          pendingCommand.store(1);
        });
        commands.PreviousReceived([this](auto const&, auto const& args) {
          args.Handled(true);
          pendingCommand.store(2);
        });
      }
      {
        std::scoped_lock lock(errorMutex);
        error.clear();
      }
      ended.store(false);
      playlist = Windows::Media::Playback::MediaPlaybackList();
      playlist.MaxPrefetchTime(std::chrono::duration_cast<Windows::Foundation::TimeSpan>(
          std::chrono::seconds(5)));
      playlist.Items().Append(MakeItem(url, title, artist));
      playlist.CurrentItemChanged([this](auto const& source, auto const&) {
        if (source.CurrentItemIndex() == 1) {
          ended.store(false);
          pendingCommand.store(3);
        }
      });
      player.Source(playlist);
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
    try { ended.store(false); pendingCommand.store(0); if (player) player.Source(nullptr); playlist = nullptr; } catch (...) {}
  }

  REACT_METHOD(setNext)
  void setNext(std::string url, std::string title, std::string artist) noexcept {
    try {
      if (!playlist) return;
      auto items = playlist.Items();
      if (playlist.CurrentItemIndex() == 1 && items.Size() > 1) items.RemoveAt(0);
      if (items.Size() > 1) items.RemoveAt(1);
      if (!url.empty()) items.Append(MakeItem(url, title, artist));
    } catch (winrt::hresult_error const& ex) { SetError(to_string(ex.message())); }
    catch (...) { SetError("Could not prepare the next song"); }
  }

  REACT_METHOD(setVolume)
  void setVolume(double value) noexcept {
    if (!std::isfinite(value)) return;
    desiredVolume = std::clamp(value, 0.0, 1.0);
    try { if (player) player.Volume(desiredVolume); } catch (...) {}
  }

  REACT_METHOD(setSpeed)
  void setSpeed(double value) noexcept {
    if (!std::isfinite(value) || value < 0.5 || value > 2.0) return;
    desiredSpeed.store(value);
    try { if (player) player.PlaybackSession().PlaybackRate(value); } catch (...) {}
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
    if (ended.load()) return "ended";
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

  REACT_SYNC_METHOD(takeMediaCommand)
  int takeMediaCommand() noexcept { return pendingCommand.exchange(0); }

 private:
  static Windows::Media::Playback::MediaPlaybackItem MakeItem(
      std::string const& url, std::string const& title, std::string const& artist) {
    auto item = Windows::Media::Playback::MediaPlaybackItem(
        Windows::Media::Core::MediaSource::CreateFromUri(Windows::Foundation::Uri(to_hstring(url))));
    auto display = item.GetDisplayProperties();
    display.Type(Windows::Media::MediaPlaybackType::Music);
    display.MusicProperties().Title(to_hstring(title));
    display.MusicProperties().Artist(to_hstring(artist));
    item.ApplyDisplayProperties(display);
    return item;
  }
  void SetError(std::string message) noexcept {
    std::scoped_lock lock(errorMutex);
    error = std::move(message);
  }
  Windows::Media::Playback::MediaPlayer player{nullptr};
  Windows::Media::Playback::MediaPlaybackList playlist{nullptr};
  std::atomic<bool> ended{false};
  std::atomic<int> pendingCommand{0};
  double desiredVolume{1.0};
  std::atomic<double> desiredSpeed{1.0};
  std::mutex errorMutex;
  std::string error;
};

} // namespace winrt::TelopotifyApp
