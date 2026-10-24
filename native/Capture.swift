// Every PCM buffer crossing queues is copied and then transferred to the main actor.
@preconcurrency import AVFoundation
import AppKit
import AudioToolbox
import CoreAudio
import EventKit
import Foundation
// Delegate references cross to the main actor only for identity checks; stream operations stay isolated.
@preconcurrency import ScreenCaptureKit
import Speech

var eventFile: FileHandle?
var eventObserver: (([String: Any]) -> Void)?
func emit(_ value: [String: Any]) {
  eventObserver?(value)
  guard JSONSerialization.isValidJSONObject(value),
    let data = try? JSONSerialization.data(withJSONObject: value),
    let line = String(data: data, encoding: .utf8)
  else { return }
  print(line)
  fflush(stdout)
  try? eventFile?.write(contentsOf: Data((line + "\n").utf8))
}
func problem(_ message: String) -> NSError {
  NSError(domain: "Stillnote", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}
extension Data {
  mutating func little<T: FixedWidthInteger>(_ value: T) {
    var little = value.littleEndian
    Swift.withUnsafeBytes(of: &little) { append(contentsOf: $0) }
  }
}

// The captured audio is durable independently of the recognizer. Canonical PCM WAV
// headers are checkpointed during recording, so a helper crash does not leave an empty file.
final class WAVWriter {
  let url: URL
  var handle: FileHandle?
  private(set) var frames: Int64 = 0
  private var checkpoint: Int64 = 0
  init(url: URL) throws {
    self.url = url
    guard
      FileManager.default.createFile(
        atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600])
    else { throw problem("Cannot create the local recording file.") }
    handle = try FileHandle(forWritingTo: url)
    try writeHeader()
  }
  func writeHeader() throws {
    guard let handle else { return }
    let bytes = frames * 2
    guard bytes <= Int64(UInt32.max) - 36 else {
      throw problem("Recording reached the WAV size limit.")
    }
    var header = Data("RIFF".utf8)
    header.little(UInt32(bytes + 36))
    header.append(Data("WAVEfmt ".utf8))
    header.little(UInt32(16))
    header.little(UInt16(1))
    header.little(UInt16(1))
    header.little(UInt32(16000))
    header.little(UInt32(32000))
    header.little(UInt16(2))
    header.little(UInt16(16))
    header.append(Data("data".utf8))
    header.little(UInt32(bytes))
    try handle.seek(toOffset: 0)
    try handle.write(contentsOf: header)
    try handle.seekToEnd()
    checkpoint = frames
  }
  func append(_ buffer: AVAudioPCMBuffer) throws {
    guard let handle, let samples = buffer.floatChannelData?[0] else { return }
    let count = Int(buffer.frameLength)
    var values = [Int16](repeating: 0, count: count)
    for i in 0..<count {
      let v = samples[i].isFinite ? max(-1, min(1, samples[i])) : 0
      values[i] = Int16((v * 32767).rounded()).littleEndian
    }
    try values.withUnsafeBytes { try handle.write(contentsOf: Data($0)) }
    frames += Int64(count)
    if frames - checkpoint >= 16000 {
      try writeHeader()
      try handle.synchronize()
    }
  }
  func close() throws {
    guard let handle else { return }
    try writeHeader()
    try handle.synchronize()
    try handle.close()
    self.handle = nil
  }
  deinit { try? close() }
}

@MainActor
final class RecognitionCancellation {
  var cancel: (() -> Void)?
}

@MainActor
final class RecognitionWindow {
  let id = UUID().uuidString
  let offset: TimeInterval
  let buffer = AVAudioPCMBuffer(
    pcmFormat: AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1)!,
    frameCapacity: 15 * 16000)!
  var quietFrames = 0
  var latest = ""
  var firstWordTime: TimeInterval = 0
  var finalized = false
  init(offset: TimeInterval) { self.offset = offset }
  var ready: Bool {
    buffer.frameLength == buffer.frameCapacity
      || (buffer.frameLength >= 8 * 16000 && quietFrames >= 4800)
  }
  func append(_ input: UnsafePointer<Float>, count available: Int) -> Int {
    let existing = Int(buffer.frameLength)
    var count = 0
    while count < available, existing + count < Int(buffer.frameCapacity) {
      quietFrames = abs(input[count]) < 0.003 ? quietFrames + 1 : 0
      count += 1
      if existing + count >= 8 * 16000 && quietFrames >= 4800 { break }
    }
    memcpy(
      buffer.floatChannelData![0].advanced(by: existing), input, count * MemoryLayout<Float>.size)
    buffer.frameLength += AVAudioFrameCount(count)
    return count
  }
}

// Apple recognition requests for the two captured inputs must not compete. Audio
// capture continues independently; this queue serializes only on-device inference.
@MainActor
final class SpeechJob {
  let key: String
  let window: RecognitionWindow
  let recognizer: SFSpeechRecognizer
  let context: [String]
  let control = RecognitionCancellation()
  let partial: (String, TimeInterval) -> Void
  let complete: (Result<(String, TimeInterval), Error>) -> Void
  var cancelled = false
  init(
    key: String, window: RecognitionWindow, recognizer: SFSpeechRecognizer, context: [String] = [],
    partial: @escaping (String, TimeInterval) -> Void,
    complete: @escaping (Result<(String, TimeInterval), Error>) -> Void
  ) {
    self.key = key
    self.window = window
    self.recognizer = recognizer
    self.context = context
    self.partial = partial
    self.complete = complete
  }
}

@MainActor
final class SpeechScheduler {
  static let shared = SpeechScheduler()
  var pending: [SpeechJob] = []
  var active: SpeechJob?
  var running = false
  var recognizers: [String: SFSpeechRecognizer] = [:]
  let testWorker: ((SpeechJob) async -> Void)?
  init(testWorker: ((SpeechJob) async -> Void)? = nil) { self.testWorker = testWorker }
  func recognizer(locale: String) throws -> SFSpeechRecognizer {
    if let cached = recognizers[locale] { return cached }
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)),
      recognizer.supportsOnDeviceRecognition, recognizer.isAvailable
    else {
      throw problem(
        "On-device recognition is unavailable for \(locale). Audio will still be saved. Install the language in macOS Dictation settings, then retry transcription."
      )
    }
    recognizers[locale] = recognizer
    return recognizer
  }
  func enqueue(_ job: SpeechJob) -> Bool {
    // Bounded memory if recognition falls behind; the original WAV remains durable.
    guard pending.count < 24 else { return false }
    pending.append(job)
    if !running {
      running = true
      Task { @MainActor in
        while !self.pending.isEmpty {
          let next = self.pending.removeFirst()
          self.active = next
          if let worker = self.testWorker { await worker(next) } else { await self.perform(next) }
          self.active = nil
        }
        self.running = false
      }
    }
    return true
  }
  func perform(_ job: SpeechJob) async {
    guard !job.cancelled else { return }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "stillnote-live-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    do {
      try FileManager.default.createDirectory(
        at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      let writer = try WAVWriter(url: directory.appendingPathComponent("chunk.wav"))
      try writer.append(job.window.buffer)
      try writer.close()
      let result = try await recognizeFile(
        writer.url, recognizer: job.recognizer,
        control: job.control, context: job.context, onPartial: job.partial)
      if !job.cancelled { job.complete(.success(result)) }
    } catch { if !job.cancelled { job.complete(.failure(error)) } }
  }
  func cancel(key: String) {
    let removed = pending.filter { $0.key == key }
    pending.removeAll { $0.key == key }
    for job in removed {
      job.cancelled = true
      job.complete(.failure(CancellationError()))
    }
    if let job = active, job.key == key {
      job.cancelled = true
      job.control.cancel?()
      job.complete(.failure(CancellationError()))
    }
  }
}

