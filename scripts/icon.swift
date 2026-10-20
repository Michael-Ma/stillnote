import AppKit
let root = CommandLine.arguments[1]
let image = NSImage(size: NSSize(width: 1024, height: 1024))
image.lockFocus()
NSColor(calibratedRed: 0.83, green: 0.88, blue: 0.70, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: 1024, height: 1024), xRadius: 220, yRadius: 220).fill()
NSColor(calibratedRed: 0.97, green: 0.98, blue: 0.94, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 246, y: 185, width: 540, height: 660), xRadius: 55, yRadius: 55).fill()
NSColor(calibratedRed: 0.29, green: 0.35, blue: 0.22, alpha: 1).setStroke()
for y in [660, 540, 420] {
 let line = NSBezierPath(); line.move(to: NSPoint(x: 348, y: y)); line.line(to: NSPoint(x: y == 420 ? 558 : 675, y: y)); line.lineWidth = 24; line.lineCapStyle = .round; line.stroke()
}
let spine = NSBezierPath(); spine.move(to: NSPoint(x: 314, y: 185)); spine.line(to: NSPoint(x: 314, y: 845)); spine.lineWidth = 6
NSColor(calibratedRed: 0.83, green: 0.87, blue: 0.75, alpha: 1).setStroke(); spine.stroke()
image.unlockFocus()
let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: root))
