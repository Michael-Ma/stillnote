#include "stillnote_aec.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <deque>
#include <limits>
#include <map>
#include <memory>
#include <time.h>
#include <vector>

#include "api/audio/audio_processing.h"
#include "api/audio/echo_canceller3_config.h"
#include "modules/audio_processing/aec3/echo_canceller3.h"
#include "rtc_base/logging.h"

namespace {
constexpr int kFrame = 160;
constexpr int kLookahead = 4000;
constexpr int kTimeout = 8000;
constexpr int64_t kUnset = std::numeric_limits<int64_t>::min();

double CpuTime() {
  timespec t{};
  clock_gettime(CLOCK_THREAD_CPUTIME_ID, &t);
  return t.tv_sec + t.tv_nsec * 1e-9;
}
struct Timer {
  double &total;
  double start = CpuTime();
  ~Timer() { total += CpuTime() - start; }
};

// This extraction exposes EchoControlFactory, but has no public AEC3 factory.
class EchoCanceller3Factory final : public webrtc::EchoControlFactory {
 public:
  explicit EchoCanceller3Factory(bool linear) {
    // Matched filters are 32 blocks long, shifted by 24 blocks. Six filters
    // cover (32 + (6 - 1) * 24) * 64 / 16000 = 608 ms; eight cover 800 ms.
    // Downsampling cancels out in this computation. 800 ms >= the 700 ms goal.
    config_.delay.num_filters = 8;
    config_.filter.export_linear_aec_output = linear;
  }
  std::unique_ptr<webrtc::EchoControl> Create(int rate, int render, int capture) override {
    return std::make_unique<webrtc::EchoCanceller3>(config_, std::nullopt, rate, render, capture);
  }
 private:
  webrtc::EchoCanceller3Config config_;
};
struct Sample {
  float raw;
  bool bypass;
  int64_t index;
};
struct Output {
  std::vector<float> samples;
  int64_t index;
  size_t read = 0;
};
float Clean(float f) { return std::isfinite(f) ? std::clamp(f, -1.f, 1.f) : 0.f; }
}  // namespace

struct StillnoteAEC {
  explicit StillnoteAEC(bool linear) : linear(linear) { NewAPM(); }
  bool linear;
  rtc::scoped_refptr<webrtc::AudioProcessing> apm;
  webrtc::StreamConfig format{16000, 1};
  std::map<int64_t, std::vector<float>> reference;
  int64_t reference_end = kUnset;
  int64_t reverse_index = kUnset;
  int64_t capture_index = kUnset;
  int64_t capture_end = kUnset;
  std::deque<float> capture;
  std::deque<Sample> delayed;
  std::deque<Output> output;
  int startup = 0;
  bool active = false;
  int64_t last_reference_signal = kUnset;
  double erle_sum = 0;
  int64_t erle_count = 0;
  StillnoteAECStats stats{};

  void NewAPM() {
    webrtc::AudioProcessing::Config config;
    config.echo_canceller.enabled = true;
    config.echo_canceller.mobile_mode = false;
    config.echo_canceller.export_linear_aec_output = linear;
    config.high_pass_filter.enabled = true;
    config.noise_suppression.enabled = false;
    config.gain_controller1.enabled = false;
    config.gain_controller2.enabled = false;
    config.transient_suppression.enabled = false;
    apm = webrtc::AudioProcessingBuilder().SetConfig(config)
              .SetEchoControlFactory(std::make_unique<EchoCanceller3Factory>(linear)).Create();
    if (!apm || apm->Initialize() != 0) throw std::bad_alloc();
    // AEC3's block framer delays 64 samples, and the nonlinear overlap-add
    // adds another 64. Drop startup padding and drain this tail on flush.
    startup = linear ? 64 : 128;
    active = false;
    reverse_index = kUnset;
    last_reference_signal = kUnset;
  }

  int ReadReference(int64_t index, std::array<float, kFrame>& frame) {
    int present = 0;
    auto it = reference.upper_bound(index);
    if (it != reference.begin()) --it;
    for (; it != reference.end() && it->first < index + kFrame; ++it) {
      int64_t begin = std::max(index, it->first);
      int64_t end = std::min(index + kFrame, it->first + static_cast<int64_t>(it->second.size()));
      for (int64_t t = begin; t < end; ++t) {
        frame[t - index] = it->second[t - it->first];
        if (frame[t - index] != 0) last_reference_signal = t;
        ++present;
      }
    }
    return present;
  }

  void ReverseThrough(int64_t end) {
    while (reverse_index < end) {
      std::array<float, kFrame> frame{};
      stats.missing_reference_samples += kFrame - ReadReference(reverse_index, frame);
      const float* in = frame.data();
      float* out = frame.data();
      if (apm->ProcessReverseStream(&in, format, format, &out) != 0) ++stats.errors;
      reverse_index += kFrame;
    }
  }