// Deterministic regression of the actual scheduler; no recognition request or
// audio device is opened. The worker is substituted, not the queue being tested.
@MainActor
func schedulerSelfTest() async throws {
  guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")) else {
    throw problem("Speech framework unavailable.")
  }
  var concurrent = 0
  var maximum = 0
  var order: [Int] = []
  var successes = 0
  var failures = 0
  let scheduler = SpeechScheduler(testWorker: { job in
    concurrent += 1
    maximum = max(maximum, concurrent)
    try? await Task.sleep(nanoseconds: 10_000_000)
    concurrent -= 1
    if !job.cancelled {
      order.append(Int(job.window.offset))
      job.complete(.success(("fixture", 0)))
    }
  })
  func job(_ index: Int, key: String) -> SpeechJob {
    SpeechJob(
      key: key, window: RecognitionWindow(offset: Double(index)), recognizer: recognizer,
      partial: { _, _ in },
      complete: { result in
        switch result {
        case .success: successes += 1
        case .failure: failures += 1
        }
      })
  }
  for index in 0..<24 {
    guard scheduler.enqueue(job(index, key: index % 2 == 0 ? "microphone" : "system")) else {
      throw problem("Scheduler rejected work below its limit.")
    }
  }
  guard !scheduler.enqueue(job(25, key: "overflow")) else {
    throw problem("Scheduler failed its backlog bound.")
  }
  scheduler.cancel(key: "system")
  let deadline = Date().addingTimeInterval(5)
  while scheduler.running && Date() < deadline { try? await Task.sleep(nanoseconds: 5_000_000) }
  guard !scheduler.running, maximum == 1, order == Array(stride(from: 0, to: 24, by: 2)),
    successes == 12, failures == 12
  else { throw problem("Scheduler serialization/order/cancellation regression.") }
  // Cancel work after it has become active; completion must not be delivered twice.
  guard scheduler.enqueue(job(30, key: "active")), scheduler.enqueue(job(31, key: "next")) else {
    throw problem("Scheduler did not resume after draining.")
  }
  while scheduler.active == nil { await Task.yield() }
  scheduler.cancel(key: "active")
  while scheduler.running && Date() < deadline { try? await Task.sleep(nanoseconds: 5_000_000) }
  guard !scheduler.running, maximum == 1, successes == 13, failures == 13, order.last == 31 else {
    throw problem("Active cancellation caused duplicate completion or blocked the queue.")
  }
  let voiced = [Float](repeating: 0.1, count: 16 * 16000)
  let quiet = [Float](repeating: 0, count: 8 * 16000)
  let cut = RecognitionWindow(offset: 0)
  _ = voiced.withUnsafeBufferPointer { cut.append($0.baseAddress!, count: 8 * 16000) }
  guard !cut.ready else { throw problem("Legacy window cut before silence.") }
  _ = quiet.withUnsafeBufferPointer { cut.append($0.baseAddress!, count: 4799) }
  guard !cut.ready else { throw problem("Legacy window cut before 300 ms of silence.") }
  _ = quiet.withUnsafeBufferPointer { cut.append($0.baseAddress!, count: 1) }
  guard cut.ready, cut.buffer.frameLength == 132800 else {
    throw problem("Legacy silence boundary regression.")
  }
  let hard = RecognitionWindow(offset: 0)
  let consumed = voiced.withUnsafeBufferPointer { hard.append($0.baseAddress!, count: $0.count) }
  guard hard.ready, consumed == 15 * 16000 else { throw problem("Legacy hard cap regression.") }
  let silent = RecognitionWindow(offset: 0)
  _ = quiet.withUnsafeBufferPointer { silent.append($0.baseAddress!, count: $0.count) }
  guard silent.ready, silent.buffer.frameLength == 8 * 16000 else {
    throw problem("Legacy minimum window regression.")
  }
  emit([
    "type": "scheduler-self-test", "status": "passed", "maximumConcurrentRecognition": maximum,
    "successfulJobs": successes, "cancelledJobs": failures, "backlogBound": 24,
    "speechRecognitionInvoked": false, "liveAudioInvoked": false, "silenceBoundaryChecks": 5,
  ])
}

@MainActor
protocol SpeechChannel: AnyObject {
  var errors: Int { get }
  var timeouts: Int { get }
  func append(_ buffer: AVAudioPCMBuffer, offset: TimeInterval)
  func finish() async
}

var recognitionEngine: String {
  if #available(macOS 26.0, *) { return "speechTranscriber" }
  return "legacy"
}
func contextHints(_ value: Any?) -> [String] {
  Array((value as? [String] ?? []).prefix(100)).map { String($0.prefix(100)) }
}
@MainActor
func speechChannel(source: String, locale: String, recordingId: String, context: [String])
  async throws -> any SpeechChannel
{
  if #available(macOS 26.0, *) {
    return try await ModernSpeechChannel(
      source: source, locale: locale, recordingId: recordingId, context: context)
  }
  return try LegacySpeechChannel(
    source: source, locale: locale, recordingId: recordingId, context: context)
}

@available(macOS 26.0, *)
@MainActor
final class ModernSpeechChannel: SpeechChannel {
  let source: String
  let recordingId: String
  let transcriber: SpeechTranscriber
  let analyzer: SpeechAnalyzer
  let format: AVAudioFormat
  var converter: AVAudioConverter?
  var continuation: AsyncStream<AnalyzerInput>.Continuation?
  var analysisTask: Task<Void, Never>?
  var resultsTask: Task<Void, Never>?
  var analysisDone = false
  var resultsDone = false
  var finishing = false
  var closed = false
  var failure: Error?
  var errors = 0
  var timeouts = 0
  var baseOffset: TimeInterval?
  var frames: Int64 = 0
  var pending: [Double: [String: Any]] = [:]
  var pendingEnds: [Double: Double] = [:]
  var segments: [[String: Any]] = []
  var progress: ((Double) -> Void)?
  let live: Bool
  init(source: String, locale: String, recordingId: String, context: [String], live: Bool = true)
    async throws
  {
    self.source = source
    self.recordingId = recordingId
    self.live = live
    guard SpeechTranscriber.isAvailable,
      let supported = await SpeechTranscriber.supportedLocale(
        equivalentTo: Locale(identifier: locale))
    else {
      throw problem("On-device recognition is unavailable for \(locale). Audio is still saved.")
    }
    transcriber = SpeechTranscriber(
      locale: supported, transcriptionOptions: [],
      reportingOptions: live ? [.volatileResults] : [], attributeOptions: [.audioTimeRange])
    // `AssetInventory.status` reports `.supported` for usable installed locales on macOS 26, so the
    // installed-locale list is the reliable signal (and matches what the `languages` op reports).
    let installed = await SpeechTranscriber.installedLocales.contains {
      $0.identifier(.bcp47) == supported.identifier(.bcp47)
    }
    guard installed else {
      throw problem(
        "Download the \(locale) language in Settings to enable transcription. Audio is still saved."
      )
    }
    analyzer = SpeechAnalyzer(modules: [transcriber])
    let hints = AnalysisContext()
    hints.contextualStrings[.general] = context
    try await analyzer.setContext(hints)
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
    else {
      throw problem("No compatible speech audio format is available.")
    }
    self.format = format
    try await analyzer.prepareToAnalyze(in: format)
    resultsTask = Task { @MainActor [weak self, transcriber] in
      do {
        for try await result in transcriber.results {
          guard let self, !self.closed else { break }
          self.receive(result)
        }
      } catch { self?.failed(error) }
      self?.resultsDone = true
    }
    if live {
      let sequence = AsyncStream<AnalyzerInput>(bufferingPolicy: .bufferingOldest(256)) {
        self.continuation = $0
      }
      analysisTask = Task { @MainActor [weak self, analyzer] in
        do {
          if let end = try await analyzer.analyzeSequence(sequence) {
            try await analyzer.finalizeAndFinish(through: end)
          } else {
            try await analyzer.finalizeAndFinishThroughEndOfInput()
          }
        } catch { self?.failed(error) }
        self?.analysisDone = true
      }
    }
  }
  deinit {
    continuation?.finish()
    analysisTask?.cancel()
    resultsTask?.cancel()
  }
  func failed(_ error: Error) {
    guard !closed, failure == nil else { return }
    failure = error
    errors += 1
    emit([
      "type": "warning", "recordingId": recordingId, "source": source,
      "message": "Recognition: \(error.localizedDescription). Original audio is preserved.",
    ])
    continuation?.finish()
  }
  func receive(_ result: SpeechTranscriber.Result) {
    let start = result.range.start.seconds
    let end = CMTimeRangeGetEnd(result.range).seconds
    let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
    guard start.isFinite, end.isFinite, !text.isEmpty else { return }
    // Revisions retain the phrase's ID even if its first word boundary shifts slightly.
    let key =
      pending.keys.filter {
        abs($0 - start) < 0.1 || (start < (pendingEnds[$0] ?? $0) && $0 < end)
      }.min { abs($0 - start) < abs($1 - start) } ?? start
    let id = pending[key]?["segmentId"] as? String ?? UUID().uuidString
    let event: [String: Any] = [
      "type": result.isFinal ? "segment" : "partial", "recordingId": recordingId,
      "segmentId": id, "source": source,
      "speaker": source == "microphone" ? "You" : "Meeting audio",
      "text": text, "timestamp": (baseOffset ?? 0) + start, "partial": !result.isFinal,
    ]
    if result.isFinal {
      pending.removeValue(forKey: key)
      pendingEnds.removeValue(forKey: key)
      segments.append(event)
    } else {
      pending[key] = event
      pendingEnds[key] = end
    }
    if live { emit(event) }
    progress?(end)
  }
  func yield(_ buffer: AVAudioPCMBuffer) {
    guard let continuation, buffer.frameLength > 0 else { return }
    let time = CMTime(value: frames, timescale: CMTimeScale(format.sampleRate))
    frames += Int64(buffer.frameLength)
    if case .dropped = continuation.yield(AnalyzerInput(buffer: buffer, bufferStartTime: time)) {
      failed(
        problem("Transcription is falling behind; retry from the saved recording after the meeting")
      )
    }
  }
  func append(_ buffer: AVAudioPCMBuffer, offset: TimeInterval) {
    guard !finishing, !closed, failure == nil else { return }
    if baseOffset == nil { baseOffset = offset }
    if buffer.format.isEqual(format) {
      if let copy = copyPCM(buffer) { yield(copy) }
      return
    }
    if converter == nil {
      converter = AVAudioConverter(from: buffer.format, to: format)
      converter?.downmix = true
      converter?.sampleRateConverterQuality = AVAudioQuality.max.rawValue
    }
    guard let converter else {
      failed(problem("Speech audio conversion failed"))
      return
    }
    let capacity =
      AVAudioFrameCount(
        ceil(Double(buffer.frameLength) * format.sampleRate / buffer.format.sampleRate)) + 64
    let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity)!
    var supplied = false
    var error: NSError?
    let status = converter.convert(to: output, error: &error) { _, status in
      if supplied {
        status.pointee = .noDataNow
        return nil
      }
      supplied = true
      status.pointee = .haveData
      return buffer
    }
    if status == .error {
      failed(error ?? problem("Speech audio conversion failed"))
    } else {
      yield(output)
    }
  }
  func preservePending() {
    for key in pending.keys.sorted() {
      var event = pending[key]!
      event["type"] = "segment"
      event["partial"] = true
      segments.append(event)
      if live { emit(event) }
    }
    pending.removeAll()
    pendingEnds.removeAll()
  }
  func finish() async {
    guard !finishing else { return }
    finishing = true
    if let converter, failure == nil {
      let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4096)!
      var error: NSError?
      let status = converter.convert(to: output, error: &error) { _, status in
        status.pointee = .endOfStream
        return nil
      }
      if status == .error {
        failed(error ?? problem("Speech audio conversion failed"))
      } else {
        yield(output)
      }
    }
    continuation?.finish()
    let deadline = Date().addingTimeInterval(29.5)
    while !(analysisDone && resultsDone), failure == nil, Date() < deadline {
      try? await Task.sleep(nanoseconds: 50_000_000)
    }
    if !(analysisDone && resultsDone), failure == nil {
      timeouts += 1
      emit([
        "type": "warning", "recordingId": recordingId, "source": source,
        "message":
          "Recognition finalization timed out. The latest partial and original audio are preserved.",
      ])
    }
    preservePending()
    closed = true
    analysisTask?.cancel()
    resultsTask?.cancel()
    // Do not let a stalled Speech XPC cancellation extend the 30-second stop bound.
    if !analysisDone || !resultsDone { Task { [analyzer] in await analyzer.cancelAndFinishNow() } }
  }
  func transcribeFile(_ file: AVAudioFile, offset: Double) async throws -> [[String: Any]] {
    baseOffset = offset
    do {
      if let end = try await analyzer.analyzeSequence(from: file) {
        try await analyzer.finalizeAndFinish(through: end)
      } else {
        try await analyzer.finalizeAndFinishThroughEndOfInput()
      }
      analysisDone = true
      await finish()
      if let failure { throw failure }
      if timeouts > 0 {
        throw problem("File transcription finalization timed out. Retry from the saved audio.")
      }
      return segments
    } catch {
      closed = true
      resultsTask?.cancel()
      Task { [analyzer] in await analyzer.cancelAndFinishNow() }
      throw error
    }
  }
}

