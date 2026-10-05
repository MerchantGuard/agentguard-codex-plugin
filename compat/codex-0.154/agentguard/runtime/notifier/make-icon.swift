import AppKit
// AgentGuard app icon, drawn from the site's flat mark (agentguard-icon-flat.svg geometry, teal #2ABCB4)
// on Apple's macOS grid: 1024 canvas, 824 rounded square, transparent corners, a quiet navy gradient.
let out = CommandLine.arguments[1]
let inset: CGFloat = 100, body: CGFloat = 824, radius: CGFloat = 185.4, scale: CGFloat = 1.36
func rgb(_ h: Int) -> NSColor { NSColor(srgbRed: CGFloat((h >> 16) & 255) / 255, green: CGFloat((h >> 8) & 255) / 255, blue: CGFloat(h & 255) / 255, alpha: 1) }
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024, bitsPerSample: 8, samplesPerPixel: 4,
                           hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSColor.clear.setFill(); NSRect(x: 0, y: 0, width: 1024, height: 1024).fill()
let rect = NSRect(x: inset, y: inset, width: body, height: body)
NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).addClip()
NSGradient(starting: rgb(0x132A45), ending: rgb(0x07101E))!.draw(in: rect, angle: -90)
func p(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x: 512 + (x - 256) * scale, y: 512 - (y - 256) * scale) }
let teal = rgb(0x2ABCB4), navy = rgb(0x07101E)
let lines: [(CGFloat, CGFloat, CGFloat, CGFloat)] = [(114,174,256,92),(256,92,398,174),(398,174,398,338),(398,338,256,420),(256,420,114,338),(114,338,114,174),
  (256,92,256,256),(256,420,256,256),(114,174,256,256),(398,174,256,256),(114,338,256,256),(398,338,256,256)]
teal.setStroke()
for (x1, y1, x2, y2) in lines {
  let path = NSBezierPath(); path.move(to: p(x1, y1)); path.line(to: p(x2, y2))
  path.lineWidth = 20 * scale; path.lineCapStyle = .round; path.stroke()
}
let circles: [(CGFloat, CGFloat, CGFloat, CGFloat)] = [(256,256,62,22),(256,92,28,20),(398,174,28,20),(398,338,28,20),(256,420,28,20),(114,338,28,20),(114,174,28,20)]
for (cx, cy, r, w) in circles {
  let c = p(cx, cy), rr = r * scale
  let path = NSBezierPath(ovalIn: NSRect(x: c.x - rr, y: c.y - rr, width: rr * 2, height: rr * 2))
  navy.setFill(); path.fill(); path.lineWidth = w * scale; teal.setStroke(); path.stroke()
}
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
