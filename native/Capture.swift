// Every PCM buffer crossing queues is copied and then transferred to the main actor.
@preconcurrency import AVFoundation
import AppKit
import EventKit
import Foundation
import ScreenCaptureKit
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
final class RecognitionWindow {
  let id = UUID().uuidString
  let request = SFSpeechAudioBufferRecognitionRequest()
  let offset: TimeInterval
  var task: SFSpeechRecognitionTask?
  var latest = ""
  var firstWordTime: TimeInterval = 0
  var frames: Int64 = 0
  var ended = false
  var finalized = false
  init(offset: TimeInterval) {
    self.offset = offset
    request.shouldReportPartialResults = true
    request.requiresOnDeviceRecognition = true
    request.taskHint = .dictation
  }
}

@MainActor
final class SpeechChannel {
  let source: String
  let speaker: String
  let recordingId: String
  let recognizer: SFSpeechRecognizer
  var current: RecognitionWindow?
  var windows: [RecognitionWindow] = []
  var finishing = false
  var errors = 0
  var timeouts = 0
  init(source: String, locale: String, recordingId: String) throws {
    self.source = source
    speaker = source == "microphone" ? "You" : "Meeting audio"
    self.recordingId = recordingId
    guard let r = SFSpeechRecognizer(locale: Locale(identifier: locale)),
      r.supportsOnDeviceRecognition, r.isAvailable
    else {
      throw problem(
        "On-device recognition is unavailable for \(locale). Your audio is still being saved. Install the language in macOS Dictation settings, then retry transcription."
      )
    }
    recognizer = r
  }
  func startWindow(offset: TimeInterval) -> RecognitionWindow {
    let window = RecognitionWindow(offset: offset)
    windows.append(window)
    current = window
    window.task = recognizer.recognitionTask(with: window.request) {
      [weak self, weak window] result, error in
      DispatchQueue.main.async {
        guard let self, let window, !window.finalized else { return }
        if let result {
          window.latest = result.bestTranscription.formattedString
          window.firstWordTime = result.bestTranscription.segments.first?.timestamp ?? 0
          emit([
            "type": "partial", "recordingId": self.recordingId, "segmentId": window.id,
            "source": self.source, "speaker": self.speaker, "text": window.latest,
            "timestamp": window.offset + window.firstWordTime,
          ])
          if result.isFinal { self.finalize(window, partial: false) }
        } else if let error {
          self.errors += 1
          let ns = error as NSError
          if ns.code != 1110 && !self.finishing {
            emit([
              "type": "warning", "recordingId": self.recordingId, "source": self.source,
              "message":
                "\(self.speaker) recognition: \(error.localizedDescription). Original audio continues to be saved.",
            ])
          }
          self.finalize(window, partial: true)
        }
      }
    }
    return window
  }
  func append(_ buffer: AVAudioPCMBuffer, offset: TimeInterval) {
    guard !finishing else { return }
    let window = current ?? startWindow(offset: offset)
    window.request.append(buffer)
    window.frames += Int64(buffer.frameLength)
    if window.frames >= 40 * 16000 { drain(window) }
  }
  func drain(_ window: RecognitionWindow) {
    guard !window.ended, !window.finalized else { return }
    window.ended = true
    window.request.endAudio()
    if current === window { current = nil }
    // Do not cancel or invalidate this task on rotation: its final result often
    // arrives AFTER the next window has begun. Each window has its own identity.
    DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self, weak window] in
      guard let self, let window, !window.finalized else { return }
      self.timeouts += 1
      self.finalize(window, partial: true)
    }
  }
  func finalize(_ window: RecognitionWindow, partial: Bool) {
    guard !window.finalized else { return }
    window.finalized = true
    if !window.latest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      emit([
        "type": "segment", "recordingId": recordingId, "segmentId": window.id, "source": source,
        "speaker": speaker, "text": window.latest,
        "timestamp": window.offset + window.firstWordTime, "partial": partial,
      ])
    }
    if current === window { current = nil }
    window.request.endAudio()
    if partial { window.task?.cancel() }
    window.task = nil
    windows.removeAll { $0.finalized }
  }
  func finish() async {
    finishing = true
    for window in windows { drain(window) }
    let deadline = Date().addingTimeInterval(16)
    while windows.contains(where: { !$0.finalized }) && Date() < deadline {
      try? await Task.sleep(nanoseconds: 100_000_000)
    }
    for window in windows where !window.finalized {
      timeouts += 1
      finalize(window, partial: true)
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
  init(source: String, recordingId: String, directory: URL, start: Date) throws {
    self.source = source
    self.recordingId = recordingId
    self.start = start
    writer = try WAVWriter(
      url: directory.appendingPathComponent(
        source == "microphone" ? "microphone.wav" : "system.wav"))
  }
  func accept(_ buffer: AVAudioPCMBuffer) {
    guard !closed else { return }
    do { try process(buffer) } catch {
      captureError = error.localizedDescription
      emit([
        "type": "warning", "recordingId": recordingId, "source": source,
        "message": "Cannot save \(source) audio: \(error.localizedDescription)",
      ])
      closed = true
      try? writer.close()
    }
  }
  func process(_ buffer: AVAudioPCMBuffer) throws {
    guard buffer.frameLength > 0 else { return }
    if startOffset == nil { startOffset = max(0, Date().timeIntervalSince(start)) }
    if inputFormat == nil || !inputFormat!.isEqual(buffer.format) {
      converter = AVAudioConverter(from: buffer.format, to: format)
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
  let audioQueue = DispatchQueue(label: "local.stillnote.audio")
  func start(locale: String, includeSystem: Bool, directory: URL, id: String) async throws {
    guard engine == nil, !isStarting, !stopping else {
      throw problem("Already recording or finishing a recording.")
    }
    operation += 1
    let generation = operation
    isStarting = true
    recordingId = id
    defer { if generation == operation { isStarting = false } }
    guard await AVCaptureDevice.requestAccess(for: .audio) else {
      throw problem(
        "Allow Microphone access for Stillnote in System Settings → Privacy & Security.")
    }
    guard generation == operation else { throw CancellationError() }
    var speechStatus = SFSpeechRecognizer.authorizationStatus()
    if speechStatus == .notDetermined {
      speechStatus = await withCheckedContinuation { c in
        SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
      }
    }
    guard generation == operation else { throw CancellationError() }
    if speechStatus != .authorized {
      emit([
        "type": "warning", "recordingId": id,
        "message":
          "Speech Recognition permission is unavailable. Original audio will be saved for playback; enable permission and retry transcription later.",
      ])
    }
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let start = Date()
    started = start
    tracks = [:]
    let mic = try AudioTrack(
      source: "microphone", recordingId: id, directory: directory, start: start)
    tracks["microphone"] = mic
    if speechStatus == .authorized {
      do {
        mic.speech = try SpeechChannel(source: "microphone", locale: locale, recordingId: id)
      } catch {
        emit(["type": "warning", "recordingId": id, "message": error.localizedDescription])
      }
    }
    let engine = AVAudioEngine()
    self.engine = engine
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      throw problem("No microphone input is available.")
    }
    input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
      guard let copy = copyPCM(buffer) else { return }
      DispatchQueue.main.async {
        guard let self, self.recordingId == id else { return }
        self.tracks["microphone"]?.accept(copy)
      }
    }
    try engine.start()
    var systemActive = false
    var sources: [String: [String: String]] = [
      "microphone": ["status": "recording"],
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
        let filter = SCContentFilter(
          display: display, excludingApplications: [], exceptingWindows: [])
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
        if speechStatus == .authorized {
          do {
            track.speech = try SpeechChannel(source: "system", locale: locale, recordingId: id)
          } catch {
            emit(["type": "warning", "recordingId": id, "message": error.localizedDescription])
          }
        }
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)
        try await stream.startCapture()
        guard generation == operation else {
          try? await stream.stopCapture()
          throw CancellationError()
        }
        self.stream = stream
        systemActive = true
        sources["system"] = ["status": "recording"]
      } catch {
        if generation != operation { throw CancellationError() }
        sources["system"] = ["status": "unavailable", "message": error.localizedDescription]
        emit([
          "type": "warning", "recordingId": id,
          "message":
            "Microphone capture continues, but system audio is unavailable: \(error.localizedDescription). Check Screen & System Audio Recording permission.",
        ])
      }
    }
    guard generation == operation else { throw CancellationError() }
    emit([
      "type": "started", "recordingId": id, "systemAudio": systemActive, "sources": sources,
      "startedAt": start.timeIntervalSince1970 * 1000,
    ])
  }
  func stop(status: String = "completed") async {
    guard !stopping else { return }
    stopping = true
    operation += 1
    isStarting = false
    let id = recordingId
    let duration = started.map { Date().timeIntervalSince($0) } ?? 0
    engine?.stop()
    if let engine { engine.inputNode.removeTap(onBus: 0) }
    engine = nil
    if let stream { try? await stream.stopCapture() }
    stream = nil
    // Let already-enqueued copies reach the serialized writer before closing files.
    try? await Task.sleep(nanoseconds: 50_000_000)
    for track in tracks.values {
      do { try track.closeAudio() } catch {
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
      guard !self.stopping else { return }
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
    DispatchQueue.main.async { self.tracks["system"]?.accept(pcm) }
  }
}

@MainActor
func recognizeFile(_ url: URL, recognizer: SFSpeechRecognizer) async throws -> (
  String, TimeInterval
) {
  try await withCheckedThrowingContinuation { continuation in
    let request = SFSpeechURLRecognitionRequest(url: url)
    request.requiresOnDeviceRecognition = true
    request.shouldReportPartialResults = false
    var task: SFSpeechRecognitionTask?
    var done = false
    let timeout = DispatchWorkItem {
      if !done {
        done = true
        task?.cancel()
        continuation.resume(
          throwing: problem("On-device transcription timed out. The recording is preserved."))
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 70, execute: timeout)
    task = recognizer.recognitionTask(with: request) { result, error in
      DispatchQueue.main.async {
        guard !done else { return }
        if let result, result.isFinal {
          done = true
          timeout.cancel()
          continuation.resume(
            returning: (
              result.bestTranscription.formattedString,
              result.bestTranscription.segments.first?.timestamp ?? 0
            ))
          task = nil
        } else if let error {
          done = true
          timeout.cancel()
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
func transcribe(_ input: [[String: Any]], id: String, locale: String) async throws {
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
          chunkTrack.writer.url, recognizer: recognizer)
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
func streamedRecognition(input: URL, id: String, locale: String) async throws {
  var permission = SFSpeechRecognizer.authorizationStatus()
  if permission == .notDetermined {
    permission = await withCheckedContinuation { c in
      SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
    }
  }
  guard permission == .authorized else {
    throw problem("Speech Recognition permission is required for this test.")
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
  let track = try AudioTrack(
    source: "microphone", recordingId: id, directory: temporary, start: Date())
  track.events = false
  track.startOffset = 0
  track.speech = try SpeechChannel(source: "microphone", locale: locale, recordingId: id)
  let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 4096)!
  while file.framePosition < file.length {
    try file.read(into: buffer)
    guard buffer.frameLength > 0 else { break }
    try track.process(buffer)
    try await Task.sleep(
      nanoseconds: UInt64(
        Double(buffer.frameLength) / file.processingFormat.sampleRate * 1_000_000_000))
  }
  try track.closeAudio()
  await track.speech?.finish()
  eventObserver = nil
  emit([
    "type": "retranscription-completed", "recordingId": id, "segments": segments, "streamed": true,
    "diagnostics": track.stats(),
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
      "location": e.location ?? "", "notes": e.notes ?? "",
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
        guard !transcribing, let directory = obj["audioDir"] as? String, directory.hasPrefix("/"),
          let id = obj["recordingId"] as? String, UUID(uuidString: id) != nil
        else { throw problem("Recording requires a valid local audio directory and session ID.") }
        do {
          try await capture.start(
            locale: obj["locale"] as? String ?? "en-US",
            includeSystem: obj["systemAudio"] as? Bool ?? true,
            directory: URL(fileURLWithPath: directory), id: id)
        } catch is CancellationError { return } catch {
          emit([
            "type": "error", "op": op, "recordingId": id, "message": error.localizedDescription,
          ])
          await capture.stop(status: "failed")
        }
      case "stop": await capture.stop()
      case "transcribe":
        guard !transcribing, capture.engine == nil, let id = obj["recordingId"] as? String,
          let tracks = obj["tracks"] as? [[String: Any]]
        else { throw problem("Finish the current operation before retrying transcription.") }
        transcribing = true
        do {
          try await transcribe(tracks, id: id, locale: obj["locale"] as? String ?? "en-US")
        } catch {
          emit([
            "type": "retranscription-error", "recordingId": id,
            "message": error.localizedDescription,
          ])
        }
        transcribing = false
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
if CommandLine.arguments.contains("--self-test") {
  emit([
    "type": "ready", "platform": "macOS",
    "speechLocales": SFSpeechRecognizer.supportedLocales().count,
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
          locale: argument("--locale") ?? "en-US")
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
      Task {
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