func localeNames(_ locales: [Locale]) -> [String] {
  Array(Set(locales.map { $0.identifier.replacingOccurrences(of: "_", with: "-") })).sorted()
}
@MainActor
func languages() async -> [String: Any] {
  if #available(macOS 26.0, *) {
    return [
      "type": "languages", "engine": recognitionEngine,
      "supported": localeNames(await SpeechTranscriber.supportedLocales),
      "installed": localeNames(await SpeechTranscriber.installedLocales),
    ]
  }
  let locales = localeNames(
    SFSpeechRecognizer.supportedLocales().filter {
      SFSpeechRecognizer(locale: $0)?.supportsOnDeviceRecognition == true
    })
  return ["type": "languages", "engine": "legacy", "supported": locales, "installed": locales]
}
@MainActor
func installLanguage(_ locale: String) async throws {
  guard #available(macOS 26.0, *) else {
    throw problem("Install this language in macOS Dictation settings, then retry.")
  }
  guard
    let supported = await SpeechTranscriber.supportedLocale(
      equivalentTo: Locale(identifier: locale))
  else {
    throw problem("This language is not supported by on-device transcription.")
  }
  let module = SpeechTranscriber(
    locale: supported, transcriptionOptions: [], reportingOptions: [],
    attributeOptions: [.audioTimeRange])
  try await AssetInventory.reserve(locale: supported)
  var lastProgress = Date.distantPast
  if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
    let polling = Task { @MainActor in
      while !Task.isCancelled {
        lastProgress = Date()
        emit([
          "type": "language-progress", "locale": locale,
          "fraction": max(0, min(1, request.progress.fractionCompleted)),
        ])
        do { try await Task.sleep(nanoseconds: 250_000_000) } catch { break }
      }
    }
    defer { polling.cancel() }
    try await request.downloadAndInstall()
    polling.cancel()
  }
  let remaining = 0.25 - Date().timeIntervalSince(lastProgress)
  if remaining > 0 { try await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000)) }
  emit(["type": "language-progress", "locale": locale, "fraction": 1])
  emit([
    "type": "language-installed", "locale": locale,
    "installed": localeNames(await SpeechTranscriber.installedLocales),
  ])
}

@MainActor
final class LegacySpeechChannel: SpeechChannel {
  let source: String
  let speaker: String
  let recordingId: String
  let recognizer: SFSpeechRecognizer
  let context: [String]
  var key: String { recordingId + ":" + source }
  var current: RecognitionWindow?
  var windows: [RecognitionWindow] = []
  var finishing = false
  var errors = 0
  var timeouts = 0
  init(source: String, locale: String, recordingId: String, context: [String]) throws {
    self.source = source
    speaker = source == "microphone" ? "You" : "Meeting audio"
    self.recordingId = recordingId
    self.context = context
    recognizer = try SpeechScheduler.shared.recognizer(locale: locale)
  }
  func append(_ buffer: AVAudioPCMBuffer, offset: TimeInterval) {
    guard !finishing, let input = buffer.floatChannelData?[0] else { return }
    var consumed = 0
    while consumed < Int(buffer.frameLength) {
      let window = current ?? RecognitionWindow(offset: offset + Double(consumed) / 16000)
      current = window
      consumed += window.append(
        input.advanced(by: consumed), count: Int(buffer.frameLength) - consumed)
      if window.ready {
        submit(window)
        current = nil
      }
    }
  }
  func submit(_ window: RecognitionWindow) {
    guard window.buffer.frameLength > 0 else { return }
    windows.append(window)
    let job = SpeechJob(
      key: key, window: window, recognizer: recognizer, context: context,
      partial: { [weak self, weak window] text, time in
        guard let self, let window, !window.finalized else { return }
        window.latest = text
        window.firstWordTime = time
        emit([
          "type": "partial", "recordingId": self.recordingId, "segmentId": window.id,
          "source": self.source, "speaker": self.speaker, "text": text,
          "timestamp": window.offset + time, "partial": true,
        ])
      },
      complete: { [weak self, weak window] result in
        guard let self, let window, !window.finalized else { return }
        switch result {
        case .success(let value):
          if !value.0.isEmpty {
            window.latest = value.0
            window.firstWordTime = value.1
          }
          self.finalize(window, partial: value.0.isEmpty && !window.latest.isEmpty)
        case .failure(let error):
          self.errors += 1
          if !(error is CancellationError) {
            emit([
              "type": "warning", "recordingId": self.recordingId, "source": self.source,
              "message":
                "\(self.speaker) recognition: \(error.localizedDescription). Original audio is preserved.",
            ])
          }
          self.finalize(window, partial: true)
        }
      })
    if !SpeechScheduler.shared.enqueue(job) {
      errors += 1
      emit([
        "type": "warning", "recordingId": recordingId, "source": source,
        "message":
          "Transcription is falling behind. Audio is still being saved; retry transcription from the recording after the meeting.",
      ])
      finalize(window, partial: true)
    }
  }
  func finalize(_ window: RecognitionWindow, partial: Bool) {
    guard !window.finalized else { return }
    window.finalized = true
    if !window.latest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      emit([
        "type": "segment", "recordingId": recordingId, "segmentId": window.id,
        "source": source, "speaker": speaker, "text": window.latest,
        "timestamp": window.offset + window.firstWordTime, "partial": partial,
      ])
    }
    windows.removeAll { $0.finalized }
  }
  func finish() async {
    finishing = true
    if let window = current {
      submit(window)
      current = nil
    }
    let deadline = Date().addingTimeInterval(30)
    while !windows.isEmpty && Date() < deadline { try? await Task.sleep(nanoseconds: 100_000_000) }
    if !windows.isEmpty {
      timeouts += windows.count
      SpeechScheduler.shared.cancel(key: key)
      for window in windows { finalize(window, partial: true) }
    }
  }
}

