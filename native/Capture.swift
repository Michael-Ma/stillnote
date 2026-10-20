import Foundation
import AppKit
import AVFoundation
import Speech
import ScreenCaptureKit
import EventKit

func emit(_ value: [String: Any]) { if let data = try? JSONSerialization.data(withJSONObject: value), let line = String(data: data, encoding: .utf8) { print(line); fflush(stdout) } }
func fail(_ message: String) { emit(["type":"error", "message":message]) }

final class SpeechChannel {
    let label: String
    let recognizer: SFSpeechRecognizer
    var request: SFSpeechAudioBufferRecognitionRequest?
    var task: SFSpeechRecognitionTask?
    var timer: Timer?
    var generation = 0
    var latest = ""
    var offset: TimeInterval = 0
    let start: Date
    var active = true
    var ending = false
    init(label: String, locale: String, start: Date) throws {
        self.label = label; self.start = start
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)), recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else { throw NSError(domain: "Stillnote", code: 1, userInfo: [NSLocalizedDescriptionKey:"On-device speech recognition is not available for \(locale). Enable Dictation and download this language in macOS System Settings, or choose another language."]) }
        self.recognizer = recognizer
        rotate()
        timer = Timer.scheduledTimer(withTimeInterval: 45, repeats: true) { [weak self] _ in self?.rotate() }
    }
    func commit() { if !latest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { emit(["type":"segment", "speaker":label, "text":latest, "timestamp":offset]) }; latest = "" }
    func rotate() {
        generation += 1; let g = generation
        commit(); request?.endAudio(); task?.cancel()
        offset = Date().timeIntervalSince(start)
        let req = SFSpeechAudioBufferRecognitionRequest(); req.shouldReportPartialResults = true; req.requiresOnDeviceRecognition = true
        req.taskHint = .dictation; request = req
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, self.active, self.generation == g else { return }
                if let result { self.latest = result.bestTranscription.formattedString; emit(["type":"partial", "speaker":self.label, "text":self.latest, "timestamp":self.offset]); if result.isFinal { if self.ending { self.commit() } else { self.rotate() } } }
                else if let error, !self.ending { emit(["type":"warning", "message":"\(self.label): \(error.localizedDescription). Restarting speech recognition."]); DispatchQueue.main.asyncAfter(deadline: .now()+1) { if self.active && !self.ending && self.generation == g { self.rotate() } } }
            }
        }
    }
    func append(_ buffer: AVAudioPCMBuffer) { request?.append(buffer) }
    func endAudio() { ending = true; timer?.invalidate(); request?.endAudio() }
    func stop() { active = false; timer?.invalidate(); generation += 1; commit(); request?.endAudio(); task?.cancel(); task = nil; request = nil }
}
final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
    var engine: AVAudioEngine?
    var stream: SCStream?
    var mic: SpeechChannel?
    var system: SpeechChannel?
    var started: Date?
    var operation = 0
    let audioQueue = DispatchQueue(label:"local.stillnote.audio")
    func start(locale: String, includeSystem: Bool) async throws {
        guard engine == nil else { throw NSError(domain:"Stillnote",code:2,userInfo:[NSLocalizedDescriptionKey:"Already recording."]) }
        operation += 1; let generation = operation
        let micGranted = await AVCaptureDevice.requestAccess(for: .audio)
        guard generation == operation else { throw CancellationError() }
        guard micGranted else { throw NSError(domain:"Stillnote",code:3,userInfo:[NSLocalizedDescriptionKey:"Allow Microphone access for Stillnote in System Settings → Privacy & Security."]) }
        let speechStatus = await withCheckedContinuation { continuation in SFSpeechRecognizer.requestAuthorization { continuation.resume(returning:$0) } }
        guard generation == operation else { throw CancellationError() }
        guard speechStatus == .authorized else { throw NSError(domain:"Stillnote",code:4,userInfo:[NSLocalizedDescriptionKey:"Allow Speech Recognition for Stillnote in System Settings → Privacy & Security."]) }
        let start = Date(); started = start
        mic = try SpeechChannel(label:"You",locale:locale,start:start)
        let engine = AVAudioEngine(); self.engine = engine
        let input = engine.inputNode; let format = input.outputFormat(forBus:0)
        guard format.sampleRate > 0 else { await stop(); throw NSError(domain:"Stillnote",code:5,userInfo:[NSLocalizedDescriptionKey:"No microphone input is available."]) }
        input.installTap(onBus:0,bufferSize:4096,format:format) { [weak self] buffer, _ in
            guard let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) else { return }
            copy.frameLength = buffer.frameLength
            let source = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
            let target = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
            for i in 0..<min(source.count,target.count) { if let src=source[i].mData, let dst=target[i].mData { memcpy(dst,src,Int(source[i].mDataByteSize)) } }
            DispatchQueue.main.async { self?.mic?.append(copy) }
        }
        do { try engine.start() } catch { await stop(); throw error }
        var systemActive = false
        if includeSystem {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false,onScreenWindowsOnly:true)
                guard generation == operation else { throw CancellationError() }
                guard let display = content.displays.first else { throw NSError(domain:"Stillnote",code:6,userInfo:[NSLocalizedDescriptionKey:"No display is available for meeting audio capture."]) }
                let filter = SCContentFilter(display:display,excludingApplications:[],exceptingWindows:[])
                let config = SCStreamConfiguration(); config.capturesAudio = true; config.excludesCurrentProcessAudio = true; config.sampleRate = 16000; config.channelCount = 1; config.width = 2; config.height = 2; config.minimumFrameInterval = CMTime(value:1,timescale:1)
                system = try SpeechChannel(label:"Meeting audio",locale:locale,start:start)
                let stream = SCStream(filter:filter,configuration:config,delegate:self)
                try stream.addStreamOutput(self,type:.audio,sampleHandlerQueue:audioQueue)
                try await stream.startCapture()
                guard generation == operation else { try? await stream.stopCapture(); throw CancellationError() }
                self.stream = stream; systemActive = true
            } catch { system?.stop(); system = nil; emit(["type":"warning","message":"Microphone is active, but meeting audio is unavailable: \(error.localizedDescription). Enable Screen & System Audio Recording for Stillnote and restart the app."]) }
        }
        if generation == operation { emit(["type":"started","systemAudio":systemActive]) }
    }
    func stop() async {
        operation += 1
        engine?.stop(); engine?.inputNode.removeTap(onBus:0); engine = nil
        if let stream { try? await stream.stopCapture() }; stream = nil
        mic?.endAudio(); system?.endAudio()
        if mic != nil || system != nil { try? await Task.sleep(nanoseconds: 1_200_000_000) }
        mic?.stop(); system?.stop(); mic = nil; system = nil
        emit(["type":"stopped","duration":started.map{Date().timeIntervalSince($0)} ?? 0]); started = nil
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) { DispatchQueue.main.async { self.system?.stop();self.system=nil;emit(["type":"warning","message":"Meeting audio stopped: \(error.localizedDescription). Microphone capture continues."]) } }
    func stream(_ stream: SCStream,didOutputSampleBuffer sampleBuffer: CMSampleBuffer,of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid, let desc=CMSampleBufferGetFormatDescription(sampleBuffer), let asbd=CMAudioFormatDescriptionGetStreamBasicDescription(desc), let format=AVAudioFormat(streamDescription:asbd) else { return }
        var needed=0
        CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sampleBuffer,bufferListSizeNeededOut:&needed,bufferListOut:nil,bufferListSize:0,blockBufferAllocator:nil,blockBufferMemoryAllocator:nil,flags:0,blockBufferOut:nil)
        let raw=UnsafeMutableRawPointer.allocate(byteCount:needed,alignment:MemoryLayout<AudioBufferList>.alignment); defer { raw.deallocate() }
        let list=raw.bindMemory(to:AudioBufferList.self,capacity:1);var block:CMBlockBuffer?
        guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sampleBuffer,bufferListSizeNeededOut:nil,bufferListOut:list,bufferListSize:needed,blockBufferAllocator:nil,blockBufferMemoryAllocator:nil,flags:UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment),blockBufferOut:&block)==noErr,
          let pcm=AVAudioPCMBuffer(pcmFormat:format,frameCapacity:AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))) else { return }
        pcm.frameLength=pcm.frameCapacity
        let src=UnsafeMutableAudioBufferListPointer(list),dst=UnsafeMutableAudioBufferListPointer(pcm.mutableAudioBufferList)
        for i in 0..<min(src.count,dst.count) { if let s=src[i].mData,let d=dst[i].mData { memcpy(d,s,min(Int(src[i].mDataByteSize),Int(dst[i].mDataByteSize))) } }
        DispatchQueue.main.async { self.system?.append(pcm) }
    }
}
let capture=Capture()
let events=EKEventStore()
func calendar() async throws {
    let allowed:Bool
    if #available(macOS 14.0, *) { allowed=try await events.requestFullAccessToEvents() }
    else { allowed=try await events.requestAccess(to:.event) }
    guard allowed else { throw NSError(domain:"Stillnote",code:7,userInfo:[NSLocalizedDescriptionKey:"Allow Calendar access in System Settings → Privacy & Security."]) }
    let from=Calendar.current.startOfDay(for:Date()),to=Calendar.current.date(byAdding:.day,value:7,to:from)!
    let rows=events.events(matching:events.predicateForEvents(withStart:from,end:to,calendars:nil)).sorted{$0.startDate<$1.startDate}.map { e -> [String:Any] in
        ["id":e.eventIdentifier ?? UUID().uuidString,"title":e.title ?? "Meeting","start":ISO8601DateFormatter().string(from:e.startDate),"end":ISO8601DateFormatter().string(from:e.endDate),"participants":(e.attendees ?? []).compactMap{$0.name}.joined(separator:", "),"location":e.location ?? "","notes":e.notes ?? ""]
    }
    emit(["type":"calendar","events":rows])
}
func command(_ data:Data) {
    guard let obj=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],let op=obj["op"] as? String else{return}
    Task { @MainActor in
        do {
            switch op {
            case "start": try await capture.start(locale:obj["locale"] as? String ?? "en-US",includeSystem:obj["systemAudio"] as? Bool ?? false)
            case "stop": await capture.stop()
            case "calendar": try await calendar()
            case "status": emit(["type":"status","microphone":AVCaptureDevice.authorizationStatus(for:.audio).rawValue,"speech":SFSpeechRecognizer.authorizationStatus().rawValue,"locales":SFSpeechRecognizer.supportedLocales().map{$0.identifier}.sorted()])
            default: fail("Unknown native operation.")
            }
        } catch { fail(error.localizedDescription) }
    }
}
var input=Data()
FileHandle.standardInput.readabilityHandler = { handle in
    let bytes=handle.availableData
    if bytes.isEmpty { DispatchQueue.main.async { Task { await capture.stop(); exit(0) } }; return }
    input.append(bytes)
    while let index=input.firstIndex(of:10) { let line=input.prefix(upTo:index); input.removeSubrange(...index); DispatchQueue.main.async { command(Data(line)) } }
}
if CommandLine.arguments.contains("--self-test") { emit(["type":"ready","platform":"macOS","speechLocales":SFSpeechRecognizer.supportedLocales().count]); exit(0) }
emit(["type":"ready","platform":"macOS"])
RunLoop.main.run()
