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
  // Silence for a long gap, written in blocks with one header update at the end.
  func appendSilence(_ count: Int64) throws {
    guard let handle, count > 0 else { return }
    let block: Int64 = 10 * 16000
    let zeros = Data(count: Int(block) * 2)
    var left = count
    while left > 0 {
      let frames = min(left, block)
      try handle.write(contentsOf: frames == block ? zeros : Data(count: Int(frames) * 2))
      self.frames += frames
      left -= frames
    }
    try writeHeader()
    try handle.synchronize()
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
  // The recording jumps ahead (the Mac slept): the next audio starts `seconds` later.
  func skip(_ seconds: TimeInterval)
  func finish() async
}

var recognitionEngine: String {
  if #available(macOS 26.0, *), SpeechTranscriber.isAvailable { return "speechTranscriber" }
  return "legacy"
}
func contextHints(_ value: Any?) -> [String] {
  Array((value as? [String] ?? []).prefix(100)).map { String($0.prefix(100)) }
}
@MainActor
func speechChannel(source: String, locale: String, recordingId: String, context: [String])
  async throws -> any SpeechChannel
{
  if #available(macOS 26.0, *), SpeechTranscriber.isAvailable {
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
  let locale: String
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
  // Auto language reports a failed candidate as a fallback instead of a recognition warning, and
  // reports how far it has finalized so the app knows when every language has spoken.
  var quiet = false
  var reportsProgress = false
  var through: Double = 0
  var lastProgress = Date.distantPast
  // Long gaps (the Mac slept) are not fed to the analyzer as silence: its stream skips them, and
  // `audioTime` maps stream time back to recording time.
  var skips: [(at: Double, seconds: Double)] = []
  let live: Bool
  init(source: String, locale: String, recordingId: String, context: [String], live: Bool = true)
    async throws
  {
    self.source = source
    self.locale = locale
    self.recordingId = recordingId
    self.live = live
    guard SpeechTranscriber.isAvailable,
      let supported = await SpeechTranscriber.supportedLocale(
        equivalentTo: Locale(identifier: locale))
    else {
      throw problem("On-device recognition is unavailable for \(locale). Audio is still saved.")
    }
    // Confidence lets Auto language compare the same phrase transcribed in two languages.
    transcriber = SpeechTranscriber(
      locale: supported, transcriptionOptions: [],
      reportingOptions: live ? [.volatileResults] : [],
      attributeOptions: [.audioTimeRange, .transcriptionConfidence])
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
    // Modules must use a locale reserved by this app ("unallocated locales" is slated to become
    // an error). A full reservation list still works today, so a failed reserve is not fatal.
    let reserved = await AssetInventory.reservedLocales.contains {
      $0.identifier(.bcp47) == supported.identifier(.bcp47)
    }
    if !reserved { _ = try? await AssetInventory.reserve(locale: supported) }
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
    try Task.checkCancellation()
    if live {
      // Results before the volatile range are final, silence included.
      await analyzer.setVolatileRangeChangedHandler { [weak self] range, _, _ in
        let start = range.start.seconds
        Task { @MainActor in self?.advance(to: start) }
      }
    }
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
      // About 20 s of system audio (ScreenCaptureKit's buffers are small) or 80 s of microphone
      // audio may wait for the analyzer before it counts as falling behind.
      let sequence = AsyncStream<AnalyzerInput>(bufferingPolicy: .bufferingOldest(1024)) {
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
    if !quiet {
      emit([
        "type": "warning", "recordingId": recordingId, "source": source,
        "message": "Recognition: \(error.localizedDescription). Original audio is preserved.",
      ])
    }
    continuation?.finish()
  }
  func receive(_ result: SpeechTranscriber.Result) {
    let start = result.range.start.seconds
    let end = CMTimeRangeGetEnd(result.range).seconds
    guard start.isFinite, end.isFinite else { return }
    let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
    // Provisional phrases this result revises: the same start, or an overlapping range.
    let revised = pending.keys.filter {
      abs($0 - start) < 0.1 || (start < (pendingEnds[$0] ?? $0) && $0 < end)
    }
    guard !text.isEmpty else {
      // Revised to nothing (a cough, noise): its provisional text must not linger or be saved.
      discard(revised)
      return
    }
    // Revisions retain the phrase's ID even if its first word boundary shifts slightly.
    let key = revised.min { abs($0 - start) < abs($1 - start) } ?? start
    let id = pending[key]?["segmentId"] as? String ?? UUID().uuidString
    var event: [String: Any] = [
      "type": result.isFinal ? "segment" : "partial", "recordingId": recordingId,
      "segmentId": id, "source": source,
      "speaker": source == "microphone" ? "You" : "Meeting audio",
      "text": text, "timestamp": audioTime(start), "partial": !result.isFinal,
      "end": audioTime(end), "locale": locale,
    ]
    if let confidence = Self.confidence(of: result.text) { event["confidence"] = confidence }
    // Word timing lets Auto language split a long phrase at its pauses.
    if result.isFinal { event["runs"] = Self.runs(of: result.text) { self.audioTime($0) } }
    if result.isFinal {
      // One final can cover several provisional phrases; the others never get one of their own.
      discard(revised.filter { $0 != key })
      pending.removeValue(forKey: key)
      pendingEnds.removeValue(forKey: key)
      // Live results go to the app as they arrive; only a file transcription returns them.
      if !live { segments.append(event) }
      through = max(through, audioTime(end))
    } else {
      pending[key] = event
      pendingEnds[key] = end
    }
    if live { emit(event) }
    progress?(end)
  }
  // Provisional phrases that will never get a final of their own leave the live transcript.
  func discard(_ keys: [Double]) {
    let ids = keys.compactMap { pending[$0]?["segmentId"] as? String }
    for key in keys {
      pending.removeValue(forKey: key)
      pendingEnds.removeValue(forKey: key)
    }
    guard live, !ids.isEmpty else { return }
    emit([
      "type": "partial-discard", "recordingId": recordingId, "source": source, "locale": locale,
      "segmentIds": ids,
    ])
  }
  func audioTime(_ stream: Double) -> Double {
    skips.reduce((baseOffset ?? 0) + stream) { $1.at <= stream ? $0 + $1.seconds : $0 }
  }
  func skip(_ seconds: TimeInterval) {
    // Before the first audio there is nothing to shift: that audio's offset includes the gap.
    guard seconds > 0, !closed, baseOffset != nil else { return }
    skips.append((Double(frames) / format.sampleRate, seconds))
  }
  func advance(to seconds: Double) {
    guard seconds.isFinite, !closed else { return }
    through = max(through, audioTime(seconds))
    guard reportsProgress, Date().timeIntervalSince(lastProgress) >= 0.5 else { return }
    lastProgress = Date()
    emit([
      "type": "recognition-progress", "recordingId": recordingId, "source": source,
      "locale": locale, "through": through,
    ])
  }
  // Character-weighted mean of the runs' confidence, or nil when the model reports none.
  static func confidence(of text: AttributedString) -> Double? {
    var weighted = 0.0
    var count = 0.0
    for run in text.runs {
      guard let value = run[AttributeScopes.SpeechAttributes.ConfidenceAttribute.self] else {
        continue
      }
      let characters = Double(text[run.range].characters.count)
      weighted += value * characters
      count += characters
    }
    return count > 0 ? weighted / count : nil
  }
  // [start, end, confidence or -1, text] per timed run; untimed text joins the previous run.
  static func runs(of text: AttributedString, time: (Double) -> Double) -> [[Any]] {
    var out: [[Any]] = []
    for run in text.runs {
      let piece = String(text[run.range].characters)
      guard let range = run[AttributeScopes.SpeechAttributes.TimeRangeAttribute.self],
        range.start.seconds.isFinite, CMTimeRangeGetEnd(range).seconds.isFinite
      else {
        if var last = out.popLast() {
          last[3] = (last[3] as? String ?? "") + piece
          out.append(last)
        }
        continue
      }
      let round = { (value: Double) in (value * 1000).rounded() / 1000 }
      out.append([
        round(time(range.start.seconds)), round(time(CMTimeRangeGetEnd(range).seconds)),
        run[AttributeScopes.SpeechAttributes.ConfidenceAttribute.self] ?? -1, piece,
      ])
    }
    return out
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
      if live { emit(event) } else { segments.append(event) }
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

// Raw capture owns the track; recognition joins asynchronously and replays a bounded tail.
// A stopped/replaced capture must never acquire a late recognizer.
@MainActor
func attachPrimary(
  _ track: AudioTrack, keepBuffer: Bool,
  make: () async throws -> any SpeechChannel,
  stillWanted: () -> Bool, failed: (Error) -> Void
) async {
  guard !Task.isCancelled, stillWanted(), !track.closed else { return }
  do {
    let channel = try await make()
    guard !Task.isCancelled, stillWanted(), !track.closed else {
      await channel.finish()
      return
    }
    for (buffer, offset) in merged(track.preRoll ?? [], seconds: 1) {
      channel.append(buffer, offset: offset)
    }
    track.speech = channel
  } catch {
    guard !Task.isCancelled, stillWanted(), !track.closed else { return }
    failed(error)
  }
  if !keepBuffer {
    track.preRoll = nil
    track.preRollFrames = 0
  }
}

// Starts a second-language transcriber for a track that is already recording: it first hears the
// buffered audio, then joins the first language. `stillWanted` guards against a stop meanwhile.
@available(macOS 26.0, *)
@MainActor
func attachCandidate(
  _ track: AudioTrack, locale: String, id: String, context: [String], stillWanted: () -> Bool
) async {
  guard !Task.isCancelled, stillWanted(), !track.closed else { return }
  do {
    let second = try await ModernSpeechChannel(
      source: track.source, locale: locale, recordingId: id, context: context)
    guard !Task.isCancelled, stillWanted(), !track.closed else {
      await second.finish()
      return
    }
    // Replayed in blocks: hundreds of small system-audio buffers at once would overrun the
    // recognizer's input queue before it reads any.
    for (buffer, offset) in merged(track.preRoll ?? [], seconds: 1) {
      second.append(buffer, offset: offset)
    }
    track.preRoll = nil
    if let first = track.speech as? ModernSpeechChannel {
      track.speech = CandidateSpeechChannel(
        source: track.source, recordingId: id, children: [first, second])
    } else if track.speech == nil {
      // The first language never started here; the second carries this source alone.
      second.reportsProgress = true
      track.speech = second
    } else {
      await second.finish()
    }
  } catch {
    track.preRoll = nil
    guard !Task.isCancelled, stillWanted(), !track.closed else { return }
    emit([
      "type": "language-fallback", "recordingId": id, "source": track.source, "locale": locale,
      "reason": error.localizedDescription,
    ])
  }
}

// Auto language: one transcriber per candidate language hears the same audio. A candidate that
// fails is reported once as `language-fallback` and the others carry on.
@available(macOS 26.0, *)
@MainActor
final class CandidateSpeechChannel: SpeechChannel {
  let source: String
  let recordingId: String
  let children: [ModernSpeechChannel]
  var reported = Set<String>()
  init(source: String, recordingId: String, children: [ModernSpeechChannel]) {
    self.source = source
    self.recordingId = recordingId
    self.children = children
    for child in children {
      child.quiet = true
      child.reportsProgress = true
    }
  }
  var warned = false
  var errors: Int { children.reduce(0) { $0 + $1.errors } }
  var timeouts: Int { children.reduce(0) { $0 + $1.timeouts } }
  func append(_ buffer: AVAudioPCMBuffer, offset: TimeInterval) {
    for child in children { child.append(buffer, offset: offset) }
    for child in children where child.failure != nil && !reported.contains(child.locale) {
      reported.insert(child.locale)
      emit([
        "type": "language-fallback", "recordingId": recordingId, "source": source,
        "locale": child.locale, "reason": child.failure?.localizedDescription ?? "",
      ])
    }
    // With every language gone this source has no transcription: say so, as without Auto.
    if !warned, children.allSatisfy({ $0.failure != nil }), let failure = children.last?.failure {
      warned = true
      emit([
        "type": "warning", "recordingId": recordingId, "source": source,
        "message": "Recognition: \(failure.localizedDescription). Original audio is preserved.",
      ])
    }
  }
  func skip(_ seconds: TimeInterval) {
    for child in children { child.skip(seconds) }
  }
  func finish() async {
    await withTaskGroup(of: Void.self) { group in
      for child in children { group.addTask { @MainActor in await child.finish() } }
    }
  }
}

func localeNames(_ locales: [Locale]) -> [String] {
  Array(Set(locales.map { $0.identifier.replacingOccurrences(of: "_", with: "-") })).sorted()
}
@MainActor
func languages() async -> [String: Any] {
  if #available(macOS 26.0, *), SpeechTranscriber.isAvailable {
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
  // A full reservation list is not fatal (see ModernSpeechChannel); the download says if it is.
  _ = try? await AssetInventory.reserve(locale: supported)
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
  func skip(_ seconds: TimeInterval) {
    guard !finishing, let window = current else { return }
    submit(window)
    current = nil
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
  // While a recognizer initializes, retain at most ten seconds for catch-up. The full
  // recording is already on disk and can be transcribed again after capture.
  var preRoll: [(buffer: AVAudioPCMBuffer, offset: TimeInterval)]?
  var preRollFrames: AVAudioFrameCount = 0
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
      emit([
        "type": "recording-status", "recordingId": recordingId,
        "sources": [source: ["status": "unavailable", "message": error.localizedDescription]],
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
    if startOffset == nil {
      startOffset = elapsed
      // Reported now, so a recording that never finishes cleanly still knows where it began.
      if events {
        emit([
          "type": "track-started", "recordingId": recordingId, "source": source,
          "startOffset": elapsed,
        ])
      }
    }
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
    if preRoll != nil, let copy = copyPCM(buffer) {
      preRoll?.append((copy, offset))
      preRollFrames += copy.frameLength
      while preRollFrames > 10 * 16000, let first = preRoll?.first {
        preRoll?.removeFirst()
        preRollFrames -= first.buffer.frameLength
      }
    }
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
    // Recognition hears up to two seconds of the gap, enough to end the phrase before it. A
    // longer gap (the Mac slept) is skipped by recognition and written to the WAV in blocks.
    var heard = min(missing, 2 * 16000)
    while heard > 0 {
      let count = AVAudioFrameCount(min(heard, 16000))
      let silence = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: count)!
      silence.frameLength = count
      memset(silence.floatChannelData![0], 0, Int(count) * MemoryLayout<Float>.size)
      try save(silence)
      heard -= Int64(count)
      missing -= Int64(count)
    }
    guard missing > 0 else { return }
    speech?.skip(Double(missing) / 16000)
    // A second language still starting begins after the gap.
    if preRoll != nil {
      preRoll = []
      preRollFrames = 0
    }
    try writer.appendSilence(missing)
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

// Joins consecutive buffers of one format into blocks of up to `seconds`; each block keeps the
// offset of its first buffer.
func merged(_ items: [(buffer: AVAudioPCMBuffer, offset: TimeInterval)], seconds: Double)
  -> [(buffer: AVAudioPCMBuffer, offset: TimeInterval)]
{
  var out: [(buffer: AVAudioPCMBuffer, offset: TimeInterval)] = []
  for item in items {
    let buffer = item.buffer
    guard buffer.frameLength > 0, let source = buffer.floatChannelData else { continue }
    if let last = out.last?.buffer, last.format.isEqual(buffer.format),
      last.frameLength + buffer.frameLength <= last.frameCapacity,
      let target = last.floatChannelData
    {
      for channel in 0..<Int(buffer.format.channelCount) {
        memcpy(
          target[channel].advanced(by: Int(last.frameLength)), source[channel],
          Int(buffer.frameLength) * MemoryLayout<Float>.size)
      }
      last.frameLength += buffer.frameLength
      continue
    }
    let capacity = max(
      buffer.frameLength, AVAudioFrameCount(buffer.format.sampleRate * seconds))
    guard let block = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: capacity),
      let target = block.floatChannelData
    else { continue }
    for channel in 0..<Int(buffer.format.channelCount) {
      memcpy(target[channel], source[channel], Int(buffer.frameLength) * MemoryLayout<Float>.size)
    }
    block.frameLength = buffer.frameLength
    out.append((block, item.offset))
  }
  return out
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
// Meeting detection: which other apps are using a microphone. macOS 14 lists the processes
// running audio input, so Stillnote's own capture is left out, and names each by the app it
// belongs to (Chrome's or Granola's audio helper as Chrome or Granola), so the app can tell a
// call from another note-taker. macOS 13 can only tell that the default microphone is in use by
// someone (no apps), and the app ignores what starts while it records. Reads CoreAudio state
// only; never opens an input.
func inputApps(
  _ processes: [(pid: Int32, input: Bool)], own: Int32, app: (Int32) -> String
) -> [String] {
  Set(processes.filter { $0.input && $0.pid != own }.map { app($0.pid) }).sorted()
}
// The outermost .app bundle around a process's executable, else what CoreAudio calls it, else
// the executable's name.
func owningApp(_ pid: Int32, bundleID: String = "") -> String {
  var buffer = [CChar](repeating: 0, count: 4096)
  guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return bundleID }
  let path = String(cString: buffer)
  if let app = path.range(of: ".app/"),
    let id = Bundle(path: String(path[..<app.lowerBound]) + ".app")?.bundleIdentifier
  {
    return id
  }
  return bundleID.isEmpty ? URL(fileURLWithPath: path).lastPathComponent : bundleID
}
func microphoneUsers() -> (active: Bool, apps: [String]?) {
  let system = AudioObjectID(kAudioObjectSystemObject)
  if #available(macOS 14.0, *) {
    var objects: [Int32: AudioObjectID] = [:]
    let processes = audioIDs(system, kAudioHardwarePropertyProcessObjectList).map {
      let pid = Int32(bitPattern: audioNumber($0, kAudioProcessPropertyPID))
      objects[pid] = $0
      return (pid: pid, input: audioNumber($0, kAudioProcessPropertyIsRunningInput) != 0)
    }
    let apps = inputApps(processes, own: getpid()) { pid in
      let bundleID = objects[pid].map { audioString($0, kAudioProcessPropertyBundleID) }
      return owningApp(pid, bundleID: bundleID ?? "")
    }
    return (!apps.isEmpty, apps)
  }
  let input = audioNumber(system, kAudioHardwarePropertyDefaultInputDevice)
  return (input != 0 && audioNumber(input, kAudioDevicePropertyDeviceIsRunningSomewhere) != 0, nil)
}
// Checks every two seconds and reports each change, starting with the current state. CoreAudio is
// read off the main actor, which also receives recorded audio: a slow audio service (a Bluetooth
// handoff) must not hold up capture.
@MainActor
final class MicrophoneWatch {
  var task: Task<Void, Never>?
  var reported: String?
  func start() {
    guard task == nil else { return }
    task = Task { @MainActor [weak self] in
      while !Task.isCancelled {
        let now = await Task.detached(priority: .utility) { microphoneUsers() }.value
        guard let self, !Task.isCancelled else { break }
        let state = "\(now.active) \(now.apps ?? [])"
        if state != self.reported {
          self.reported = state
          var event: [String: Any] = ["type": "microphone-activity", "active": now.active]
          if let apps = now.apps { event["apps"] = apps }
          emit(event)
        }
        do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { break }
      }
    }
  }
  func stop() {
    task?.cancel()
    task = nil
    reported = nil
  }
}
// At most three microphone rebuilds in any ten seconds. Refused attempts are not counted, so the
// monitor's retries rebuild again once the window has passed.
struct RestartLimiter {
  var rebuilds: [Date] = []
  mutating func allow(at now: Date = Date()) -> Bool {
    rebuilds = rebuilds.filter { now.timeIntervalSince($0) < 10 }
    guard rebuilds.count < 3 else { return false }
    rebuilds.append(now)
    return true
  }
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
  var speechSetup: [Task<Void, Never>] = []
  var restarting = false
  var tapInstalled = false
  var microphoneGeneration = 0
  var tapFormat: AVAudioFormat?
  var restarts = RestartLimiter()
  var restartsPaused = false
  nonisolated let audioQueue = DispatchQueue(label: "local.stillnote.audio")
  nonisolated let pendingAudio = DispatchGroup()
  func start(
    locale: String, includeSystem: Bool, directory: URL, id: String, inputDevice: String?,
    context: [String], echoCancellation: String, locales: [String] = []
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
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let start = Date()
    started = start
    restarts = RestartLimiter()
    tracks = [:]
    let mic = try AudioTrack(
      source: "microphone", recordingId: id, directory: directory, start: start)
    tracks["microphone"] = mic
    let auto = locales.count > 1 && recognitionEngine == "speechTranscriber"
    mic.preRoll = []
    let device = try startMicrophone()
    startMonitoring()
    var systemActive = false
    var sources: [String: [String: Any]] = [
      "microphone": ["status": "recording", "device": device.identity, "recognition": "starting"],
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
        track.preRoll = []
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
        sources["system"] = ["status": "recording", "recognition": "starting"]
      } catch {
        if generation != operation { throw CancellationError() }
        if let failedStream = self.stream {
          self.stream = nil
          try? await failedStream.stopCapture()
        }
        // Meeting audio that never started is not a track: it would be reported as silent.
        if let track = tracks.removeValue(forKey: "system") {
          track.preRoll = nil
          try? track.writer.close()
          await track.speech?.finish()
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
    // Audio is already being saved and `started` has been acknowledged. Neither a permission
    // prompt nor model preparation can delay it. Each source initializes independently.
    for (source, track) in tracks {
      let job = Task { @MainActor [weak self] in
        guard let self, !Task.isCancelled, generation == self.operation else { return }
        let wanted = { generation == self.operation && self.tracks[source] === track }
        let recognitionStatus = { (status: String) in
          emit([
            "type": "recording-status", "recordingId": id,
            "sources": [source: ["recognition": status]],
          ])
        }
        if recognitionEngine == "legacy" {
          var status = SFSpeechRecognizer.authorizationStatus()
          if status == .notDetermined {
            status = await withCheckedContinuation { c in
              SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
            }
          }
          guard !Task.isCancelled, wanted() else { return }
          if status != .authorized {
            track.preRoll = nil
            recognitionStatus("unavailable")
            self.warning(
              "Speech Recognition permission is unavailable. Audio is still saved; enable permission and retry transcription later."
            )
            return
          }
        }
        await attachPrimary(
          track, keepBuffer: auto,
          make: {
            let channel = try await speechChannel(
              source: source, locale: locale, recordingId: id, context: context)
            if #available(macOS 26.0, *), auto {
              (channel as? ModernSpeechChannel)?.reportsProgress = true
            }
            return channel
          }, stillWanted: wanted,
          failed: { error in
            emit(["type": "warning", "recordingId": id, "message": error.localizedDescription])
            if auto {
              emit([
                "type": "language-fallback", "recordingId": id, "source": source,
                "locale": locale, "reason": error.localizedDescription,
              ])
            }
          })
        guard !Task.isCancelled, wanted() else { return }
        recognitionStatus(track.speech != nil ? "ready" : auto ? "starting" : "unavailable")
        if auto, #available(macOS 26.0, *) {
          await attachCandidate(
            track, locale: locales[1], id: id, context: context,
            stillWanted: wanted)
          guard !Task.isCancelled, wanted() else { return }
          recognitionStatus(track.speech != nil ? "ready" : "unavailable")
        }
      }
      speechSetup.append(job)
    }
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
    guard restarts.allow() else {
      if !restartsPaused {
        restartsPaused = true
        warning(
          "The microphone keeps resetting. Check the input device in Settings › Recording.")
        emit([
          "type": "recording-status", "recordingId": recordingId,
          "sources": ["microphone": ["status": "unavailable"]],
        ])
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
      restartsPaused = false
      emit([
        "type": "recording-status", "recordingId": recordingId,
        "sources": ["microphone": ["status": "recording", "device": device.identity]],
      ])
    } catch {
      removeMicrophone()
      // After the limit's warning, retries stay quiet until one succeeds.
      if !restartsPaused {
        warning(
          "Microphone restart failed: \(error.localizedDescription). Retrying in two seconds.")
      }
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
        // A microphone track that can no longer save (disk full) is not restarted in a loop.
        guard let mic = self.tracks["microphone"], !mic.closed else { continue }
        if self.engine?.isRunning != true || Date().timeIntervalSince(mic.lastBuffer) > 6 {
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
    for job in speechSetup { job.cancel() }
    speechSetup = []
    for track in tracks.values {
      track.preRoll = nil
      track.preRollFrames = 0
    }
    removeMicrophone()
    // ScreenCaptureKit can take long to confirm a stop; the audio received so far is saved.
    if let stream { await waitAtMost(5) { try? await stream.stopCapture() } }
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
final class Flag {
  var raised = false
}
// Runs `work`, returning when it finishes or after `seconds`, whichever comes first (the work
// itself carries on).
@MainActor
func waitAtMost(_ seconds: Double, _ work: @escaping @MainActor () async -> Void) async {
  let finished = Flag()
  await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
    let finish = { @MainActor in
      guard !finished.raised else { return }
      finished.raised = true
      continuation.resume()
    }
    Task { @MainActor in
      await work()
      finish()
    }
    Task { @MainActor in
      try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
      finish()
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

// A retry can be cancelled (the app gave up waiting, or quit), and a pass that stalls is stopped
// after three times real time.
var transcriptionCancelled = false
var transcriptionCancel: (() -> Void)?
let transcriptionStalled =
  "Transcription stopped because it was taking too long. The existing transcript was preserved."

// A failed locale does not discard a successful candidate, but a source with no usable
// candidate must fail the whole replacement so its previous transcript survives. With one
// language, its own reason (which language to download, say) is the error.
@MainActor
func recognizeCandidates(
  _ locales: [String], run: (Int, String) async throws -> [[String: Any]]
) async throws -> (segments: [[String: Any]], failures: [[String: String]]) {
  var segments: [[String: Any]] = []
  var failures: [[String: String]] = []
  var successes = 0
  var firstError: Error?
  for (pass, locale) in locales.enumerated() {
    try Task.checkCancellation()
    if transcriptionCancelled { throw CancellationError() }
    do {
      segments += try await run(pass, locale)
      successes += 1  // A valid silent track is a successful empty result.
    } catch {
      if transcriptionCancelled || error is CancellationError { throw error }
      firstError = firstError ?? error
      failures.append(["locale": locale, "reason": error.localizedDescription])
    }
  }
  guard successes > 0 else {
    if locales.count == 1, let firstError { throw firstError }
    throw problem("No language could transcribe this audio. The existing transcript was preserved.")
  }
  return (segments, failures)
}

// Several locales (Auto language) transcribe every track once per locale, one pass at a time to
// stay inside the system's limit on simultaneous analyses; the app picks per sentence.
@MainActor
func transcribe(_ input: [[String: Any]], id: String, locales: [String], context: [String] = [])
  async throws
{
  let locale = locales.first ?? "en-US"
  if #available(macOS 26.0, *), SpeechTranscriber.isAvailable {
    var segments: [[String: Any]] = []
    var fallbacks: [[String: String]] = []
    for track in input {
      guard let path = track["path"] as? String, let source = track["source"] as? String,
        ["microphone", "system"].contains(source)
      else { throw problem("Invalid recording track.") }
      if transcriptionCancelled { throw CancellationError() }
      let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
      let duration = Double(file.length) / file.processingFormat.sampleRate
      let result = try await recognizeCandidates(locales) { pass, candidate in
        file.framePosition = 0
        let channel = try await ModernSpeechChannel(
          source: source, locale: candidate, recordingId: id, context: context, live: false)
        var lastProgress = Date.distantPast
        var completed = 0.0
        let passes = Double(locales.count)
        let progress = { (seconds: Double) in
          (Double(pass) * duration + min(duration, seconds)) / passes
        }
        channel.progress = { seconds in
          completed = max(completed, progress(seconds))
          guard Date().timeIntervalSince(lastProgress) >= 0.25 else { return }
          lastProgress = Date()
          emit([
            "type": "transcription-progress", "recordingId": id, "source": source,
            "completed": completed, "total": duration,
          ])
        }
        let stalled = Flag()
        transcriptionCancel = { Task { await channel.analyzer.cancelAndFinishNow() } }
        let watchdog = Task { @MainActor in
          try? await Task.sleep(nanoseconds: UInt64(max(60, 3 * duration) * 1_000_000_000))
          guard !Task.isCancelled else { return }
          stalled.raised = true
          transcriptionCancel?()
        }
        defer {
          watchdog.cancel()
          transcriptionCancel = nil
        }
        let found: [[String: Any]]
        do {
          found = try await channel.transcribeFile(
            file, offset: track["startOffset"] as? Double ?? 0)
        } catch {
          if stalled.raised { throw problem(transcriptionStalled) }
          throw error
        }
        if stalled.raised { throw problem(transcriptionStalled) }
        if transcriptionCancelled { throw CancellationError() }
        emit([
          "type": "transcription-progress", "recordingId": id, "source": source,
          "completed": progress(duration), "total": duration,
        ])
        return found
      }
      segments += result.segments
      for failure in result.failures {
        fallbacks.append(failure.merging(["source": source]) { _, new in new })
        let reason = failure["reason"] ?? "unavailable"
        emit([
          "type": "warning", "recordingId": id, "source": source,
          "message": "Recognition: \(reason). Original audio is preserved.",
        ])
      }
    }
    emit([
      "type": "retranscription-completed", "recordingId": id, "fallbacks": fallbacks,
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
      if transcriptionCancelled { throw CancellationError() }
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
        let control = RecognitionCancellation()
        transcriptionCancel = { control.cancel?() }
        defer { transcriptionCancel = nil }
        let (text, firstWord) = try await recognizeFile(
          chunkTrack.writer.url, recognizer: recognizer, control: control, context: context)
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
func streamedRecognition(
  input: URL, id: String, locales: [String], dualSource: Bool = false
) async throws {
  let locale = locales.first ?? "en-US"
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
  var timeline: [[String: Any]] = []
  let began = Date()
  eventObserver = { event in
    guard event["recordingId"] as? String == id else { return }
    let type = event["type"] as? String
    if type == "segment" { segments.append(event) }
    // Auto evaluation replays live decisions with real arrival times.
    if ["segment", "partial", "language-fallback", "recognition-progress"].contains(type ?? "") {
      var timed = event
      timed["arrival"] = Date().timeIntervalSince(began)
      timeline.append(timed)
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
    if locales.count > 1 {
      track.preRoll = []
      if #available(macOS 26.0, *) {
        (track.speech as? ModernSpeechChannel)?.reportsProgress = true
      }
    }
    tracks.append(track)
  }
  // Like a recording, the second language joins a moment later and catches up from the buffer.
  var attach: Task<Void, Never>?
  if locales.count > 1, #available(macOS 26.0, *) {
    let late = tracks
    attach = Task { @MainActor in
      try? await Task.sleep(nanoseconds: 1_500_000_000)
      for track in late {
        await attachCandidate(track, locale: locales[1], id: id, context: []) { true }
      }
    }
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
  await attach?.value
  for track in tracks { try track.closeAudio() }
  await withTaskGroup(of: Void.self) { group in
    for track in tracks { group.addTask { @MainActor in await track.speech?.finish() } }
  }
  eventObserver = nil
  emit([
    "type": "retranscription-completed", "recordingId": id, "segments": segments, "streamed": true,
    "dualSource": dualSource, "timeline": timeline,
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
  // A long gap (the Mac slept) is written in full; recognition hears two seconds and skips the rest.
  let later = directory.appendingPathComponent("gap")
  try FileManager.default.createDirectory(at: later, withIntermediateDirectories: true)
  let sleeper = try AudioTrack(
    source: "microphone", recordingId: "capture-self-test", directory: later, start: Date())
  sleeper.events = false
  sleeper.startOffset = 0
  let speech = ObservedSpeech()
  sleeper.speech = speech
  try sleeper.save(signal)
  try sleeper.pad(to: 601)
  guard sleeper.writer.frames == 601 * 16000, speech.heard == 3 * 16000,
    abs(speech.skipped - 598) < 0.001
  else { throw problem("A long gap must be written in full and skipped by recognition.") }
  try sleeper.closeAudio()
  guard try AVAudioFile(forReading: sleeper.writer.url).length == 601 * 16000 else {
    throw problem("Long-gap WAV header/frame count mismatch.")
  }
  // Buffered system audio is replayed in one-second blocks with every sample in order.
  let small = (0..<470).map { i -> (buffer: AVAudioPCMBuffer, offset: TimeInterval) in
    let buffer = AVAudioPCMBuffer(pcmFormat: track.format, frameCapacity: 341)!
    buffer.frameLength = 341
    for j in 0..<341 { buffer.floatChannelData![0][j] = Float(i * 341 + j) }
    return (buffer, 5 + Double(i * 341) / 16000)
  }
  let blocks = merged(small, seconds: 1)
  let joined = blocks.flatMap { block in
    (0..<Int(block.buffer.frameLength)).map { block.buffer.floatChannelData![0][$0] }
  }
  guard blocks.count == 11, blocks[0].offset == 5, joined.count == 470 * 341,
    joined.enumerated().allSatisfy({ $0.element == Float($0.offset) })
  else { throw problem("Merged audio blocks lost or reordered samples.") }
  // A microphone that keeps resetting is retried again once the limit's window has passed.
  var limiter = RestartLimiter()
  let t0 = Date()
  let allowed = stride(from: 0.0, through: 30, by: 2).filter {
    limiter.allow(at: t0.addingTimeInterval($0))
  }
  guard allowed == [0, 2, 4, 10, 12, 14, 20, 22, 24, 30] else {
    throw problem("Microphone restarts never resume after the limit.")
  }
  // Meeting detection names the other apps using a microphone, once each, never Stillnote's own
  // capture, and reads the current state without opening an input.
  let own = getpid()
  let zoom = { (_: Int32) in "us.zoom.xos" }
  guard inputApps([(pid: own, input: true), (pid: own + 1, input: false)], own: own, app: zoom)
    .isEmpty,
    inputApps(
      [(pid: own, input: true), (pid: own + 1, input: true), (pid: own + 2, input: true)],
      own: own, app: zoom) == ["us.zoom.xos"],
    !owningApp(own).isEmpty
  else { throw problem("Meeting detection counted Stillnote's own microphone use.") }
  _ = microphoneUsers()
  // The reminder panel's bar takes the calendar's color as sRGB hex.
  guard hexColor(CGColor(srgbRed: 1, green: 0.5, blue: 0, alpha: 1)) == "#ff8000",
    hexColor(nil) == nil
  else { throw problem("Calendar colors are not reported as sRGB hex.") }
  emit([
    "type": "capture-self-test", "status": "passed", "checks": 12,
    "paddedFrames": 20000, "sampleCount": file.length, "liveAudioInvoked": false,
  ])
}

// Records what a track sends to recognition, for the self-test.
@MainActor
final class ObservedSpeech: SpeechChannel {
  var errors = 0
  var timeouts = 0
  var heard: AVAudioFrameCount = 0
  var skipped: TimeInterval = 0
  var finished = false
  func append(_ buffer: AVAudioPCMBuffer, offset: TimeInterval) { heard += buffer.frameLength }
  func skip(_ seconds: TimeInterval) { skipped += seconds }
  func finish() async { finished = true }
}

// Deterministic model-startup and retry tests: no microphone, permission or model is used.
@MainActor
func recognitionLifecycleSelfTest() async throws {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(
    "stillnote-recognition-test-" + UUID().uuidString)
  defer { try? FileManager.default.removeItem(at: root) }
  var checks = 0
  for mode in ["delayed", "failed", "pending"] {
    let directory = root.appendingPathComponent(mode)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let session = Capture()
    session.recordingId = UUID().uuidString
    session.started = Date()
    let generation = session.operation
    var gates: [CheckedContinuation<Void, Never>] = []
    var channels: [ObservedSpeech] = []
    var jobs: [Task<Void, Never>] = []
    var failures = 0
    for source in ["microphone", "system"] {
      let track = try AudioTrack(
        source: source, recordingId: session.recordingId,
        directory: directory, start: session.started!)
      track.events = false
      track.preRoll = []
      session.tracks[source] = track
      let observed = ObservedSpeech()
      channels.append(observed)
      let job = Task { @MainActor in
        await attachPrimary(
          track, keepBuffer: false,
          make: {
            await withCheckedContinuation { gates.append($0) }
            if mode == "failed" { throw problem("Injected missing model") }
            return observed
          }, stillWanted: { generation == session.operation }, failed: { _ in failures += 1 })
      }
      jobs.append(job)
      session.speechSetup.append(job)
    }
    while gates.count < 2 { await Task.yield() }
    let buffer = AVAudioPCMBuffer(
      pcmFormat: session.tracks["microphone"]!.format, frameCapacity: 16000)!
    buffer.frameLength = 16000
    for index in 0..<16000 { buffer.floatChannelData![0][index] = 0.1 }
    for track in session.tracks.values {
      for _ in 0..<13 { try track.process(buffer) }
      guard track.writer.frames == 13 * 16000, track.preRollFrames <= 10 * 16000,
        track.speech == nil
      else { throw problem("Model preparation blocked raw audio or exceeded its buffer bound.") }
      checks += 1
    }
    if mode != "pending" {
      for gate in gates { gate.resume() }
      for job in jobs { await job.value }
      if mode == "delayed" {
        guard channels.allSatisfy({ $0.heard == 10 * 16000 }) else {
          throw problem("Delayed recognizer did not replay the retained audio.")
        }
      } else {
        guard failures == 2 else {
          throw problem("Failed initialization was not reported per source.")
        }
      }
    }
    // This must return even when the injected model factory ignores cancellation and has not
    // returned. Resume it only after Stop to assert that it cannot attach to the retired capture.
    await session.stop()
    if mode == "pending" {
      guard jobs.allSatisfy({ $0.isCancelled }) else {
        throw problem("Stop did not cancel pending model setup.")
      }
      session.operation += 1
      for gate in gates { gate.resume() }
      for job in jobs { await job.value }
      guard channels.allSatisfy({ $0.heard == 0 && $0.finished }) else {
        throw problem("A late recognizer attached after Stop.")
      }
    }
    for source in ["microphone", "system"] {
      let file = try AVAudioFile(forReading: directory.appendingPathComponent(source + ".wav"))
      guard file.length == 13 * 16000 else {
        throw problem("Raw audio was lost while recognition initialized.")
      }
    }
    checks += 2
  }
  for failing in ["first", "second", "both", "neither", "silent"] {
    var tried: [String] = []
    var returned = false
    do {
      let result = try await recognizeCandidates(["first", "second"]) { _, locale in
        tried.append(locale)
        if failing == locale || failing == "both" { throw problem("Injected unavailable locale") }
        return failing == "silent" ? [] : [["text": locale]]
      }
      returned = true
      guard tried == ["first", "second"],
        result.segments.count == (failing == "silent" ? 0 : failing == "neither" ? 2 : 1),
        result.failures.count == (["first", "second"].contains(failing) ? 1 : 0)
      else { throw problem("Candidate fallback dropped a usable language.") }
    } catch {
      guard failing == "both", tried.count == 2 else { throw error }
    }
    guard returned == (failing != "both") else {
      throw problem("All failed candidates returned a replacement.")
    }
    checks += 1
  }
  // A single language that fails says why, instead of the general message.
  let missing =
    "Download the zh-CN language in Settings to enable transcription. Audio is still saved."
  do {
    _ = try await recognizeCandidates(["zh-CN"]) { _, _ in throw problem(missing) }
    throw problem("A failed single-language retry returned a replacement.")
  } catch {
    guard error.localizedDescription == missing else {
      throw problem("A failed single-language retry hid its reason: \(error.localizedDescription)")
    }
  }
  checks += 1
  var sourcesCompleted = 0
  do {
    for source in ["microphone", "system"] {
      _ = try await recognizeCandidates(["first", "second"]) { _, _ in
        if source == "system" { throw problem("Injected source failure") }
        return [["text": "valid microphone"]]
      }
      sourcesCompleted += 1
    }
    throw problem("A source with no valid candidate was silently replaced.")
  } catch {
    guard sourcesCompleted == 1 else { throw error }
  }
  emit([
    "type": "recognition-self-test", "status": "passed", "checks": checks + 1,
    "speechRecognitionInvoked": false, "liveAudioInvoked": false,
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

// The app reading these events may be gone; writing must then fail quietly instead of ending the
// helper before it has closed the recording.
signal(SIGPIPE, SIG_IGN)
let capture = MainActor.assumeIsolated { Capture() }
let microphoneWatch = MainActor.assumeIsolated { MicrophoneWatch() }
let events = EKEventStore()
var transcribing = false
var transcribingId: String?
// A calendar's color as #rrggbb in sRGB, for the reminder panel's bar; nil when it has none.
func hexColor(_ color: CGColor?) -> String? {
  guard let srgb = CGColorSpace(name: CGColorSpace.sRGB),
    let parts = color?.converted(to: srgb, intent: .defaultIntent, options: nil)?.components,
    parts.count >= 3
  else { return nil }
  let channel = { (value: CGFloat) in Int((min(max(value, 0), 1) * 255).rounded()) }
  return String(format: "#%02x%02x%02x", channel(parts[0]), channel(parts[1]), channel(parts[2]))
}
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
      "location": e.location ?? "", "notes": e.notes ?? "", "url": e.url?.absoluteString ?? "",
      "allDay": e.isAllDay, "color": hexColor(e.calendar?.cgColor) ?? "",
    ]
  }
  emit(["type": "calendar", "events": rows])
}
func command(_ data: Data) {
  guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
    let op = obj["op"] as? String
  else { return }
  Task { @MainActor in
    do {
      switch op {
      case "start":
        let id = obj["recordingId"] as? String ?? ""
        do {
          guard !transcribing else {
            throw problem("Wait for the transcription retry to finish, then start recording.")
          }
          guard let directory = obj["audioDir"] as? String, directory.hasPrefix("/"),
            UUID(uuidString: id) != nil
          else {
            throw problem("Recording requires a valid local audio directory and session ID.")
          }
          try await capture.start(
            locale: obj["locale"] as? String ?? "en-US",
            includeSystem: obj["systemAudio"] as? Bool ?? true,
            directory: URL(fileURLWithPath: directory), id: id,
            inputDevice: obj["inputDevice"] as? String, context: contextHints(obj["context"]),
            echoCancellation: obj["echoCancellation"] as? String ?? "auto",
            locales: obj["locales"] as? [String] ?? [])
        } catch is CancellationError { return } catch {
          emit([
            "type": "error", "op": op, "recordingId": id, "message": error.localizedDescription,
          ])
          // Only this start's own half-started capture is stopped, never a recording in progress.
          if capture.recordingId == id { await capture.stop(status: "failed") }
        }
      case "stop": await capture.stop()
      case "cancel-transcribe":
        if let id = obj["recordingId"] as? String, id == transcribingId {
          transcriptionCancelled = true
          transcriptionCancel?()
        } else if !transcribing {
          emit(["type": "transcription-cancelled", "recordingId": obj["recordingId"] ?? ""])
        }
      case "transcribe":
        guard !transcribing, capture.started == nil, !capture.isStarting, !capture.stopping,
          let id = obj["recordingId"] as? String,
          let tracks = obj["tracks"] as? [[String: Any]]
        else { throw problem("Finish the current operation before retrying transcription.") }
        transcribing = true
        transcribingId = id
        transcriptionCancelled = false
        do {
          try await transcribe(
            tracks, id: id,
            locales: (obj["locales"] as? [String]).flatMap { $0.isEmpty ? nil : $0 }
              ?? [obj["locale"] as? String ?? "en-US"],
            context: contextHints(obj["context"]))
        } catch {
          emit([
            "type": "retranscription-error", "recordingId": id,
            "message": error.localizedDescription,
          ])
        }
        transcribing = false
        transcribingId = nil
        if transcriptionCancelled { emit(["type": "transcription-cancelled", "recordingId": id]) }
      case "devices": emit(["type": "devices", "inputs": inputDevices().map { $0.json }])
      case "languages": emit(await languages())
      case "install-language":
        let locale = obj["locale"] as? String ?? ""
        do { try await installLanguage(locale) } catch {
          emit(["type": "error", "op": op, "locale": locale, "message": error.localizedDescription])
        }
      case "calendar": try await calendar()
      case "watch-microphone":
        if obj["enabled"] as? Bool ?? true {
          microphoneWatch.start()
        } else {
          microphoneWatch.stop()
        }
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
if CommandLine.arguments.contains("--recognition-self-test") {
  Task { @MainActor in
    do {
      try await recognitionLifecycleSelfTest()
      exit(0)
    } catch {
      emit([
        "type": "recognition-self-test", "status": "failed", "message": error.localizedDescription,
      ])
      exit(1)
    }
  }
  RunLoop.main.run()
  exit(1)
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
          locales: argument("--locales")?.split(separator: ",").map(String.init)
            ?? [argument("--locale") ?? "en-US"],
          dualSource: CommandLine.arguments.contains("--dual-source"))
      } else {
        try await transcribe(
          [["source": "microphone", "path": CommandLine.arguments[index + 1], "startOffset": 0]],
          id: id,
          locales: argument("--locales")?.split(separator: ",").map(String.init)
            ?? [argument("--locale") ?? "en-US"])
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
    // The app quit or crashed: cancel a retry, let a stop in progress finish, save a recording.
    handle.readabilityHandler = nil
    DispatchQueue.main.async {
      Task { @MainActor in
        if transcribing {
          transcriptionCancelled = true
          transcriptionCancel?()
        }
        let deadline = Date().addingTimeInterval(45)
        while capture.stopping || transcribing, Date() < deadline {
          try? await Task.sleep(nanoseconds: 50_000_000)
        }
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