// Each source is normalized explicitly. Feeding changing/stereo hardware formats
// directly into recognition is avoided; the exact same samples are saved and recognized.
@MainActor
final class AudioTrack {
  let source: String
  let recordingId: String
  let start: Date
  let writer: WAVWriter
  let format = AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1)!
  var converter: AVAudioConverter?
  var inputFormat: AVAudioFormat?
  var speech: SpeechChannel?
  var startOffset: TimeInterval?
  var lastLevel = Date.distantPast
  var sumSquares: Double = 0
  var peak: Double = 0
  var signalFrames: Int64 = 0
  var closed = false
  var events = true
  var captureError: String?
  var deviceName = ""
  var quietFrames: Int64 = 0
  var silent = false
  var lastSignal = Date()
  var lastBuffer = Date()
  var padOnNextBuffer = false
  init(source: String, recordingId: String, directory: URL, start: Date) throws {
    self.source = source
    self.recordingId = recordingId
    self.start = start
    writer = try WAVWriter(
      url: directory.appendingPathComponent(
        source == "microphone" ? "microphone.wav" : "system.wav"))
  }
  func accept(_ buffer: AVAudioPCMBuffer, capturedAt: Date? = nil) {
    guard !closed else { return }
    do { try process(buffer, capturedAt: capturedAt) } catch {
      captureError = error.localizedDescription
      emit([
        "type": "warning", "recordingId": recordingId, "source": source,
        "message": "Cannot save \(source) audio: \(error.localizedDescription)",
      ])
      closed = true
      try? writer.close()
    }
  }
  func process(_ buffer: AVAudioPCMBuffer, capturedAt: Date? = nil) throws {
    guard buffer.frameLength > 0 else { return }
    let elapsed = max(0, (capturedAt ?? Date()).timeIntervalSince(start))
    if padOnNextBuffer {
      try pad(to: elapsed)
      padOnNextBuffer = false
    }
    lastBuffer = Date()
    if startOffset == nil { startOffset = elapsed }
    if inputFormat == nil || !inputFormat!.isEqual(buffer.format) {
      converter = AVAudioConverter(from: buffer.format, to: format)
      converter?.downmix = true
      converter?.sampleRateConverterQuality = AVAudioQuality.max.rawValue
      inputFormat = buffer.format
    }
    guard let converter else { throw problem("Unsupported input audio format.") }
    let capacity =
      AVAudioFrameCount(ceil(Double(buffer.frameLength) * 16000 / buffer.format.sampleRate)) + 64
    let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity)!
    var supplied = false
    var error: NSError?
    let status = converter.convert(to: output, error: &error) { _, inputStatus in
      if !supplied {
        supplied = true
        inputStatus.pointee = .haveData
        return buffer
      }
      inputStatus.pointee = .noDataNow
      return nil
    }
    if status == .error { throw error ?? problem("Audio normalization failed.") }
    if output.frameLength > 0 { try save(output) }
  }
  func save(_ buffer: AVAudioPCMBuffer) throws {
    guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
    let offset = (startOffset ?? 0) + Double(writer.frames) / 16000
    var squares: Double = 0
    var localPeak: Double = 0
    for i in 0..<Int(buffer.frameLength) {
      let sample = Double(samples[i])
      if sample.isFinite {
        squares += sample * sample
        localPeak = max(localPeak, abs(sample))
      }
    }
    let rms = sqrt(squares / Double(buffer.frameLength))
    sumSquares += squares
    peak = max(peak, localPeak)
    if rms > 0.005 { signalFrames += Int64(buffer.frameLength) }
    if localPeak < 0.003 {
      quietFrames += Int64(buffer.frameLength)
      if quietFrames >= 6 * 16000 { reportSilence() }
    } else {
      quietFrames = 0
      lastSignal = Date()
      if silent {
        silent = false
        if events { emit(["type": "source-signal", "recordingId": recordingId, "source": source]) }
      }
    }
    try writer.append(buffer)
    speech?.append(buffer, offset: offset)
    if events && Date().timeIntervalSince(lastLevel) >= 0.5 {
      lastLevel = Date()
      emit([
        "type": "audio-level", "recordingId": recordingId, "source": source, "rms": rms,
        "peak": localPeak, "seconds": Double(writer.frames) / 16000,
      ])
    }
  }
  func reportSilence() {
    guard !silent, !closed else { return }
    silent = true
    if events {
      emit([
        "type": "source-silent", "recordingId": recordingId, "source": source, "device": deviceName,
      ])
    }
  }
  func pad(to elapsed: TimeInterval) throws {
    if startOffset == nil { startOffset = 0 }
    var missing = max(0, Int64((elapsed - (startOffset ?? 0)) * 16000) - writer.frames)
    while missing > 0 {
      let count = AVAudioFrameCount(min(missing, 16000))
      let silence = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: count)!
      silence.frameLength = count
      memset(silence.floatChannelData![0], 0, Int(count) * MemoryLayout<Float>.size)
      try save(silence)
      missing -= Int64(count)
    }
  }
  func closeAudio() throws {
    guard !closed else { return }
    if let converter {
      let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1024)!
      var error: NSError?
      let status = converter.convert(to: output, error: &error) { _, status in
        status.pointee = .endOfStream
        return nil
      }
      if status != .error && output.frameLength > 0 { try save(output) }
    }
    try writer.close()
    closed = true
  }
  func metadata() -> [String: Any] {
    let bytes =
      (try? FileManager.default.attributesOfItem(atPath: writer.url.path)[.size] as? NSNumber)?
      .int64Value ?? 0
    return [
      "source": source, "fileName": writer.url.lastPathComponent,
      "duration": Double(writer.frames) / 16000, "sampleRate": 16000, "channels": 1, "bytes": bytes,
      "startOffset": startOffset ?? 0,
    ]
  }
  func stats() -> [String: Any] {
    [
      "sampleCount": writer.frames, "signalSeconds": Double(signalFrames) / 16000,
      "rms": writer.frames > 0 ? sqrt(sumSquares / Double(writer.frames)) : 0, "peak": peak,
      "recognitionErrors": speech?.errors ?? 0, "recognitionTimeouts": speech?.timeouts ?? 0,
      "inputSampleRate": inputFormat?.sampleRate ?? 0, "captureError": captureError ?? "",
    ]
  }
}

func copyPCM(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
  guard let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength)
  else { return nil }
  copy.frameLength = buffer.frameLength
  let source = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
  let target = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
  for i in 0..<min(source.count, target.count) {
    if let src = source[i].mData, let dst = target[i].mData {
      memcpy(dst, src, min(Int(source[i].mDataByteSize), Int(target[i].mDataByteSize)))
    }
  }
  return copy
}

