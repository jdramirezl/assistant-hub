// Renders tests/support/fixtures/balances.png (a generic balances screenshot for the replay).
// swift tests/support/fixtures/make-balances.swift tests/support/fixtures/balances.png
import AppKit
let W = 420.0, H = 560.0
let img = NSImage(size: NSSize(width: W, height: H))
img.lockFocus()
NSColor(white: 0.96, alpha: 1).setFill(); NSRect(x: 0, y: 0, width: W, height: H).fill()
var y = H - 50.0
func text(_ s: String, _ x: Double, size: CGFloat = 17, bold: Bool = false, color: NSColor = .black, right: Bool = false) {
  let a: [NSAttributedString.Key: Any] = [.font: bold ? NSFont.boldSystemFont(ofSize: size) : NSFont.systemFont(ofSize: size), .foregroundColor: color]
  let str = NSAttributedString(string: s, attributes: a)
  let w = str.size().width
  str.draw(at: NSPoint(x: right ? x - w : x, y: y))
}
text("Mis saldos · 23 oct", 24, size: 22, bold: true)
func card(_ title: String, _ color: NSColor, _ rows: [(String, String)]) {
  let h = Double(rows.count) * 34 + 56
  y -= 20
  NSColor.white.setFill(); NSBezierPath(roundedRect: NSRect(x: 16, y: y - h + 24, width: W - 32, height: h), xRadius: 14, yRadius: 14).fill()
  text(title, 32, size: 18, bold: true, color: color)
  for (name, amount) in rows { y -= 34; text(name, 32); text(amount, W - 32, bold: true, right: true) }
  y -= 40
}
card("Nu México (MXN)", NSColor(red: 0.51, green: 0.04, blue: 0.82, alpha: 1), [("Cajita Turbo", "$5,069.45"), ("Viajes", "$4,070.59"), ("Ahorros", "$2,022.36"), ("Dinero de respaldo", "$1,015.78")])
card("Bancolombia (COP)", NSColor(red: 0.8, green: 0.6, blue: 0, alpha: 1), [("Bono", "$1.055.262,51"), ("Para gastar", "$1.950.000")])
img.unlockFocus()
let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