  void Frame(int count) {
    ReverseThrough(capture_index + kLookahead + kFrame);
    std::array<float, kFrame> frame{}, processed{};
    for (int i = 0; i < count; ++i) {
      frame[i] = capture.front();
      capture.pop_front();
      // After the render history is silent for a second, there can be no
      // in-range echo left; preserve the microphone exactly in that case.
      bool bypass = last_reference_signal == kUnset || capture_index - last_reference_signal > 16000;
      delayed.push_back({frame[i], bypass, capture_index + i});
    }
    const float* in = frame.data();
    float* out = processed.data();
    int result = apm->ProcessStream(&in, format, format, &out);
    if (result != 0) ++stats.errors;
    if (linear) {
      std::array<std::array<float, kFrame>, 1> linear_output{};
      if (apm->GetLinearAecOutput(linear_output)) processed = linear_output[0];
      else ++stats.errors;
    }
    Output block{{}, 0};
    for (int i = 0; i < kFrame; ++i) {
      if (startup > 0) { --startup; continue; }
      if (delayed.empty()) break;
      Sample sample = delayed.front();
      delayed.pop_front();
      if (block.samples.empty()) block.index = sample.index;
      block.samples.push_back(sample.bypass || result != 0 ? sample.raw : Clean(processed[i]));
    }
    if (!block.samples.empty()) output.push_back(std::move(block));
    stats.processed_samples += count;
    capture_index += kFrame;
    auto metrics = apm->GetStatistics();
    if (metrics.delay_ms) stats.delay_ms = *metrics.delay_ms;
    if (metrics.echo_return_loss_enhancement && std::isfinite(*metrics.echo_return_loss_enhancement)) {
      erle_sum += *metrics.echo_return_loss_enhancement;
      stats.erle_db = erle_sum / ++erle_count;
    }
    // Keep one second of history for re-priming after a reset; memory is bounded
    // during live capture and the paced offline feeder.
    while (!reference.empty() && reference.begin()->first +
           static_cast<int64_t>(reference.begin()->second.size()) < capture_index - 16000)
      reference.erase(reference.begin());
  }

  void Process(bool flush) {
    if (!active) return;
    while (capture.size() >= kFrame || (flush && !capture.empty())) {
      const int64_t needed = capture_index + kLookahead + kFrame;
      if (!flush && reference_end < needed && capture.size() <= kTimeout) break;
      Frame(std::min<int>(kFrame, capture.size()));
    }
    if (flush) {
      // Zero padding drains both partial frames and AEC3's internal DSP delay.
      while (!delayed.empty()) Frame(0);
      active = false;
    }
  }
};

extern "C" {
StillnoteAEC* stillnote_aec_create(int linear_only) {
  rtc::LogMessage::LogToDebug(rtc::LS_NONE);
  try { return new StillnoteAEC(linear_only != 0); } catch (...) { return nullptr; }
}
void stillnote_aec_destroy(StillnoteAEC* a) { delete a; }
void stillnote_aec_reference(StillnoteAEC* a, const float* samples, int count, int64_t index) {
  if (!a || !samples || count <= 0) return;
  Timer timer{a->stats.cpu_seconds};
  // Never change reference audio already consumed by this AEC instance.
  int skip = a->reverse_index == kUnset ? 0 :
      static_cast<int>(std::clamp<int64_t>(a->reverse_index - index, 0, count));
  int64_t begin = index + skip;
  const int64_t end = index + count;
  auto previous = a->reference.upper_bound(begin);
  if (previous != a->reference.begin()) {
    --previous;
    begin = std::max(begin, previous->first + static_cast<int64_t>(previous->second.size()));
  }
  while (begin < end) {
    auto next = a->reference.lower_bound(begin);
    const int64_t limit = next == a->reference.end() ? end : std::min(end, next->first);
    if (limit > begin) {
      std::vector<float> data(samples + (begin - index), samples + (limit - index));
      for (float& f : data) f = Clean(f);
      a->reference.emplace(begin, std::move(data));
    }
    if (next == a->reference.end()) break;
    begin = std::max(limit, next->first + static_cast<int64_t>(next->second.size()));
  }
  a->reference_end = std::max(a->reference_end, index + count);
  a->Process(false);
}
void stillnote_aec_capture(StillnoteAEC* a, const float* samples, int count, int64_t index) {
  if (!a || !samples || count <= 0) return;
  Timer timer{a->stats.cpu_seconds};
  if (a->capture_end != kUnset && index != a->capture_end) {
    a->Process(true);
    a->NewAPM();
    ++a->stats.resets;
  }
  if (!a->active) {
    a->NewAPM();
    a->active = true;
    a->capture_index = index;
    a->reverse_index = index;
  }
  for (int i = 0; i < count; ++i) a->capture.push_back(Clean(samples[i]));
  a->capture_end = index + count;
  a->Process(false);
}
int stillnote_aec_pull(StillnoteAEC* a, float* out, int capacity, int64_t* index) {
  if (!a || !out || !index || capacity <= 0 || a->output.empty()) return 0;
  auto& block = a->output.front();
  const int count = std::min<size_t>(capacity, block.samples.size() - block.read);
  *index = block.index + block.read;
  std::copy_n(block.samples.data() + block.read, count, out);
  block.read += count;
  if (block.read == block.samples.size()) a->output.pop_front();
  return count;
}
void stillnote_aec_flush(StillnoteAEC* a) {
  if (!a) return;
  Timer timer{a->stats.cpu_seconds};
  a->Process(true);
}
void stillnote_aec_reset(StillnoteAEC* a) {
  if (!a) return;
  Timer timer{a->stats.cpu_seconds};
  a->Process(true);
  a->NewAPM();
  a->capture_end = kUnset;
  ++a->stats.resets;
}
void stillnote_aec_stats(StillnoteAEC* a, StillnoteAECStats* stats) {
  if (a && stats) *stats = a->stats;
}
}