struct InputDevice {
  let id: AudioDeviceID
  let uid: String
  let name: String
  let isDefault: Bool
  let transport: String
  var identity: [String: String] { ["uid": uid, "name": name] }
  var json: [String: Any] {
    ["uid": uid, "name": name, "isDefault": isDefault, "transport": transport]
  }
}
func audioNumber(
  _ object: AudioObjectID, _ selector: AudioObjectPropertySelector,
  scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
) -> UInt32 {
  var address = AudioObjectPropertyAddress(
    mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
  var value: UInt32 = 0
  var size = UInt32(MemoryLayout<UInt32>.size)
  guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr else {
    return 0
  }
  return value
}
func audioString(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String {
  var address = AudioObjectPropertyAddress(
    mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var value: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr else {
    return ""
  }
  return value?.takeRetainedValue() as String? ?? ""
}
func audioIDs(
  _ object: AudioObjectID, _ selector: AudioObjectPropertySelector,
  scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
) -> [UInt32] {
  var address = AudioObjectPropertyAddress(
    mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(object, &address, 0, nil, &size) == noErr, size > 0 else {
    return []
  }
  var values = [UInt32](repeating: 0, count: Int(size) / MemoryLayout<UInt32>.size)
  let status = values.withUnsafeMutableBytes {
    AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0.baseAddress!)
  }
  return status == noErr ? values : []
}
func currentDeviceID(_ input: AVAudioInputNode) -> AudioDeviceID? {
  guard let unit = input.audioUnit else { return nil }
  var id = AudioDeviceID(0)
  var size = UInt32(MemoryLayout<AudioDeviceID>.size)
  let status = AudioUnitGetProperty(
    unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &id, &size)
  return status == noErr ? id : nil
}
func inputDevices() -> [InputDevice] {
  let system = AudioObjectID(kAudioObjectSystemObject)
  let defaultID = audioNumber(system, kAudioHardwarePropertyDefaultInputDevice)
  return audioIDs(system, kAudioHardwarePropertyDevices).compactMap { id in
    guard !audioIDs(id, kAudioDevicePropertyStreams, scope: kAudioDevicePropertyScopeInput).isEmpty
    else { return nil }
    let transport: String
    switch audioNumber(id, kAudioDevicePropertyTransportType) {
    case kAudioDeviceTransportTypeBuiltIn: transport = "built-in"
    case kAudioDeviceTransportTypeUSB: transport = "usb"
    case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE:
      transport = "bluetooth"
    case kAudioDeviceTransportTypeVirtual: transport = "virtual"
    case kAudioDeviceTransportTypeAggregate: transport = "aggregate"
    default: transport = "other"
    }
    return InputDevice(
      id: id, uid: audioString(id, kAudioDevicePropertyDeviceUID),
      name: audioString(id, kAudioObjectPropertyName), isDefault: id == defaultID,
      transport: transport)
  }.sorted { $0.name < $1.name }
}
@MainActor
final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
  var engine: AVAudioEngine?
  var stream: SCStream?
  var tracks: [String: AudioTrack] = [:]
  var started: Date?
  var recordingId = ""
  var operation = 0
  var isStarting = false
  var stopping = false
  var inputUID: String?
  var microphoneDevice: InputDevice?
  var echoMode = "auto"
  var echoEnabled = false
  var configurationObserver: NSObjectProtocol?
  var monitoringTask: Task<Void, Never>?
  var restarting = false
  var tapInstalled = false
  var microphoneGeneration = 0
  var tapFormat: AVAudioFormat?
  var rebuilds: [Date] = []
  nonisolated let audioQueue = DispatchQueue(label: "local.stillnote.audio")
  nonisolated let pendingAudio = DispatchGroup()
  func start(
    locale: String, includeSystem: Bool, directory: URL, id: String, inputDevice: String?,
    context: [String], echoCancellation: String
  ) async throws {
    guard engine == nil, started == nil, !isStarting, !stopping else {
      throw problem("Already recording or finishing a recording.")
    }
    operation += 1
    let generation = operation
    isStarting = true
    recordingId = id
    inputUID = inputDevice
    echoMode = echoCancellation
    defer { if generation == operation { isStarting = false } }
    guard await AVCaptureDevice.requestAccess(for: .audio) else {
      throw problem(
        "Allow Microphone access for Stillnote in System Settings → Privacy & Security.")
    }
    guard generation == operation else { throw CancellationError() }
    var speechAllowed = true
    if #available(macOS 26.0, *) {
    } else {
      var status = SFSpeechRecognizer.authorizationStatus()
      if status == .notDetermined {
        status = await withCheckedContinuation { c in
          SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
        }
      }
      speechAllowed = status == .authorized
      if !speechAllowed {
        warning(
          "Speech Recognition permission is unavailable. Audio is still saved; enable permission and retry transcription later."
        )
      }
    }
    guard generation == operation else { throw CancellationError() }
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let start = Date()
    started = start
    rebuilds = []
    tracks = [:]
    let mic = try AudioTrack(
      source: "microphone", recordingId: id, directory: directory, start: start)
    tracks["microphone"] = mic
    if speechAllowed {
      do {
        mic.speech = try await speechChannel(
          source: "microphone", locale: locale, recordingId: id, context: context)
      } catch {
        emit(["type": "warning", "recordingId": id, "message": error.localizedDescription])
      }
    }
    guard generation == operation else {
      await mic.speech?.finish()
      throw CancellationError()
    }
    let device = try startMicrophone()
    startMonitoring()
    var systemActive = false
    var sources: [String: [String: Any]] = [
      "microphone": ["status": "recording", "device": device.identity],
      "system": ["status": includeSystem ? "starting" : "disabled"],
    ]
    if includeSystem {
      do {
        let content = try await SCShareableContent.excludingDesktopWindows(
          false, onScreenWindowsOnly: true)
        guard generation == operation else { throw CancellationError() }
        guard let display = content.displays.first else {
          throw problem("No display is available for system-audio capture.")
        }
        let ownApps = content.applications.filter {
          $0.processID == getppid() || $0.bundleIdentifier.hasPrefix("local.stillnote.app")
        }
        let filter = SCContentFilter(
          display: display, excludingApplications: ownApps, exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 48000
        config.channelCount = 2
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        let track = try AudioTrack(
          source: "system", recordingId: id, directory: directory, start: start)
        tracks["system"] = track
        if speechAllowed {
          do {
            track.speech = try await speechChannel(
              source: "system", locale: locale, recordingId: id, context: context)
          } catch {
            emit(["type": "warning", "recordingId": id, "message": error.localizedDescription])
          }
        }
        guard generation == operation else {
          await track.speech?.finish()
          throw CancellationError()
        }
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)
        self.stream = stream
        try await stream.startCapture()
        guard generation == operation else {
          try? await stream.stopCapture()
          throw CancellationError()
        }
        guard self.stream === stream else {
          throw problem("System-audio capture stopped while starting.")
        }
        systemActive = true
        sources["system"] = ["status": "recording"]
      } catch {
        if generation != operation { throw CancellationError() }
        if let failedStream = self.stream {
          self.stream = nil
          try? await failedStream.stopCapture()
        }
        sources["system"] = ["status": "unavailable", "message": error.localizedDescription]
        // A denial needs the user, not a retry: say what to change and let the app link to it.
        let nsError = error as NSError
        if nsError.domain == SCStreamErrorDomain,
          nsError.code == SCStreamError.Code.userDeclined.rawValue
        {
          emit([
            "type": "warning", "recordingId": id, "permission": "screen-recording",
            "message":
              "Meeting audio isn’t being recorded because macOS hasn’t allowed Stillnote to capture it; your microphone is still recording. Turn on Stillnote in Screen & System Audio Recording, then quit and reopen Stillnote. If it’s already on, remove it with − and allow it again.",
          ])
        } else {
          emit([
            "type": "warning", "recordingId": id,
            "message":
              "Microphone capture continues, but system audio is unavailable: \(error.localizedDescription). Check Screen & System Audio Recording permission.",
          ])
        }
      }
    }
    guard generation == operation else { throw CancellationError() }
    sources["microphone"]?["device"] = (microphoneDevice ?? device).identity
    emit([
      "type": "started", "recordingId": id, "systemAudio": systemActive, "sources": sources,
      "startedAt": start.timeIntervalSince1970 * 1000,
      "engine": recognitionEngine, "echoCancellation": echoEnabled,
    ])
  }
  func warning(_ message: String) {
    emit(["type": "warning", "recordingId": recordingId, "message": message])
  }
  func startMicrophone(allowVoiceProcessing: Bool = true) throws -> InputDevice {
    let devices = inputDevices()
    let requested = devices.first { $0.uid == inputUID }
    if inputUID != nil && requested == nil {
      warning("The selected microphone is missing. Using the default input device.")
    }
    guard var device = requested ?? devices.first(where: { $0.isDefault }) else {
      throw problem(
        "No microphone input is available. Connect a microphone; capture will retry automatically.")
    }
    let engine = AVAudioEngine()
    self.engine = engine
    let input = engine.inputNode
    func select(_ device: InputDevice) throws {
      guard let unit = input.audioUnit else {
        throw problem("Microphone audio unit is unavailable.")
      }
      var id = device.id
      let status = AudioUnitSetProperty(
        unit, kAudioOutputUnitProperty_CurrentDevice,
        kAudioUnitScope_Global, 0, &id, UInt32(MemoryLayout<AudioDeviceID>.size))
      guard status == noErr else {
        throw problem("Cannot select microphone \(device.name) (\(status)).")
      }
    }
    // Selecting a device the unit already uses still posts a configuration change; skip it.
    do { if currentDeviceID(input) != device.id { try select(device) } } catch {
      guard let fallback = devices.first(where: { $0.isDefault }), fallback.id != device.id else {
        throw error
      }
      warning("\(error.localizedDescription) Using the default input device.")
      device = fallback
      try select(device)
    }
    echoEnabled = false
    // AVAudioEngine voice processing fails to start on some Macs (-10875) and its teardown can
    // reset the input device mid-meeting, so it only runs when explicitly turned on.
    if allowVoiceProcessing && echoMode == "on" {
      do {
        try input.setVoiceProcessingEnabled(true)
        if #available(macOS 14.0, *) {
          input.voiceProcessingOtherAudioDuckingConfiguration =
            AVAudioVoiceProcessingOtherAudioDuckingConfiguration(
              enableAdvancedDucking: false, duckingLevel: .min)
        }
        // Voice processing can replace the I/O unit; reapply the selected device.
        if currentDeviceID(input) != device.id { try select(device) }
        echoEnabled = input.isVoiceProcessingEnabled
      } catch {
        warning(
          "Echo cancellation could not be enabled: \(error.localizedDescription). Continuing without it."
        )
        removeMicrophone()
        return try startMicrophone(allowVoiceProcessing: false)
      }
    }
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      throw problem("Microphone input format is unavailable.")
    }
    let id = recordingId
    microphoneGeneration += 1
    let generation = microphoneGeneration
    let pending = pendingAudio
    input.installTap(onBus: 0, bufferSize: 4096, format: format) {
      [weak self, pending] buffer, time in
      pending.enter()
      let capturedAt = Date().addingTimeInterval(
        time.isHostTimeValid
          ? AVAudioTime.seconds(forHostTime: time.hostTime)
            - AVAudioTime.seconds(forHostTime: mach_absolute_time())
          : -Double(buffer.frameLength) / buffer.format.sampleRate)
      guard let copy = copyPCM(buffer) else {
        pending.leave()
        return
      }
      DispatchQueue.main.async {
        defer { pending.leave() }
        guard let self, self.recordingId == id, self.microphoneGeneration == generation else {
          return
        }
        self.tracks["microphone"]?.accept(copy, capturedAt: capturedAt)
      }
    }
    tapInstalled = true
    tapFormat = format
    // The voice-processing I/O unit only initializes with a complete input → output path;
    // route the input through a muted mixer so nothing is played back.
    if echoEnabled {
      engine.connect(input, to: engine.mainMixerNode, format: format)
      engine.mainMixerNode.outputVolume = 0
    }
    do { try engine.start() } catch {
      guard echoEnabled, allowVoiceProcessing else { throw error }
      warning(
        "Echo cancellation could not start: \(error.localizedDescription). Continuing without it.")
      removeMicrophone()
      return try startMicrophone(allowVoiceProcessing: false)
    }
    microphoneDevice = device
    tracks["microphone"]?.deviceName = device.name
    tracks["microphone"]?.lastBuffer = Date()
    configurationObserver = NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
    ) { [weak self, weak engine] _ in
      Task { @MainActor in
        guard let self, let engine, self.engine === engine else { return }
        self.configurationChanged(engine)
      }
    }
    return device
  }
  func removeMicrophone() {
    if let configurationObserver {
      NotificationCenter.default.removeObserver(configurationObserver)
    }
    configurationObserver = nil
    engine?.stop()
    if tapInstalled { engine?.inputNode.removeTap(onBus: 0) }
    tapInstalled = false
    engine = nil
  }
  // AVAudioEngine posts configuration changes for benign reasons too (including its own start).
  // Rebuild only when the device or format really changed, and announce only a new device.
  func configurationChanged(_ engine: AVAudioEngine) {
    guard !stopping, !restarting, started != nil else { return }
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    let sameDevice = currentDeviceID(input) == microphoneDevice?.id
    let sameFormat =
      tapFormat.map { $0.sampleRate == format.sampleRate && $0.channelCount == format.channelCount }
      ?? false
    if sameDevice && sameFormat {
      if engine.isRunning { return }
      tracks["microphone"]?.padOnNextBuffer = true
      if (try? engine.start()) != nil { return }
    }
    restartMicrophone(announce: !sameDevice)
  }
  func restartMicrophone(announce: Bool = true) {
    guard !stopping, !restarting, started != nil else { return }
    // A device that keeps resetting must not turn into a rebuild loop that drops the audio.
    rebuilds = rebuilds.filter { Date().timeIntervalSince($0) < 10 } + [Date()]
    guard rebuilds.count <= 3 else {
      if rebuilds.count == 4 {
        warning(
          "The microphone keeps resetting. Check the input device in Settings › Recording.")
      }
      return
    }
    restarting = true
    defer { restarting = false }
    removeMicrophone()
    tracks["microphone"]?.converter = nil
    tracks["microphone"]?.inputFormat = nil
    tracks["microphone"]?.padOnNextBuffer = true
    do {
      let device = try startMicrophone()
      if announce {
        emit([
          "type": "device-changed", "recordingId": recordingId, "source": "microphone",
          "device": device.identity,
        ])
        warning(
          "Microphone input restarted on \(device.name). The capture gap is padded with silence.")
      }
      emit([
        "type": "recording-status", "recordingId": recordingId,
        "sources": ["microphone": ["status": "recording", "device": device.identity]],
      ])
    } catch {
      removeMicrophone()
      warning("Microphone restart failed: \(error.localizedDescription). Retrying in two seconds.")
      emit([
        "type": "recording-status", "recordingId": recordingId,
        "sources": [
          "microphone": ["status": "unavailable", "message": error.localizedDescription]
        ],
      ])
    }
  }
  func startMonitoring() {
    monitoringTask = Task { @MainActor [weak self] in
      while !Task.isCancelled {
        do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { break }
        guard let self, !self.stopping, self.started != nil else { break }
        for track in self.tracks.values where Date().timeIntervalSince(track.lastSignal) >= 6 {
          track.reportSilence()
        }
        if self.engine?.isRunning != true
          || self.tracks["microphone"].map({ Date().timeIntervalSince($0.lastBuffer) > 6 }) == true
        {
          self.restartMicrophone()
        }
      }
    }
  }
  func stop(status: String = "completed") async {
    guard !stopping, !recordingId.isEmpty else { return }
    stopping = true
    operation += 1
    isStarting = false
    let id = recordingId
    let duration = started.map { Date().timeIntervalSince($0) } ?? 0
    monitoringTask?.cancel()
    monitoringTask = nil
    removeMicrophone()
    if let stream { try? await stream.stopCapture() }
    // Drain the source callback queue, then every copied buffer enqueued on the
    // main actor. A fixed sleep can close the WAV before queued tail audio arrives.
    await withCheckedContinuation { continuation in
      audioQueue.async { [pendingAudio] in
        pendingAudio.notify(queue: .main) { continuation.resume() }
      }
    }
    stream = nil
    for track in tracks.values {
      do {
        if track.source == "microphone", track.padOnNextBuffer { try track.pad(to: duration) }
        try track.closeAudio()
      } catch {
        emit(["type": "warning", "recordingId": id, "message": error.localizedDescription])
      }
    }
    await withTaskGroup(of: Void.self) { group in
      for track in tracks.values {
        if let speech = track.speech { group.addTask { @MainActor in await speech.finish() } }
      }
    }
    let metadata = tracks.values.map { $0.metadata() }.filter { ($0["bytes"] as? Int64 ?? 0) > 44 }
    let stats = Dictionary(uniqueKeysWithValues: tracks.map { ($0.key, $0.value.stats()) })
    emit([
      "type": "stopped", "recordingId": id, "status": status, "duration": duration,
      "audio": ["tracks": metadata, "diagnostics": ["sourceStats": stats]],
    ])
    tracks = [:]
    started = nil
    recordingId = ""
    stopping = false
  }
  nonisolated func stream(_ stream: SCStream, didStopWithError error: Error) {
    DispatchQueue.main.async {
      guard !self.stopping, self.stream === stream else { return }
      self.stream = nil
      emit([
        "type": "recording-status", "recordingId": self.recordingId,
        "sources": ["system": ["status": "unavailable", "message": error.localizedDescription]],
      ])
      emit([
        "type": "warning", "recordingId": self.recordingId,
        "message":
          "System audio stopped: \(error.localizedDescription). Microphone capture continues.",
      ])
    }
  }
  nonisolated func stream(
    _ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
    of type: SCStreamOutputType
  ) {
    guard type == .audio, sampleBuffer.isValid,
      let desc = CMSampleBufferGetFormatDescription(sampleBuffer),
      let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc),
      let format = AVAudioFormat(streamDescription: asbd)
    else { return }
    var needed = 0
    let query = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
      sampleBuffer, bufferListSizeNeededOut: &needed, bufferListOut: nil, bufferListSize: 0,
      blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil)
    guard query == noErr || needed > 0, needed >= MemoryLayout<AudioBufferList>.size else { return }
    let raw = UnsafeMutableRawPointer.allocate(
      byteCount: needed, alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { raw.deallocate() }
    let list = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
    var block: CMBlockBuffer?
    guard
      CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sampleBuffer, bufferListSizeNeededOut: nil, bufferListOut: list, bufferListSize: needed,
        blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
        flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment),
        blockBufferOut: &block) == noErr,
      let pcm = AVAudioPCMBuffer(
        pcmFormat: format,
        frameCapacity: AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer)))
    else { return }
    pcm.frameLength = pcm.frameCapacity
    let src = UnsafeMutableAudioBufferListPointer(list)
    let dst = UnsafeMutableAudioBufferListPointer(pcm.mutableAudioBufferList)
    for i in 0..<min(src.count, dst.count) {
      if let s = src[i].mData, let d = dst[i].mData {
        memcpy(d, s, min(Int(src[i].mDataByteSize), Int(dst[i].mDataByteSize)))
      }
    }
    let pending = pendingAudio
    pending.enter()
    DispatchQueue.main.async {
      defer { pending.leave() }
      guard self.stream === stream else { return }
      self.tracks["system"]?.accept(pcm)
    }
  }
}

@MainActor
func recognizeFile(
  _ url: URL, recognizer: SFSpeechRecognizer, control: RecognitionCancellation? = nil,
  context: [String] = [], onPartial: ((String, TimeInterval) -> Void)? = nil
) async throws -> (
  String, TimeInterval
) {
  try await withCheckedThrowingContinuation { continuation in
    let request = SFSpeechURLRecognitionRequest(url: url)
    request.requiresOnDeviceRecognition = true
    request.addsPunctuation = true
    request.taskHint = .dictation
    request.contextualStrings = context
    request.shouldReportPartialResults = onPartial != nil
    var task: SFSpeechRecognitionTask?
    var done = false
    let timeout = DispatchWorkItem {
      if !done {
        done = true
        task?.cancel()
        task = nil
        control?.cancel = nil
        continuation.resume(
          throwing: problem("On-device transcription timed out. The recording is preserved."))
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 70, execute: timeout)
    control?.cancel = {
      guard !done else { return }
      done = true
      timeout.cancel()
      task?.cancel()
      task = nil
      control?.cancel = nil
      continuation.resume(throwing: CancellationError())
    }
    task = recognizer.recognitionTask(with: request) { result, error in
      DispatchQueue.main.async {
        guard !done else { return }
        if let result {
          onPartial?(
            result.bestTranscription.formattedString,
            result.bestTranscription.segments.first?.timestamp ?? 0)
        }
        if let result, result.isFinal {
          done = true
          timeout.cancel()
          control?.cancel = nil
          continuation.resume(
            returning: (
              result.bestTranscription.formattedString,
              result.bestTranscription.segments.first?.timestamp ?? 0
            ))
          task = nil
        } else if let error {
          done = true
          timeout.cancel()
          control?.cancel = nil
          if (error as NSError).code == 1110 {
            continuation.resume(returning: ("", 0))
          } else {
            continuation.resume(throwing: error)
          }
          task = nil
        }
      }
    }
  }
}

@MainActor
func transcribe(_ input: [[String: Any]], id: String, locale: String, context: [String] = [])
  async throws
{
  if #available(macOS 26.0, *) {
    var segments: [[String: Any]] = []
    for track in input {
      guard let path = track["path"] as? String, let source = track["source"] as? String,
        ["microphone", "system"].contains(source)
      else { throw problem("Invalid recording track.") }
      let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
      let duration = Double(file.length) / file.processingFormat.sampleRate
      let channel = try await ModernSpeechChannel(
        source: source, locale: locale, recordingId: id, context: context, live: false)
      var lastProgress = Date.distantPast
      var completed = 0.0
      channel.progress = { seconds in
        completed = max(completed, min(duration, seconds))
        guard Date().timeIntervalSince(lastProgress) >= 0.25 else { return }
        lastProgress = Date()
        emit([
          "type": "transcription-progress", "recordingId": id, "source": source,
          "completed": completed, "total": duration,
        ])
      }
      segments += try await channel.transcribeFile(
        file, offset: track["startOffset"] as? Double ?? 0)
      emit([
        "type": "transcription-progress", "recordingId": id, "source": source,
        "completed": duration, "total": duration,
      ])
    }
    emit([
      "type": "retranscription-completed", "recordingId": id,
      "segments": segments.sorted {
        ($0["timestamp"] as? Double ?? 0) < ($1["timestamp"] as? Double ?? 0)
      },
    ])
    return
  }
  var permission = SFSpeechRecognizer.authorizationStatus()
  if permission == .notDetermined {
    permission = await withCheckedContinuation { c in
      SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
    }
  }
  guard permission == .authorized else {
    throw problem(
      "Allow Speech Recognition for Stillnote in macOS Settings, then retry. Audio is preserved.")
  }
  guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)),
    recognizer.supportsOnDeviceRecognition, recognizer.isAvailable
  else {
    throw problem(
      "On-device recognition is unavailable for \(locale). Install the language in macOS Dictation settings, then retry."
    )
  }
  var results: [[String: Any]] = []
  let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(
    "stillnote-transcribe-" + UUID().uuidString)
  try FileManager.default.createDirectory(
    at: temporary, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
  defer { try? FileManager.default.removeItem(at: temporary) }
  for track in input {
    guard let path = track["path"] as? String, let source = track["source"] as? String,
      ["microphone", "system"].contains(source)
    else { throw problem("Invalid recording track.") }
    let file = try AVAudioFile(
      forReading: URL(fileURLWithPath: path), commonFormat: .pcmFormatFloat32, interleaved: false)
    let rate = file.processingFormat.sampleRate
    let chunkFrames = AVAudioFramePosition(rate * 30)
    let total = Int(ceil(Double(file.length) / Double(chunkFrames)))
    var cursor: AVAudioFramePosition = 0
    var index = 0
    while cursor < file.length {
      let count = AVAudioFrameCount(min(chunkFrames, file.length - cursor))
      let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: count)!
      file.framePosition = cursor
      try file.read(into: buffer, frameCount: count)
      let chunkTrack = try AudioTrack(
        source: "microphone", recordingId: id, directory: temporary, start: Date())
      chunkTrack.events = false
      chunkTrack.startOffset = 0
      try chunkTrack.process(buffer)
      try chunkTrack.closeAudio()
      // Silent input is not useful speech, and should not occupy a recognition request.
      if chunkTrack.peak > 0.001 {
        let (text, firstWord) = try await recognizeFile(
          chunkTrack.writer.url, recognizer: recognizer, context: context)
        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          results.append([
            "segmentId": UUID().uuidString, "source": source,
            "speaker": source == "microphone" ? "You" : "Meeting audio", "text": text,
            "timestamp": (track["startOffset"] as? Double ?? 0) + Double(cursor) / rate + firstWord,
          ])
        }
      }
      index += 1
      cursor += AVAudioFramePosition(count)
      emit([
        "type": "transcription-progress", "recordingId": id, "source": source, "completed": index,
        "total": total,
      ])
    }
  }
  emit([
    "type": "retranscription-completed", "recordingId": id,
    "segments": results.sorted {
      ($0["timestamp"] as? Double ?? 0) < ($1["timestamp"] as? Double ?? 0)
    },
  ])
}

// Reusable acceptance path: production streaming recognition, prerecorded PCM,
// real-time pacing and window finalization, without opening any live audio input.
@MainActor
func streamedRecognition(input: URL, id: String, locale: String, dualSource: Bool = false)
  async throws
{
  if #available(macOS 26.0, *) {
  } else {
    var permission = SFSpeechRecognizer.authorizationStatus()
    if permission == .notDetermined {
      permission = await withCheckedContinuation { c in
        SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
      }
    }
    guard permission == .authorized else {
      throw problem("Speech Recognition permission is required for this test.")
    }
  }
  let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(
    "stillnote-stream-test-" + UUID().uuidString)
  try FileManager.default.createDirectory(
    at: temporary, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
  defer {
    eventObserver = nil
    try? FileManager.default.removeItem(at: temporary)
  }
  var segments: [[String: Any]] = []
  eventObserver = { event in
    if event["type"] as? String == "segment", event["recordingId"] as? String == id {
      segments.append(event)
    }
  }
  let file = try AVAudioFile(forReading: input, commonFormat: .pcmFormatFloat32, interleaved: false)
  let sources = dualSource ? ["microphone", "system"] : ["microphone"]
  var tracks: [AudioTrack] = []
  for source in sources {
    let track = try AudioTrack(source: source, recordingId: id, directory: temporary, start: Date())
    track.events = false
    track.startOffset = 0
    track.speech = try await speechChannel(
      source: source, locale: locale, recordingId: id, context: [])
    tracks.append(track)
  }
  let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 4096)!
  while file.framePosition < file.length {
    try file.read(into: buffer)
    guard buffer.frameLength > 0 else { break }
    for track in tracks { try track.process(buffer) }
    try await Task.sleep(
      nanoseconds: UInt64(
        Double(buffer.frameLength) / file.processingFormat.sampleRate * 1_000_000_000))
  }
  for track in tracks { try track.closeAudio() }
  await withTaskGroup(of: Void.self) { group in
    for track in tracks { group.addTask { @MainActor in await track.speech?.finish() } }
  }
  eventObserver = nil
  emit([
    "type": "retranscription-completed", "recordingId": id, "segments": segments, "streamed": true,
    "dualSource": dualSource,
    "diagnostics": Dictionary(uniqueKeysWithValues: tracks.map { ($0.source, $0.stats()) }),
  ])
}

@MainActor
func captureSelfTest() throws {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
    "stillnote-capture-test-" + UUID().uuidString)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  let previous = eventObserver
  defer {
    eventObserver = previous
    try? FileManager.default.removeItem(at: directory)
  }
  var observed: [String] = []
  eventObserver = { event in
    if let type = event["type"] as? String, ["source-silent", "source-signal"].contains(type) {
      observed.append(type)
    }
  }
  let track = try AudioTrack(
    source: "microphone", recordingId: "capture-self-test", directory: directory, start: Date())
  track.startOffset = 2
  let quiet = AVAudioPCMBuffer(pcmFormat: track.format, frameCapacity: 16000)!
  quiet.frameLength = 16000
  memset(quiet.floatChannelData![0], 0, 16000 * MemoryLayout<Float>.size)
  for _ in 0..<5 { try track.save(quiet) }
  guard observed.isEmpty else { throw problem("Silence reported before six seconds.") }
  try track.save(quiet)
  try track.save(quiet)
  guard observed == ["source-silent"] else { throw problem("Silence notification must fire once.") }
  let signal = copyPCM(quiet)!
  signal.floatChannelData![0][0] = 0.1
  try track.save(signal)
  guard observed == ["source-silent", "source-signal"] else {
    throw problem("Signal recovery notification missing.")
  }
  try track.pad(to: 11.25)
  guard track.writer.frames == 148000 else {
    throw problem("Gap padding ignored the track start offset.")
  }
  for _ in 0..<5 { try track.save(quiet) }
  guard observed == ["source-silent", "source-signal", "source-silent"] else {
    throw problem("Silence did not rearm after signal.")
  }
  try track.closeAudio()
  let file = try AVAudioFile(forReading: track.writer.url)
  guard file.length == 228000 else { throw problem("Padded WAV header/frame count mismatch.") }
  file.framePosition = 128000
  let gap = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 20000)!
  try file.read(into: gap)
  guard gap.frameLength == 20000, (0..<20000).allSatisfy({ gap.floatChannelData![0][$0] == 0 })
  else {
    throw problem("Padded gap contains signal.")
  }
  emit([
    "type": "capture-self-test", "status": "passed", "checks": 7,
    "paddedFrames": 20000, "sampleCount": file.length, "liveAudioInvoked": false,
  ])
}

@MainActor
func audioSelfTest(input: URL, output: URL) throws {
  try FileManager.default.createDirectory(
    at: output, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
  let file = try AVAudioFile(forReading: input, commonFormat: .pcmFormatFloat32, interleaved: false)
  let track = try AudioTrack(
    source: "microphone", recordingId: "self-test", directory: output, start: Date())
  track.events = false
  track.startOffset = 0
  let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 4096)!
  while file.framePosition < file.length {
    try file.read(into: buffer)
    if buffer.frameLength == 0 { break }
    try track.process(buffer)
  }
  try track.closeAudio()
  emit([
    "type": "audio-self-test", "tracks": [track.metadata()],
    "inputDuration": Double(file.length) / file.processingFormat.sampleRate,
    "diagnostics": track.stats(),
  ])
}

let capture = MainActor.assumeIsolated { Capture() }
let events = EKEventStore()
var transcribing = false
var pendingCommands = 0
@MainActor
func calendar() async throws {
  let allowed: Bool
  if #available(macOS 14.0, *) {
    allowed = try await events.requestFullAccessToEvents()
  } else {
    allowed = try await events.requestAccess(to: .event)
  }
  guard allowed else {
    throw problem("Allow Calendar access in System Settings → Privacy & Security.")
  }
  let from = Calendar.current.startOfDay(for: Date())
  let to = Calendar.current.date(byAdding: .day, value: 7, to: from)!
  let rows = events.events(
    matching: events.predicateForEvents(withStart: from, end: to, calendars: nil)
  ).sorted { $0.startDate < $1.startDate }.map { e -> [String: Any] in
    [
      "id": e.eventIdentifier ?? UUID().uuidString, "title": e.title ?? "Meeting",
      "start": ISO8601DateFormatter().string(from: e.startDate),
      "end": ISO8601DateFormatter().string(from: e.endDate),
      "participants": (e.attendees ?? []).compactMap { $0.name }.joined(separator: ", "),
      "location": e.location ?? "", "notes": e.notes ?? "", "allDay": e.isAllDay,
    ]
  }
  emit(["type": "calendar", "events": rows])
}
func command(_ data: Data) {
  guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
    let op = obj["op"] as? String
  else { return }
  pendingCommands += 1
  Task { @MainActor in
    defer { pendingCommands -= 1 }
    do {
      switch op {
      case "start":
        guard !transcribing, let directory = obj["audioDir"] as? String, directory.hasPrefix("/"),
          let id = obj["recordingId"] as? String, UUID(uuidString: id) != nil
        else { throw problem("Recording requires a valid local audio directory and session ID.") }
        do {
          try await capture.start(
            locale: obj["locale"] as? String ?? "en-US",
            includeSystem: obj["systemAudio"] as? Bool ?? true,
            directory: URL(fileURLWithPath: directory), id: id,
            inputDevice: obj["inputDevice"] as? String, context: contextHints(obj["context"]),
            echoCancellation: obj["echoCancellation"] as? String ?? "auto")
        } catch is CancellationError { return } catch {
          emit([
            "type": "error", "op": op, "recordingId": id, "message": error.localizedDescription,
          ])
          await capture.stop(status: "failed")
        }
      case "stop": await capture.stop()
      case "transcribe":
        guard !transcribing, capture.started == nil, !capture.isStarting, !capture.stopping,
          let id = obj["recordingId"] as? String,
          let tracks = obj["tracks"] as? [[String: Any]]
        else { throw problem("Finish the current operation before retrying transcription.") }
        transcribing = true
        do {
          try await transcribe(
            tracks, id: id, locale: obj["locale"] as? String ?? "en-US",
            context: contextHints(obj["context"]))
        } catch {
          emit([
            "type": "retranscription-error", "recordingId": id,
            "message": error.localizedDescription,
          ])
        }
        transcribing = false
      case "devices": emit(["type": "devices", "inputs": inputDevices().map { $0.json }])
      case "languages": emit(await languages())
      case "install-language":
        let locale = obj["locale"] as? String ?? ""
        do { try await installLanguage(locale) } catch {
          emit(["type": "error", "op": op, "locale": locale, "message": error.localizedDescription])
        }
      case "calendar": try await calendar()
      case "status":
        emit([
          "type": "status", "microphone": AVCaptureDevice.authorizationStatus(for: .audio).rawValue,
          "speech": SFSpeechRecognizer.authorizationStatus().rawValue,
          "locales": SFSpeechRecognizer.supportedLocales().map { $0.identifier }.sorted(),
        ])
      default: throw problem("Unknown native operation.")
      }
    } catch { emit(["type": "error", "op": op, "message": error.localizedDescription]) }
  }
}
if CommandLine.arguments.contains("--capture-self-test") {
  do {
    try MainActor.assumeIsolated { try captureSelfTest() }
    exit(0)
  } catch {
    emit(["type": "capture-self-test", "status": "failed", "message": error.localizedDescription])
    exit(1)
  }
}
if CommandLine.arguments.contains("--scheduler-self-test") {
  Task { @MainActor in
    do {
      try await schedulerSelfTest()
      exit(0)
    } catch {
      emit([
        "type": "scheduler-self-test", "status": "failed", "message": error.localizedDescription,
      ])
      exit(1)
    }
  }
  RunLoop.main.run()
  exit(0)
}
if CommandLine.arguments.contains("--self-test") {
  emit([
    "type": "ready", "platform": "macOS",
    "speechLocales": SFSpeechRecognizer.supportedLocales().count, "engine": recognitionEngine,
  ])
  exit(0)
}
if let index = CommandLine.arguments.firstIndex(of: "--audio-self-test"),
  CommandLine.arguments.count > index + 2
{
  do {
    try MainActor.assumeIsolated {
      try audioSelfTest(
        input: URL(fileURLWithPath: CommandLine.arguments[index + 1]),
        output: URL(fileURLWithPath: CommandLine.arguments[index + 2]))
    }
    exit(0)
  } catch {
    emit(["type": "error", "message": error.localizedDescription])
    exit(1)
  }
}
// LaunchServices test mode gives this helper its own bundle/TCC identity instead
// of attributing Speech access to an unrelated terminal or editor host.
if let index = CommandLine.arguments.firstIndex(of: "--transcribe-file"),
  CommandLine.arguments.count > index + 1
{
  func argument(_ key: String) -> String? {
    guard let i = CommandLine.arguments.firstIndex(of: key), CommandLine.arguments.count > i + 1
    else { return nil }
    return CommandLine.arguments[i + 1]
  }
  guard let resultPath = argument("--result"), resultPath.hasPrefix("/") else { exit(2) }
  FileManager.default.createFile(
    atPath: resultPath, contents: nil, attributes: [.posixPermissions: 0o600])
  eventFile = try? FileHandle(forWritingTo: URL(fileURLWithPath: resultPath))
  let id = argument("--recording-id") ?? UUID().uuidString
  emit([
    "type": "ready", "pid": ProcessInfo.processInfo.processIdentifier, "recordingId": id,
    "speechPermission": SFSpeechRecognizer.authorizationStatus().rawValue,
  ])
  Task { @MainActor in
    do {
      if CommandLine.arguments.contains("--streamed") {
        try await streamedRecognition(
          input: URL(fileURLWithPath: CommandLine.arguments[index + 1]), id: id,
          locale: argument("--locale") ?? "en-US",
          dualSource: CommandLine.arguments.contains("--dual-source"))
      } else {
        try await transcribe(
          [["source": "microphone", "path": CommandLine.arguments[index + 1], "startOffset": 0]],
          id: id, locale: argument("--locale") ?? "en-US")
      }
      try? eventFile?.close()
      exit(0)
    } catch {
      emit([
        "type": "retranscription-error", "recordingId": id, "message": error.localizedDescription,
      ])
      try? eventFile?.close()
      exit(1)
    }
  }
  RunLoop.main.run()
  exit(0)
}
var input = Data()
FileHandle.standardInput.readabilityHandler = { handle in
  let bytes = handle.availableData
  if bytes.isEmpty {
    DispatchQueue.main.async {
      Task { @MainActor in
        while pendingCommands > 0 { try? await Task.sleep(nanoseconds: 50_000_000) }
        await capture.stop()
        exit(0)
      }
    }
    return
  }
  input.append(bytes)
  while let index = input.firstIndex(of: 10) {
    let line = input.prefix(upTo: index)
    input.removeSubrange(...index)
    DispatchQueue.main.async { command(Data(line)) }
  }
}
emit(["type": "ready", "platform": "macOS"])
RunLoop.main.run()
